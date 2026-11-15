# Changelog

Net changes between **public releases**. Internal iterations that never shipped are not listed.

## 0.4.0 — 2026-11-15

**Interjection, in the turn it lands** (the main path)

- A snapshot written for a message that arrived in the turn currently running now renders as `## Interjection during this turn` instead of `## Suspended work`. It lists the parked items, the message itself, and the three readings — cancellation (rewrite the list), amendment (edit the item), separate work (stop this turn, say what is parked, answer what was asked) — and asks the model to decide in that turn. The plugin does not interrupt; the same snapshot renders as `## Suspended work` once the next turn starts.

**Hard stop** (`forceStop: off` by default, experimental)

- With `forceStop: always`, a mid-turn message no longer merely gets recorded: the `agent/pre-step` handler parks the claimed message into `next-turn`, returns `reject`, and the turn ends at that boundary (`turn/end` reason `blocked`) instead of spending a model call on the interruption. The parked message opens the next turn. The host treats that as an ended turn and plays its end-of-task cue — which is why this is not the recommended path.
- With `forceStop: triage`, the text is read first: an interjection that looks like a cancellation (`cancelPatterns`) or an amendment (`amendPatterns`) leaves the turn running so the plan can be rewritten; only text that reads as separate work stops it. This is a keyword heuristic, not a judgement — the lists are configurable.
- The parked copy is written to the durable inbox before the turn closes; the wake for the next turn is deferred to `setImmediate`, because a wake raised while the loop is still running is swallowed. If the agent never goes idle, the message stays pending and is delivered at the next boundary.
- Off by default — ending a running turn is a stronger decision than writing the interruption down.

**Config**: `forceStop` (`off`/`always`/`triage`), `cancelPatterns`, `amendPatterns`. **Tests**: 48.

**Docs**: both READMEs carry an *Experimental: the hard stop* section — mechanism, the six limits (turn not plan, no closing line, host cue, keyword-only `triage`, wake deferred to idle, config defaults), and why it stays off by default alongside `returnPolicy: auto`.

## 0.2.3 — 2026-11-15

**Publishing**

- `.github/workflows/publish.yml`: pushing a `v*` tag now publishes to npm from GitHub Actions via **trusted publishing (OIDC)** — no long-lived token and no repository secret. Tests run first; provenance is generated automatically for a public repository and a public package.
- `RELEASING.md` / `RELEASING.zh-CN.md` describe the tag-driven flow, the 2-day validation window of a new trusted-publisher configuration, and the manual fallback.

**Docs**

- READMEs carry the official *powered by dsh* badge at the bottom; the plugin-store badge is removed until the listing exists.

## 0.2.2 — 2026-11-15 — first public release

**Prompt contract** (`task-anchor:contract`, system-prompt section, ~320 tokens per request, `contract: false` removes it)

- A mid-turn user message is a new input, not automatically a replacement for the task in progress: added constraint / correction / question / separate task / change or cancellation.
- How to record a suspended plan (cancel = rewrite the list without it, amend = edit the item, suspend = keep it and add the new work), and that a cancelled task is not re-narrated afterwards.
- An answer to a question you asked is a decision, not a fact: name the action in a todo, run it, and only consider it done once the reply says what ran and what came back.
- Two tasks at once: execution is serial; when to deliver incrementally; the three conditions that justify handing one task to a subagent; ordering (user-specified > dependency > shorter first > closer to done).
- The closing rule depends on `returnPolicy`: `auto` states that a reminder will be steered back in, `wait` asks for a stop after the interrupting message and says the suspended plan stays untouched until asked.
- Findings that are expensive to obtain again get written to a file and referenced from a todo; cheap lookups do not.

**Suspended plan**

- On a mid-turn message with open todos, the open items are written once to `suspended-<session>.json`.
- Every later prompt assembly renders `## Suspended work`: the items still open, the message that interrupted, where the turn stopped, and the session event number that holds the transcript (`session_event_read`).
- Items that leave the todo list (done or cancelled) disappear; when none remain the file is deleted. The block does not age out by turn count, so "continue" still works after a quiet stretch.
- With no snapshot but open work, the section ends with one `Open items: …` line — the todo panel is per-turn, the log is not.

**Guard**

- On `agent/turn-stopping`, when this turn received a mid-turn user message (or a queued message is waiting) and a recent `todo/write` still has unfinished items, `agent.steer()` sends one notice back into the turn. The model finishes, or states plainly what remains and why.
- At most once per turn and `maxNudgesPerSession` per session; skipped when the turn ended with a question (`skipWhenAsking`).

**Config**: `enabled`, `contract`, `guard`, `onInterject`, `returnPolicy`, `triggerQueued`, `skipWhenAsking`, `maxNudgesPerSession`, `maxNoticeItems`, `maxStaleTurns`, `storeDir`, `storeTtlDays`. Every key is optional.

**Maintenance**: writing a snapshot sweeps other sessions' `suspended-*.json` older than `storeTtlDays`; DSH's session archive is never touched.

**Tests**: 37 (`node --test`, no harness needed). Zero runtime dependencies.
