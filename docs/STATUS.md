# STATUS — dsh-task-anchor

更新：2026-11-15。这是交接快照，不是设计文档（设计见 [DESIGN.md](DESIGN.md)）。

## 一句话状态

v0.1.0 已实现、21 条单测通过、已挂载进 desktop profile；**契约段已在 live 会话中验证生效**；**守卫（turn-stopping 兜底）尚未在真实插话场景端到端验证**。

## 要解决的问题（出处）

执行指令途中用户插话，agent 往往立刻转去做插话内容并输出，原任务做一半丢掉，或注意力被带偏。原会话调研报告：`T:\Deepseek-harness\.dsh\notes\2026-11-15-steering-interjection-research.md`（索引在 `notes\INDEX.md`）。

根因是三件事叠加，其中两件在 DSH core、本插件只能绕：

1. `packages/core/session/src/surface.ts:83-114` 把 `user/message` 逐字投影 —— 插话与开场 prompt 在模型眼里同形同权，没有「这是中途插入」的标记。
2. `packages/core/system-prompt/src/index.ts` 里 grep `steer|interrupt|mid-turn` 零命中 —— 模型从未被告知执行中收到新消息该怎么处理。
3. 没有跨步骤的任务锚：`todo` 投影在 `turn/start` 清空；compaction 的 `## Next Step` 又明确要求「对齐最近一次请求」，而插话恰好就是最近一次请求。

## 本插件的两个机制

| 机制 | 挂点 | 作用 | 是否落盘 |
| --- | --- | --- | --- |
| 契约段 | `ctx.systemPrompt.section(...)`，order 540，每请求重新渲染 | 告诉模型：插话是新输入、不自动等于替换当前任务；按「补充约束 / 修正当前步 / 提问 / 新任务 / 改目标」分类处理；永不静默丢弃 | 否（system prompt，不污染转录） |
| 守卫 | `agent/turn-stopping` | 回合本该结束、但本回合收过插话（或下轮已有排队）且还有未完成 todo 时，`agent.steer()` 一条 `[task-anchor]` notice 把剩余计划递回去，代价是一次额外请求 | 是（一条持久 user 消息，kind `plugin:task-anchor`） |

不做的事（有意）：不判定插话与任务的关系（模型判）、不延迟/不阻止插话、不改 core 的逐字投影、不做 UI 标注。

## 已有证据（真实输出）

- 单测：`node --test tests/` → `tests 21` / `pass 21` / `fail 0`（tests/policy.test.mjs 12 + tests/plugin.test.mjs 9）。
- profile 集成校验（headless 脚本）：`resolved: T:\dsh-task-anchor` / `name matches: true` / `patch exists: true` / `entry: {"id":"task-anchor","name":"dsh-task-anchor"}` / `exported name matches id: true` / `bundle listed in profile: true`。
- 符号链接：`node_modules\dsh-task-anchor` → `..\..\..\..\..\dsh-task-anchor`（SymbolicLink）。
- **live**：DSH 重启后（GUI 端口 49048 → 12174），会话 system prompt 中出现本插件注入的 `## Mid-turn user messages` 段 ⇒ 插件已加载、契约生效。

## 未验证（下一个会话从这里开始）

1. **守卫端到端手测**（最高优先）。步骤建议：
   1. 新会话，给一个明确多步任务（≥3 步、会让 agent 写 todo）。
   2. 在第 1–2 步之间插一句与原任务无关的新任务。
   3. 期望：该 turn 收尾时出现一条 `[task-anchor] ...` user 消息，列出剩余 todo，agent 随后继续原任务。
   4. 假阴性排查顺序：模型自己继续做了原任务 → 不触发是对的（无「未完成就停」）；未触发且确实停早了 → 查 `openTodos` 是否为空（没写 todo，或已超 `maxStaleTurns=3`）、末句是否以 `?`/`？` 结尾（`skipWhenAsking` 生效）、本轮是否已催过（每 turn 一次）、会话配额是否用尽（`maxNudgesPerSession=6`）。
2. 阈值调参：`maxNudgesPerSession=6`、`maxStaleTurns=3`、`maxNoticeItems=5` 都是拍的，需要真实使用后校准。
3. 契约体积：约 150 tokens/请求且常驻，可考虑「会话内出现过插话后才 sticky 出现」。
4. 可选 UI 侧标注：让用户看见哪条是插话、哪条是插件 notice（客户端投影；参考 `.agents/notes/implemented/feature/2026-08-04-web-context-source-and-steer-marks.md` 与 `2026-08-10-web-remove-steering-interjection-caption.md`，后者删掉了「插话」气泡标注）。
5. 可选上游化：把「中途消息关系契约」做成 DSH 自带 prompt section，需要写 Agent Note 并查 supersession（`2026-07-20-unwrap-injected-content-envelopes.md` 是本决策的直接前身）。

## 已知边界（别当 bug 修）

- **step 1 漏判**：`inbox.claim()` 先取全部 `next-step` 再取 1 条 `next-turn`，所以第 1 步的批次是 `[steering..., opener]`，`detectInterjection` 要求 `step > 1`，此时段进来的插话会被记成普通消息。代价是偶发漏一次兜底，不是误触。
- **依赖 todo**：模型没写 todo 就没有任务锚，守卫不会触发。这是有意的——宁可不动，也不要凭猜测「提醒」模型该做什么。
- **守卫只能救「自己停下」**：插话被理解成新任务、然后一路做下去的情况，靠契约段软约束，机械层拦不住。
- **与同类插件叠加**：`dsh-loop-continue`、`dsh-early-stop-guard` 也挂 `agent/turn-stopping` 并 `steer`。本插件每 turn 最多一次，但两个插件可能各催一次。

## 关键位置

- `lib/index.js:37` `export const name = 'task-anchor'`；`:43` `NOTICE_SOURCE_KIND`；`:46` `SECTION_ORDER = 540`；`:76` `noticeMessage()`；`:94` `apply()`；`:103` 注册 section；`:115` `agent/pre-step` 观察；`:128` `agent/turn-stopping` 守卫。
- `lib/policy.js`：`detectInterjection` / `openTodos` / `buildContractText` / `buildNoticeText` / `normalizeConfig`（纯函数，全部单测覆盖）。
- `cordis.patch.yml`：全量默认配置 + id/name 约定说明。

## 回滚

- DSH 快照：`20261115-172955-ac20`（`undo_list` / `undo_restore mode "id"`）。
- 手动停用：`cordis.patch.yml` 里 `enabled: false`，或只关 `guard: false` / `contract: false`，重启 DSH。
- 完全卸载：profile `package.json` 删 `dsh-task-anchor` 两行（dependencies + `dsh.profile.bundles`），再 `pnpm install`。
