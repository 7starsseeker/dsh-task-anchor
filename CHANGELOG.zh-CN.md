# 更新日志

只记**两次公开发布之间**的净变化。开发过程中没发布过的中间版本不列。

## 0.2.2 — 2026-11-15 — 首次公开发布

**提示契约**（`task-anchor:contract`，system prompt section，约 320 tokens/请求，`contract: false` 可整段关掉）

- 中途 user 消息是「新输入」，不是「任务的替代品」：补充约束 / 修正当前步 / 追问 / 独立新任务 / 改目标或中止。
- 被挂起的计划怎么记账（取消 = 重写清单去掉它；补充 = 改写该项；挂起 = 保留它并把新活加进清单），以及被取消的任务之后不再复述。
- 用户回答你问过的问题是**决定**而不是情报：把动作写进 todo，跑完、在回复里写清「跑了什么、回了什么」才算完。
- 两个任务同时来：执行是串行的；什么时候该增量交付；什么条件下把一个任务交给 subagent（三条判据同时成立）；排序规则（用户指定 > 依赖 > 短优先 > 接近完成）。
- 收尾规则随 `returnPolicy` 变：`auto` 明说会有提醒把回合拉回来；`wait` 要求处理完插话就停，并声明挂起计划原封不动、等用户开口。
- 重取昂贵的中间结论写成文件、todo 指向它；一次搜索就能重取的不落。

**挂起计划**

- 插话到达且清单里还有未完成项时，把未完成项写一次到 `suspended-<session>.json`。
- 之后每次组装 prompt 渲染 `## Suspended work`：还剩哪些、打断它的是哪句话、停在哪、以及当时的会话事件号（`session_event_read` 可回读）。
- 项从清单里消失（做完或取消）即消失；全部消失时删文件。不按轮数过期，所以安静一段后说「继续」仍能接上。
- 没有快照但有待办时，段末只追加一行 `Open items: …`——todo 面板是当轮表面，日志不是。

**守卫**

- `agent/turn-stopping` 上：本回合收到插话（或下回合已有排队消息）且最近的 `todo/write` 还有未完成项时，`agent.steer()` 把一条 notice 递回本回合，让模型干完或写明「剩下什么、为什么」。
- 每回合最多一次、每会话最多 `maxNudgesPerSession` 次；本回合以提问结尾时跳过（`skipWhenAsking`）。

**配置**：`enabled`、`contract`、`guard`、`onInterject`、`returnPolicy`、`triggerQueued`、`skipWhenAsking`、`maxNudgesPerSession`、`maxNoticeItems`、`maxStaleTurns`、`storeDir`、`storeTtlDays`。全部可省略。

**维护**：写快照时顺手清理其它会话超过 `storeTtlDays` 天的 `suspended-*.json`；DSH 自己的会话归档从不触碰。

**测试**：37 条（`node --test`，不需要启动 harness）。零运行时依赖。
