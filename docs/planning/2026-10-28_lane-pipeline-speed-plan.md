# Plan: lane pipeline speed, from ~45–75 min (Tier 1) and ~2–3 h (Tier 2) to ~17 min and ~25–30 min

- **Date:** 2026-10-28
- **Target repository:** `fleet-v2` (repository configuration in Horizon A, conductor amendments in Horizon B). The orchestrator's own scripts live outside this repository: they are listed so the plan is whole, but they are not lanes here. The incremental `sync --check` is a work order against `hexagen-monaco` (§3.4).
- **Status:** rev 0. The improvements were reviewed by Fable in two passes before this plan was written (§8): one on today's orchestration, one on the pipeline once the conductor is built. This plan is the write-up of both. Nothing built. Decisions D19–D32 (§6) continue the conductor plan's numbering (its last is D18) and are open with recommended defaults. Anchors checked against `origin/main` at `50adfde`.
- **Owner request (2026-10-28):** "Ask fable to review the improvements. Then write up a plan." and "how could we get lanes down to 15-20m total time, once the orchestrator lane is implemented".
- **Short answer.** Tier 1 can reach about **17 minutes p50** once the conductor runs it (floor about 13, about 23 with one fix round). Tier 2 cannot reach 15–20 minutes without dropping the independent review or the Fable pass, which this plan does not do: its floor is about **23 minutes** with no fix round and about **29 minutes p50** with one. The honest ways to get more lanes under 20 minutes are smaller scope per lane and classifying work as Tier 1 where it truly is.
- **Amends:** `2026-10-27_conductor-plan.md` §3.2 (states), §3.6 (admission, merge train), D3, D6 and the K4, K5, K6, K7 and K9 rows. Each amendment is marked there by the lane that builds it, in the conductor plan's style.

## 1. Goal

Cut a lane's wall time from frozen brief to merge without weakening what a merge requires. Today about three quarters of a lane is fixed overhead around a 14-minute agent session. The plan removes that overhead in two horizons:

- **Horizon A (now):** the orchestrator's scripts and this repository's configuration. Caches, concurrency inside the gate, the review beside the gate, no second gate before the PR, and a merge path that tests the merged result once instead of twice. Target: Tier 1 about 25–30 minutes, Tier 2 about 60–75 minutes (estimates, §2.3).
- **Horizon B (with the conductor):** the conductor does what the orchestrator does by hand, with no turnaround, from a warm worktree, with gate receipts keyed by tree hash and pipelined admission. Target: Tier 1 about 17 minutes p50, Tier 2 about 29 minutes p50 (§3.6).

**Non-goals.**
- No review is removed, and no review runs on a seat that implemented the lane. Every Tier 1 and Tier 2 lane keeps one independent non-implementer review; every Tier 2 lane keeps its one Fable pass before merge.
- CI is not reduced. The full suite runs on the merged result of every lane before or at its merge.
- No new seat, model or provider. The 20-second dispatch stagger stays (§3.5).
- No change to the fix-round cap of two, the parks at one-way doors, `lane-diff-check` on every head, or sealed artefacts before any gate reads them.

## 2. Current state (measured 2026-10-28)

### 2.1 Measured

| Stage | Measured | Sample, note |
|---|---|---|
| Lane agent session | median **14 min**, mean 18, p90 33 | 86 sessions |
| PR open → merge | median **8 min**, mean 12 | 101 PRs; CI plus the orchestrator's merge |
| Worktree prep (`yarn install` + full build) | 2–4 min | per lane, cold `node_modules` and no shared build cache |
| Dispatch stagger and gate sleeps | 30–210 s | fixed sleeps, at about 15% of the lane host's thread budget |
| Local gate: `yarn build` | 1–2 min | no shared turbo cache between worktrees |
| Local gate: `yarn typecheck` | 6–7 s | |
| Local gate: `yarn lint` | 7–8 s | |
| Local gate: `yarn lint:arch` | 7–8 s | |
| Local gate: `yarn sync:check` (`hexagen sync --check --allow-dirty`) | **145–160 s** | the longest gate step; runs last, in sequence |
| Local gate: tests per workspace | 15–30 s | |
| Local gate, total | **4–5 min** | every step in sequence |
| Review (brief check or code review) | 3–6 min | starts only after the gate passes |
| Orchestrator turnaround | 5–20 min per lane | reading results, writing the next step by hand |
| Rebase + second full gate before every PR | 4–5 min | gate #2 repeats gate #1 on the rebased head |
| CI, last green `main` run | **about 7.5 min** (runs take 6–9 min end to end) | one job, in sequence: checkout, setup and install about 17 s, build 36 s, typecheck 14 s, lint 19 s, `lint:arch` 4 s, test 44 s, `sync:check` 82 s, shell tests (`yarn test:bin`, every `tests/*.test.sh`) **191 s** |

### 2.2 Where the time goes today

| Tier 1 lane, p50 | Minutes |
|---|---|
| Worktree prep | 3 |
| Dispatch stagger | 1 |
| Agent session | 14 |
| Gate #1 | 4.5 |
| Review, after the gate | 4.5 |
| Orchestrator turnaround | 10 (5–20) |
| Rebase + gate #2 | 4.5 |
| PR → merge (CI, merge) | 8 |
| **Total** | **about 50 (45–75)** |

About 36 of the 50 minutes are not the agent's work. Tier 2 adds a brief check, usually one fix round (a fresh session, a gate and a re-review: about 25–30 minutes), a Fable pass before the PR, and more turnaround: **about 2–3 hours**.

### 2.3 What the repository does today

| Item | Today | Anchor |
|---|---|---|
| CI | One `gate` job (the ruleset's required check): install, fixture parity, build, typecheck, lint, `lint:arch`, test, `sync:check`, `test:bin`, all in sequence; `actions/setup-node@v4` with no package cache and no turbo cache; triggers `pull_request`, `push` to `main`, `workflow_dispatch`; no `merge_group`. `OCM_IT_REQUIRE=1` is read by the vitest integration suite `execution-runner-ocm-run.integration.test.ts` in `work-execution` (part of `yarn test`), not by a shell test | `.github/workflows/gate.yml` |
| Shell tests | `scripts/test-bin.sh` checks the two runner script pins, then runs the eight `tests/*.test.sh` in sorted order and stops at the first failure; it takes no shard or file-list argument | `scripts/test-bin.sh`, `tests/` |
| Turbo | `build`, `lint`, `typecheck`, `test` cached; no `globalDependencies`, no declared `env`; cache in each worktree's `.turbo/` | `turbo.json`; `.gitignore` |
| Yarn | `nodeLinker: node-modules`, nothing else; the lane host forces the classic `nmMode` by environment, which overrides the file | `.yarnrc.yml` |
| Scripts | `sync:check` = `hexagen sync --check --allow-dirty`; `lint:arch` = `hexagen arch validate`; neither is a turbo task | `package.json` |
| hexagen | `@hexagen-monaco/sync` and `arch-linter` pinned at `0.14.0` | `package.json` |
| Ruleset on `main` | `strict_required_status_checks_policy: false` (CI tests the PR head, not the merged result); repository `allow_auto_merge: false` | owner settings |
| Gate in the conductor | `EvaluateAttemptGatePort` runs the frozen gate at the collected head, predicates in order, stops at the first non-pass, and stores one outcome per head | `RequestAttemptAcceptanceUseCase.use-case.ts` (K4-2, #313) |
| Protected paths | `.github/`, `.yarnrc.yml`, every `package.json`, `scripts/`, `bin/` are protected: a lane's diff touching them is a `lane-diff-check` finding | `scripts/lane-diff-check.protected` |

The last row decides who makes Horizon A's repository changes: workflows, Yarn configuration and package manifests are **orchestrator changes (Tier 0)**, never lane output. Only `turbo.json` is open to a lane, and its change is small enough to be Tier 0 too.

## 3. Design

### 3.1 Fable's first review: today's orchestration

Fable found the overhead at about 75% of a lane and ranked nine improvements. Summarised faithfully:

1. **Lane sizing.** While the fixed overhead is about 40 minutes and the work 14, put **2–3 units in one lane**. (Horizon B reverses this; §3.6.)
2. **Shared caches on the lane host.** A shared `TURBO_CACHE_DIR` for every worktree of a project, and Yarn's global cache with `nmMode: hardlinks-global`, so worktree prep and gate builds stop rebuilding what another worktree already built.
3. **`sync:check` concurrently** with typecheck, lint and tests in the gate, and **dropped from the Tier 1 local gate**. The owner's tier rule already allows targeted local checks for Tier 1; CI keeps `sync:check`.
4. **The review in parallel with gate #1.** The reviewer is told "gate pending"; its result is acted on only after the gate passes.
5. **Push the PR right after the rebase**, with gate #2 as a non-blocking early warning. Better: a **GitHub merge queue** with `on: merge_group` and auto-merge, which deletes the rebase and gate #2 from the hot path. Today the ruleset's `strict_required_status_checks_policy` is false, so CI tests the head and not the merge, and `allow_auto_merge` is false.
6. **A `flock` slot semaphore** (8 slots) instead of the gate's sleeps. **Keep the 20-second dispatch stagger** (the lane server's sqlite lock).
7. **One chained script per lane**: gate → review → rebase → PR → watch, which stops on any finding, never writes a fix brief, and **holds a Tier 2 merge until the Fable receipt**. Today the watch script auto-merges on a clean PR state. Also: parse the gate's result from the full log, not its tail.
8. **Incremental `sync --check`** in hexagen: `--since <ref>` with dependency fan-out, or an input-hash cache. `--only` has no fan-out (§3.4).
9. **CI:** `setup-node` with the Yarn cache, and the job split in parallel jobs.

Fable would **not**: drop the 20-second dispatch stagger; skip gate #2 silently without CI on the merged result; auto-merge Tier 2 before Fable; let a script author fix briefs; put a remote-cache token in public CI; reduce CI.

### 3.2 Horizon A: what changes, and where

| # | Change | Where | Saves (p50, est.) | Tier, who |
|---|---|---|---|---|
| A-1 | **Tier 2 merge hold**: the watch step never merges a Tier 2 PR without a Fable receipt for its head | orchestrator scripts | — (safety; first) | orchestrator |
| A-2 | Slot semaphore with 8 slots replaces the gate's sleeps; the 20 s dispatch stagger stays | orchestrator scripts | 0.5–3 | orchestrator |
| A-3 | Gate steps concurrent: `turbo run build typecheck lint test` in one invocation, `lint:arch` and `sync:check` beside it; Tier 1 drops `sync:check` locally unless the diff touches `.architecture/` or a `@generated` file (D26) | orchestrator scripts | 2–3 | orchestrator |
| A-4 | Shared turbo cache per project on the lane host, written only by the gate's process (D27) | lane host environment; `turbo.json` declares its inputs (A-R2) | 1–2 (prep and build) | orchestrator; owner for host environment |
| A-5 | Review starts with gate #1 on the sealed diff, marked "gate pending"; consumed only after PASS (D19) | orchestrator scripts | 3–5 | orchestrator |
| A-6 | One chained script per lane; stops on any finding; never writes a fix brief; result read from the full log | orchestrator scripts | 5–15 (turnaround) | orchestrator |
| A-7 | No second blocking gate: with a merge queue, no local rebase at all (D21, D24); without one, D22's fallback | owner settings, A-R1 | 4–5 | owner, orchestrator |
| A-8 | CI sharded into parallel jobs behind an aggregate `gate` job, Yarn and turbo caches, `merge_group` trigger (D32, §3.2.3) | `.github/workflows/gate.yml`, `scripts/test-bin.sh` (A-R1) | 4.5–5 (CI: about 7.5 → 2.5–3) | orchestrator, Tier 0/1 |
| A-9 | Lane sizing: 2–3 units per lane while overhead is high (D25) | briefs | amortises overhead | orchestrator |
| A-10 | Incremental `sync --check` (hexagen work order) | hexagen-monaco (§3.4) | 2–2.5 per gate where it still runs | hexagen |

**Horizon A estimate, Tier 1 p50:** prep 1 + stagger 0.3 + session 14 + (gate 1.5 ∥ review 4) 4 + chained turnaround 1 + push and sharded CI on the merged result about 4 = **about 24 minutes**, against about 50 today. Tier 2 adds the brief check (in the same window as the gate), one fix round at about 12 minutes and the Fable pass at about 8: **about 50–75 minutes**. These are estimates built from the measured stages; §7 says what is unmeasured.

**What Horizon A does not fix:** the agent session is still 14 minutes, and the orchestrator is still in the loop between lanes. Those are Horizon B's.

#### 3.2.1 The two sizing rules are not in conflict

Fable's first review packs 2–3 units into a lane because each lane pays about 40 minutes of fixed overhead. Its second review asks for 1–2 units because, with the conductor, the overhead is about 5 minutes and the session dominates; a smaller lane finishes, gates and reviews faster, and a fix round costs less. The rule follows the overhead: **2–3 units per lane in Horizon A, 1–2 units in Horizon B** (D25). The switch is made when a measured week of conducted Tier 1 lanes shows fixed overhead under 10 minutes.

#### 3.2.2 Shared caches: what is safe

- **Turbo cache.** A shared cache is sound only if every input a task reads is in its hash. `turbo.json` today declares no `globalDependencies` and no `env`. A-R2 declares the root inputs (`.nvmrc`, the root `tsconfig*.json`, `.architecture/manifest.yaml` for tasks that read it, `yarn.lock`) and the environment variables tests read, so a shared hit is the same result a local run would give. Turbo 2's strict environment mode already withholds undeclared variables from tasks; A-R2 makes that a deliberate list.
- **Who writes it.** Only the gate's process sets `TURBO_CACHE_DIR`; the lane server's environment does not. A lane building in its worktree writes its own `.turbo/`. So a lane cannot plant a cache entry another worktree's gate would replay. This keeps `AGENTS.md`'s "workers are disposable and isolated". No remote cache and no token in public CI.
- **Yarn.** Yarn 4's global cache is already on by default; the gain Fable named is `nmMode: hardlinks-global`, which links every worktree's `node_modules` files to one store. **This plan recommends deferring it (D28)**, against Fable's ranking: hard links make one file writable from every worktree, so a lane that edits a file under `node_modules` changes it for every other worktree and for the gate, and `lane-diff-check` deliberately skips `node_modules`. Horizon B's warm worktree pool (§3.6) removes most of the install time without a shared writable store. The orchestrator raises this as its one divergence from Fable's review.

#### 3.2.3 CI sharding (measured, can start now)

The last green `main` run took about 7.5 minutes in one serial job (§2.1). The shell tests alone are 191 s and `sync:check` 82 s; neither needs to wait for the build, the typecheck or the vitest suites. A-R1 splits `gate.yml` into parallel jobs:

| Job | Steps | Expected |
|---|---|---|
| `build-test` | checkout, setup, install, build, typecheck, lint, `lint:arch`, test; keeps `OCM_IT_REQUIRE=1`, because the `ocm-run` integration suite it guards is a vitest test in `work-execution` (§2.3) | about 2.3 min |
| `sync` | checkout, setup, install, `sync:check` | about 1.7 min; **verify first** that `hexagen sync --check` reads no build output (run it on a fresh checkout with no `dist/`) |
| `shell` (matrix, 3–4 shards) | checkout, setup, install, model-family fixture parity (one shard), `scripts/test-bin.sh --shard <i>/<n>` | about 1–1.3 min each |
| `gate` (aggregate) | `needs:` every job above; fails unless every one succeeded (`if: always()` with an explicit check of each `needs.<job>.result`, so a skipped or cancelled shard is a failure, never a pass) | seconds |

**The required check's name stays `gate`.** The ruleset requires the aggregate job, so A-S2 (renaming required checks) is not needed and open PRs are not blocked by the switch. Expected wall time **about 2.5–3 minutes**, from about 7.5. Every check still runs on every PR; CI stays the single source of truth.

**`scripts/test-bin.sh` gains a shard argument** (`--shard <i>/<n>`, or an explicit file list). Shards split `tests/*.test.sh` by file in sorted order, balanced by the measured per-file times (the eight files are not equal; a greedy split by recorded duration beats round-robin). The pin checks of `bin/ocm-run` and `bin/agy-run` run in every shard (they take milliseconds), so no shard can pass with a broken pin. A run with no argument behaves exactly as today. The script is a protected path, so the orchestrator makes the change; it is one script and one workflow, Tier 0/1.

**Two verifications before it merges.**
- **No shell test depends on another's leftovers.** Today the files run in one order in one job; a test that reads a file or state another test left would pass serially and fail sharded. A-R1 runs each `tests/*.test.sh` alone on a fresh checkout once and records the result.
- **`sync:check` on a fresh checkout** (above).

**Caches.** `setup-node` with `cache: yarn` (after `corepack enable`, so the cache key resolves Yarn 4), and an `actions/cache` step for the turbo cache keyed by the OS, the lockfile hash and the commit, restoring from the newest entry with the same lockfile. The turbo cache in CI is only as sound as A-R2's declared inputs, so A-R2 lands first or in the same change; in particular `OCM_IT_REQUIRE` must be a declared `env` of `test`, or a cached test result from a run without it could stand in for the required integration suite. No remote cache and no token.

### 3.3 The merge path

Today every lane is rebased and gated a second time locally, then CI tests the PR head (not the merged result), then the orchestrator merges. With a merge queue:

1. The PR is opened right after the lane is accepted, with no local rebase.
2. PR CI runs on the head (fast checks, and in time the affected-only tests, D23).
3. The conductor (or, in Horizon A, the chained script) enables auto-merge at the expected head.
4. The queue builds the merged result and runs the **full** suite under `merge_group`. Green merges; red drops the PR from the queue, and the lane re-enters gating with the failure as a fix input.

The queue removes the rebase, gate #2 and the `branch-behind` park (conductor D6) from the hot path, and it tests what lands, which today nothing does before the merge.

**Availability is the first thing to verify.** GitHub offers merge queues on organisation-owned repositories; this repository is owned by a user account, and the queue may not be offered for it. A-0 checks this in the repository settings before anything depends on it. If the queue is not available, D22 applies:

- **D22 fallback.** PR CI stays the full suite on the head. The local rebase and gate #2 are dropped **only** for a lane whose touch list is disjoint from every file changed on `main` since its base (the chained script checks this with `git diff --name-only <base>..origin/main`); any overlap updates the branch through the forge and lets CI re-run, never a local second gate. The `push` to `main` CI run stays the net for the merged result, and a red `main` blocks new merges until it is green. Turning on `strict_required_status_checks_policy` instead would serialise every merge behind a branch update and a full CI run, which costs more than it saves at today's PR rate.

**Tier 2 under auto-merge.** Auto-merge on a Tier 2 lane needs the auto-merge plan's `allowHighRisk` and the merge hold of §3.5: the Fable receipt for the exact head is a merge predicate, so enabling auto-merge never bypasses it.

### 3.4 hexagen work order: incremental `sync --check`

`sync:check` is 145–160 s of a 4–5 minute gate. It regenerates every managed file to compare, whatever the diff touched.

| # | Work order (filed in `hexagen-monaco`; its session plans and runs it) | Acceptance |
|---|---|---|
| HS1 | `hexagen sync --check --since <ref>`: compute the managed outputs whose inputs (manifest sections, templates, generator version, hand-written sources a barrel lists) changed between `<ref>` and the working tree, **with dependency fan-out** (a changed manifest entry checks every output derived from it; a changed module checks the barrels that list it); check only those. `--only` today checks one target and has no fan-out, so it is not a substitute | On an unchanged manifest and a diff inside one module, under 10 s; a fixture where a manifest change reaches a barrel in another context is caught; `--since` with an unknown ref fails closed (full check) |
| HS2 | Alternative or complement: an input-hash cache, `--cache <dir>`, keyed by the hash of every input of the check plus the generator version; a hit skips the regeneration | Cache miss on any input change, including the generator version; a corrupt cache entry is a miss, never a pass |
| HS3 | A release of `@hexagen-monaco/sync` carrying HS1 (and HS2 if built), fanned out under the hexagen integration plan's release rule | fleet-v2 moves its pin from `0.14.0` in a Tier 0 change, with `sync:check` green |

Until HS3 lands, Horizon A runs `sync:check` concurrently with the other steps (A-3), so it costs its 150 s once in wall time instead of after everything else. CI always runs the full check, with or without `--since`.

### 3.5 What is not traded

From Fable's second review, adopted as constraints on every change in this plan:

- An independent non-implementer review on every Tier 1 and Tier 2 lane.
- One Fable pass on every Tier 2 lane before merge, at the exact head that merges.
- The full CI suite on the merged result.
- The 20-second dispatch stagger.
- The fix-round cap of two.
- Shared-file serialisation (manifest, barrels, `composition.ts`, `index.ts`).
- Parks at one-way doors.
- `lane-diff-check` on every head.
- Sealed artefacts before any gate reads them.

### 3.6 Horizon B: the pipeline with the conductor

Fable's second review gives this budget for a conducted lane (minutes, p50):

| Step | Tier 1 | Tier 2 |
|---|---|---|
| Admission, warm worktree, dispatch | 0.5 | 0.5 |
| First pass (1–2 unit brief) | 6 | 8 |
| Collect, seal, `lane-diff-check` | 0.5 | 0.5 |
| Gate (concurrent, cached by tree hash) ∥ brief check ∥ code review | 3 | 4 |
| Fix round | 0 at p50 (+6 when one runs) | +6 |
| Push, PR, PR CI ∥ Fable (Tier 2) with the merge hold | 5 | 8 |
| Merge queue CI on the merged result | 2 | 2 |
| **Total** | **about 17** (floor about 13; about 23 with a fix round) | **about 29** (floor about 23 with no fix round) |

**15–20 minutes for Tier 2 is not reachable** without removing the review or the Fable pass. The two honest levers are smaller scope (a Tier 2 change cut into a Tier 2 core and Tier 1 follow-ups) and classifying work truthfully: a test-only or behaviour-free lane that is filed as Tier 2 out of habit is a Tier 1 lane.

**The 6-minute first pass is a target, not a measurement.** Today's median session is 14 minutes at today's lane sizes. If sessions stay at 14 minutes, a conducted Tier 1 lane is about 25 minutes. The first pass reaches 6–8 minutes only with D25's sizing: **1–2 units, one package, about 6 files or fewer, at most 8 work-order steps**.

#### 3.6.1 What the conductor must do to reach it

1. **Warm worktree pool per project** (`WorktreePoolPort`, new). Worktrees are created, installed and built ahead of admission, at `origin/main`, and refilled after each merge; admission takes one and resets it to the run's base. Prep leaves the hot path.
2. **Gate predicates as one run.** One `turbo run` over the affected workspaces for build, typecheck, lint and test, with `lint:arch` and `sync:check` concurrent beside it, under the host-wide slot budget. **Receipts keyed by (predicate, tree hash)**: a head whose tree equals an already-gated tree reuses the receipt, so a no-op rebase or a re-push never gates twice.
3. **Reviews start from the sealed diff**, in `gating`, and are consumed only after the gate passes (D19). A gate failure goes to a fix round whose brief carries the gate's failures **and** any review findings already recorded; the next review is on the delta.
4. **Fix rounds are tiny fresh sessions** on the numbered findings only, and the re-review reads the fix delta against its own list.
5. **The PR opens right after acceptance**, with no local rebase.
6. **CI split, cached, with `merge_group`** (Horizon A, A-R1). Affected-only PR tests are acceptable only when `merge_group` runs the full suite (D23).
7. **Merge = enable auto-merge at the expected head.** The queue merges; the conductor watches.
8. **Fable after the PR, concurrent with CI** (D20), with a merge-hold predicate `premerge-receipt(head)`. A Fable finding pushes a new head through a fix round, which re-enters gating; the hold is per head, so a pass on an old head never releases a new one.
9. **Pipelined admission.** Lane N+1 is admitted when its declared touch list is disjoint from every unmerged lane's, and shared files (`.architecture/manifest.yaml`, `@generated` barrels, `apps/cli/src/composition.ts`, `apps/cli/src/index.ts`, `apps/api` wiring) serialise on a **per-file lock** held from admission to merge (D30). This replaces "one active run per package" (§3.6 of the conductor plan) with a finer rule that admits more lanes, not fewer.

#### 3.6.2 Conductor amendments

| Conductor item | Amendment |
|---|---|
| §3.2 `gating`, `brief-check`, `code-review` | A run in `gating` may hold **reviews in flight**: brief-check and code-review intents keyed at the sealed head (`<runId>/r<round>/review/<kind>/<seat>@<head12>`) are appended on entry to `gating`. Exits are unchanged in meaning: `brief-check` and `code-review` read the receipts already recorded instead of requesting them. A receipt for a head the gate failed is kept and passed to the fix brief; it never accepts a head |
| §3.2 `accepting`, `awaiting-premerge`, `opening-pr` | Tier 2 goes `accepting` → `opening-pr` → `watching-ci`, with the pre-merge request appended at `opening-pr`. `awaiting-premerge` becomes a **merge hold** read in `merging`: no `merging` action until `premerge-receipt(head)` is a pass. Amends D3 (D20) |
| §3.2 `merging` | The merge action is **enable auto-merge at the expected head**; `merged` is entered when the forge reports the merge at that head. `CiStatePort` gains `queued` and `merge-group` states (D21) |
| §3.6 admission | File-level disjointness and per-file locks (D30) replace one active run per package; the host-wide gate budget and the global cap stay |
| §3.6 merge train, D6 | With a merge queue, `branch-behind` is not reached and the park is removed; without one, D22's fallback applies and D6 stands for overlapping lanes |
| K4 | `GatePort` receipts keyed by (predicate, tree hash); predicates run concurrently under the slot budget (today `EvaluateAttemptGatePort` runs them in order and stops at the first non-pass; the concurrent form still reports the first non-pass in declared order, so the typed verdict of K4-2 is unchanged); `WorktreePoolPort`; file-level admission disjointness |
| K5 | Reviews may start in `gating` (the reviews-in-flight set); the fix brief is rendered from review findings plus gate deltas; re-review on the delta |
| K6 | `awaiting-premerge` overlapped with `watching-ci` under the merge hold; `CiStatePort` `queued`/`merge-group`; merge action = enable auto-merge at the expected head; the `branch-behind` park removed when the queue is on |
| K7 | Poll floor **10 s** in `watching-ci` and `merging` (today the driver backs off from 30 s to 2 min, §3.1 of the conductor plan); other states keep the back-off (D31) |
| K9 | `/v1/changes` wake-ups matter more once every other wait is short; K9 moves up the queue, still under D9 |

## 4. Workbook

Each Horizon B lane is sized to Horizon B's own rule where it can be (1–2 units); the conductor plan's "about 45 minutes" applies to the larger ones. **Start now** marks what has no unmet dependency.

### 4.1 Horizon A, repository side (orchestrator changes, Tier 0)

Protected paths: these are made by the orchestrator, not by a lane (§2.3).

| # | Scope | Files | Tier | After | Start now |
|---|---|---|---|---|---|
| A-0 | Verify whether a merge queue is offered for this repository; record the answer here | owner settings (read) | 0 | — | **yes** |
| A-R2 | `turbo.json`: `globalDependencies` (`.nvmrc`, root `tsconfig*.json`, `yarn.lock`), declared `env` for tests (including `OCM_IT_REQUIRE`), inputs for tasks that read the manifest | `turbo.json` | 0 | — | **yes** |
| A-R1 | CI sharding (§3.2.3): jobs `build-test`, `sync`, a `shell` matrix of 3–4 shards and the aggregate `gate` that `needs:` them all; `corepack enable` before `setup-node` with `cache: yarn`; `actions/cache` for turbo; `scripts/test-bin.sh --shard <i>/<n>`; `merge_group` trigger (inert until a queue exists); the concurrency group unchanged for `pull_request` and not cancelling `merge_group` runs. Before merge: each shell test passes alone on a fresh checkout, and `sync:check` passes with no build output. Measured target: about 7.5 → 2.5–3 min | `.github/workflows/gate.yml`, `scripts/test-bin.sh` | 0/1 | A-R2 (same change or before); D32 | **yes** |
| A-R3 | `.yarnrc.yml` `nmMode` | `.yarnrc.yml` | 0 | D28 (default: not now) | no |
| A-R4 | Affected-only PR tests: `turbo run test --filter=...[origin/main]`, checkout `fetch-depth: 0`; the `merge_group` run stays full | `.github/workflows/gate.yml` | 0 | A-R1, A-S1 live, D23 | no |
| A-S1 | Owner settings: `allow_auto_merge: true`; merge queue on the `main` ruleset (if A-0 says it exists) | owner | — | D21, A-0, A-R1 | no |
| A-S2 | Not needed while the aggregate job keeps the name `gate`; only if the owner prefers to require each job by name | owner | — | A-R1 | — |

### 4.2 Horizon A, orchestrator scripts (outside this repository; listed, not lanes here)

| # | Scope | After | Start now |
|---|---|---|---|
| OS-1 | Tier 2 merge hold in the watch step: never merge a Tier 2 PR without a Fable receipt for the exact head (A-1) | — | **yes, first** |
| OS-2 | Slot semaphore (8 slots) replaces gate sleeps; dispatch stagger kept at 20 s | — | **yes** |
| OS-3 | Concurrent gate steps; Tier 1 without local `sync:check` unless the diff touches `.architecture/` or a `@generated` file; gate result parsed from the full log | D26 | **yes** |
| OS-4 | Gate-only shared `TURBO_CACHE_DIR` per project on the lane host | A-R2, D27; the owner sets the host environment | after A-R2 |
| OS-5 | Review started with gate #1, "gate pending", consumed only after PASS | D19 | after D19 |
| OS-6 | Chained per-lane script: gate → review → PR → watch; stops on any finding; never writes a fix brief | OS-1, OS-3 | after OS-1 |
| OS-7 | Merge path: queue and auto-merge, or D22's fallback (disjointness check, forge branch update, no local gate #2) | D21/D22, A-S1 | after D21 |
| OS-8 | Brief template: 2–3 units per lane (Horizon A sizing) | D25 | after D25 |

### 4.3 hexagen-monaco (work orders filed there)

| # | Scope | After | Start now |
|---|---|---|---|
| HS1 | `sync --check --since <ref>` with dependency fan-out | — | **yes** (file the work order) |
| HS2 | Input-hash cache for `sync --check` | HS1's design note decides whether both are needed | with HS1 |
| HS3 | Release and fleet-v2 pin bump (Tier 0 here) | HS1 | no |

### 4.4 Horizon B, conductor amendments (fleet-v2 lanes)

Parallel means different packages and no shared file; manifest edits merge one at a time.

| Lane | Scope | Package / shared files | Tier | After | Start now |
|---|---|---|---|---|---|
| KS0 | This plan's amendment markers in the conductor plan (§3.2, §3.6, D3, D6, K4–K7, K9 rows) | docs | 0 | owner's decisions on D19–D31 | after the decisions |
| KS1 | Transition table: reviews in flight during `gating`; Tier 2 `accepting` → `opening-pr`; the merge hold in `merging`; `branch-behind` exit conditional on the queue; one test per changed row | work-execution (domain `lane-run-transitions.ts`); sync barrel | 2 | KS0 | no |
| KS2 | Gate receipts keyed by (predicate, tree hash); reuse on an equal tree; tests for reuse, a changed tree, and a receipt from another predicate set | work-execution (application, infra), **manifest** if the port changes | 2 | K4-2 (#313, merged) | **yes**, once D29 is decided |
| KS3 | Concurrent predicates under the slot budget; first non-pass reported in declared order; K4-2's typed verdict unchanged | work-execution (application, infra) | 2 | KS2 | no |
| KS4a | `WorktreePoolPort` and its domain record: take, reset to base, refill after merge; memory fake | work-execution (domain, application port), **manifest** | 2 | K3 | **yes**, once D30 is decided |
| KS4b | Pool adapter through the recorded host's executor (create, install, build, reset); refill trigger on a merge record | work-execution (infra) | 2 | KS4a | no |
| KS5 | File-level admission: declared touch list in the work order, disjointness against unmerged runs, per-file locks on shared files from admission to merge | work-execution (domain, application) | 2 | KS1, D30 | no |
| KS6 | K5 amendment: reviews in flight from `gating`; fix brief from review findings plus gate deltas; re-review on the delta | work-execution (application) | 2 | KS1, K5's own lanes | no |
| KS7 | K6 amendment: merge hold `premerge-receipt(head)`; `CiStatePort` `queued`/`merge-group`; merge action = enable auto-merge at the expected head (a new forge action kind, so AM4b's kinds and AM3a's grants cover it) | work-execution, **`apps/cli/src/composition.ts`** | 2 | KS1, K6, AM4b, D20, D21 | no |
| KS8 | K7 amendment: 10 s poll floor in `watching-ci` and `merging` | apps/cli | 1 | K7, D31 | no |

KS2 and KS4a can run in parallel (different files). KS7 joins the `composition.ts` sequence. If a K lane named here has already merged when its amendment is dispatched, the amendment lands as that lane's follow-up.

## 5. Hard to undo

- **Merge queue and auto-merge on `main`** (A-S1). A two-way door in settings, but every merge the queue makes is one-way, and auto-merge means a PR can land with nobody watching at that moment. Chosen by the owner under D21; Tier 2 additionally needs `allowHighRisk` and the Fable merge hold.
- **Tier 2 PRs opened before the Fable pass** (D20). The repository is public: a Tier 2 diff, including one that fixes a security finding, is visible on a branch and a PR some minutes before Fable reads it. Once pushed, it cannot be recalled. D20's default keeps the old order (Fable before the push) for a lane whose brief fixes an open security finding.
- **The required check name** (A-R1). The ruleset requires a check named `gate`. The sharded workflow keeps that name on an aggregate job that `needs:` every other job. If the aggregate were dropped or renamed, every open PR would wait forever on a check that never reports; and if it reported success when a needed job was skipped or cancelled, a PR could merge with a check that never ran. So the aggregate fails on any result of a needed job other than `success`, with a test PR that cancels one shard to prove it. Two-way, but the failure mode is silent, so it is named here.
- **Gate receipts keyed by tree hash** (KS2) become stored data; version the key from its first commit.
- **The touch list on a work order** (KS5) becomes part of the frozen brief; once runs are admitted by it, an inaccurate list is a correctness problem, not a hint. `lane-diff-check --strict-brief` against the touch list is what keeps it honest.
- **Smaller lanes** (D25). Two-way, but it changes how the owner reads the board: more PRs, each smaller.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D19 | May the review start beside gate #1, on the sealed diff, before the gate passes? Rewording of the pipeline's step-5 rule: "once the gate passes, Grok reviews" becomes "Grok reviews the sealed diff while the gate runs; its result is acted on only after the gate passes; on a gate failure its findings join the fix brief" | **Yes** |
| D20 | Tier 2: Fable after the PR is opened, concurrent with CI, with a merge hold on `premerge-receipt(head)`. Amends conductor D3 | **Yes**, except lanes whose brief fixes an open security finding, which keep Fable before the push (§5) |
| D21 | Merge queue with `merge_group` CI and auto-merge (repository setting and ruleset; Tier 2 auto-merge after Fable needs the auto-merge plan's `allowHighRisk`) | **Yes, if A-0 finds the queue offered for this repository**; else D22 |
| D22 | Without a queue: drop the local rebase and gate #2 only for lanes disjoint from `main` since their base; overlap → forge branch update and CI; `main` push CI as the net, red `main` blocks merges | **Yes** (only if D21 is not possible) |
| D23 | Affected-only PR tests, with the full suite on `merge_group` | **Yes, only with a queue**; without one PR CI stays full |
| D24 | Drop the local rebase before the PR; conductor D6 becomes moot with a queue | **Yes** with a queue; per D22 without |
| D25 | Lane size: 2–3 units per lane in Horizon A; 1–2 units, one package, ≤6 files, ≤8 work-order steps in Horizon B; switch when a measured week shows conducted Tier 1 overhead under 10 min | **Yes**; the owner is told that lanes get smaller and PRs more numerous |
| D26 | Tier 1 local gate without `sync:check` (CI keeps it), unless the diff touches `.architecture/` or a `@generated` file | **Yes** |
| D27 | Shared turbo cache per project on the lane host, written only by the gate's process; no remote cache, no token in CI | **Yes** |
| D28 | Yarn `nmMode: hardlinks-global` on the lane host | **Not now** (orchestrator's divergence from Fable: a shared writable store across worktrees; revisit after the warm pool is measured) |
| D29 | Gate receipts keyed by (predicate, tree hash), reused for an equal tree | **Yes** |
| D30 | Admission by file-level disjointness with per-file locks on shared files, replacing one active run per package | **Yes** |
| D31 | Poll floor 10 s in `watching-ci` and `merging` | **Yes** |
| D32 | CI sharded into `build-test`, `sync` and 3–4 shell shards behind an aggregate `gate` job (required check name unchanged), with the Yarn and turbo caches | **Yes** (measured: about 7.5 → 2.5–3 min) |

## 7. Open questions, assumptions and what is unmeasured

- **Merge queue availability** for a user-owned repository is unverified (A-0). Much of the merge-path saving depends on it; D22 is the fallback.
- **CI duration is measured for one run** (the last green `main` run, about 7.5 minutes; runs take 6–9). The sharded estimate of 2.5–3 minutes is computed from that run's steps plus each job's setup; measure ten runs after A-R1. The Horizon B budget assumes about 5 minutes for PR CI plus PR handling and 2 minutes for the queue's run.
- **The 6–8 minute first pass** assumes 1–2 unit briefs shorten sessions proportionally. Measure it: ten conducted lanes at D25's size against the 14-minute median.
- **The turbo cache's hit rate** across worktrees is unmeasured; A-R2's declared inputs may also lower it (more inputs, fewer accidental hits). Measure prep and build time before and after OS-4.
- **Review time beside the gate.** Running the review beside the gate assumes the gate fails rarely enough that reviewing a head that then fails is cheap. If gate #1 fails often, the wasted reviews are a cost on the review seats' quota; record how many reviews ran on a failed head.
- **Thread budget.** A concurrent gate uses more threads at once than a sequential one. The slot semaphore keeps the total inside the host-wide budget (8 slots × 4 workers); at today's load of about 15% there is room, but a wave of parallel lanes may need fewer slots.
- **hexagen's fan-out** must be complete for HS1 to be safe locally; CI's full check is the backstop, so a missed fan-out shows up as a CI failure, not a bad merge.

## 8. Revision notes

- **Fable, review 1 (2026-10-28): today's orchestration.** Summarised in §3.1. Adopted as A-1 to A-10 and OS-1 to OS-8; HS1/HS2 from item 8. One divergence, raised by the orchestrator: `nmMode: hardlinks-global` is deferred (D28, §3.2.2).
- **Fable, review 2 (2026-10-28): with the conductor.** The budget table (§3.6), the requirements (§3.6.1), the conductor amendments (§3.6.2), the decisions D19–D25, D29–D31 and the "not traded" list (§3.5) are from this review. Its conclusion that Tier 2 cannot reach 15–20 minutes without removing the review or Fable is kept as the plan's answer.
- **rev 0 (2026-10-28).** Written from both reviews and the measurements of §2. Added by the orchestrator: CI sharding from a measured `main` run, with the aggregate `gate` job (§3.2.3, A-R1, D32); the protected-path consequence for Horizon A (§2.3), the merge-queue availability check and D22's fallback (§3.3), the gate-only writer for the shared turbo cache (§3.2.2), D20's security-fix exception, and the reconciliation of the two sizing rules (§3.2.1).

## Challenge this

Whether reviewing a head before its gate passes is worth it. It saves 3–5 minutes per lane only when the gate passes; when it fails, the review spent quota on a head that will change, and its findings may not apply to the fixed head. A reviewer should check how often gate #1 fails on recorded lanes and whether the fix brief's carried findings are useful or noise.

Whether the merge queue is needed at all at this repository's PR rate. With lanes admitted only when disjoint, the merged result differs from the head only by files the lane did not touch; the queue's extra run catches semantic conflicts across files (a renamed export used elsewhere). A reviewer should test whether D22's fallback, with `main` push CI as the net, catches enough of those, at less setup and with no dependency on a feature the account may not have.

Whether 1–2 unit lanes shorten sessions as much as the budget assumes. A session has a fixed start (reading the brief, the files, the architecture) that does not shrink with the work order. If that start is 4–5 minutes, a 1-unit lane is closer to 9 minutes than 6, and Tier 1 lands nearer 20 than 17.
