/**
 * Glue tests — the real `apply()` wired to a fake Cordis context.
 *
 * These catch what the policy tests cannot: a wrong hook name, a contract that is
 * never registered, a notice that never reaches `agent.steer`, a guard that fires
 * twice in one turn.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

/** Minimal fake Cordis context that records what the plugin registers. */
function fakeCtx() {
  const handlers = new Map()
  const sections = []
  const logs = []
  const ctx = {
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
    },
    effect: setup => setup(),
    on: (name, handler) => handlers.set(name, handler),
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
    },
  }
  return { ctx, handlers, sections, logs }
}

let nextId = 0

/** A session-log event. */
function ev(type, data) {
  nextId += 1
  return { seq: nextId, time: nextId, type, data }
}

/** A user message delivered by the controller. */
function userMessage(text) {
  return { id: `m${nextId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r' } }
}

/** A fake agent recording steered messages. */
function fakeAgent(events, nextTurn = []) {
  const steered = []
  return {
    agent: {
      id: 'agent-1',
      session: { events },
      inbox: { nextTurn },
      steer: message => steered.push(message),
    },
    steered,
  }
}

/** A turn that already ran one step and is ending with the given final text. */
function turnEvents(finalText) {
  return [
    ev('turn/start', { turn: 1 }),
    ev('todo/write', { todos: [{ content: '改 lib/policy.js', status: 'completed' }, { content: '补测试', status: 'pending' }] }),
    ev('assistant/message', { content: [{ type: 'tool_use', id: 't1' }] }),
    ev('assistant/message', { content: [{ type: 'text', text: finalText }] }),
  ]
}

test('apply registers the contract section once, at the documented slot', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'task-anchor:contract')
  assert.equal(sections[0].order, 540)
  assert.match(sections[0].text, /Mid-turn user messages/)
})

test('apply honours contract:false', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, { contract: false })
  assert.equal(sections.length, 0)
})

test('apply does nothing when disabled', () => {
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(sections.length, 0)
  assert.equal(handlers.size, 0)
})

test('a mid-turn user message leads to exactly one notice on turn stop', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const { agent, steered } = fakeAgent(turnEvents('我先按你说的改日志。'))

  const preStep = handlers.get('agent/pre-step')
  const decision = await preStep(
    { agent, turn: 1, step: 2, messages: [userMessage('顺便把日志级别也降一下')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [userMessage('顺便把日志级别也降一下')] }),
  )
  assert.equal(decision.kind, 'enter')

  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
  const notice = steered[0]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'plugin:task-anchor')
  assert.match(notice.id, /^[0-9a-f-]{36}$/)
  assert.match(notice.content[0].text, /\[task-anchor\]/)
  assert.match(notice.content[0].text, /补测试/)
  assert.match(notice.content[0].text, /Do not silently drop them/)

  // A second stop in the same turn must not nudge again.
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
})

test('no interjection and no queued message means no notice', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const { agent, steered } = fakeAgent(turnEvents('全部完成。'))
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 0)
})

test('a queued message for the next turn is enough to guard', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const { agent, steered } = fakeAgent(turnEvents('先这样。'), [userMessage('接着做下一件事')])
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /queued user message/)
})

test('turn ending with a question is left alone', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const { agent, steered } = fakeAgent(turnEvents('补测试要先装依赖，你希望我装吗？'))
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('插一句')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 0)
})

test('an aborted turn is never revived', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const { agent, steered } = fakeAgent(turnEvents('停下。'))
  const controller = new AbortController()
  controller.abort()
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('插一句')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: controller.signal })
  assert.equal(steered.length, 0)
})

test('the notice itself is not mistaken for a new interjection', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const { agent, steered } = fakeAgent(turnEvents('继续。'))
  const preStep = handlers.get('agent/pre-step')
  await preStep(
    { agent, turn: 1, step: 2, messages: [userMessage('插一句')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })
  const notice = steered[0]

  // The machine re-reads the inbox: the next step claims our own notice.
  await preStep(
    { agent, turn: 1, step: 3, messages: [notice], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [notice] }),
  )
  // A fresh turn with no interjection must not be guarded.
  const second = fakeAgent(turnEvents('这一轮没有插话。'))
  await handlers.get('agent/turn-stopping')({ agent: second.agent, turn: 1, signal: new AbortController().signal })
  assert.equal(second.steered.length, 0)
})
