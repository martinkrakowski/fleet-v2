# Scaffold generation and verification

Date: 2026-10-13.

Generated at `/Users/martin/Projects/fleet-v2` with Hexagen's CLI from the corrected
`.architecture/manifest.yaml`. The generation command was:

```sh
node /Users/martin/Projects/hexagen-monaco/cli.js sync --force-root --allow-dirty
```

Hexagen 0.14.0 is installed as project-local tooling for subsequent regeneration.
The initial package manager configuration was seeded only to let the CLI locate
the new workspace and complete its preflight. Hexagen generated the context
packages, app, source scaffolds, barrels, package metadata and architectural
invariants. The generation reported zero failures.

## Manifest checks

- Supported Hexagen manifest schema: passed.
- Four business contexts; one CLI app.
- 36 use cases; 63 single-owner ports; 27 declared adapter bindings.
- Every outbound port has a named adapter binding.
- Supplier delegation references resolve to existing supplier-owned inbound ports.
- Context dependencies are acyclic; CLI depends on all four contexts.
- 164 declared entity, value-object, use-case, port and adapter symbols were found
  as exports in their generated source files.
- All 27 generated adapter classes declare the expected port implementation.
- Generated package dependencies agree with context and app dependencies.

## Scaffold gates

| Command | Result |
|---|---|
| `yarn install` | Passed; project-local tooling and workspace dependencies installed |
| `yarn build` | Passed, five workspaces |
| `yarn typecheck` | Passed, five workspaces |
| `yarn lint` | Passed, five workspaces |
| `yarn lint:arch` | Passed |
| `yarn test` | Exited 0; four contexts explicitly allow no test files |
| `yarn sync:check` | Passed; zero pending generation operations |

## What this establishes

The scaffold is structurally consistent, installable and type-checkable. It has
no behavioural tests or implemented execution stations yet. Empty generated port
interfaces and adapter classes do not demonstrate working isolation, recovery,
verification, authorization or knowledge retrieval. Their typed contracts and
behaviour are the first migration work.

## Application templates follow-up

On 2026-10-13, added `apps/web` (Next.js App Router) and `apps/api` (Nitro)
through the installed Hexagen CLI's framework templates:

```sh
yarn exec hexagen sync --force-root --allow-dirty
```

Installed Next.js 15.5.27 and Nitro (`nitropack`) 2.13.4. The API has explicit
workspace dependencies on the four business contexts; the frontend currently
has no domain-package dependencies. The CLI app remains present.

The Next.js TypeScript settings added by its first build are retained in the
manifest's framework override, including explicit strict mode. Next/Nitro
outputs are ignored and declared as build-cache outputs.

Verified after generation:

- `yarn lint`, `yarn typecheck` and `yarn build`: passed across seven workspaces.
- `yarn lint:arch`: passed.
- `yarn sync:check`: passed, zero pending operations.
- Next.js production server: `GET /` returned HTTP 200 and the generated homepage.
- Nitro production server: `GET /` returned HTTP 200 with
  `{"status":"ok","app":"api"}`.
- Both temporary verification servers were stopped after the HTTP checks.

Development commands are `yarn workspace @fleet/web dev` (port 3000) and
`yarn workspace @fleet/api dev` (port 3001). Business workflows are still
unimplemented; the HTTP checks establish that the generated app templates run.
