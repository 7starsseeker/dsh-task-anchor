# 发版流程

> English: [RELEASING.md](RELEASING.md)

给维护者看。先立三条规矩：

1. **零运行时依赖不可谈判。** `package.json` 里不能有 `dependencies`；有就不发。
2. **跑自测，把原始输出贴进 release note** —— 不要写「测试通过」。
3. **先打 tag，再 publish。** 反过来会让 npm 上有一个 GitHub 找不到 tag 的版本。

## 1. 版本号

| 改动 | 版本 |
|---|---|
| 提示措辞、文档、内部修复 | patch（0.2.2 → 0.2.3） |
| 新配置键、新契约段、新行为 | minor（0.2.2 → 0.3.0） |
| 配置键或 notice 格式不兼容 | major（0.x 阶段：用 minor + CHANGELOG 标 BREAKING） |

## 2. 发布前检查

```bash
node --check lib/index.js && node --check lib/policy.js && node --check lib/store.js
node --test tests/          # 期望：36 条，0 失败
npm pack --dry-run          # 自己读一遍：不能有 tests、临时脚本、本地文件
```

`npm pack --dry-run` 的清单应当正好是：`lib/`、`cordis.patch.yml`、四份文档、`LICENSE`、`NOTICE`、`package.json`。

## 3. 文档

- `CHANGELOG.md` + `CHANGELOG.zh-CN.md`：两边各加一节，**只写净变化** —— 没发布过的迭代历史不写。不许只改一个。
- `README.md` + `README.zh-CN.md`：配置表与机制列表保持一致；英文版是默认文件。
- 测试条数出现的地方都要改：`README.md`、`README.zh-CN.md`、`AGENTS.md`、`docs/DESIGN.md`、`docs/STATUS.md`。

## 4. 那个故意留的口子

`package.json` 出厂是 `"private": true`。这就是本次发布需要你亲手做的那一处：在提版本号的那个 commit 里把它改成 `false`。不改，`npm publish` 会拒绝；提前改，一次手滑的 `npm publish` 就可能发出去 —— 所以这个翻转必须发生在测试全绿、tag 计划好之后。

## 5. 提交并打 tag

```bash
git add -A
git commit -m "release: v0.2.2"
git tag v0.2.2
git push origin main --tags
```

## 6. 发布

```bash
npm publish --access public
```

CI 自动发布**故意还没接**。接的时候用 npm **trusted publishing**（OIDC），由 workflow 从 tag 发布 —— 不要在仓库里加 `NPM_TOKEN` secret。这就是元数据已经准备好的「之后还要再更新一次」：`publishConfig` 已经是 public。

## 7. 发布之后

- 用 tag 建 GitHub release，贴 CHANGELOG 对应段 + 原始测试输出。
- 检查 npm 页面是否正确渲染 README、LICENSE、徽章；`npm view dsh-task-anchor dist-tags` 对不对。
- 装进一个干净的 DSH profile（`<DSH_HOME>/profiles/…`），确认契约段真的挂上、守卫能催一次 —— 「装上了但没挂载」正是这个仓库存在的理由，别让它发生在自己身上。
