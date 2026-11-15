/**
 * Policy tests — no harness, no Cordis, just a session-log-shaped array.
 * Run with `node --test tests/` (or `pnpm test`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assistantText,
  buildAnchorText,
  buildContractText,
  buildNoticeText,
  detectInterjection,
  endsWithQuestion,
  isUserMessage,
  lastAssistantText,
  normalizeConfig,
  openTodos,
  turnStartSeq,
} from '../lib/policy.js'

let seq = 0

/** Build one session-log event. */
function ev(type, data) {
  seq += 1
  return { seq, type, data }
}

/** A controller-delivered user message. */
function userMessage(text) {
  return { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' } }
}

/** A plugin notice message. */
function notice(text) {
  return {
    id: `n${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:task-anchor', form: 'notice', summary: 'notice' },
  }
}

test('isUserMessage only accepts controller-delivered user messages', () => {
  assert.equal(isUserMessage(userMessage('hi')), true)
  assert.equal(isUserMessage(notice('hi')), false)
  assert.equal(isUserMessage({ role: 'user', content: [], source: { kind: 'plugin', plugin: 'x', form: 'snapshot' } }), false)
  assert.equal(isUserMessage(undefined), false)
})

test('detectInterjection flags a mid-turn user message and ignores the opener', () => {
  // Step 1 may carry [steering, opener] — both are next-step/next-turn claims.
  assert.equal(detectInterjection({ step: 1, messages: [userMessage('插话'), userMessage('原任务')] }), false)
  // Step 2 carrying a user message is the real mid-turn case.
  assert.equal(detectInterjection({ step: 2, messages: [userMessage('顺便把日志也清理一下')] }), true)
  // A plugin notice is never an interjection.
  assert.equal(detectInterjection({ step: 2, messages: [notice('guard')] }), false)
  assert.equal(detectInterjection({ step: 3, messages: [] }), false)
  assert.equal(detectInterjection(undefined), false)
})

test('assistantText skips tool-call-only parts', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'text', text: '先看看这个文件' },
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
    ],
  }
  assert.equal(assistantText(message), '先看看这个文件')
  assert.equal(assistantText({ role: 'assistant', content: [{ type: 'tool_use', id: 't2' }] }), '')
  assert.equal(assistantText({ role: 'assistant', content: [{ type: 'text', text: '   ' }] }), '')
})

test('endsWithQuestion recognises real questions only', () => {
  assert.equal(endsWithQuestion('需要我直接改掉吗？'), true)
  assert.equal(endsWithQuestion('Are you sure?'), true)
  assert.equal(endsWithQuestion('要 A 还是 B？“'), false)
  assert.equal(endsWithQuestion('全部完成了。'), false)
})

test('turnStartSeq finds the newest start of the requested turn', () => {
  seq = 0
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('assistant/message', { content: [{ type: 'text', text: 'a' }] }),
    ev('turn/start', { turn: 2 }),
    ev('turn/end', { turn: 1 }),
  ]
  assert.equal(turnStartSeq(events, 2), 3)
  assert.equal(turnStartSeq(events, 9), 0)
})

test('lastAssistantText stops at the turn boundary', () => {
  seq = 0
  const events = [
    ev('assistant/message', { content: [{ type: 'text', text: '旧 turn 的话' }] }),
    ev('turn/start', { turn: 2 }),
    ev('assistant/message', { content: [{ type: 'tool_use', id: 't' }] }),
    ev('assistant/message', { content: [{ type: 'text', text: '本 turn 的话' }] }),
  ]
  assert.equal(lastAssistantText(events, 2), '本 turn 的话')
  assert.equal(lastAssistantText(events, 0), '本 turn 的话')
})

test('openTodos keeps only open, non-empty items', () => {
  seq = 0
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('todo/write', { todos: [
      { content: '改 policy.js', status: 'completed' },
      { content: '补测试', status: 'pending' },
      { content: '更新 README', status: 'in_progress' },
      { content: '   ', status: 'pending' },
    ] }),
  ]
  assert.deepEqual(openTodos(events).map(todo => todo.content), ['补测试', '更新 README'])
})

test('openTodos drops a list that is too old to be the current plan', () => {
  seq = 0
  const events = [ev('todo/write', { todos: [{ content: '旧计划', status: 'pending' }] })]
  for (let turn = 1; turn <= 4; turn += 1) events.push(ev('turn/start', { turn }))
  assert.equal(openTodos(events, { maxStaleTurns: 3 }).length, 0)
  assert.equal(openTodos(events, { maxStaleTurns: 4 }).length, 1)
})

test('openTodos returns nothing without a todo/write', () => {
  seq = 0
  assert.deepEqual(openTodos([ev('turn/start', { turn: 1 })]), [])
})

test('buildNoticeText lists the open work and folds the overflow', () => {
  const text = buildNoticeText({ items: ['a', 'b', 'c', 'd'], reason: 'interjection', maxItems: 2 })
  assert.match(text, /mid-turn user message/)
  assert.match(text, /- a\n- b/)
  assert.match(text, /and 2 more/)
  assert.match(text, /Do not silently drop them/)
  assert.equal(buildNoticeText({ items: [], reason: 'interjection' }), '')
  assert.match(buildNoticeText({ items: ['a'], reason: 'queued' }), /queued user message/)
})

test('buildContractText names all five relations and the no-silent-drop rule', () => {
  const text = buildContractText()
  for (const phrase of ['added constraint', 'correction', 'question', 'separate new task', 'explicit change or cancellation']) {
    assert.ok(text.includes(phrase), `contract must mention "${phrase}"`)
  }
  assert.match(text, /Never silently abandon unfinished work/)
})

test('normalizeConfig fills defaults and clamps bad values', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.guard, true)
  assert.equal(defaults.maxNudgesPerSession, 6)
  assert.equal(defaults.maxNoticeItems, 5)
  assert.equal(defaults.maxStaleTurns, 3)

  const tuned = normalizeConfig({ enabled: false, maxNudgesPerSession: 0, maxNoticeItems: 0, maxStaleTurns: -2, storeTtlDays: -5 })
  assert.equal(tuned.enabled, false)
  assert.equal(tuned.maxNudgesPerSession, 0)
  assert.equal(tuned.maxNoticeItems, 1)
  assert.equal(tuned.maxStaleTurns, 0)
  assert.equal(defaults.storeTtlDays, 7)
  assert.equal(tuned.storeTtlDays, 0)
  assert.equal(normalizeConfig({ storeTtlDays: 30 }).storeTtlDays, 30)
  assert.equal(tuned.contract, true)
})

test('buildAnchorText points at the transcript when a sequence is known', () => {
  const withSeq = buildAnchorText({
    items: ['写报告'],
    interjection: '晚上吃什么',
    stoppedAt: '正在查榜单',
    seq: 1531,
  })
  assert.match(withSeq, /## Suspended work/)
  assert.match(withSeq, /session event #1531/)
  assert.match(withSeq, /session_event_read/)

  // No known position must not render a dangling pointer.
  const withoutSeq = buildAnchorText({ items: ['写报告'] })
  assert.doesNotMatch(withoutSeq, /session event #/)
})

test('contract says where durable evidence belongs', () => {
  const body = buildContractText()
  assert.match(body, /### Keeping what you already found/)
  assert.match(body, /expensive to obtain again/)
})

test('contract makes a cancellation silent afterwards', () => {
  const body = buildContractText()
  assert.match(body, /### After a cancellation/)
  assert.match(body, /silent from then on/)
  assert.match(body, /no "as you cancelled X"/)
  assert.match(body, /answer once and drop it again/)
})

test('contract turns a granted answer into a reported action', () => {
  const body = buildContractText()
  assert.match(body, /### Answering a question you asked/)
  assert.match(body, /not a fact to file away/)
  assert.match(body, /states what ran and what came back/)
})

test('wait mode asks the model to stop; auto mode asks it to resume', () => {
  const wait = buildContractText({ returnPolicy: 'wait' })
  assert.match(wait, /### Waiting for the user/)
  assert.match(wait, /do not pick it back up until the user asks/)
  assert.doesNotMatch(wait, /### Resuming suspended work/)

  const auto = buildContractText({ returnPolicy: 'auto' })
  assert.match(auto, /### Resuming suspended work/)
  assert.doesNotMatch(auto, /### Waiting for the user/)

  // No options = the default profile (auto).
  assert.match(buildContractText(), /### Resuming suspended work/)
})
