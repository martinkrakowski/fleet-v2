# Plan: the work that still happens outside fleet-v2

- **Review log:** Fable review 2026-11-24 — 6 majors, 4 minors — applied.
- **Status:** rev 1 draft, 2026-11-24. Nothing here is dispatched. Owner decisions are in section 8.
- **Basis:** the owner rule of 2026-11-03 ("no shell style for scripts in v2, everything should be properly rewritten for the platform") and the owner request of 2026-11-24 to list and plan what is still done by shell scripts, by the orchestrator, or by helpers outside this repository.
- **Relation to the cutover plan:** `2026-11-03_cutover-plan.md` (CO) covers the merge train, the chain station, the brief station, release install and relaunch. This plan covers only what CO leaves outside, plus first-live-use of what CO built. It adds no unit that CO already owns.

## 1. Reading notes

- **Read:** the CO plan (sections 1, 2, 3.5), the manifest (four business contexts plus `merge-coordination`, ports and adapters), `AGENTS.md`, `docs/runbooks/cutover.md`, and a code search of `origin/main` for the use cases named below.
- **Not inspected:** the bodies of the shell scripts, the host timer units and the scratchpad scripts. Their behaviour below is taken from the owner's request and from the CO ledger headers; every row marked *behaviour unverified* needs SX0 or SX6 before its unit is briefed.
- **A declared port is not an implemented guarantee** (`AGENTS.md`). "Exists" below means a use case or in-port file is present on `origin/main`; SX0 confirms it is wired and exercised.
- **Context ownership.** `work-execution` (WE) owns lanes, runs, chains, the daemon and the conductor. `evidence-and-acceptance` (EA) owns receipts, gates and review verdicts. `brief-knowledge` (BK) owns brief context. `operator-coordination` (OC) owns decisions, grants and owner items. `merge-coordination` (MC) owns pure train records. Dependency direction is as declared in the manifest; no unit below adds a context edge.

## 2. Inventory: what is outside, and what already has a home

Legend: **E** = a use case or in-port exists on `origin/main` (audit by SX0). **P** = a CO unit is planned. **G** = gap, planned here.

| # | Item | Today | Already planned or built | Gap in this plan |
|---|---|---|---|---|
| A | Merging (shell train) | shell | CO3-CO12, CO25, CO30-CO33, cutover runbook | none: list only |
| 1 | Conductor driver loop and supervisor | shell loop plus a one-off supervisor script, behind a lock wrapper | **E** `conductor run --live`, `ConductorDriverLeasePort` (K3), request channel (O9 in REM), CO6 daemon scheduler for the tick only | **G** the driver is not a supervised unit; no takeover preflight; no drain. SX1-SX3 |
| 2 | Chain refresh and landing | shell | **E** `StartChain`, `RefreshChains`, `LandChain`, `ChainRepositoryPort`, `ReviewChainPort`, `ChainAttentionPort`; **P** CO7-CO11 | **G** live parity on real chains, then flip. SX4 |
| 3 | Hand-landing, premerge, enqueue | shell | **P** KS7a (premerge from the daemon), DT4 (enqueue), CO25 (`merge ready`, `merge wait`) | **G** the composite "land this reviewed PR" command. SX5 |
| 4 | Housekeeping timers (train watchdog, retry-dispatch, sentinel, stop-after-merge) | host user timers | CO step 0 asks the operator to map timers; **E** daemon job registry and reaper findings | **G** inventory, then one job per behaviour. SX6-SX10 |
| 5 | Script installation (`deploy-train.sh`) | shell | **E** `release install\|swap\|rollback` with RR1 release grants (CO14); retired by CO33/section 3.5 | none: list only |
| 6 | Unit selection and planning | orchestrator reading plans and state | **E** `plan import`, work-board read model (WB, BRD); admission caps (CON) | **G** deterministic readiness selector. SX11-SX13 |
| 7 | Brief writing and brief-lint | brief writer on the operator's agy plan via the lane host; shell lint | **E** `AuthorBrief`, `BriefAuthoringAdapter`, `parseBriefAnswer`, `lintBrief`, `VerifyBrief` (CO15-CO18) | **G** the remote seat transport, lint parity against the shell corpus. SX14-SX15 |
| 8 | Fable brief and pre-merge reviews | Claude Code subagents | **E** `ReviewRequestPort` (brief-check, code-review, pre-merge), review transports (CLI and api), `ReviewChainPort` | **G** a seat type for plan-quota agent CLIs, required-receipts predicate. SX16-SX18 |
| 9 | Extra-seat lanes (grok edit-only, agy Sonnet patch lanes) | scratchpad scripts | **E** `AgyRunnerAdapter`, `SaveLaneEdits`, `AdoptLane` (CO27, CO28) | **G** a grok runner, a patch-return seat, a capacity class. SX19-SX21 |
| 10 | Mutation proofs for hand lanes | hand-run harness | vacuous-pass plan (2026-10-26) covers the review-side rule only | **G** the proof itself as a gate predicate. SX22-SX23 |
| 11 | Relaunch apply (first live use) | built, unused | **E** `ApplyRelaunch`, `AdoptLane`, relaunch plan repository (CO26-CO29) | **G** a rehearsal drill, then the owner-granted live run. SX24-SX25 |
| 12 | Owner signing ergonomics | works, clumsy | **E** `coordination sign-decision` (incl. `--pre-sign`), `owner-key` | **G** summary-before-sign and expiry attention. SX26-SX27 |

## 3. Principles for every unit

1. **Platform code, not shell.** Each unit is TypeScript behind ports; the one process boundary is `CommandExecutorPort` in infrastructure. No script is ported line by line; the behaviour list from SX0/SX6 is the spec and a parity corpus is the proof.
2. **Shadow first, then flip, for anything that acts.** A job or command that would write (forge, queue, runner, grant, worktree) first ships in a mode that journals `would-*` and compares with what the shell side did. The flip is a separate unit or an installation setting change, never inside the building lane.
3. **One writer per state directory.** A unit never starts a second writer. Anything taking over a duty from a shell process proves, before it writes, that the shell process is not live (SX2), and holds the existing lease (`ConductorDriverLeasePort`, `DaemonLeasePort`).
4. **Model judgement stays outside domain code.** Domain and application code decide on typed facts (receipts present, tier, head, counts). A model is reached only through a review or brief seat, which is an infrastructure adapter behind an existing port; its output is untrusted text (`wrapUntrusted`) and becomes evidence only as a typed receipt bound to a head or digest.
5. **Authority is granted, not assumed.** Acting commands default to dry-run and need a recorded grant naming scope and digest (`--apply --grant`), as `merge import` and `release` already do.
6. **Public repository.** Fixtures, docs and receipts carry role names ("the lane host", "the operator host"), ids and codes only; no hostnames, addresses or home paths.

## 4. Units

Each lane is sized for about 45 minutes. "Proof" states what is proved and how. Tiers follow the project's tiering (Tier 2: security, data safety, user-facing behaviour, concurrency). **OWNER** marks a one-way door or an owner-only action.

### 4.0 Audit

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX0 | Read-only audit: for each **E** item in section 2, record wired or declared-only (composition, CLI verb, test that exercises it). Output a ledger table in `docs/planning/`. Names no host, path or token | docs | 0 | none | Each row cites a test or composition file; a row with neither is marked declared-only. Verified by reading, reviewer re-derives three rows |

### 4.1 Driver loop and supervisor (item 1)

Existing: the lease, `conductor run --live`, the start-request channel. Missing: running it as a supervised service, the proof that no second writer exists, and a clean stop that does not park runs.

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX1 | Oneshot `driver` unit pair, one `conductor run --live` pass per timer firing (no resident process), rendered by `hosts daemon install --unit driver`; the `ManageDaemonSchedulerPort` / `DaemonSchedulerPort` contract is amended in the same unit. Render and `show` only; linger, enable and start are printed, never run (as CO6) | WE app/infra; `apps/cli` `hosts.ts` | 2 | SX0, CO6 | Golden render tests for the unit pair; `show` and `uninstall` print keys only; a test that the render embeds no environment value |
| SX2 | `DriverTakeoverPreflight` use case and `conductor takeover --check`: read-only. Facts: the driver lease holder and age, whether a legacy driver process or lock is live on the lane host (via a new `LegacyDriverProbePort`, adapter over `CommandExecutorPort`, process names matched by pattern, nothing printed but a count), and request-channel backlog. Verdicts `clear`, `legacy-live`, `lease-held`, `unknown`. `unknown` never means clear | WE app/infra; `apps/cli` | 2 | SX1 | Decider table test for all four verdicts; probe adapter test with a fake executor; `hosts daemon install --unit driver --apply` refuses to write unless the verdict is `clear` (one-writer proof) |
| SX3 | `conductor drain`: ask the driver to finish the current pass, release the lease and exit without parking or stopping any run (CON section 3.8: a stopped run cannot resume). Idempotent; a second call is a no-op | WE app | 2 | SX2 | Test: runs in `running` stay `running` after drain; lease released exactly once; re-drain is a no-op |

**Sequence:** SX1 and SX2 after the switch; the live swap (stop the legacy loop, start the service) is **OWNER** (one-way only in that the legacy loop is then retired; reversible by `drain` plus restarting the loop until section 3.5 of the CO plan runs).

### 4.2 Chains (item 2)

Everything is built or planned (CO7-CO11). The remaining risk is that no real chain has run through it.

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX4 | Chain parity run: use `chain-refresh-mode` (already a daemon setting) in shadow on the live chains for the first N merges to main after the switch. Add the comparator rows (refresh outcome, conflict attention, landing member set) to the existing shadow report; add one e2e that lands a two-link chain end to end in the test composition | WE tests; `tests/e2e`; `apps/cli` shadow report | 1 | CO7-CO11, CO31, switch | The report shows equal refresh outcomes for N merges; the e2e asserts the integration PR carries every link's receipt and that the sweep deletes the branches. The code resolves `chainRefresh` only to shadow or invalid today, so the flip needs SX4b |
| SX4b | Accept `chainRefresh: live` in the daemon composition behind a recorded grant (extends the mode resolver; `live` is no longer `invalid`). **Flip: OWNER** | WE app; installation | 2 | SX4 | Resolver table test (shadow, live with grant, live without grant refused, invalid); live refresh writes only through the forge action port. |

### 4.3 Hand-landing (item 3)

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX5a | `LandPullRequest` decider and use case: read live head (`ForgeMergeReadPort`); require the receipts the tier needs on that exact head; mark ready; post `premerge` through KS7a's path; enqueue (DT4); each step journaled with a keyed intent. A head that moved refuses and changes nothing after that step. Adds no way to merge outside the train | WE domain/app | 2 | CO25, KS7a, DT4, switch | Table test per refusal (missing receipt, head moved, wrong tier label, two tier labels, not ready); idempotent re-run test (same keys, no duplicate status or enqueue) |
| SX5b | `merge land <pr> [--apply --grant <id>]` CLI: dry-run by default, prints each step; grant binding | `apps/cli` `merge.ts` | 2 | SX5a | Grant-scope test; dry-run writes nothing. After the switch the shadow-taint note for hand-lands is moot |

### 4.4 Housekeeping timers (item 4)

Behaviours, **unverified until SX6**: (a) train watchdog: a queue entry stuck in progress for a PR that is already merged or closed; (b) retry-dispatch: held units are re-dispatched once main moves; (c) sentinel: a periodic health check that notifies; (d) stop-after-merge: stop a named run or the driver once a named PR merges. Behaviours already covered by the CO-WD watchdog are not re-planned. The rest become jobs in the daemon job registry, each holding a `DaemonLeasePort` lease by scope, each with shadow mode.

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX6 | Timer inventory (read-only): `hosts daemon timers` lists the operator's legacy user units by name and the command class they run (never environment files or values), and maps each to a daemon job id or "unmapped". An unmapped timer is an attention item | WE app/infra; `apps/cli` | 1 | CO6 | Fixture units (public-safe) map as expected; a unit with an environment-file line prints no value; unmapped yields the attention item. Allowed before the switch: read-only |
| SX7 | Extend `train-health-rules` (the merged CO-WD train-health watchdog: `WatchTrainHealthPort`, `HostAudibleAlertPort`, wired in the daemon composition; overnight-plan U1/U5 and OG-20) with any stuck-entry case SX6 shows missing; `clear-entry` shadow first (`would-clear` journal), writes only after the flip | WE domain/app | 2 | SX6, DT3, switch | Rule table test for each added case (merged, closed, head moved, live, unknown forge answer: unknown never clears); shadow journal compared with what the legacy watchdog cleared over a window |
| SX8 | `retry-held-dispatch` job: a pure rule over held run requests and the new main head: re-issue through the existing request channel only if the request's base still validates; a mismatch is a typed attention item, never a silent drop. Uses fresh request ids (no id reuse) | WE domain/app | 2 | SX6, O9, switch | Rule test for base match, base moved, already running; e2e: main moves, held unit starts once, a second tick starts nothing (idempotence) |
| SX9a | `StopWhen` record (`{target: run\|driver, condition: pr-merged <repo>#<n>}`) and its store | WE domain/infra | 1 | SX6 | Store round-trip survives restart; invalid targets refused |
| SX9b | Job that evaluates `StopWhen` each tick from forge facts and the `stop-after-merge` CLI verbs. Acts through `drain` (SX3) or the run stop use case, never kill | WE app; `apps/cli` | 2 | SX9a, SX3 | Condition false, true, forge unknown (unknown never fires); fires once |
| SX10 | Only the checks SX6 proves absent from CO-WD and overnight U1/U5; otherwise dropped. Implement as a health job through the existing notification port, bland messages only (ids and counts) | WE app; OC owner items | 1 | SX6 | Fixture-based: each unhealthy fact yields one item, no duplicates on re-run; message text test asserts no path or host string |

**Flip order:** SX7, SX8, SX9b, SX10 each ship in shadow; each job flips on its own, per installation setting, after one clean day of matching the legacy timer. Each flip is **OWNER**; the matching legacy timer is disabled by the owner afterwards.

### 4.5 Unit selection and planning (item 6)

Judgement about *what is worth doing* stays with the orchestrator and owner. The platform owns the deterministic question "what may start now".

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX11 | Pure `selectReadyUnits(plan, runs, caps, order)`: a unit is ready when its dependencies are merged on the base, it has no live or parked run, it fits admission caps (per-package, per-host, gate budget), and its brief is frozen and verified. Output: ordered list with a reason code per excluded unit. Ordering is an installation list plus tier, never a model's ranking. Reuses CR2 `start-now` from the continuous-replanning plan if built; else supersedes it, recorded in that plan | WE domain | 1 | SX0, WB4a | Table tests over a fixture plan: dependency chain, parked run blocks, cap reached, brief unverified, stale plan (unit already merged on main is reported `already-merged`, which answers the known "no-commit phantom" case) |
| SX12a | `plan next [--json]` CLI over SX11, read-only | `apps/cli` | 1 | SX11 | CLI golden output |
| SX12b | Work-board "Ready" panel and its read-only API route fed by SX11 | `apps/api`, `apps/web` | 2 | SX12a | API route scope test (read scope only); web renders reasons; no action button (web action rules unaffected) |
| SX13 | `plan-advance` daemon job: for each ready unit, enqueue a start request. Shadow journals `would-start`; live behind a per-project `autoStart` setting and a recorded owner grant naming the project and a cap. Never starts more than the cap per tick | WE app; installation setting | 2 | SX11, SX12a, O9, SX2, switch | Shadow compared with what the orchestrator actually started over a window; cap test; refused without grant; **flip OWNER** |

### 4.6 Brief writing and lint (item 7)

CO15-CO18 built the station. Gaps are the fallback and fan-out of the brief writer and proof that the platform linter agrees with the shell linter.

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX14 | Fallback order and fan-out cap for the `brief-author` seat over the existing `BriefAuthoringAdapter` (CO17's `authorBriefSession` already runs the seat by argv in a read-only pinned checkout); no new adapter. An empty answer is a failed seat, never an empty brief | WE infra; installation seat config | 2 | CO17, SX0 | Fake-executor tests: empty answer fails; fallback taken on a typed seat-unavailable; at most K concurrent. First live use is a recorded, non-binding trial |
| SX15 | Lint parity: replay the shell linter's corpus and recent real briefs through `lintBrief`, diff verdicts; any divergence is a decision (fix the platform rule or document the waiver). Includes the known false positive on read-only domain citations | WE domain tests | 1 | CO15 | `shadow-brief-corpus` extended; zero unexplained divergences |

### 4.7 Fable and other review seats (item 8)

**Shape.** A review is a typed request (kind, subject digest or head, tier, embedded diff and brief text) to `ReviewRequestPort`; a **seat** is a named adapter that answers it. Review transports already exist in EA infra (`CliReviewTransport` for grok and agy with fixed argv and an empty scratch directory, and `ReviewTransportRouter`); add a `claude` argv template there (Claude Code in print mode, read-only, tools limited to file reading, web off, prompt embedded). The `fable` seat is configuration (transport `agent-cli`, model id, kinds it may take), not code. The seat's output is parsed by the existing verdict grammar; unparseable or empty is a failed review, never a pass. The domain only knows "a receipt of kind K from seat class S exists for head H".

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX16 | Pure `requiredReceipts(tier, kind, isChainHead)` returning the list of `{kind, seatClass}` needed, from an installation policy table (for example Tier 2 brief: a `deep` seat class receipt; chain landing: one `deep` receipt on the exact chain head). The implementer-is-not-reviewer rule is not re-implemented: `RecordReviewReceiptUseCase` already enforces it | EA domain; installation policy | 2 | SX0 | Table test over tiers and kinds; stale-head receipt does not satisfy |
| SX17 | Add a `claude` argv template to `CliReviewTransport` and a `ReviewTransportRouter` entry; EA infra only. Quota exhaustion and refusal are classified into `seat-unavailable` with a reason code. No credential is read or passed by the platform | EA infra | 2 | SX16 | Argv golden; web and write tools off in the template; empty output fails; quota text classified; argv never contains the prompt body |
| SX18 | Depends overnight U2 (and CO21); adds only park-on-`seat-unavailable` (attention `deep-review-unavailable`, never a silent substitute) and the installation substitute policy, which the owner enables | WE app (AdvanceLaneRun review step), installation | 2 | SX17, CO9, U2 | Run-decider test: park, not pass, on unavailable; substitution only when the policy names one; receipt records seat id |

**Flip.** Shadow: the seat runs on real heads and its verdict is recorded beside the human-run Fable pass; compare agreement over about 20 reviews. Making the platform seat the *only* pass is **OWNER** (plan quota is spent unattended; one-way in cost, two-way in code).

### 4.8 Extra-seat lanes (item 9)

These seats are additional capacity (owner, 2026-11-24). They edit only; the harness (not the model) syncs, gates, mutation-proves and commits. The platform already has the edit-only discipline for agy (`AgyRunnerAdapter`, hash-checked rounds) and adoption of uncommitted work (CO27, CO28).

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX19 | `GrokRunnerAdapter` implementing the runner port edit-only: allow and deny tool flags fixed by the adapter (headless accept-edits approves nothing by itself), web search off, brief fixed to the in-worktree file, model id mandatory. Result is an edit set, not a commit | WE infra | 2 | AG, SX0 | Argv golden; refusal when the brief is outside the worktree; a seat that exits 0 with no diff is `no-edits`, not success; no credential in argv or env allow-list |
| SX20 | `PatchReturnSeat` for seats that cannot write to the lane host (patch comes back as text): apply to a fresh worktree via `WorkspacePort`, run `LaneDiffCheck`, then `SaveLaneEdits` and `AdoptLane` to enter the normal lane run at `collecting` with `adopted` provenance | WE app | 2 | CO27, CO28, SX19 | A patch touching a protected path is refused with the finding class only; a patch that does not apply cleanly is `patch-conflict`; adopted run reaches `gating` in an e2e |
| SX21 | Seat capacity class `additional` in the seat plan: additional seats add host and quota concurrency only; per-package and gate-budget caps always bind. Never the first fallback in a primary chain | WE domain; installation | 1 | SX11 | Admission table test: an additional seat runs when the primary seat quota is full; per-package and gate-budget caps still refuse; chain fallback order unchanged |

### 4.9 Mutation proofs (item 10)

A hand lane's tests are proved by checking that they fail when the change they test is removed. This is a gate predicate, not a model task.

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX22 | Pure `partitionDiff(diff, testGlobs)` into source hunks and test hunks, and `judgeMutation(baselineRun, mutatedRun)` returning `proves`, `vacuous` (tests still pass without the source change), `inconclusive` (build broke, timeout, no tests selected). `inconclusive` never counts as proof | EA domain | 1 | none | Table tests incl. a diff touching only tests (no source hunks: `not-applicable`), rename, binary file |
| SX23a | `MutationProofAdapter` and the `mutation-proof` acceptance predicate (`GatePredicatePort`): in a scratch worktree on the lane host revert only the source hunks, run the named test selection. **Shadow:** informational, never blocks | WE infra (gate wiring); SX22 rule in EA domain, reusing the manifest's existing mutation-proof invariant | 2 | SX22 | Fixture repo with a real vacuous and a real proving test; scratch worktree removed and lane tree digest unchanged |
| SX23b | Record the verdict in the gate receipt, keyed with tree hash and predicate digest so `GateReceiptReuse` stays correct. **Flip to blocking for Tier 2 hand lanes: OWNER** | WE app/infra | 1 | SX23a | Receipt reuse test (same key reuses, changed predicate digest does not) |

### 4.10 Relaunch (item 11)

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX24 | Rehearsal drill for `relaunch plan\|apply`: a scripted-in-TypeScript e2e on a throwaway lane host fixture (a synthetic conducted, an attempt-recorded and an unrecorded lane), including the loss ledger (I5) and idempotent re-run (I7). Reports any step the live path needs that the fixture cannot show | `tests/e2e`; WE | 1 | CO26-CO29 | Loss ledger equal before and after; re-run changes nothing; abort without prior save refuses (I2) |
| SX25 | Runbook section: preconditions, the grant to request (plan digest), the stop-the-drivers-first order, rollback. Public-safe | `docs/runbooks` | 0 | SX24 | Reviewed against the drill's output |

The live `relaunch apply` is **OWNER**: it needs a recorded grant naming the plan digest, and it aborts running lanes.

### 4.11 Owner signing ergonomics (item 12)

Constraint: the platform never reads, prints or copies the private key; signing stays an owner action with the key path supplied at the command line.

| ID | Scope | Context / package | Tier | Depends | Proof |
|---|---|---|---|---|---|
| SX26 | `coordination sign-decision --request <id>`: look up the stored request, print a plain summary (scope, project, repository, head or root digest, expiry, what is not covered), recompute the digest from stored coordinates and refuse on mismatch, then sign only with `--yes` after the summary. `--pre-sign` flows keep working | OC app; `apps/cli` | 2 | none | Golden summary; tampered coordinates refused; the summary contains no key path or key material (test greps the output); existing sign-decision tests unchanged |
| SX27 | `coordination grants status`: lists standing grants with scope, project, expiry; raises an owner item `grant-expiring` N days before expiry and `grant-expired` after. Read-only plus the owner item | OC app; `apps/cli` | 1 | SX26 | Clock-injected tests for the thresholds; no duplicate items on re-run |

## 5. Totals

33 units: **Tier 0: 2** (SX0, SX25); **Tier 1: 12** (SX4, SX6, SX9a, SX10, SX11, SX12a, SX15, SX21, SX22, SX23b, SX24, SX27); **Tier 2: 19** (SX1, SX2, SX3, SX4b, SX5a, SX5b, SX7, SX8, SX9b, SX12b, SX13, SX14, SX16, SX17, SX18, SX19, SX20, SX23a, SX26). Fable pre-merge passes: about 19 (Tier 2), fewer if batched. All estimates are unmeasured.

## 6. Sequence

**Rule:** nothing that changes merge authority or evidence starts before the switch. Before it, only read-only units may run: **SX0, SX6, SX15, SX22** (they touch no queue, forge, runner, receipt or signing path). Everything else is briefed during shadow and dispatched after `cutover switch`.

| Phase | When | Units | Exit |
|---|---|---|---|
| P0 | before the switch, read-only | SX0, SX6, SX15, SX22 | Audit ledger merged; timer map complete (an unmapped timer is raised to the owner) |
| P1 | first week after the switch | SX1, SX2, SX3, SX11, SX16, SX21, SX24, SX26, SX27 | Driver service renders; takeover preflight verdicts proven; selector merged read-only |
| P2 | after P1 | SX5a, SX5b, SX7, SX8, SX9a, SX9b, SX10, SX12a, SX12b, SX4 | Jobs in shadow; `merge land` dry-run; chain shadow running |
| P3 | after P2 | SX14, SX17, SX18, SX19, SX20, SX23a, SX23b, SX25 | Seats and mutation predicate in shadow; relaunch runbook |
| P4 | flips, one at a time, each after a clean shadow window | driver swap (SX2 verdict `clear`), SX7, SX8, SX9b, SX10 jobs, SX4b chain refresh, SX13, SX18 sole-seat, SX23b blocking, relaunch apply | Legacy timer or script disabled by the owner after each |

Dependencies inside phases are as the Depends column. SX13 (auto-start) is last of the acting units because it multiplies every other defect.

## 7. Not planned here

- Item A and item 5: covered by CO; cited, not duplicated.
- Choosing what is worth building (backlog prioritisation, product judgement) and the owner's own review of briefs: stay human. SX11 only answers "ready or not".
- Hosting the model CLIs, their sign-in and their plan quotas: operator concerns. The platform never holds those credentials.
- Retiring the fleet repository's script tree: CO section 3.5 owns it; this plan adds only SX6's timer map as an input.

## 8. Decisions needed

| # | Decision | Recommendation | Why it matters |
|---|---|---|---|
| D-SP1 | Start after the switch, with only the P0 read-only units before it | Yes | Keeps merge authority and evidence unchanged during shadow |
| D-SP2 | Driver as a supervised service on the operator host (SX1/SX2); who performs the live swap | Owner performs it, after a `clear` verdict | One writer; the swap retires the legacy loop |
| D-SP3 | May the platform start the plan-quota review CLI unattended (SX17/SX18) | Yes, shadow first, in an empty scratch directory with read-only tools | Spends quota without a human present |
| D-SP4 | When the deep seat is unavailable: park, or allow a substitute seat by policy | Park by default; owner enables a named substitute per project | Silent substitution weakens the review rule |
| D-SP5 | Auto-start of ready units (SX13): allowed at all, and the per-tick cap | Allowed behind a grant; cap 2 to begin | It acts without the orchestrator |
| D-SP6 | Mutation proof blocking for Tier 2 hand lanes (SX23 flip) | Informational for 20 lanes, then block | A false `vacuous` would block honest lanes |
| D-SP7 | Additional seats may exceed primary-chain concurrency (SX21), still inside the gate budget | Yes | Owner direction of 2026-11-24 on extra capacity |
| D-SP8 | Fixtures for the legacy driver probe and timer inventory are generated, not copied from the operator host | Generated | Public repository: no host facts |
| D-SP9 | Order of P2 flips (watchdog first, then retry-dispatch, stop-after-merge, sentinel) | As listed | Lowest blast radius first |

## 9. Hard to undo

- **Retiring a legacy timer or the legacy driver loop after its job flips.** Reversible while the script and unit still exist; effectively one-way once the CO section 3.5 deletes them. Chosen by: the owner, per flip.
- **Granting `plan-advance` auto-start.** Two-way in code; one-way in the work it starts and the quota it spends. Chosen by: the owner, via the grant.
- **Letting the platform seat replace the human-run deep review.** Two-way in code; one-way in review quality if the seat is weaker. Chosen by: the owner, after the shadow comparison.
- **Live `relaunch apply`.** It aborts running lanes after saving edits; the save is verified but the abort is not undoable. Chosen by: the owner, via the plan-digest grant.
- **Making the mutation proof blocking.** Two-way (a setting).

## 10. Assumptions

- The **E** items are wired, not only declared. Where SX0 finds them declared only, the dependent unit gains a prerequisite and its tier does not drop.
- The behaviour of the four timers and the sentinel matches the one-line descriptions in the request. If SX6 shows more (for example a notification channel or a side effect on a forge), SX7-SX10 are re-briefed; none is dispatched before SX6.
- The daemon job registry has room for more jobs under its lease scheme without a schema bump. If it needs one, add a unit before SX7 and treat it as Tier 2 with a migration test.
- The review CLI can run read-only headlessly with an embedded prompt on the operator host. If it cannot, SX17 stays at the adapter level and the human pass remains.
- Extra-seat CLIs keep their current flags. Flag drift is caught by the argv golden tests, which fail loudly rather than run with wider permissions.

## 11. Challenge this

- **SX11's `already-merged` reason may hide a real problem.** A unit that is already on the base but whose plan row says open could mean a plan that was never updated, not just a phantom; the selector reports it, but nothing here fixes the plan. Is a plan-reconcile job needed?
- **Is porting the sentinel and watchdog worth it?** Both may be symptoms of the shell train's wedges; after the cutover the daemon may have no stuck-entry state at all, making SX7 dead code. SX6's inventory should decide before SX7 is briefed.
- **The `agent-cli` transport puts an unattended model run behind a CLI whose permission flags the platform does not control.** The argv goldens help, but a CLI upgrade that widens defaults would not be caught until used. Should the adapter probe the CLI's reported tool set before each run?
- **Sequencing SX13 last may be too cautious or too bold:** auto-start is where the orchestrator's judgement is most replaced. Is the readiness selector alone (SX11, SX12) enough value, with the orchestrator remaining the one who starts?

## Owner decisions recorded, 2026-11-24

Owner, 2026-11-24: "take the default for all open questions ... Proceed with your recommendations."

D-SP1 to D-SP9 are recorded as recommended:
- **D-SP1:** start after the switch; only P0 (SX0, SX6, SX15, SX22) before it.
- **D-SP2:** the owner performs the live swap after a `clear` verdict.
- **D-SP3:** yes: shadow first, in an empty scratch directory with read-only tools.
- **D-SP4:** park by default; the owner enables a named substitute per project.
- **D-SP5:** allowed behind a grant, cap 2.
- **D-SP6:** informational for 20 lanes, then blocking.
- **D-SP7:** yes, inside the gate budget.
- **D-SP8:** generated fixtures.
- **D-SP9:** watchdog, retry-dispatch, stop-after-merge, sentinel.
