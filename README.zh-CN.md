# dsh-task-anchor

> English: [README.md](README.md)

任务执行中被打断时，别让原任务悄悄消失。

[![selftest](https://github.com/7starsseeker/dsh-task-anchor/actions/workflows/selftest.yml/badge.svg)](https://github.com/7starsseeker/dsh-task-anchor/actions/workflows/selftest.yml)
[![npm](https://img.shields.io/npm/v/dsh-task-anchor.svg)](https://www.npmjs.com/package/dsh-task-anchor)
[![npm downloads](https://img.shields.io/npm/dm/dsh-task-anchor.svg)](https://www.npmjs.com/package/dsh-task-anchor)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-1F3A8A.svg)](https://github.com/7starsseeker)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/7starsseeker/dsh-task-anchor/)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

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

**先把范围说清楚。** 它**缓解**漂移，不能消除。插话仍然会占据它落到的那个 step，模型也仍然可能在下一个边界之前就转向——契约是建议性的，守卫只在回合已经收尾时才触发。真正改变的是「计划能扛过这次转向」：计划被写下来、被重新渲染，回合不能带着未完成项静默结束。要把缺口本身补上——让中途消息先排队，并给它一个与开场 prompt 不同的身份——那是宿主（DSH 核心）的决定，不是插件该替它做的。

## 它做的事

1. **契约（system prompt section，`task-anchor:contract`）**
   每次请求注入约 320 tokens 的规则：中途 user 消息是「新输入」，不是「任务的替代品」；先判断它属于补充约束 / 修正当前步 / 追问 / 新任务 / 改目标或中止，再决定动作。同一段还写着：被挂起的计划怎么记账、什么中间结论值得落盘、用户回答你问过的问题是**决定**而不是情报、被取消的任务之后不再复述。永不静默丢弃未完成的工作。

2. **挂起计划（`agent/pre-step` → 一个 JSON 文件）**
   插话到达且清单里还有未完成项时，把当时的未完成项写一次到 `suspended-<session>.json`。之后每次组装 prompt 都按「挂起项 ∩ 当前未完成项」渲染回 `## Suspended work`：还剩哪些、打断它的是哪句话、停在哪、以及当时的会话事件号（可用 `session_event_read` 回读转录）。这些项从清单里消失（做完或取消）即删文件。**插话落在当前正在跑的回合时**，同一份快照改渲染成 `## Interjection during this turn`：列出被挂起的项、插话原文、三个读法（取消 / 补充 / 另起一件事），并要求模型在**这一回合内**自己判断——停不停是模型的判断，不是插件替它打断。没有快照但有待办时，段末只追加一行 `Open items: …`——todo 面板只是当轮表面，日志不是。

3. **守卫（`agent/turn-stopping`）**
   满足全部条件时，用 `agent.steer()` 把一条 notice 塞回当前回合：
   - 本回合观察到中途 user 消息（`step > 1` 且批次里有 `source.kind === 'user'`），**或** `inbox.nextTurn` 里有排队消息；
   - 最近一次 `todo/write`（不超过 `maxStaleTurns` 个回合）里还有 `pending` / `in_progress` 项；
   - 本回合最后一句不是提问（默认跳过，避免打断「停下来问用户」）；
   - 本回合没催过、会话内没超过 `maxNudgesPerSession`。

   模型于是多走一步：干完，或写明「剩下 X，因为 Y」。

4. **观察（`agent/pre-step`）**
   只读不改，记录本回合是否收到插话，供守卫判断；debug 日志可见。

5. **首次运行（`first-run.json`）**
   第一次对着某个 store 启动时，section 里多一段 `## First run`：列出会影响行为的开关（`returnPolicy`、`forceStop`、`onInterject`、`storeTtlDays`）及其当前值，要求模型用一小段话告诉用户、并问要不要改。版本号直接读 `package.json`，不会忘了同步。标记文件保证只出现一次；store 不可写就下次再来一遍，不报错。

快照会顺手清扫：写新快照时删掉**其它会话**里超过 `storeTtlDays` 天的 `suspended-*.json`。插件从不触碰 DSH 自己的会话归档。

## 安装（挂进一个 profile）

```powershell
# 1) 把本目录登记成 profile 依赖与 bundle
#    编辑 <DSH_HOME>/profiles/desktop/package.json：
#    dependencies 加  "dsh-task-anchor": "link:<本仓路径>"
#    dsh.profile.bundles 加 "dsh-task-anchor"
# 2) 建立链接
cd <DSH_HOME>/profiles/desktop
pnpm install
# 3) 重启 DSH（宿主插件在启动时加载，热重载不覆盖 profile bundle）
```

`<DSH_HOME>` 指包含 `profiles/` 的那一层目录（DSH 存放 profile 数据的位置）。

验证加载：

```powershell
Get-Item <DSH_HOME>/profiles/desktop/node_modules/dsh-task-anchor |
  Select-Object Name, LinkType, Target
```

## 配置

写在 `cordis.patch.yml` 的 `config:` 下，全部可省略：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时不注册任何东西 |
| `contract` | `true` | 是否注入系统提示契约（约 320 tokens/请求）；同时是挂起锚的总开关 |
| `guard` | `true` | 是否启用 turn-stopping 守卫 |
| `onInterject` | `triage` | 插话时是否把挂起计划落盘（`triage`）；`off` = 只保留守卫 |
| `returnPolicy` | `auto` | `auto` 把提醒递回回合；`wait` 只记录不催。单靠 `wait` **不能中止正在跑的回合**，见 DESIGN §7.4 |
| `forceStop` | `off` | **实验性。** `off` / `always` / `triage`。插话落到 step 边界时直接停在那里，把这条消息交给下一回合；`triage` 只在文本不像取消、也不像补充修改时才停。默认关；停回合会让宿主播一次「任务结束」提示音，所以不作推荐路径 |
| `cancelPatterns` | 内置表 | 判「这条插话是取消」的正则列表（不区分大小写）；给了数组就整体替换默认值 |
| `amendPatterns` | 内置表 | 判「这条插话是补充修改」的正则列表（不区分大小写）；给了数组就整体替换默认值 |
| `triggerQueued` | `true` | 「下回合已有排队消息」是否也算触发条件 |
| `skipWhenAsking` | `true` | 回合末句是提问时不催 |
| `maxNudgesPerSession` | `6` | 每会话最多催几次；`0` = 只观察 |
| `maxNoticeItems` | `5` | notice / `Open items:` 行里最多列几项 |
| `maxStaleTurns` | `3` | todo 清单跨多少回合后视为过期（只影响守卫） |
| `storeDir` | `<DSH_HOME>/task-anchor` | `suspended-<session>.json` 存放目录；回落到 `~/.dsh/task-anchor` |
| `storeTtlDays` | `7` | 写快照时顺手清理其它会话超过 N 天的快照；`0` 关闭 |

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
cd <本仓路径>
node --test     # 52 条单测：策略判定 + apply() 接线，不需要启动 DSH
```

端到端手测（重启后）：

1. 让 agent 做一个三步任务，要求先写 todo；
2. 第二步执行中插一句无关追问；
3. 观察回合结束前是否出现 `[task-anchor]` notice，以及模型是否交代剩余项。

日志关键字：`task-anchor: steered a reminder`（info）、`task-anchor: mid-turn user message observed`（debug）。

已确认（2026-11-15）：重启后会话 system prompt 里出现契约段 `## Mid-turn user messages` ⇒ 插件加载与 section 注入正常；插话时落盘 `suspended-<session>.json` 并渲染 `## Suspended work`；回合收尾出现 `[task-anchor]` notice；改写清单后快照被删。

2026-11-19 在 DSH 0.2.2-rc.5 上复检。这次是**依赖闭包 diff，不只是运行时证据**：`@deepseek-ai/dsh` 的 0.2.2-rc.3 与 0.2.2-rc.5 都从 npm 拉下来逐文件比对，本插件站立的每一个宿主包 —— `dsh-system-prompt`、`dsh-agent-loop`、`dsh-agent`、`dsh-session`、`dsh-tools`、`dsh-skill`、`dsh-app-boot`、`dsh-plugin-manager` —— **逐字节一致**，只有 `package.json` 的版本字段在动。真正改了代码的两个包（`dsh-llm-deepseek`：新增 `CONTENT_REFUSED` 错误码；`dsh-web`：按模型路由选搜索 provider）都不在本插件的契约面上，所以 rc.3 那轮确认的契约原样穿过 rc.4 与 rc.5。运行中的 rc.5 宿主上，契约段照常出现在会话 system prompt 里，`node --test` 本机 52/52。这一轮没复跑的：真实插话（本轮没有插话到达），因此 `suspended-<session>.json` 落盘、`[task-anchor]` notice 与 `forceStop` 路径没有重跑 —— 那些代码（`lib/index.js`、`lib/policy.js`）跑在没动过的宿主面上。

`returnPolicy: wait` 也实测过一次：守卫如预期保持安静，**但回合没有停** —— 模型自己接着做挂起的那份计划了。这是能力边界：`wait` 只拿掉「催」这个动作，剩下的只有契约措辞能请求它停，所以补了 `### Waiting for the user` 明确写出来。**所以主路径不是强行停，而是上面那条同回合提示**：模型在插话落地的那一步就看到「挂起的是什么、刚来的是什么」，由它自己决定。`forceStop: always` 是实验性的机械停：`agent/pre-step` 里把这一批消息放回 `next-turn` 并返回 `reject`，这个 step 不会打开，`turn/end` 记成 `blocked`，下一回合从这条插话开始。2026-11-15 已 live 验证（`turn/end reason=blocked` → 消息在下一回合开头重新送达），同一次实测也暴露了代价：宿主播了「任务结束」提示音，用户体感就是「任务被打断」。`forceStop: triage` 把停的范围收窄到「不像取消、也不像补充修改」的插话；关键词启发式，尚未 live 验证。

### 实验性：硬停（`forceStop`）

**默认关闭**（`forceStop: off`），也不是推荐路径 —— 推荐的是上面那条同回合提示。它只服务于「想要机械保证、不接受建议」的场合。

**机制**：`agent/pre-step` 里如果这一批里含用户消息，`parkAndStop()` 先把它们逐条 `append` 成 `next-turn`（先落盘，崩了也不丢），再返回 `{ kind: 'reject' }`；turn 循环把它变成 `turnEnds = { kind: 'blocked' }` 并直接 return、不调 `step()`（`dsh-agent-loop/src/agent.ts:354-357`），于是宿主看到一次正常的回合结束，消息原样成为下一回合的开场。

**限制**：
- 停的是**回合**，不是计划：todo 清单还在、到那一步为止的转录还在、之前的工具结果也还能读。
- 被 reject 的回合**没有 assistant 收尾语**，转录上是直接断掉。
- 宿主播「任务结束」提示音，和「任务真的做完了」无法区分 —— 这就是它默认关着的原因。
- `triage` 只把「不像取消、也不像补充修改」的文本停掉；那是关键词启发式，不是语义判断：「裙子什么颜色」不含取消/补充词 ⇒ 仍归「另一件事」⇒ 照样会停。
- 被暂存的消息要等 loop 空闲才重投；一直不空闲就留在 `next-turn` 里，跟下一条用户消息一起走。
- 配置：`forceStop: off | always | triage`、`returnPolicy: auto | wait`；默认 `off` + `auto`。

## 现状

进度、证据、未验证项与下一步：见 [docs/STATUS.md](docs/STATUS.md)。设计取舍：见 [docs/DESIGN.md](docs/DESIGN.md)。

## 卸载

从 profile 的 `dependencies` 与 `dsh.profile.bundles` 里删掉两行，`pnpm install`，重启。
