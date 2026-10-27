# Plan: the conductor — fleet-v2 runs a lane end to end

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** draft; approved in principle by the owner (2026-10-27: "Agreed and approved. Much of this you should be able to run in parallel."). Decisions in §6 are open with defaults. Nothing built. Anchors checked against `main` at `f04b825`.
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
| Collect, seal | Collection against a completion receipt; `usage` (S3, #154) | `CollectAttemptArtifactsUseCase.use-case.ts`, `OpencodeDbUsageAdapter.adapter.ts` | C1 sealed manifest in flight |
| Gate | Lane diff check port; verification allow-list | `LaneDiffCheckPort.out-port.ts`, `evidence-and-acceptance/.../VerificationExecutorAdapter.adapter.ts` | S2 `AcceptanceSpec` not built; V2 in flight |
| Review | `RequestIndependentReview`; `OcmReviewTransport` exists | `evidence-and-acceptance/src/infrastructure/adapters/OcmReviewTransport.adapter.ts` | Not wired: both roots construct `IndependentReviewAdapter()` with no transport (`apps/cli/src/composition.ts:869`) |
| Fix rounds | Fresh attempt with numbered fixes after the prior ended | `PrepareFixAttemptUseCase.use-case.ts` | Refuses a `cancelled` prior (S1); no handover renderer; `AgyRunnerAdapter` not wired (`RunnerSelectorAdapter` refuses `agy`) |
| Acceptance | Exact-head assessment; R1 dissent (#211), V1 (#212), A1/A2 (#215, #217) | `AssessHeadAcceptanceUseCase.use-case.ts`, `RequestAttemptAcceptanceUseCase.use-case.ts` | Blockers are text (AM3c) |
| PR, merge | `push-and-open-pr`, `merge-pr`, head-pinned, grant consumed before the forge runs | `ExecuteAuthorizedForgeActionUseCase.use-case.ts`, `ForgeActionAdapter.adapter.ts` | Refusals have no kind (AM4b); no policy grant (AM3a, AM4a) |
| CI | Forge evidence reads CI state and threads | `ForgeEvidenceAdapter.adapter.ts` | Pending and failed indistinguishable (AM3c) |
| Owner park | `AskOwnerQuestionUseCase`; attention is read-only | `operator-coordination/src/application/use-cases/` | Attention store (AM3b) |
| Wake-ups | In-memory change feed and watcher (E3a-2b, #216) | `apps/api/server/wiring/changes/change-feed.ts` | In the API process only; `/v1/changes` (E3b) in flight |
| Records | `AttemptRecord` with CAS revision; journal actions `dispatch, reconcile, stop, collect, forge` | `packages/work-execution/src/domain/execution-records.ts` | No record spans attempts of one lane |

Missing: a record spanning a lane's attempts, the decider, the driver, and four wirings (review transport, agy runner, policy grants, structured blockers).

## 3. The shape

### 3.1 Place in the hexagon

The conductor is an **application service in `work-execution`**, not a fifth context. `work-execution` already depends on the other three through consumer-side ports, and every step is one of its own use cases (dispatch, reconcile, collect, fix, forge) or a supplier call it already makes (review through `AcceptanceAssessmentPort` → `RequestIndependentReviewPort`; doors through `OwnerDecisionPort`). An orchestration context would depend on all four, break `AGENTS.md`'s four contexts, and own no rule of its own. The manifest's dependency direction is unchanged.

Three parts:
- **Domain:** `LaneRun` aggregate (record, states, transition table, guards) and a pure decider `nextAction(run, facts) → Action | Wait | Park`.
- **Application:** `AdvanceLaneRunUseCase`: load the run, gather facts, ask the decider, journal intent, perform **at most one external action**, record the outcome, save under CAS. Plus `StartLaneRun`, `ResumeLaneRun`, `HaltConductor`.
- **Driver (composition root):** `fleet-v2 conductor run` in `apps/cli` loops over live runs and calls `advance`. Wake-ups: `/v1/changes` (E3b) when configured, else polling with back-off (30 s to 2 min). Signals only say a store changed; **lane end is always read from the runner**, CI from the forge.

### 3.2 State, derived first

The run's state is a projection of records that already exist (attempts, journal, receipts, forge evidence). `LaneRunRecord` stores only what cannot be derived: `workOrderId`, `tier`, `seatPlanRef` and a cursor per role, `round` (0–2), the attempt ids in order, `parked` (reason, question id), `lease`, `revision`, and the `runPolicyRevision` it started under.

| State | Enters when | Next | Guard |
|---|---|---|---|
| `ready` | Work order registered, brief frozen, `AcceptanceSpec` present | `dispatching` | Capacity reserved; kill switch off; per-package limit free |
| `dispatching` | Intent journalled | `running` / `seat-failed` | Seat allowed (`AllowedSeatPort`); reviewer family differs from every implementer of the run so far |
| `running` | Session id recorded | `collecting` | Server reports end (reconcile); past `ExecutionLimits` → `StopAttempt` → `seat-failed (timeout)` |
| `seat-failed` | Typed `stopReason` | `dispatching` (next seat entry) / `parked` | First `SeatPlan` entry whose `on` matches; plan exhausted → park |
| `collecting` | Ended attempt | `gating` | C1 manifest verifies `sealed`; usage read (failure does not block) |
| `gating` | Sealed | `brief-check` / `fixing` / `parked` | S2 predicates; any `unknown` is not a pass. First pass fails → second pass (no repeat of the first-pass seat) |
| `brief-check` | Gate passed | `code-review` / `fixing` | Diff-against-brief review receipt for this head |
| `code-review` | Brief check passed | `accepting` / `fixing` | Numbered findings or the literal no-defects answer; empty or one-line = failed review |
| `fixing` | Blockers or majors, `round < 2` | `dispatching` (second-pass role) | Handover rendered from numbered findings; prior attempt ended or cancelled |
| `accepting` | Review passed | `awaiting-premerge` (Tier 2) / `opening-pr` / `parked` | `AssessHeadAcceptance` accepted at head (R1, V1/V2, A1/A2) |
| `awaiting-premerge` | Tier 2 | `opening-pr` | A pre-merge receipt for this head from a seat that wrote none of the code (D3) |
| `opening-pr` | Accepted | `watching-ci` | `push-and-open-pr` with the PR body rendered from the journal |
| `watching-ci` | PR open | `merging` / `fixing` / `parked` | Structured blockers: `ci-pending` waits, `ci-failed` is a fix round if one is left (D5) |
| `merging` | CI green, eligible (AM A4) | `merged` / `parked` | Policy grant at this head; any one-way door → park |
| `merged`, `stopped` | terminal | — | — |
| `parked` | Any guard that needs a human | the state it parked from | Owner answer or orchestrator action recorded; facts re-read before continuing |

A head change after `accepting` sends the run back to `gating`: old readiness is invalid by the existing rule.

**Idempotency keys.** Every external action has the key `<runId>/r<round>/<step>/<seatIndex>[@<head12>]`. The intent entry carries the key and any id minted for it (the attempt id, the review request id) **before** the action runs. A second intent with the same key is refused by the journal.

### 3.3 Where each step's port lives

| Step | Port (context) | New or changed |
|---|---|---|
| Dispatch, lane end, stop | `DispatchAttemptPort`, `ReconcileAttemptPort`, `StopAttemptPort` (work-execution) | `RunnerSelector` hands over `AgyRunnerAdapter`; edit-only seats get a commit step: `LaneDiffCheckPort`, then `WorkspacePort.commitLaneOutput` |
| Collect, seal | `CollectAttemptArtifactsPort` + C1 | — |
| Gate | `RequestAttemptAcceptancePort` with S2 `AcceptanceSpec` | S2 |
| Review | `AcceptanceAssessmentPort` → `RequestIndependentReviewPort` (evidence) | Review `kind: brief-check \| code-review \| pre-merge`; transports wired: the served reviewer (`OcmReviewTransport`) and a local review CLI transport, chosen by the installation's seat catalogue |
| Fix | `PrepareFixAttemptPort`, `PrepareBriefPackagePort` | Pure `renderHandoverBrief(findings, prior)` in the domain |
| Acceptance | `AcceptanceAssessmentPort` | AM3c blocker kinds |
| PR, merge | `ExecuteAuthorizedForgeActionPort`; `AutoMergeAttemptUseCase` (AM4a) | Pure `renderPrBody(journal, brief)` |
| CI | `AcceptanceEvidencePort` → forge evidence | AM3c |
| Park | `OwnerDecisionPort`, a new consumer port to `AskOwnerQuestion` and the attention store (AM3b) | — |
| Seats | S1 `SeatPlan`; the rotation cursor | Round-robin pairs as installation data (first pass, second pass, review), one pre-merge pass on Tier 2 |
| Telemetry | `ExecutionJournalPort`, `ExecutionObservationPort`, `UsagePort` | Journal actions gain `gate`, `review`, `fix`, `ci`, `park`, `conduct` |

### 3.4 Crash and resume

On start, and on every `advance`, the decider reads the last journal entry for the run:
- **Completed:** derive the next state.
- **Intent without completion:** **reconcile, never repeat.** Dispatch: inspect the runner by worktree directory (exists, L6). PR: read the forge for an open PR on the branch. Merge: read the PR state at the head (AM A13). Owner question: find it by its idempotency key. Review: a receipt for the request id counts; without one, the review may run again once, since R1 records a receipt and its request in one call. Gate predicates and reads are pure re-runs.
- **Ambiguous:** the run parks with `ambiguous <action>` until reconcile settles it. No timer turns ambiguous into anything.

One-way actions (dispatch, push and PR, merge, an owner question) are never issued twice for one key.

### 3.5 Parking for the owner

A park writes one attention item keyed by (project, work order, reason) and, where the owner must choose, one owner question naming ids and kinds only, never lane output. Park reasons: `one-way-door`, `seat-plan-exhausted`, `blocker-after-round-2`, `ambiguous`, `cost-ceiling` (`policy.perLaneCostCeiling`), `ci-failed-no-rounds`, `branch-behind`, `premerge-wanted`, `halted`. `fleet-v2 conductor resume <runId>` (or the owner's answer, seen through a change signal) moves the run back to the parked-from state, which re-reads every fact before acting.

### 3.6 Concurrency

- **One conductor per run:** a lease on the `LaneRunRecord` (holder id, expiry, fencing revision) taken by CAS. Every save carries the fencing revision; a stale holder's write is refused by the existing revision check.
- **One driver per state directory:** a driver lease, matching the journal's "one designated dispatcher per host" contract.
- **Admission:** host capacity through `ReserveExecutionCapacity`; at most one active run per package by default (the execution order's "never two in `evidence-and-acceptance`" rule, generalised from the brief's owned paths); a global cap from installation configuration.
- **Merge train per target repository:** one run in `merging` at a time. A branch behind its base parks as `branch-behind` (D6); any update is a new head and re-enters `gating`.

### 3.7 Failure semantics

- Unknown is never pass: an unreadable runner, receipt, CI state or setting holds the run where it is.
- A seat failure (`rate-limited`, `payment`, `timeout`, `model-missing`, `no-commit`, `length`, `step-cap`) moves to the next `SeatPlan` entry in a fresh attempt; a refused model is not retried before its reset. A first-pass gate failure goes to the second-pass role, never a second first-pass round.
- An empty or one-line review, or one that tried to act, is a failed review: re-run once, then the next review seat. The reviewer's family never matches any implementer of the run.
- After round 2, any blocker parks the run.

### 3.8 Kill switch and dry-run

- **Kill switch:** `fleet-v2 conductor halt` writes a halt marker in the state directory; every `advance` checks it before any external action and parks with `halted`. Halt never stops a running lane; `attempt stop` stays separate. `policy.conductor.enabled` (absent = off) gates the driver.
- **Dry-run:** the same decider and use case with recording fakes for every outbound port that acts; each step journals `would <action>` and the run advances on recorded facts. **Shadow mode:** the conductor follows a lane the orchestrator runs by hand and records what it would have done; differences are the rollout evidence (D4).

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. **Parallel** means different packages; the number running at once is set by the host-wide gate budget (the owner lifted the two-lane stability cap on 2026-10-27). Lanes in the same package merge one at a time, rebased.

| Lane | Scope | Package | Tier | After |
|---|---|---|---|---|
| K0 | This plan, decisions, manifest text for `LaneRun` | docs | 0 | — |
| **Group 1: parallel now** | | | | |
| K1 | `LaneRun` record, states, transition table, guards, idempotency key, pure `nextAction`; table tests per row of §3.2 | work-execution (domain) | 2 | K0 |
| AM1 → K2 | `policy.autoMerge`; then `policy.conductor` (`enabled`, `mode`, caps) | installation | 2 | — |
| AM3a → AM3b | Policy grants; attention store | operator-coordination | 2 | — |
| RW | Wire `OcmReviewTransport`; review `kind`; local review CLI transport | evidence-and-acceptance, apps/cli | 2 | U1/U2 merged |
| **Group 2: after Group 1, parallel across packages** | | | | |
| S1a → S1b | `SeatPlan`, `stopReason`, `seatUsed`; refusal-to-fix transition | work-execution | 2 | K1 merged (same package) |
| AM3c | Structured blockers | evidence-and-acceptance, work-execution port | 2 | RW, V2 merged |
| AG | Wire `AgyRunnerAdapter`; edit-only commit step | work-execution (infra), apps/cli | 2 | — |
| AM4b | Forge refusal kinds, PR-state read | work-execution (infra) | 2 | — |
| **Sequential** | | | | |
| S2a → S2b | `AcceptanceSpec`; acceptance runs it | work-execution, evidence | 2 | S1b, AM3c |
| K3 | `LaneRunRepositoryPort`, file store, run and driver leases | work-execution | 2 | K1 |
| K4 | `AdvanceLaneRun` steps: dispatch to gate, seat pivots, crash-resume tests | work-execution | 2 | K3, S2b, C1, AG |
| K5 | Review and fix rounds; `renderHandoverBrief`; reviewer ≠ any implementer | work-execution | 2 | K4, RW |
| AM4a → AM5 | `AutoMergeAttemptUseCase`; CLI | work-execution, apps/cli | 2 | AM1, AM3a–c, AM4b |
| K6 | Acceptance, `renderPrBody`, CI watch, merge, parks | work-execution | 2 | K5, AM4a |
| K7 | `conductor run\|halt\|resume\|status`, polling, dry-run fakes | apps/cli | 2 | K4 (grows with K5, K6) |
| K8 | Shadow mode: replay recorded journals and compare | apps/cli, tests | 1 | K7 |
| K9 | `/v1/changes` wake-ups in the driver | apps/cli | 1 | K7, E3b |

C1, U1/U2 and V2 are in flight: prerequisites, not new lanes.

## 5. Hard to undo

- **Merges made by the conductor** are one-way. They need `policy.autoMerge` on, an eligible lane, and live mode (D4); every merge's journal entry names the policy revision that authorised it.
- **PRs it opens** are visible to anyone who can see the target repository; the body is rendered from records, never lane output.
- **The `LaneRunRecord` format and the new journal action kinds** become stored data; version the record from its first commit.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Application service in `work-execution`, or a fifth context? | `work-execution` (§3.1) |
| D2 | Where does the driver run? | A CLI process on the orchestrator's machine, where the local review CLI and forge credentials already are; not the API process, so no HTTP-reachable process gains merge power |
| D3 | Who runs the Tier 2 pre-merge pass? | The orchestrator: the run parks at `premerge-wanted` and resumes when that receipt is recorded for the head |
| D4 | Rollout | Dry-run, then shadow for five lanes, then live up to `opening-pr`, then merges for Tier 1, then Tier 2 |
| D5 | A CI failure | A fix round if one is left, else park |
| D6 | A branch behind its base at merge | Park; the conductor never updates a branch itself in v1 |
| D7 | PR "Hard to undo", "Assumptions", "Challenge this" | Written into the frozen brief package at preparation; a brief without them is refused for a conducted run |
| D8 | Rotation state | One cursor per (project, role), advanced when a dispatch is recorded, so pairs alternate across lanes and not within one |

## 7. Assumptions

- The lane server's end report stays authoritative and reachable by worktree; if not, runs park as `ambiguous`, never guess.
- Review CLIs end with a parseable verdict line; a change in format reads as `unknown`, which holds the run.
- `gh pr merge --match-head-commit` keeps refusing a moved head.
- One state directory per installation, and one driver over it.
- S1, S2 and AM are built as planned; if one slips, the conductor parks at that step instead of guessing.

## Challenge this

Whether `LaneRunRecord` should exist at all. Nearly all of the run's state can be derived from attempts, the journal and receipts, and a second record risks disagreeing with them. The plan keeps a minimal record because the round count, seat cursors, parks and the lease cannot be derived safely. The cheaper design would put those in journal entries and keep the conductor stateless. A reviewer should test whether that alternative keeps crash-resume and lease fencing correct.
