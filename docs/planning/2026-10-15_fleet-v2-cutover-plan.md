# Fleet v2 Cutover Plan — CLI Binary, Cross-Process State Persistence, API Boundary Forwarding, and Pilot Proof (2026-10-15)

## 1. Objective & Scope

With all four hexagonal bounded contexts (`@fleet/work-execution`, `@fleet/evidence-and-acceptance`, `@fleet/brief-knowledge`, `@fleet/operator-coordination`) and the three application boundaries (`@fleet/cli`, `@fleet/api`, `@fleet/web`) implemented and verified on `main` (`65962a9`), this plan defines the three cutover items required to move from single-process test composition to durable multi-process CLI and HTTP inspection operation:

1. **Cutover Item 1 — `@fleet/cli` Executable Binary (`fleet-v2`), `--state-dir` / `FLEET_STATE_DIR` Wiring & Cross-Process Receipt/Coordinate Persistence:**
   - Package `@fleet/cli` with a shebang entrypoint (`apps/cli/src/bin.ts` -> `apps/cli/dist/bin.js`, `"bin": { "fleet-v2": "./dist/bin.js" }`).
   - Strip global `--state-dir <path>` / `--state-dir=<path>` before group dispatch and before `parseFlags`, falling back to `process.env.FLEET_STATE_DIR`, while keeping an explicitly injected `runtime` parameter authoritative.
   - Persist cross-context state (`accepted-receipts.json` and `authorization-coordinates.json`) inside `stateDir` in both `apps/cli/src/composition.ts` and `apps/api/server/wiring/runtime.ts` so separate CLI invocations and restarted API processes share acceptance receipts and authorization coordinates across process boundaries.
2. **Cutover Item 2 — `@fleet/api` Nitro Startup Plugin, Strict `/v1/*` Route Input Forwarding, and `@fleet/web` `FLEET_API_URL` Binding:**
   - Add `apps/api/server/plugins/runtime.ts` so Nitro calls `configureFleetApiRuntime({ stateDir })` at server startup when `process.env.FLEET_STATE_DIR` is set and non-empty, while remaining unconfigured (`501 NOT_IMPLEMENTED`) by default when unset.
   - Update `/v1/*` route handlers to forward parsed JSON bodies, query parameters, and exact route parameters (`workOrderId`, `attemptId`, `candidateHeadSha`, `assessmentId`, `entryId`, `grantId`, `requestId`) to their single bound use case without inventing new multi-use-case orchestration or unsafe parameter aliases.
   - Wire `process.env.FLEET_API_URL ?? process.env.NEXT_PUBLIC_FLEET_API_URL` as the default `baseUrl` in `apps/web/src/lib/api-client.ts` (`createFleetWebApiClient()`) while keeping `deploy/staging/app.yaml` unconfigured by default so unauthenticated LAN HTTP callers cannot trigger live `ocm-run` or `gh` subprocesses.
3. **Cutover Item 3 — Multi-Process CLI & Restarted API Cutover Pilot Proof:**
   - Prove the full 4-context workflow (`register-profile` -> `work-order register` -> `knowledge` keeper lifecycle -> `brief prepare` -> `capacity reserve` -> `attempt dispatch/reconcile/collect` -> `evidence request-verification/record-verification/record-review/assess` -> `attempt accept` -> `coordination request-decision/resolve-auth` -> `forge execute`) across **separate `runCli(['--state-dir', stateDir, ...])` invocations** with no shared in-memory `runtime`.
   - Prove a process-restart boundary where a freshly initialized API runtime (`configureFleetApiRuntime({ stateDir })`), the Nitro startup plugin (`FLEET_STATE_DIR` set vs unset), and a local `http.Server` serving the `/v1/*` route handlers deliver those CLI-created records to `createFleetWebApiClient` (`source: 'api'`, `status: 200`), alongside a 501-vs-validation test matrix (`configureFleetApiRuntime(null)` -> `501` vs configured runtime + invalid body -> non-501).

### Explicit Non-Goals & Authority Rules (`AGENTS.md` & `~/.claude/CLAUDE.md`)
- **Do not replace `ocm-run` or `gh`:** `ExecutionRunnerAdapter` and `ForgeActionAdapter` continue to wrap the existing reviewed scripts behind argument-array subprocesses with `RUNNER_ENV_ALLOWLIST`.
- **No unauthenticated remote dispatch/forge in staging:** Because `fleet-v2` has no auth platform (`docs/architecture.md`), `deploy/staging/app.yaml` does not mount a live `FLEET_STATE_DIR` or expose mutating `/v1/*` subprocess triggers on the public Ingress without an auth boundary; staging deployment (`yarn staging:deploy --yes`) is executed only under the owner's explicit instruction in this session.
- **No full workspace gate on `midnight` inside a lane:** Lanes on `midnight` run targeted package/app tests only; full verification gates are run at convergence/CI.

---

## 2. Detailed Design

### Item 1: `@fleet/cli` Executable Binary & Durable Cross-Process State

#### 1.1 Cross-Process Persistence of `acceptedReceiptByHead` and `resolveCoordinates`
In both `apps/cli/src/composition.ts` and `apps/api/server/wiring/runtime.ts`:
- Currently, `acceptedReceiptByHead` (`Record<string, string>`) and `resolveCoordinates` (`Map<string, { attemptId: string; expectedHeadSha: string }>`) live only in process memory. If Process A runs `attempt accept` (or `coordination resolve-auth`) and exits, Process B running `forge execute --kind merge-pr` on the same `stateDir` would fail because its in-memory maps are empty.
- **Fix:** When `stateDir` is provided:
  - Reload `<stateDir>/accepted-receipts.json` before each check and write it atomically (`writeFileSync` to a temp file in `stateDir` + `renameSync`) whenever an assessment is accepted (also checking `evidenceAssessmentRepository.findAssessmentByHead(expectedHeadSha)` so any accepted `EvidenceAssessmentRecord` on disk is honored).
  - Reload `<stateDir>/authorization-coordinates.json` before each check in `consumeGrant` and write it atomically whenever `resolveActionAuthorization` grants an authorization.

#### 1.2 Global `--state-dir` Flag & `FLEET_STATE_DIR` Environment Variable in `apps/cli/src/index.ts`
- Add `extractStateDirOption(argv: readonly string[], envStateDir?: string): { readonly stateDir?: string; readonly restArgv: readonly string[] }`:
  - Scans `argv` and strips `--state-dir <path>` or `--state-dir=<path>` from any position before `<group> <subcommand>` and before `parseFlags(rest)` so `--state-dir` never leaks into the command payload.
  - Rejects missing/empty flag values or paths containing null bytes (`\0`) with `CliUsageError` (exit code `2`), and normalizes valid paths via `path.resolve()`.
  - Falls back to `envStateDir?.trim()` (`process.env.FLEET_STATE_DIR`) when `--state-dir` is omitted.
- In `runCli(argv: readonly string[], io: CliIo = processIo, runtime?: FleetCliRuntime): Promise<number>`:
  - Keep an explicitly passed `runtime` authoritative (`const activeRuntime = runtime ?? createFleetCliRuntime({ stateDir })`) so all existing single-process tests in `cli-workflow.test.ts` continue to work unchanged.
  - Update `HELP_TEXT` and error messages to reference `fleet-v2` and document `--state-dir <path>` / `FLEET_STATE_DIR`.

#### 1.3 Executable Binary Entrypoint (`apps/cli/src/bin.ts` & `apps/cli/package.json`)
- Create `apps/cli/src/bin.ts`:
  ```ts
  #!/usr/bin/env node
  import { main } from './index.js';

  main();
  ```
- Add `"bin": { "fleet-v2": "./dist/bin.js" }` to `apps/cli/package.json`. TypeScript preserves `#!/usr/bin/env node` at the top of `dist/bin.js`.

---

### Item 2: `@fleet/api` Nitro Startup Plugin, `/v1/*` Route Input Forwarding, and `@fleet/web` `FLEET_API_URL` Support

#### 2.1 Nitro Startup Plugin (`apps/api/server/plugins/runtime.ts`)
- Create `apps/api/server/plugins/runtime.ts`:
  ```ts
  import { configureFleetApiRuntime } from "../wiring/runtime";

  export default defineNitroPlugin(() => {
    const stateDir = process.env.FLEET_STATE_DIR?.trim();
    if (stateDir) {
      configureFleetApiRuntime({ stateDir });
    }
  });
  ```
- When `FLEET_STATE_DIR` is unset, the plugin is a no-op and default `501 NOT_IMPLEMENTED` behavior is preserved.

#### 2.2 Shared HTTP Request Input Helper (`apps/api/server/wiring/http-input.ts`) & `evidenceResponse`
- Create `apps/api/server/wiring/http-input.ts`:
  - `readObjectBody(event: H3Event): Promise<Record<string, unknown>>`: reads JSON body via H3's `readBody(event)`, returning `{}` when no body is sent, and throwing an H3 `400` error if a non-object primitive or array is supplied.
  - `readQueryRecord(event: H3Event): Record<string, unknown>`: returns `getQuery(event)` as a plain object.
- Update `evidenceResponse(event: H3Event, useCase: EvidenceUseCase, operationId: string, input?: unknown): Promise<ApiEnvelope>` in `apps/api/server/wiring/evidence/errors.ts` so `useCase.execute(input)` receives `input`.
- Update `/v1/*` route handlers so each route forwards its parsed body/query and route parameter using the exact property name required by that use case's port contract:
  - `POST /v1/work-orders`: `registerWorkOrder.execute(await readObjectBody(event))`
  - `GET /v1/work-orders/:id`: `inspectWorkOrder.execute({ workOrderId: getRouterParam(event, "id") ?? "" })`
  - `GET /v1/attempts/:id`: `reconcileAttempt.execute({ ...readQueryRecord(event), attemptId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/attempts/:id/artifacts`: `collectAttemptArtifacts.execute({ ...(await readObjectBody(event)), attemptId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/attempts/:id/fix`: `prepareFixAttempt.execute({ ...(await readObjectBody(event)), priorAttemptId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/attempts/:id/stop`: `stopAttempt.execute({ ...(await readObjectBody(event)), attemptId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/attempts/:id/acceptance`: `requestAttemptAcceptance.execute({ ...(await readObjectBody(event)), attemptId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/forge`: `executeAuthorizedForgeAction.execute(await readObjectBody(event))`
  - `POST /v1/verifications`: `evidenceResponse(event, ..., "RequestVerification", await readObjectBody(event))`
  - `POST /v1/verifications/:id/receipt`: forwards `body.assessmentId` untouched and merges `:id` into `receipt.id` (`{ ...body, receipt: isPlainObject(body.receipt) ? { ...body.receipt, id: getRouterParam(event, "id") ?? "" } : body.receipt }`)
  - `POST /v1/reviews`: `evidenceResponse(event, ..., "RequestIndependentReview", await readObjectBody(event))`
  - `POST /v1/reviews/:id/receipt`: forwards `body.assessmentId` untouched and merges `:id` into `receipt.id` (`{ ...body, receipt: isPlainObject(body.receipt) ? { ...body.receipt, id: getRouterParam(event, "id") ?? "" } : body.receipt }`)
  - `POST /v1/findings/:id/disposition`: forwards `body.assessmentId` untouched and merges `:id` into `disposition.findingId` (`{ ...body, disposition: isPlainObject(body.disposition) ? { ...body.disposition, findingId: getRouterParam(event, "id") ?? "" } : body.disposition }`)
  - `POST /v1/heads/:sha/assessment`: `evidenceResponse(event, ..., "AssessHeadAcceptance", { ...(await readObjectBody(event)), candidateHeadSha: getRouterParam(event, "sha") ?? "" })`
  - `GET /v1/heads/:sha/evidence`: `evidenceResponse(event, ..., "InspectAcceptanceEvidence", { ...readQueryRecord(event), candidateHeadSha: getRouterParam(event, "sha") ?? "" })`
  - `POST /v1/attempts/:id/notes`: `knowledgeResponse(event, ..., { ...(await readObjectBody(event)), attemptId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/knowledge/checks`: `knowledgeResponse(event, ..., await readObjectBody(event))`
  - `POST /v1/knowledge/:id/disposition`: `knowledgeResponse(event, ..., { ...(await readObjectBody(event)), entryId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/knowledge/:id/publish`: `knowledgeResponse(event, ..., { ...(await readObjectBody(event)), entryId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/knowledge/proposals`: `knowledgeResponse(event, ..., await readObjectBody(event))`
  - `POST /v1/knowledge/selections`: `knowledgeResponse(event, ..., await readObjectBody(event))`
  - `POST /v1/knowledge/:id/reuse`: `knowledgeResponse(event, ..., { ...(await readObjectBody(event)), entryId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/knowledge/:id/supersede`: `knowledgeResponse(event, ..., { ...(await readObjectBody(event)), olderEntryId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/projects`: `registerProjectProfile.execute(await readObjectBody(event))`
  - `GET /v1/capabilities`: `inspectConfiguredCapabilities.execute(readQueryRecord(event))`
  - `POST /v1/decisions`: `requestScopedDecision.execute(await readObjectBody(event))`
  - `POST /v1/authorizations/resolve`: `resolveActionAuthorization.execute(await readObjectBody(event))`
  - `POST /v1/authorizations/:id/consume`: `recordAuthorizationConsumption.execute({ ...(await readObjectBody(event)), grantId: getRouterParam(event, "id") ?? "" })`
  - `POST /v1/observations`: `publishProjectObservation.execute(await readObjectBody(event))`
  - `GET /v1/attention`: `readProjectAttention.execute(readQueryRecord(event))`
  - `POST /v1/relays`: `sendFleetRelay.execute(await readObjectBody(event))`
  - `POST /v1/relays/:id/acknowledgement`: `recordRelayAcknowledgement.execute({ ...(await readObjectBody(event)), requestId: getRouterParam(event, "id") ?? "" })`
  - `GET /v1/coordination`: `inspectOutstandingCoordination.execute(readQueryRecord(event))`
  - *(Note: `POST /v1/attempts` keeps its existing 3-step `prepareBriefPackage` -> `reserveExecutionCapacity` -> `dispatchAttempt` structure without adding conditional branching.)*
- **501 vs Validation Error Matrix:**
  - When unconfigured (`configureFleetApiRuntime(null)`), every use case has `this.deps === undefined` and immediately throws `Not implemented: <UseCaseName>`, which maps to HTTP `501 NOT_IMPLEMENTED`.
  - Separate the `!this.deps` guard (`throw new Error(NOT_IMPLEMENTED)`) from missing/invalid request object guards in use cases so a configured runtime returns a structured domain rejection (`outcome: 'rejected'` / `'invalid'` / `'unavailable'`) rather than throwing `Not implemented` when given an empty or incomplete request object.

#### 2.3 `@fleet/web` Default `baseUrl` Resolution from Environment (`apps/web/src/lib/api-client.ts`)
- In `createFleetWebApiClient(options: FleetWebApiClientOptions = {})`:
  - When `options.baseUrl` is `undefined`, fall back to `process.env.FLEET_API_URL ?? process.env.NEXT_PUBLIC_FLEET_API_URL ?? ""` (while an explicit `options.baseUrl: ""` continues to force unconfigured fallback in unit tests).

---

### Item 3: Multi-Process CLI & Restarted API Cutover Pilot Proof

1. **Multi-Process CLI Persistence Test (`apps/cli/src/__tests__/cli-workflow.test.ts`):**
   - Execute the complete 4-context lifecycle (`coordination register-profile` -> `work-order register` -> `knowledge capture-notes/check-claim/decide/propose-context` -> `brief prepare` -> `capacity reserve` -> `attempt dispatch/reconcile/collect` -> `evidence request-verification/record-verification/record-review/assess` -> `attempt accept` -> `coordination request-decision/resolve-auth` -> `forge execute`) by calling `runCli(['--state-dir', stateDir, ...], io)` **with `runtime` omitted on every call**, proving that every step reconstructs a fresh `FleetCliRuntime` from `stateDir` on disk (including atomic `accepted-receipts.json` and `authorization-coordinates.json`) and completes the merge.
2. **CLI-Write -> API-Restart -> HTTP Read + 501 Matrix Pilot Test (`apps/api/server/wiring/__tests__/cutover-pilot.test.ts`):**
   - Test the Nitro startup plugin (`apps/api/server/plugins/runtime.ts`) with `FLEET_STATE_DIR` unset (stays 501) and set (configures runtime).
   - Seed `stateDir` via CLI/use-case calls, call `configureFleetApiRuntime(null)` (verifying routes return `501 NOT_IMPLEMENTED`), then call `configureFleetApiRuntime({ stateDir })` (simulating an API process restart against an existing `stateDir`), verify configured routes with an empty/bad body return domain rejections rather than `501`, and read `/v1/work-orders/:id`, `/v1/heads/:sha/evidence`, `/v1/coordination`, and `/v1/attention` through `createFleetWebApiClient({ baseUrl })` over a real loopback `http.Server`, asserting `source: 'api'`, `status: 200`, and exact record fidelity.

---

## 3. Verification & Rollout Sequence

1. **Re-verify Plan with `grok-4.7`:** Confirm all review findings are addressed and commit both `docs/planning/2026-10-15_fleet-v2-cutover-plan.md` and `docs/planning/2026-10-15_fleet-v2-cutover-plan-review.md`.
2. **Implement in Disposable Lane Worktree on `midnight.lan`:** Run targeted package/app tests during the lane (`vitest run` on modified suites).
3. **Convergence Checks & PR:** Verify `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:arch`, `yarn sync:check`, and targeted test suites; open PR with `What`, `Proof`, `Hard to undo`, `Assumptions`, and `Challenge this`; merge when green.
4. **Owner-Requested Staging Deployment (`midnight.lan`):** Pull `main` and run `yarn staging:deploy --yes` as explicitly requested by the owner.
