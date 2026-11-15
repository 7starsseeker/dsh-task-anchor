# Changelog

## 0.2.1 — 2026-11-15

- **新**：`### After a cancellation` 契约段——取消之后不再复述（后续回复、解释、笔记、报告都不许再提；用户问原因只答一次）。状态层早就干净了，这次补的是「嘴」。
- **新**：孤儿快照按年龄清理。写快照时顺手删「不属于当前会话且超过 `storeTtlDays`（默认 7 天）」的 `suspended-*.json`；只扫本插件目录、只认自己的文件名，不碰 `DSH_HOME/sessions` 的会话归档，也不删当前会话。
- 35 条单测（17 策略 + 17 接线 + 1 store）。

## 0.2.0 — 2026-11-15

修复 + 挂起计划。

- **修**：守卫在真实插话里从未生效。`agent.session.events` 在 DSH 0.2.2-rc.3 不存在（`Session` 只暴露 `snapshotEvents()`），`openTodos(undefined)` 抛错被 `turn-stopping` 的 catch 吞成一行 debug 日志。改用 `snapshotEvents()`。
- **修**：`lastAssistantText` 读 `event.data`，而真实 `assistant/message` 把消息放在 `data.message`，导致 `skipWhenAsking` 永远失效。
- **新**：插话时把当时未完成的 todo 条目落盘一次（`suspended-<session>.json`，`items` 字段），之后每次组装 prompt 按「挂起项 ∩ 当前未完成项」渲染成 `## Suspended work`（未完成项 + 插话原文 + 停在哪一句）。交集为空即删；不按轮数过期，所以安静多轮后回来说「继续」仍能接上。
- **新**：配置项 `onInterject: triage|off`、`returnPolicy: wait|auto`、`storeDir`。
- **新**：契约段补「三类记账（取消 / 补充 / 挂起）」「双任务时的交付与顺序」「何时拆 subagent 的三条判据」。
- **新**：没有挂起项时，prompt 末尾渲染一行 `Open items: …`。todo 面板只在当轮可见，日志不是；这一行让「还欠着什么」在每个请求里都看得见。
- **新**：锚点末尾附带挂起时的会话事件号，并提示用 `session_event_read` 回读——证据本来就躺在日志里，模型只是不知道去哪找。
- **新**：契约补「证据落盘」一条：重取昂贵（不止一次调用、花了钱或配额、有外部副作用）的中间结论写成文件，todo 指向它；重取便宜的不落。
- 32 条单测（16 条策略 + 16 条 `apply()` 接线），零运行时依赖。

## 0.1.0 — 2026-11-15

首个版本。

- 系统提示契约 `task-anchor:contract`：中途 user 消息的五类关系与「不静默丢弃」规则（约 150 tokens/请求，可关）。
- `agent/turn-stopping` 守卫：本回合收到插话（或下回合已有排队消息）且 todo 未完成时，`agent.steer()` 一条 notice 回本回合；每回合最多一次，会话上限可配。
- `agent/pre-step` 只读观察，debug 日志可见。
- 21 条单测（12 条策略 + 9 条 `apply()` 接线，`node --test tests/`），零运行时依赖。
- 已知边界：step 1 时段的插话不判定；无 todo 的回合不催；不阻止/延迟插话。
