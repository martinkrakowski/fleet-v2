# Plan: the conductor — fleet-v2 runs a lane end to end

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 1, the Opus review of rev 0 applied (two blockers, five majors, two notes; §8). Approved in principle by the owner (2026-10-27: "Agreed and approved. Much of this you should be able to run in parallel."). Decisions in §6 are open with defaults. Nothing built. Anchors checked against `main` at `f04b825`.
- **Owner request (2026-10-27):** "How far away are we from lane orchestrators being implemented?" The answer: the stations exist, the missing design is a **conductor** that moves one lane through them.
- **Builds on:** the 2026-10-23 seat/gate/usage plan (S1, S2), 2026-10-20 auto-merge (AM1–AM5), 2026-10-24 live updates (E3), 2026-10-25 Agensh (C1), 2026-10-26 vacuous-pass (R1, V1, V2) and untrusted-input (U1, U2) plans, and the 2026-10-26 execution order.

## 1. Goal

fleet-v2 runs one lane from frozen brief to merge, or to a precise park, without an orchestrator driving each step by hand. The conductor is a resumable, idempotent state machine over one **lane run**: dispatch → lane end → collect and seal → gate → independent review → fix rounds (at most two) → acceptance → PR → CI → merge, or park at a one-way door for the owner.

**Non-goals.** No new runner, seat, model or provider. No model inference inside the control plane: handover briefs and PR bodies are rendered from records, never written by a model. No change to what a merge requires today. No resumed lane sessions.

## 2. What exists (checked on `main`, 2026-10-27)

| Step | What exists | Anchor | Gap for the conductor |
|---|---|---|---|
| Dispatch | Durable intent before start; brief digest recomputed; refusals keep capacity | `packages/work-execution/src/application/use-cases/DispatchAttemptUseCase.use-case.ts` | Refusal reason is free text (S1 adds `stopReason`) |
| Lane end | Only the server's matching end report ends an attempt | `ReconcileAttemptUseCase.use-case.ts` | Nothing calls it on a schedule |
| Collect, seal | Collection against a completion receipt; `usage` (S3, #154) | `CollectAttemptArtifactsUseCase.use-case.ts` | C1 sealed manifest in flight |
| Gate | Lane diff check port; verification allow-list | `LaneDiffCheckPort.out-port.ts`, `VerificationExecutorAdapter.adapter.ts` | S2 `AcceptanceSpec` not built |
| Review | `RequestIndependentReview`; `OcmReviewTransport` exists | `evidence-and-acceptance/src/infrastructure/adapters/OcmReviewTransport.adapter.ts` | Not wired (`apps/cli/src/composition.ts:869` builds `IndependentReviewAdapter()` with no transport); receipts carry no request id and no review kind; work-execution's `AcceptanceAssessmentPort` has only `assessHeadAcceptance` |
| Fix rounds | Fresh attempt with numbered fixes after the prior ended | `PrepareFixAttemptUseCase.use-case.ts` | Refuses a `cancelled` prior (S1); no handover renderer; `AgyRunnerAdapter` not wired |
| Acceptance | Exact-head assessment; R1 (#211), V1 (#212), A1/A2 (#215, #217) | `AssessHeadAcceptanceUseCase.use-case.ts` | Blockers are text (AM3c) |
| PR, merge | `push-and-open-pr`, `merge-pr`, head-pinned, grant consumed first | `ForgeActionPort.out-port.ts` (kinds at `:13`) | No push to an existing PR; refusals have no kind (AM4b); no policy grant (AM3a, AM4a); no `risk` on work orders (AM2) |
| CI | Evidence reads CI state through its `ForgeEvidencePort` | `ForgeEvidenceAdapter.adapter.ts` | work-execution has no CI read: `AcceptanceEvidencePort.readAcceptance` carries none |
| Owner park | `AskOwnerQuestionUseCase` (one-way questions need a `linkedRequestId`, `:81-83`); attention is read-only | `operator-coordination/src/application/use-cases/` | No idempotency key on questions; attention store (AM3b) |
| Journal | `ActionJournalEntryRecord`: actions `dispatch, reconcile, stop, collect, forge`; append and list per attempt | `packages/work-execution/src/domain/execution-records.ts:205` | No key, no uniqueness check, no per-run listing |
| Wake-ups | In-memory change feed and watcher (E3a-2b, #216) | `apps/api/server/wiring/changes/change-feed.ts` | API process only; `/v1/changes` (E3b) in flight on the shared `/v1` bearer |

Missing: a record spanning a lane's attempts, a keyed journal, the decider, the driver, and the wirings above.

## 3. The shape

### 3.1 Place in the hexagon

The conductor is an **application service in `work-execution`**, not a fifth context. `work-execution` already depends on the other three through consumer-side ports, and every step is one of its own use cases (dispatch, reconcile, collect, fix, forge) or a supplier call it already makes through a consumer-side port. An orchestration context would depend on all four, break `AGENTS.md`'s four contexts, and own no rule of its own. The manifest's dependency direction is unchanged.

- **Domain:** `LaneRun` aggregate (record, states, transition table, guards) and a pure decider `nextAction(run, facts) → Action | Wait | Park`.
- **Application:** `AdvanceLaneRunUseCase`: load the run, gather facts, ask the decider, append a keyed intent, perform **at most one external action**, append its result, save under CAS. Plus `StartLaneRun`, `ResumeLaneRun`, `HaltConductor`.
- **Driver (composition root):** `fleet-v2 conductor run` in `apps/cli` loops over live runs and calls `advance`. It polls with back-off (30 s to 2 min); `/v1/changes` wake-ups are subject to D9. Signals only say a store changed; **lane end is always read from the runner**, CI from the forge.

### 3.2 State, derived first

The run's state is a projection of attempts, the keyed journal, receipts and forge evidence. `LaneRunRecord` stores only what cannot be derived: `workOrderId`, `tier`, `seatPlanRef` and a cursor per role, `round` (0–2), the attempt ids in order, `prNumber`, `parked` (reason, parked-from state, question id), `lease`, `revision`, `runPolicyRevision`.

| State | Enters when | Exits | Guard |
|---|---|---|---|
| `ready` | Work order registered, brief frozen, `AcceptanceSpec` and PR notes (D7) present | `dispatching` | Capacity reserved; kill switch off; admission (§3.6) |
| `dispatching` | Intent appended | `running` / `seat-failed` | Seat allowed; reviewer family differs from every implementer of the run |
| `running` | Session id recorded | `collecting` / `seat-failed` | Server reports end; past `ExecutionLimits` → `StopAttempt` → `seat-failed (timeout)` |
| `seat-failed` | Typed `stopReason` | `dispatching` (next entry) / `parked` | First `SeatPlan` entry whose `on` matches; exhausted → park |
| `collecting` | Ended attempt | `gating`; `seat-failed (no-commit)`; `gating` for `partial` (a commit exists, the gate decides); `parked` on manifest `missing` or `mismatch` | C1 manifest verifies `sealed`; usage read never blocks |
| `gating` | Sealed | `brief-check` / `fixing` / `parked` | S2 predicates; `unknown` is not a pass |
| `brief-check` | Gate passed | `code-review` / `fixing` / `parked` | Brief-check receipt for this head (§3.4) |
| `code-review` | Brief check passed | `accepting` / `fixing` / `parked` | Code-review receipt: numbered findings or the no-defects answer |
| `fixing` | Blockers or majors and rounds left | `dispatching` (second-pass role) | Handover rendered from numbered findings; prior ended or cancelled |
| `accepting` | Code review passed | `awaiting-premerge` (Tier 2) / `opening-pr` or `pushing` / `parked` | `AssessHeadAcceptance` accepted at head |
| `awaiting-premerge` | Tier 2 | `opening-pr` or `pushing` / `fixing` / `parked` | Pre-merge receipt for this head (D3): pass → on; findings and rounds left → `fixing`; else park |
| `opening-pr` | Accepted, no PR yet | `watching-ci` | `push-and-open-pr`; body rendered from the journal |
| `pushing` | Accepted, PR exists (`prNumber`) | `watching-ci` | New kind `push-to-pr`: push the new head to the run's branch, expected-head checked; never a second PR |
| `watching-ci` | Head pushed | `merging` / `fixing` / `parked` | CI read (§3.3): `ci-pending` waits, `ci-failed` → `fixing` if a round is left (D5) |
| `merging` | CI green, eligible (AM A4) | `merged` / `parked` | Policy grant at this head; any one-way door → park |
| `merged` | Forge reports merged at the head | — | terminal |
| `stopped` | The owner or orchestrator ends the run (`conductor stop <runId>`), or the work order is stopped | — | terminal; a running attempt is stopped first through `StopAttempt` |
| `parked` | A guard needs a human | the parked-from state | Answer or action recorded; facts re-read |

**Rounds.** A round is one second-pass dispatch. The first pass is round 0; a failed first gate **uses round 1** (the first fix round), since the second-pass seat is what runs next. After round 2, any blocker, failed gate or failed CI parks. A head change after `accepting` re-enters `gating`.

**Idempotency keys.** Every external action has the key `<runId>/r<round>/<step>/<seatIndex>[@<head12>]`. The intent entry carries the key and any id minted for it (attempt id, review request id, question key) **before** the action runs. The journal's uniqueness check (K1b) refuses a second intent with the same key, so two drivers that both pass a stale lease check cannot both act: the second append fails and that driver drops its step. Leases make collisions rare; the unique key makes them harmless.

### 3.3 Where each step's port lives

| Step | Port (context) | New or changed |
|---|---|---|
| Dispatch, lane end, stop | `DispatchAttemptPort`, `ReconcileAttemptPort`, `StopAttemptPort` | `AgyRunnerAdapter` handed to the selector; edit-only seats get `LaneDiffCheckPort`, then `WorkspacePort.commitLaneOutput` |
| Collect, seal | `CollectAttemptArtifactsPort` + C1 | — |
| Gate | `RequestAttemptAcceptancePort` with S2 | S2 |
| Review | New consumer-side `ReviewRequestPort` (work-execution) → evidence's `RequestIndependentReviewPort` | `kind: brief-check \| code-review \| pre-merge` and a request id on requests and receipts; transports wired |
| Fix | `PrepareFixAttemptPort`, `PrepareBriefPackagePort` | Pure `renderHandoverBrief` |
| Acceptance | `AcceptanceAssessmentPort` | AM3c blocker kinds |
| PR, push, merge | `ExecuteAuthorizedForgeActionPort`; `AutoMergeAttemptUseCase` (AM4a) | `push-to-pr` kind; pure `renderPrBody` |
| CI | New consumer-side `CiStatePort` (work-execution) → evidence's forge evidence, through a new evidence in-port `InspectHeadCiState` | Returns `pending \| passed \| failed \| unknown` per head |
| Park | `OwnerDecisionPort`; consumer ports to `AskOwnerQuestion` (with an idempotency key) and the attention store (AM3b) | One-way parks first record the scoped request that the question's `linkedRequestId` names |
| Seats | S1 `SeatPlan`; rotation cursor (D8) | — |
| Telemetry | Keyed journal, `ExecutionObservationPort`, `UsagePort` | Actions gain `gate`, `review`, `fix`, `ci`, `push`, `park`, `conduct` |

### 3.4 Reviews and R1

R1 keeps the latest receipt per reviewer model, and only that reviewer's later pass answers its fail. Two changes keep that rule sound under the conductor:
- **Selection per (reviewer, kind).** Receipts carry `kind`; R1's latest-receipt and dissent rules apply per (reviewer, kind), so a later code-review pass never hides a brief-check fail from the same model. Receipts without `kind` read as `code-review` (today's meaning). This amends the R1 plan (D10).
- **A seat switch never answers a dissent.** "Re-run once, then the next seat" applies only to a review that **produced no receipt** (empty, one-line, tried to act, transport down): no receipt was recorded, so nothing is outvoted. A recorded `fail` is answered only by the same seat passing on a later head (after a fix round) or the same head (D10 default: the same seat re-runs on a new head; if that seat is unavailable, park).

### 3.5 Crash and resume

On start and on every `advance`, the decider reads the run's last keyed entry (per-run listing, K1b):
- **Result present:** derive the next state.
- **Intent without result: reconcile, never repeat.** Dispatch: inspect the runner by worktree (L6). PR or push: read the forge for the branch's PR and head. Merge: PR state at the head (AM A13). Owner question: look it up by its idempotency key. Review: a receipt with the request id counts; without one, the review may run again under the same key's retry entry, once.
- **Ambiguous:** park with `ambiguous <action>` until reconcile settles it.

One-way actions (dispatch, push, PR, merge, an owner question) are never issued twice for one key.

### 3.6 Parking, concurrency, failure

- **Parking.** One attention item keyed by (project, work order, reason); where the owner must choose, one keyed owner question naming ids and kinds only. Reasons: `one-way-door`, `seat-plan-exhausted`, `blocker-after-round-2`, `ambiguous`, `artifacts-unsealed`, `cost-ceiling` (`policy.perLaneCostCeiling`), `ci-failed-no-rounds`, `branch-behind`, `review-seat-unavailable`, `halted`. Tier 2 waits in `awaiting-premerge`, not in `parked`. `conductor resume <runId>`, or the owner's answer, returns the run to the parked-from state.
- **Leases.** One per run, one per state directory for the driver, both taken by CAS with a fencing revision; the run record's saves check it, and journal intents are protected by the unique key (§3.2).
- **Admission.** Host capacity through `ReserveExecutionCapacity` and the host-wide gate budget; one active run per package; a global cap from configuration.
- **Merge train.** One run in `merging` per target repository; a branch behind its base parks as `branch-behind` (D6).
- **Failure.** Unknown is never pass. A seat failure moves to the next `SeatPlan` entry in a fresh attempt; a refused model is not retried before its reset. The reviewer's family never matches any implementer of the run.

### 3.7 Kill switch and dry-run

- **Kill switch:** `conductor halt` writes a halt marker in the state directory; `advance` checks it before any external action and parks with `halted`. Halt never stops a running lane. `policy.conductor.enabled` (absent = off) gates the driver.
- **Dry-run:** recording fakes for every acting outbound port; each step journals `would <action>`. **Shadow mode:** the conductor follows a hand-run lane and records what it would have done (D4).

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. **Parallel** means three things together: different packages, **no shared file** (notably `apps/cli/src/composition.ts`, `apps/api` wiring and `.architecture/manifest.yaml`), and room in the host-wide gate budget. The owner lifted the two-lane stability cap on 2026-10-27. Within a group, lanes marked **→** run in sequence. Manifest edits are small; lanes that add to it merge one at a time, rebased.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| K0 | This plan, decisions, manifest text | docs | 0 | — |
| **Group 1, parallel now** | | | | |
| K1 | `LaneRun` record, transition table, guards, keys, pure `nextAction`; one test per row of §3.2 | work-execution (domain) | 2 | K0 |
| AM1 → K2 | `policy.autoMerge`; then `policy.conductor` | installation | 2 | V2b out of installation |
| AM3a | Policy grants | operator-coordination | 2 | — |
| RW1 | Review `kind` and request id on requests and receipts; R1 selection per (reviewer, kind); `InspectHeadCiState` in-port | evidence-and-acceptance (no app wiring) | 2 | D10; V2 is out of evidence |
| **Group 2, parallel after Group 1** | | | | |
| K1b | Keyed journal: `key`, intent/result pairing, uniqueness check, per-run listing; file and memory stores | work-execution (domain, infra) | 2 | K1 |
| AM3b → Q1 | Attention store; then an idempotency key on `AskOwnerQuestion` | operator-coordination | 2 | AM3a |
| RW2 | Wire `OcmReviewTransport` and the local review-CLI transport | evidence (infra), **`apps/cli/src/composition.ts`** | 2 | RW1 |
| **Group 3, one at a time on `composition.ts` and work-execution** | | | | |
| AM2 | `risk` on work orders, absent = `high`; `--risk` | work-execution, apps/cli | 2 | — |
| S1a → S1b | `SeatPlan`, `stopReason`, `seatUsed`; refusal-to-fix | work-execution | 2 | K1b |
| AM3c | Structured blockers | evidence, work-execution port, **`composition.ts`, `apps/api`** | 2 | RW2 |
| AG | Wire `AgyRunnerAdapter`; edit-only commit step | work-execution (infra), **`composition.ts`** | 2 | AM3c |
| AM4b | Forge refusal kinds, PR-state read, `push-to-pr` kind | work-execution (infra) | 2 | — |
| PC | `ReviewRequestPort`, `CiStatePort` and their adapters | work-execution, **`composition.ts`** | 2 | RW2, AG |
| **Sequential** | | | | |
| S2a → S2b | `AcceptanceSpec`; acceptance runs it | work-execution, evidence | 2 | S1b, AM3c |
| K3 | `LaneRunRepositoryPort`, run and driver leases | work-execution | 2 | K1b |
| K4 | Dispatch to gate, seat pivots, crash-resume tests | work-execution | 2 | K3, S2b, C1, AG |
| K5 | Review and fix rounds, `renderHandoverBrief`, §3.4 | work-execution | 2 | K4, PC |
| AM4a → AM5 | `AutoMergeAttemptUseCase`; CLI | work-execution, apps/cli | 2 | AM1, AM2, AM3a–c, AM4b |
| K6 | Acceptance, pre-merge wait, PR, push, CI, merge, parks | work-execution | 2 | K5, AM4a, Q1 |
| K7 | `conductor run\|halt\|resume\|stop\|status`, polling, dry-run fakes | apps/cli | 2 | K4 |
| K8 | Shadow replay of recorded journals | apps/cli, tests | 1 | K7 |
| K9 | `/v1/changes` wake-ups as D9 allows | apps/cli | 1 | K7, E3b |

Group 3's work-execution lanes can each run beside a Group 2 lane in another package; inside Group 3, AM2, S1a and AM4b may overlap only if their files are disjoint, which each brief must state. C1 and U1/U2 are in flight: prerequisites, not new lanes.

## 5. Hard to undo

- **Merges made by the conductor** are one-way. They need `policy.autoMerge` on, an eligible lane, and live mode (D4); each merge's journal entry names the policy revision that authorised it.
- **PRs it opens or pushes to** are visible to anyone who can see the target repository; bodies are rendered from records, never lane output.
- **The `LaneRunRecord` format, journal keys and the review `kind`** become stored data; version them from their first commit.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Application service in `work-execution`, or a fifth context? | `work-execution` (§3.1) |
| D2 | Where does the driver run? | A CLI process on the orchestrator's machine, not the API process |
| D3 | Who runs the Tier 2 pre-merge pass? | The orchestrator: the run waits in `awaiting-premerge` until that receipt is recorded for the head |
| D4 | Rollout | Dry-run, shadow for five lanes, live up to the PR, merges for Tier 1, then Tier 2 |
| D5 | A CI failure | A fix round if one is left, else park |
| D6 | A branch behind its base at merge | Park; no branch updates by the conductor in v1 |
| D7 | PR "Hard to undo", "Assumptions", "Challenge this" | Frozen in the brief package; a conducted run refuses a brief without them |
| D8 | Rotation state | One cursor per (project, role), advanced when a dispatch is recorded |
| D9 | May the driver read `/v1/changes` (shared `/v1` bearer until T3a's `read` scope) in the process that holds forge credentials? | **No:** until T3a, a separate reader process wakes the driver, or the driver polls |
| D10 | Amend R1: selection per (reviewer, kind), and a seat switch never answers a recorded fail | **Yes**, with the same seat re-running on the next head; seat unavailable → park |

## 7. Assumptions

- The lane server's end report stays authoritative and reachable by worktree; if not, runs park as `ambiguous`.
- Review CLIs end with a parseable verdict line; a changed format reads as `unknown`, which holds the run.
- `gh pr merge --match-head-commit` keeps refusing a moved head.
- One state directory per installation, one driver over it.
- S1, S2 and AM are built as planned; if one slips, the conductor parks at that step instead of guessing.

## 8. Review

**Opus, rev 0 (2026-10-27).** Applied: keyed journal, request ids and question keys in K1b, RW1, Q1, with intents fenced by the unique key (blocker); review `kind` and per-(reviewer, kind) R1 selection, no seat switch on a recorded fail, D10 (blocker); `ReviewRequestPort` and `CiStatePort` in PC; `push-to-pr`, exits from `collecting` and `awaiting-premerge`, `stopped` defined, D3 unified, rounds defined; groups re-cut by shared files; AM2 added; the lifted two-lane cap; D9.

## Challenge this

Whether `LaneRunRecord` should exist at all. With a keyed journal, nearly all of the run's state can be derived, and a second record risks disagreeing with it. The plan keeps a minimal record because the seat cursors, the park and the lease cannot be derived safely. A reviewer should test whether putting those in keyed journal entries keeps crash-resume and fencing correct with one store fewer.
