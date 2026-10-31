# Plan: the daemon tick — one launchd job runs fleet-v2's merge pass, and the merge train becomes the conductor's merge stage

- **Date:** 2026-10-31. Anchors checked against `main` at `a05c2e34`; the remaining-work plan is read from `origin/docs/remaining-plan-rev2-tracks-2026-10-31` (§7), the continuous-replanning plan from `origin/docs/continuous-replanning-plan-2026-10-31`, the Jev veto decision from `origin/docs/jev-merge-veto-decision-2026-10-31`.
- **Target repository:** `fleet-v2`. The orchestrator's shell train (`pr.sh`, `train.sh`, `watch.sh`, `premerge.sh`) lives outside and is named only as the bridge this plan retires.
- **Status:** rev 1, after an independent Opus review of rev 0 (merge after fixes: two blockers, nine majors, nine minors; all applied, §10). Nothing built. Decisions D-DT1–D-DT9 (§7) are open with recommended defaults; D-JV1–D-JV5 are decided by the owner and folded in.
- **Owner decisions (2026-10-31):** replace the session-run shell train with one launchd (or cron) job that runs `fleet-v2 daemon tick` about every 60 s (`StartInterval`, not `KeepAlive`); each tick is a fresh process that takes a lease per registered job, does one bounded pass of each, writes status and events, and exits. The same binary later becomes the Fleet Cloud control-plane worker. **Unattended merge is approved** under the existing policy (PR clean under the strict up-to-date ruleset; required checks including `gate` and `premerge` success for the exact head; a macOS verification pass where the project requires it); every merge and drop emits a notification. Until then the orchestrator hardens the scripts as a bridge. **Jev veto** (D-JV1–5): escalation-only, shadow first, live after ≥ 20 merges with a false-hold rate ≤ 1/10, `holdConfidence` 0.8, fleet-v2 only.
- **Review folded in:** the Grok 4.7 review of the bridge (gh/jq failures terminal, queue not crash-safe, merge not SHA-pinned; parked-list keying, distinct park reasons with backoff, macOS verify only at a repo queue's head, update-branch bounded, a bare mirror, full SHAs, launchd environment, atomic status and an intent-then-result event log, named required contexts, thread pagination; cloud: merge authority in the control plane, per-repo queue and lease, fair admission, forge port with `gh` then GitHub App adapters, native queue only as an adapter, macOS verify as a per-project procedure). Every item has a home in §3.
- **Builds on:** `2026-10-27_conductor-plan.md` (§3.1, §3.5, §3.6, §3.7, K6, K7), `2026-10-28_lane-pipeline-speed-plan.md` (§3.3, §3.3.1, D22, D30, D33, KS1, KS7, A-S1, OS-1), `2026-10-31_remaining-work-plan.md` (Wave 1, §7.1, D-R2, D-R8), `2026-10-31_continuous-replanning-plan.md` (Phase 1, D-CR9), `2026-10-31_jev-merge-veto-decision.md`, `2026-10-16_decision-port.md`, `2026-10-20_auto-merge-policy-plan.md` (A3, A13), `2026-10-24_live-updates-and-state-resilience-plan.md` (E4, §3.4), `AGENTS.md`.

**Short answer.** The daemon is a thin tick over jobs. In v1 the tick carries the **merge pass**, the notifier and a daily replan digest; the conductor's driver stays `conductor run --live` (D-DT1). The merge pass is the conductor's K6 `merging` stage, not a second system: a conducted run's `merging` enqueues `(repo, pr, headOid)` and waits for the queue's verdict; a hand-run PR enters the same queue through `fleet-v2 merge enqueue`. One merge lease per repository; every forge action under a keyed intent in **the run journal** (`run-journal.json`, K1b's uniqueness); full SHAs; merges pinned to the verified head; one escalation-only Jev question before the merge intent. Status is one atomic `status.json`; `events.jsonl` is a projection. The bridge retires when §4.3's criteria are met.

## 1. Goal

A Mac that is awake merges green, verified PRs without a session open, and parks or drops the rest with a typed reason and a notification; a crash at any instant loses nothing and repeats no one-way action; the owner can stop it with one command; the same code runs later as a cloud worker with a different lease scope and forge adapter.

**Non-goals.** No merge queue of GitHub's (D22, A-0); no model decides to merge (the one model call, the Jev veto, can only hold); no change to what a merge requires; the daemon never resolves review threads, never writes a fix brief, never runs a local `git merge` or push into a PR branch; no API or web surface in v1; detached long conductor steps are a separate future plan.

## 2. What exists (checked on `main`, a05c2e34)

| Need | What exists | Anchor | Gap |
|---|---|---|---|
| A pass with a lease | `RunConductorPassUseCase`: driver lease via `ConductorDriverLeaseKeeper`, halt read, ≤ 8 steps per run, `releaseLeases`; `CONDUCTOR_LEASE_MS` 5 min | `packages/work-execution/src/application/use-cases/RunConductorPassUseCase.use-case.ts:1-80`, `application/ports/in/RunConductorPassPort.in-port.ts:13-50` | The CLI loops it with back-off and a runner tunnel (`apps/cli/src/conductor.ts:700-860`); steps take minutes and are not interruptible, so it does not fit a 45 s tick (D-DT1) |
| Lease rules | Pure CAS/fence decisions; `conductor-driver-lease.json` under the shared lock, atomic rename | `domain/lane-run-lease.ts:1-45`, `infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.ts:1-25` | Reusable; needs a scope id |
| Keyed journal | `LaneRunJournalEntryRecord` v1: intent/result/conduct; outcomes incl. `ambiguous`, `reconciled`; reason codes `^[a-z][a-z0-9-]{0,63}$`; uniqueness per key; key families step, stop, resume, `request/`, `reaper/`; retry `r1..r9` (`LANE_RUN_MAX_RETRY`) and **no retry on a one-way step**; attempt ordinal 1–32 | `domain/lane-run-journal.ts:1-80`; `domain/lane-run-keys.ts:110-135` | No `merge/` family; the merge family needs its own retry rule (§3.3) |
| Kill switch | `conductor-halt.json`, fail-closed reader | `domain/conductor-halt.ts` | No daemon pause distinct from the halt |
| Merge stage (K6, #397/#398) | `merging`: `trainFree` (no other run `merging` on the repo), `branchBehind` parks; `act merge` → `AutoMergeAttemptPort` under the **attempt id**, one-way key `merge@<head12>`, `waiting` refused; `reconcileMerge` reads the PR and refuses `merge-not-merged` so the decider acts again (which the spent one-way key then parks `step-refused merge`) | `advance-lane-run/merge.ts:333-405, 889-896, 957-990`; `ports/in/AutoMergeAttemptPort.in-port.ts:10-16` | No queue, no update, no named contexts, no macOS step; the request shape is attempt-bound |
| Forge actions | `ForgeActionRequest { actionId, attemptId, workOrderId, kind, expectedHeadSha, branchName, … }`; the adapter is bound to the installation's one repository (`repositoryArgs()`); `merge-pr` pinned `--match-head-commit`, A13 post-read; kinds `push-and-open-pr`, `push-to-pr`, `merge-pr` | `ports/out/ForgeActionPort.out-port.ts:14-20`; `ForgeActionAdapter.adapter.ts:216-219, 371-412`; `domain/coordination-keys.ts:5-18` | A repo-scoped request without an attempt; `update-branch`, `post-status` kinds |
| Forge reads | `gh pr view` → `mergeStateStatus`, 40-hex heads; `gh pr checks` buckets with `skipping` read as pass; `reviewThreads(first:100)`: more than 100 → `null` → `unknown` (fails closed) | `ForgeReadAdapter.adapter.ts:33-40, 82-85`; `packages/evidence-and-acceptance/src/infrastructure/adapters/ForgeEvidenceAdapter.adapter.ts:38, 59, 131-133` | Named contexts, success-only, creator check, pagination |
| Park notices | `LaneRunParkNoticeAdapter`: attention + keyed question, codes only | `infrastructure/adapters/LaneRunParkNoticeAdapter.adapter.ts:1-60` | The pattern for merge notices; E4 unbuilt |
| Change feed | In-process API feed; foreign writes seen as `resync` | `apps/api/server/wiring/changes/change-feed.ts:1-60` | FEED-K adds `merge` later; a fresh process needs a cursor, not a subscription |
| Verification | `verification.procedures` (`command`, `args`, `coverage`); receipts at a head | `packages/installation/src/types.ts:47-57` | Per-repo "procedure required before merge" |
| Decision port | Jev `choice` decisions, invariants 1–6, budget ledger, `JevRankingAdviceAdapter` in brief-knowledge | decision-port plan; Jev record §5 | Types to `@fleet/shared`; `MergeVetoPort` |
| Policy | `policy.conductor`, `policy.autoMerge`, revisions | `packages/installation/src/policy.ts:324-490` | `policy.daemon`, `policy.merge` |
| State files | `describeRecordListStore` only; the registry | `infrastructure/adapters/file-store.ts:788`; `state-files.ts:18-28` | Single-record, glob and JSONL descriptors (DT3) |
| `premerge` | KS1, KS7, OS-1, A-S1 planned | speed plan §3.3.1, §4.4; remaining plan Wave 1 | KS7's "enable auto-merge at head" conflicts with a macOS step that is not a CI status (D-DT3) |

## 3. The shape

### 3.1 The tick

`fleet-v2 daemon tick [--budget-seconds 45] [--job <id>]...` is one process. It reads the pause and halt markers and the registered jobs; for each job in fair order (§3.6) it takes the job's lease by CAS (holder `tick-<ulid>`, minted by the CLI and passed in), calls `job.pass({ nowIso, deadlineIso })`, releases the lease, then writes `status.json` atomically (temp + `rename`) and appends the tick's projection lines to `events.jsonl`. A job whose lease a live holder has is `skipped: lease-held`. A tick whose forge probe (`gh api rate_limit`, 10 s) fails runs no forge-touching job and reports `skipped: forge-unreachable`, counting no attempt against any PR (the wake rule, §4.1).

- **Budget.** `deadlineIso` is checked between steps; `budget-exhausted` is a normal outcome. Per-call deadlines stay in adapters (`gh` 30 s). Default 45 s under a 60 s interval; nothing waits for a check.
- **Exit codes.** 0 completed, or every job skipped or paused; 1 a job refused or an unreadable status store; 2 usage.
- **One store for intents.** Every external action of the merge pass is an intent/result pair in **`run-journal.json`** through `LaneRunJournalPort`, under the `merge/` key family (§3.3), `runId` null for CLI-enqueued PRs (as `request/` and `reaper/` keys already allow). K1b's uniqueness and `state check` cover it. **`events.jsonl` is a projection**: `{"version":1}` then one line per journal entry appended during the tick plus the tick's own job outcomes (`{ version, eventId, tickId, jobId, kind, key, outcome, reasonCode, recordedAtIso }`, journal rules for codes and secret shapes). It is regenerable from the journal and status history, is not a source of truth, and the notifier reads it by cursor.
- **Status file** `<stateDir>/daemon/status.json` v1: `tickId`, `startedAtIso`, `finishedAtIso`, `exitCode`, `paused`, `halted`, `forgeReachable`, per job `{ jobId, outcome, reasonCode, leaseFence, durationMs, nextNotBeforeIso }`, per repository `{ repoDigest, lastServedAtIso, queued, ready, parked, lastMergedHead12 }`, the notifier cursor. No paths, titles or texts.
- **`daemon status [--json]`**: exit 0 when the last tick finished within three intervals and no job's last outcome was `refused`; else 1. `daemon pause|resume` writes `<stateDir>/daemon/paused.json` (unreadable reads as paused). `doctor` gains one line.

### 3.2 `DaemonJobPort` and the registered jobs

```ts
interface DaemonJobPort {
  readonly jobId: string;            // 'merge-pass' | 'notifier' | 'replan-digest'
  readonly leaseScope: string;       // local: the job id, or 'merge/<repoDigest>'; cloud: '<org>/<repo>'
  pass(request: { nowIso: string; deadlineIso: string }): Promise<DaemonJobOutcome>;
}
type DaemonJobOutcome =
  | { outcome: 'completed'; progressed: boolean; reasonCode?: string }
  | { outcome: 'budget-exhausted'; progressed: boolean }
  | { outcome: 'skipped'; reasonCode: string }
  | { outcome: 'refused'; reasonCode: string };
```

| Job | Wraps | Lease scope | Notes |
|---|---|---|---|
| `merge-pass` | `RunMergePassUseCase` (§3.3) | one per repository, `merge/<repoDigest>` | The train |
| `notifier` | reads `events.jsonl` from the status cursor; one notification per `merged`, `dropped`, first `parked` per `(repo, pr, headOid, reason)`, `forge-error-exhausted`, `veto-hold`, pause/halt transitions | the job id | `MergeNotificationPort` → operator-coordination `OwnerNotificationPort` (E4); fixed text, ids and codes only |
| `replan-digest` | `ProposeReplanUseCase` dry-run (CR8-lite) once per calendar day; digest and lever count into `status.json`; stores nothing, asks nothing (D-CR9 unchanged) | the job id | After CR8-lite |

The conductor's driver pass is **not** a v1 job (D-DT1): its steps take minutes, `deadlineIso` is only checked between steps, jobs run serially so a long driver step would delay merges, and launchd does not overlap ticks. `conductor run --live` stays the driver; the tick and it share nothing but the state directory.

### 3.3 The merge pass (K6's merge stage)

**Record.** `MergeQueueEntryRecord` v1 in `<stateDir>/merge-queue.json`: `{ version: 1, entryId, repository: { owner, repo }, repoDigest (12 hex of owner/repo, computed by the adapter), pullRequest, headOid (40 hex), state, reason, attempt, notBeforeIso, enqueuedAtIso, enqueuedBy: 'conductor'|'cli'|'update', supersedes: entryId|null, runId|null, attemptId|null, workOrderId|null, tier, verifiedHeadOid|null, revision }`. Identity `(repository, pullRequest, headOid)`; a new head is a new entry and the old one ends `superseded`. States `queued → updating → awaiting-checks → ready → vetoing → verifying → merging → merged`, with `parked`, `dropped`, `superseded`. The pure decider `decideMergeStep(entry, facts, repoPolicy, nowIso)` never throws, never acts, **re-evaluates every fact each tick**, and returns `act <action> | wait <reason> | park <reason> | drop <reason> | supersede`; rows are evaluated top to bottom and `act merge` is reached only when every earlier row is false. Ids and digests enter through ports and use-case parameters, never from the domain.

**Keys** (`merge/` family added to `lane-run-keys.ts`, lane DTK): `merge/<repoDigest>/<pr>/<head12>/<action>[/r<n>]`.
- One-way actions `merge-pr`, `update-branch`, `post-status`: one key per `(repo, pr, headOid, action)`. A retry key `/r<n>` (n ≤ `LANE_RUN_MAX_RETRY` = 9) is minted **only** when the prior key has a final `refused` result whose reason is a transient `forge-error`, and a read-only reconcile has proved the postcondition absent (PR open at the same head and not merged; branch head unchanged; no status by our creator at the head). An `ambiguous` result is never retried: it is reconciled (§3.5 of the conductor plan) until it settles. The one-way rule of `lane-run-keys.ts:129-133` is therefore relaxed for this family by this proof step, and only there.
- Two-way actions `macos-verify`, `veto`: `/a<n>` attempt segment, n ≤ 32, as the step keys' attempt ordinal.
- `entry.attempt` counts parks with backoff; `maxAttempts` default **9** so the park cap and the key cap agree. Reaching either drops.

**Facts** (under the repo lease, each `unknown` with a code on failure): PR state and live head; `mergeStateStatus`; **required contexts by name** at the exact head (`policy.merge.repos[repo].requiredContexts`, default `['gate', 'premerge']`), green = `SUCCESS` only (`skipped`/`neutral` are not green for a required context), and for `premerge` the status `creator.login` must be the poster identity (D-DT8); review threads fully paginated; the verification receipt for the head; the Jev veto answer; halt and pause; the per-PR update count, **derived from the journal** (count of `update-branch` intents for `(repo, pr)` within the last hour, so a superseded entry resets nothing).

| Row | Decision | Bound |
|---|---|---|
| live head ≠ `headOid` | `supersede`; a conductor entry's run re-enqueues the new head; a CLI entry is re-enqueued by `merge enqueue` | — |
| halted or paused | reads only | — |
| `mergeStateStatus` `BEHIND`, policy `updateBranch` | `act update-branch` (`PUT …/pulls/{n}/update-branch`, `expected_head_sha` = headOid; grant `forge:update-branch`). The PUT is **202 async**: within the budget the pass re-reads the head up to 3 times; a new head → the pass itself writes the successor entry (`enqueuedBy: 'update'`, `supersedes`), state `awaiting-checks`; still the old head → result `ambiguous`, entry `updating`; next ticks reconcile by reading the head; unchanged after `updateGraceMinutes` (5) → the update is recorded `not-started` and the row re-applies under `/r<n>` | ≥ 3 updates for `(repo, pr)` in the hour → `park update-churn` |
| a required context pending, or missing within its grace (`gate` 5 min, `premerge` 20 min, others 0) | `wait checks-pending` | no attempt counted |
| a required context `failure`, or missing past grace | `park checks` (code names the context) | backoff; drop after `maxAttempts`; a new head supersedes |
| unresolved threads, or thread count `unknown` | `park threads` / `wait threads-unknown` | never resolved by the daemon |
| Tier 2, `premerge` absent on a head produced by `update-branch` | `act premerge-carry` → `post-status` by the poster identity, only when the **speed plan §3.3.1 rule** holds: `git diff --name-only <oldHead> <newHead>` touches only files changed on `main` since the old head's merge-base and none of them is in the lane's diff (`git diff --name-only <base>...<oldHead>`), **and** the three-dot patch-id is unchanged (an extra guard, not the rule); else `park premerge` until a new receipt | event names the receipt head |
| KS5 touch-list overlap with a PR merged since the head's merge-base (D22/D30 merge-time re-check) | `park disjointness` | **deferred until KS5** supplies touch lists; until then the strict up-to-date CI run is the only guard, as D22 states |
| green, up to date, head of the repo queue, policy names `macosProcedure` | `act macos-verify` (`/a<n>`) | only the queue head, only inside the pass under the repo lease, never from a poller; receipt binds `verifiedHeadOid` |
| verified (or no procedure required), `policy.merge.veto.mode ≠ off` | `act veto` (`/a<n>`): one Jev `choice` question bound to `verifiedHeadOid` (Jev record §3). `hold-for-human` with confidence ≥ `holdConfidence` (0.8): **live** → `park veto-hold` + notification; **shadow** → journalled `would-hold`, no effect. `merge-safe`, low confidence or `unknown` → no effect | fleet-v2 only (D-JV5); live only after D-JV3's record |
| `unattended` false for the repo | `park owner-merge` at `ready`: one attention item | — |
| all above false; head re-read equals `verifiedHeadOid` | `act merge-pr` with `--match-head-commit <verifiedHeadOid>`, A13 post-read | never a head that changed since verification |
| forge refusal `conflict` | `drop conflict` + notification | a new head re-enqueues |
| refusal `protection`/`permission`, `gh`/network error, 5xx, rate limit | `park forge-error`, `notBefore = now + min(30 s × 2^attempt, 30 min)` | after `maxAttempts` → `drop forge-error-exhausted` + notification |

**`MERGE_PARK_REASONS`:** `conflict`, `checks`, `threads`, `premerge`, `macos`, `forge-error`, `update-refused`, `update-churn`, `disjointness`, `veto-hold`, `owner-merge`, `policy-unreadable`. (The bridge logs the veto as `jev-hold`; the product code is provider-neutral.)

**Request shapes (new, repo-scoped).** The existing `AutoMergeAttemptRequest` and `ForgeActionRequest` need an attempt and a work order and the adapter is bound to one repository, so the merge pass does **not** call them. DTM/DT6 add `MergeForgeActionPort` with `MergeForgeActionRequest { actionId, repository, pullRequestNumber, branchName, expectedHeadSha, kind: 'merge-pr'|'update-branch'|'post-status', status?: { context, state, description } }`, implemented by `ForgeActionAdapter` through its existing `runGh`, pin and A13 internals, with `-R owner/repo` per call. Grants: a conducted entry (with `attemptId`) uses the AM3a policy grant path as today; a CLI entry uses a new `IssuePolicyForgeGrantPort` variant bound to `(repository, pr, expectedHeadSha)` with no attempt coordinates (`decisionRevision: policy:merge@<revision>`), consumed before the action as every grant is.

**Relation to K6, KS1, KS7.** `act merge` (one-way `merge@<head12>`) is replaced for conducted runs by a **two-way step `merge-enqueue`**, key `<runId>/r<n>/merge-enqueue@<head12>`, which may `wait`: its intent writes the entry (`mintedId` = entryId) and later advances read the entry: `merged` at the head → `merged`; `dropped conflict|checks|macos` → `fixing` if a round is left, else park (D5); `dropped forge-error-exhausted` → park `forge-error`; `veto-hold` → park `veto-hold`. `trainFree` and `branchBehind` leave `merge.ts`. KS1 keeps the `premerge` hold in `merging`, read from the entry. KS7 is re-cut: **KS7a** = `post-status` kind, key and grant (the `premerge` post); **KS7b** = the `merge-enqueue` hand-off. "Enable auto-merge at head" becomes an unbuilt optional adapter (D-DT3). `AutoMergeAttemptUseCase` stays for `attempt auto-merge` by hand.

### 3.4 Infrastructure and the hexagon

Owned by **work-execution**; evidence owns the receipt; operator-coordination owns notifications; `@fleet/shared` holds the decision-port types. Direction unchanged.

- **Domain** (pure; no clock, crypto or ids): `daemon-tick.ts` (plan, fair order, budget, status record v1), `daemon-events.ts` (projection record), `merge-queue-records.ts`, `merge-queue-decider.ts`, `lane-run-keys.ts` (+ `merge/`).
- **Application:** in `RunDaemonTickPort`, `InspectDaemonStatusPort`, `SetDaemonPausePort`, `EnqueueMergePort`, `RunMergePassPort`, `ListMergeQueuePort`; out `DaemonJobPort`, `DaemonLeasePort`, `DaemonStatusPort`, `DaemonEventProjectionPort`, `DaemonPausePort`, `MergeQueueRepositoryPort`, `ForgeMergeReadPort`, `MergeForgeActionPort`, `MergeGrantPort`, `PatchIdentityPort`, `MergeVerificationPort` (→ evidence), `MergeVetoPort` (→ the decision port), `MergeNotificationPort` (→ coordination), `MergePolicyPort`.
- **Infrastructure:** `DaemonLeaseAdapter` (`daemon/leases/<scope>.json`), `DaemonStatusFileAdapter`, `DaemonEventProjectionAdapter`, `DaemonPauseAdapter`, `MergeQueueRepositoryAdapter`, `GhForgeMergeReadAdapter` (`gh api graphql`: `statusCheckRollup.contexts` and `reviewThreads` both paginated; `creator.login`; error classification), `ForgeActionAdapter` (+ `MergeForgeActionPort`), `GitMirrorPatchIdentityAdapter` (bare mirror `<stateDir>/mirrors/<repoDigest>.git`, allow-listed argv via `CommandExecutorPort`, never the live checkout), `MergeVerificationAdapter`, `JevMergeVetoAdapter` (over the shared decision client, receipts as evidence, budget ledger), `MergeNotificationAdapter`; in operator-coordination E4's local adapter (C). Later: `GitHubAppForgeAdapter`, `NativeAutoMergeAdapter`, a Kubernetes lease adapter, a webhook wake.
- **State files (DT3):** `file-store.ts` gains `describeSingleRecordStore` (status, paused), `describeRecordGlob` (leases) and `describeJsonlProjection` (events: readable-or-not, never a failure of `state check`); `merge-queue.json` is a record-list store. All registered in `state-files.ts:18-28`.
- **Manifest:** DTM (T0) lists ports, use cases, adapters and bindings (`MergeVerificationAdapter → evidence-and-acceptance/RequestVerificationPort, InspectAcceptanceEvidencePort`; `MergeNotificationAdapter → operator-coordination/OwnerNotificationPort`; `JevMergeVetoAdapter → shared decision client`); notes extended on the existing mapping rows.
- **Composition roots:** `apps/cli/src/daemon.ts` (`daemon tick|status|pause|resume`), `apps/cli/src/merge.ts` (`merge enqueue <owner/repo> <pr> --head <sha40> [--tier] | list | drop | retry`), `apps/cli/src/composition/daemon.ts`; one registration each in `index.ts`/`composition.ts`. CLI I/O at the boundary only.
- **Track:** A for everything above including `@fleet/shared` (§7.1); E4 on C; `deploy/staging` cloud manifests on C, unscheduled.

### 3.5 Cloud shape (ports cut for it; not built)

Merge authority stays in the control plane: the merge pass is the only holder of a merge-capable credential, and K6's hand-off means acceptance → grant → merge happen there; runners hold no push or merge tokens. The tick runs as a Deployment or CronJob; `leaseScope` becomes `<org>/<repo>`; fair admission orders repositories by `lastServedAtIso` round-robin across orgs then repos. A GitHub App webhook writes a wake record and runs one tick early for that scope (locally, launchd `WatchPaths` on `<stateDir>/daemon/wake`). GitHub's native merge queue is an optional adapter behind the same decider; macOS verification is a per-project procedure (absent = `unknown`, never a pass where required).

### 3.6 Safety: the unattended-merge one-way door

Approved by the owner on 2026-10-31. Guards, each with a test:
- **Kill switches.** `conductor halt` stops every external action of every job; `daemon pause` stops the jobs except status and the notifier's "paused" line; `launchctl bootout` stops the job.
- **Per-repo policy** `policy.merge.repos[repo] { unattended, requiredContexts, updateBranch, macosProcedure?, maxAttempts, checksGraceMinutes, veto: { mode: off|shadow|live, holdConfidence } }`; re-read before every action. For fleet-v2 `unattended` is the owner's approval already recorded; §4.3(5) flips it mechanically.
- **Every action notifies**, codes and ids only.
- **Never a head that changed since verification** (re-read before the intent; `--match-head-commit`; a moved head supersedes).
- **Never resolve a thread; never merge `main` into a branch by local git.** Branch updates only through the forge's `update-branch` with `expected_head_sha`, bounded (D-DT4).
- **One action per entry per tick, under a unique key in the run journal; intent before action; reconcile, never repeat.**
- **Tier 2 needs `premerge: success`** by the poster identity on the exact head; a carry needs the §3.3.1 file rule.
- **Fail closed on facts:** an unreadable policy, lease, marker or forge answer is `unknown`, and unknown never merges. **The veto is the one exemption:** its `unknown` never blocks (D-JV1, decision-port invariant 1), so Jev can only make a merge more conservative.
- **Two identities** (D-DT8): the `premerge` poster can write statuses only; the merger can write pull requests and contents only. Neither can both attest and merge.

## 4. Ops

### 4.1 launchd

Template `deploy/launchd/fleet-v2-daemon.plist.tmpl` (placeholders only), rendered by `fleet-v2 hosts daemon install [--interval 60] [--budget 45]` into `~/Library/LaunchAgents/com.fleet-v2.daemon.plist` from an ignored `daemon` section of the installation file; `show|uninstall` print keys only and `launchctl bootout`. Nothing rendered is committed.

- `Label com.fleet-v2.daemon`; `ProgramArguments [<node>, <dist>/bin.js, daemon, tick]`, absolute; `StartInterval 60`; `RunAtLoad true`; `ProcessType Background`; `Nice 5`; **no `KeepAlive`**; stdout/stderr under `<stateDir>/daemon/logs/`, rotated at 10 MB.
- `EnvironmentVariables`: absolute `PATH` (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`), `HOME`, `FLEET_STATE_DIR`, the installation file, **two** gh config directories (`FLEET_GH_CONFIG_PREMERGE`, `FLEET_GH_CONFIG_MERGE`; the adapter sets `GH_CONFIG_DIR` per invocation by action kind), `GIT_SSH_COMMAND="ssh -F <stateDir>/daemon/ssh_config -o BatchMode=yes"` with an `IdentityFile` usable without the GUI keychain, restricted on the verifier host to the procedure's command. Nothing from the runner allow-lists.
- **Wake.** launchd coalesces missed intervals into one tick; the forge probe turns a cold network into `skipped: forge-unreachable`; `policy.daemon.settleSeconds` (20) delays the first job of a tick whose previous status is older than three intervals.

### 4.2 Bridge (outside this repo; listed for sequencing)

Hardened now: `pipefail`; `gh`/`jq` failures retried with backoff, never terminal; queue file rewritten after the work; a lease file with pid and expiry; full SHAs; `--match-head-commit`; the Jev shadow call in `pass.sh` (D-JV2). OS-1 keeps posting `premerge`. **Until KS7b lands**, conducted runs still park `owner-merge` or `branch-behind` in `merging`, and the bridge train merges their PRs; the run leaves its park when the PR merges (CT-2a, `merge.ts:333-340`). DT0 amends rev2 lines 422, 681 and 704 accordingly: "conducted Tier 1 PRs merge through the daemon's merge pass after KS7b; until then through the bridge, the run leaving its park on the merge".

### 4.3 Retirement criteria

(1) Shadow for 3 days: the merge pass's `would merge` events match the bridge's merges with no divergence on head or verdict; (2) every park reason and the intent-without-result reconcile have an e2e test and a live `forge-error` backoff was observed; (3) the orchestrator has enqueued through `merge enqueue` for 3 days; (4) a sleep/wake produced a `forge-unreachable` skip and a fresh status within two intervals; (5) **mechanical flip** of `unattended` for fleet-v2 by the orchestrator once (1)–(4) pass — a code-trust gate over the owner's existing approval, not a new decision (D-DT6). Then `train.sh`/`watch.sh` stop; `pr.sh` wraps `merge enqueue`; `premerge.sh` stays until KS7a posts from the daemon.

## 5. Workbook

~45 min each, one PR, Track A unless marked; shared files in bold. Nothing precedes **KS1 → KS7a → OS-1 posts → A-S1** (D-R2 stands, `allow_auto_merge` removed); no stored record before **Q5b** (D-R8). Pure lanes and the manifest text start now on A's stream (iii). **The two cli slots (DT4, DT10) are placed right after TD3b in A's serial `index.ts` list**, ahead of WB7a (rev2 §7.1), because the bridge stays live until they land; WB7a–WB12b shift by two slots (~1.5 h).

| Lane | Scope | Package / shared files | Tier | After | Acceptance |
|---|---|---|---|---|---|
| DT0 | This plan; manifest text; KS7 → KS7a/KS7b in the speed and remaining plans; A-S1 without `allow_auto_merge`; rev2 lines 422/681/704 amended (§4.2); D33 amendment note (D-DT8) | docs | 0 | §7 | Markers in place |
| DT1 | `merge-queue-records.ts`, `merge-queue-decider.ts` (pure; one test per row of §3.3) | work-execution domain, **barrel** | 2 | DT0 | Never throws; same (entry, facts, policy, now) → same decision; `unknown` facts never yield `act merge-pr`; veto `unknown` has no effect |
| DT2 | `daemon-tick.ts`, `daemon-events.ts`: plan, fair order, budget, status/projection records | work-execution domain, **barrel** | 2 | DT0 | lease-held → skipped; paused → no job; forge-unreachable → no forge job |
| DTK | `merge/` key family in `lane-run-keys.ts`: one-way keys, proof-gated `/r<n>`, `/a<n>` for two-way actions | work-execution domain | 2 | DT1 | Parse/build round-trip; `/r<n>` refused without the proof flag; n ≤ 9 |
| DTM | Manifest: ports, use cases, adapters, bindings; `yarn sync` | **manifest**, **barrels** | 0 | DT1, DT2, DTK | `lint:arch`, `sync:check` |
| DT3 | Lease, status, pause, projection adapters; new `file-store.ts` descriptor kinds; registry | work-execution infra, `file-store.ts`, `state-files.ts` | 2 | DTM, Q5b | Kill mid-write leaves the file intact; fence never goes back; `state check` reads all four kinds |
| DT4 | `MergeQueueRepositoryAdapter`, `EnqueueMerge`, `ListMergeQueue`; `merge enqueue|list|drop|retry` | work-execution; cli **`index.ts`, `composition.ts`** | 2 | DTM, Q5b | Non-40-hex head refused; duplicate returns the first; new head supersedes |
| DT5 | `GhForgeMergeReadAdapter`: named contexts (SUCCESS only, creator), paginated threads and contexts, merge state, error classification | work-execution infra | 2 | DTM | Fixtures: missing context ≠ green; `skipped` required ≠ green; 150 threads read; network error → `forge-error` |
| KS7a | `post-status` kind, key, grant; `premerge` post | work-execution, `coordination-keys.ts`, **`composition.ts`** | 2 | KS1 | Speed plan KS7 acceptance for the post |
| DT6 | `MergeForgeActionPort` (repo-scoped; `merge-pr`, `update-branch`, `post-status`), `MergeGrantPort` and the attempt-less grant variant, per-kind `GH_CONFIG_DIR` | work-execution infra; operator-coordination grant use case | 2 | KS7a | Moved head refused before the call; 202 then re-read; a merge with the premerge identity is refused (`permission`) |
| DT7 | `GitMirrorPatchIdentityAdapter` with the §3.3.1 file rule and the patch-id guard | work-execution infra | 2 | DTM | Lane file touched by the update → no carry; path confinement |
| DT8 | `MergeVerificationAdapter` → evidence procedure at head | work-execution infra | 2 | DTM | Other-head receipt = unknown; absent procedure where required = unknown |
| DT-V1 | Decision-port types and client to `@fleet/shared` (Jev record §5.4) | **`@fleet/shared`**, brief-knowledge import | 2 | — | brief-knowledge's adapter unchanged in behaviour |
| DT-V2 | `MergeVetoPort`, `JevMergeVetoAdapter` (fields of Jev record §3; redaction; budget; receipts) | work-execution infra; evidence receipt | 2 | DT-V1, DTM | Secret-shaped field → `unknown/redaction-refused`; shadow never acts |
| DT9 | `RunMergePassUseCase`: facts, decider, one keyed action per entry, reconcile, successor entries, notifications | work-execution app | 2 | DT3–DT8, DT-V2, KS7a | Crash after `merge-pr` → `reconciled`, no second merge; conflict → drop; backoff caps at 9 and drops; shadow hold journalled |
| DT10 | `RunDaemonTickUseCase`, `InspectDaemonStatus`, `daemon tick|status|pause|resume`, job registry | work-execution app; cli `daemon.ts`, `composition/daemon.ts`, **`index.ts`, `composition.ts`** | 2 | DT9 | Two ticks → one skips on lease; `--job` filter; exit codes |
| DT11 | launchd template, `hosts daemon install|show|uninstall`, `doctor` line, `docs/runbooks/daemon.md` | cli `hosts.ts`, `deploy/launchd/`, docs | 2 + 0 | DT10 | No `KeepAlive`, absolute paths, both config dirs; nothing rendered is tracked |
| E4 | `OwnerNotificationPort`, local adapter, `policy.notifications` | operator-coordination (C, W6) | 2 | — | Its plan |
| DT12 | `MergeNotificationAdapter`; notifier job | work-execution infra; cli registry | 2 | E4, DT10 | No path or title in text; one per (event, id) |
| KS7b | `merge-enqueue` step and key; `act merge` replaced; `trainFree`/`branchBehind` removed; drop mapping | `advance-lane-run/merge.ts`, `lane-run-keys.ts`, decider | 2 | KS7a, DT9 | Q1c e2e reaches `merged` through the queue; a drop with a round left → `fixing` |
| DT13 | `replan-digest` job | cli registry | 1 | CR8-lite, DT10 | Once a day; stores nothing |
| DT14 | e2e: fake `gh` replay of every park reason; wake probe; concurrent ticks; veto shadow | `tests/e2e`, `gate.yml` | 1 | DT10 | All reasons exercised |
| DT-C | Cloud adapters and manifests | infra; `deploy/staging` (C) | 2 | bridge retired | Not scheduled |

Chains: DT1 ‖ DT2 → DTK → DTM → (DT3 ‖ DT4 ‖ DT5 ‖ DT7 ‖ DT8 ‖ DT-V1→DT-V2) → DT9 → DT10 → DT11 → DT12/13/14; KS1 → KS7a → DT6 → DT9; KS7b after DT9. ~17 Tier 2 lanes (~21 h at 3 in flight; ≈ 34 Fable sittings), 2 T0, 3 T1.

## 6. Hard to undo

- **Unattended merges** (owner, 2026-10-31): events name policy revision, grant, verified head, receipt head, veto answer. Rollback is pause or `unattended: false`; nothing un-merges.
- **Stored codes and records:** the `merge/` key family and its retry proof, `merge-enqueue` step, `MergeQueueEntryRecord` v1, status v1, `MERGE_PARK_REASONS` (incl. `veto-hold`, `disjointness`), forge kinds `update-branch`/`post-status`, grant scope `policy:merge@` (D-R8: absent is 1, unknown refused; codes additive).
- **Two credentials** on the orchestrator's Mac and the passphrase-less verifier key: revoke and re-issue is the undo.
- **PR metadata sent to Jev** (fleet-v2 is public; others off, D-JV5).
- **Plist label**; **events projection format** (versioned).

## 7. Decisions for the owner

| # | Question | Recommended |
|---|---|---|
| D-DT1 | Does the conductor's driver pass join the tick? | **Not now.** Steps take minutes, `deadlineIso` is between steps only, jobs are serial and launchd does not overlap; a driver job would delay merges and stall ticks. v1 tick = merge pass + notifier + replan digest; `conductor run --live` stays; detached long steps are a future plan |
| D-DT2 | Merge intents in the run journal (`merge/` family) or a separate store? | **The run journal:** one uniqueness check, one `state check`, one reconcile rule; `events.jsonl` is a projection |
| D-DT3 | GitHub auto-merge (KS7's "enable at head") or the daemon merges? | **The daemon merges, SHA-pinned; auto-merge off.** Auto-merge cannot update a branch and the macOS step is not a CI status. Native auto-merge is an optional adapter; A-S1 drops `allow_auto_merge` |
| D-DT4 | May the daemon update a behind branch? | **Yes, forge-only:** `update-branch` with `expected_head_sha`, ≤ 3 per PR per hour (journal-derived), per-repo `updateBranch`; never local git. D22 requires it |
| D-DT5 | Carry Tier 2 `premerge` across an update? | **Carry under the speed plan §3.3.1 file rule** plus the patch-id guard; the event names the receipt head; S7 counts escaped defects after a carry. (§3.3.1's own "Challenge this" stands) |
| D-DT6 | Unattended per repository | **Absent = attended.** For fleet-v2 the owner's approval is recorded; §4.3(5) is a mechanical flip once (1)–(4) pass, not a new decision |
| D-DT7 | Notification channel | **E4's local adapter** through a consumer-side port; webhook later |
| D-DT8 | Identities | **Split:** a statuses-only poster (D33 as written) and a merger with pull-requests + contents write, each in its own `GH_CONFIG_DIR`, both on the orchestrator's Mac only. The alternative — one identity with both — is an explicit **D33 amendment** the owner would have to make; not recommended, since one credential could then self-attest `premerge` and merge |
| D-DT9 | Interval and budget | **60 s / 45 s**, `policy.daemon { intervalSeconds, budgetSeconds, settleSeconds }` |

## 8. Assumptions

- `gh api` can `PUT …/update-branch` with `expected_head_sha` (202) and post statuses with the poster token on a user-owned repository; a 422 on a moved head is classifiable.
- `gh pr merge --match-head-commit` keeps refusing a moved head.
- The verifier host accepts a `BatchMode` ssh with a command-restricted key.
- launchd runs one coalesced tick after wake.
- One state directory per installation; the tick and `conductor run --live` share only stores and K1b keys.
- E4 lands on C before DT12; until then merges and drops are visible in `daemon status` and the projection.
- Q5b precedes every stored record here (D-R8); DT1/DT2/DTK and the manifest text do not wait for it.
- Required contexts after A-S1 are exactly `gate` and `premerge`; a required macOS check is named in `requiredContexts` or as `macosProcedure`, never both.
- The decision-port client moves to `@fleet/shared` without changing brief-knowledge's behaviour (Jev record §5.4).

## 9. Challenge this

Whether "one process" is honest when the conductor's driver stays outside the tick (D-DT1): the plan now says it plainly, and the only way to change it is detached long steps with a reconcile, a larger change to `advance-lane-run/*` than this plan admits; a reviewer should decide whether that plan should be written before the daemon is called the control plane. Whether the proof-gated `/r<n>` retry on a one-way `merge-pr` key is a hole in K1b's "one-way is never re-sent": the proof is a forge read that the PR is open at the same head, which is exactly what `reconcileMerge` does today before the decider acts again; the difference is only that the second act has a key. Whether the `premerge` carry (D-DT5) should exist for Tier 2 at all. Whether a repo queue should order by enqueue time or by chain-head priority (rev2 §7.6): the decider has no priority, and adding one is owner policy. Whether the Jev veto earns its call over the countable rules the Jev record itself names; the shadow trial logs both. And whether a passphrase-less ssh key on the orchestrator's Mac is an acceptable price for unattended macOS verification, or whether that step should stay attended until the verifier is a fleet host.

## 10. Review record

2026-10-31, independent review (Opus) of rev 0: merge after fixes. Two blockers, nine majors, nine minors; all applied.
- **2a (blocker), keys without an attempt segment vs. `maxAttempts` 20:** §3.3 defines the `merge/` scheme: one key per one-way `(repo, pr, head, action)`; `/r<n>` (n ≤ 9) minted only after a final transient `refused` and a read-only proof that the postcondition is absent; `/a<n>` for two-way actions; `maxAttempts` lowered to 9 so caps agree; the relaxation of `lane-run-keys.ts:129-133` is named and scoped to the family (DTK).
- **2b (blocker), one store:** `run-journal.json` via `LaneRunJournalPort` holds every merge intent; `events.jsonl` is a regenerable projection (§3.1, D-DT2).
- **2c (major), "the merge call is the existing one":** withdrawn. `MergeForgeActionPort`/`MergeForgeActionRequest` (repo-scoped, no attempt) and `MergeGrantPort` with an attempt-less grant variant defined in §3.3 and DT6.
- **2d (major), update-branch bound and 202:** bound is ≤ 3 per `(repo, pr)` per hour derived from the journal; the pass writes the successor entry itself (`enqueuedBy: 'update'`, `supersedes`); 202 handling and the `updateGraceMinutes` reconcile rule added (§3.3).
- **2e (major), carry rule and D34 citation:** the §3.3.1 file rule is the rule, patch-id an extra guard; D34 citation removed (§3.3, D-DT5).
- **2f (major), D33 identity widened:** identities split (poster statuses-only; merger PR + contents); a single identity is flagged as an explicit D33 amendment, not recommended (D-DT8, §3.6, §4.1, DT6 test).
- **2g (major), D22/D30 merge-time disjointness:** decider row `park disjointness` added, deferred until KS5 (§3.3).
- **2h (major), D-R2 and rev2's "auto-merge outside the loop":** §4.2 states the interim (bridge merges; the run leaves its park on merge, CT-2a `merge.ts:333-340`); DT0 amends rev2 lines 422, 681, 704.
- **3c (major), cli slot placement:** DT4/DT10 placed right after TD3b in A's serial list, with the stated shift (§5).
- **4a (major), Jev veto:** `MergeVetoPort` row after verify and before the merge intent, bound to `verifiedHeadOid`; `veto-hold` reason added to `MERGE_PARK_REASONS` and §6; shadow/live per D-JV2/3; fleet-v2 only; §1 non-goal and §3.6 unknown rule amended; DT-V1 (shared types, Track A) and DT-V2 added.
- **4c (major), D-DT1:** "not now"; v1 tick = merge pass, notifier, replan digest; §3.2 and §9 updated.
- **1 (minor):** threads > 100 read as `null` → `unknown` (fails closed); `state-files.ts:18-28`.
- **2i (minor):** KS7b's hand-off is its own two-way step `merge-enqueue` with key `<runId>/r<n>/merge-enqueue@<head12>`.
- **2j (minor):** green = `SUCCESS` only, `skipped` not green for a required context; `premerge` creator verified; `gate` grace 5 min.
- **2k (minor):** the decider re-evaluates all facts each tick and reaches `act merge-pr` only when every earlier row is false.
- **3a (minor):** ids and digests enter through ports/parameters (§3.1, §3.3, §3.4).
- **3b (minor):** `file-store.ts` descriptor kinds for single-record, glob and JSONL files, owned by DT3.
- **3d (minor):** DTM (T0 manifest) split from DTK (T2 key family).
- **4b (minor):** D-DT6 and §4.3(5) made a mechanical flip over the owner's existing approval.
