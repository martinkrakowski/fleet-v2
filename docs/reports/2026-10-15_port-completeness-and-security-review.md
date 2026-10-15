# Fleet to fleet-v2: port completeness and security review

*Date: 2026-10-15 · Reviewer: Fable 5.1 (session fleet-v2-07), read-only · Scope: `fleet-v2` `main` at `ac2e4b5` against `fleet` `main` at `bc9921a` · Status: draft, uncommitted, not a station pass*

## Verdict

The port is not complete, and it is not claimed to be. Of the workshop's behaviours, the execution kernel, brief freezing, worktree inspection, artifact collection, exact-head acceptance, fresh fix rounds, knowledge capture and the relay and decision records are ported and tested (558 tests, local gate green, GitHub gate green at `ac2e4b5`). Every external transport (verification host, independent reviewer, forge CI evidence, Waves, ByteStash, installation loading, `doctor`) is a cutover station: two are running, three are queued, four are not started. Those are in flight and are not findings here.

Outside the cutover plan's Evidence table, this review found 30 defects: 7 high, 15 medium, 3 security-specific, 5 low. The high ones all sit on the acceptance, authorization or capacity path and need fixing before any workflow is declared moved:

1. The product's independence check compares the reviewer against a model id baked into application code, never against the model the lane actually ran on (H1).
2. A reconcile against the wrong server port, or the wrong directory string, is answered "nothing is running" and the product records an authoritative end, releases capacity and lets collection and acceptance proceed on a lane that is still running (H2).
3. `fleet-v2 attempt dispatch` blocks for the lane's whole duration and learns the session id only when the lane ends; a killed dispatch leaves an attempt the product can neither reconcile nor re-dispatch, and a re-dispatch cancels the attempt and frees capacity while the lane runs on (H3).
4. Two product processes writing one state directory overwrite each other's records (whole-map persistence, last writer wins). With two lanes running at a time and dispatch blocking for 45 minutes, this is the normal case, not an edge (H4).
5. The runner dispatches on the environment's seat, not the frozen manifest's, and passes no `-m` when the environment is unset (H5).
6. The forge path force-pushes to a branch name it invents, in whatever repository the shell is in (H6).
7. A grant approved for `push-and-open-pr` at a head authorises `merge-pr` at that head: the action scope is never compared at consumption (H7).

`main` on GitHub has no branch protection and no ruleset. The repository is public. The gate workflow runs but nothing requires it, so `gh pr merge` and the product's own merge path can merge a red PR today (O1).

## What was verified

| Check | Result |
|---|---|
| `yarn build && yarn test` on the Mac | 13 tasks ok; 558 tests pass (work-execution 170, brief-knowledge 108, evidence 106, coordination 105, api 42, web 19, cli 8) |
| GitHub gate at `ac2e4b5` | run `38813190660` success; red proof `38808345838` failed as intended |
| Workshop `tests/ocm-run.test.sh` against `fleet-v2/bin/ocm-run` | 63 checks, 0 failed (same as the workshop copy) |
| `shasum` of the three `ocm-run` copies | workshop and `~/.local/bin` identical (`06eef884…`); bundled copy differs (`5e2b0cc4…`) |
| Branch protection on `main` | none (`404 Branch not protected`); rulesets `[]`; visibility PUBLIC |
| midnight `.worktrees/fleet-v2/` | 50 worktrees; 5 station worktrees carry `.lane/brief.md`; two lanes running (2a, 3a) per the orchestrator |

No file in either tree was edited. No lane was dispatched. midnight was read over ssh only.

## Part 1: port completeness

Legend: **ported** (code and tests on `main`), **in flight** (a cutover station the orchestrator named: 2a and 3a running, 4a to 6a queued, 2b to 8 not started), **workshop** (stays a host program under M3, by design), **gap** (no code and no station).

### Work execution

| Workshop behaviour | Where in fleet-v2 | Status | Note |
|---|---|---|---|
| Brief in a gitignored worktree path | `AttemptArtifactAdapter.placeFrozenBrief` + `git check-ignore` | ported | |
| Frozen manifest (base commit, policy revision, seat, variant, fallback, reviewer, paths, bounds, selected knowledge) with digest | `PrepareBriefPackageUseCase` | ported | digest is never re-checked at dispatch (M3 below); the runner ignores the manifest's seat (H5) |
| Dispatch with explicit `-m`, variant, port | `ExecutionRunnerAdapter.startSession` | ported | `-m` omitted when `FLEET_RUNNER_MODEL` is unset (H5) |
| Session id belongs to one server | nothing records the port | **gap** | H2 |
| Status is the server, not the local watcher | `ReconcileAttemptUseCase` over `ocm-run --status` | partial | dispatch itself is a local watcher (H3); status parsed by keyword (M1) |
| `--detach` | passed on every start | ported | its meaning differs (H3) |
| Never dispatch into a busy worktree (exit 75) | `ReserveExecutionCapacity` + runner refusal | ported | refusal cancels the attempt and frees capacity while the lane runs (H3) |
| Abort, then confirm before releasing | `StopAttemptUseCase` over `ocm-run --abort` | ported | |
| Short lanes, fix round is a fresh session | `PrepareFixAttemptUseCase` | ported | resume (`-s`, `--fork`, stagger) not ported; acceptable under the fresh-session rule |
| Resume limits (45 min, $0.50, never twice) | nothing measures wall time or cost | **gap** | `timeLimitSeconds` is recorded, never enforced (M4) |
| Commits against the pre-dispatch tip; exit 0 is not work | `CollectAttemptArtifacts` → `no-commit` | ported | |
| `lane-usage` cost on the PR; over $1 reported | nothing | **gap** | M4 |
| Lane caps per server from installation | `maxSlots` is a CLI argument | in flight (2a/2b) | 2a's schema has no capacity section (B1) |
| `fleet worktrees list` | `WorkspaceAdapter` inspects one worktree | gap, planned for `doctor` (8) | |
| `fleet status`, `fleet project plan` | `InspectConfiguredCapabilities` reads only the profile file | planned (8) | host probing stays in the workshop |
| `fleet project onboard`, decommission, key proxy, LXD, egress, test DB | none | workshop (M3) | by design |
| `scripts/fleet-verify.sh` start/verify | none | planned (8) | |
| `ocm-run` | `bin/ocm-run` (bundled) | ported | drift from the workshop copy, no tests in fleet-v2's gate (M2) |

### Evidence and acceptance

| Workshop behaviour | Where in fleet-v2 | Status | Note |
|---|---|---|---|
| Targeted tests on the lane; CI is the gate | `RequestVerification`, `ForgeEvidenceAdapter` | in flight (3a, 4a, 4b) | CLI root does not bind forge evidence (Evidence table) |
| `verify-run.sh`, one verification at a time per host | station 3a calls it over ssh | in flight | the lock stays in the host script |
| Reviewer model never the implementer's | three checks | **defective** | all compare against a constant or operator input, not the lane's seat (H1) |
| High-risk reviewer seat once per lane | nothing marks a lane high-risk | gap | no station names it |
| PR sections (Hard to undo, Assumptions, Challenge this) | `ForgeActionAdapter.runPrCreate` body is one line | **gap** | PR #36 was opened by the product without them (M5) |
| One-way door stops for the owner | nothing reads `ownerDecisionReferences` | **gap** | M15 |
| Exact head; stale head refused | `AssessHeadAcceptance`, `RequestAttemptAcceptance`, `ExecuteAuthorizedForgeAction`, `ForgeActionAdapter` | ported | |
| Push, open PR, merge by the orchestrator only | `ForgeActionAdapter` through `gh` | ported | force push, invented branch name, no `-R` (H6, M6) |

### Knowledge

| Workshop behaviour | Where in fleet-v2 | Status | Note |
|---|---|---|---|
| Lane notes after the server says the lane ended | `CollectAttemptArtifacts` records that `.lane/notes.md` exists; `CaptureCompletedAttemptNotes` exists | partial | the collect use case declares `briefKnowledge` (`CollectAttemptArtifactsUseCase.use-case.ts:26`) and never calls it; notes reach the knowledge context only when the operator runs `knowledge capture-notes` by hand, and that use case cannot verify the lane ended (Appendix A) |
| Keep, defer, reject; only an orchestrator publishes | `DecideKnowledgeDisposition`, `PublishAcceptedKeeper` | ported | the API exposes both with no auth (S1) |
| `stash`: create and read, sign `--by`, no secrets | `KeeperPublicationAdapter` local shelf file | in flight (7) | no secret-pattern refusal yet; ByteStash transport not started |
| Retrieval proposes, orchestrator freezes | `ProposeBriefContext`, `RecordContextSelection` | ported | |
| Lexical first | `KnowledgeRetrievalAdapter` | ported | |

### Operator coordination

| Workshop behaviour | Where in fleet-v2 | Status | Note |
|---|---|---|---|
| Relays, silence is not agreement | `SendFleetRelay`, `RecordRelayAcknowledgement`, outbox files | ported | |
| Waves publish and read | outbox only; `AttentionReadAdapter` reads nothing | in flight (6b, not started) | |
| Signed decisions checked for scope, revision, prior use | `ResolveActionAuthorization`, `RecordAuthorizationConsumption` | in flight (6a for the signature) | signed bytes should include the head and scope (B4) |
| Registry alerts (disk, budget, stale lanes) | nothing | gap | |
| Owner runs restart, sudo, spending, policy | no such port exists | ported by absence | |
| Acknowledge seats and projects from installation | `RegisterProjectProfile` takes CLI flags | in flight (2b) | |

### Templates and tests

| Workshop piece | fleet-v2 | Status |
|---|---|---|
| `templates/pr-description.md` | not applied by the forge adapter | gap (M5) |
| `templates/relay.md` | relay notice JSON | ported |
| planning, remediation, runbook templates | `docs/planning`, `docs/runbooks` follow the shape | ported |
| `tests/ocm-run.test.sh` (63 checks) | not in fleet-v2; the bundled script is untested in its own gate | gap (M2) |
| other `tests/*.test.sh` | host scripts, stay in the workshop | workshop |

## Part 2: findings outside the cutover plan's Evidence table

Severity: **High** blocks declaring a workflow moved; **Medium** should be fixed before that workflow's declaration; **Low** is hygiene.

### H1. Independence is checked against a constant, not the lane's seat

- `packages/work-execution/src/application/use-cases/RequestAttemptAcceptanceUseCase.use-case.ts:26` hard-codes `DEFAULT_IMPLEMENTER_MODEL = 'nvidia/z-ai/glm-5.3'`; `:90-91` uses it whenever `implementerModelByAttempt` has no entry. Neither composition root passes `implementerModelByAttempt` (`apps/cli/src/composition.ts:834-838`, `apps/api/server/wiring/work/composition.ts:187-191`), so it is always the constant.
- `apps/cli/src/index.ts:464` takes `implementerModel` for `evidence request-review` from the operator's flags, not from the frozen manifest.
- `packages/evidence-and-acceptance/src/domain/entities/ReviewReceipt.ts:43-46` (`underlyingModelFamily`) strips one path segment, so `nvidia/z-ai/glm-5.3-flash` and `openrouter/z-ai/glm-5.3-flash` compare as different families. The orchestrator flagged this one.
- Scenario: a lane runs on `opencode/longcat-2.5-preview-free` (as PR #32's proof did). The operator requests acceptance with `--reviewer-model opencode/longcat-2.5-preview-free`. The check compares it with `nvidia/z-ai/glm-5.3`, finds them different, and accepts a self-review.
- Fix: record `modelAssignment` on the attempt at dispatch (it is in the manifest `PrepareBriefPackageUseCase.use-case.ts:146`) and bind every independence check to that field; delete the constant (it also violates M2); compare the family by stripping the provider and the `#variant` suffix and by comparing the last segment.

### H2. Wrong port or wrong directory is read as an authoritative end

- `packages/work-execution/src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.ts:300-331, 444-465`: `inspectSession` asks `ocm-run --status --dir <worktree>` and turns "nothing is running" into a `CommandCompletionReceipt` with `authoritative: true`, synthesised from the attempt's own ids (`:450-457`). `ReconcileAttemptUseCase.use-case.ts:99-103` then checks that receipt against the same ids, which always match, and releases capacity (`:113`).
- The attempt record has no server port (`execution-records.ts`, `AttemptRecord`); the port is read from the environment at every call (`composition.ts:358-360`). The workshop copy of `ocm-run` documents the hazard the product inherits: "the wrong OCM_REMOTE_PORT, or a path that is not the lane's, is answered 'nothing is running'" (`fleet/bin/ocm-run:35-38`).
- Scenario: the lane was dispatched with `OCM_REMOTE_PORT=4166`. A later `fleet-v2 attempt reconcile` runs in a shell without it. The shared server on 4096 knows no session in that directory, answers "nothing is running", the attempt is `ended`, capacity is released, `attempt collect` proceeds on a half-written head, and acceptance can be requested on it.
- Fix: record `remotePort` (and the binary's identity) on the attempt at start; refuse `inspectSession` when the configured port differs; ask the server about the session id (`GET /api/session/<id>`), not the directory; keep `authoritative: false` until the server itself reports the session ended.

### H3. Dispatch is a local watcher; a killed dispatch cannot be recovered

- `bin/ocm-run:446-462, 465-487`: run mode waits for the `opencode run` child. `--detach` only stops the signal trap from aborting the session. `ExecutionRunnerAdapter.startSession` (`:272-298`) therefore returns only when the lane ends, and only then parses the session id (`:285`).
- `DispatchAttemptUseCase.use-case.ts:150-180` saves the attempt as `dispatching` with `sessionId: null` before the start. If the CLI process dies (closed laptop, 10-minute subagent limit, SIGKILL), the attempt keeps `sessionId: null`. `ReconcileAttemptUseCase.use-case.ts:57-71` returns `unknown` without asking the server. `StopAttemptUseCase.use-case.ts:47` refuses. A second `attempt dispatch` reaches `ocm-run`, which exits 75; `DispatchAttemptUseCase.use-case.ts:241-258` records `cancelled`, journals `refused` and **releases the reservation**, while the lane runs on and will commit into the worktree.
- This is the exact failure `ocm-run`'s rules 1 and 2 were written for on 2026-10-11, reintroduced one layer up. The migration plan's step 3 ("recover after a killed local watcher without a second dispatch") is not met.
- Fix: start the session through the server API and return the id immediately (the bundled script already creates the session with `POST /api/session` when the directory is remote, `bin/ocm-run:455-460`; surface that id and detach the client), or run the client in the background and persist the id from the first NDJSON event. Treat exit 75 on dispatch as `unknown`, never as `refused`, and let reconcile adopt a session the server reports for that directory.

### H4. Whole-map persistence: two processes overwrite each other

- `AttemptRepositoryAdapter.adapter.ts:84-124`, `ExecutionJournalAdapter.adapter.ts:99-168`, `WorkOrderRepositoryAdapter`: each adapter loads its JSON file once per process (`loadPromise`) and every save rewrites the whole file from memory. The temp-file-and-rename only prevents torn reads.
- Scenario: process A runs `attempt dispatch` for attempt 1 (blocks 45 minutes, H3). Process B dispatches attempt 2 and writes `attempts.json`, `journal.json`, `reservations.json` with both. Process A finishes and writes its in-memory maps: attempt 2's record, journal entries and reservation are gone. B's lane is now invisible to reconcile, its worktree is free for a third dispatch, and the capacity count is wrong.
- PR #29's Assumptions names "last-writer-wins" for the two root-level files only; it applies to every repository.
- Fix: re-read before every write under an advisory lock (`flock` on a lock file, or `O_EXCL` lock directory as `verify-run.sh` does), or one record file per id (`<stateDir>/attempts/<id>.json`) with the same sanitised-id rule the decision adapter already has (`DecisionTransportAdapter.adapter.ts:33`).

### H5. The runner ignores the frozen manifest's seat, and `-m` is optional

- `ExecutionRunnerAdapter.adapter.ts:264-269`: agent, model and variant come from adapter options (environment `FLEET_RUNNER_*`), and each flag is added only when set. The manifest's `modelAssignment` (`PrepareBriefPackageUseCase.use-case.ts:146`) is never read at dispatch.
- Scenario: the brief freezes `nvidia/z-ai/glm-5.3`; the operator's shell has `FLEET_RUNNER_MODEL` unset. `ocm-run` is called with `--agent lane-glm` and no `-m`; the server agent's default (paid GLM-5.3-Flash per the rulebook's agent note) runs the lane. The frozen record says one seat, the lane ran on another, and the rulebook's "always pass `-m`" is broken silently.
- Fix: `startSession` takes model, variant and agent from the attempt's manifest; refuse to start without a model; the environment may only override with an explicit flag that is journaled.

### H6. Forge: force push, invented branch name, repository from the cwd

- `apps/cli/src/composition.ts:541-553` inside the **verify** delegate: `git fetch <host>:<worktree> <sha>:refs/heads/<branch> --force` then `git push -f origin <sha>:refs/heads/<branch>`. A head verification performs a force push as a side effect. `--force` without `--force-with-lease` discards anything on origin's branch.
- `ExecuteAuthorizedForgeActionUseCase.use-case.ts:114`: `branchName` is `feat/${workOrder.laneId}`, not the worktree's branch. The product cannot open a PR for `feat/forge-evidence-adapter-2026-10-15`; it pushes the head to a branch named after the lane id.
- `ForgeActionAdapter.adapter.ts:125-134, 169-176` and `composition.ts:210, 257`: `gh pr create`, `gh pr merge`, `git push origin` and `git fetch` run in the CLI's current directory with no `-R`/`--repo`. The work order's `repository` field is unused. Run `fleet-v2 forge execute` from `~/Projects/fleet` and the PR is opened in the wrong repository.
- Fix: pass `-R <owner>/<repo>` from the work order (station 4a already adds owner and repo to installation); push with `--force-with-lease=refs/heads/<branch>:<expected-or-empty>` or without force; record the worktree's branch on the attempt and use it; move the push out of the verify callback into `runPrCreate`, after the head check, and journal it.

### H7. A grant's action scope is never checked when it is consumed

- `ExecuteAuthorizedForgeActionUseCase.use-case.ts:90-93` consumes by grant id and action id only and never resolves; `RecordAuthorizationConsumptionUseCase.use-case.ts:67-89` checks prior use, state and head but not `recorded.actionScope`; the consumer-side request (`ActionAuthorizationPort.out-port.ts:24-27`) carries no kind. The CLI root's `consumeGrant` (`composition.ts:698-763`) compares heads only.
- Scenario: the owner approves `forge:push-and-open-pr` at head H (one decision file). The operator runs `forge execute --kind merge-pr --authorization-grant-id <that grant>` with H's acceptance receipt present. Consumption succeeds and the merge runs on a grant that never authorised a merge.
- Fix: carry `actionKind`, `expectedHeadSha` and `attemptId` on the consume request; compare `actionScope` in `RecordAuthorizationConsumption`; have the forge use case resolve with the kind before consuming.

### M1. `ocm-run --status` is classified by keywords, not by its exit code

- `ExecutionRunnerAdapter.adapter.ts:322, 429-476`: exit 0 and 3 are treated alike and the text is scanned. The status line contains the directory path. A worktree under `…/idle-fix/` matches `'idle'` (`:446`) and a running lane is reported ended with an authoritative receipt; a path containing `error` (`:433`) is reported unreachable forever.
- Fix: exit 0 is "nothing is running", exit 3 is "running"; parse only the session ids on exit 3.

### M2. The bundled `ocm-run` drifted and has no tests in fleet-v2

- `fleet-v2/bin/ocm-run` drops the `nvidia/*` + `--variant low` → `none` rewrite (`fleet/bin/ocm-run:435-437`) and the `OCM_HOST` default. With `FLEET_RUNNER_VARIANT=low` on an NVIDIA seat the server answers "Variant unavailable", the start is `unknown`, and the attempt sits in `reconciling` with its reservation held.
- The 63-check workshop suite passes against the bundled copy today, but fleet-v2's gate never runs it and the suite does not pin the NVIDIA rewrite. The cutover plan asks `doctor` to report drift; the gate should catch it first.
- Fix: vendor `tests/ocm-run.test.sh` into fleet-v2 and run it in `gate.yml`; decide which copy is canonical and mirror by hash.

### M3. The brief digest is never re-verified at dispatch

- `apps/cli/src/index.ts:358` takes `briefDigest` from the payload or the stored attempt; `DispatchAttemptUseCase` records it (`:157`) and nothing recomputes it from `.lane/brief.md` and `.lane/brief-manifest.json`. The readiness runbook's line "its digest matches" has no code. The digest is FNV-1a (`PrepareBriefPackageUseCase.use-case.ts:43-58`), which is fine for integrity but trivial to collide on purpose.
- Fix: recompute over the placed files in `DispatchAttempt` (through the artifact port) and refuse on mismatch; use SHA-256 through an injected `computeDigest` at the root.

### M4. No wall time, cost or step count is measured

- `AttemptArtifactAdapter.adapter.ts:139-142` collects head, commits, paths and notes. Nothing reads opencode's database (`lane-usage`), nothing records elapsed time, and `timeLimitSeconds` / `stepLimit` (`DispatchAttempt` request) reach no enforcement. The rules "measure every lane", "cost in the PR", "over $1 reported", "never resume past 60 minutes" cannot be kept by the product.
- Fix: a `LaneUsagePort` with an adapter over `opencode db` on the server (read-only), recorded on the attempt at collect time; a wall-clock check in reconcile that flags an attempt past its `timeLimitSeconds`.

### M5. PR discipline is not ported

- `ForgeActionAdapter.adapter.ts:130-133`: title `Fleet work order <id>`, body one line. `applyGhEnvironmentOverrides` (`composition.ts:191-200`) lets `FLEET_PR_BODY` replace it but nothing checks the three sections. PR #36 is the product's own output: body "Attempt att-bundle-part2-flash … at head 1f492c2…", no Hard to undo, Assumptions or Challenge this. The feature inventory lists this as "acceptance check before forge".
- Fix: the forge request carries a body (from a file in the worktree or the work order); `ExecuteAuthorizedForgeAction` refuses `push-and-open-pr` unless the three headings are present in order; the body names the attempt id, seat, cost (M4) and the pre-merge review's session id.

### M6. The CLI and API roots compute different coordination keys

- Action scope: `apps/cli/src/composition.ts:159-161, 677` uses `forge:<kind>`; `apps/api/server/wiring/runtime.ts:278` uses `<workOrderId>/<kind>`. Consumption id: CLI `consumption-<actionId>` (`:754`), API `consumption-<grantId>` (`runtime.ts:314`). Observation `eventKind`: CLI `execution:<action>:<status>` (`:771`), API `<action>` (`runtime.ts:331`).
- Both roots share one `FLEET_STATE_DIR`. A decision requested through the CLI with scope `forge:merge-pr` is never found by the API's resolve, and the other way round; the two roots will disagree about whether a merge is authorised.
- Fix: one pure function in `work-execution` (or a shared module) that both roots import for scope, consumption id and event kind.

### M7. A refused forge action cannot be retried in a new process

- `ExecuteAuthorizedForgeActionUseCase.use-case.ts:50-51, 185`: journal ids are `forge:<actionId>:<status>:<n>` with `n` counted per use-case instance. The CLI builds a fresh runtime per process and defaults `actionId` to `forge-<attemptId>` (`index.ts:430`). The second `forge execute` after a refusal produces the same id, `ExecutionJournalAdapter.appendJournalEntry` throws `Duplicate journal entry id` (`:50-53`), and the CLI exits 1 with an error instead of a typed result.
- Fix: derive `n` from the journal (as the other use cases do at `DispatchAttemptUseCase.use-case.ts:46-57`).

### M8. The runner asserts isolation it cannot see

- `ExecutionRunnerAdapter.adapter.ts:76-83`: `networkEgressRestricted`, `cpuAndMemoryLimited`, `processTreeTermination` are `true` by construction. `DispatchAttemptUseCase.use-case.ts:83-94` requires them and is satisfied by that assertion. The shared server on 4096 has no egress rule; the fleet-v2 container does. The product cannot tell them apart, and `ProjectProfile.runnerCapabilities` (operator-coordination) is never consulted at dispatch.
- Fix: the capability profile comes from installation per runner port (station 2a's schema needs a field for it, B1), defaults to every boolean `false`, and the dispatch refuses unless the profile says otherwise.

### M9. `GET /v1/attempts/:id` mutates state and runs a subprocess (API)

- `apps/api/server/routes/v1/attempts/[id].get.ts:12-14` calls `reconcileAttempt` with the query spread into the request, so a GET saves the attempt, appends journal entries, may release capacity and runs `ocm-run --status`; `nowIso` from the query string becomes the recorded time (`ReconcileAttemptUseCase.use-case.ts:55`). This is the route a web view would poll.
- Fix: GET reads the record; reconcile is a POST; `nowIso` is never accepted from the wire.

### M10. `POST /v1/forge` consumes the grant, then answers 501 (API)

- `runtime.ts:191-342` binds no `forge` delegate, so `ForgeActionAdapter.performForgeAction` throws (`:72-75`), but `ExecuteAuthorizedForgeActionUseCase.use-case.ts:90-106` has already consumed the grant and journaled intent. One stray request burns the owner's grant.
- Fix: check the forge port's readiness (a `describe()` or the delegate's presence) before consumption; or do not expose the route until 4b wires it.

### M11. `POST /v1/attempts` is dead in every configuration (API)

- `apps/api/server/routes/v1/attempts/index.post.ts:11-12` calls `prepareBriefPackage.execute(undefined)`; a configured use case throws `Not implemented` for a non-object (`PrepareBriefPackageUseCase.use-case.ts:208-210`). The body is ignored. The cutover test pins the 501 (`cutover-pilot.test.ts:583-588`). The brief view's dialog cites `POST /v1/attempts` as the route (`frozen-brief-card.tsx:107`).
- Fix: either implement it as three explicit calls with the body, or remove the route and the UI reference.

### M12. The merge gate is a head-keyed map, and a stale assessment can still be accepted

- `ExecuteAuthorizedForgeActionUseCase.use-case.ts:80-88` consults `acceptedReceiptByHead[sha]`, written by the root at acceptance time (`composition.ts:589-596`). The receipt is never read back from the evidence context, never bound to attempt or policy revision, and never revoked when `AssessHeadAcceptance` marks the assessment stale (`AssessHeadAcceptanceUseCase.use-case.ts:131-136`).
- `AssessHeadAcceptanceUseCase.use-case.ts:121-160` and `EvidenceAssessment.ts:282-294` (`accept`) have no terminal-state guard: a `stale` assessment re-assessed with its original head and policy is accepted again.
- Scenario: head H accepted under policy P1; policy moves to P2; a merge of H proceeds on the map entry without re-assessment.
- Fix: the forge use case reads the acceptance through a port at forge time (attempt, head, policy revision, state `accepted`); `accept()` refuses terminal states; stale and blocked transitions remove the receipt.

### M13. Assessment identity is not checked when receipts are merged

- `RequestVerificationUseCase.use-case.ts:95-111`: `existing ?? newRecord` without comparing the request's head, policy revision, attempt or project with the stored assessment; receipts for another head are appended and the entity's `pendingRequiredChecks` (`EvidenceAssessment.ts:180-190`) does not filter by head, so the stored record reads `pending` with no blockers. `AssessHeadAcceptance`'s own head filter still blocks acceptance, but `evidence inspect` shows a clean assessment.
- `RequestIndependentReviewUseCase.use-case.ts:137-149` returns `reviewed` even when no assessment exists, and stores nothing.
- Fix: refuse or mark stale on an identity mismatch; filter by head inside the entity; `RequestIndependentReview` creates the assessment or rejects.

### M14. Brief-knowledge use cases bypass their aggregate; a contradicted keeper can be published

- `PublishAcceptedKeeperUseCase.use-case.ts:44-53` checks `disposition` and `supersededById` only; `CheckKnowledgeClaimUseCase.use-case.ts:82-89` can set `contradicted` on an accepted entry (the entity forbids it at `KnowledgeEntry.ts:224-226`, but the use case writes the record by hand). `DecideKnowledgeDispositionUseCase.use-case.ts:64-85` can re-accept a superseded entry. The policy-proposal refusal is a keyword regex (`:19, 70-75`), not the entity's state guard (`KnowledgeEntry.ts:189-192`).
- Scenario: keeper K accepted; a later check contradicts it; `knowledge publish K` ships the contradicted claim to the shelf.
- Fix: route disposition, check and supersede through `KnowledgeEntry.decideDisposition` / `applyCheck` / `supersedeBy`; require `verification === 'supported'` to publish; make "policy proposal" an explicit orchestrator classification at capture.

### M15. No one-way-door gate exists in acceptance

- The feature inventory maps "a one-way door stops for the owner" to "`AssessHeadAcceptance` refuses". `AssessHeadAcceptancePort.in-port.ts:10-15` has no such input; `ownerDecisionReferences` is copied into the manifest (`PrepareBriefPackageUseCase.use-case.ts:155`) and read by nothing. A lane that names an undecided one-way door passes checks, review and acceptance.
- Fix: a blocker in `AssessHeadAcceptance` unless every `ownerDecisionReferences` entry resolves to an approved, consumed coordination request for this head.

### S1. The API has no authentication, origin or CSRF check

- No middleware under `apps/api/server/`; `nitro.config.ts` sets only `srcDir`. h3's `readBody` also parses `application/x-www-form-urlencoded`, which `readObjectBody` accepts (`http-input.ts:16-25`). A form POST is a CORS simple request, so any page the operator opens in a browser can fire every mutating `/v1/*` route at a LAN-reachable API.
- Reachable side effects once `FLEET_STATE_DIR` is set: abort a CLI-dispatched lane (`POST /v1/attempts/:id/stop` → `ocm-run --abort`), run `git`/`ssh` against a caller-supplied `worktreePath` (`POST /v1/attempts/:id/artifacts`, `AttemptArtifactAdapter.adapter.ts:96-176`), write knowledge candidates, project profiles, relays, decisions and observations that the CLI treats as the record, consume grants (M10).
- Staging sets no `FLEET_STATE_DIR`, so every route is 501 there today, and the Service exposes only the web port; port 3001 is reachable from inside the cluster with no NetworkPolicy.
- Fix before any state directory reaches the API: a bearer token from a mode-600 file named in installation, `Content-Type: application/json` required, `Origin` checked, and a NetworkPolicy in `deploy/staging`. Credential handling as C5.

### S2. Caller-controlled timestamps and paths on API work routes

- `nowIso` from the wire on reconcile, stop, fix, register (`ReconcileAttemptUseCase.use-case.ts:55`, `StopAttemptUseCase.use-case.ts:51`, `RegisterWorkOrderUseCase.use-case.ts:95`). `worktreePath` and `baseCommit` from the body on `artifacts` and `fix` are not compared with the attempt's recorded values (`CollectAttemptArtifactsUseCase.use-case.ts:65-71`, `PrepareFixAttemptUseCase.use-case.ts:82-88`).
- Fix: the HTTP boundary strips `nowIso`; collect and fix take the path and base from the record and refuse a differing value.

### S3. ssh host strings are not validated outside the verification adapter

- `WorkspaceAdapter.adapter.ts:127`, `AttemptArtifactAdapter.adapter.ts:83, 158, 171`, `composition.ts:238`: `execFile('ssh', [sshHost, …])` with `sshHost` from `FLEET_WORKTREE_SSH_HOST`. A value beginning with `-` is an ssh option (`-oProxyCommand=…` runs a local command). Station 3a's brief rejects that shape for the verification adapter only.
- Fix: one shared `isSafeSshHost` and `--` before the host in all four places.

### L1. `inspectSession` falls back to the session id as a directory

- `ExecutionRunnerAdapter.adapter.ts:307, 339`: `dir = resolved ?? session.sessionId`. If the attempt lookup fails, `ocm-run --status --dir ses_…` answers "nothing is running" and H2 applies. Refuse instead.

### L2. The acceptance receipt's `exitStatus` on stop is invented

- `ExecutionRunnerAdapter.adapter.ts:352`: `exitStatus: 130` on any successful abort. Record `null` and `stoppedByRequest: true`.

### L3. `SETUP.md` is stale and `README.md` overstates the web app

- `SETUP.md` says to delete itself after the first push and refers to `.github/workflows/ci.yml`, which does not exist (the workflow is `gate.yml`).
- `README.md:26, 84`: "Renders live data from the API when `FLEET_API_URL` is set". No page imports `apps/web/src/lib/api-client.ts`; every view reads `station-fixture.ts`. The footer does say "fixture", so the screen is honest; the README is not.

### L5. Any recipient can close a relay

- `RecordRelayAcknowledgementUseCase.use-case.ts:74-91` never compares the acknowledging `recipientId` with the addressed recipient in `actionScope` (`relay:<recipient>`, set at `SendFleetRelayUseCase.use-case.ts:83`). The workshop rule is "a session he has not told is not bound"; its inverse, "only the told session can answer", is not enforced.

### L4. midnight worktree hygiene

- 50 worktrees under `.worktrees/fleet-v2/`; about 40 are branches merged on 2026-10-13/14 (`api-*`, `apply-*`, `review-*`, `view-*`, `ui-*`), several with uncommitted `.agents/` or `docs/` files and one with a modified tracked file (`view-attempt`). Not a product defect; the orchestrator should prune after the owner's say-so (the rulebook forbids adopting or deleting them otherwise).

## Part 3: the in-flight briefs (contract review, not a lane review)

Read from `.lane/brief.md` in the five station worktrees on midnight. Each is a clean small-steps WORK ORDER with fail-closed contracts. What a reviewer of the resulting PRs should challenge:

- **B1, station 2a (installation).** The schema has no `capacity` (lane caps per runner port, M6 of the migration plan) and no `runner.capabilities` (M8 above). 2b cannot wire what 2a does not load; add both before 2b. `fallbackChain` is loaded but no consumer is planned.
- **B2, station 3a (verification).** Sound. Add that `allowListedCommands` keys are matched exactly against `requiredChecks` names and that the sha is the last argument so a procedure cannot be given extra flags.
- **B3, station 4a (forge evidence).** Sound, and it fixes the Evidence-table blockers. `repos/{owner}/{repo}/commits/{sha}/pulls` also lists the merged PR for a commit; the `state === 'open'` filter handles that. Station 4b must bind it in the **CLI** root too (today only the API binds it).
- **B4, station 6a (signed decisions).** The signed bytes are `{requestId, decisionRevision, grantId, state}`. The head and the action scope live in the request record in `coordination-requests.json`, which the API can write without auth (S1) and any process can rewrite (H4). Sign `{requestId, projectId, actionScope, expectedHeadSha, decisionRevision, grantId, state}` so the owner signs what he approves, not a pointer to it.
- **B5, station 5a (review transport).** The read-only proof is by tool names in the event stream, backed by the server's `reviewer` agent permissions; a `bash` call voids it, which is right. Two notes: the verdict line can be influenced by text in the candidate's own files (the reviewer reads them), which the exactly-one-line rule mitigates but does not remove; and the whole chain still compares the implementer model the operator typed (H1), so 5a's model binding is only as good as H1's fix.

## Part 4: operations

- **O1. Branch protection.** `main` has no protection and no ruleset; the repository is public. `gate.yml` runs on every PR but is required by nothing. The product's merge path (`gh pr merge --match-head-commit --merge`) does not read CI in the CLI root (4b not started). Until the owner's click, a red PR can merge from the product and from `gh`. The cutover plan names this as the owner's action; it should happen before station 4b, not after.
- **O2. Staging** runs the API without `FLEET_STATE_DIR` (every route 501) and the web without `FLEET_API_URL` (fixtures, labelled). The cutover plan's sentence "it runs the API root, so its acceptance blocks on `unknown` today" overstates it: nothing on staging is configured.
- **O3. The runner's environment allow-list** (`ExecutionRunnerAdapter.adapter.ts:98-113`) drops `OPENCODE_SERVER_PASSWORD`; the bundled script reads `~/.config/opencode/server-auth.env` through `HOME` (`bin/ocm-run:52-53`), so a password-protected server works only through that file. Worth a line in the installation README.

## Part 5: what this review did not do

- No lane was reviewed; the five station worktrees have no commits yet beyond their base.
- The domain and application layers were swept by a delegated read; its confirmed findings are folded in above and listed in the appendix. Anything it marked "plausible" was re-read before inclusion.
- No Fable station pass is replaced by this document. Stations 4 to 7 keep their own pre-merge pass.

## Appendix A: application-layer sweep, remaining items

The delegated sweep of the domain and application layers returned 22 items. Seven were re-read and promoted above (H1, H7, M12, M13, M14, M15, L5); three were folded into H2, H3 and S2 (receipts never checked for `authoritative`; a running attempt can be re-dispatched and its `sessionId` overwritten, `DispatchAttemptUseCase.use-case.ts:150-161`; collection trusts the request's base and worktree, `CollectAttemptArtifactsUseCase.use-case.ts:65-71`). The rest, each verified at its line by the sweep and not independently re-read here:

- Structural: no work-execution use case calls its own domain entities or value objects (`Attempt.canCollect`, `matchesCompletionReceipt`, `BriefPackage.create`, `ModelAssignment.create`, …); brief-knowledge builds records by hand. The guards in those classes are documentation. One refactor (construct and mutate through the aggregates) removes about half the list.
- `StopAttemptUseCase.use-case.ts:46-48, 70-78`: no state guard; a stop on a `collected` attempt regresses it to `cancelled` and replaces the authoritative receipt.
- `PrepareBriefPackageUseCase.use-case.ts:176-186` ignores a refused context selection; `:100` compares the reviewer by exact string and ignores `fallbackModel`, so a reviewer equal to the fallback seat becomes the implementer after a fail-over; `policyRevision` is not required although `BriefPackage` requires it.
- `RequestScopedDecisionUseCase.use-case.ts:74-94` re-records an existing request id with empty consumptions; only the repository's revision check stops the re-arm.
- `RecordReviewReceiptUseCase.use-case.ts:68-72` skips the independence check on a blank model string and then throws from the entity.
- `RegisterWorkOrderUseCase.use-case.ts:67-70` checks duplicate ids per project only.
- `ReserveExecutionCapacityUseCase.use-case.ts:66-67, 50` lets one attempt hold two reservations and accepts a non-integer `maxSlots`.
- `CaptureCompletedAttemptNotesUseCase.use-case.ts:22, 67-71` derives entry ids from a process-local counter; after a restart they collide and the repository throws mid-loop.
- `RecordContextSelectionUseCase.use-case.ts:19, 59` fabricates `decisionBecause`; the consumer-side port drops the orchestrator's reason; neither side checks the selected entry is an accepted keeper.
- Dead paths: `BriefKnowledgePort.forwardCompletedAttemptNotes` and `requestBriefContextProposals` have no caller inside the packages, and `CollectAttemptArtifactsDependencies.briefKnowledge` is declared and unused. Notes therefore reach `CaptureCompletedAttemptNotes` only through the composition root's delegate, which the use case never invokes. (Confirmed against `CollectAttemptArtifactsUseCase.use-case.ts:30-115`: the port is in the dependency type and never called. The "lane notes after the lane ends" row in Part 1 is therefore **partial**, not ported.)
- `AssessHeadAcceptanceUseCase.use-case.ts:144-156` adds CI blockers only when a forge port is injected; the CLI root injects none (Evidence table, station 4b).
- Wall-clock fallbacks `new Date().toISOString()` in nearly every use case; `CollectAttemptArtifacts` has no clock injection at all.
