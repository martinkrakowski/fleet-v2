# Setup

This project was scaffolded by hexagen. Before your first push:

```bash
corepack enable                 # activate the pinned package manager
yarn install                    # resolves dependencies, writes yarn.lock
git add yarn.lock && git commit -m "chore: add lockfile"
git push
```

Once `yarn.lock` is committed, you can switch CI to a reproducible install by
adding `--immutable` to the `yarn install` step in
`.github/workflows/ci.yml` (npm: `npm ci`; pnpm: `pnpm install --frozen-lockfile`).

**Notes**

- CI reads your package-manager version from `package.json` (`packageManager`)
  via Corepack, so bumping it stays in sync automatically — nothing to edit in
  `ci.yml`.
- **This file is a one-time bootstrap doc — delete it after your first push.**
  Its pre-lockfile guidance goes stale once `yarn.lock` is committed. (Run
  `hexagen sync` won't bring it back — it's a protected root file.)
