# 更新日志

只记**两次公开发布之间**的净变化。开发过程中没发布过的中间版本不列。

## 0.4.0 — 2026-11-15

**同回合插话提示**（主路径）

- 插话发生在**当前正在跑的回合**时，那份快照不再渲染成 `## Suspended work`，而是 `## Interjection during this turn`：列出被挂起的条目、插话原文、三个读法（取消 → 重写清单；补充 → 就地改项；另一件事 → 本回合就停、一句话说明挂起了什么、回答用户刚问的），要求模型在**这一回合内**自己判断。插件不打断、不重投消息；下一回合开始后同一份快照回到 `## Suspended work` 的提醒措辞。

**强行拦停**（`forceStop`，默认 `off`，实验性）

- `forceStop: always` 时，中途消息不再只是「记下来」：`agent/pre-step` 把这一批消息放回 `next-turn` 并返回 `reject`，回合在那个边界就结束（`turn/end` 记为 `blocked`），不会为这条插话再花一次模型调用；消息由下一回合开头交付。代价是宿主把它当成「回合结束」并播放提示音，所以这不是推荐路径。
- `forceStop: triage` 时先看文本：像取消（`cancelPatterns`）或像补充修改（`amendPatterns`）的插话**不停回合**，留给人/模型按契约改写 todo；只有像「另一件事」的插话才停。这是关键词启发式，不是语义判断——标记表可覆盖。
- 放回是**先落盘再结束**（写进 inbox 的持久化 splice），唤醒推到 `setImmediate` —— 因为驱动还在跑时发出的 wake 会被吞掉。若 agent 一直没回到 idle，消息就留在队列里，等下一个边界再交付。
- 默认关：结束一个正在跑的回合比「把它记下来」强硬得多，这个决定留给用户。

**配置**：新增 `forceStop`（`off`/`always`/`triage`）、`cancelPatterns`、`amendPatterns`。**测试**：48 条。

**文档**：两份 README 都加了「实验性：硬停（`forceStop`）」一节 —— 机制、六条限制（停的是回合不是计划、没有 assistant 收尾语、宿主提示音、`triage` 只是关键词、唤醒推迟到 idle、默认 `off` + `auto`），以及为什么它默认关。

## 0.2.3 — 2026-11-15

**发布方式**

- `.github/workflows/publish.yml`：推 `v*` tag 即由 GitHub Actions 通过 **trusted publishing（OIDC）** 发布到 npm —— 不需要长期令牌，也不需要在仓库里配 secret。先跑测试；公开仓 + 公开包会自动生成 provenance。
- `RELEASING.md` / `RELEASING.zh-CN.md` 写明 tag 驱动的流程、新建 trusted publisher 配置的 2 天验证窗口，以及手动兜底。

**文档**

- 两份 README 底部加官方 *powered by dsh* 徽章；商城徽章撤掉，等收录之后再放回来。

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
