# 设计说明：为什么是「契约 + 守卫」而不是改 core

## 1. 数据流（DSH 0.1.2-alpha.1 的真实顺序）

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
- notice 的 `source.kind` 是 `plugin:dsh-task-anchor`：format v4 拒收 `{kind:'plugin', plugin:'<id>'}`（写得进去、读不回来），生产者必须用自己的 kind。

## 5. 失败模式

| 失败 | 表现 | 处理 |
| --- | --- | --- |
| 没有 todo | 守卫不触发 | 契约里要求「用 todo 记录计划」；这是诚实的能力边界 |
| 模型把「催」当成新任务 | 又多写一段总结 | notice 明确写「finish or state what remains」，并只列未完成项 |
| 与 loop-continue 同 turn 双 steer | 两次额外请求 | 每 turn 一次上限；文档建议二选一 |
| section 重复注册 | `systemPrompt.section` 重名抛错 | 注册走 `ctx.effect`，dispose 时一并撤销 |

## 6. 验证策略

- 12 条纯策略单测：分类、截断、过期、提问判定、默认值。全部不需要启动 harness。
- 端到端手测脚本见 README「验证」；日志关键字 `task-anchor: steered a reminder`。
- 不写「假装通过」的集成测试：真实 turn-stopping 需要模型产出，成本高且不稳定；改为日志可观察 + 单测覆盖判定。
