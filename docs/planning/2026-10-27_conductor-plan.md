# Plan: the conductor — fleet-v2 runs a lane end to end

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 1, the Opus review of rev 0 applied (two blockers, five majors, two notes; §8). Approved in principle by the owner (2026-10-27: "Agreed and approved. Much of this you should be able to run in parallel."). Decisions in §6 are open with defaults. Nothing built. Anchors checked against `main` at `f04b825`. Amended 2026-10-27 by the web UI interactivity plan, lane UI-B (§3.8): how a stop ends a run, the park reason `stop-unconfirmed`, and the `run-stopped` refusal in `ResumeLaneRun`. Amended 2026-10-27 by K-GC (§3.9), rev 2 after Grok 4.7's review (one blocker, six majors, three minors): a graceful and a forced run stop, the record-only cancel of an undispatched attempt, and the reaper; D11, D13, D14 and D15 decided by the owner, D12 and D16 recommended defaults still open (§6).
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
| `stopped` | The owner or orchestrator ends the run (`conductor stop <runId>`), or the work order is stopped | — | terminal; reachable from every non-terminal state; a running attempt is stopped first through `StopAttempt` (**amended by K-GC, §3.9:** that is the forced stop; a graceful stop, the default, lets the attempt finish and drains it first) |
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
- **Intent without result: reconcile, never repeat.** Dispatch: inspect the runner by worktree (L6). PR or push: read the forge for the branch's PR and head. Merge: PR state at the head (AM A13). Owner question: look it up by its idempotency key. Review: a receipt with the request id counts; without one, the review may run again once, under its own retry key (`…/review/<seat>@<head>/retry1`), since K1b refuses a second intent with the original key.
- **Ambiguous:** park with `ambiguous <action>` until reconcile settles it.

One-way actions (dispatch, push, PR, merge, an owner question) are never issued twice for one key.

### 3.6 Parking, concurrency, failure

- **Parking.** One attention item keyed by (project, work order, reason); where the owner must choose, one keyed owner question naming ids and kinds only. Reasons: `one-way-door`, `seat-plan-exhausted`, `blocker-after-round-2`, `ambiguous`, `artifacts-unsealed`, `cost-ceiling` (`policy.perLaneCostCeiling`), `ci-failed-no-rounds`, `branch-behind`, `review-seat-unavailable`, `halted`, and `stop-unconfirmed` (amendment UI-B, §3.8). Tier 2 waits in `awaiting-premerge`, not in `parked`. `conductor resume <runId>`, or the owner's answer, returns the run to the parked-from state.
- **Attention without a park (amendment K-GC, §3.9).** `stop-grace-exceeded` and the reaper's finding kinds raise attention items but are not park reasons. A graceful drain is not a park.
- **Leases.** One per run, one per state directory for the driver, both taken by CAS with a fencing revision; the run record's saves check it, and journal intents are protected by the unique key (§3.2).
- **Admission.** Host capacity through `ReserveExecutionCapacity` and the host-wide gate budget; one active run per package; a global cap from configuration.
- **Merge train.** One run in `merging` per target repository; a branch behind its base parks as `branch-behind` (D6).
- **Failure.** Unknown is never pass. A seat failure moves to the next `SeatPlan` entry in a fresh attempt; a refused model is not retried before its reset. The reviewer's family never matches any implementer of the run.

### 3.7 Kill switch and dry-run

- **Kill switch:** `conductor halt` writes a halt marker in the state directory; `advance` checks it before any external action and parks with `halted`. Halt never stops a running lane. `policy.conductor.enabled` (absent = off) gates the driver.
- **Dry-run:** recording fakes for every acting outbound port; each step journals `would <action>`. **Shadow mode:** the conductor follows a hand-run lane and records what it would have done (D4).

### 3.8 Amendment UI-B: stopping and resuming a run

Amended 2026-10-27 by the web UI interactivity plan, lane UI-B (`2026-10-27_web-ui-interactivity-plan.md`, §3.3, §3.4, §6). The text above is unchanged; this section adds to it.

**Amended by K-GC (§3.9):** this paragraph and the outcome table below describe the **forced** stop, keyed `<runId>/stop-force@web` (or `@cli`). `<runId>/stop@web` now names the graceful stop, which calls no `StopAttempt` because of the stop (§3.9.1). Where this section says `<runId>/stop@web` below, read `<runId>/stop-force@web`.

**A stop is a record the driver obeys.** A stop from the web is a keyed run-journal entry `<runId>/stop@web` carrying the run's `expectedRevision`. It is written only if that revision matches the run's current one; a stale revision is refused, and the web re-reads before asking again. K1b's uniqueness check refuses a second entry with the same key. The driver reads the entry on its next `advance` and stops the run's running attempt itself through `StopAttempt` (§3.2). Nothing outside the driver calls `StopAttempt` for an attempt that belongs to a run; the direct attempt stop refuses such an attempt with a pointer to the run. A run with no running attempt ends as `stopped` without calling `StopAttempt`.

**How `StopAttempt`'s outcome maps.** The same mapping applies to `conductor stop <runId>` (amended by K-GC: `conductor stop <runId> --force`; the table is the forced stop's only):

| `StopAttempt` outcome | Run | Capacity |
|---|---|---|
| `terminated`, `capacityReleased: true` | `stopped` | released |
| `cancelled` (never started) | `stopped` | released by the cancel |
| `terminated`, `capacityReleased: false` | `stopped` | slot stays held; one attention item names it; a reconcile releases it |
| `still-running` or `unknown` | parked, reason `stop-unconfirmed`; the driver retries the stop and reconciles | held |
| `refused` | parked, its reason carrying the refusal's typed reason | held |

A run never shows `stopped` while its attempt may still be running, and a slot is never reported as released unless the result confirmed it. A `stop-unconfirmed` park ends as `stopped` once a retried stop or a reconcile confirms that the attempt ended.

**`stop-unconfirmed` is a park reason, not a state.** It joins the reasons in §3.6. Its attention item names the run and the attempt; no owner question is asked, since nothing needs a choice.

**`ResumeLaneRun` refuses two cases server-side**, each with a typed reason and its own test:
- a run parked with `parked.reason === 'one-way-door'`: the owner's signed decision on the keyed question answers it, never a resume;
- a `stopped` run: refused with `run-stopped`; a stopped run cannot be resumed.
- a `stop-unconfirmed` park: refused with `stop-pending`; a requested stop always wins over a resume. The driver keeps retrying and reconciling the stop; only a confirmed stop (`stopped`) or an operator reconcile that finds the attempt gone ends the park.

A resume carries the run's `expectedRevision` and is journalled under `<runId>/park/<n>/resume@web` when it comes from the web (through the request channel), so K1b refuses a repeat.

**Keys outside the step pattern.** K1b's keys include `<runId>/stop@web` (amended by K-GC: with `<runId>/stop-force@web` and the `@cli` forms, §3.9.1), `<runId>/park/<n>/resume@web` and the request channel's `request/<requestId>` beside the step keys of §3.2; the uniqueness check covers them all.

### 3.9 Amendment K-GC: graceful and forced stops, and the reaper

Amended 2026-10-27 at the owner's request (K-GC). The text above is unchanged; this section adds to it. Where it narrows an earlier rule, it says so.

#### 3.9.1 Two stop modes

Today `conductor halt` is global and never stops a running lane (§3.7), and the run stop of §3.8 is immediate: the driver calls `StopAttempt` on its next `advance`. K-GC adds a per-run **graceful** stop and names §3.8's behaviour the **forced** stop.

| Mode | Command, web control | Key | What the driver does |
|---|---|---|---|
| `graceful` (default, D11) | `conductor stop <runId>`; web "Stop" | `<runId>/stop@cli`, `<runId>/stop@web` | Issues no new external action for the run except the drain steps below. The running attempt may finish. Its result is collected and gated, so the work on the branch is kept and recorded. Then the run ends `stopped` instead of advancing. |
| `force` | `conductor stop <runId> --force`; web "Stop now" | `<runId>/stop-force@cli`, `<runId>/stop-force@web` | §3.8 unchanged: `StopAttempt` now; §3.8's outcome table applies. |

**The mode is read from the key.** A stop entry also carries `mode`, and K1b refuses an entry whose `mode` does not match its key. D11 decides only which key the bare command and the web's first button write. §3.8's `<runId>/stop@web` therefore names a graceful stop from this amendment on. Nothing has been stored under it yet (K1b is not built), so this is still a two-way door; it becomes stored data with K1b (§5).

**Escalation goes one way, and one stop per mode.** A force may follow a graceful stop; a graceful stop never follows a force. The force is its own key because K1b refuses a repeat key. While both are recorded, force wins: the decider reads the stronger mode. K1b also checks each stop entry against the stops the run already has, whatever the channel: an entry no stronger than the strongest recorded one is refused, `stop-already-requested` for the same mode (a graceful `stop@cli` after a graceful `stop@web` is refused like a repeat key, not appended as a second request) and `stop-already-forced` for a graceful after a force. The routes and the CLI show the typed reason. The CLI exits 0 on `stop-already-requested`, since the record already says what was asked, and 1 on `stop-already-forced`.

**Reconcile before any stop ends a run.** §3.5 comes first in both modes. An intent without a result is reconciled, read-only, before a stop rule runs (the decider's G3a precedes every stop rule). If the reconcile is ambiguous, the run parks `ambiguous` with its step. A stop never ends a run `stopped` while one of its one-way intents (dispatch, PR, push, merge, owner question) is unreconciled. If the reconcile finds the merge landed, the run ends `merged`, not `stopped`: the stop came too late, and the journal keeps the stop entry as overtaken. A policy grant that an intent consumed (forge actions consume their grant first, AM3a) stays consumed when the stop ends the run without the action: grants are single-use, it is never reissued or reused, and the result entry names it. An opened or pushed PR is left open.

**The attempt, in both modes.** One rule for `dispatching` and `running`, after that reconcile:

| Attempt | Graceful | Force |
|---|---|---|
| `intent-recorded`; no dispatch key, or the dispatch key's result is `not-started` | Record-only cancel, `cancelled-unstarted` (below) | The same |
| `intent-recorded`; the dispatch key's result says the runner was called, or the runner shows a session in its worktree | Park `ambiguous`, qualifier `dispatch` | The same |
| `dispatching` (no session id yet) | Wait, `stop-draining`. `ReconcileAttempt` leaves an idle `dispatching` worktree alone, since a start may be in progress (`ReconcileAttemptUseCase.use-case.ts:160-205`) | `StopAttempt`, which aborts a session-less `dispatching` attempt by worktree (`StopAttemptUseCase.use-case.ts:67-71`); §3.8's table maps the outcome |
| `running` | Wait for the server's end report, `stop-draining` | `StopAttempt`; §3.8's table |

A dispatch key's result is `not-started` when the dispatch was refused, or when its reconcile (K4, §3.5) finds the record still `intent-recorded` and the worktree idle. `DispatchAttempt` saves `dispatching` before it calls the runner (`DispatchAttemptUseCase.use-case.ts:662-705`), so an `intent-recorded` record proves no start was requested for it. The `ambiguous` park's exit: the reaper's `orphan-session` finding names the session; once that session is aborted (by the owner, or under D14's opt-in) a reconcile of the dispatch key finds the worktree idle, records `not-started`, and the cancel applies. A session-less `dispatching` attempt that never gets a session is the grace attention item's case under graceful; the owner escalates to force.

**`ExecutionLimits` under a graceful stop.** The timeout is not part of the stop. It is §3.2's `running` rule (past `ExecutionLimits` → `StopAttempt` → `seat-failed (timeout)`), keyed as its own `stop` step, and it fires with or without a stop. So a graceful stop calls no `StopAttempt` **because of the stop**, and a lane past its limit is stopped as it would be anyway; the drain then ends `stopped`. The other choice would let a graceful stop run a lane past its limit, which makes a stop more permissive than no stop.

**The drain.** After the reconcile and the attempt rule above, a graceful stop lets a run finish only these steps:

| Run state | What happens |
|---|---|
| `dispatching`, `running` (attempt live) | The attempt rule above; the wait reason is `stop-draining`. |
| `collecting` | Collect and seal (C1). An edit-only seat's commit step (AG) runs here as it would without the stop. |
| `gating`, gate not yet decided | The gate runs once at the collected head. |
| `gating`, gate `passed`, `failed` or `unknown` | `stopped`. Never `brief-check`, never `fixing`. The gate result stays in the journal. |
| Any other state, attempt null, `ended`, `collected` or `cancelled` | `stopped` (as §3.8's "no running attempt"). No review, fix round, PR, push or merge is started. |
| `parked`, attempt ended | `stopped`. |
| `parked`, attempt may be running (for example `ambiguous` on dispatch) | The park stands. A run never shows `stopped` while its attempt may still be running (§3.8). The owner escalates to force, or a reconcile settles it. |

A seat failure during the drain (`seat-failed`) moves to `stopped`, never to the next seat. A park reached during the drain (for example `artifacts-unsealed`) keeps its attention item; once its attempt is confirmed ended, the run ends `stopped`.

**Halt and a pending stop.** Halt still parks a draining run `halted` before collect or gate. Collect and gate run on the lane host (the gate runs commands there), and §3.7's promise is that a halted conductor takes no external action; a drain does not get an exception. The exit is a table transition, not a resume: **a run parked `halted` with a stop pending leaves the park by itself once the halt marker is gone.** On its next `advance` the driver enters the parked-from state (`parked → <parkedFrom>`, §3.2's park exit), journalled as a `conduct` entry. `ResumeLaneRun` is not involved, so `stop-pending` does not block it. The drain (graceful) or the `StopAttempt` (force) then continues. Halt allows no `StopAttempt` either (§3.7), so a force recorded during a halt waits for the marker to go; the halt's attention item says so. A `halted` park with no stop pending is unchanged: `conductor resume` or the owner's answer moves it.

**Grace.** A graceful stop does not signal the lane; it waits for the lane's own end. When the drain has lasted longer than `policy.conductor.stopGraceMinutes` (default 45, the lane size; D12), the driver raises **one** attention item keyed (project, run, `stop-grace-exceeded`) naming the run and the attempt. It never escalates to force by itself. The owner may.

**An attempt that was never dispatched** (`intent-recorded`, the decider's phase `prepared`) is cancelled **in the record** by either mode, without `StopAttempt`. `StopAttempt` refuses it today: a session-less attempt outside `dispatching`, `reconciling` and `blocked` is refused (`StopAttemptUseCase.use-case.ts:67-76`), so the open K7 item resolves this way. The cancel is safe only while §3.5's dispatch rule holds, so it needs all of these:
- no unread dispatch intent for the run (the decider reconciles a pending intent first, §3.5; K1-2b G3a);
- no dispatch key for this attempt, or a dispatch key whose result is `not-started` (a new attempt fact, `dispatchResult`: `none | not-started | started`). `started` with an `intent-recorded` record parks `ambiguous`, qualifier `dispatch`, as in the attempt table above;
- a CAS save on the attempt's revision, so a concurrent writer loses;
- `DispatchAttempt` refuses an attempt whose record is `cancelled`. Its claim-state check refuses `dispatching`, `running`, `reconciling` and `blocked` only (`DispatchAttemptUseCase.use-case.ts:502-516`); the lane that builds the cancel verifies this and adds the refusal, with a test, if it is missing.

The cancel is journalled under the attempt's stop step key `<runId>/r<round>/stop/<seatIndex>`, with the result `cancelled-unstarted`, and releases the attempt's reservation if one is held. Its outcome maps like §3.8's `cancelled` row: `stopped`; capacity released only when the release is confirmed, otherwise held with one attention item.

**Resume.** A run with any stop pending, graceful or force, refuses resume with `stop-pending` (§3.8). A graceful drain is not a park, so the refusal also covers a run that is not parked. The halt-marker exit above is not a resume, and `stop-pending` does not apply to it.

#### 3.9.2 The reaper

§3.5 reconciles one run each time the driver advances it. Nothing looks for what no driver advances. The **reaper** does. It finds zombies, reports them, and repairs only what is provably safe.

**What expires by itself and needs no reaper.** Request claims (O1b: claim lease and TTL) and orchestrator sessions (O2a: the 90 s session lease) end by clock in their own use cases. The run and driver leases (K3) need no repair either: a lapsed lease is taken by the next driver under CAS. The reaper only reports a run that no driver holds (below).

**Finding kinds.** Each is a typed `ReaperFindingKind`.

| Kind | Seen when | Facts read through | Repair |
|---|---|---|---|
| `orphan-session` | The runner reports a session in a known worktree (one named by an attempt or a reservation) whose attempts are all terminal, or absent | `inspectWorktreeRun`, `listAllAttempts`, `listActiveReservations` | Report. Abort only with opt-in (D14), never on a worktree with commits not on the remote, and only through `abortWorktreeRun` |
| `dead-attempt` | The record says `running` with a session; the runner reports that session ended or not found | `inspectSession` | Record-only: run `ReconcileAttempt`, which applies its own rules and is safe to repeat (below) |
| `driverless-run` | A non-terminal run whose run lease lapsed and no driver lease is held | K3 run and driver leases | Report only: start the driver |
| `leaked-slot` | A held reservation whose attempt is `ended`, `collected` or `cancelled`; or whose attempt is absent and named by no non-terminal run. A run in `ready` reserves before its attempt row exists (§3.2), so a reservation named by a non-terminal run's attempt ids or pending intents is never a leak. Includes §3.8's `terminated, capacityReleased: false` row | `listActiveReservations`, `findAttemptById`, runs and their leases (K3) | Record-only release. Just before it, re-read the attempt and every run naming it: release only if the attempt is still in a release state, or still absent and named by no non-terminal run. Any naming run whose lease was renewed within G aborts the repair |
| `stale-stop` | A `stop-unconfirmed` park older than `policy.conductor.reaper.staleStopMinutes` (default 30), or the stop retries spent (K1-2b's `wait stop-unconfirmed`) | Run record, keyed journal | Record-only: run `ReconcileAttempt` on its attempt; the driver then ends the run (§3.8) |
| `orphan-worktree` | A known worktree with no non-terminal attempt or run, or whose branch's PR is merged | Attempts, runs, AM4b's PR-state read | Report only (D15) |
| `stale-attention` | An open attention item, or an unanswered owner question, for a run already `merged` or `stopped` | AM3b attention store, Q1 questions | Attention: record-only close. Question: report only |

**Two changes the existing plan forces.**
- **Only the server's matching end report ends an attempt** (§2). So the reaper never marks an attempt ended itself. Its `dead-attempt` and `stale-stop` repairs call `ReconcileAttempt`, which ends an attempt only on that report and deliberately leaves an idle `dispatching` worktree untouched (`ReconcileAttemptUseCase.use-case.ts:160-205`). A finding the reconcile does not settle stays a report.
- **Facts come through existing ports, so v1 sees only known worktrees.** No port lists every runner session or every worktree on a host: the runner inspects one session or one worktree, and `WorkspacePort` inspects one worktree. So `orphan-session` and `orphan-worktree` cover worktrees named by an attempt or a reservation. Enumerating a host is a new read method and its own decision (D16).

**The reaper's reconcile and the driver's.** The reaper calls `ReconcileAttempt` under its own repair key, not the run's step key. That is safe because `ReconcileAttempt` is safe to repeat. It refuses a terminal attempt before any runner contact or change, releasing only a reservation the terminal attempt still holds (`ReconcileAttemptUseCase.use-case.ts:103-139`). It saves under the attempt's revision, re-reading once on a conflict and writing nothing if the fresh record is terminal (`:87-93`, `:457-470`). So two reconciles of one attempt, one from the driver and one from the reaper, end it at most once; the worst case is a second `reconcile` journal entry. The reaper still skips an attempt whose run has an intent younger than G.

**The reaper never changes a run.** Only the driver changes a run, under its lease and keys (§3.2). The reaper writes attempts, reservations and attention items through the existing use cases above, and its own findings. A run it reports is moved by the driver on its next `advance`.

**The shape.**
- **Domain (work-execution):** `ReaperFinding` (kind, subject, first and last sighting, sightings), `REAPER_FINDING_KINDS`, and a pure classifier `classifyZombies(facts, nowIso, reaperPolicy)` returning findings and, per finding, `report | repair | wait`. Like `nextLaneRunAction`, it never throws and never acts.
- **Application:** `ReapZombiesUseCase`: gather facts through the ports in the table, classify, upsert findings, raise or refresh attention items, perform the allowed repairs. A new `ReaperFindingRepositoryPort` (file and memory stores) keeps sightings across passes; it is the one new port.
- **Driver and CLI:** the driver runs a pass every `policy.conductor.reaper.intervalMinutes` (default 10; D13). `conductor reap [--dry-run]` runs one pass; `--dry-run` lists findings and the repairs it would make, and writes nothing. A standalone `conductor reap` is how a `driverless-run` is seen, since a driver never finds itself missing.

**Two sightings and a grace period.** A finding acts only when seen on two passes at least G apart, with G = `policy.conductor.reaper.graceMinutes` (default 5, and never less than twice the driver's longest poll of 2 min; D13). The reaper never acts on a subject with an intent, a save or a lease renewal younger than G, so it never races a dispatch, a stop or a driver. A finding not seen on a later pass is closed.

**Worktree subjects are re-read as a whole.** Young activity is checked per subject, and a new attempt in the same worktree does not make the worktree subject young. So before any action on a worktree subject (today only the opt-in `orphan-session` abort, K12), the reaper takes the worktree through `reserveCapacityAtomically` under a hold id `reaper-<findingId>`; its busy-worktree check is the same one a dispatch passes, so a dispatch and the abort exclude each other. Holding it, the reaper re-reads every attempt, run and reservation naming that worktree, and gives up the repair if any is non-terminal or was written within G. Then it releases the hold. K12 verifies the busy-worktree check covers a hold with no attempt; if it does not, the abort stays out of scope. Report-only findings are unaffected: they act on nothing.

**Report first.** By default every finding is report-only: one attention item keyed (project, subject, kind), one per finding, never one per pass. Automatic repair is allowed only for the record-only repairs in the table, each enabled per kind under `policy.conductor.reaper.repairs` (D14). A destructive repair (abort an orphan session) needs its own per-kind opt-in and never touches a worktree with commits not on the remote. No repair removes a worktree (D15).

**Every repair is keyed.** Its journal entry has the key `reaper/<subjectId>/<kind>@<findingId>`, intent before the action, result after, so K1b refuses a second one and a repair is never done twice. The subject id is a record id (attempt, reservation, run, attention item); a worktree subject is named by a 12-hex digest of its path, never the path. The finding id is a ULID minted at the first sighting.

**Web.** Findings are read-only in the web first (web plan: route A-F, view W7c). Repairs stay in the CLI until the owner decides otherwise.

**Kill switch.** Halt stops reaper repairs too; a halted reaper still reports. `--dry-run` and dry-run mode (§3.7) journal `would repair <kind>`.

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. **Parallel** means three things together: different packages, **no shared file** (notably `apps/cli/src/composition.ts`, `apps/api` wiring and `.architecture/manifest.yaml`), and room in the host-wide gate budget. The owner lifted the two-lane stability cap on 2026-10-27. Within a group, lanes marked **→** run in sequence. Manifest edits are small; lanes that add to it merge one at a time, rebased.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| K0 | This plan, decisions, manifest text; amends `docs/planning/2026-10-26_execution-order.md` (its "at most two" lines) with the owner's 2026-10-27 lift of the two-lane cap, keeping "never two in evidence-and-acceptance" | docs | 0 | — |
| **Group 1, parallel now** | | | | |
| K1 | `LaneRun` record, transition table, guards, keys, pure `nextAction`; one test per row of §3.2. Split into the four lanes below | work-execution (domain) | 2 | K0 |
| K1-1 | `LaneRunRecord`, `LaneRunState`, park reasons, keys (implemented) | work-execution (domain), **manifest**; sync barrels | 2 | K0 |
| K1-2a | Transition table, guards, stop mapping, stop modes, drain and halt-exit data, resume refusals | work-execution (domain `lane-run-transitions.ts`); sync barrel | 2 | K1-1 |
| K1-2b | Facts and the pure decider; forced stop, record-only cancel, halt-marker exit, merged-before-stopped | work-execution (domain `lane-run-decider.ts`); sync barrel | 2 | K1-2a |
| K1-2c | The graceful drain rules in the decider | work-execution (domain `lane-run-decider.ts`) | 2 | K1-2b |
| AM1 → K2 | `policy.autoMerge`; then `policy.conductor` | installation | 2 | V2b out of installation |
| AM3a | Policy grants, covering every forge kind including `push-to-pr` | operator-coordination | 2 | — |
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
| AM4b | Forge refusal kinds, PR-state read, `push-to-pr` kind | work-execution (domain `coordination-keys.ts`, application ports, infra), shares `apps/cli/src/composition.ts` and `apps/cli/src/index.ts` | 2 | — |
| PC | `ReviewRequestPort`, `CiStatePort` and their adapters | work-execution, **`composition.ts`** | 2 | RW2, AG |
| **Sequential** | | | | |
| S2a → S2b | `AcceptanceSpec`; acceptance runs it | work-execution, evidence | 2 | S1b, AM3c |
| K3 | `LaneRunRepositoryPort`, run and driver leases | work-execution | 2 | K1b |
| K4 | Dispatch to gate, seat pivots, crash-resume tests | work-execution | 2 | K3, S2b, C1, AG |
| K5 | Review and fix rounds, `renderHandoverBrief`, §3.4 | work-execution | 2 | K4, PC |
| AM4a → AM5 | `AutoMergeAttemptUseCase`; CLI | work-execution, apps/cli | 2 | AM1, AM2, AM3a–c, AM4b |
| K6 | Acceptance, pre-merge wait, PR, push, CI, merge, parks | work-execution | 2 | K5, AM4a, Q1 |
| K7 | `conductor run\|halt\|resume\|stop\|status`, polling, dry-run fakes | apps/cli | 2 | K4, K1-2c |
| K8 | Shadow replay of recorded journals | apps/cli, tests | 1 | K7 |
| K9 | `/v1/changes` wake-ups as D9 allows | apps/cli | 1 | K7, E3b |
| K10 | `ReaperFinding`, `REAPER_FINDING_KINDS`, `reaper/` keys, pure `classifyZombies` with the two-sighting and grace rules; one test per kind and per row of §3.9.2 | work-execution (domain), **manifest** | 2 | K1-2c, K1b, K3 |
| K11a | `ReapZombiesUseCase`, `ReaperFindingRepositoryPort` and its file and memory stores; record-only repairs through `ReconcileAttempt`, the reservation release and the attention store; keyed repair entries; fault-injection tests (a crash after the repair before its result; a subject with a young intent) | work-execution (application, infra), **manifest** | 2 | K10, K4, AM3b, AM4b |
| K11b | `conductor reap [--dry-run]`; the driver's reaper pass and its interval; `policy.conductor.reaper` read | apps/cli, **`index.ts`, `composition.ts`** (shared with K7, AM5, O5) | 2 | K11a, K7, K2, AM5 |
| K12 | Destructive repair `orphan-session` abort, behind its per-kind opt-in and the unpushed-commits check | work-execution (application), **`composition.ts`** | 2 | K11b, D14 opt-in |

Group 3's work-execution lanes can each run beside a Group 2 lane in another package; inside Group 3, AM2 and S1a may overlap only if their files are disjoint, which each brief must state. AM4b touches `composition.ts`, so it runs in sequence with every other `composition.ts` lane. C1 and U1/U2 are in flight: prerequisites, not new lanes.

**Amendment UI-B (2026-10-27, §3.8).** No new lanes. K1's transition table and guards gain the stop mapping and the `stop-unconfirmed` park reason, with one test per mapping row. K1b's keys include the control keys of §3.8. Whichever lane builds `ResumeLaneRun` (it backs K7's `conductor resume`) refuses `one-way-door` parks, `stopped` runs (`run-stopped`) and `stop-unconfirmed` parks (`stop-pending`), with a test for each. K7's driver obeys `<runId>/stop@web` entries. If K1 has merged before this amendment, these land as a K1 follow-up. The web UI plan's A-C writes the stop entry and refuses run-owned attempts on the direct attempt stop.

**Amendment K-GC (2026-10-27, §3.9).** New lanes K10, K11a, K11b and K12 above; the stop modes need no new lane:
- **K1b** adds the keys K1-1 lacks: `<runId>/stop-force@web`, the `@cli` forms of both stop keys, the `mode` on a parsed stop key (read from the key), `reaper/<subjectId>/<kind>@<findingId>`, a check that a stop entry's `mode` matches its key, and the per-run stop check (`stop-already-requested`, `stop-already-forced`). K1b is the first lane that stores keys, so they land before anything is stored. It updates K1-1's manifest invariant with the new control keys.
- **K1-2a** adds `RunStopMode` (`graceful | force`), a `strongerStopMode` helper, the drain states and steps of §3.9.1 as data, and `laneRunHaltLiftExit` (a `halted` park with a stop pending returns to its parked-from state once the marker is gone). Its resume check reads `stopMode: RunStopMode | null` instead of `stopRequested`; any recorded stop refuses with `stop-pending`, with its own test.
- **K1-2b** replaces `stopRequested` with `stopMode`, `stopRequestedAtIso` and `stopGraceMinutes`, adds `dispatchResult` to the attempt fact, the decision `cancel` (the record-only cancel, under the stop step key) and the wait reasons `stop-draining` and `stop-grace-exceeded`. New rules: a merge that landed ends `merged` before any stop rule; the halt-marker exit; the attempt table of §3.9.1 for both modes. G4a and G4d become force rules; a graceful stop waits until K1-2c. One test per new row.
- **K1-2c** (new, about 35 minutes, after K1-2b) replaces that wait with the drain rules of §3.9.1: collect and gate once, then `stopped`; the grace wait. One test per row and per drain sequence.
- **K2** adds `policy.conductor.stopGraceMinutes` and `policy.conductor.reaper` (enabled, interval, grace, stale-stop minutes, per-kind repairs; absent = report-only).
- **K4** builds the record-only cancel of a prepared attempt and `DispatchAttempt`'s refusal of a `cancelled` record if it is missing.
- **K7** adds `conductor stop --force`, the drain wait, the grace attention item, and the CLI's handling of K1b's `stop-already-requested` (exit 0) and `stop-already-forced` (exit 1).
- **Web plan.** A-C writes both stop keys and shows K1b's `stop-already-requested` and `stop-already-forced`; W7b shows "Stop" and, while a graceful stop is pending, "Stop now"; the reaper's read route (A-F) and view (W7c) are added there.

K11 is split in two because a use case, a store, the CLI and the driver hook are more than one 45-minute lane, and K11b shares `index.ts` and `composition.ts` with K7, AM5 and O5. K12 is dispatched only if the owner opts in under D14.

## 5. Hard to undo

- **Merges made by the conductor** are one-way. They need `policy.autoMerge` on, an eligible lane, and live mode (D4); each merge's journal entry names the policy revision that authorised it.
- **PRs it opens or pushes to** are visible to anyone who can see the target repository; bodies are rendered from records, never lane output.
- **The `LaneRunRecord` format, journal keys and the review `kind`** become stored data; version them from their first commit.
- **The park reason `stop-unconfirmed` and the refusal reason `run-stopped`** (amendment UI-B) become stored and wire data the web reads.
- **The stop keys and `RunStopMode`** (amendment K-GC): `<runId>/stop@…` now means graceful, `<runId>/stop-force@…` means force. Once K1b stores them, the meaning of a stored key cannot change. The refusal reasons `stop-already-requested` and `stop-already-forced` become wire data the web shows.
- **The reaper's finding kinds and its `reaper/` keys** become stored data the web reads; version them from their first commit.
- **A destructive repair** (aborting an orphan session) is one-way: the session's unfinished work is lost. It runs only behind the owner's per-kind opt-in (D14), and never removes a worktree (D15).

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
| D11 | The default stop mode for `conductor stop` and the web's first button | **Graceful.** Force is explicit (`--force`, "Stop now"); a force may follow a graceful stop, never the reverse |
| D12 | How long a graceful drain runs before it raises an attention item | **45 minutes** (`policy.conductor.stopGraceMinutes`, the lane size); one attention item, never an automatic force |
| D13 | Reaper grace G and interval | **G = 5 minutes** (at least twice the driver's longest poll); **a pass every 10 minutes** in the driver, plus `conductor reap` on demand |
| D14 | Which repairs may ever be automatic | **Record-only, per kind:** release a leaked slot, reconcile a dead attempt or a stale stop through `ReconcileAttempt`, close attention for a terminal run. **Aborting an orphan session:** off; per-kind opt-in only, never with commits not on the remote |
| D15 | Is removing an orphan worktree in scope? | **No.** Report-only, with no remove method on any port, unless the owner opts in by a later decision |
| D16 | Should the reaper enumerate every runner session and worktree on a host, beyond those the records name? | **Not in v1.** It would need new listing reads on the runner and workspace ports; decide after ten reaper passes are recorded |

D11, D13, D14 and D15 (amendment K-GC, §3.9) were decided by the owner on 2026-10-27, each as recommended. D12 and D16 are the recommended defaults, shown to the owner on the same day with no objection, and stay open until the owner decides otherwise. Nothing in §3.9 that depends on D12 or D16 is changed without that decision.

## 7. Assumptions

- The lane server's end report stays authoritative and reachable by worktree; if not, runs park as `ambiguous`.
- Review CLIs end with a parseable verdict line; a changed format reads as `unknown`, which holds the run.
- `gh pr merge --match-head-commit` keeps refusing a moved head.
- One state directory per installation, one driver over it.
- S1, S2 and AM are built as planned; if one slips, the conductor parks at that step instead of guessing.
- The runner's worktree inspection answers `idle` truthfully for an attempt that was never started; if it cannot, a prepared attempt with a journalled dispatch parks `ambiguous` instead of being cancelled.
- A graceful stop does not reach the lane. It relies on lanes ending within their size; a lane that does not raises the grace attention item, and the owner decides whether to force.
- The reaper and the driver read one clock per installation; skew between passes shorter than G cannot make a fresh subject look stale.
- A standalone `conductor reap` beside a running driver is harmless: the reaper never writes a run, and every repair is keyed.

## 8. Review

**Opus, rev 0 (2026-10-27).** Applied: keyed journal, request ids and question keys in K1b, RW1, Q1, with intents fenced by the unique key (blocker); review `kind` and per-(reviewer, kind) R1 selection, no seat switch on a recorded fail, D10 (blocker); `ReviewRequestPort` and `CiStatePort` in PC; `push-to-pr`, exits from `collecting` and `awaiting-premerge`, `stopped` defined, D3 unified, rounds defined; groups re-cut by shared files; AM2 added; the lifted two-lane cap; D9.

**Opus, rev 1 (2026-10-27): NO BLOCKERS.** Applied: a review retry uses its own key; `stopped` is reachable from every state; AM4b's real scope (domain `ForgeActionKind`, application ports, `composition.ts`, `index.ts`) and its sequencing with the other `composition.ts` lanes; AM3a's grants cover `push-to-pr`; K0 amends the execution-order doc's two-lane cap.

**Grok 4.7, amendment K-GC rev 1 (2026-10-27): one blocker, six majors, three minors.** Applied: the halt-marker exit for a halted park with a stop pending (blocker); reconcile before any stop ends a run, merged before stopped, consumed grants; one attempt table for `dispatching` and `running` in both modes, with `ExecutionLimits` kept; `leaked-slot` excludes reservations of non-terminal runs; worktree subjects re-read under a worktree hold; §3.2 and §3.8 marked in place; K1-1 to K1-2c in the workbook, K7 and K11b dependencies; the per-run stop check in K1b; Status aligned with §6; `ReconcileAttempt`'s repeat safety cited.

## Challenge this

Whether `LaneRunRecord` should exist at all. With a keyed journal, nearly all of the run's state can be derived, and a second record risks disagreeing with it. The plan keeps a minimal record because the seat cursors, the park and the lease cannot be derived safely. A reviewer should test whether putting those in keyed journal entries keeps crash-resume and fencing correct with one store fewer.

Whether the graceful stop earns its place. A forced stop deletes no commits: collecting what is already on the branch after a force keeps most of what a drain keeps. What a drain adds is the work the lane would commit before its natural end, at the cost of a new fact, a new key, a drain table and a grace timer. A reviewer should test whether "force, then collect and gate what was committed" covers the owner's need with less, and whether a lane left to drain is likelier to commit something useful or to run to its deadline. On the reaper, the part to challenge is the claim that it never races the driver: check every record-only repair against a driver that advances the same subject in the same second.
