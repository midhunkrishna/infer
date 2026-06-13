# Publishing `infer-cmd` to npm

Release runbook for maintainers.

## Prerequisites

- An npm account with publish rights to `infer-cmd`.
- `npm login` completed locally (`npm whoami` confirms).
- 2FA enabled on the npm account (recommended; required for `--otp` flows).
- A clean working tree on the default branch with CI green.

## Versioning (SemVer)

```sh
npm version patch   # bug fixes        0.1.0 -> 0.1.1
npm version minor   # new features     0.1.0 -> 0.2.0
npm version major   # breaking changes 0.1.0 -> 1.0.0
```

`npm version` bumps `package.json` and creates a git commit + tag (`vX.Y.Z`).

## Pre-publish checklist

```sh
npm ci                  # clean install
npm run build           # produce dist/cli.js
npm test                # full suite must pass
npm pack --dry-run      # inspect the tarball contents
```

Confirm the tarball ships **only** `dist/` (plus README/LICENSE) — the `files`
field in `package.json` controls this. Verify:

- `bin.infer` points to `dist/cli.js`
- `engines.node` is `>=18`
- no `src/`, `test/`, or secrets are included

Dry-run the publish:

```sh
npm publish --dry-run
```

## Publish

```sh
npm publish --access public
```

Then verify from a clean environment:

```sh
npm i -g infer-cmd@latest
infer --help
infer doctor
```

Push the tag created by `npm version`:

```sh
git push && git push --tags
```

## Automated release (optional)

`.github/workflows/release.yml` publishes on a pushed `v*` tag:

1. Add an **NPM automation token** as the `NPM_TOKEN` repo secret
   (npm → Access Tokens → Generate → "Automation").
2. Push a tag: `git push --tags`.
3. CI runs build + tests, then `npm publish --provenance --access public`.

Provenance requires `permissions: id-token: write` (already set in the workflow).

## Branch protection

Require the **CI** check to pass before merging to `master`:
Settings → Branches → add a rule for `master` → "Require status checks to pass" →
select the CI workflow.

## Rollback

`npm` disallows re-publishing the same version. To pull a bad release:

```sh
npm deprecate infer-cmd@X.Y.Z "Broken release — use X.Y.(Z+1)"
# npm unpublish infer-cmd@X.Y.Z   # only allowed within 72h, avoid if depended on
```

Prefer publishing a fixed patch version over unpublishing.
