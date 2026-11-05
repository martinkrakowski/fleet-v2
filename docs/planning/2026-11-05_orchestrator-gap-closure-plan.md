# Plan: closing the orchestrator gap — what the bridge tooling does today that fleet-v2 must do itself

- **Date:** 2026-11-05. Anchors checked against `main` at `38d08b6e`. Every plan cited below is a file in `docs/planning/` of this repository.
- **Target repository:** `fleet-v2`. The bridge tooling that runs lanes and the merge train today lives outside this repository, in the owner's private orchestrator tooling. This plan names it only as the bridge to retire. Nothing from that tooling (hosts, paths, scripts, seat choices, operational history) is copied here, in line with `docs/architecture.md`.
- **Status:** rev 1, draft. Nothing built. Not yet reviewed. Rev 1 adds G16–G24, OG-20–OG-28 and D-OG8 from an operator's reading of two days of conducted runs (§10). Decisions D-OG1–D-OG8 (§7) are open. No lane from this plan is scheduled until the owner records them.
- **Builds on:** `2026-10-27_conductor-plan.md` (§3.1, §3.2, §3.6, §3.7, §3.8, K6, K7, K11, CB-D1, CB1), `2026-10-28_lane-pipeline-speed-plan.md` (§3.3, §3.3.1, D21, D22, D33, KS1, KS5, KS7, A-S1, OS-1), `2026-10-31_daemon-tick-plan.md` (the merge pass, D-DT1–D-DT9), `2026-10-31_remaining-work-plan.md` (Waves 0–7, D-R2, D-R8), `2026-10-31_continuous-replanning-plan.md`, `2026-10-31_jev-merge-veto-decision.md`, `2026-11-01_lanes-board-and-killall-plan.md` (halt and pause), `2026-10-20_auto-merge-policy-plan.md` (A4, A11), `2026-10-27_lane-run-telemetry-plan.md`, `2026-10-16_onboarding-and-init.md`, `2026-10-16_add-host.md`, `2026-10-23_host-programs-and-client-server-packaging-plan.md`.

**Short answer.** The bridge does five jobs that fleet-v2 does not yet do: it drives many conducted runs with one safe driver, it runs the merge train and its chain rules, it validates briefs and acceptance commands before dispatch, it talks to the owner (notifications, seat rotation, review-thread replies), and it notices and recovers runs that stop making progress. Most of the merge work is already planned in fleet-v2 and only needs to be sequenced. The chain rules, the driver-safety rules, the acceptance allow-list and the thread helper have no lane yet. This plan adds them, retires the bridge in stages, and keeps the owner's policy values out of the product.

## 1. Goal

A user who installs fleet-v2 and points an agent at it can run conducted lanes, merge them through a train with chains, and get notified of parks and merges, with no bridge scripts. Every guard the bridge enforces today (one driver, allow-listed acceptance commands, premerge on every head, no merge without a current receipt) is enforced by fleet-v2 itself and covered by a test.

**Non-goals.** No copy of the bridge's scripts into this repository. No owner policy values (seat choices, hosts, fallbacks, limits) in product code; they stay in the installation file. No model decides to merge. No automatic resolution of review threads in v1 (see D-OG2). No GitHub merge queue (D22).

## 2. What exists and what is missing

Checked by reading the planning documents and by searching `apps/cli`, `apps/api` and `packages/work-execution` for the command or term. "Missing" means no lane in the planning documents covers it; it does not prove the code lacks it.

| # | Bridge capability (generic) | What fleet-v2 has | Planned where | Gap |
|---|---|---|---|---|
| G1 | Merge pass: enqueue, up-to-date check, merge, park with a reason | `attempt auto-merge`, `policy auto-merge`, `forge execute`; the `merge` stage in K6 | Daemon merge pass (daemon-tick §3.3); KS7 and A-S1 (speed plan) | Planned, not built. Sequencing only |
| G2 | Premerge status on every head change, re-posted after a branch update | `premerge` status design (KS1, KS7, OS-1) | Speed plan §3.3.1, §4.4 | Re-post on every head change is not an acceptance criterion in any lane. Add it (OG-5) |
| G3 | Premerge carried across a branch update when the PR's own patch is unchanged | Nothing | None found | Missing. A candidate rule that needs a decision (D-OG4) |
| G4 | Chains: a dependent set merges into `chain/<name>`, refreshed after each `main` merge, landed by one integration PR | `work-order` `baseBranch` (CB-D1, CB1) | Conductor plan §3.6 describes chains; only CB1 is a lane | Missing: chain start, refresh and landing, and a ruleset for chain branches (OG-6, OG-7) |
| G5 | One safe driver over many runs: a lock, re-read of run ids, refusal when another driver is alive | One driver by convention (conductor plan, line 519); O9 claims `start-lane-run`; K11b' is a driver pass; the CLI refuses `stop` and `resume` while a driver lease is live | Partly planned | No lane for an explicit driver lock with liveness check (OG-2). The bridge enforces one driver with an operating-system file lock, separate from the conductor's driver lease; OG-2 must name which of the two survives |
| G6 | Acceptance commands and brief argv validated before dispatch; the real refusal reason printed | `brief prepare`, `conductor start --brief-request` | Not in the planning documents | Missing: an argv allow-list in fleet-v2, and the refusal reason printed by `conductor start` (OG-3) |
| G7 | Review-thread reply and resolve in one call, from a file | `forge execute`; acceptance counts unresolved threads (A4, A11) | Daemon plan §3.6 says the daemon never resolves threads | Missing as an operator helper. Its scope is D-OG2 (OG-8) |
| G8 | `gh` located at a configured path; doctor says exactly how to fix it | Doctor with seat probes (P1, remaining plan W4) | Remaining plan W4 | Probe for the forge binary path not named. Add it to P1 (OG-1) |
| G9 | Owner notifications on park, merge and drop | Nothing live | E4 (remaining plan W6); daemon plan notifier job | Planned late (W6). Decide whether to pull earlier (D-OG5) |
| G10 | Seat choice rotates per lane; a seat outage moves to the next seat | Seat plans with fallbacks (onboarding-and-init); `seats check` | Onboarding plan | Rotation policy not stated. Decide ownership (D-OG6) |
| G11 | Lane telemetry: per-run cost and tokens, appended to a log | `telemetry export|status`, `attempt usage` | Lane-run-telemetry plan; OT5 | Covered in principle. The log format is not stated |
| G12 | One ocm-run copy, pinned by hash, in the repo the operator installs | `bin/ocm-run` bundled and hash-pinned in `scripts/ocm-run-hash.txt` | Host-programs plan cites a "single-copy" plan | The cited plan file is not in `docs/planning/`. The bridge keeps its own copy, which has drifted. Restore or re-state the plan (OG-9) |
| G13 | Install and state location for the bridge | `init`, installation file, state check and restore | Onboarding and init plans | No installer for the bridge's own pieces, which is correct once the bridge is retired. Covered by OG-10 |
| G14 | Halt the whole system: stop lanes, pause the train, refuse dispatch | `conductor halt`, halt marker | Lanes-board-and-killall plan (2026-11-01) | Planned, not built. The train pause depends on G1 |
| G15 | Merge veto from a model, shadow first | Nothing | Jev veto decision; daemon plan `JevMergeVetoAdapter` | Planned, behind G1 |
| G16 | A run whose state, park reason and round stay unchanged past a set time is reported as stuck | Nothing in the driver | None found | Missing. A run can sit in one non-terminal state for hours with no report (OG-20) |
| G17 | A graceful stop applies at the next step boundary, including a run waiting in collect with no live attempt | `conductor stop` (graceful) and `stop --force` | Conductor plan §3.1 | A graceful stop was observed never to apply to a run stuck in collect; only a forced stop ended it. No lane states the boundary rule (OG-21) |
| G18 | A capacity reservation whose run never started, or was abandoned, is found and released | `conductor start --abandon --run-id --attempt-id` by hand | None found | Missing: detection. One orphaned reservation was observed to block every later start for hours (OG-22) |
| G19 | A model-written brief is checked for structure before registration: both markers once and in order, nothing before the first marker, the lane id and tier, repository paths only in the owned list, gate commands as plain package-manager argv, the closing line; one retry on a malformed answer; the brief is written against the head of its base branch and records that commit | `brief prepare` checks a brief package | None found | Missing. The bridge does this outside the product. Writing against a pinned older build instead of the base-branch head was observed to cut work items whose files existed only on the base branch (OG-23) |
| G20 | A checked deploy of the build the driver runs: build at a recorded commit, run the suites, refuse while a merge is in progress, repoint atomically, verify the installed bytes | Nothing in the product | Remaining plan names a deploy step for the conductor only in passing | Missing (OG-24) |
| G21 | Batch merges on the base branch: several ready PRs tested together, with split, dissolve and park rules when the batch fails | Nothing | Daemon-tick §3.3 describes one PR at a time | Missing, or a deliberate removal (D-OG8, OG-25) |
| G22 | Routing after a failed pass: fix rounds on a configured fix seat, a review seat that never wrote the code, and a cap on review-and-fix rounds before the run parks | Seat plans; conducted fix rounds and review receipts | Conductor plan K-series | Parity unknown: some of this runs in the conductor today, some in the bridge. Needs an audit before it is listed as covered (OG-26) |
| G23 | A journal written by an older build replays on a newer one; key formats change only with a reader for the old form | The key parser reads the previous collect-key form | None found | Missing as a rule with tests. The collect key changed format on 2026-11-05 (OG-27) |
| G24 | Health of self-hosted CI runner slots is checked and reported | Nothing | None found | Missing. A slot that is down slows every PR without any park (OG-28) |

## 3. Shape

Three rules shape the work.

1. **The conductor owns runs; the daemon owns the merge pass.** The daemon tick (daemon-tick §3.1) carries the merge pass, the notifier and the replan digest. The conductor's driver stays `conductor run --live` (D-DT1). The driver lock (OG-2) is a property of the driver, not of the daemon.
2. **Every one-way action has a durable intent before it and a reconciliation after it.** This is already the journal rule (conductor §3.2). Chain landing, merge and thread resolution follow it.
3. **Product code carries mechanisms; the installation file carries values.** Chain names, merge policy, seat choices and notification targets are installation values. The allow-list of acceptance argv (OG-3) is a product rule.

### 3.1 Driver safety (G5, G6)

One driver per state directory. `conductor run --live` takes a driver lease (existing `ConductorDriverLeaseAdapter`), refuses to start while another live driver holds it, and re-reads the set of run ids between passes so a run added with `conductor start` is picked up without a restart. A stale lease is reclaimed only after its liveness check fails.

Acceptance commands and brief argv are checked by `brief prepare` against an allow-list (a shell is never invoked; argv[0] must be on the list). `conductor start` prints the refusal reason from the brief check, not a redacted code.

### 3.2 Merge path (G1, G2, G3, G14)

The merge pass is the daemon job already described in daemon-tick §3.3. Its prerequisites are KS1 (transition table), KS7 (premerge post and enable auto-merge at head) and OS-1 (Tier 2 hold). Two additions:

- The premerge status is re-posted on every head change of a PR the train touches, as an acceptance criterion of KS7 (OG-5).
- If D-OG4 is accepted, a branch update that leaves the PR's own patch identical carries the premerge status. The patch identity is computed as in the bridge's rule: the patch of the PR against its merge base, with whitespace and three context lines kept. A changed patch never carries.

The halt marker (lanes-board-and-killall) pauses the merge pass before any merge call. A merge call already sent completes and is reported.

### 3.3 Chains (G4)

A chain is a work-order `baseBranch` of the form `chain/<name>` (CB1) plus three operations, each an intent in the journal:

- **start**: create `chain/<name>` from `main` and record it.
- **refresh**: after every merge to `main`, merge `main` into each open chain branch through the forge's branch update, never by local git (daemon-tick §3.6). A conflict becomes an attention item and blocks landing.
- **land**: when every link is merged into the chain, open one integration PR `chain/<name>` → `main`. Its body lists each link's evidence. It requires `gate` and `premerge` on its exact head.

Each base is served serially by the merge pass; different bases proceed in parallel (conductor plan §3.6). Cleanup after landing deletes the chain branch, the link branches and their worktrees, and archives the chain record. Until a ruleset covers `refs/heads/chain/**` (an owner setting, D-OG7), the merge pass is the only enforcer, so the pass must refuse chain merges that fail any check.

### 3.4 Operator helpers (G7, G9, G10, G11)

- A thread helper `fleet-v2 forge threads` lists, replies from a file, and resolves, one call each. It is operator-run in v1 and never called by the daemon (D-OG2).
- Notifications use E4. The notifier job in the daemon tick is its only caller.
- Seat rotation is a policy in the installation file (onboarding-and-init). The bridge's rotation is replaced by that policy, not ported.
- Telemetry rows use the existing usage record and OT5's native emission.

### 3.5 Retirement

The bridge retires in stages, each gated by evidence rather than by date:

1. **Shadow.** The daemon merge pass runs in dry-run beside the bridge; its would-merge set is compared with what the bridge merged, for three days (daemon-tick §4.3 criteria).
2. **Parity.** Every bridge capability in §2 is either a fleet-v2 command with a test, or a deliberate removal recorded in §7.
3. **Cutover.** Conducted runs and the merge pass run from fleet-v2 alone. The bridge's scripts are kept in the private repository for one release, then removed.

## 4. Ops

- **Single operator host first.** The daemon runs under the operator's supervisor (launchd or systemd) as one tick job (daemon-tick §4.1). No second scheduler.
- **Secrets.** Forge and notifier tokens are read from files at call time, never from argv or logs, as the bridge does. The token files are the owner's to place.
- **Logs.** Events are written as intent-then-result rows, with no secret values (conductor §3.2).
- **No bridge in the product.** A release of fleet-v2 never ships or calls the bridge's scripts.

## 5. Workbook

Tiers follow the house style: T0 is documentation or tooling with no product code, T1 is a brief of about 45 minutes, T2 is a larger change that needs a full review. Waves refer to `2026-10-31_remaining-work-plan.md`. "Hand-run" means an operator runs the lane without the conductor, as the remaining-work plan does for its early waves.

| ID | Unit | Gap | Tier | Wave | Depends | Acceptance |
|---|---|---|---|---|---|---|
| OG-0 | This plan, decisions recorded in §7 | all | T0 | 0 | — | Owner records D-OG1–D-OG7 |
| OG-1 | Add a forge-binary path probe to doctor (P1) | G8 | T1 | W4 | P1 | Doctor prints the exact fix line when the configured path is missing; no secret in output |
| OG-2 | Driver lease with liveness check; run-id re-read between passes; refusal while another driver holds the lease | G5 | T2 | W3, after K11a | O9 | Two drivers on one state directory: the second refuses; a stale lease is reclaimed only after the liveness check fails; a run added mid-session is picked up |
| OG-3 | Acceptance argv allow-list in `brief prepare`; `conductor start` prints the real refusal reason | G6 | T1 | W2 | — | A shell invocation is refused; an allowed argv is accepted; the refusal names the rule |
| OG-4 | Premerge re-post on every head change of a train-touched PR (KS7 acceptance) | G2 | T1 | W1, with KS7 | KS7 | A new head gets `premerge` before the pass considers it |
| OG-5 | Patch-identity carry of premerge after a branch update (if D-OG4 accepted) | G3 | T2 | W1, after OG-4 | OG-4, D-OG4 | An unchanged patch carries; a changed patch, an empty patch identity or a non-success status does not |
| OG-6 | Chain start, refresh and landing as journalled intents; refresh through the forge only | G4 | T2 | W3 | CB1, K6 | Refresh after a `main` merge updates every open chain; a conflict parks with an attention item; landing refuses when a link lacks evidence |
| OG-7 | Merge pass refuses chain merges failing `gate`, `premerge`, threads or up-to-date | G4 | T2 | W3 | OG-6, D-DT8 | A chain PR missing any check does not merge, with a test per check |
| OG-8 | `fleet-v2 forge threads` (list, reply from file, resolve), operator-run | G7 | T1 | W5 | T3a | Reply and resolve happen in one call each; the daemon has no call path to it (test) |
| OG-9 | Restore the cited single-copy ocm-run plan, or re-state it in this plan's successor; hash-pin the one copy | G12 | T0 | W0 | — | The referenced file exists in `docs/planning/`; `scripts/ocm-run-hash.txt` matches the one copy |
| OG-10 | Install and migration notes: what a bridge user keeps, moves or deletes | G13 | T0 | W7 | OG-19 | `docs/runbooks` gets a migration page; `installation.example` has the values a bridge user needs |
| OG-11 | Merge pass in shadow beside the bridge; comparison report | G1 | T2 | W1 | KS7, daemon-tick §4 | Three days of shadow runs; the would-merge set matches the bridge's merges or each difference is explained |
| OG-12 | Owner notifications on park, merge and drop (E4 earlier, if D-OG5) | G9 | T2 | W6 (or W2 if pulled) | E4 | Each park, merge and drop emits one notification; a failed send is recorded and retried, never silent |
| OG-13 | Seat rotation policy in the installation file, with the rotation rule in the loader | G10 | T1 | W4 | onboarding-and-init | A seat outage moves to the next seat in the policy; rotation is tested with fixtures |
| OG-14 | Lane usage row format for the telemetry log, aligned with the usage record | G11 | T1 | W4 | OT5 | A finished attempt writes one row with the fields in the telemetry plan |
| OG-15 | Halt and pause wired into the merge pass and chain operations | G14 | T1 | W5 | lanes-board-and-killall, OG-11 | Halt before a merge stops it; a merge sent before the marker completes and is reported |
| OG-16 | Jev veto shadow adapter in the merge pass (log only) | G15 | T1 | W7 | daemon-tick §3.4, Jev decision | A shadow row per merge; no effect on the decision |
| OG-17 | Bridge retirement: parity check, cutover, removal of bridge scripts from the operator's path | all | T2 | W7 | OG-11, OG-15, OG-6, OG-7, OG-20, OG-21, OG-22, OG-23, OG-24, OG-27 | §3.5 stages 2 and 3 complete; the parity report is in `docs/runbooks` |
| OG-18 | Public-safety check: no host, path, token or seat value in any product file | all | T0 | every wave | — | The check runs in the gate and fails on a match from a list the owner maintains outside the repository |
| OG-19 | Installation values for chains, merge policy and notifications | G10, G13 | T1 | W4 | D-OG3 | Values load and validate; no value is required by the product's defaults |
| OG-20 | Stuck-run report in the driver: a live run whose state, park reason and round are unchanged for a set time (an installation value) is reported once per period | G16 | T1 | W3 | OG-2 | A fixture run held in one state past the limit is reported; a terminal or parked run never is; a changed state resets the timer |
| OG-21 | A graceful stop takes effect at the next step boundary; a run in collect with no live attempt is at a boundary | G17 | T2 | W3 | — | A run stuck in collect stops on a graceful stop within one pass; a run with a live attempt waits for the attempt to end |
| OG-22 | Orphaned-reservation detection and release, each release a journalled intent | G18 | T2 | W3 | O9 | A reservation with no live run is reported, then released by an explicit command; a reservation of a live run is never released |
| OG-23 | Brief structure check before registration, one retry on a malformed answer, brief written against the base-branch head with that commit recorded | G19 | T1 | W2, with OG-3 | OG-3 | Each structural fault is refused with its rule named; a narration line before the first marker gets one retry; the recorded commit is the base-branch head at writing time |
| OG-24 | Checked deploy of the driver's build | G20 | T1 | W4 | — | A deploy during a merge is refused; a failing suite leaves the previous build in place; the installed bytes match the built ones |
| OG-25 | Batch merges in the merge pass (if D-OG8 keeps them) | G21 | T2 | W5 | OG-11, D-OG8 | A failing batch splits; a batch that cannot split parks each member with a reason; a passing batch merges in order |
| OG-26 | Parity audit of fix-round and review-seat routing between the conductor and the bridge | G22 | T0 | W0 | — | A table in this plan's successor lists each routing rule as product, installation value or removal |
| OG-27 | Journal compatibility rule and fixtures: one fixture per released key format replays and advances on the current build | G23 | T1 | W3 | — | Every fixture replays; a key format change without an old-form reader fails the gate |
| OG-28 | Doctor reports CI runner slots that are not active | G24 | T1 | W4 | P1 | A down slot is reported with its name and the fix line; no token in output |

**Ordering.** W0 documents, the single-copy plan and the routing audit (OG-0, OG-9, OG-26). W1 the merge path and shadow (OG-4, OG-5, OG-11), which the remaining plan already puts first. W2 the allow-list and the brief check (OG-3, OG-23). W3 driver safety, run recovery, journal compatibility and chains (OG-2, OG-20, OG-21, OG-22, OG-27, OG-6, OG-7). W4 doctor, seats, telemetry, values, deploy and runner health (OG-1, OG-13, OG-14, OG-19, OG-24, OG-28). W5 threads, halt and batches (OG-8, OG-15, OG-25). W6 notifications (OG-12). W7 retirement (OG-10, OG-16, OG-17). OG-18 runs in every gate.

## 6. Hard to undo

- **Retiring the bridge.** Once the bridge's scripts are removed from the operator's path, a regression means rebuilding them. Stage 3 waits for the parity report and a clean shadow window.
- **Chain landing.** A landed integration PR is a one-way merge. OG-7 must have tests for each check before OG-6 lands anything to `main`.
- **Premerge carry (OG-5).** A carry that is wrong lets an unreviewed change through. It is off until D-OG4 is accepted and has its own shadow window.
- **The allow-list (OG-3).** A too-strict list blocks legitimate briefs; a too-loose one defeats its purpose. Start with the current bridge's accepted argv set, recorded in fixtures, and widen only by a reviewed change.

## 7. Decisions for the owner

| Id | Decision | Recommendation | Why it matters |
|---|---|---|---|
| D-OG1 | Keep the bridge running beside fleet-v2 until shadow parity, then retire it | Yes, retire in three stages (§3.5); no retirement by date | Avoids a gap in merges |
| D-OG2 | Who resolves review threads | Operator, through the helper; the daemon never resolves | Daemon plan §3.6 already rules out daemon resolution |
| D-OG3 | Chain mechanics in fleet-v2 or private | In fleet-v2 (OG-6, OG-7): the mechanism is generic. Chain names, policy and any owner-only steps stay in the installation file | Chains are useful to any user of the product |
| D-OG4 | Carry premerge across a branch update when the PR's patch is unchanged | Accept, behind a flag, with a shadow window; off by default | Removes parks on generated shared files; the risk is a stale receipt |
| D-OG5 | Pull notifications (E4) earlier from W6 to W2 | Pull earlier only if the bridge's notifications are needed during W2–W5; otherwise keep W6 | Affects how fast a park is seen |
| D-OG6 | Who owns seat rotation | The installation policy in fleet-v2 owns the rule; the operator's probe stays a probe | One rule, one place |
| D-OG7 | Ruleset for `refs/heads/chain/**` | Owner setting, applied after OG-7; until then the merge pass is the only enforcer and must refuse chain merges that fail a check | Two enforcers are safer than one |
| D-OG8 | Batch merges in v1, or one PR at a time | One at a time in v1 (daemon-tick §3.3); batches as OG-25 after the shadow window, if merge throughput needs them | Batches raise throughput but add split and park rules, and a wrong split can park good PRs |

## 8. Assumptions

- The daemon merge pass (daemon-tick) is built before OG-11 starts. If not, OG-11 waits.
- KS1, KS5 and KS7 land as the speed plan describes. KS5 (file-level admission) is needed before conducted lanes run in parallel within a package.
- The forge exposes what `forge execute` needs for chain branches (branch update, check reads). Not verified against the current forge adapter.
- The bridge's parity list in §2 is complete for the owner's use. It was compiled from reading the bridge, not from a run-by-run comparison.
- A new user has no bridge. This plan's end state works without it, so no user-facing step depends on it.

## 9. Challenge this

- Is OG-11 (shadow beside the bridge) worth a separate lane, or is the daemon's own dry-run enough? A separate report makes the comparison explicit; a dry-run may be cheaper.
- Is chain landing needed for a first public release, or can v1 land chains by hand from a documented procedure? Landing is the riskiest one-way step in this plan.
- The gap list in §2 came from one reading of the bridge. A second reader should check it for missed capabilities before the plan is accepted.

## 10. Review record

- Rev 1, 2026-11-05. Adds G16–G24, OG-20–OG-28 and D-OG8, and corrects G5 (two locks today). Sources: an operator's reading of the bridge's failure log and two days of conducted runs; the generic capability is stated, not the incidents. Not reviewed.
- Rev 0, 2026-11-05. Not reviewed. Before any lane from this plan is accepted, it needs an independent review that checks §2 against the bridge and the open decisions in §7.
