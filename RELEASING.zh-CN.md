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
node --test          # 期望：40 条，0 失败
npm pack --dry-run          # 自己读一遍：不能有 tests、临时脚本、本地文件
```

`npm pack --dry-run` 的清单应当正好是：`lib/`、`cordis.patch.yml`、四份文档、`LICENSE`、`NOTICE`、`package.json`。

## 3. 文档

- `CHANGELOG.md` + `CHANGELOG.zh-CN.md`：两边各加一节，**只写净变化** —— 没发布过的迭代历史不写。不许只改一个。
- `README.md` + `README.zh-CN.md`：配置表与机制列表保持一致；英文版是默认文件。
- 测试条数出现的地方都要改：`README.md`、`README.zh-CN.md`、`AGENTS.md`、`docs/DESIGN.md`、`docs/STATUS.md`。

## 4. 提交并打 tag

```bash
git add -A
git commit -m "release: v0.2.3"
git tag v0.2.3
git push origin master
git push origin v0.2.3
```

推 tag 才会触发发布 workflow，所以先推提交 —— tag 指向一个还没进分支的提交，等于把没人能在 GitHub 上审到的代码发出去了。

## 5. 发布

`.github/workflows/publish.yml` 由 `v*` tag 触发，用 npm **trusted publishing**（OIDC + GitHub Actions）发布：不配 `NPM_TOKEN`，仓库里也不放 secret。流程是先 `node --test` 再 `npm publish`。

第一次打 tag 之前，npm 侧必须有：

- 包 → Settings → Trusted Publisher → GitHub Actions：organization 填 `7starsseeker`，repository 填 `dsh-task-anchor`，workflow filename 填 `publish.yml`，勾上 **Allow npm publish**。
- 新建的配置要在 **2 天内**完成首次成功发布，否则过期作废，只能删了重建。

CI 不可用时的手动兜底：

```bash
npm publish --access public
```

不要「临时」加一个令牌 secret —— trusted publisher 绑的就是这个 workflow 文件，塞回令牌等于把 OIDC 消掉的风险又请回来。

## 6. 发布之后

- 用 tag 建 GitHub release，贴 CHANGELOG 对应段 + 原始测试输出。
- 检查 npm 页面是否正确渲染 README、LICENSE、徽章；`npm view dsh-task-anchor dist-tags` 对不对。
- 装进一个干净的 DSH profile（`<DSH_HOME>/profiles/…`），确认契约段真的挂上、守卫能催一次 —— 「装上了但没挂载」正是这个仓库存在的理由，别让它发生在自己身上。
