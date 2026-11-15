# dsh-task-anchor

> 中文版：[README.zh-CN.md](README.zh-CN.md)

When a task is interrupted mid-flight, don't let the original task disappear.

[![selftest](https://github.com/7starsseeker/dsh-task-anchor/actions/workflows/selftest.yml/badge.svg)](https://github.com/7starsseeker/dsh-task-anchor/actions/workflows/selftest.yml)
[![npm](https://img.shields.io/npm/v/dsh-task-anchor.svg)](https://www.npmjs.com/package/dsh-task-anchor)
[![npm downloads](https://img.shields.io/npm/dm/dsh-task-anchor.svg)](https://www.npmjs.com/package/dsh-task-anchor)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-1F3A8A.svg)](https://github.com/7starsseeker)

A zero-dependency DeepSeek Harness host plugin. **When a turn receives a mid-turn user message and ends with unfinished todos, it steers one notice back into that turn** so the model either finishes the work or states plainly what remains.

No core patch, no fork, no change to the session projection.

---

## The failure it addresses

A mid-turn message reaches DSH through one of two paths, and both can drop the running task:

| Path | Mechanism | Where it fails |
| --- | --- | --- |
| steer (Enter while busy) | The message joins `inbox`'s `next-step`; the next step boundary claims it and appends it as an ordinary `user/message` | The interjection reaches the model with the **same shape and weight as the opening prompt** (`packages/core/session/src/surface.ts` projects it verbatim — a deliberate 2026-07-20 decision), and the system prompt says nothing about mid-turn messages. The model readily treats the newest user message as the only task |
| queue | The message joins `next-turn`; the current turn ends normally and the message opens the next one | The turn ends with todos unfinished and **nothing checks what it left behind**; the next turn belongs to the new message |

Common root: the todo projection is cleared at `turn/start` (`packages/todo/tool-todo/src/index.ts`), so the next turn is never reminded that work is still open.

**Scope, stated plainly.** This softens the drift; it does not remove it. The interrupting message still takes the step it lands on, and the model can still pivot before the next boundary — the contract is advisory and the guard fires only once the turn is already closing. What changes is that the plan survives the pivot: it is written down, re-rendered, and the turn cannot close silently with it unfinished. Closing the gap itself — deciding that a mid-turn message should wait, and giving it a different identity in the transcript — is a harness decision, not a plugin one.

## What it does

1. **Contract** (`task-anchor:contract`, a system-prompt section, ~320 tokens per request): a mid-turn user message is new input, not automatically a replacement for the task in progress. Classify it first — added constraint / correction of the current step / question / separate new task / explicit change or cancellation — then act. The same section says how to record a suspended plan, when a finding is expensive enough to persist, that an answer to your own question is a decision rather than a fact, and that work the user cancelled is not re-narrated afterwards. Never silently abandon unfinished work.

2. **Suspended plan** (`agent/pre-step` → one JSON file): when a mid-turn message arrives while todos are open, the open items are written once to `suspended-<session>.json`. Every later assembly renders them back as a `## Suspended work` block — only the items still open, the message that interrupted, where the turn stopped, and the session event number that holds the transcript for `session_event_read`. When those items leave the list (done or cancelled) the file is deleted. With no snapshot but open work, the section ends with a single `Open items: …` line, because the todo panel is a per-turn surface and the log is not.

3. **Guard** (`agent/turn-stopping`): when all of the following hold, `agent.steer()` returns one notice to the turn:
   - this turn observed a mid-turn user message (`step > 1` and the batch contains a `source.kind === 'user'` message), **or** `inbox.nextTurn` already holds a queued message;
   - the latest `todo/write` (within `maxStaleTurns` turns) still has `pending` / `in_progress` items;
   - the turn's final sentence is not a question (`skipWhenAsking`);
   - this turn was not nudged yet and the session is under `maxNudgesPerSession`.

   The model takes one more step: finish, or say what remains and why.

4. **Observation** (`agent/pre-step`): read-only bookkeeping of which turns received an interjection; visible in debug logs.

Snapshots are swept opportunistically: writing one deletes *other* sessions' `suspended-*.json` older than `storeTtlDays`. The plugin never touches DSH's own session archive.

## Install (local profile)

```powershell
# 1) register the directory as a profile dependency and bundle.
#    Edit <DSH_HOME>/profiles/desktop/package.json:
#    dependencies        -> "dsh-task-anchor": "link:<path-to-this-repo>"
#    dsh.profile.bundles -> "dsh-task-anchor"
# 2) link it
cd <DSH_HOME>/profiles/desktop
pnpm install
# 3) restart DSH (host plugins load at boot; profile bundles are not hot-reloaded)
```

`<DSH_HOME>` is the directory that contains `profiles/` (wherever your DSH install keeps its profile data).

## Config

Under `config:` in `cordis.patch.yml`; every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` registers nothing |
| `contract` | `true` | Inject the prompt contract (~320 tokens/request); also gates the anchor block |
| `guard` | `true` | Enable the turn-stopping guard |
| `onInterject` | `triage` | On a mid-turn message, persist the suspended plan (`triage`) or only keep the guard (`off`) |
| `returnPolicy` | `auto` | Nudge the turn (`auto`) or record only until the user speaks again (`wait`). `wait` disables the nudge; on its own it **cannot abort a running turn** — see DESIGN §7.4 |
| `forceStop` | `false` | End the turn at the step boundary the interjection landed on and hand that message to the next turn. Off by default; meant to be paired with `returnPolicy: wait` |
| `triggerQueued` | `true` | Also act when a queued message is waiting for the next turn |
| `skipWhenAsking` | `true` | Skip when the turn ended with a question |
| `maxNudgesPerSession` | `6` | Nudges per session; `0` = observe only |
| `maxNoticeItems` | `5` | Items listed in the notice / the `Open items:` line |
| `maxStaleTurns` | `3` | Turns after which a todo list is stale (guard only) |
| `storeDir` | `<DSH_HOME>/task-anchor` | Where `suspended-<session>.json` lives; falls back to `~/.dsh/task-anchor` |
| `storeTtlDays` | `7` | Age after which another session's stale snapshot is swept while writing; `0` disables |

## Boundaries

- **No relation classification.** The plugin calls no model and does not decide which kind of interjection arrived; the contract plus the model own that judgement. The plugin only enforces the mechanical part: was open work left behind?
- **Step-1 interjections are not detected.** `claim()` takes `next-step` and `next-turn` together at step 1, so "steering" and "opener" cannot be told apart by step alone. Documented known gap.
- **Turns without a todo list are never nudged.** No declared plan, no open item to account for.
- **It never delays an interjection.** A `agent/pre-step` listener could rewrite the step's `messages` — the waterfall's `enter` decision is exactly what gets logged and sent to the model — and park the message for later; returning `reject` instead ends the turn right there (`turn/end` reason `blocked`). This plugin deliberately does neither: holding a message would silence a legitimate "stop, wrong direction", and rejecting the step would throw away the half-done work too. Stopping *because of* an interjection stays the user's call.
- **It does not touch `surface.ts`.** The model-side identity of a steering message stays flat; adding a render-layer marker requires a meta renderer and a new Agent Note.

## Relation to neighbouring plugins

- `dsh-loop-continue` and `dsh-early-stop-guard` also `agent.steer()` from `agent/turn-stopping`. This plugin nudges at most once per turn, but two plugins can each nudge in the same turn; pick one.
- `dsh-todo-float-ball` only displays "plans lost to an interruption"; it does not inject anything. Complementary.

## Verify

```powershell
cd <path-to-this-repo>
node --test     # 40 tests: policy decisions + apply() wiring, no harness needed
```

Manual end-to-end after a restart: give the agent a three-step task that starts with a todo list, inject an unrelated question during step 2, then check that a `[task-anchor]` notice appears before the turn closes and that the model accounts for the remaining items.

Log keys: `task-anchor: steered a reminder` (info), `task-anchor: mid-turn user message observed` (debug).

Confirmed 2026-11-15 on DSH 0.2.2-rc.3: after a restart the session system prompt contains the contract section, an unrelated mid-turn question produced a `suspended-<session>.json` plus the `## Suspended work` block, and the turn closed with an `[task-anchor]` notice. Rewriting the todo list without the suspended items deleted the file.

`returnPolicy: wait` was also tried: the guard stayed quiet as intended, **but the turn did not stop** — the model kept working on the suspended plan on its own. That is the honest boundary: `wait` removes the nudge, and the only thing left to ask for a stop is the contract text, so `### Waiting for the user` was added to state it explicitly. If the model ignores it, `agent/turn-stopping` cannot abort a running turn (`agent.steer()` can only add a step). `forceStop: true` closes that gap mechanically: the `agent/pre-step` handler parks the claimed message into `next-turn` and returns `reject`, so the step never opens, `turn/end` records `blocked`, and the next turn starts with the interjection. Not yet verified live.

## Status

Progress, evidence, open items, next steps: [docs/STATUS.md](docs/STATUS.md). Design rationale: [docs/DESIGN.md](docs/DESIGN.md).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
