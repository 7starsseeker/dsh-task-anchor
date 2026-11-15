# 设计说明：为什么是「契约 + 守卫」而不是改 core

## 1. 数据流（DSH 0.1.2-alpha.1 的真实顺序；0.2.2-rc.3 行号见下）

```
用户忙时输入
   └─ controller prompt()                              packages/api/session-controller/src/commands.ts:283
        ├─ mode=steer → agent.steer(msg)               core/agent-loop/src/agent.ts:133
        │    └─ inbox.splice('next-step', …)           core/agent/src/inbox.ts:86
        └─ mode=queue → agent.followup(msg)
             └─ inbox.splice('next-turn', …)

step 边界
   ├─ inbox.claim(target, turn)                        inbox.ts:71
   │    = 全部 next-step + (target==='next-turn' ? 1 条 next-turn)
   ├─ systemPrompt.assemble(assembleContextFor(agent)) agent.ts:237   ← 契约 section 在这里展开
   ├─ agent/pre-step waterfall                        agent.ts:238   ← 本插件只读观察
   ├─ session.append('user/message', msg)             agent.ts:289   ← claim 到的每条都落盘
   └─ step(assembly, …)

turn 边界
   └─ 若 turnEnds && inbox.nextStep.length === 0 → agent/turn-stopping   agent.ts:302-306
        └─ 本插件：条件满足则 agent.steer(notice) —— 机器重读 inbox，再走一步
```

两条关键不变量：

1. **没有「只进请求、不进日志」的通道。** pre-step 返回的 `messages` 会在 `agent.ts:289` 逐条 `session.append`；`assembly` 与它们分离，但它只是 system prompt。所以「在插话旁边贴一个临时说明」在插件层做不到，只能进持久转录——这正是契约放 system prompt（每次请求动态展开、不落盘）的原因。
2. **pre-step 的 `decision.messages` 是替换整个批次。** 监听器必须 `await next()` 后**追加**，返回自己的数组会把用户消息吞掉（这是水坝式 middleware 的通用坑，与具体插件无关）。

## 2. 为什么不做关系判定

插话与任务的关系（补充约束 / 修正当前步 / 追问 / 新任务 / 改目标）**不是可自动判定的量**：

- 文本上「顺便把 A 也改了」既可能是补充约束，也可能是新任务；
- 一旦判错方向，代价不对称：把「停，方向错了」判成「补充约束」会继续做错事。

所以分层：

| 层 | 谁负责 | 本插件的角色 |
| --- | --- | --- |
| 关系判断 | 模型（契约给出分类清单与默认倾向） | 提供判据，不代替判断 |
| 机械兜底 | 插件（有没有留下未完成的 todo） | 只做这一件事 |
| 用户纠正 | todo 清单 + 下一轮对话 | 提供可见的「还剩下什么」 |

## 3. 为什么守卫放在 turn-stopping

候选扩展点对比：

| 扩展点 | 能做 | 为什么没选 |
| --- | --- | --- |
| `agent/pre-step` 注入 | 把说明和插话同批送进模型 | 落盘为持久 user 消息，污染转录；且每步都要判断，成本高 |
| `systemPrompt.section` | 每次请求动态展开、不落盘 | 选它承载契约；但它是静态规则，无法对「这一回合失败了」作出反应 |
| `agent/turn-stopping` | 回合即将关闭、模型不欠响应时介入 | **选它做兜底**：只有真正「要结束了但活没干完」才付出一次额外模型请求 |
| 改 `surface.ts` | 给插话加渲染层身份 | 违反 2026-07-20 的刻意决策（逐字投影）；需要新 Agent Note + meta renderer |

turn-stopping 的语义是「模型不欠响应」，监听器 `steer()` 会让机器重读 inbox 再走一步（`docs/subsystems/core.md:1054`）。因此它的代价是**一次额外请求**，只在失败路径上付。

## 4. 判据与阈值

- 插话判定：`step > 1` 且批次含 `source.kind === 'user'`。`claim()` 的顺序决定了 step 1 的批次可能是 `[steering, opener]`，无法区分，故放过（已知边界）。
- 任务锚：最近一次 `todo/write` 的 `pending`/`in_progress` 项；`maxStaleTurns` 之外的清单视为过期。todo 投影在 `turn/start` 清空的是 UI/wire 投影，日志仍在（`packages/todo/tool-todo/src/index.ts:140-143`）。
- 不催的情形：末句是提问（`?`/`？` 结尾）、本回合已催、会话配额用尽、信号已 abort。
- notice 的 `source.kind` 是 `plugin:task-anchor`：format v4 拒收 `{kind:'plugin', plugin:'<id>'}`（写得进去、读不回来），生产者必须用自己的 kind。

## 5. 失败模式

| 失败 | 表现 | 处理 |
| --- | --- | --- |
| 没有 todo | 守卫不触发 | 契约里要求「用 todo 记录计划」；这是诚实的能力边界 |
| 模型把「催」当成新任务 | 又多写一段总结 | notice 明确写「finish or state what remains」，并只列未完成项 |
| 与 loop-continue 同 turn 双 steer | 两次额外请求 | 每 turn 一次上限；文档建议二选一 |
| section 重复注册 | `systemPrompt.section` 重名抛错 | 注册走 `ctx.effect`，dispose 时一并撤销 |

## 6. 验证策略

- 48 条单测：21 条策略（分类、截断、过期、提问判定、默认值、锚点渲染、锚点里的转录事件号、同回合/跨回合两种锚点措辞、`Open items` 行、取消后不复述、授权后必须回报、`wait`/`auto` 两种收尾措辞、插话三分类、当前回合推导）、26 条接线（section 注册、steer 时机、单 turn 去重、abort、自产 notice 不误判、落盘/重读/取消/久置不倒、同回合与跨回合两种渲染、`Open items` 三种形态、孤儿清扫、`forceStop` 的六条：停并交棒 / 没 idle 就留在队列 / 默认关 / triage 放过取消 / triage 放过补充 / triage 仍停无关话题）+ 1 条 store（只删别的会话的陈旧快照）。全部不需要启动 harness。
- 端到端手测脚本见 README「验证」；日志关键字 `task-anchor: steered a reminder`。
- 不写「假装通过」的集成测试：真实 turn-stopping 需要模型产出，成本高且不稳定；改为日志可观察 + 单测覆盖判定。

## 7. 挂起计划：为什么只落盘一次

插话把任务打断后，**「这活是挂起还是取消」不是插件能算的量**——只有模型知道用户想继续还是想放弃。所以插件不判语义，只认 todo 的痕迹：

| 模型的动作 | 插件看到的事实 | 结果 |
| --- | --- | --- |
| 把清单里那一项删掉 | 挂起项不在最近 `todo/write` 里 | 视为取消，删快照 |
| 改写那一项（加约束） | 内容变了 ⇒ 原项不再出现 | 视为取消（改写即换新条目），快照删；新条目属于当前计划 |
| 保留原项 + 新任务入清单 | 挂起项仍在未完成集合里 | 视为挂起，快照保留，只渲染挂起项 |

快照里存的是**插话那一刻未完成的条目本身**（`items`），不是「清单后来长什么样」。渲染时取 `items ∩ 当前未完成项`：后来新增的任务不会被误标成「被挂起」，被删掉的项也会立刻消失。代价是「改写一项」等价于取消旧项——这是有意的取舍：判断「改写」和「换成新任务」需要语义理解，而插件只认痕迹。

触发点只有一个：`agent/pre-step` 里 `detectInterjection` 为真那一刻。**不设周期检查点**——周期写盘要每回合付费，而读它的时机（恢复上下文、重启后继续）却很稀少。

落到哪：`storeDir`（默认 `DSH_HOME/task-anchor`，再退 `~/.dsh/task-anchor`）下 `suspended-<session>.json`，内容只有 `{version, session, turn, seq, at, interjection, items, stoppedAt}`。计划全文不落盘——它在 session log 的 `todo/write` 里，抄一份只会让两份状态漂移；`items` 例外，因为它是「哪些项被挂起」这件事的唯一记录。

**不按轮数过期**：用户可能安静五轮之后才说「继续」，而这正是它存在的理由（billion-context 之类的压缩会把计划挤掉）。消失条件只有两个：渲染时交集为空（项被删/改写）、或下一轮 `turn-stopping` 时交集为空（顺手删文件）。若模型永远不重写清单，它就一直显示——那是「活还没做完」的诚实表达。

怎么读回来：system prompt 的同一 section 在每次组装时把快照渲染成 `## Suspended work`（未完成项 + 打断它的那句话 + 停在哪），**和契约共用一个 section**，所以稳态下多出的 token 是 0。措辞是 advisory 的（「用户说继续就从这里接；用户说取消就重写清单」），不是「必须继续」——否则就是另一种劫持。

**证据不进 prompt，但要可发现**：快照里的 `seq`（挂起那一刻最后一条事件的序号）也渲染出来，附一句「用 `session_event_read` 回读该事件附近的转录」。把已查到的东西塞进 prompt 是**每轮**付费，而压缩动的是上下文、session log 本身是完整的；所以正确做法是给一个入口，不是搬家。契约里因此多一条纪律：重取昂贵（不止一次调用、花了钱或配额、有外部副作用）的中间结论写成文件，todo 指向它；重取便宜的（一次搜索就能拿回来）不落。

### 7.1 没有挂起项时：一行 `Open items:`

只有「被插话打断」的那份计划才有快照。普通的多步任务没有插话，就只能靠 todo 面板——而面板是当轮的工具卡片，回合结束就没了，日志也不是模型每次都能读的东西。所以 section 在**没有快照但有未完成项**时，末尾追加一行 `Open items: <未完成项>; ...and N more`（`maxNoticeItems` 截断，单项 120 字）。有快照时不再追加，避免同一批条目在一段 prompt 里出现两遍。约 20–40 token/请求。

为什么必须从日志推导而不是从本步 payload：prompt 在 `agent/pre-step` **之前**组装（0.2.2-rc.3 的 `agent.ts:300` vs `:302-303`），本步的插话在组装时还不存在。

### 7.2 取消之后：不再复述

「清单里没了」是插件的取消信号：锚点消失、`Open items` 不再列出、守卫不再提醒。这解决的是**状态**，不解决**嘴**——上一版实测里，我在解释机制时反复把已取消的任务讲了三遍，用户听感就是「还在纠结」。所以契约多一节 `### After a cancellation`：取消之后就安静，不许在后续回复、解释、笔记、报告里复述被取消的任务；用户问原因就答一次，然后继续放下。这不是插件能机械拦的（它读不到我的正文），只能写进契约做软约束——和「advisory」同一层。

### 7.3 孤儿快照：只在写的时候顺手扫

三种「删不掉」的情况里，只有一种是真的：会话崩了或被搁置，那个会话再也不会走到 `turn-stopping`，`suspended-<session>.json` 就成了孤儿（`suspended-unknown.json` 就是这么来的）。另外两种是**设计信号**，不能删：模型忘了改 todo 时锚点一直显示，那本来就是「还欠着」的提醒；`Open items:` 是无状态渲染，没有盘可清。

清扫放在 `remember()` 里——也就是**只在写快照时**跑一次，不设周期任务，不扫每轮。范围卡死三条：只扫 `storeDir` 这一个目录、只认 `suspended-*.json`、永不删当前会话的文件；`DSH_HOME/sessions` 下的会话归档属于 harness 自己的管理，一个字节都不碰。阈值 `storeTtlDays`（默认 7 天，0 关闭）。宁可留一个孤儿，也不误删一份还有人要读的挂起计划。

### 7.4 `wait` 能做什么、不能做什么

`returnPolicy: wait` 只改一个分支：`agent/turn-stopping` 里提前 `return`，不发 steer。其余全部照旧——插话照样落盘、`## Suspended work` 照样渲染、`Open items:` 照样出现、todo 照样是唯一状态。

**做不到**（只开 `wait` 时）：中止一个正在跑的回合。`agent/turn-stopping` 是回合「已经决定收尾」时才派发的事件，`agent.steer()` 只能往回合里追加一步，两者都不具备「打断」语义。所以 `wait` 模式下能请求停下的只有契约文字（`### Waiting for the user`），效果取决于模型是否照做。

2026-11-15 实测：只开 `wait` 时守卫确实没催，但回合也没有停 —— 模型自己接着把挂起计划做完了。这不是配置没生效，而是「不催」与「让它停」是两件事。

**更正**：早先这里写着「要机械保证停，只能改 DSH 核心」，那句话是错的。`agent/pre-step` 的 waterfall 返回值就是这一步的 `PreStepDecision`，`reject` 会让 `turn()` 在打开 step 之前收尾 —— 不需要改核心。机械停的实现与代价见 §7.5。

需要「软停」的场景仍然推荐：`wait` + 契约 + 在插话里明确写「先别做 X，等我」。需要「必定停」的场景用 `forceStop`。

### 7.5 `forceStop`：唯一会拒绝一步的开关

`agent/pre-step` 的 waterfall 返回值就是这一步要用的 `PreStepDecision`（`dsh-agent-loop/src/agent.ts:302-303`）。返回 `reject` 时，`turn()` 在 `:354-357` 把 `turnEnds` 记成 `blocked` 并直接返回：`this.step()` 不会被调用，没有 `step/start`，也不花模型调用。这是本插件唯一会**结束**回合的路径，默认关。

三个必须处理的细节：

1. **消息已经被 claim 走**（`:293` 在派发之前），`reject` 会把这一批消息连同 runtime-context 一起丢掉。所以先 `inbox.append('next-turn', message)`（持久化的 splice），再 `reject`。
2. **唤醒要推迟**。驱动运行中收到的 wake 会被丢掉：`wakeDriver()` 只在 idle 相位起新 driver（`:235-255`），running 相位只有 maintenance 或「aborted 后的 send」会 latch。所以在 `setImmediate` 里等 `agent.status === 'idle'`，再 `followup()`；并且先 `inbox.remove(id)` 掉刚放回的那份，避免同一 id 出现两次。
3. **失败不炸 turn**。放回、唤醒各包一层 try/catch，最坏情况是消息留在队列里等下一个边界交付（不丢）。

代价：`turn/end` 的 reason 是 `blocked`，UI 上没有 assistant 收尾语；被停的那一步的 runtime-context 会被丢弃（下一回合重新组装）。这些都是「停下来」本身的意思，不是缺陷。

为什么默认关：结束一个正在跑的回合是**代替用户**做决定，而插话可能只是顺口一问。开它是配置行为，不是默认行为。

**三档**：`off`（默认）/ `always`（任何插话都停）/ `triage`（只看文本像不像「另一件事」）。

`triage` 的存在理由是用户体感：插话如果是**取消**（「算了」「不用了」）或**补充修改**（「改成」「换成」），回合不该被切断——这两种情况下前一份计划要么作废、要么变形，模型在本轮里改写 todo 就够了；只有「另一件事」才需要先挂起、下一回合交付。但插件读不到语义，`triage` 只是关键词启发式（`cancelPatterns` / `amendPatterns`，可覆盖，编译失败的条目会被丢掉）。它的误判方向是安全的：误判成 cancel/amend ⇒ 不停，退化成 `off` 的行为；误判成 other ⇒ 停，退化成 `always` 的行为。真正的语义判断仍然留给模型和契约。

**但它不是主路径**（2026-11-15 的决定）。`forceStop` 停的是**回合**，用户体感到的是「任务被打断」+ 宿主播一次「任务结束」提示音；而插话往往只是顺口一问。用关键词表去替用户判断「该不该停」，本质上是把语义判断塞进一个看不见上下文的启发式里——`triage` 只是把这个判断做得没那么粗暴，没有解决「插件不该替用户决定」这件事。所以：`forceStop` 保持可用、默认关、文档标为实验性；主路径改成 §7.6。

### 7.6 同回合插话提示：把两个任务并排摆好，让模型自己决定

目标不是「让插件判断」，而是**让模型在插话落地的那一步就看到：挂起的是哪几项、打断它的是哪句话、自己现在有三个选择**。

信息本来就够：`agent/pre-step` 拿到 `messages` 与 `position.turn`，`remember()` 写下 `{turn, seq, items, interjection}`。缺的是**时机**——`## Suspended work` 的措辞是「以后想继续就从这里接」，适合跨回合提醒，不适合「此刻还没答复」。于是同一份快照按 `snapshot.turn` 与日志里最后一个 `turn/start` 的 `turn` 比较，分成两种渲染：

- 相等 ⇒ `## Interjection during this turn`：列出被挂起的条目、插话原文、事件号，然后给出三个读法（取消 → 重写清单；补充 → 就地改项；另一件事 → **本回合就停**，一句话说明挂起了什么、把项留给下一回合），并明说「不要一边让用户等答案、一边继续磨挂起的项」。
- 不等 ⇒ 原来的 `## Suspended work`：提醒「想继续就从这里接；取消就重写清单」。

这个方案不碰 inbox、不 reject、不重投消息，因此没有提示音、没有 `blocked`、不会让消息在 UI 与转录里错位；模型仍然是唯一的语义判断者，插件只是保证它**在正确的那一步**拿到正确的事实。风险也很直白：模型可以不照做——它读到了提示仍然继续跑。那种情况下的兜底是 `turn-stopping` 的 steer（`auto` 模式）或契约本身，而不是把决定权收回到插件手里。

实现位置：`lib/policy.js` 的 `currentTurnOf(events)` 与 `buildAnchorText({ sameTurn })`、`lib/index.js` 的 `anchorTextFor()`。

## 8. 一次真实的静默失败（0.2.2-rc.3）
守卫上线后在真实插话里没有 steer，日志里也没有 `steered a reminder`。根因不是事件名，而是插件读了 `agent.session.events`：

- `dsh-session/src/index.ts:555` 的 `Session` 只有 `private log`，没有 `events`；公开读法是 `snapshotEvents()`（`:759-768`）。
- 于是 `openTodos(undefined)` 在 `events.length` 抛错，被 turn-stopping 的 `catch` 吞成一行 debug 日志 ⇒ 守卫静默不催。
- 次生问题：真实 `assistant/message` 的 data 形状是 `{turn, step, message, usage, stream}`，消息体在 `data.message`，旧实现读 `event.data` ⇒ `content` 取不到 ⇒ `skipWhenAsking` 永远失效。

教训：**在 turn-stopping 里 catch 一切，会把「代码错了」和「条件不满足」变成同一种表现**。现在两处都留了可 grep 的 debug 文案（`guard skipped` / `anchor skipped` / `observation skipped`）。
