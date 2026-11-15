# STATUS — dsh-task-anchor

更新：2026-11-15。这是交接快照，不是设计文档（设计见 [DESIGN.md](DESIGN.md)）。

## 一句话状态

v0.3.0（未发布）已实现、**40 条单测通过**、已挂载进 desktop profile。三个机制都已在 live 会话里验收：契约段常驻、插话时落盘 `suspended-<session>.json` 并渲染 `## Suspended work`、回合收尾时 `agent.steer` 递回一条 `[task-anchor]` notice；**取消路径**（改写清单 → 锚点消失 → 快照删除）也已跑通。`returnPolicy: wait` 实测过：守卫保持安静，但**回合没有停**（模型自己续跑），已补 `### Waiting for the user` 契约段；要机械停回合则开 `forceStop`（默认关，实现见 DESIGN §7.5，**尚未 live 验证**）。

## 要解决的问题（出处）

执行指令途中用户插话，agent 往往立刻转去做插话内容并输出，原任务做一半丢掉，或注意力被带偏。上游调研笔记没有随仓发布（做这个插件时在 DSH 的 notes 目录里留过一份，含会话实证；公开版不复述其中的会话细节）。

根因是三件事叠加，其中两件在 DSH core、本插件只能绕：

1. `packages/core/session/src/surface.ts:83-114` 把 `user/message` 逐字投影 —— 插话与开场 prompt 在模型眼里同形同权，没有「这是中途插入」的标记。
2. `packages/core/system-prompt/src/index.ts` 里 grep `steer|interrupt|mid-turn` 零命中 —— 模型从未被告知执行中收到新消息该怎么处理。
3. 没有跨步骤的任务锚：`todo` 投影在 `turn/start` 清空；compaction 的 `## Next Step` 又明确要求「对齐最近一次请求」，而插话恰好就是最近一次请求。

第 3 条由本插件补：插话时把「被挂起的计划」落盘一次，之后每次组装 prompt 都把它渲染回来。

## 本插件的三个机制

| 机制 | 挂点 | 作用 | 是否落盘 |
| --- | --- | --- | --- |
| 契约段 | `ctx.systemPrompt.section(...)`，order 540，每请求重新渲染 | 告诉模型：插话是新输入、不自动等于替换当前任务；五类关系 + 三类记账（取消/补充/挂起）+ 取消之后不再复述 + 用户回答你问过的问题（「可以」「go ahead」、选择、批准）是决定、要建 todo 并在回复里写清「跑了什么、回了什么」+ 双任务时何时拆 subagent、按什么顺序做 + 证据何时该落盘（重取昂贵的中间结论写成文件，todo 指向它）。没有挂起项时，末尾追加一行 `Open items: …`（todo 面板只在当轮可见，日志不是） | 否（system prompt，不污染转录） |
| 挂起锚 | 同一 section，末尾追加 `## Suspended work` | 插话时把当时未完成的 todo 条目写进 `suspended-<session>.json`；之后每次组装按「挂起项 ∩ 当前未完成项」渲回 prompt（未完成项 + 打断它的那句话 + 停在哪 + 当时的会话事件号，可用 `session_event_read` 回读证据）；交集为空即删 | 是（每会话一份小 JSON） |
| 守卫 | `agent/turn-stopping` | 回合本该结束、但本回合收过插话（或下轮已有排队）且还有未完成 todo 时，`agent.steer()` 一条 `[task-anchor]` notice 把剩余计划递回去，代价是一次额外请求；`returnPolicy: wait` 时只记不催 | 是（一条持久 user 消息，kind `plugin:task-anchor`） |
| 拦停（`forceStop`） | `agent/pre-step` → `reject` | 插话落到 step 边界时把这一批消息放回 `next-turn`，返回 `reject`：step 不打开、不花模型调用，`turn/end` 记 `blocked`，下一回合从这条插话开始。默认关 | 否（消息在 inbox 里，不是新事件） |

不做的事（有意）：不判定插话与任务的关系（模型判）、不延迟/不阻止插话、不改 core 的逐字投影、不做 UI 标注、不替模型拆 subagent。

## 已有证据（真实输出）

- 单测：`node --test` → `tests 40` / `pass 40` / `fail 0`（policy 17 + plugin 22 + store 1）。
- 语法：`node --check lib/index.js`、`lib/policy.js`、`lib/store.js` 全部 exit 0。
- profile 集成校验（headless 脚本）：`resolved: <本仓路径>` / `name matches: true` / `patch exists: true` / `entry: {"id":"task-anchor","name":"dsh-task-anchor"}` / `exported name matches id: true` / `bundle listed in profile: true`。
- 符号链接：`node_modules/dsh-task-anchor` → 本仓目录（SymbolicLink）。
- **live**：DSH 重启后，会话 system prompt 中出现本插件注入的 `## Mid-turn user messages` 段 ⇒ 插件已加载、契约生效（GUI 端口每次重启不同，不记录）。
- **live（2026-11-15 18:29–18:30，v0.2.0 修复后的第一次正向结果）**：真实插话「所以说晚上吃点什么好呢……」到达后，`<storeDir>/suspended-<session>.json` 落盘（662 B，version 2，items = 当时 5 条调查 todo），同一回合 prompt 出现 `## Suspended work`；回合收尾时收到 `[task-anchor]` notice 并继续运行（`agent.steer` 路径）。
- **真实日志集成**（脚本驱动 `apply()`，喂一次真实长会话的 1413 条事件 + 真实插话事件）：`## Suspended work` 正确列出 5 条真实 todo、插话原文；把清单改写成不含这些项后，段落消失且 `suspended-*.json` 被删。这不是 live 会话（插件尚未重启加载新代码），但走的是真实事件形状。
- **live 反证（2026-11-15 17:48 会话）**：真实插话后 turn 2 正常结束，session log 里没有任何 `source.kind === "plugin:task-anchor"` 事件、也没有第 4 个 step ⇒ 守卫没触发。解压日志定位到 `Session` 没有 `events` 成员，`openTodos(undefined)` 抛错被 catch 吞掉。修复见 `lib/index.js` 的 `snapshotEvents()` 与 `lib/policy.js` 的 `data.message`。
- **live（2026-11-15 18:44–18:49，取消路径）**：插话「这个任务不用查了，换成另一个」到达时 pre-step 写盘（items = 当时 pending 的旧任务项）；模型按契约重写清单去掉该项，下一轮 `turn-stopping` 交集为空 ⇒ `suspended-<session>.json` 被删、`## Suspended work` 消失。复查 store 目录只剩一个旧版遗留文件（`suspended-unknown.json`，157 B，旧代码还没拿到 session id 时写的），按精确路径手工删除后目录为 0 文件 ⇒ 删除是**按 session id 精确删**，不是清目录。

## 未验证（下一个会话从这里开始）

1. **`forceStop`**：`returnPolicy: wait` + `forceStop: true` 重启后实测——插话到达时回合应立刻收尾（`turn/end` reason `blocked`，无 `step/start`），下一回合开头交付那条消息；同时确认没有出现「消息消失」或「同一 id 两次」。若 `setImmediate` 里 agent 不是 idle，消息应留在 `next-turn` 等下一个边界。
2. 阈值调参：`maxNudgesPerSession=6`、`maxStaleTurns=3`、`maxNoticeItems=5` 都是拍的，需要真实使用后校准。
3. 契约体积：现在约 320 tokens/请求且常驻；再有未完成项时多一行 `Open items:`（约 25 tokens）。可考虑「会话内出现过插话后才 sticky 出现」。
4. 可选 UI 侧标注：让用户看见哪条是插话、哪条是插件 notice；以及让 todo 面板常驻（需改 DSH 前端，超出本仓范围）。
5. 可选上游化：把「中途消息关系契约」做成 DSH 自带 prompt section，需要写 Agent Note 并查 supersession。

## 已知边界（别当 bug 修）

- **step 1 漏判**：`inbox.claim()` 先取全部 `next-step` 再取 1 条 `next-turn`，所以第 1 步的批次是 `[steering..., opener]`，`detectInterjection` 要求 `step > 1`，此时段进来的插话会被记成普通消息。代价是偶发漏一次兜底，不是误触。
- **依赖 todo**：模型没写 todo 就没有任务锚，守卫不会触发，锚点也没有内容可渲染。有意如此。
- **守卫只能救「自己停下」**：插话被理解成新任务、然后一路做下去的情况，靠契约段软约束，机械层拦不住。
- **`wait` 不能中止回合**：它只是不发 steer，`agent.steer()` 只能追加一步、`agent/turn-stopping` 在收尾时才派发。要机械保证「停」必须改 DSH 核心，见 DESIGN §7.4。
- **锚点靠「挂起项 ∩ 当前未完成项」判断存亡**：不按轮数过期（安静五轮后回来说「继续」仍能接上）。代价是：模型若把某一项**改写**成新条目，旧项消失 ⇒ 视为取消；若永不重写清单，锚点会一直显示。
- **`contract: false` 会连锚点一起关掉**：两者共用一个 section（这样稳态 token 成本为 0，也不必维护第二个注册）。
- **todo 面板是「当轮」表面**：回合结束后面板可能不再显示，但 session log 里的 `todo/write` 还在。`Open items:` 那一行就是给「面板看不见、日志还在」这种情况兜底的；它不按 `maxStaleTurns` 过期——清单本身就是用户可见的事实，除非模型重写清单，否则一直算欠着。
- **落盘目录**：`DSH_HOME/task-anchor`；`DSH_HOME` 由宿主进程环境提供，核心包不暴露 home 服务的查询接口。
- **孤儿快照按年龄清**：会话崩掉或被搁置时，没人再来删它的 `suspended-*.json`；写新快照时会顺手删掉「不属于当前会话且超过 `storeTtlDays`（默认 7 天）」的那些。只扫本目录、只认 `suspended-*.json`，不碰 `DSH_HOME/sessions` 的会话归档，也不删当前会话的文件。模型忘了改 todo 导致的「锚点一直显示」不属于孤儿，那是「还欠着」的信号，不自动清。
- **与同类插件叠加**：`dsh-loop-continue`、`dsh-early-stop-guard` 也挂 `agent/turn-stopping` 并 `steer`。本插件每 turn 最多一次，但两个插件可能各催一次。

## 关键位置

- `lib/index.js`：`export const name = 'task-anchor'`；`NOTICE_SOURCE_KIND`；`SECTION_ORDER = 540`；`noticeMessage()`；`apply()`；`snapshotFor/forget/remember/anchorTextFor`；`agent/pre-step` 观察 + 落盘；`agent/turn-stopping` 维护锚点 + 守卫。
- `lib/policy.js`：`isUserMessage` / `textOf` / `interjectionText` / `detectInterjection` / `assistantText` / `lastAssistantText` / `openTodos` / `buildContractText` / `buildAnchorText` / `buildOpenItemsText` / `buildNoticeText` / `normalizeConfig`（纯函数，全部单测覆盖）。
- `lib/store.js`：`resolveStoreDir` / `snapshotFileName` / `saveSnapshot` / `loadSnapshot` / `removeSnapshot` / `pruneSnapshots`（零依赖，只有 fs）。
- `cordis.patch.yml`：全量默认配置（`onInterject` / `returnPolicy` / `forceStop` / `storeDir` 是新增项）+ id/name 约定说明。

## 回滚

- DSH 快照：`20261115-175909-e4e8`（守卫修复前）与更早的 `20261115-172955-ac20`（首版）。
- 手动停用：`cordis.patch.yml` 里 `enabled: false`，或只关 `guard: false` / `onInterject: off` / `contract: false`，重启 DSH。
- 完全卸载：profile `package.json` 删 `dsh-task-anchor` 两行（dependencies + `dsh.profile.bundles`），再 `pnpm install`。
