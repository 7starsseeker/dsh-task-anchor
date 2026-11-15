/**
 * task-anchor — keep the running task anchored when a mid-turn user message arrives.
 *
 * Two mechanisms, both outside `packages/core` (no fork, no patch):
 *
 *  1. A system-prompt section states the contract: a mid-turn user message is a
 *     new input, not automatically a replacement for the task in progress.
 *     DSH deliberately projects injected content verbatim so the producer owns
 *     framing (see the 2026-07-20 "unwrap injected content envelopes" note), so
 *     the section is the sanctioned place for exactly this kind of rule.
 *
 *     The same section also carries the suspended-work anchor: a plan recorded
 *     at the moment of the interjection and rendered back on every later
 *     assembly, so a compaction cannot erase what is still owed.
 *
 *  2. A guard on `agent/turn-stopping`: when a turn that received a mid-turn
 *     message (or is handing over to a queued one) ends with unfinished todos,
 *     steer one notice back into the turn. The turn then runs another step and
 *     the model must either finish the work or account for what it dropped.
 *
 * DSH gives plugins no "ephemeral message" channel: a pre-step injection becomes
 * a durable `user/message`. That is why the contract lives in the prompt rather
 * than next to the interjection, and why the guard fires only on failure.
 *
 * @module dsh-task-anchor
 */

import { randomUUID } from 'node:crypto'
import {
  buildAnchorText,
  buildContractText,
  buildNoticeText,
  buildOpenItemsText,
  detectInterjection,
  endsWithQuestion,
  interjectionText,
  lastAssistantText,
  normalizeConfig,
  openTodos,
  turnStartSeq,
} from './policy.js'
import { loadSnapshot, removeSnapshot, resolveStoreDir, saveSnapshot, SNAPSHOT_VERSION } from './store.js'

/** Cordis plugin id: must equal the patch entry's `id` (the package name keeps its `dsh-` prefix). */
export const name = 'task-anchor'

/** The prompt service must exist before the contract can be registered. */
export const inject = ['systemPrompt']

/** Producer-owned source tag — format v4 rejects the legacy `{kind:'plugin',plugin}` shape. */
const NOTICE_SOURCE_KIND = 'plugin:task-anchor'

/** Prompt order: right after plan policy (500), before team policy (600). */
const SECTION_ORDER = 540

const SECTION_NAME = 'task-anchor:contract'

/**
 * Per-agent bookkeeping. Weak so a disposed agent's state goes with it.
 * `snapshot` is the suspended plan; `snapshotRead` marks that the on-disk copy
 * was already consulted (a missing file must not cost a stat per assembly).
 * @type {WeakMap<object, {steeringTurns: Set<number>, nudgedTurns: Set<number>, nudges: number, snapshot: object|null, snapshotRead: boolean}>}
 */
const states = new WeakMap()

/**
 * @param agent - the agent whose turn is running.
 * @returns its mutable bookkeeping.
 */
function stateFor(agent) {
  let state = states.get(agent)
  if (state === undefined) {
    state = { steeringTurns: new Set(), nudgedTurns: new Set(), nudges: 0, snapshot: null, snapshotRead: false }
    states.set(agent, state)
  }
  return state
}

/**
 * One user-role notice message, shaped exactly like `createUserMessage` output
 * (the `@deepseek-ai/dsh-llm` helper is not available to a dependency-free plugin).
 * @param text - notice body.
 * @param summary - folded title shown by the conversation surface.
 * @returns a complete, frozen-compatible user message.
 */
function noticeMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: NOTICE_SOURCE_KIND,
      form: 'notice',
      summary: summary.length <= 80 ? summary : `${summary.slice(0, 79)}…`,
    },
  }
}

/**
 * Mount the plugin.
 * @param ctx - the Cordis context handed to a profile bundle.
 * @param config - the `config:` block from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('task-anchor: disabled by config')
    return
  }

  const storeDir = resolveStoreDir(cfg.storeDir)
  const recording = cfg.onInterject === 'triage'

  /**
   * The durable copy of the suspended plan, read once per agent (a missing file
   * must not cost a stat on every assembly).
   * @param agent - the agent being assembled.
   * @returns the snapshot, or null.
   */
  function snapshotFor(agent) {
    const state = stateFor(agent)
    if (!state.snapshotRead) {
      state.snapshotRead = true
      state.snapshot = loadSnapshot(storeDir, agent?.session?.id)
    }
    return state.snapshot
  }

  /**
   * Drop the anchor: the plan is empty, stale, or explicitly cancelled.
   * @param agent - the agent whose anchor goes away.
   */
  function forget(agent) {
    const state = stateFor(agent)
    state.snapshot = null
    state.snapshotRead = true
    removeSnapshot(storeDir, agent?.session?.id)
  }

  /**
   * Persist the plan at the moment an interjection is detected.
   * @param agent - the interrupted agent.
   * @param payload - the `agent/pre-step` payload.
   * @returns the written snapshot.
   */
  function remember(agent, payload) {
    const events = agent?.session?.snapshotEvents?.() ?? []
    // Snapshot the items themselves, not "whatever the list holds later": a
    // later list may describe unrelated work, and calling that suspended would
    // be a lie. The anchor renders this set ∩ the still-open set.
    const items = openTodos(events, { maxStaleTurns: Infinity }).map(todo => todo.content.trim())
    if (items.length === 0) return null
    const seq = events.length === 0 ? 0 : events[events.length - 1].seq
    const snapshot = {
      version: SNAPSHOT_VERSION,
      session: String(agent?.session?.id ?? ''),
      turn: payload.turn,
      seq,
      at: new Date().toISOString(),
      interjection: interjectionText(payload.messages),
      items,
      stoppedAt: '',
    }
    const state = stateFor(agent)
    state.snapshot = snapshot
    state.snapshotRead = true
    try {
      saveSnapshot(storeDir, agent?.session?.id, snapshot)
    } catch (error) {
      // An unwritable store must not break the turn; the in-memory copy still
      // serves this process, and the session log keeps the raw events.
      ctx.logger?.debug?.('task-anchor: snapshot skipped: %s', String(error?.message ?? error))
    }
    return snapshot
  }

  /**
   * The "Suspended work" block for one agent, or '' when nothing is suspended.
   * Derived from the log, never from this step's payload: the prompt is
   * assembled before `agent/pre-step` runs (agent.ts:300 vs :302).
   * @param agent - the agent being assembled.
   * @returns the prompt block.
   */
  function anchorTextFor(agent) {
    try {
      if (typeof agent?.session?.snapshotEvents !== 'function') return ''
      const snapshot = snapshotFor(agent)
      if (snapshot === null || !Array.isArray(snapshot.items) || snapshot.items.length === 0) return ''
      const events = agent.session.snapshotEvents()
      // Age alone never expires the anchor: the user may come back five quiet
      // turns later and ask to continue. It disappears when its own items leave
      // the plan (closed, or rewritten away), which is the cancellation signal.
      const open = new Set(
        openTodos(events, { maxStaleTurns: Infinity }).map(todo => todo.content.trim()),
      )
      const items = snapshot.items.filter(item => open.has(item))
      if (items.length === 0) {
        forget(agent)
        return ''
      }
      return buildAnchorText({
        items,
        interjection: snapshot.interjection,
        stoppedAt: snapshot.stoppedAt,
        seq: snapshot.seq,
        maxItems: cfg.maxNoticeItems,
      })
    } catch (error) {
      ctx.logger?.debug?.('task-anchor: anchor skipped: %s', String(error?.message ?? error))
      return ''
    }
  }

  /**
   * The one-line "Open items" reminder for a plan with no suspension block.
   *
   * The todo panel only lives while its turn is on screen; the log outlives it.
   * Rendering the open items here keeps what the plan still owes visible to the
   * model on every assembly, at a cost of one short line. No age cutoff on
   * purpose: the todo list is the user-facing truth, so an item stays listed
   * until the model rewrites the list without it.
   *
   * @param agent - the agent being assembled.
   * @returns the line, or '' when nothing is open.
   */
  function openItemsTextFor(agent) {
    try {
      if (typeof agent?.session?.snapshotEvents !== 'function') return ''
      const items = openTodos(agent.session.snapshotEvents(), { maxStaleTurns: Infinity })
        .map(todo => todo.content)
      return buildOpenItemsText({ items, maxItems: cfg.maxNoticeItems })
    } catch (error) {
      ctx.logger?.debug?.('task-anchor: open items skipped: %s', String(error?.message ?? error))
      return ''
    }
  }

  if (cfg.contract) {
    const contract = buildContractText()
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        // One section, three shapes: contract only in the steady state; the
        // suspension block while work is actually set aside; the shorter open
        // items line otherwise (never both — the block already lists its items).
        text: recording
          ? (context) => {
              const anchor = anchorTextFor(context?.agent)
              if (anchor !== '') return `${contract}\n\n${anchor}`
              const openItems = openItemsTextFor(context?.agent)
              return openItems === '' ? contract : `${contract}\n\n${openItems}`
            }
          : contract,
      }),
      'task-anchor: contract section',
    )
  }

  // Observation only: the batch is claimed before this handler runs, so the
  // messages survive whatever we return. Never drop them by returning a new array.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (detectInterjection(payload)) {
        if (recording) remember(payload.agent, payload)
        if (cfg.guard) stateFor(payload.agent).steeringTurns.add(payload.turn)
        ctx.logger?.debug?.('task-anchor: mid-turn user message observed (turn %d, step %d)', payload.turn, payload.step)
      }
    } catch (error) {
      ctx.logger?.debug?.('task-anchor: observation skipped: %s', String(error?.message ?? error))
    }
    return decision
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const agent = payload.agent
      const state = stateFor(agent)
      const events = agent.session.snapshotEvents()

      // Anchor maintenance runs even with the guard off: the stop point is
      // worth recording on its own, and cancelling must delete the file.
      const snapshot = recording ? snapshotFor(agent) : null
      if (snapshot !== null) {
        if (snapshot.turn === payload.turn && snapshot.stoppedAt === '') {
          const stoppedAt = lastAssistantText(events, turnStartSeq(events, payload.turn))
          if (stoppedAt !== '') {
            snapshot.stoppedAt = stoppedAt
            try {
              saveSnapshot(storeDir, agent.session?.id, snapshot)
            } catch (error) {
              // Same contract as above: an unwritable store never breaks a turn.
              ctx.logger?.debug?.('task-anchor: stop point not persisted: %s', String(error?.message ?? error))
            }
          }
        }
        // Cancellation is judged on the suspended items only: a plan that was
        // rewritten away is gone, and unrelated new work must not resurrect it.
        const open = new Set(
          openTodos(events, { maxStaleTurns: Infinity }).map(todo => todo.content.trim()),
        )
        const suspended = Array.isArray(snapshot.items) ? snapshot.items : []
        if (suspended.filter(item => open.has(item)).length === 0) forget(agent)
      }

      if (!cfg.guard) return
      // `wait` keeps the record but leaves the turn alone: the user asked for a
      // stop, and the next prompt will remind the model what is still owed.
      if (cfg.returnPolicy === 'wait') return
      if (payload.signal?.aborted) return
      if (state.nudgedTurns.has(payload.turn)) return
      if (state.nudges >= cfg.maxNudgesPerSession) return

      const steering = state.steeringTurns.has(payload.turn)
      const queued = cfg.triggerQueued && agent.inbox.nextTurn.length > 0
      if (!steering && !queued) return

      const items = openTodos(events, { maxStaleTurns: cfg.maxStaleTurns })
        .map(todo => todo.content.trim())
      if (items.length === 0) return
      // Stopping to ask the user is a legitimate reason to end with open work.
      if (cfg.skipWhenAsking && endsWithQuestion(lastAssistantText(events, turnStartSeq(events, payload.turn)))) return

      const text = buildNoticeText({
        items,
        reason: steering ? 'interjection' : 'queued',
        maxItems: cfg.maxNoticeItems,
      })
      if (text === '') return

      state.nudgedTurns.add(payload.turn)
      state.nudges += 1
      agent.steer(noticeMessage(text, `task-anchor: ${items.length} open item(s) — 继续或说明留下了什么`))
      ctx.logger?.info?.(
        'task-anchor: steered a reminder into turn %d (%s, %d open item(s))',
        payload.turn,
        steering ? 'interjection' : 'queued-next-turn',
        items.length,
      )
    } catch (error) {
      // A throwing turn-stopping listener would fail the turn boundary; staying
      // silent is strictly better than breaking the user's conversation.
      ctx.logger?.debug?.('task-anchor: guard skipped: %s', String(error?.message ?? error))
    }
  })
}
