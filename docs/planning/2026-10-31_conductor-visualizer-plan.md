# Plan: conductor concurrency visualizer

- **Date:** 2026-10-31
- **Status:** rev 1. Drafted by Grok 4.7 (rev 0), reviewed by Fable, revised by Grok (rev 1). The owner asked for it to be built, merged and deployed on 2026-10-31; D-VZ1 and D-VZ8 are decided, and D-VZ2–D-VZ7 and D-VZ9 are adopted as recommended under that instruction. Amends A-R and W7a of `2026-10-27_web-ui-interactivity-plan.md`. Record in `2026-10-31_remaining-work-plan.md` §7 as **A-R-1** / **W7a-1** so those items are not dispatched again. Fact pack: `main` `8dfda58d`. Fable review applied; see §9.

Read-only picture of one conductor pass. List order is creation order (`runId` localeCompare; ULIDs are time-ordered). Workers take from that queue. Per run the order is lease, then pending resume, then up to 8 steps. A step is the decider, then the admission hook (admit, then a non-journalled wait). The session-start gate is consulted only when the intent is `dispatch`, `brief-check`, or `code-review`. There is no priority sort to draw. v1 explains that policy.

## 1. Goal and non-goals

**Goal.** A Conductor page (W7a-1), fed only by `/v1/*`, showing current occupancy and, once recorded, the last passes: who ran, who waited and why, which host slot and package key they hold, and how full the caps are.

**Non-goals (v1).** No start, stop, halt, resume, or reorder. No AlertBox actions. No fixture fallback at runtime. No chart library. No change-feed kind. No journalling of waits. No enforcement of profile `maxConcurrentLanes`. No `GET /v1/board`, no `WaitGuard`, no `GET /v1/conductor/schedule`. The schedule is `GET /v1/runs` (A-R-1). CLI and API are views of the same read model, not a second scheduler. WB2b/WB2c, TD/WB routes, FEED-K, and the L-series do not overlap; copy says **admission wait**, never the board's "Waiting" column.

## 2. What the UI shows

**(a) Scheduler board — buildable now.** Rows in creation order. Columns: run id, state, round, package keys, host alias + slot, placement `running | waiting | parked | halted` from state, `pendingIntent`, and park only.

- Park chip from `LaneRunParkRecord`. Pending-step chip from the journal's pending intent. No inferred wait reason. Where the row is waiting, the copy is "waiting (reason recorded per pass once traces exist)". Where the cap or a package overlap blocks, the label is **admission wait** (still without a guessed `LaneRunWaitReason`).
- Host lanes: one column per `hostName` with a held reservation; cells are `slotIndex` + run id. Free-slot count only when that pass's recorded `maxLanes` is on the trace; until then, held count only.
- Package lanes: keys from `laneRunPackageKeys`. Overlap badge when two live rows share repository + key. Unreadable work order is a badge, not a guess.
- Cap gauge: numerator `active + inFlight` by the admission rule (held reservation, not terminal, plus held reservations no run references). Denominator `maxActiveRuns` is absent until a trace stores it; the gauge then reads "cap not recorded".
- Session-start strip: intent `recordedAtIso` for `dispatch`, `brief-check`, `code-review`. Draw gaps. Mark a gap under the stagger only after a trace stores `dispatchStaggerMs` (the 20s default is not assumed on screen).

**(b) Sort trace — new recording.** Last 32 completed passes, newest first. Each: `nowIso`, `halted`, `progressed`, `passConcurrency`, `maxActiveRuns`, `dispatchStaggerMs`, runs in worker-take order, each run's report. For `advanced`, up to 8 steps and the last outcome (`waiting` reason, `parked`, `done`, `acted`, `refused`, …). `skipped` / `resume-refused` show their reason. Attention: `stop-grace-exceeded`, `out-of-scope-findings`. This is the only honest "why this run waited" view. The CLI already prints one JSON line per pass to stdout; that line is not durable.

**(c) Concurrency strip.** SVG from `reservations.json`: held count over time (`reservedAtIso` → `releasedAtIso`). Do not plot a live-run series in v1 (run records have no timestamps; parked stays live). A series from journal `conduct` `recordedAtIso` is possible later and is out of scope. After traces exist, overlay one sample per pass: active count and wait counts by `LaneRunWaitReason`. No per-wait history before the first traced pass.

## 3. Data

| View | Existing records | Gap |
| --- | --- | --- |
| Board order, state, park, pending step, lease lapsed | `lane-runs.json`, `run-journal.json` (same facts as `InspectLaneRuns`) | Halt + driver lease already derived for inspect; reuse |
| Host slot, in-flight | `reservations.json` (`held`, `hostName`, `slotIndex`, `attemptId`) | Per-host `maxLanes` is `candidateHosts` in the installation file, not these JSON files |
| Package keys, overlap | `work-orders.json` + `laneRunPackageKeys` | Unreadable order already blocks admission; show that |
| Active count | runs + journal terminal check + reservations | `maxActiveRuns` is only the admission adapter's cap (CLI `--max-active-runs`, default 1) |
| Session-start times | journal intents | Stagger is a use-case constructor dep (default 20_000), not stored |
| Sort trace, real wait reason, pass samples | — | Completed result is printed by the CLI and not stored |

**Do not journal admission waits.** `waiting` is not a conduct state. `RunConductorPassRequest` stays `{holderId, nowIso}`. Do not add request fields.

**Smallest new record** — `conductor-passes.json`. Field `schemaVersion`. Absent means 1. Any other value is refused and the ring is not appended. When Q5a lands, this record adopts Q5a's `schemaVersion` convention unchanged (owner, D-VZ8).

```ts
// schemaVersion: 1; ring length 32; newest last; one file replace
ConductorPassTrace {
  schemaVersion: 1; passId: string; nowIso: string; holderId: string; // stored, never sent
  halted: boolean; progressed: boolean;
  maxActiveRuns: number; passConcurrency: number; dispatchStaggerMs: number;
  runs: { runId: string; report: ConductorRunReport }[];
  attention: ConductorAttentionItem[];
}
```

Written only from the CLI `eachPass` of `conductor run --live`, and only when `outcome` is `completed`. Dry-run and `--once` dry-run write nothing (scratch stores, own callback). A refused pass is not a sort. The three limits are already in the CLI: pass them into the trace adapter at construction (`maxActiveRuns` from the admission adapter / `--max-active-runs`; `passConcurrency` and `dispatchStaggerMs` from the use-case constructor deps). Bounds: drop step arrays beyond 8; drop traces beyond 32.

**Read model.** `deriveConductorSchedule(facts, nowIso)` is pure. Facts: runs, journal-derived status, reservations, attempt id → run, work-order package keys, optional latest traces, optional recorded caps. It does not read the clock. Unknown `schemaVersion` fails closed as `unreadable`.

**Routes** (existing bearer, no new scope). `GET /v1/runs` is the A-R-1 shape: the `InspectLaneRuns` view plus reservations, package keys, and `admission { active, inFlight, maxActiveRuns|null }`. `GET /v1/runs/passes?limit=`. Envelope `operationId` + `code`. DTO omits `holderId` (divergence from the later A-R run card, which shows the lease holder; this page does not), `sshAlias`, `port`, `transport`, `worktreePath`, and the lease `holderId`. Keep host-name alias (already on `GET /v1/attempts`). Step `detail` is a fixed token or a reason code; `acted.key` is ids or head12 only; `resume-refused.reason` stays the typed reason. `truncated: true` when the ring or the run list is cut.

**Feed.** No `lane-run` kind in v1. Neither run store emits a signal. The page polls.

## 4. Hexagonal placement

- **Domain** (`packages/work-execution`): `deriveConductorSchedule`, `deriveReservationSeries`, `deriveSessionStartMarks`, overlap via `laneRunPackagesOverlap`. Pure. Unknown record version → `unreadable`.
- **Ports.** In: `ListLaneRunsPort` (A-R's read use case), `ListConductorPassesPort`. Out: `ConductorPassTracePort` (`append`, `list`). The read use case depends on `Pick<ConductorHaltPort | ConductorDriverLeasePort, 'read'>` only, as `InspectLaneRunsUseCase` does. API composition builds the halt and driver-lease adapters for that read (no `readOnly` flag exists) and reuses the read-only `laneRunRepo` / `laneRunJournal` open. Inspect is wired in the CLI today and is new in the API.
- **Manifest (§7.1).** Before lane 2, track A lands a Tier-0 commit of `.architecture/manifest.yaml` (ListAttempts is the precedent; no conductor in-port is in the manifest yet). The lane is dispatched after that commit. The brief forbids `.architecture/`. The lane runs `yarn sync` so `@generated` barrels update. Lanes do not edit the manifest.
- **Adapters.** JSON ring beside the other state files. Append is lock + temp-file + rename (same precedent as `LaneRunRepositoryAdapter`). `RunConductorPassUseCase` is unchanged and does not append. `eachPass` in `conductor run --live` calls `append` with the completed result and the three limits. The adapter never throws; it returns `{recorded | not-recorded, reason}`. The CLI prints one line on `not-recorded` and continues. A throw inside `eachPass` would end the loop and release leases, so it must not throw. One writer: only the driver-lease holder completes a pass, and the result is final after `Promise.allSettled`.
- **CLI.** `fleet-v2 conductor schedule [--json] [--passes]`. Same use case as `GET /v1/runs`. Text is a short table; `--json` is the DTO. Takes one turn in A's serial CLI list. `conductor status` already wires inspect repos.
- **API.** `apps/api` wires the use case beside `ListAttempts`. No domain import from `apps/web`.

## 5. Web

- Route: `/conductor`, recorded in `view-nav.tsx` `VIEWS` as W7a's entry (label Conductor). `apps/web/src/app/conductor/page.tsx` (`force-dynamic`). Server load through `lib/api-client.ts`. Reads never throw. Empty `baseUrl` → not-configured (`Banner`: "api boundary is not configured"). No fixture branch. `NOT_IMPLEMENTED` (501) is not-configured, not fake rows. Precedent: `questions/live.ts`.
- Components stay on the page until a second consumer exists: `ScheduleBoard`, `CapGauge` (CSS), `SessionStrip` and `ConcurrencyStrip` (inline SVG), `PassList` (accordion). Filters and row selection are immediate. A selected row is `aria-expanded` plus a step list. No inferred wait chip.
- States: not-configured; empty ("no live runs"); halted banner (rows still listed); stale (`observedAtIso`, "cap not recorded").
- A11y: text with every colour; table semantics; buttons are selection only; focus visible; contrast from existing tokens. Under 720px: stack the board; horizontal scroll on the strips. `prefers-reduced-motion: reduce` on the strips. The strip has a text-table fallback.
- Refresh: existing 30s visible-tab `router.refresh()`. Stop when not configured.
- Tests: no JSX/DOM runner. Pure mappers + source-text assertions. Add the §7.6 parity test (`apps/web/src/lib/api/*.test.ts` type-checks the mapper against a response the route tests recorded). SVG scales live in a pure module with unit tests. Source-assert reduced motion and the text-table fallback.

## 6. Lanes

Each unit is one PR, about 45 minutes. A = work-execution / cli. B = web. C = api. Manifest is the orchestrator's Tier-0 commit, not a lane edit.

| # | Tier | Track | Unit | Depends | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | A | Pure `deriveConductorSchedule` + reservation series + session marks | — | vitest: order is runId; terminal omitted; parked kept; active/in-flight match admission; overlap; unreadable order flagged; cap omitted when unset; absent `schemaVersion` loads as 1; any other value is `unreadable` |
| 2 | 1 | A | `ListLaneRunsPort`, use case (`Pick` read of halt + lease), CLI `conductor schedule --json`. After A's T0 manifest commit; one slot in A's serial CLI list | 1 | In-memory repos; DTO has no host path, port, ssh alias, transport, or holder |
| 3 | 1 | C | `GET /v1/runs` (A-R-1). After T3a merges; batched in C's api queue | 2 | Envelope OK; 501 when runtime unset; bearer unchanged |
| 4 | 1 | B | W7a-1 `/conductor`: board, gauge, session strip, nav, not-configured, 30s refresh. No wait-reason chip | 3 | Source asserts: no fixture fallback, no AlertBox, route chip `GET /v1/runs`. Mapper + parity tests |
| 5 | 2 | A | Out-port + JSON ring; CLI `eachPass` of `run --live` only. D-VZ8 grants this before Q5b. `schemaVersion: 1` | 2 | Ring stays at 32; refused, dry-run, and `--once` dry-run write nothing; adapter never throws; `not-recorded` is one CLI line; pass still completes; no secrets or paths |
| 6 | 1 | C | `GET /v1/runs/passes`. After T3a; C's api queue | 5 | `limit` bounded; newest first; unknown `schemaVersion` → empty + `unreadable`, not 500 |
| 7 | 1 | B | Pass list + concurrency strip (reservations now; pass samples when present) | 4, 6 | Text-table fallback; reduced motion; wait reasons only from traces; pure scale tests |

Slices 1–4 ship a useful board from current files and write nothing. Slice 5 is the one state write (design review + pre-merge review). It may start under D-VZ8 without waiting for Q5b. Do not start 5 before lane 2's port exists.

## 7. Staging

`deploy/staging` is a manual script in this repo. It is not the deployment of record. `build-image.yml` publishes an image and does not deploy. The platform-repo manifests are the workload.

1. Merge to main. `build-image.yml` pushes `ghcr.io/martinkrakowski/fleet-v2:sha-<12>` (amd64, signed) and records `ghcr.io/martinkrakowski/fleet-v2@sha256:…` in the job summary.
2. Open a PR in `martinkrakowski/platform` at `apps/staging/fleet-v2` pinning that digest.
3. **Owner must do** (never in git, never in chat). The orchestrator names the keys; the owner creates the values.
   - **(a) Web container.** `FLEET_API_URL=http://127.0.0.1:3001` (API is not on the ingress; both containers share the pod network). `FLEET_API_TOKEN_FILE` from a mode-0600 Secret mount.
   - **(b) API container.** `FLEET_STATE_DIR`, `FLEET_API_TOKEN_FILE` (same token, mode 0600), and `HOST=127.0.0.1` (preferred) or `FLEET_API_ALLOW_REMOTE=1`. With `HOST=0.0.0.0` and no allow-remote the process refuses to start. Mount a valid installation file (host `maxLanes` lives there).
   - **(c) State the conductor actually writes.** Least risk, now: a one-way, read-only, periodic sync of only `lane-runs.json`, `run-journal.json`, `attempts.json`, `work-orders.json`, `reservations.json`, and `conductor-passes.json` from the Mac (where `conductor run --live` runs today) onto a PVC the API mounts as `FLEET_STATE_DIR`. Authenticated path. Never secrets, the token, or the installation file. The API only reads. A later option, not this lane, is to run the conductor's state on the cluster. Until (c) exists the page is correctly empty or not-configured.
   - **Secrets the owner creates:** the API bearer (one value, two mounts: web reader and API), and the sync credential (Mac → cluster, write only those six files). Nothing else.

**Acceptance.** First deploy, before (a)–(c): `/conductor` shows the not-configured banner and no sample rows. Second verification, after (a)–(c) and one completed live pass: creation-order rows, held slots, package keys, "cap not recorded" until a trace exists, then a pass row with wait reasons. Halted conductor: halted banner, rows still listed.

## 8. Owner decisions

- **D-VZ1 — Wait reasons.** Pass-trace ring, not journal entries. No inferred wait chip on the board (state, pending step, park, and the neutral waiting line only). **Accepted** (rev 1).
- **D-VZ2 — Cap on the gauge.** Store `maxActiveRuns`, `passConcurrency`, and `dispatchStaggerMs` on the trace only. Do not read profile `maxConcurrentLanes`. **Recommend accept.**
- **D-VZ3 — Wire DTO.** Drop holder, ssh alias, port, transport, and worktree path. Keep host-name aliases. Lease holder stays off this wire even though a later A-R card may show it. **Recommend accept.**
- **D-VZ4 — Feed.** 30s poll. A `lane-run` feed kind waits until the stores emit signals. **Recommend accept for v1.**
- **D-VZ5 — Where SVG lives.** Page-local until a second consumer exists. **Recommend accept.**
- **D-VZ6 — Trace-write failure.** The pass still completes. The adapter returns `not-recorded`; the CLI prints one line. **Recommend accept.**
- **D-VZ7 — Re-home.** Slices 1–3 are A-R-1 (`GET /v1/runs` + admission block). Slice 4 is W7a-1 (`/conductor` as W7a's nav entry). Passes stay `GET /v1/runs/passes`. Amend `remaining-work-plan.md` §7 so A-R and W7a are not dispatched twice. **Recommend accept.**
- **D-VZ8 — D-R8 exception. Decided (owner, 2026-10-31).** The pass-trace ring may land before Q5b. Field name is `schemaVersion`; absent means 1; unknown is refused. The record adopts Q5a's convention unchanged when Q5a lands. Name this exception in `remaining-work-plan.md` next to D-R8.
- **D-VZ9 — Where the trace is written.** CLI `eachPass` of `conductor run --live` only. The use case is untouched. Dry-run writes nothing. **Recommend accept.**

**Hard to undo.** The trace file's schemaVersion-1 shape. Adding fields is easy; renaming `runs[].report` is not, because old files must still load. Journal shape is untouched.

**Assumptions.** The API process can read the synced state dir. One conductor writer on the Mac. Host names are aliases safe to show. Web on `127.0.0.1:3001` reaches the API in the same pod. If the token or `FLEET_API_URL` is missing, not-configured is correct. If the sync lags, the board is stale and still read-only.

## 9. Review record

Fable review of rev 0. Each finding and how rev 1 applies it.

- **B1.** Slice 5 no longer waits on an unresolved D-R8 clash. D-VZ8 records the owner exception: ring before Q5b, `schemaVersion: 1` (absent = 1, unknown refused), Q5a's convention adopted unchanged when Q5a lands. Slices 1–4 still write nothing.
- **B2.** §7 no longer treats merge + digest pin as enough for live rows. Owner actions (a)(b)(c) are in scope. First-deploy acceptance is the not-configured banner and no sample rows. Live rows are a second check after the state sync.
- **M1.** Schedule is `GET /v1/runs` (A-R-1). Page is W7a-1 at `/conductor`. Passes are `GET /v1/runs/passes`. §7 of the remaining-work plan must record the amendment. Copy says "admission wait". No second runs read model.
- **M2.** No new fields on `RunConductorPassRequest`. The CLI passes the three limits into the trace adapter at construction. `maxActiveRuns` stays the admission cap.
- **M3.** Append moved to `eachPass` of `conductor run --live`. Use case unchanged. Dry-run and `--once` dry-run write nothing. Adapter never throws and returns `{recorded|not-recorded, reason}`.
- **M4.** Inferred wait chip removed. Placement is `running | waiting | parked | halted` from state, pending intent, and park. Neutral waiting line until a trace exists. §8 challenge dropped; D-VZ1 amended.
- **M5.** Ordering sentence corrected: creation order for the queue; per run, lease → resume → steps; admission hook inside the step; session-start gate only at dispatch/review intents.
- **M6.** (a) Lanes 3 and 6 wait until T3a merges and sit in C's api queue. (b) Lane 2 takes a turn in A's serial CLI list. (c) Manifest is A's Tier-0 commit before lane 2; the brief forbids `.architecture/`; the lane runs `yarn sync`. (d) API composes `Pick<…,'read'>` of halt and driver-lease; inspect wiring in the API is new.
- **m1.** §2(b) says the pass result is printed to stdout and is not durable.
- **m2.** §7 calls `deploy/staging` a manual script and not the deployment of record.
- **m3.** D-VZ3 notes that omitting `holderId` diverges from the later A-R run card on purpose.
- **m4.** §3 states step `detail` is a fixed token or reason code, and names the reservation fields dropped. `hostName` and `slotIndex` stay.
- **m5.** Cap numerator matches the admission rule. Per-host `maxLanes` stays "not in the JSON files".
- **m6.** §2(c) notes a journal-derived live-run series is possible later and leaves it out of v1.
- **m7.** §5 adds the parity test, a pure SVG-scale module, and source asserts for reduced motion and the text-table fallback. No DOM runner.
