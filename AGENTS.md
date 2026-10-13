# Fleet v2 agent instructions

This project is a generated, CLI-first hexagonal scaffold. Read
`.architecture/manifest.yaml` and `docs/architecture.md` before changing it.

- Keep the four business contexts and their declared acyclic dependency direction.
- Domain code is pure. Application code depends on ports. Every filesystem,
  subprocess, network, database and vendor dependency belongs in infrastructure.
- Refine typed contracts before implementing a station. Generated empty ports and
  stubs do not establish an implemented guarantee.
- Use the existing Fleet scripts behind adapters before replacing their behaviour.
- Workers are disposable and isolated. Context enters through frozen briefs;
  candidate notes never become instructions or authority automatically.
- Never read, print, copy or commit credentials, tokens, secrets or client content.
- Live dispatch, host administration, real data migration and deployment require
  their existing explicit authority. Scaffolding grants none of those actions.
- Keep installation configuration and runtime artifacts in ignored paths.
- No console logging in package code; CLI I/O belongs at the application boundary.
- Update the manifest when adding owned ports, use cases or adapters. Regenerate
  using Hexagen rather than manually duplicating its symbol scaffolds.
- After changes run `yarn build && yarn typecheck && yarn lint && yarn lint:arch`.
  Run meaningful tests for implemented behaviour and `yarn sync:check` for drift.
- Do not commit or push unless explicitly requested.
