/**
 * Glue tests — the real `apply()` wired to a fake Cordis context.
 *
 * These catch what the policy tests cannot: a wrong hook name, a contract that is
 * never registered, a notice that never reaches `agent.steer`, a guard that fires
 * twice in one turn.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { snapshotFileName } from '../lib/store.js'

// The default store is `DSH_HOME/task-anchor`; these tests run the real
// `apply()`, which persists interjections, so keep it in a scratch directory.
const scratch = mkdtempSync(join(tmpdir(), 'task-anchor-'))
process.env.DSH_HOME = scratch
after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

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
let nextSession = 0

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
  nextSession += 1
  return {
    agent: {
      id: 'agent-1',
      // Session exposes the log via snapshotEvents(); the fake mirrors that
      // surface only, so a stale `.events` read fails here instead of in prod.
      session: { id: `session-${nextSession}`, snapshotEvents: () => events },
      inbox: { nextTurn },
      steer: message => steered.push(message),
    },
    steered,
  }
}

/** A fake agent with a caller-owned log and session id. */
function bareAgent(sessionId, events) {
  const steered = []
  return {
    agent: {
      id: `agent-${sessionId}`,
      session: { id: sessionId, snapshotEvents: () => events },
      inbox: { nextTurn: [] },
      steer: message => steered.push(message),
    },
    steered,
  }
}

/** Read a section body the way the prompt service does: provider or literal. */
function sectionText(section, agent) {
  return typeof section.text === 'function' ? section.text({ agent }) : section.text
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
  // The section is provider-backed (the suspension block is appended at assembly
  // time), so read it the way the prompt service does.
  assert.match(sectionText(sections[0], undefined), /Mid-turn user messages/)
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

test('a triage interjection persists the plan and shows it in the prompt', async () => {
  const dir = join(scratch, 'triage')
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { storeDir: dir })
  const { agent } = fakeAgent(turnEvents('先按你说的改日志。'))

  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('顺便把日志级别也降一下')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  const body = sectionText(sections[0], agent)
  assert.match(body, /## Suspended work/)
  assert.match(body, /补测试/)
  assert.match(body, /顺便把日志级别也降一下/)

  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^suspended-.*\.json$/)
  const saved = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
  assert.equal(saved.interjection, '顺便把日志级别也降一下')
  assert.equal(saved.turn, 1)
  assert.deepEqual(saved.items, ['补测试'])
})

test('writing a snapshot sweeps stale orphans from other sessions only', async () => {
  const dir = join(scratch, 'prune')
  mkdirSync(dir, { recursive: true })
  const stale = join(dir, snapshotFileName('session-abandoned'))
  const fresh = join(dir, snapshotFileName('session-other'))
  writeFileSync(stale, '{}')
  writeFileSync(fresh, '{}')
  const longAgo = new Date(Date.now() - 30 * 86_400_000)
  utimesSync(stale, longAgo, longAgo)

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { storeDir: dir, storeTtlDays: 7 })
  const { agent } = fakeAgent(turnEvents('先按你说的改日志。'))
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('顺便把日志级别也降一下')] },
    async () => ({ kind: 'enter', messages: [] }),
  )

  const names = readdirSync(dir)
  assert.equal(names.includes(snapshotFileName('session-abandoned')), false)
  assert.ok(names.includes(snapshotFileName('session-other')))
  assert.ok(names.includes(snapshotFileName(agent.session.id)))
})

test('onInterject off writes nothing and keeps the section literal', async () => {
  const dir = join(scratch, 'off')
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { onInterject: 'off', storeDir: dir })
  assert.equal(typeof sections[0].text, 'string')

  const { agent } = fakeAgent(turnEvents('先这样。'))
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('插一句')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(existsSync(dir), false)
})

test('returnPolicy wait records the suspension but leaves the turn alone', async () => {
  const dir = join(scratch, 'wait')
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { returnPolicy: 'wait', storeDir: dir })
  const { agent, steered } = fakeAgent(turnEvents('先这样。'))

  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('插一句')], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })

  assert.equal(steered.length, 0)
  assert.match(sectionText(sections[0], agent), /Suspended work/)
  assert.equal(readdirSync(dir).length, 1)
})

test('rewriting the plan without the suspended items clears the anchor', async () => {
  const dir = join(scratch, 'cancel')
  const events = []
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { guard: false, storeDir: dir })
  const { agent } = bareAgent('sess-cancel', events)

  events.push(ev('turn/start', { turn: 1 }))
  events.push(ev('todo/write', { todos: [{ content: '写报告', status: 'in_progress' }] }))
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('先停一下')] },
    async () => ({}),
  )
  assert.match(sectionText(sections[0], agent), /写报告/)

  // The model judged the work cancelled and rewrote the list without it.
  events.push(ev('todo/write', { todos: [{ content: '写报告', status: 'completed' }] }))
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal })

  assert.doesNotMatch(sectionText(sections[0], agent), /## Suspended work/)
  assert.equal(readdirSync(dir).length, 0)
})

test('an anchor survives quiet turns and ignores unrelated new work', async () => {
  const dir = join(scratch, 'stale')
  const events = []
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { guard: false, storeDir: dir })
  const { agent } = bareAgent('sess-stale', events)

  events.push(ev('turn/start', { turn: 1 }))
  events.push(ev('todo/write', { todos: [{ content: '写报告', status: 'pending' }] }))
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('先停一下')] },
    async () => ({}),
  )
  assert.match(sectionText(sections[0], agent), /写报告/)

  // Five quiet turns later the plan is still owed; age alone must not drop it.
  for (let turn = 2; turn <= 6; turn += 1) events.push(ev('turn/start', { turn }))
  assert.match(sectionText(sections[0], agent), /## Suspended work/)
  assert.match(sectionText(sections[0], agent), /写报告/)

  // New work does not get relabelled as suspended …
  events.push(ev('todo/write', {
    todos: [{ content: '写报告', status: 'pending' }, { content: '写文档', status: 'pending' }],
  }))
  assert.match(sectionText(sections[0], agent), /写报告/)
  assert.doesNotMatch(sectionText(sections[0], agent), /写文档/)

  // … and rewriting the plan without the suspended item is the cancel signal.
  events.push(ev('todo/write', { todos: [{ content: '写文档', status: 'in_progress' }] }))
  assert.doesNotMatch(sectionText(sections[0], agent), /## Suspended work/)
  assert.equal(readdirSync(dir).length, 0)
})

test('a restarted process reads the suspended plan from disk', async () => {
  const dir = join(scratch, 'reload')
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('todo/write', { todos: [{ content: '补测试', status: 'pending' }] }),
  ]

  const first = fakeCtx()
  apply(first.ctx, { storeDir: dir })
  const a1 = bareAgent('sess-reload', events)
  await first.handlers.get('agent/pre-step')(
    { agent: a1.agent, turn: 1, step: 2, messages: [userMessage('插一句')] },
    async () => ({}),
  )
  assert.equal(readdirSync(dir).length, 1)

  // A new process: new plugin instance, new agent, same session id and log.
  const second = fakeCtx()
  apply(second.ctx, { storeDir: dir })
  const a2 = bareAgent('sess-reload', events)
  assert.match(sectionText(second.sections[0], a2.agent), /补测试/)
})

test('renders the open items line on assemblies with no suspension block', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, { storeDir: join(scratch, 'open-line') })
  const { agent } = bareAgent('sess-open', [
    ev('turn/start', { turn: 1 }),
    ev('todo/write', {
      todos: [
        { content: '写报告', status: 'pending' },
        { content: '补测试', status: 'completed' },
      ],
    }),
  ])

  const body = sectionText(sections[0], agent)
  assert.match(body, /Open items: 写报告/)
  // Completed items are not owed; only the open ones are listed.
  assert.doesNotMatch(body, /补测试/)
  assert.doesNotMatch(body, /## Suspended work/)
})

test('a finished plan renders no open items line', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, { storeDir: join(scratch, 'open-done') })
  const { agent } = bareAgent('sess-done', [
    ev('turn/start', { turn: 1 }),
    ev('todo/write', { todos: [{ content: '写报告', status: 'completed' }] }),
  ])
  assert.doesNotMatch(sectionText(sections[0], agent), /Open items:/)
})

test('the suspension block replaces the open items line', async () => {
  const { ctx, handlers, sections } = fakeCtx()
  apply(ctx, { storeDir: join(scratch, 'open-anchor') })
  const { agent } = fakeAgent(turnEvents('先按你说的改日志。'))
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, messages: [userMessage('顺便把日志级别也降一下')] },
    async () => ({}),
  )

  const body = sectionText(sections[0], agent)
  assert.match(body, /## Suspended work/)
  // One list, not two: the block already names the same items.
  assert.doesNotMatch(body, /Open items:/)
})
