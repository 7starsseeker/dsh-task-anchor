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
  buildContractText,
  buildNoticeText,
  detectInterjection,
  endsWithQuestion,
  lastAssistantText,
  normalizeConfig,
  openTodos,
  turnStartSeq,
} from './policy.js'

/** Plugin id: cordis `name`, patch `id`, and the notice source suffix. */
export const name = 'dsh-task-anchor'

/** The prompt service must exist before the contract can be registered. */
export const inject = ['systemPrompt']

/** Producer-owned source tag — format v4 rejects the legacy `{kind:'plugin',plugin}` shape. */
const NOTICE_SOURCE_KIND = 'plugin:dsh-task-anchor'

/** Prompt order: right after plan policy (500), before team policy (600). */
const SECTION_ORDER = 540

const SECTION_NAME = 'task-anchor:contract'

/**
 * Per-agent bookkeeping. Weak so a disposed agent's state goes with it.
 * @type {WeakMap<object, {steeringTurns: Set<number>, nudgedTurns: Set<number>, nudges: number}>}
 */
const states = new WeakMap()

/**
 * @param agent - the agent whose turn is running.
 * @returns its mutable bookkeeping.
 */
function stateFor(agent) {
  let state = states.get(agent)
  if (state === undefined) {
    state = { steeringTurns: new Set(), nudgedTurns: new Set(), nudges: 0 }
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

  if (cfg.contract) {
    const contract = buildContractText()
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: contract,
      }),
      'task-anchor: contract section',
    )
  }

  // Observation only: the batch is claimed before this handler runs, so the
  // messages survive whatever we return. Never drop them by returning a new array.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (cfg.guard && detectInterjection(payload)) {
        stateFor(payload.agent).steeringTurns.add(payload.turn)
        ctx.logger?.debug?.('task-anchor: mid-turn user message observed (turn %d, step %d)', payload.turn, payload.step)
      }
    } catch (error) {
      ctx.logger?.debug?.('task-anchor: observation skipped: %s', String(error?.message ?? error))
    }
    return decision
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      if (!cfg.guard) return
      if (payload.signal?.aborted) return
      const agent = payload.agent
      const state = stateFor(agent)
      if (state.nudgedTurns.has(payload.turn)) return
      if (state.nudges >= cfg.maxNudgesPerSession) return

      const steering = state.steeringTurns.has(payload.turn)
      const queued = cfg.triggerQueued && agent.inbox.nextTurn.length > 0
      if (!steering && !queued) return

      const events = agent.session.events
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
