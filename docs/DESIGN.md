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
2. **pre-step 的 `decision.messages` 是替换整个批次。** 监听器必须 `await next()` 后**追加**，返回自己的数组会把用户消息吞掉（`T:\jev-guard\adapters\dsh\index.js` 的注释里记了这个坑）。

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

- 32 条单测：16 条策略（分类、截断、过期、提问判定、默认值、锚点渲染、锚点里的转录事件号、`Open items` 行）+ 16 条接线（section 注册、steer 时机、单 turn 去重、abort、自产 notice 不误判、落盘/重读/取消/久置不倒、`Open items` 三种形态）。全部不需要启动 harness。
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

## 8. 一次真实的静默失败（0.2.2-rc.3）

守卫上线后在真实插话里没有 steer，日志里也没有 `steered a reminder`。根因不是事件名，而是插件读了 `agent.session.events`：

- `dsh-session/src/index.ts:555` 的 `Session` 只有 `private log`，没有 `events`；公开读法是 `snapshotEvents()`（`:759-768`）。
- 于是 `openTodos(undefined)` 在 `events.length` 抛错，被 turn-stopping 的 `catch` 吞成一行 debug 日志 ⇒ 守卫静默不催。
- 次生问题：真实 `assistant/message` 的 data 形状是 `{turn, step, message, usage, stream}`，消息体在 `data.message`，旧实现读 `event.data` ⇒ `content` 取不到 ⇒ `skipWhenAsking` 永远失效。

教训：**在 turn-stopping 里 catch 一切，会把「代码错了」和「条件不满足」变成同一种表现**。现在两处都留了可 grep 的 debug 文案（`guard skipped` / `anchor skipped` / `observation skipped`）。
