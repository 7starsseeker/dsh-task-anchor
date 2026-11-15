# STATUS — dsh-task-anchor

更新：2026-11-15。这是交接快照，不是设计文档（设计见 [DESIGN.md](DESIGN.md)）。

## 一句话状态

v0.4.1 已实现、**52 条单测通过**、已挂载进 desktop profile。契约段常驻、插话时落盘 `suspended-<session>.json`、回合收尾时 `agent.steer` 递回 notice、取消路径（改写清单 → 锚点消失 → 快照删除）都已在 live 会话里跑通。**同回合插话提示**（`## Interjection during this turn`）是当前主路径：插话当回合就把「挂起的是哪几项 + 打断它的那句话 + 三个读法」摆到模型面前，由模型自己决定取消 / 补充 / 另起一件事，插件不打断。`returnPolicy: wait` 实测过：守卫保持安静，但回合不会自己停，所以补了 `### Waiting for the user` 契约段。`forceStop` 是**实验性**的机械打断（`off` 默认 / `always` / `triage`）：`always` 已 live 验证（`turn/end reason=blocked` + 消息原样进下一回合），代价是宿主会播一次「任务结束」提示音，因此不再作为推荐路径；`triage` 尚未 live 验证。实现见 DESIGN §7.5–7.7。首次对着一个 store 启动时会多渲染一段 `## First run`（0.4.1）：列 `returnPolicy` / `forceStop` / `onInterject` / `storeTtlDays` 当前值，要求模型转述并询问是否修改；`first-run.json` 保证只出现一次。

## 要解决的问题（出处）

执行指令途中用户插话，agent 往往立刻转去做插话内容并输出，原任务做一半丢掉，或注意力被带偏。上游调研笔记没有随仓发布（做这个插件时在 DSH 的 notes 目录里留过一份，含会话实证；公开版不复述其中的会话细节）。

根因是三件事叠加，其中两件在 DSH core、本插件只能绕：

1. `packages/core/session/src/surface.ts:83-114` 把 `user/message` 逐字投影 —— 插话与开场 prompt 在模型眼里同形同权，没有「这是中途插入」的标记。
2. `packages/core/system-prompt/src/index.ts` 里 grep `steer|interrupt|mid-turn` 零命中 —— 模型从未被告知执行中收到新消息该怎么处理。
3. 没有跨步骤的任务锚：`todo` 投影在 `turn/start` 清空；compaction 的 `## Next Step` 又明确要求「对齐最近一次请求」，而插话恰好就是最近一次请求。

第 3 条由本插件补：插话时把「被挂起的计划」落盘一次，之后每次组装 prompt 都把它渲染回来。

## 本插件的机制

| 机制 | 挂点 | 作用 | 是否落盘 |
| --- | --- | --- | --- |
| 契约段 | `ctx.systemPrompt.section(...)`，order 540，每请求重新渲染 | 告诉模型：插话是新输入、不自动等于替换当前任务；五类关系 + 三类记账（取消/补充/挂起）+ 取消之后不再复述 + 用户回答你问过的问题（「可以」「go ahead」、选择、批准）是决定、要建 todo 并在回复里写清「跑了什么、回了什么」+ 双任务时何时拆 subagent、按什么顺序做 + 证据何时该落盘（重取昂贵的中间结论写成文件，todo 指向它）。没有挂起项时，末尾追加一行 `Open items: …`（todo 面板只在当轮可见，日志不是） | 否（system prompt，不污染转录） |
| 挂起锚 | 同一 section，末尾追加 `## Suspended work` | 插话时把当时未完成的 todo 条目写进 `suspended-<session>.json`；之后每次组装按「挂起项 ∩ 当前未完成项」渲回 prompt（未完成项 + 打断它的那句话 + 停在哪 + 当时的会话事件号，可用 `session_event_read` 回读证据）；交集为空即删 | 是（每会话一份小 JSON） |
| 守卫 | `agent/turn-stopping` | 回合本该结束、但本回合收过插话（或下轮已有排队）且还有未完成 todo 时，`agent.steer()` 一条 `[task-anchor]` notice 把剩余计划递回去，代价是一次额外请求；`returnPolicy: wait` 时只记不催 | 是（一条持久 user 消息，kind `plugin:task-anchor`） |
| 同回合插话提示 | 同一 section，换成 `## Interjection during this turn` | 快照的 `turn` 等于日志里最后一个 `turn/start` 时，说明这条插话就发生在**当前回合**：渲染被挂起的条目 + 插话原文 + 三个读法（取消 / 补充 / 另起一件事），并要求模型在**本回合**内做出判断、若属另一件事就停在这里、把挂起的项留给下一回合。不打断、不重投消息，纯粹把两个任务并排摆给模型 | 否（复用挂起快照） |
| 首次运行提示 | 同一 section，追加 `## First run` | 第一次对着某个 store 启动时，列出 `returnPolicy` / `forceStop` / `onInterject` / `storeTtlDays` 的当前值，要求模型用一小段话转述并问是否修改；`first-run.json` 标记保证只出现一次（store 不可写就下次再出现，不报错） | 是（一个标记文件） |
| 拦停（`forceStop`，实验性） | `agent/pre-step` → `reject` | 插话落到 step 边界时把这一批消息放回 `next-turn`，返回 `reject`：step 不打开、不花模型调用，`turn/end` 记 `blocked`，下一回合从这条插话开始。`off`（默认）/ `always` / `triage`；`triage` 用关键词表判取消与补充修改，只对「像另一件事」的插话生效。代价：宿主会播一次「任务结束」提示音，所以不作推荐路径 | 否（消息在 inbox 里，不是新事件） |

不做的事（有意）：不判定插话与任务的关系（模型判）、不延迟/不阻止插话、不改 core 的逐字投影、不做 UI 标注、不替模型拆 subagent。

## 已有证据（真实输出）

- 单测：`node --test` → `tests 48` / `pass 48` / `fail 0`（policy 21 + plugin 26 + store 1）。
- 语法：`node --check lib/index.js`、`lib/policy.js`、`lib/store.js` 全部 exit 0。
- profile 集成校验（headless 脚本）：`resolved: <本仓路径>` / `name matches: true` / `patch exists: true` / `entry: {"id":"task-anchor","name":"dsh-task-anchor"}` / `exported name matches id: true` / `bundle listed in profile: true`。
- 符号链接：`node_modules/dsh-task-anchor` → 本仓目录（SymbolicLink）。
- **live**：DSH 重启后，会话 system prompt 中出现本插件注入的 `## Mid-turn user messages` 段 ⇒ 插件已加载、契约生效（GUI 端口每次重启不同，不记录）。
- **live（2026-11-15 18:29–18:30，v0.2.0 修复后的第一次正向结果）**：真实插话「所以说晚上吃点什么好呢……」到达后，`<storeDir>/suspended-<session>.json` 落盘（662 B，version 2，items = 当时 5 条调查 todo），同一回合 prompt 出现 `## Suspended work`；回合收尾时收到 `[task-anchor]` notice 并继续运行（`agent.steer` 路径）。
- **真实日志集成**（脚本驱动 `apply()`，喂一次真实长会话的 1413 条事件 + 真实插话事件）：`## Suspended work` 正确列出 5 条真实 todo、插话原文；把清单改写成不含这些项后，段落消失且 `suspended-*.json` 被删。这不是 live 会话（插件尚未重启加载新代码），但走的是真实事件形状。
- **live 反证（2026-11-15 17:48 会话）**：真实插话后 turn 2 正常结束，session log 里没有任何 `source.kind === "plugin:task-anchor"` 事件、也没有第 4 个 step ⇒ 守卫没触发。解压日志定位到 `Session` 没有 `events` 成员，`openTodos(undefined)` 抛错被 catch 吞掉。修复见 `lib/index.js` 的 `snapshotEvents()` 与 `lib/policy.js` 的 `data.message`。
- **live（2026-11-15 18:44–18:49，取消路径）**：插话「这个任务不用查了，换成另一个」到达时 pre-step 写盘（items = 当时 pending 的旧任务项）；模型按契约重写清单去掉该项，下一轮 `turn-stopping` 交集为空 ⇒ `suspended-<session>.json` 被删、`## Suspended work` 消失。复查 store 目录只剩一个旧版遗留文件（`suspended-unknown.json`，157 B，旧代码还没拿到 session id 时写的），按精确路径手工删除后目录为 0 文件 ⇒ 删除是**按 session id 精确删**，不是清目录。

- **live 失败样本（2026-11-15 20:23，`forceStop: off` + `returnPolicy: wait`）**：插话「那个颜色是蓝黑还是白金」到达时，system prompt 正确渲染了 `## Interjection during this turn`（5 条待办 + 插话原文 + 三个读法），说明同回合提示这条主路径**送达正常**；模型答完那句无关提问后**自行继续执行**了下一步扫描（Steam 清单）。契约 `### Waiting for the user` 要求的是「handle → report → stop」，模型把它误读成「提问 → 继续」。⇒ 同回合提示提供的是**信息**，不是机械保证；`forceStop: off` 时不构成任何硬约束，停不停完全落在模型判断上，本次判断错误。用户随后指出「当前不是 wait 模式在测试吗」，同一回合 prompt 的 `## Suspended work` 正常回填了停止点（快照 turn 54 / seq 5644，文件 2249 B）。
- **live（2026-11-15 20:12，`forceStop: always` 首次真停）**：插话「炸鸡为什么比炸鸭炸鹅多？」到达后，session log 顺序为 `agent/inbox/spliced target=next-turn inserted=[该消息]`（seq 4961）→ `turn/end turn=51 reason={"kind":"blocked"}`（4962）→ `turn/start turn=52`（4965）→ `user/message` 同文本（4968）。⇒ 停回合、原样交付、不丢消息三件事都成立。
- **live 待查（同一回合）→ 已结案，不是 bug**：那次 turn 51 结束前后 `<storeDir>` 里没有留下快照，所以下一回合 prompt 显示的是 `Open items:` 而不是 `## Suspended work`。查 session log 的 `todo/write` 序列：seq 2138（上一轮调查的 5 条，**全部 completed**）之后、直到 seq 4971 才有下一条写入，而插话落在 seq 4960、停回合在 4962；也就是说**插话那一刻 `openTodos` 为空**，`remember()` 按设计 `return null`（没有未完成项就不写空快照）；那 5 条游戏待办是在 turn 52（4965 起）才写进去的。⇒ 「目录为空」与设计一致，不是写丢或被 `forget` 删掉。

## 未验证（下一个会话从这里开始）

1. **同回合插话提示（`## Interjection during this turn`）**：需要一次真实插话确认模型会照三个读法判断，并在「另一件事」时主动停（而不是继续磨挂起的项）。断言点：prompt 里出现该标题与三条读法；模型若判定为另一件事，应在无工具调用的情况下结束回合、一句话说明挂起了什么；下一回合该快照应渲染成 `## Suspended work`。
2. **`forceStop: triage`**（实验性，默认关）：`always` 已于 20:12 实测通过；`triage` 是启发式——取消（「算了」「不用了」）与补充修改（「改成」「换成」）应**不停回合**，其余文本仍停。「停回合时快照没留下」已结案：插话那一刻 `openTodos` 为空，`remember()` 按设计不写空快照。
3. 阈值调参：`maxNudgesPerSession=6`、`maxStaleTurns=3`、`maxNoticeItems=5` 都是拍的，需要真实使用后校准。
4. 契约体积：现在约 320 tokens/请求且常驻；再有未完成项时多一行 `Open items:`（约 25 tokens）。可考虑「会话内出现过插话后才 sticky 出现」。
5. 可选 UI 侧标注：让用户看见哪条是插话、哪条是插件 notice；以及让 todo 面板常驻（需改 DSH 前端，超出本仓范围）。
6. 可选上游化：把「中途消息关系契约」做成 DSH 自带 prompt section，需要写 Agent Note 并查 supersession。

## 已知边界（别当 bug 修）

- **step 1 漏判**：`inbox.claim()` 先取全部 `next-step` 再取 1 条 `next-turn`，所以第 1 步的批次是 `[steering..., opener]`，`detectInterjection` 要求 `step > 1`，此时段进来的插话会被记成普通消息。代价是偶发漏一次兜底，不是误触。
- **依赖 todo**：模型没写 todo 就没有任务锚，守卫不会触发，锚点也没有内容可渲染。有意如此。
- **守卫只能救「自己停下」**：插话被理解成新任务、然后一路做下去的情况，靠契约段软约束，机械层拦不住。
- **`wait` 不能中止回合**：它只是不发 steer，`agent.steer()` 只能追加一步、`agent/turn-stopping` 在收尾时才派发。主路径因此不是「强行停」，而是同回合把进度与插话一起摆给模型、由模型决定（DESIGN §7.6）；要机械停才用 `forceStop`（实验性，默认关）。
- **`triage` 是关键词启发式**：只认 `cancelPatterns` / `amendPatterns`，不读语义；误判方向安全（误判成取消/补充 ⇒ 不停，退化为 `off`；误判成另一件事 ⇒ 停，退化为 `always`）。
- **锚点靠「挂起项 ∩ 当前未完成项」判断存亡**：不按轮数过期（安静五轮后回来说「继续」仍能接上）。代价是：模型若把某一项**改写**成新条目，旧项消失 ⇒ 视为取消；若永不重写清单，锚点会一直显示。
- **`contract: false` 会连锚点一起关掉**：两者共用一个 section（这样稳态 token 成本为 0，也不必维护第二个注册）。
- **todo 面板是「当轮」表面**：回合结束后面板可能不再显示，但 session log 里的 `todo/write` 还在。`Open items:` 那一行就是给「面板看不见、日志还在」这种情况兜底的；它不按 `maxStaleTurns` 过期——清单本身就是用户可见的事实，除非模型重写清单，否则一直算欠着。
- **落盘目录**：`DSH_HOME/task-anchor`；`DSH_HOME` 由宿主进程环境提供，核心包不暴露 home 服务的查询接口。
- **孤儿快照按年龄清**：会话崩掉或被搁置时，没人再来删它的 `suspended-*.json`；写新快照时会顺手删掉「不属于当前会话且超过 `storeTtlDays`（默认 7 天）」的那些。只扫本目录、只认 `suspended-*.json`，不碰 `DSH_HOME/sessions` 的会话归档，也不删当前会话的文件。模型忘了改 todo 导致的「锚点一直显示」不属于孤儿，那是「还欠着」的信号，不自动清。
- **与同类插件叠加**：`dsh-loop-continue`、`dsh-early-stop-guard` 也挂 `agent/turn-stopping` 并 `steer`。本插件每 turn 最多一次，但两个插件可能各催一次。

## 关键位置

- `lib/index.js`：`export const name = 'task-anchor'`；`NOTICE_SOURCE_KIND`；`SECTION_ORDER = 540`；`noticeMessage()`；`apply()`；`snapshotFor/forget/remember/anchorTextFor`；`agent/pre-step` 观察 + 落盘；`agent/turn-stopping` 维护锚点 + 守卫。
- `lib/policy.js`：`isUserMessage` / `textOf` / `interjectionText` / `detectInterjection` / `classifyInterjection` / `assistantText` / `lastAssistantText` / `openTodos` / `buildContractText` / `buildAnchorText` / `buildOpenItemsText` / `buildNoticeText` / `normalizeConfig`（纯函数，全部单测覆盖）。
- `lib/store.js`：`resolveStoreDir` / `snapshotFileName` / `saveSnapshot` / `loadSnapshot` / `removeSnapshot` / `pruneSnapshots`（零依赖，只有 fs）。
- `cordis.patch.yml`：全量默认配置（`onInterject` / `returnPolicy` / `forceStop` / `storeDir` 是新增项）+ id/name 约定说明。

## 回滚

- DSH 快照：`20261115-175909-e4e8`（守卫修复前）与更早的 `20261115-172955-ac20`（首版）。
- 手动停用：`cordis.patch.yml` 里 `enabled: false`，或只关 `guard: false` / `onInterject: off` / `contract: false`，重启 DSH。
- 完全卸载：profile `package.json` 删 `dsh-task-anchor` 两行（dependencies + `dsh.profile.bundles`），再 `pnpm install`。
