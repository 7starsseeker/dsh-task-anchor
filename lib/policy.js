/**
 * task-anchor policy — every decision this plugin makes, with no Cordis in sight.
 *
 * The adapter (`lib/index.js`) only wires these functions to DSH hooks. Keeping
 * the judgement here means it can be replayed offline against a session log
 * (tests, incident review) without booting a harness.
 *
 * Facts this module relies on (DSH 0.2.2-rc.3):
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
 * All text parts of a message, joined into one line.
 * @param message - an inbox message.
 * @returns the visible text, or '' when the message carries none.
 */
export function textOf(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text.trim())
    .filter(text => text !== '')
    .join(' ')
}

/**
 * The user text that interrupted a turn, for the persisted anchor.
 * @param messages - the claimed `agent/pre-step` batch.
 * @returns one line combining every user message in the batch.
 */
export function interjectionText(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(isUserMessage)
    .map(textOf)
    .filter(text => text !== '')
    .join(' / ')
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
 * The turn the log is currently inside, from the last `turn/start`.
 *
 * The prompt section is assembled once per step, so "is this interjection
 * happening in the turn I am running right now?" has to be answered from the
 * log, not from a flag the plugin keeps — a restart or a fork would clear one.
 * @param events - the session log.
 * @returns the turn number, or 0 when no turn has started.
 */
export function currentTurnOf(events) {
  if (!Array.isArray(events)) return 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && Number.isFinite(event.data?.turn)) return event.data.turn
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
    // Real events carry the message under `data.message`; tests and older
    // producers may inline the content at `data`.
    const text = assistantText(event.data?.message ?? event.data)
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
  // `Infinity` means "age does not matter": the suspended-work anchor uses it,
  // because that plan must survive quiet turns until its items are closed or
  // rewritten — that is the whole point of writing it to disk.
  const maxStaleTurns = options.maxStaleTurns === Infinity
    ? Infinity
    : Number.isFinite(options.maxStaleTurns)
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
export function buildContractText(options = {}) {
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
    '### Recording what you suspended',
    '',
    'The todo list is the only state the plugin reads. Keep it honest when a message changes the plan:',
    '',
    '- cancellation → rewrite the list without the dropped items;',
    '- amendment → rewrite the affected item with the new constraint;',
    '- suspension → keep the open items and add the new work as its own item, then continue.',
    '',
    'A suspended plan is written to disk once, when the interjection is detected, and reappears in a later prompt as "Suspended work". Rewriting the list without those items is how you say the work was cancelled; leaving them in means it is still owed.',
    '',
    '### After a cancellation',
    '',
    'Cancellation is silent from then on. Rewrite the list without the dropped items and stop referring to them: no "as you cancelled X" in later replies, no re-narrating the abandoned work in explanations, notes, or reports, and no farewell speech. Once the items are off the list, neither "Suspended work" nor "Open items" will mention them again — that is the signal that nothing is owed. If the user asks why it stopped, answer once and drop it again.',
    '',
    '### Answering a question you asked',
    '',
    'When the user replies to a question you asked — "yes", "go ahead", a choice from a list, an approval that unlocks the next step — that reply is a decision, not a fact to file away. Open a todo item naming the exact action, run it, and close the item only when your reply states what ran and what came back. Until then the answer is owed and the turn is not finished.',
    '',
    '### Keeping what you already found',
    '',
    'Evidence lives in the transcript, not in this prompt. Before you set work aside, anything that would be expensive to obtain again belongs in a file — a note, a draft — with the todo item pointing at it. Redoing one search is cheaper than maintaining a checkpoint; re-reading forty files is not. Write the conclusion, not the raw output.',
    '',
    '### Two tasks at once',
    '',
    'A step is sequential: there is no background run. If you deliver incrementally, say what is deferred; if you deliver once, say so before you start.',
    '',
    'You may hand one task to a subagent when all three hold: both tasks are substantial (roughly ten or more steps each), neither needs the other\'s output, and they touch disjoint files. `subagent_fork` inherits this conversation but cannot see the running turn; `subagent` starts from a fresh context. Record the handover in the todo list as "[external] <goal>".',
    '',
    'Otherwise finish one and then the other. Order: an explicit user order wins, then dependencies, then the shorter task, then the one closest to done.',
    '',
    'Never silently abandon unfinished work. If you stop early, say what remains and why. If you finish a turn with a plan still open, either continue it or account for it explicitly.',
    '',
    options.returnPolicy === 'wait'
      ? '### Waiting for the user\n\nThis profile runs in `wait` mode: handle the message that interrupted the work, report what you did, and **stop**. Leave the suspended plan in the todo list and do not pick it back up until the user asks for it. A later prompt will remind you what is still owed.'
      : '### Resuming suspended work\n\nThis profile runs in `auto` mode: when a turn is about to end with suspended work still open, a reminder is steered back into it. Finish the open items, or state plainly what remains — whether a task is dropped is the user\'s call, not yours.',
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
 * Shorten a string for one-line inclusion in a prompt.
 * @param value - raw text.
 * @param max - maximum characters kept.
 * @returns trimmed text with an ellipsis when cut.
 */
function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Render the "Suspended work" prompt section.
 *
 * Advisory on purpose: it says where work stopped and how to resume, but never
 * "resume now". A prompt section that orders the model to continue would be a
 * second, quieter hijack — the user may have cancelled the work minutes ago.
 *
 * @param input - `items` (open todo contents), `interjection`, `stoppedAt`, `maxItems`.
 * @returns the section body, or '' when nothing is suspended.
 */
export function buildAnchorText(input) {
  const items = Array.isArray(input?.items) ? input.items : []
  if (items.length === 0) return ''
  const maxItems = Number.isFinite(input?.maxItems) ? Math.max(1, input.maxItems) : 5
  const shown = items.slice(0, maxItems)
  const sameTurn = input?.sameTurn === true
  const lines = sameTurn
    ? [
        '## Interjection during this turn',
        '',
        'A user message arrived while this turn was still running. The work that was in flight is not cancelled — it is parked here:',
        '',
      ]
    : [
        '## Suspended work',
        '',
        'A user message arrived mid-task and this plan was set aside rather than cancelled. It is still open:',
        '',
      ]
  lines.push(...shown.map(item => `- ${item}`))
  const hidden = items.length - shown.length
  if (hidden > 0) lines.push(`- ...and ${hidden} more`)
  const interjection = clip(input?.interjection, 100)
  if (interjection !== '') lines.push('', `Message that interrupted it: "${interjection}"`)
  const stoppedAt = clip(input?.stoppedAt, 160)
  if (stoppedAt !== '') lines.push('', `Where it stopped: "${stoppedAt}"`)
  // The log, not this prompt, holds the evidence the model had gathered. Pointing
  // at the event that was current when work was set aside turns "it is somewhere
  // in the transcript" into a lookup the model can actually perform.
  const seq = Number(input?.seq)
  if (Number.isFinite(seq) && seq > 0) {
    lines.push(
      '',
      `The transcript up to that point is session event #${seq}. Use session_event_read around that event to recover what you had already found, before re-running anything.`,
    )
  }
  if (sameTurn) {
    // The turn is still running, so the model is the one that gets to decide what
    // this message is. All the plugin does is put the two tasks side by side and
    // name the three readings, so stopping is a choice rather than an ambush.
    lines.push(
      '',
      'Decide what that message is before you continue, and act on it in this turn:',
      '- a cancellation — rewrite the todo list without those items;',
      '- an amendment — update those items in place;',
      '- separate work — stop this turn now: say in one line what you are parking, leave the items in the list for the next turn, and answer what was just asked.',
      '',
      'Do not keep grinding on the parked items while the user waits for an answer about what they just asked.',
    )
  } else {
    lines.push(
      '',
      'If the user asks to continue, resume from here. If the user cancelled this work, rewrite the todo list without these items — this block disappears when the plan is empty. Do not resume it unless asked.',
    )
  }
  return lines.join('\n')
}

/**
 * Render the one-line "Open items" reminder used when no suspension block is
 * present. It exists because the todo panel is a per-turn surface: once a turn
 * ends the user may no longer see what the plan still owes, while the log still
 * does. The anchor block already lists its own items, so the section renders one
 * or the other, never both.
 *
 * @param input - `items` (open todo contents) and `maxItems`.
 * @returns the line, or '' when nothing is open.
 */
export function buildOpenItemsText(input) {
  const items = Array.isArray(input?.items)
    ? input.items.map(item => clip(item, 120)).filter(item => item !== '')
    : []
  if (items.length === 0) return ''
  const maxItems = Number.isFinite(input?.maxItems) ? Math.max(1, input.maxItems) : 5
  const shown = items.slice(0, maxItems)
  const hidden = items.length - shown.length
  return `Open items: ${shown.join('; ')}${hidden > 0 ? `; ...and ${hidden} more` : ''}`
}

/** Markers of "the plan is dropped", used when the config supplies none. */
const DEFAULT_CANCEL_PATTERNS = [
  '取消',
  '不用了',
  '不需要了',
  '算了',
  '别做了',
  '先不做',
  '停一下',
  '\\bcancel\\b',
  '\\bnever ?mind\\b',
  '\\bforget it\\b',
]

/** Markers of "the same plan, changed", used when the config supplies none. */
const DEFAULT_AMEND_PATTERNS = [
  '改成',
  '换成',
  '改为',
  '换个',
  '补充',
  '再加上',
  '另外加',
  '还要加',
  '修改',
  '调整',
  '\\binstead\\b',
  '\\bchange (it|that) to\\b',
  '\\balso add\\b',
]

/**
 * Turn config strings into regexes, dropping the ones that do not compile.
 * @param value - a config array, or anything else to fall back.
 * @param fallback - patterns used when `value` is not an array.
 * @returns compiled regexes (case-insensitive).
 */
function compilePatterns(value, fallback) {
  const source = Array.isArray(value)
    ? value.filter(pattern => typeof pattern === 'string' && pattern.trim() !== '')
    : fallback
  const compiled = []
  for (const pattern of source) {
    try {
      compiled.push(new RegExp(pattern, 'i'))
    } catch {
      // A broken pattern must not take the plugin down: skip it.
    }
  }
  return compiled
}

/**
 * Read an interjecting message as cancellation, amendment, or separate work.
 * This is a text heuristic and nothing more: it exists so the mechanical stop
 * can be limited to the case that actually needs it, not to judge intent.
 * @param text - the interjected text, already joined into one line.
 * @param patterns - an object with `cancelPatterns` and `amendPatterns` (RegExp[]).
 * @returns 'cancel' | 'amend' | 'other'.
 */
export function classifyInterjection(text, patterns) {
  const line = typeof text === 'string' ? text : ''
  if (line.trim() === '') return 'other'
  for (const pattern of patterns?.cancelPatterns ?? []) if (pattern.test(line)) return 'cancel'
  for (const pattern of patterns?.amendPatterns ?? []) if (pattern.test(line)) return 'amend'
  return 'other'
}

/**
 * Read the `forceStop` setting.
 * @param value - true/'always' for unconditional, 'triage' for heuristic.
 * @returns 'off' | 'always' | 'triage'.
 */
function normalizeForceStop(value) {
  if (value === true || value === 'always') return 'always'
  if (value === 'triage') return 'triage'
  return 'off'
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
    onInterject: raw.onInterject === 'off' ? 'off' : 'triage',
    returnPolicy: raw.returnPolicy === 'wait' ? 'wait' : 'auto',
    // Off by default: ending a turn because a message arrived is a stronger
    // opinion than writing that message down and carrying on. 'triage' stops
    // only when the message does not look like a cancellation or an amendment.
    forceStop: normalizeForceStop(raw.forceStop),
    cancelPatterns: compilePatterns(raw.cancelPatterns, DEFAULT_CANCEL_PATTERNS),
    amendPatterns: compilePatterns(raw.amendPatterns, DEFAULT_AMEND_PATTERNS),
    storeDir: typeof raw.storeDir === 'string' && raw.storeDir.trim() !== '' ? raw.storeDir.trim() : '',
    // Orphan sweep: snapshots of abandoned sessions older than this many days are
    // removed when the next snapshot is written. 0 disables it.
    storeTtlDays: Number.isFinite(raw.storeTtlDays) ? Math.max(0, raw.storeTtlDays) : 7,
    triggerQueued: raw.triggerQueued !== false,
    skipWhenAsking: raw.skipWhenAsking !== false,
    maxNudgesPerSession: Number.isFinite(raw.maxNudgesPerSession) ? Math.max(0, raw.maxNudgesPerSession) : 6,
    maxNoticeItems: Number.isFinite(raw.maxNoticeItems) ? Math.max(1, raw.maxNoticeItems) : 5,
    maxStaleTurns: Number.isFinite(raw.maxStaleTurns) ? Math.max(0, raw.maxStaleTurns) : DEFAULT_MAX_STALE_TURNS,
  }
}

/**
 * The one-time note shown on the first start against a given store.
 *
 * Why a prompt section and not a UI prompt: the plugin has no client surface —
 * it injects prompt text and reads the todo log — so the honest way to surface
 * its options is to ask the model to state them, exactly once.
 *
 * @param input - `{ version, returnPolicy, forceStop, onInterject, storeTtlDays }`.
 * @returns a prompt section.
 */
export function buildFirstRunText(input) {
  const {
    version = '',
    returnPolicy = 'auto',
    forceStop = 'off',
    onInterject = 'triage',
    storeTtlDays = 7,
  } = input ?? {}
  const which = version === '' ? '`task-anchor`' : `\`task-anchor v${version}\``
  return [
    '## First run',
    '',
    `This is the first start of ${which} against this store. Before anything else, tell the user in one short paragraph: the plugin is loaded; the switches that change its behaviour are \`returnPolicy\` (\`auto\` steers a reminder back into a turn that ends with work still open, \`wait\` records the plan and stays silent) and \`forceStop\` (\`off\` never ends the turn, \`always\` / \`triage\` end it at the interjection and re-deliver the message on the next turn); their current values are \`returnPolicy: ${returnPolicy}\`, \`forceStop: ${forceStop}\`, \`onInterject: ${onInterject}\`, \`storeTtlDays: ${storeTtlDays}\`; they live in \`cordis.patch.yml\`. Ask whether the user wants to change any of them. Do not repeat this note on later runs.`,
  ].join('\n')
}