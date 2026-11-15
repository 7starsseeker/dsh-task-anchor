# Release flow

> 中文版：[RELEASING.zh-CN.md](RELEASING.zh-CN.md)

For maintainers. Three rules first:

1. **Zero runtime dependencies is non-negotiable.** `dependencies` must stay out of `package.json`; anything there blocks the release.
2. **Run the self-tests and paste the raw output** into the release notes — not "tests pass".
3. **Tag first, then publish.** The reverse order leaves npm with a version GitHub has no tag for.

## 1. Version

| Change | Version |
|---|---|
| Prompt wording, docs, internal fix | patch (0.2.2 → 0.2.3) |
| New config key, new contract section, new behaviour | minor (0.2.2 → 0.3.0) |
| Breaking config keys or notice format | major (during 0.x: minor + BREAKING in CHANGELOG) |

## 2. Pre-release checks

```bash
node --check lib/index.js && node --check lib/policy.js && node --check lib/store.js
node --test          # expect: 37 tests, 0 failures
npm pack --dry-run          # read it: no tests, no scratch scripts, no local files
```

`npm pack --dry-run` must list exactly `lib/`, `cordis.patch.yml`, the four docs, `LICENSE`, `NOTICE`, and `package.json`.

## 3. Docs

- `CHANGELOG.md` + `CHANGELOG.zh-CN.md`: one new section in both, **net changes only** — no iteration history that never shipped. Never update only one.
- `README.md` + `README.zh-CN.md`: keep the config table and the mechanism list in sync. English is the default file.
- Bump the test count wherever it appears: `README.md`, `README.zh-CN.md`, `AGENTS.md`, `docs/DESIGN.md`, `docs/STATUS.md`.

## 4. Commit and tag

```bash
git add -A
git commit -m "release: v0.2.3"
git tag v0.2.3
git push origin master
git push origin v0.2.3
```

Pushing the tag is what starts the publish workflow, so push the commit first — a tag pointing at a commit that is not on the branch yet publishes code nobody can review on GitHub.

## 5. Publish

`.github/workflows/publish.yml` publishes from a `v*` tag with npm **trusted publishing** (OIDC, GitHub Actions): no `NPM_TOKEN`, no repository secret. It runs `node --test` and then `npm publish`.

Settings that must exist on npm before the first tag:

- Package → Settings → Trusted Publisher → GitHub Actions, with organization `7starsseeker`, repository `dsh-task-anchor`, workflow filename `publish.yml`, and **Allow npm publish** checked.
- A newly created configuration must complete its first successful publish **within 2 days**, otherwise it expires and has to be recreated.

Manual fallback, if CI is unavailable:

```bash
npm publish --access public
```

Do not add a token secret "temporarily" — the trusted publisher is bound to this workflow file, and a token reintroduces the risk the OIDC path removes.

## 6. After publish

- Create the GitHub release from the tag; paste the CHANGELOG section and the raw test output.
- Verify the npm page renders the README, LICENSE and badges; check `npm view dsh-task-anchor dist-tags`.
- Install it into a scratch DSH profile (`<DSH_HOME>/profiles/…`) and confirm the contract section and one guard nudge work — a package that installs but does not mount is the failure mode this repository exists to avoid.
