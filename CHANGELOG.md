# Changelog

Net changes between **public releases**. Internal iterations that never shipped are not listed.

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
