# Plan: lane pipeline speed, from ~45–75 min (Tier 1) and ~2–3 h (Tier 2) to ~17 min and ~24–31 min

- **Date:** 2026-10-28
- **Target repository:** `fleet-v2` (repository configuration in Horizon A, conductor amendments in Horizon B). The orchestrator's own scripts live outside this repository: they are listed so the plan is whole, but they are not lanes here. The incremental `sync --check` is a work order against `hexagen-monaco` (§3.4).
- **Status:** rev 1, after a Grok check of rev 0 (one blocker, five majors, one minor; all applied, §8). Fable reviewed the improvements in two passes before rev 0 was written: one on today's orchestration, one on the pipeline once the conductor is built. Nothing built. Decisions D19–D35 (§6) continue the conductor plan's numbering (its last is D18) and are open with recommended defaults. Anchors checked against `origin/main` at `50adfde`.
- **Owner request (2026-10-28):** "Ask fable to review the improvements. Then write up a plan." and "how could we get lanes down to 15-20m total time, once the orchestrator lane is implemented".
- **Short answer.** Tier 1 can reach about **17 minutes p50** once the conductor runs it, provided a 1–2 unit first pass takes about 6 minutes (floor about 14; about 24 with one fix round). Tier 2 cannot reach 15–20 minutes without dropping the independent review or the Fable pass, which this plan does not do: its floor is about **24 minutes** with no fix round and about **31 minutes p50** with one (§3.6). The honest ways to get more lanes under 20 minutes are smaller scope per lane and classifying work as Tier 1 where it truly is.
- **Amends:** `2026-10-27_conductor-plan.md` §3.2 (states), §3.6 (admission, merge train), D3, D6 and the K4, K5, K6, K7 and K9 rows. Each amendment is marked there by the lane that builds it, in the conductor plan's style.

## 1. Goal

Cut a lane's wall time from frozen brief to merge without weakening what a merge requires. Today about three quarters of a lane is fixed overhead around a 14-minute agent session. The plan removes that overhead in two horizons:

- **Horizon A (now):** the orchestrator's scripts and this repository's configuration. Caches, concurrency inside the gate, the review beside the gate, no second local gate before the PR, a required `premerge` status, and a merge path that tests the merged result in CI instead of locally. Target, per lane of 2–3 units: Tier 1 about **30 minutes**, Tier 2 about **50 minutes p50** (35–70) (estimates, §3.2).
- **Horizon B (with the conductor):** the conductor does what the orchestrator does by hand, with no turnaround, from a warm worktree, with gate receipts keyed by tree and toolchain, and pipelined admission. Target, per lane of 1–2 units: Tier 1 about **17 minutes p50**, Tier 2 about **31 minutes p50** (§3.6).

**Non-goals.**
- No review is removed, and no review runs on a seat that implemented the lane. Every Tier 1 and Tier 2 lane keeps one independent non-implementer review; every Tier 2 lane keeps its one Fable pass before merge, enforced by a required status check (§3.3.1).
- CI is not reduced. The full suite runs on the merged result of every lane before its merge, with or without a merge queue (§3.3).
- No new seat, model or provider. The 20-second dispatch stagger stays (§3.5).
- No change to the fix-round cap of two, the parks at one-way doors, `lane-diff-check` on every head, or sealed artefacts before any gate reads them.

## 2. Current state (measured 2026-10-28)

### 2.1 Measured

| Stage | Measured | Sample, note |
|---|---|---|
| Lane agent session | median **14 min**, mean 18, p90 33 | 86 sessions, at today's lane sizes |
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
| CI | One `gate` job (the ruleset's required check): install, fixture parity, build, typecheck, lint, `lint:arch`, test, `sync:check`, `test:bin`, all in sequence; `actions/setup-node@v4` with no package cache and no turbo cache; triggers `pull_request`, `push` to `main`, `workflow_dispatch`; no `merge_group`; `permissions: contents: read`. `OCM_IT_REQUIRE=1` is read by the vitest integration suite `execution-runner-ocm-run.integration.test.ts` in `work-execution` (part of `yarn test`), not by a shell test | `.github/workflows/gate.yml` |
| Shell tests | `scripts/test-bin.sh` checks the two runner script pins, then runs the eight `tests/*.test.sh` in sorted order and stops at the first failure; it takes no shard or file-list argument | `scripts/test-bin.sh`, `tests/` |
| Turbo | `build`, `lint`, `typecheck`, `test` cached; no `globalDependencies`, no declared `env` or `passThroughEnv`; cache in each worktree's `.turbo/` | `turbo.json`; `.gitignore` |
| Environment read by code and tests | About thirty variables are read through `process.env` across `apps/` and `packages/`: the `FLEET_*` family (state directory, installation file, API URL and token file, runner and usage binaries, PR title, body and branch options, forge push origin, test secret), `NEXT_PUBLIC_FLEET_API_URL`, the runner tunnel's `OCM_*` family (including `OCM_IT_REQUIRE` and `OCM_IT_SCRIPT`), git's `GIT_DIR`, `GIT_WORK_TREE` and `GIT_CONFIG_COUNT`, `HOME`, `PATH`, `USER`, the SSH agent socket, and a few credential-named variables. Not one is declared to turbo | `process.env` reads under `apps/`, `packages/` |
| Yarn | `nodeLinker: node-modules`, nothing else; the lane host forces the classic `nmMode` by environment, which overrides the file | `.yarnrc.yml` |
| Scripts | `sync:check` = `hexagen sync --check --allow-dirty`; `lint:arch` = `hexagen arch validate`; neither is a turbo task | `package.json` |
| hexagen | `@hexagen-monaco/sync` and `arch-linter` pinned at `0.14.0` | `package.json` |
| Ruleset on `main` | Requires `gate`; `strict_required_status_checks_policy: false` (CI tests the PR head, not the merged result); repository `allow_auto_merge: false` | owner settings |
| Gate in the conductor | `EvaluateAttemptGatePort` runs the frozen gate at the collected head, predicates in order, stops at the first non-pass, and stores one outcome per head | `RequestAttemptAcceptanceUseCase.use-case.ts` (K4-2, #313) |
| Protected paths | `.github/`, `.architecture/`, `.yarnrc.yml`, every `package.json`, `scripts/`, `bin/` are protected: a lane's diff touching them is a `lane-diff-check` finding | `scripts/lane-diff-check.protected` |

The last row decides who makes Horizon A's repository changes: workflows, Yarn configuration, package manifests and scripts are **orchestrator changes (Tier 0/1)**, never lane output. Only `turbo.json` is open to a lane, and its change is small enough for the orchestrator too.

## 3. Design

### 3.1 Fable's first review: today's orchestration

Fable found the overhead at about 75% of a lane and ranked nine improvements. Summarised faithfully:

1. **Lane sizing.** While the fixed overhead is about 40 minutes and the work 14, put **2–3 units in one lane**. (Horizon B reverses this; §3.2.1.)
2. **Shared caches on the lane host.** A shared `TURBO_CACHE_DIR` for every worktree of a project, and Yarn's global cache with `nmMode: hardlinks-global`, so worktree prep and gate builds stop rebuilding what another worktree already built.
3. **`sync:check` concurrently** with typecheck, lint and tests in the gate, and **dropped from the Tier 1 local gate**. The owner's tier rule already allows targeted local checks for Tier 1; CI keeps `sync:check`. (Rev 1 keeps it locally until HS1 ships; §3.4.)
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
| A-1 | **Tier 2 merge hold**: the watch step never merges a Tier 2 PR without a Fable receipt for its head; becomes the required `premerge` status once A-S1 lands (§3.3.1) | orchestrator scripts | — (safety; first) | orchestrator |
| A-2 | Slot semaphore with 8 slots replaces the gate's sleeps; the 20 s dispatch stagger stays | orchestrator scripts | 0.5–3 | orchestrator |
| A-3 | Gate steps concurrent: `turbo run build typecheck lint test` in one invocation, `lint:arch` and `sync:check` beside it. `sync:check` stays in the Tier 1 local gate until HS1 ships (D26) | orchestrator scripts | 2 | orchestrator |
| A-4 | Shared turbo cache per project on the lane host, written only by the gate's process (D27) | lane host environment; `turbo.json` declares its inputs (A-R2) | 1–2 (prep and build) | orchestrator; owner for host environment |
| A-5 | Review starts with gate #1 on the sealed diff, marked "gate pending"; consumed only after PASS (D19) | orchestrator scripts | 3–5 | orchestrator |
| A-6 | One chained script per lane; stops on any finding; never writes a fix brief; result read from the full log | orchestrator scripts | 5–15 (turnaround) | orchestrator |
| A-7 | No local rebase and no local gate #2; the merged result is tested in CI instead: by the merge queue (D21), or by strict up-to-date checks with a forge branch update (D22) | owner settings, A-R1 | 4–5 locally; CI time added back (§3.3) | owner, orchestrator |
| A-8 | CI sharded into parallel jobs behind an aggregate `gate` job, Yarn and turbo caches, `merge_group` trigger (D32, §3.2.3) | `.github/workflows/gate.yml`, `scripts/test-bin.sh` (A-R1) | 4.5–5 per CI run (about 7.5 → 2.5–3) | orchestrator, Tier 0/1 |
| A-9 | Lane sizing: 2–3 units per lane while overhead is high (D25) | briefs | amortises overhead | orchestrator |
| A-10 | Incremental `sync --check` (hexagen work order) | hexagen-monaco (§3.4) | 2–2.5 per gate | hexagen |

#### Horizon A budget (estimates from the measured stages)

The 14-minute median session was measured at today's lane sizes. **This plan assumes today's lanes average about two units**, so a 2–3 unit lane takes about 14–21 minutes; the budget uses **18**. Fix-round sessions are not measured separately; a fresh session on numbered findings is assumed at **10 minutes** (7–14), shorter than a first pass because it reads only the named ranges.

| Step | Tier 1 | Tier 2 |
|---|---|---|
| Worktree prep (shared turbo cache) | 1 | 1 |
| Dispatch stagger | 0.3 | 0.3 |
| First pass (2–3 units) | 18 | 18 |
| Gate (concurrent, about 2.5 with `sync:check`) ∥ brief check ∥ code review | 4 | 5 |
| Chained-script turnaround | 1 | 1 |
| Fix round: fresh session 10 + gate 2.5 + re-review on the delta 3 | 0 at p50 | 15.5 |
| PR CI (sharded, about 3) ∥ Fable pass (about 8, D20); `premerge` immediate for Tier 1 | 3 | 8 |
| CI on the merged result (queue run, or branch update and re-run under D22) | 3 | 3 |
| Merge | 0.5 | 0.5 |
| **Total** | **about 31** | **about 52** (37 with no fix round, 67 with two) |

So Horizon A gives **about 30 minutes per Tier 1 lane of 2–3 units** (about 10–15 minutes per unit, against about 25–50 today) and **about 50 minutes p50 per Tier 2 lane (35–70)**. That one Tier 2 band is used everywhere in this plan. §7 says what is unmeasured.

**What Horizon A does not fix:** the agent session dominates, and the orchestrator is still in the loop between lanes. Those are Horizon B's.

#### 3.2.1 The two sizing rules are not in conflict

Fable's first review packs 2–3 units into a lane because each lane pays about 40 minutes of fixed overhead. Its second review asks for 1–2 units because, with the conductor, the overhead is a few minutes and the session dominates; a smaller lane finishes, gates and reviews faster, and a fix round costs less. The rule follows the overhead: **2–3 units per lane in Horizon A, 1–2 units in Horizon B** (D25). The switch is made when a measured week of conducted Tier 1 lanes shows fixed overhead under 10 minutes.

#### 3.2.2 Shared caches and receipts: what is safe

- **Turbo inputs (A-R2).** A shared cache is sound only if every input a task reads is in its hash. `turbo.json` today declares no `globalDependencies` and no environment (§2.3). A-R2:
  - declares the root inputs as `globalDependencies`: `.nvmrc`, the root `tsconfig*.json`, `yarn.lock`, and `.architecture/manifest.yaml` for tasks that read it;
  - sets **`envMode: "strict"`** explicitly (turbo 2's default, made deliberate) and lists every variable of §2.3 that a task reads: in `env` (hashed) where the value changes a result, including `OCM_IT_REQUIRE` and `OCM_IT_SCRIPT` on `test`, the `FLEET_*` and `OCM_*` families and the git variables; in `passThroughEnv` (not hashed) for `HOME`, `PATH`, `USER` and the SSH agent socket; credential-named variables only in `passThroughEnv`, so no secret value enters a hash, and none is set in CI;
  - adds a **check that fails on an undeclared variable**: a script that lists every `process.env` name read under `apps/` and `packages/` and fails when one is in neither list. It runs in CI's `build-test` job, so a new variable cannot silently bypass the hash.
- **Who writes the shared cache.** Only the gate's process sets `TURBO_CACHE_DIR`; the lane server's environment does not. A lane building in its worktree writes its own `.turbo/`. So a lane cannot plant a cache entry another worktree's gate would replay. This keeps `AGENTS.md`'s "workers are disposable and isolated". No remote cache and no token in public CI.
- **Gate receipts (Horizon B, KS2; D29).** A receipt is reused only when every input of the predicate is equal. Its key is (**predicate id, tree hash, predicate definition digest** (the command line and the content of every script it runs), **toolchain versions** (node, yarn, hexagen, turbo), **declared environment digest** (the A-R2 `env` list and the hashed values)). A change to any of them is a miss; an unreadable component is a miss, never a hit.
- **Yarn.** Yarn 4's global cache is already on by default; the gain Fable named is `nmMode: hardlinks-global`, which links every worktree's `node_modules` files to one store. **This plan recommends deferring it (D28)**, against Fable's ranking: hard links make one file writable from every worktree, so a lane that edits a file under `node_modules` changes it for every other worktree and for the gate, and `lane-diff-check` deliberately skips `node_modules`. Horizon B's warm worktree pool (§3.6) removes most of the install time without a shared writable store.

#### 3.2.3 CI sharding (measured)

The last green `main` run took about 7.5 minutes in one serial job (§2.1). The shell tests alone are 191 s and `sync:check` 82 s; neither needs to wait for the build, the typecheck or the vitest suites. A-R1 splits `gate.yml` into parallel jobs:

| Job | Steps | Expected |
|---|---|---|
| `build-test` | checkout, setup, install, build, typecheck, lint, `lint:arch`, test, the undeclared-variable check (A-R2); keeps `OCM_IT_REQUIRE=1`, because the `ocm-run` integration suite it guards is a vitest test in `work-execution` (§2.3) | about 2.3 min (the critical path) |
| `sync` | checkout, setup, install, `sync:check` | about 1.7 min; **verify first** that `hexagen sync --check` reads no build output (run it on a fresh checkout with no `dist/`) |
| `shell` (matrix, 3–4 shards) | checkout, setup, install, model-family fixture parity (one shard), `scripts/test-bin.sh --shard <i>/<n>` | about 1–1.3 min each |
| `gate` (aggregate) | `needs:` every job above; fails unless every one succeeded (`if: always()` with an explicit check of each `needs.<job>.result`, so a skipped or cancelled shard is a failure, never a pass) | seconds |

**The required check's name stays `gate`.** The ruleset requires the aggregate job, so open PRs are not blocked by the switch. Expected wall time **about 2.5–3 minutes**, from about 7.5. Every check still runs on every PR; CI stays the single source of truth.

**`scripts/test-bin.sh` gains a shard argument** (`--shard <i>/<n>`, or an explicit file list). Shards split `tests/*.test.sh` by file in sorted order, balanced by the measured per-file times (a greedy split by recorded duration beats round-robin). The pin checks of `bin/ocm-run` and `bin/agy-run` run in every shard (they take milliseconds), so no shard can pass with a broken pin. A run with no argument behaves exactly as today. The script is a protected path, so the orchestrator makes the change; it is one script and one workflow, Tier 0/1.

**Two verifications before it merges.**
- **No shell test depends on another's leftovers.** Today the files run in one order in one job; a test that reads a file or state another test left would pass serially and fail sharded. A-R1 runs each `tests/*.test.sh` alone on a fresh checkout once and records the result.
- **`sync:check` on a fresh checkout** (above).

**Caches.** `setup-node` with `cache: yarn` (after `corepack enable`, so the cache key resolves Yarn 4), and an `actions/cache` step for the turbo cache keyed by the OS, the lockfile hash and the commit, restoring from the newest entry with the same lockfile. The turbo cache in CI is only as sound as A-R2's declared inputs, so A-R2 lands first or in the same change. No remote cache and no token.

### 3.3 The merge path

Today every lane is rebased and gated a second time locally, then CI tests the PR head (not the merged result), then the orchestrator merges. Both paths below remove the local rebase and gate #2, and both test the merged result in CI before the merge.

**With a merge queue (D21):**

1. The PR is opened right after the lane is accepted, with no local rebase.
2. PR CI runs on the head (in time, the affected-only tests, D23).
3. The orchestrator (Horizon A) or the conductor (Horizon B) enables auto-merge at the expected head **only after `premerge` reports success for that head** (§3.3.1). Enabling it earlier would be harmless, because `premerge` is required, but the order keeps the queue free of PRs that cannot merge.
4. The queue builds the merged result and runs the **full** suite under `merge_group`, with `premerge` answered on the group's commit (§3.3.1). Green merges; red drops the PR from the queue, and the lane re-enters gating with the failure as a fix input.

The queue removes the rebase, gate #2 and the `branch-behind` park (conductor D6) from the hot path, and it tests what lands, which today nothing does before the merge.

**Availability is the first thing to verify.** GitHub offers merge queues on organisation-owned repositories; this repository is owned by a user account, and the queue may not be offered for it. A-0 checks this in the repository settings before anything depends on it.

**Without a merge queue (D22).** The merged result is still tested before the merge:

- The ruleset sets **`strict_required_status_checks_policy: true`** (part of D22): a PR merges only when its branch is up to date with `main`, so the `gate` that passed ran on the merged result.
- When `main` has moved since the head's CI run, the orchestrator (or conductor) **updates the branch through the forge** (a merge of `main` into the branch, never a local rebase) and CI re-runs on the new head. No local gate #2.
- **Disjointness is re-checked at merge time**, not only at admission: just before enabling auto-merge or merging, the lane's touch list is compared with every file changed on `main` since the head's base. An overlap on a shared file (§3.6.1 item 9) parks the lane `branch-behind` (conductor D6, which stands on this path) instead of merging on a forge update alone.
- The cost is serialisation: every merge waits for its own up-to-date CI run, about 3 minutes with A-R1. At today's PR rate that is accepted; Horizon B's pipelined admission keeps more lanes ready behind it.

#### 3.3.1 `premerge`: the Fable receipt as a required status

Auto-merge and the merge queue merge on required checks only. A Fable receipt held by the orchestrator is not one, so without this section a Tier 2 head could land with no Fable pass. The fix makes the receipt a required status check:

- **The status.** A commit status with the context `premerge`, posted on the exact head SHA by the orchestrator (Horizon A) or the conductor (Horizon B), never by a lane (lanes cannot use the forge) and never by a workflow (`gate.yml` keeps `permissions: contents: read`, so no CI job can post it).
  - **Tier 2:** `success` only after a Fable receipt for that head is recorded; until then `pending` with "waiting for the pre-merge review"; a Fable finding sets `failure` with "findings: n", and the lane goes to a fix round.
  - **Tier 0 and Tier 1:** `success` immediately, with the description "not required for tier 1" (or 0). The tier is read from the frozen work order, never from a PR label or title.
- **The ruleset requires both `gate` and `premerge`** (A-S1). Where the forge lets a required check name its expected source, `premerge` is pinned to the identity that posts it.
- **A new head invalidates it.** Statuses are per SHA, so a fix push, a forge branch update (D22) or any new commit starts with no `premerge`. A fix round after Fable's findings needs a new receipt on the new head (D34).
  - **A forge branch update under D22** produces a merge commit whose lane-side content is unchanged. The poster may carry a Tier 2 `success` to the new head only when the update changed no file in the lane's diff (`git diff <old head> <new head>` touches only files changed on `main` since the old head's base, none of them in the lane's diff); otherwise the new head waits for a receipt like any other. (Challenged below.)
  - **A merge-group commit** under D21 needs `premerge` too, since the queue requires the same checks on it. The poster answers a group's commit with `success` only when every PR in the group carries `premerge: success` on the exact head the group includes, and `failure` otherwise. A-0 also verifies that the queue's group commits can carry a status the poster sets; if not, D21 is not taken and D22 applies.
- **Who may post it is an owner decision (D33):** which identity, with which token scope (statuses write on this repository only), held where. The default keeps it with the orchestrator's existing forge identity on the orchestrator's machine, and out of every lane, workflow and runner environment.
- **The no-queue path uses the same status.** D22's strict checks require `gate` and `premerge` alike.

**Tier 2 under auto-merge.** Auto-merge on a Tier 2 lane also needs the auto-merge plan's `allowHighRisk`. With `premerge` required, enabling auto-merge never bypasses the Fable pass.

### 3.4 hexagen work order: incremental `sync --check`

`sync:check` is 145–160 s of a 4–5 minute local gate. It regenerates every managed file to compare, whatever the diff touched.

| # | Work order (filed in `hexagen-monaco`; its session plans and runs it) | Acceptance |
|---|---|---|
| HS1 | `hexagen sync --check --since <ref>`: compute the managed outputs whose inputs (manifest sections, templates, generator version, hand-written sources a barrel lists, any other file hexagen reads) changed between `<ref>` and the working tree, **with dependency fan-out** (a changed manifest entry checks every output derived from it; an added, removed or renamed module source checks the barrels that list it); check only those. `--only` today checks one target and has no fan-out, so it is not a substitute | On an unchanged manifest and a diff inside one module, under 10 s; a fixture where a manifest change reaches a barrel in another context is caught; a template or generator-version change checks everything; `--since` with an unknown ref fails closed (full check) |
| HS2 | Alternative or complement: an input-hash cache, `--cache <dir>`, keyed by the hash of every input of the check plus the generator version; a hit skips the regeneration | Cache miss on any input change, including the generator version; a corrupt cache entry is a miss, never a pass |
| HS3 | A release of `@hexagen-monaco/sync` carrying HS1 (and HS2 if built), fanned out under the hexagen integration plan's release rule | fleet-v2 moves its pin from `0.14.0` in a Tier 0 change, with `sync:check` green |

**Until HS1 ships, the Tier 1 local gate keeps `sync:check`** (D26), run concurrently with the other steps (A-3), so it costs its 150 s once in wall time, beside the build, instead of after everything else. A skip rule in the orchestrator's script would have to cover every file hexagen reads (the manifest, templates, the generator version, and any module source a barrel lists), which is HS1's own job; the plan does not duplicate it outside hexagen. CI always runs the full check, with or without `--since`.

### 3.5 What is not traded

From Fable's second review, adopted as constraints on every change in this plan:

- An independent non-implementer review on every Tier 1 and Tier 2 lane.
- One Fable pass on every Tier 2 lane before merge, at the exact head that merges, enforced by the required `premerge` status (§3.3.1).
- The full CI suite on the merged result, before the merge (§3.3).
- The 20-second dispatch stagger.
- The fix-round cap of two.
- Shared-file serialisation (manifest, barrels, `composition.ts`, `index.ts`).
- Parks at one-way doors.
- `lane-diff-check` on every head.
- Sealed artefacts before any gate reads them.

### 3.6 Horizon B: the pipeline with the conductor

Fable's second review proposed a budget; rev 1 re-derives it with three corrections: the merged-result CI run cannot be shorter than the `build-test` critical path (about 2.3 minutes, so 3 with setup), PR CI is the sharded 2.5–3 minutes plus the push and PR (3.5), and a fix round is a session plus a gate plus a re-review, not a session alone.

| Step | Tier 1 | Tier 2 | Fable's figure (T1 / T2) |
|---|---|---|---|
| Admission, warm worktree, dispatch | 0.5 | 0.5 | 0.5 / 0.5 |
| First pass (1–2 unit brief) | 6 | 8 | 6 / 8 |
| Collect, seal, `lane-diff-check` | 0.5 | 0.5 | 0.5 / 0.5 |
| Gate (concurrent, receipts reused) ∥ brief check ∥ code review | 3 | 4 | 3 / 4 |
| Fix round: tiny fresh session on findings 3.5 + gate 1.5 + re-review on the delta 2 | 0 at p50 (+7 when one runs) | 7 | 0 (+6) / 6 |
| Push, PR, PR CI (3.5) ∥ Fable (8, Tier 2); `premerge` immediate for Tier 1 | 3.5 | 8 | 5 / 8 |
| CI on the merged result (queue, or D22's up-to-date run) | 3 | 3 | 2 / 2 |
| **Total** | **about 17** (16.5; floor about 14; about 24 with a fix round) | **about 31** (floor about 24 with no fix round) | 17 / 29 |

**Tier 1 at about 17 still holds** after the corrections, because the shorter PR CI offsets the longer merged-result run. **Tier 2 moves from 29 to about 31.** 15–20 minutes for Tier 2 is not reachable without removing the review or the Fable pass. The two honest levers are smaller scope (a Tier 2 change cut into a Tier 2 core and Tier 1 follow-ups) and classifying work truthfully: a test-only or behaviour-free lane filed as Tier 2 out of habit is a Tier 1 lane.

**The 6-minute first pass is a target, not a measurement.** Today's median session is 14 minutes at today's lane sizes, assumed about two units (§3.2). A 1–2 unit lane is then about 7–14 minutes by simple scaling; 6 minutes needs the session's fixed start (reading the brief, the files, the architecture) to shrink too, which the warm worktree and a brief that names its file ranges aim at. If a 1–2 unit session stays at 10 minutes, a conducted Tier 1 lane is about 21 minutes. The first pass reaches 6–8 minutes only with D25's sizing: **1–2 units, one package, about 6 files or fewer, at most 8 work-order steps**.

#### 3.6.1 What the conductor must do to reach it

1. **Warm worktree pool per project** (`WorktreePoolPort`, new; D35). Worktrees are created, installed and built ahead of admission, at `origin/main`, and refilled after each merge; admission takes one and resets it to the run's base. Prep leaves the hot path.
2. **Gate predicates as one run.** One `turbo run` over the affected workspaces for build, typecheck, lint and test, with `lint:arch` and `sync:check` concurrent beside it, under the host-wide slot budget. **Receipts keyed by predicate, tree, predicate definition, toolchain and declared environment** (§3.2.2, D29): a head whose key equals an already-gated one reuses the receipt, so a no-op re-push never gates twice.
3. **Reviews start from the sealed diff**, in `gating`, and are consumed only after the gate passes (D19). A gate failure goes to a fix round whose brief carries the gate's failures **and** any review findings already recorded; the next review is on the delta.
4. **Fix rounds are tiny fresh sessions** on the numbered findings only, and the re-review reads the fix delta against its own list.
5. **The PR opens right after acceptance**, with no local rebase.
6. **CI sharded, cached, with `merge_group`** (Horizon A, A-R1). Affected-only PR tests are acceptable only when `merge_group` runs the full suite (D23).
7. **Merge = post `premerge`, then enable auto-merge at the expected head.** The queue (or D22's strict checks) merges; the conductor watches.
8. **Fable after the PR, concurrent with CI** (D20), with the required `premerge` status as the merge hold. A Fable finding sets `premerge: failure` and pushes a new head through a fix round, which re-enters gating; the status is per SHA, so a pass on an old head never releases a new one.
9. **Pipelined admission.** Lane N+1 is admitted when its declared touch list is disjoint from every unmerged lane's, and shared files (`.architecture/manifest.yaml`, `@generated` barrels, `apps/cli/src/composition.ts`, `apps/cli/src/index.ts`, `apps/api` wiring) serialise on a **per-file lock** held from admission to merge (D30). Disjointness is re-checked at merge time against `main` (§3.3). This replaces "one active run per package" (§3.6 of the conductor plan) with a finer rule that admits more lanes, not fewer.

#### 3.6.2 Conductor amendments

| Conductor item | Amendment |
|---|---|
| §3.2 `gating`, `brief-check`, `code-review` | A run in `gating` may hold **reviews in flight**: brief-check and code-review intents keyed at the sealed head (`<runId>/r<round>/review/<kind>/<seat>@<head12>`) are appended on entry to `gating`. Exits are unchanged in meaning: `brief-check` and `code-review` read the receipts already recorded instead of requesting them. A receipt for a head the gate failed is kept and passed to the fix brief; it never accepts a head |
| §3.2 `accepting`, `awaiting-premerge`, `opening-pr` | Tier 2 goes `accepting` → `opening-pr` → `watching-ci`, with the pre-merge request appended at `opening-pr`. `awaiting-premerge` becomes a **merge hold** read in `merging`: the conductor posts `premerge: success` for the head only when the pre-merge receipt for that head is a pass, and enables auto-merge only after that. Amends D3 (D20) |
| §3.2 `merging` | The merge actions are **post `premerge`** (a new forge action kind, keyed `<runId>/r<round>/premerge@<head12>`) and **enable auto-merge at the expected head**; `merged` is entered when the forge reports the merge at that head. Under a queue, the conductor also answers `premerge` on merge-group commits (§3.3.1). `CiStatePort` gains `queued` and `merge-group` states (D21) |
| §3.6 admission | File-level disjointness and per-file locks (D30) replace one active run per package; the host-wide gate budget and the global cap stay |
| §3.6 merge train, D6 | With a merge queue, `branch-behind` is not reached and the park is removed. Under D22, the conductor updates a behind branch through the forge and waits for CI; D6's park stays for an overlap on a shared file found at merge time |
| K4 | `GatePort` receipts keyed by predicate, tree, predicate definition digest, toolchain versions and declared environment digest (D29); predicates run concurrently under the slot budget (today `EvaluateAttemptGatePort` runs them in order and stops at the first non-pass; the concurrent form still reports the first non-pass in declared order, so the typed verdict of K4-2 is unchanged); `WorktreePoolPort` (D35); file-level admission disjointness |
| K5 | Reviews may start in `gating` (the reviews-in-flight set); the fix brief is rendered from review findings plus gate deltas; re-review on the delta |
| K6 | `awaiting-premerge` overlapped with `watching-ci` under the `premerge` status; `CiStatePort` `queued`/`merge-group`; merge action = post `premerge`, then enable auto-merge at the expected head; the `branch-behind` park removed when the queue is on |
| K7 | Poll floor **10 s** in `watching-ci` and `merging` (today the driver backs off from 30 s to 2 min, §3.1 of the conductor plan); other states keep the back-off (D31) |
| K9 | `/v1/changes` wake-ups matter more once every other wait is short; K9 moves up the queue, still under D9 |

## 4. Workbook

Each Horizon B lane is sized to Horizon B's own rule where it can be (1–2 units); the conductor plan's "about 45 minutes" applies to the larger ones. **Start now** is "yes" only for an item with no unmet dependency and no open decision. Today that is **OS-1, OS-2, A-0, and filing HS1/HS2**; everything else waits for the decision or the item named in its After column.

### 4.1 Horizon A, repository side (orchestrator changes)

Protected paths: these are made by the orchestrator, not by a lane (§2.3).

| # | Scope | Files | Tier | After | Start now |
|---|---|---|---|---|---|
| A-0 | Verify whether a merge queue is offered for this repository, and whether merge-group commits can carry a commit status posted by the orchestrator's identity; record both answers here | owner settings (read) | 0 | — | **yes** |
| A-R2 | `turbo.json`: `globalDependencies` (`.nvmrc`, root `tsconfig*.json`, `yarn.lock`, the manifest for tasks that read it); `envMode: "strict"` with every variable of §2.3 in `env` or `passThroughEnv` (credential-named ones pass-through only); the undeclared-variable check script and its CI step | `turbo.json`, a script under `scripts/` | 0/1 | D27 or D32 (its consumers are the shared caches) | no |
| A-R1 | CI sharding (§3.2.3): jobs `build-test`, `sync`, a `shell` matrix of 3–4 shards and the aggregate `gate` that `needs:` them all; `corepack enable` before `setup-node` with `cache: yarn`; `actions/cache` for turbo; `scripts/test-bin.sh --shard <i>/<n>`; `merge_group` trigger (inert until a queue exists); the concurrency group unchanged for `pull_request` and not cancelling `merge_group` runs. Before merge: each shell test passes alone on a fresh checkout, and `sync:check` passes with no build output. Measured target: about 7.5 → 2.5–3 min | `.github/workflows/gate.yml`, `scripts/test-bin.sh` | 0/1 | D32; A-R2 (same change or before) | no |
| A-R3 | `.yarnrc.yml` `nmMode` | `.yarnrc.yml` | 0 | D28 (default: not now) | no |
| A-R4 | Affected-only PR tests: `turbo run test --filter=...[origin/main]`, checkout `fetch-depth: 0`; the `merge_group` run stays full | `.github/workflows/gate.yml` | 0 | A-R1, A-S1 with a queue, D23 | no |
| A-S1 | Owner settings: the ruleset requires `gate` **and `premerge`** (with its expected source pinned where the forge allows); `allow_auto_merge: true`; then either the merge queue on `main` (D21, if A-0 found it) or `strict_required_status_checks_policy: true` (D22) | owner | — | D21 or D22, D33, A-0; OS-1 posting `premerge` on every open PR first (or the new required check blocks them) | no |

### 4.2 Horizon A, orchestrator scripts (outside this repository; listed, not lanes here)

| # | Scope | After | Start now |
|---|---|---|---|
| OS-1 | Tier 2 merge hold in the watch step: never merge a Tier 2 PR without a Fable receipt for the exact head (A-1). Once D33 is decided, the same step posts `premerge` (§3.3.1) | — (the hold); D33 (the status) | **yes, first** |
| OS-2 | Slot semaphore (8 slots) replaces gate sleeps; dispatch stagger kept at 20 s | — | **yes** |
| OS-3 | Concurrent gate steps, `sync:check` kept and run beside the others; gate result parsed from the full log | D26 | no |
| OS-4 | Gate-only shared `TURBO_CACHE_DIR` per project on the lane host | A-R2, D27; the owner sets the host environment | no |
| OS-5 | Review started with gate #1, "gate pending", consumed only after PASS | D19 | no |
| OS-6 | Chained per-lane script: gate → review → PR → watch; stops on any finding; never writes a fix brief | OS-1, OS-3 | no |
| OS-7 | Merge path: post `premerge`, then auto-merge into the queue; or D22's forge branch update, CI re-run and merge-time disjointness check | **OS-1**, D21/D22, D33, A-S1 | no |
| OS-8 | Brief template: 2–3 units per lane (Horizon A sizing) | D25 | no |

### 4.3 hexagen-monaco (work orders filed there)

| # | Scope | After | Start now |
|---|---|---|---|
| HS1 | `sync --check --since <ref>` with dependency fan-out over every file hexagen reads | — | **yes** (file the work order) |
| HS2 | Input-hash cache for `sync --check` | HS1's design note decides whether both are needed | **yes** (file with HS1) |
| HS3 | Release and fleet-v2 pin bump (Tier 0 here) | HS1 | no |

### 4.4 Horizon B, conductor amendments (fleet-v2 lanes)

Parallel means different packages and no shared file. **The orchestrator owns the manifest edits** (as in the conductor's K-chain rule): where a lane below needs a new manifest entry, the orchestrator lands it in one Tier 0 commit, with `yarn sync` for the barrels, before the lane is dispatched, and the lane's brief forbids touching `.architecture/`. Lanes that would otherwise both edit the manifest then share no file.

| Lane | Scope | Package / shared files | Tier | After | Start now |
|---|---|---|---|---|---|
| KS0 | This plan's amendment markers in the conductor plan (§3.2, §3.6, D3, D6, K4–K7, K9 rows) | docs | 0 | the owner's decisions on D19–D35 | no |
| KM | Orchestrator's manifest commit for KS2's receipt-key port change (if any) and KS4a's `WorktreePoolPort`, with barrels synced | `.architecture/manifest.yaml`, `@generated` barrels | 0 | D29, D35 | no |
| KS1 | Transition table: reviews in flight during `gating`; Tier 2 `accepting` → `opening-pr`; the `premerge` merge hold in `merging`; `branch-behind` exit conditional on the queue; one test per changed row | work-execution (domain `lane-run-transitions.ts`); sync barrel | 2 | KS0 | no |
| KS2 | Gate receipts keyed by predicate, tree, definition digest, toolchain versions and declared environment digest; reuse only on an equal key; tests for reuse, a changed tree, a changed script, a changed toolchain version, a changed declared variable, and an unreadable component (a miss) | work-execution (application, infra); no manifest edit (KM) | 2 | K4-2 (#313, merged), D29, KM | no |
| KS3 | Concurrent predicates under the slot budget; first non-pass reported in declared order; K4-2's typed verdict unchanged | work-execution (application, infra) | 2 | KS2 | no |
| KS4a | `WorktreePoolPort` and its domain record: take, reset to base, refill after merge; memory fake | work-execution (domain, application port); no manifest edit (KM) | 2 | K3, D35, KM | no |
| KS4b | Pool adapter through the recorded host's executor (create, install, build, reset); refill trigger on a merge record | work-execution (infra) | 2 | KS4a | no |
| KS5 | File-level admission: declared touch list in the work order, disjointness against unmerged runs, per-file locks on shared files from admission to merge, re-check at merge time | work-execution (domain, application) | 2 | KS1, D30 | no |
| KS6 | K5 amendment: reviews in flight from `gating`; fix brief from review findings plus gate deltas; re-review on the delta | work-execution (application) | 2 | KS1, K5's own lanes, D19 | no |
| KS7 | K6 amendment: `premerge` post action and its key (a new forge action kind, so AM4b's kinds and AM3a's grants cover it), merge-group answers; `CiStatePort` `queued`/`merge-group`; merge action = enable auto-merge at the expected head | work-execution, **`apps/cli/src/composition.ts`** | 2 | KS1, K6, AM4b, D20, D21/D22, D33 | no |
| KS8 | K7 amendment: 10 s poll floor in `watching-ci` and `merging` | apps/cli | 1 | K7, D31 | no |

**After KM, KS2 and KS4a can run in parallel** (different files, no manifest edit in either). Without KM they run one after the other, each with its own manifest edit, merged and rebased in turn. KS7 joins the `composition.ts` sequence. If a K lane named here has already merged when its amendment is dispatched, the amendment lands as that lane's follow-up.

## 5. Hard to undo

- **Merge queue or strict checks, and auto-merge on `main`** (A-S1). Two-way doors in settings, but every merge they make is one-way, and auto-merge means a PR can land with nobody watching at that moment. Chosen by the owner under D21 or D22; Tier 2 additionally needs `allowHighRisk`, and the required `premerge` status is what keeps the Fable pass in front of every Tier 2 merge.
- **The `premerge` status and the identity that posts it** (D33). Whoever can post `success` on this repository can release a Tier 2 merge. The token is scoped to statuses on this one repository and held only by the orchestrator; no workflow, lane or runner environment gets it. A leaked token is revoked by the owner and the status re-posted by a new identity, with the ruleset's expected source updated.
- **Making `premerge` required** (A-S1) blocks every open PR that has no `premerge` status yet. OS-1 posts it on every open PR before the ruleset changes.
- **Tier 2 PRs opened before the Fable pass** (D20). The repository is public: a Tier 2 diff, including one that fixes a security finding, is visible on a branch and a PR some minutes before Fable reads it. Once pushed, it cannot be recalled. D20's default keeps the old order (Fable before the push) for a lane whose brief fixes an open security finding.
- **The required check name `gate`** (A-R1). The ruleset requires a check named `gate`. The sharded workflow keeps that name on an aggregate job that `needs:` every other job. If the aggregate were dropped or renamed, every open PR would wait forever on a check that never reports; and if it reported success when a needed job was skipped or cancelled, a PR could merge with a check that never ran. So the aggregate fails on any result of a needed job other than `success`, with a test PR that cancels one shard to prove it. Two-way, but the failure mode is silent, so it is named here.
- **Gate receipt keys** (KS2) become stored data; version the key from its first commit, so a later added component is a miss, never a false hit.
- **The touch list on a work order** (KS5) becomes part of the frozen brief; once runs are admitted by it, an inaccurate list is a correctness problem, not a hint. `lane-diff-check --strict-brief` against the touch list, and the merge-time re-check, keep it honest.
- **Smaller lanes** (D25). Two-way, but it changes how the owner reads the board: more PRs, each smaller.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D19 | May the review start beside gate #1, on the sealed diff, before the gate passes? Rewording of the pipeline's step-5 rule: "once the gate passes, Grok reviews" becomes "Grok reviews the sealed diff while the gate runs; its result is acted on only after the gate passes; on a gate failure its findings join the fix brief" | **Yes** |
| D20 | Tier 2: Fable after the PR is opened, concurrent with CI, with the required `premerge` status as the merge hold. Amends conductor D3 | **Yes**, except lanes whose brief fixes an open security finding, which keep Fable before the push (§5) |
| D21 | Merge queue with `merge_group` CI, `premerge` answered on group commits, and auto-merge after `premerge` (repository setting and ruleset; Tier 2 auto-merge needs the auto-merge plan's `allowHighRisk`) | **Yes, if A-0 finds the queue offered and group commits can carry `premerge`**; else D22 |
| D22 | Without a queue: `strict_required_status_checks_policy: true`; a behind branch is updated through the forge and CI re-runs on the merged result; disjointness re-checked at merge time; no local rebase or gate #2 | **Yes** (only if D21 is not possible). *Changed in rev 1:* nothing merges on CI that has not run on the merged result |
| D23 | Affected-only PR tests, with the full suite on `merge_group` | **Yes, only with a queue**; under D22 the up-to-date PR run stays full |
| D24 | Drop the local rebase before the PR; conductor D6 becomes moot with a queue | **Yes**, under D21 or D22 (both test the merged result in CI) |
| D25 | Lane size: 2–3 units per lane in Horizon A; 1–2 units, one package, ≤6 files, ≤8 work-order steps in Horizon B; switch when a measured week shows conducted Tier 1 overhead under 10 min | **Yes**; the owner is told that lanes get smaller and PRs more numerous |
| D26 | Tier 1 local gate and `sync:check` | *Changed in rev 1:* **keep `sync:check` in the Tier 1 local gate, concurrent with the other steps, until HS1 ships**; then use `--since <base>`. CI always runs the full check |
| D27 | Shared turbo cache per project on the lane host, written only by the gate; no remote cache, no token in CI | **Yes** |
| D28 | Yarn `nmMode: hardlinks-global` on the lane host | **Not now** (divergence from Fable: a shared writable store across worktrees; revisit after the warm pool is measured) |
| D29 | Gate receipts keyed by predicate, tree, predicate definition digest, toolchain versions and declared environment digest; reused only on an equal key | **Yes** (*changed in rev 1:* the key is wider than the tree hash) |
| D30 | Admission by file-level disjointness with per-file locks on shared files, re-checked at merge time, replacing one active run per package | **Yes** |
| D31 | Poll floor 10 s in `watching-ci` and `merging` | **Yes** |
| D32 | CI sharded into `build-test`, `sync` and 3–4 shell shards behind an aggregate `gate` job (required check name unchanged), with the Yarn and turbo caches | **Yes** (measured: about 7.5 → 2.5–3 min) |
| D33 *(new, rev 1)* | Who may post the `premerge` status: which identity, which token scope, held where | **The orchestrator's existing forge identity, on the orchestrator's machine, with statuses write on this repository only**; never a workflow, lane or runner; the ruleset pins `premerge`'s expected source where it can |
| D34 *(new, rev 1)* | Who gives the receipt for `premerge` on a head produced by fixing Fable's own findings | **A re-check of the fix delta against Fable's numbered list on the reduced-schedule re-check seat**, recorded as the pre-merge receipt for the new head; Fable again only if the owner asks or the fix is itself high-risk (§7) |
| D35 *(new, rev 1)* | A warm worktree pool per project (`WorktreePoolPort`): worktrees installed and built ahead of admission, refilled after merges | **Yes**, with the pool size from configuration (default 2 per project) and the pool's worktrees subject to the reaper's merged-worktree rules |

## 7. Open questions, assumptions and what is unmeasured

- **Merge queue availability** for a user-owned repository is unverified, and so is whether a queue's group commits can carry an orchestrator-posted status (A-0). D22 is the fallback, at the cost of serialised merges.
- **D34 and the conductor's D10.** D10 says the same review seat re-runs on the next head; the reduced Fable schedule allows one Fable pass per lane and puts re-checks on another seat. D34's default follows the reduced schedule for `premerge` only; the owner may prefer Fable on the fixed head, which adds a second Fable pass to such lanes.
- **CI duration is measured for one run** (the last green `main` run, about 7.5 minutes; runs take 6–9). The sharded estimate of 2.5–3 minutes is computed from that run's steps plus each job's setup; measure ten runs after A-R1.
- **Session length by size.** Horizon A assumes today's lanes average about two units, so a 2–3 unit lane is about 18 minutes; Horizon B assumes a 1–2 unit first pass of 6–8 minutes. Neither is measured. Measure ten lanes at each size against the 14-minute median; if a 1–2 unit session is 10 minutes, Tier 1 is about 21, not 17.
- **Fix-round sessions** are assumed at 10 minutes (Horizon A) and 3.5 minutes (Horizon B, numbered findings only). Neither is measured separately from first passes.
- **The turbo cache's hit rate** across worktrees is unmeasured; A-R2's declared inputs may lower it. Measure prep and build time before and after OS-4.
- **Review time beside the gate.** Running the review beside the gate assumes the gate fails rarely enough that reviewing a head that then fails is cheap. Record how many reviews ran on a failed head.
- **Thread budget.** A concurrent gate uses more threads at once than a sequential one. The slot semaphore keeps the total inside the host-wide budget (8 slots × 4 workers); at today's load of about 15% there is room, but a wave of parallel lanes may need fewer slots.
- **hexagen's fan-out** must be complete for HS1 to be safe locally; CI's full check is the backstop, so a missed fan-out shows up as a CI failure, not a bad merge.

## 8. Revision notes

- **Fable, review 1 (2026-10-28): today's orchestration.** Summarised in §3.1. Adopted as A-1 to A-10 and OS-1 to OS-8; HS1/HS2 from item 8. One divergence, raised by the orchestrator: `nmMode: hardlinks-global` is deferred (D28, §3.2.2).
- **Fable, review 2 (2026-10-28): with the conductor.** The budget table (§3.6, re-derived in rev 1), the requirements (§3.6.1), the conductor amendments (§3.6.2), the decisions D19–D25, D29–D31 and the "not traded" list (§3.5) are from this review. Its conclusion that Tier 2 cannot reach 15–20 minutes without removing the review or Fable is kept as the plan's answer.
- **rev 0 (2026-10-28).** Written from both reviews and the measurements of §2. Added by the orchestrator: CI sharding from a measured `main` run, with the aggregate `gate` job (§3.2.3, A-R1, D32); the protected-path consequence for Horizon A (§2.3); the merge-queue availability check (§3.3); the gate-only writer for the shared turbo cache (§3.2.2); D20's security-fix exception; the reconciliation of the two sizing rules (§3.2.1).
- **rev 1 (2026-10-28), after a Grok check of rev 0 (one blocker, five majors, one minor). All applied:**
  1. **Blocker:** auto-merge and the queue merge on required checks only, so a Tier 2 head could land without its Fable receipt. The receipt is now the required commit status `premerge`, posted per SHA by the orchestrator or conductor (Tier 2 `success` only after a Fable receipt for that head; Tier 0/1 `success` immediately with "not required for tier"), required beside `gate` on both merge paths, answered on merge-group commits, carried across a forge branch update only when the lane's diff is untouched; auto-merge is enabled after it. OS-7 depends on OS-1. New D33 (who may post it) and D34 (the receipt after a Fable-finding fix) (§3.3.1, §3.6.2, A-S1, OS-7, KS7, D20, D21).
  2. **Major:** D22 merged on CI that had not run on the merged result. D22 now sets strict up-to-date checks, updates a behind branch through the forge and re-runs CI, and re-checks disjointness at merge time (§1, §3.3, D22, D24).
  3. **Major:** receipt keys now include the predicate definition digest, toolchain versions and the declared environment digest; A-R2 enumerates the variables code and tests read, sets `envMode: "strict"` explicitly and adds a check that fails on an undeclared variable (§2.3, §3.2.2, A-R2, KS2, D29).
  4. **Major:** KS2 and KS4a both edited the manifest. The orchestrator now owns those edits in one Tier 0 commit (KM) before either lane; without KM they run one after the other (§4.4).
  5. **Major:** "start now" listed items that wait for open decisions. Only OS-1, OS-2, A-0 and the HS1/HS2 filing start now; A-R1 waits for D32, A-R2 for D27 or D32, OS-3 for D26, KS4a for the new pool decision D35 (§4).
  6. **Major:** inconsistent budgets. Horizon A sessions are scaled for 2–3 unit lanes (18 minutes), a Tier 2 fix round is a session plus a gate plus a re-review (15.5), one Tier 2 band (about 50 p50, 35–70) is used everywhere, and Horizon B's merged-result run is at least the `build-test` critical path (3). Tier 1 at about 17 still holds; Tier 2 moves to about 31 (title, §1, §3.2, §3.6).
  7. **Minor:** D26's skip could miss template, generator-version or barrel-source changes. The Tier 1 local gate keeps `sync:check` (concurrent) until HS1 ships (§3.4, A-3, OS-3, D26).

## Challenge this

The `premerge` carry-over across a forge branch update (§3.3.1). It saves a second Fable pass when `main` moves under a Tier 2 lane, and it is safe only if "the update touched no file in the lane's diff" really means the reviewed change is unchanged. A semantic conflict (a function the lane calls, changed on `main`) passes that test. CI on the merged result catches what tests cover; a reviewer should decide whether that is enough for Tier 2, or whether a Tier 2 head after any update waits for a new receipt.

Whether reviewing a head before its gate passes is worth it. It saves 3–5 minutes per lane only when the gate passes; when it fails, the review spent quota on a head that will change, and its findings may not apply to the fixed head. A reviewer should check how often gate #1 fails on recorded lanes and whether the fix brief's carried findings are useful or noise.

Whether 1–2 unit lanes shorten sessions as much as the budget assumes. A session has a fixed start (reading the brief, the files, the architecture) that does not shrink with the work order. If that start is 4–5 minutes, a 1-unit lane is closer to 9 minutes than 6, and Tier 1 lands nearer 20 than 17.
