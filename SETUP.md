# Setup

Developer setup and CI reproduction for Fleet v2:

```bash
corepack enable                 # activate the pinned package manager (yarn@4.12.0)
yarn install --immutable        # install dependencies reproducibly from yarn.lock
yarn build                      # build every workspace in dependency order
```

`yarn build --filter=<pkg>...` builds one workspace and everything it depends on; `yarn workspace <pkg> build` alone leaves dependency `dist/` stale and is not used. See the README's Quick start paragraph.

The gate workflow in `.github/workflows/gate.yml` runs on every pull request and push to `main`:

```bash
yarn build
yarn typecheck
yarn lint
yarn lint:arch
yarn test
yarn sync:check
```

**Notes**

- CI reads the package-manager version from `package.json` (`packageManager`) via Corepack.
- The gate workflow is defined in `.github/workflows/gate.yml`.
