# task-anchor

> 任务执行中被打断时，别让原任务悄悄消失。

一个零依赖的 DeepSeek Harness 宿主插件：**当回合中途收到用户插话、并且回合结束时还有未完成的 todo，它会把一条提示 steer 回当前回合**，让模型要么把活干完，要么明确说清楚还剩下什么。

不加 core patch、不 fork、不改会话投影。

---

## 它解决的失效

DSH 里插话有两条投递路径，两条都可能把原任务丢掉：

| 路径 | 机制 | 失效点 |
| --- | --- | --- |
| steer（忙时 Enter） | 消息进 `inbox` 的 `next-step`，下一个 step 边界被 claim，作为普通 `user/message` 进入模型上下文 | 插话与开场 prompt **同形同权**（`packages/core/session/src/surface.ts` 逐字投影，是 2026-07-20 的刻意设计）；系统提示里没有任何关于中途消息的指令。模型很容易把「最新一条 user 消息」当成唯一任务 |
| queue（排队） | 消息进 `next-turn`，当前回合正常结束、下一回合才投递 | 原回合在 todo 未完成时结束，**没有任何人检查它留下了什么**；下一回合被新消息占据 |

两条路径的共同点：**todo 清单在 `turn/start` 时被投影清空**（`packages/todo/tool-todo/src/index.ts`），模型下一轮不再被提醒「还有活没干」。

## 它做的三件事

1. **契约（system prompt section，`task-anchor:contract`）**
   每次请求注入约 150 tokens 的规则：中途 user 消息是「新输入」，不是「任务的替代品」；先判断它属于补充约束 / 修正当前步 / 追问 / 新任务 / 改目标或中止，再决定动作；永不静默丢弃未完成的工作。

2. **守卫（`agent/turn-stopping`）**
   满足全部条件时，用 `agent.steer()` 把一条 notice 塞回当前回合：
   - 本回合观察到中途 user 消息（`step > 1` 且批次里有 `source.kind === 'user'`），**或** `inbox.nextTurn` 里有排队消息（下回合要换人）；
   - 最近一次 `todo/write`（不超过 `maxStaleTurns` 个回合）里还有 `pending` / `in_progress` 项；
   - 本回合最后一句不是提问（默认跳过，避免打断「停下来问用户」）；
   - 本回合没催过、会话内没超过 `maxNudgesPerSession`。

   模型于是多走一步：干完，或写明「剩下 X，因为 Y」。

3. **观察（`agent/pre-step`）**
   只读不改，记录本回合是否收到插话，供守卫判断；debug 日志可见。

## 安装（本机 profile）

```powershell
# 1) 把本目录登记成 profile 依赖与 bundle
#    编辑 T:\Deepseek-harness\.dsh\profiles\desktop\package.json：
#    dependencies 加  "dsh-task-anchor": "link:T:/dsh-task-anchor"
#    dsh.profile.bundles 加 "dsh-task-anchor"
# 2) 建立链接
cd T:\Deepseek-harness\.dsh\profiles\desktop
pnpm install
# 3) 重启 DSH（宿主插件在启动时加载，热重载不覆盖 profile bundle）
```

验证加载：

```powershell
Get-Item T:\Deepseek-harness\.dsh\profiles\desktop\node_modules\dsh-task-anchor |
  Select-Object Name, LinkType, Target
```

## 配置

写在 `cordis.patch.yml` 的 `config:` 下，全部可省略：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时不注册任何东西 |
| `contract` | `true` | 是否注入系统提示契约（约 150 tokens/请求） |
| `guard` | `true` | 是否启用 turn-stopping 守卫 |
| `triggerQueued` | `true` | 「下回合已有排队消息」是否也算触发条件 |
| `skipWhenAsking` | `true` | 回合末句是提问时不催 |
| `maxNudgesPerSession` | `6` | 每会话最多催几次；`0` = 只观察 |
| `maxNoticeItems` | `5` | notice 里最多列几项 |
| `maxStaleTurns` | `3` | todo 清单跨多少回合后视为过期 |

## 边界（明确不做的事）

- **不做关系判定**：插件不调用模型、不分类插话属于哪一类。关系判断交给契约 + 模型；插件只做机械兜底（有没有留下未完成的活）。
- **step 1 的插话不判定**：`claim()` 在第一步会同时取走 `next-step` 与 `next-turn`，无法仅凭 step 区分「插话」与「开场」，因此这种情况按已知边界放过。
- **没写 todo 的回合不催**：没有声明过计划，就没有可核对的「未完成」。想让它覆盖更多场景，需要模型先写 todo。
- **不阻止插话**：不做「把插话推迟到本回合结束」的策略——用户说「停，方向错了」时必须立刻被听到。
- **不动 `surface.ts` 的逐字投影**：模型侧的「插话」身份仍然是平的；要渲染层标记必须走 meta renderer + 新 Agent Note（见仓库里 2026-07-20 的 deferred 条目）。

## 与同类插件的关系

- `dsh-loop-continue`、`dsh-early-stop-guard` 也在 `agent/turn-stopping` 上 `agent.steer()`。本插件每回合最多催一次，但两个插件同时装时同一回合可能各催一次；建议按需二选一。
- `dsh-todo-float-ball` 只做 UI 展示（「被插话打断后丢失的安排」），不注入模型；与本插件互补。

## 验证

```powershell
cd T:\dsh-task-anchor
node --test tests/     # 32 条单测：策略判定 + apply() 接线，不需要启动 DSH
```

端到端手测（重启后）：

1. 让 agent 做一个三步任务，要求先写 todo；
2. 第二步执行中插一句无关追问；
3. 观察回合结束前是否出现 `[task-anchor]` notice，以及模型是否交代剩余项。

日志关键字：`task-anchor: steered a reminder`（info）、`task-anchor: mid-turn user message observed`（debug）。

已确认（2026-11-15）：重启后会话 system prompt 里出现契约段 `## Mid-turn user messages` ⇒ 插件加载与 section 注入正常。守卫的端到端触发仍待手测。

## 现状

进度、证据、未验证项与下一步：见 [docs/STATUS.md](docs/STATUS.md)。设计取舍：见 [docs/DESIGN.md](docs/DESIGN.md)。

## 卸载

从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里删掉两行，`pnpm install`，重启。
