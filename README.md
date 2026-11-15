# task-anchor

> When a task is interrupted mid-flight, don't let the original task disappear.

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

## What it does

1. **Contract** (`task-anchor:contract`, a system-prompt section, ~150 tokens per request): a mid-turn user message is new input, not automatically a replacement for the task in progress. Classify it first — added constraint / correction of the current step / question / separate new task / explicit change or cancellation — then act. Never silently abandon unfinished work.

2. **Guard** (`agent/turn-stopping`): when all of the following hold, `agent.steer()` returns one notice to the turn:
   - this turn observed a mid-turn user message (`step > 1` and the batch contains a `source.kind === 'user'` message), **or** `inbox.nextTurn` already holds a queued message;
   - the latest `todo/write` (within `maxStaleTurns` turns) still has `pending` / `in_progress` items;
   - the turn's final sentence is not a question (`skipWhenAsking`);
   - this turn was not nudged yet and the session is under `maxNudgesPerSession`.

   The model takes one more step: finish, or say what remains and why.

3. **Observation** (`agent/pre-step`): read-only bookkeeping of which turns received an interjection; visible in debug logs.

## Install (local profile)

```powershell
# 1) register the directory as a profile dependency and bundle
#    T:\Deepseek-harness\.dsh\profiles\desktop\package.json:
#    dependencies      -> "dsh-task-anchor": "link:T:/dsh-task-anchor"
#    dsh.profile.bundles -> "dsh-task-anchor"
# 2) link it
cd T:\Deepseek-harness\.dsh\profiles\desktop
pnpm install
# 3) restart DSH (host plugins load at boot; profile bundles are not hot-reloaded)
```

## Config

Under `config:` in `cordis.patch.yml`; every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` registers nothing |
| `contract` | `true` | Inject the prompt contract (~150 tokens/request) |
| `guard` | `true` | Enable the turn-stopping guard |
| `triggerQueued` | `true` | Also act when a queued message is waiting for the next turn |
| `skipWhenAsking` | `true` | Skip when the turn ended with a question |
| `maxNudgesPerSession` | `6` | Nudges per session; `0` = observe only |
| `maxNoticeItems` | `5` | Items listed in the notice |
| `maxStaleTurns` | `3` | Turns after which a todo list is stale |

## Boundaries

- **No relation classification.** The plugin calls no model and does not decide which kind of interjection arrived; the contract plus the model own that judgement. The plugin only enforces the mechanical part: was open work left behind?
- **Step-1 interjections are not detected.** `claim()` takes `next-step` and `next-turn` together at step 1, so "steering" and "opener" cannot be told apart by step alone. Documented known gap.
- **Turns without a todo list are never nudged.** No declared plan, no open item to account for.
- **It never delays an interjection.** Holding messages until the turn ends would silence a legitimate "stop, wrong direction".
- **It does not touch `surface.ts`.** The model-side identity of a steering message stays flat; adding a render-layer marker requires a meta renderer and a new Agent Note.

## Relation to neighbouring plugins

- `dsh-loop-continue` and `dsh-early-stop-guard` also `agent.steer()` from `agent/turn-stopping`. This plugin nudges at most once per turn, but two plugins can each nudge in the same turn; pick one.
- `dsh-todo-float-ball` only displays "plans lost to an interruption"; it does not inject anything. Complementary.

## Verify

```powershell
cd T:\dsh-task-anchor
node --test tests/     # 36 tests: policy decisions + apply() wiring, no harness needed
```

Manual end-to-end after a restart: give the agent a three-step task that starts with a todo list, inject an unrelated question during step 2, then check that a `[task-anchor]` notice appears before the turn closes and that the model accounts for the remaining items.

Log keys: `task-anchor: steered a reminder` (info), `task-anchor: mid-turn user message observed` (debug).

Confirmed 2026-11-15: after a restart the session system prompt contains the `## Mid-turn user messages` contract section, so the plugin loads and the section is injected. The guard's end-to-end trigger is still unverified.

## Status

Progress, evidence, open items, next steps: [docs/STATUS.md](docs/STATUS.md). Design rationale: [docs/DESIGN.md](docs/DESIGN.md).
