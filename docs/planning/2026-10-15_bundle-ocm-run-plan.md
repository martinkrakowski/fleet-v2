# Implementation Plan: Bundle `bin/ocm-run` Inside `fleet-v2`

- **Date:** 2026-10-15
- **Target Repository:** `fleet-v2`
- **Status:** Amended after `grok-4.7` Round 1 review (`grok -m grok-4.7 --permission-mode plan`)

---

## 1. Objective & Context

Currently, `fleet-v2` dispatches, inspects (`--status`), and aborts (`--abort`) runner sessions through `ExecutionRunnerAdapter` (`packages/work-execution/src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.ts`), which defaults `ocmRunBin` to `'ocm-run'` on `PATH` (resolving to `~/.local/bin/ocm-run` -> `~/Projects/fleet/bin/ocm-run`).

To make `fleet-v2` self-contained and sever its runtime dependency on the legacy `~/Projects/fleet` repository:
1. Bundle a sanitized, public-safe executable `bin/ocm-run` POSIX `/bin/sh` script directly in the `fleet-v2` repository (`bin/ocm-run`, mode `0755`).
2. Add a deterministic path resolver `resolveBundledOcmRunBin()` in `@fleet/work-execution` (`packages/work-execution/src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.ts`) so `@fleet/cli` and `@fleet/api` default to `fleet-v2`'s bundled `bin/ocm-run` rather than relying on an external `PATH` symlink.
3. Preserve full backward compatibility with existing unit and integration tests (`work-execution-adapters.test.ts` and `cli-workflow.test.ts`), keep `OCM_HOST` distinct from `FLEET_WORKTREE_SSH_HOST`, and keep `RUNNER_ENV_ALLOWLIST` unchanged per `AGENTS.md`.

---

## 2. Architectural & Public-Readiness Constraints (`AGENTS.md` & `docs/architecture.md`)

1. **Hexagonal Boundary & Generated Barrels:**
   - Subprocess and filesystem resolution belong strictly in infrastructure (`packages/work-execution/src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.ts`) and composition roots (`apps/cli/src/composition.ts`, `apps/api/server/wiring/work/composition.ts`). Domain and application layers remain pure.
   - Do **not** hand-edit `packages/work-execution/src/index.ts` or `packages/work-execution/src/infrastructure/adapters/index.ts`: both are Hexagen-generated barrels (`export *`) that automatically re-export any public symbol added to `ExecutionRunnerAdapter.adapter.ts`.
2. **Public-Safe Script Contents (`docs/architecture.md`):**
   - `docs/architecture.md` requires: *"Keep private hosts, paths, project registries, seat choices and operational history outside reusable product code."*
   - Both comments **and** executable defaults in `fleet-v2/bin/ocm-run` must be free of operator-private values:
     - **Strip private comments:** Remove private hostnames (`midnight`), private project names (`campaign-foundry`, `cf-lanes`, `hexagen-monaco`, `hexagen-lanes`), private filesystem paths (`/mnt/pool/cloud-services/...`), and historical incident dates from the header comments.
     - **Remove private SSH alias default (`OCM_HOST`):** Replace `host="${OCM_HOST:-m}"` with `host="${OCM_HOST:-}"`. When `127.0.0.1:$port` is already listening (`nc -z 127.0.0.1 "$port"`), no SSH tunnel is opened and `OCM_HOST` is not required; when the tunnel is not yet open and `[ -z "$host" ]`, `bin/ocm-run` exits `2` with `ocm-run: OCM_HOST is required to open the tunnel to remote port $remote`. Diagnostics format host context as `${host:+ on $host}` so messages never print a blank or hardcoded alias.
     - **Remove vendor seat-policy rewrite (`nvidia/*:low`):** Remove the `case "$model:$variant" in nvidia/*:low) variant=none ;; esac` block from `fleet-v2/bin/ocm-run`. Seat and variant selection belong to operator configuration (`FLEET_RUNNER_VARIANT`), while `bin/ocm-run` retains only the generic v2 `--variant` rewrite (`-m <model>#<variant>` / `--model=<model>#<variant>`).
     - **Keep OpenCode default port `4096`:** `remote="${OCM_REMOTE_PORT:-4096}"` and `port="${OCM_PORT:-$((remote + 1))}"` remain unchanged (4096 is OpenCode's upstream default).
     - **Preserve all safety invariants:** Auth-file loading from `${OPENCODE_AUTH_FILE:-$HOME/.config/opencode/server-auth.env}` inside `ocm-run`, Rule 1 (exit `75` when `--dir` is busy unless `OCM_ALLOW_BUSY=1`), Rule 2 (`INT`/`TERM`/`HUP` traps aborting sessions started by this process unless `--detach` is given), `--status` (exit `0` idle / `3` running), `--wait` (two-read confirmation), `--abort`, `--check`, v2 remote session creation (`POST /api/session`), and the single retry on early `"database is locked"` errors.
3. **Separate `OCM_HOST` and `FLEET_WORKTREE_SSH_HOST` (`AGENTS.md`):**
   - `FLEET_WORKTREE_SSH_HOST` is the host holding git worktrees (`WorkspaceAdapter` / `AttemptArtifactAdapter`).
   - `OCM_HOST` is the SSH target used by `bin/ocm-run` to open the loopback tunnel to the OpenCode server.
   - Never overwrite or alias `OCM_HOST` from `FLEET_WORKTREE_SSH_HOST`. `RUNNER_ENV_ALLOWLIST` in `ExecutionRunnerAdapter.adapter.ts` already includes both `OCM_HOST` and `OCM_REMOTE_PORT`; forward `OCM_HOST` only from its own dedicated option (`remoteHost` / `OCM_HOST`).

---

## 3. Detailed Design & File Changes

### 3.1. Add `bin/ocm-run` (Executable POSIX Shell Script, Mode `0755`)
- **File:** `bin/ocm-run`
- **Behaviour:**
  - Sanitized POSIX `/bin/sh` script with `host="${OCM_HOST:-}"`, explicit check before `ssh -f -N` when `127.0.0.1:$port` is not listening, and no `nvidia/*:low` seat-policy branch.
  - Committed with executable permissions (`100755`, verified via `git ls-files --stage bin/ocm-run`).
- **Docker / Staging Packaging Note:**
  - `Dockerfile` copies the repository archive into `/app` (`WORKDIR /app`), so `/app/bin/ocm-run` is present for path resolution inside the container image. Note that `node:22-bookworm-slim` does not install `ssh`, `curl`, or `opencode`, so copying `bin/ocm-run` into the image does not by itself make the staging API container capable of live runner dispatch.

### 3.2. Add `resolveBundledOcmRunBin()` and `remoteHost` Option in `ExecutionRunnerAdapter.adapter.ts`
- **File:** `packages/work-execution/src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.ts`
- **Changes:**
  1. Export `resolveBundledOcmRunBin(startDirs?: readonly string[], env: NodeJS.ProcessEnv = process.env): string`:
     - Checks `env.FLEET_OCM_RUN_BIN?.trim()`; if non-empty, returns it.
     - Walks upward from `startDirs` (defaulting to `[dirname(fileURLToPath(import.meta.url)), process.cwd()]`) to filesystem root looking for `join(currentDir, 'bin', 'ocm-run')` via `existsSync`.
     - Returns the first existing path to `bin/ocm-run`, or falls back to `'ocm-run'` if not found.
  2. In `ExecutionRunnerAdapterOptions`:
     - Add optional `readonly remoteHost?: string;` (`OCM_HOST` passed to the runner subprocess when configured).
     - Update `remotePortEnv()` (or rename private helper to `runnerEnvOverrides()`) so it returns `{ OCM_REMOTE_PORT?, OCM_HOST? }` when `remotePort` and/or `remoteHost` are defined, and `undefined` when neither is defined.
     - Keep `private binPath(): string { return this.options?.ocmRunBin ?? 'ocm-run'; }` unchanged when `ocmRunBin` is omitted on direct `new ExecutionRunnerAdapter({ runSubprocess })` instantiation so existing unit tests in `work-execution-adapters.test.ts` (line 769 `expect(calls[0]?.command).toBe('ocm-run')`) remain untouched.
  3. Do **not** modify `packages/work-execution/src/index.ts` (generated barrel already re-exports `ExecutionRunnerAdapter.adapter.ts`), and do **not** add a `../../bin/ocm-run` entry to `apps/cli/package.json`.

### 3.3. Wire `resolveBundledOcmRunBin()` and `OCM_HOST` in `@fleet/cli` and `@fleet/api` Composition Roots
- **Files:**
  - `apps/cli/src/composition.ts`
  - `apps/api/server/wiring/work/composition.ts`
- **Changes:**
  1. In `FleetCliRuntimeOptions` (`apps/cli/src/composition.ts`) and `WorkCompositionOptions` (`apps/api/server/wiring/work/composition.ts`), add optional:
     - `readonly runnerBin?: string;`
     - `readonly runnerRemoteHost?: string;`
  2. Resolve:
     - `const ocmRunBin = options?.runnerBin ?? resolveBundledOcmRunBin();`
     - `const runnerRemoteHost = options?.runnerRemoteHost ?? (process.env.OCM_HOST?.trim() || undefined);`
  3. Pass `ocmRunBin` and `remoteHost: runnerRemoteHost` into `new ExecutionRunnerAdapter({ ocmRunBin, agent: runnerAgent, model: runnerModel, variant: runnerVariant, remotePort: runnerRemotePort, remoteHost: runnerRemoteHost, resolveWorktreePath })`.

### 3.4. Update `cli-workflow.test.ts` and Add Unit Tests in `work-execution-adapters.test.ts`
- **Files:**
  - `apps/cli/src/__tests__/cli-workflow.test.ts`
  - `packages/work-execution/src/infrastructure/adapters/__tests__/work-execution-adapters.test.ts`
- **Changes:**
  1. In `apps/cli/src/__tests__/cli-workflow.test.ts`:
     - Pass `runnerBin: path.join(binDir, 'ocm-run')` in `createFleetCliRuntime({ stateDir, runnerBin: path.join(binDir, 'ocm-run') })` while keeping `binDir` prepended to `process.env.PATH` (which the `gh` stub still relies on).
  2. In `packages/work-execution/src/infrastructure/adapters/__tests__/work-execution-adapters.test.ts`:
     - Add unit tests verifying:
       - `resolveBundledOcmRunBin()` resolves the repository's `<repoRoot>/bin/ocm-run` and that the script is executable (`fs.access(..., fs.constants.X_OK)`).
       - `resolveBundledOcmRunBin()` respects the `FLEET_OCM_RUN_BIN` override in the supplied `env` object without mutating `process.env`.
       - `ExecutionRunnerAdapter` passes `OCM_HOST` when `remoteHost` is configured (alongside `OCM_REMOTE_PORT`).
       - Invoking the bundled `bin/ocm-run` with `--attach=bad` (with `OCM_PORT` unset in the subprocess env) exits with code `2` and stderr containing `do not pass --attach`.

### 3.5. Documentation Updates (`AGENTS.md` & `docs/architecture.md`)
- **Files:**
  - `AGENTS.md`
  - `docs/architecture.md`
- **Changes:**
  - In `AGENTS.md` ("Live runner and worktree configuration"):
    - Document `OCM_HOST` (SSH host used by `bin/ocm-run` to open the loopback tunnel to the OpenCode server when `127.0.0.1:<OCM_REMOTE_PORT + 1>` is not already listening) separately from `FLEET_WORKTREE_SSH_HOST` (host that owns the git worktrees).
    - Document that `fleet-v2` bundles `bin/ocm-run` and resolves it automatically via `resolveBundledOcmRunBin()` (overridable via `FLEET_OCM_RUN_BIN`).
  - In `docs/architecture.md`:
    - Note that `bin/ocm-run` is bundled in the repository and wrapped by `ExecutionRunnerAdapter`.

---

## 4. Verification Plan

1. Verify `bin/ocm-run` syntax, executable bit, and absence of private host/project/seat tokens:
   - `sh -n bin/ocm-run && test -x bin/ocm-run`
   - `! grep -E 'midnight|campaign-foundry|cf-lanes|hexagen|nvidia/' bin/ocm-run`
2. Run full build, typecheck, lint, architecture, sync, and test suite:
   - `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check`
   - `yarn test`
3. Run live `OCM_HOST=m OCM_REMOTE_PORT=4166 ./bin/ocm-run --check` to verify the bundled script probes the live OpenCode server cleanly.
