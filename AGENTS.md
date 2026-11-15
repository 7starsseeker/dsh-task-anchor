# AGENTS.md — dsh-task-anchor

DSH 插件仓。作用域：让模型在中途收到用户消息时先判断它与当前任务的关系，并在回合「本该结束但还有未完成计划」时机械兜底一次。

## 硬约束（写错就加载不起来 / 恢复不了会话）

- 插件 id = `lib/index.js` 的 `export const name` = `task-anchor`；包名 = `dsh-task-anchor`；`cordis.patch.yml` 里 `id` 与 `name` 必须分别等于这两者。
- 注入给模型的 notice 只能用自有 source kind `plugin:task-anchor`。写成 `{kind:'plugin', plugin:'task-anchor'}` 能写进日志但读不回来，恢复会话报 `SessionFormatError`。
- 零依赖 ESM（Node >= 22.15）。不要 import DSH 内部包：运行时解析不到，插件要能在纯 node 下被 `node --check` / 测试直接跑。

## 命令

- 测试：`node --test tests/` —— 35 条，纯 fake ctx，不启动 DSH。
- 语法：`node --check lib/index.js; node --check lib/policy.js; node --check lib/store.js`

## 生效方式

已在 desktop profile 挂载（`dsh-task-anchor": "link:T:/dsh-task-anchor"` + `dsh.profile.bundles` 里有 `dsh-task-anchor`）。

- 改 `lib/**`：重启 DSH 进程生效。
- 改 profile 的 `package.json`：还要在 `T:\Deepseek-harness\.dsh\profiles\desktop` 跑 `pnpm install`。
- 改 `cordis.patch.yml` 的 config：重启生效；临时改行为也可以直接改 config 再重启。

## 边界

- 不改 DSH core。要改「插话在模型眼里与普通消息同形」这个语义，先写 `.agents/notes` 的 Agent Note（该不变量出自 `2026-07-20-unwrap-injected-content-envelopes.md`）。
- 不要给本仓建 `.codegraph/` 索引（工作区根目录已禁用；daemon 自动生成的空脚手架已在 .gitignore）。
- 本机 shell 只有 pwsh；删除只按显式清单，不用通配。

## 现状

进度、验证证据、未验证项与下一步：见 [docs/STATUS.md](docs/STATUS.md)。设计取舍：见 [docs/DESIGN.md](docs/DESIGN.md)。
