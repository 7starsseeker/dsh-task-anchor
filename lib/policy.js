/**
 * task-anchor policy — every decision this plugin makes, with no Cordis in sight.
 *
 * The adapter (`lib/index.js`) only wires these functions to DSH hooks. Keeping
 * the judgement here means it can be replayed offline against a session log
 * (tests, incident review) without booting a harness.
 *
 * Facts this module relies on (DSH 0.1.2-alpha.1):
 *  - `Inbox.claim()` takes *all* `next-step` messages and then one `next-turn`
 *    message, so a mid-turn user message only shows up in a pre-step batch with
 *    `step > 1`. A queued message is claimed at step 1 of the *next* turn.
 *  - Controller-delivered user messages carry `source.kind === 'user'`; plugin
 *    notices carry `plugin:<id>`. That is the only reliable origin tag.
 *  - `todo/write` events persist the whole list every call; the client
 *    projection is cleared on `turn/start` but the log is not.
 *
 * @module dsh-task-anchor/policy
 */

/** Statuses that mean "planned work is still open". */
const UNFINISHED = new Set(['pending', 'in_progress'])

/** How many finished turns a `todo/write` stays relevant for. */
const DEFAULT_MAX_STALE_TURNS = 3

/**
 * Whether a message was delivered by the session controller on the user's behalf.
 * Plugin notices (`plugin:<id>`) and runtime-context snapshots are excluded on purpose.
 * @param message - a message from an `agent/pre-step` batch.
 * @returns true for a controller-delivered user message.
 */
export function isUserMessage(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

/**
 * Whether this step batch contains a message the user sent while work was in progress.
 * Step 1 batches can also contain a steering message (sent before the first model
 * call), so this deliberately under-reports rather than mislabels an opener.
 * @param payload - an `agent/pre-step` payload (`messages`, `step`).
 * @returns true when at least one next-step user message was claimed.
 */
export function detectInterjection(payload) {
  if (!payload || !Array.isArray(payload.messages)) return false
  if (!(Number(payload.step) > 1)) return false
  return payload.messages.some(isUserMessage)
}

/**
 * Last non-empty text part of an assistant message.
 * @param message - an `assistant/message` event payload.
 * @returns trimmed text, or '' when the message carries no text (tool-call-only).
 */
export function assistantText(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      return part.text.trim()
    }
  }
  return ''
}

/**
 * Whether the turn ended by asking the user something, in which case stopping is
 * legitimate and a nudge would be noise.
 * @param text - the final assistant text of the turn.
 * @returns true when the text ends with a question mark (ASCII or full-width).
 */
export function endsWithQuestion(text) {
  return /[?？]["'”’」』）)]?\s*$/.test(String(text ?? '').trim())
}

/**
 * Locate the start of a turn.
 * @param events - the session log.
 * @param turn - the turn number.
 * @returns the `seq` of that turn's `turn/start`, or 0 when absent.
 */
export function turnStartSeq(events, turn) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) return event.seq
  }
  return 0
}

/**
 * The last assistant text produced since a log position.
 * @param events - the session log.
 * @param sinceSeq - inclusive lower bound; 0 means "anywhere".
 * @returns the final assistant text, or ''.
 */
export function lastAssistantText(events, sinceSeq = 0) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.seq < sinceSeq) return ''
    if (event.type !== 'assistant/message') continue
    const text = assistantText(event.data)
    if (text !== '') return text
  }
  return ''
}

/**
 * Number of turns that started after a log position.
 * @param events - the session log.
 * @param seq - the position.
 * @returns count of `turn/start` events with a greater `seq`.
 */
export function turnsAfter(events, seq) {
  let count = 0
  for (const event of events) {
    if (event?.type === 'turn/start' && event.seq > seq) count += 1
  }
  return count
}

/**
 * The most recent todo list, without trusting it beyond a few turns.
 * A list written in an earlier turn is still the plan the agent is following,
 * but a list from ten turns ago is stale context rather than an open plan.
 * @param events - the session log.
 * @param options - `maxStaleTurns` bounds how many later turns keep it relevant.
 * @returns the recorded todos, or [] when there is no fresh list.
 */
export function openTodos(events, options = {}) {
  const maxStaleTurns = Number.isFinite(options.maxStaleTurns)
    ? options.maxStaleTurns
    : DEFAULT_MAX_STALE_TURNS
  let write
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'todo/write') {
      write = events[index]
      break
    }
  }
  if (write === undefined) return []
  if (turnsAfter(events, write.seq) > maxStaleTurns) return []
  const todos = Array.isArray(write.data?.todos) ? write.data.todos : []
  return todos.filter(todo =>
    todo
    && UNFINISHED.has(todo.status)
    && typeof todo.content === 'string'
    && todo.content.trim() !== '',
  )
}

/**
 * Render the model-facing contract. Present in every request while enabled, so
 * it is written as prose the model can apply, not as a special tag it has to learn.
 * @returns the prompt section body.
 */
export function buildContractText() {
  return [
    '## Mid-turn user messages',
    '',
    'A user message can arrive while you are in the middle of a task. It is a new input, not automatically a replacement for the task you are already carrying out. Before acting on it, relate it to the work in progress:',
    '',
    '- an added constraint or preference → apply it and keep the current task;',
    '- a correction of the current step → apply it and keep the current task;',
    '- a question about the work → answer it, then continue the task;',
    '- a separate new task → take the current task to a safe stopping point first, and say plainly what remains;',
    '- an explicit change or cancellation of the goal → follow the new goal, and state that the old task is dropped.',
    '',
    'Never silently abandon unfinished work. If you stop early, say what remains and why. If you finish a turn with a plan still open, either continue it or account for it explicitly.',
  ].join('\n')
}

/**
 * Render the guard notice steered back into a turn that is ending with open work.
 * @param input - `items` are todo contents; `reason` is `interjection` or `queued`.
 * @returns the message text, or '' when there is nothing to say.
 */
export function buildNoticeText(input) {
  const items = Array.isArray(input?.items) ? input.items : []
  if (items.length === 0) return ''
  const maxItems = Number.isFinite(input?.maxItems) ? Math.max(1, input.maxItems) : 5
  const shown = items.slice(0, maxItems)
  const lines = shown.map(item => `- ${item}`)
  const hidden = items.length - shown.length
  if (hidden > 0) lines.push(`- ...and ${hidden} more`)
  const cause = input.reason === 'queued'
    ? 'This turn is ending while a queued user message waits for the next turn'
    : 'This turn received a mid-turn user message and is ending'
  return [
    '[task-anchor]',
    `${cause}, with planned work still open:`,
    ...lines,
    '',
    'Before ending, either finish these items, or state plainly what remains and why you stopped. Do not silently drop them.',
  ].join('\n')
}

/**
 * Merge deployment config over defaults, ignoring unknown keys.
 * @param config - the raw `config:` block from the profile patch.
 * @returns a complete, typed config.
 */
export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    enabled: raw.enabled !== false,
    contract: raw.contract !== false,
    guard: raw.guard !== false,
    triggerQueued: raw.triggerQueued !== false,
    skipWhenAsking: raw.skipWhenAsking !== false,
    maxNudgesPerSession: Number.isFinite(raw.maxNudgesPerSession) ? Math.max(0, raw.maxNudgesPerSession) : 6,
    maxNoticeItems: Number.isFinite(raw.maxNoticeItems) ? Math.max(1, raw.maxNoticeItems) : 5,
    maxStaleTurns: Number.isFinite(raw.maxStaleTurns) ? Math.max(0, raw.maxStaleTurns) : DEFAULT_MAX_STALE_TURNS,
  }
}
