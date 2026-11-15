# Changelog

## 0.1.0 — 2026-11-15

首个版本。

- 系统提示契约 `task-anchor:contract`：中途 user 消息的五类关系与「不静默丢弃」规则（约 150 tokens/请求，可关）。
- `agent/turn-stopping` 守卫：本回合收到插话（或下回合已有排队消息）且 todo 未完成时，`agent.steer()` 一条 notice 回本回合；每回合最多一次，会话上限可配。
- `agent/pre-step` 只读观察，debug 日志可见。
- 21 条单测（12 条策略 + 9 条 `apply()` 接线，`node --test tests/`），零运行时依赖。
- 已知边界：step 1 时段的插话不判定；无 todo 的回合不催；不阻止/延迟插话。
