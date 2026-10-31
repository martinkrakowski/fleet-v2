# Plan: continuous replanning — fleet-v2 re-organises the remaining work on a cadence

- **Date:** 2026-10-31
- **Target repository:** `fleet-v2`. The orchestrator's own scripts (lane log / S7 scorecard, merge-train driver) stay outside and are named only where this plan reads them.
- **Status:** rev 1, after a non-Fable (Opus) review of rev 0: four majors and six minors, all applied (§9). Nothing built. The plan is now a **first slice** (Phase 1, six PRs, one manifest commit, store-free) plus deferred phases that are re-decided once conducted Tier 2 runs have produced journal data. Decisions D-CR1–D-CR9 (§6) are split into "needed now" and "at Phase 2". Anchors checked against `main` at `a05c2e34`; the remaining-work plan is merged (#532) and its Revision 2 (parallel tracks A/B/C, #542) is read from `origin/docs/remaining-plan-rev2-tracks-2026-10-31`.
- **Owner request (2026-10-31):** "The way that you just re-organized the work, we should have that occur regularly as part of fleet-v2."
- **What happened by hand today:** the orchestrator noticed `2026-10-31_remaining-work-plan.md` (184 PRs, ~98–101 h) was bound by serial bottlenecks, not by work: one orchestrator driving every Tier 2 lane (~75 min, ~3 in flight), a serial train (~10 min/PR), Waves 6–7 (98 PRs) queued behind waves they barely depend on, Tier 2 ceremony on display-only units, and predictable fix rounds (dependent-package tests missing from briefs, harness gaps, lint). It proposed levers, the owner chose, and a Fable plan revision became §7 of that plan: three tracks, start-now lists, a re-tier table and an honest Fable floor.
- **Builds on:** `2026-10-31_remaining-work-plan.md` (§2 waves, §7 tracks, D-R1–D-R17), `2026-10-30_tier2-speed-plan.md` (S1 checklist, S7 scorecard), `2026-10-27_work-board-plan.md` (§3.2 sidecar; WB1a–c built; WB4a, WB4c, WB7a planned; D2, D12), `2026-10-27_conductor-plan.md` (lane runs, keyed journal, driver passes), `2026-10-27_lane-run-telemetry-plan.md` (§3.3 consumer-side read ports and read-only stores, §3.2 what never leaves), `2026-10-28_owner-todo-section-plan.md`, `AGENTS.md`.

**Short answer.** Replanning is **a read model plus a typed, advisory proposal**, never a scheduler. Phase 1 reads the plan sidecar (the work-board plan's `<plan>.workbook.json`, whose validation and cycle check are already on `main`), the S7 scorecard rows for hand-run lanes, and review findings classified into cause codes, and prints a **`ReplanProposal`** to stdout: critical path and wall per plan and per track, utilisation, start-now lanes, re-tier candidates, fix-round causes, a Fable forecast, and levers each with an expected saving, a quality cost, the rule it would change and whether it needs the owner. It is deterministic (no model in the loop), runs as `fleet-v2 plan replan --dry-run --sidecar <file> [--scorecard <jsonl>] [--json]` on the orchestrator's machine, and **applies nothing**. Phase 2, decided only after conducted Tier 2 runs exist, adds the stored proposal, journal-derived queue waits, owner routing through keyed questions, `policy.replan` thresholds, the driver cadence and the API/web/TUI reads. Tiers, seats, review rules and owner rules never move without a recorded owner decision; accepted levers become plan revisions (a docs PR bumping the sidecar revision) or brief-template changes made by the orchestrator.

## 1. Goal

After every wave or sequence, every morning, and whenever the measured pipeline drifts, the owner and orchestrator see the analysis the orchestrator produced by hand on 2026-10-31, computed from records, with a short list of levers to accept or decline.

**Non-goals.** No dispatch, re-tiering, seat change, review-rule change or brief edit by fleet-v2. No model inference in v1 (the narrative plan revision stays a Fable task run on the proposal). No markdown parsing as a source (work-board D2). No host names, finding texts, private paths or secrets in a proposal. Workers never run it (§3.6).

## 2. What exists (checked on `main`, a05c2e34)

| Need | What exists | Anchor | Gap |
|---|---|---|---|
| Unit/dependency graph | `LanePlanRecord` v1 with `PlannedLaneRecord { laneId, aliases, scope, packages, sharedFiles, tier 0-2, after[], decisions[], status, brief, mergedPr }`, `exclusiveOrder`, plan `decisions`; sidecar validation (WB1a), aggregate (WB1b), cycle check `findLanePlanCycle` (WB1c) | `packages/work-execution/src/domain/lane-plan-records.ts:104-133`, `entities/LanePlan.ts`, `lane-plan-graph.ts:66` | No store (WB4a, Track A stream ii) or `plan` CLI group (WB7a); no sidecar written for the remaining-work plan; no estimate, run mode or wave per lane |
| Lane runs and steps | `LaneRunRecord` (tier, round, attemptIds, prNumber, parked, lease); keyed journal: intent/result per step key, conduct entries for an entered state | `.../domain/lane-run-records.ts`; manifest `LaneRunJournalPort` | Conducted runs only. **Admission waits are not journalled:** `performAdmissionWait` returns `waiting/admission` and appends nothing (`advance-lane-run/facts.ts:320-340`); a conduct entry carries only a `LaneRunState` |
| Admission | `LaneRunAdmissionPort` → `admitted` / `no-capacity` / `refused` | `.../ports/out/LaneRunAdmissionPort.out-port.ts:22-25` | Outcomes, not durations |
| Fix-round evidence | `ReviewReceiptRecord { reviewerModel, implementerModel, kind?, findings[] }`; `ReviewFindingRecord { severity, summary, filePath, state }`; verification receipts per predicate | `packages/evidence-and-acceptance/src/domain/evidence-records.ts:40-72` | `summary` is free, untrusted text; no cause taxonomy; `AcceptanceReceiptReadPort` projects counts only, by design |
| Seats, cost | `AttemptRecord.runner` (`:288`), `usage` with `costUsd` (`:296`), `seatSelection` (`:305`) | `.../domain/execution-records.ts:269-305` | No Fable quota figure anywhere |
| Owner surfaces | `AskOwnerQuestionPort`, `FindOwnerQuestionByKeyPort`, `RecordAttentionItemPort`; `LaneRunParkNoticeAdapter` is the consumer-side pattern | manifest, operator-coordination | Plan-decision owner items need WB4c |
| Hand-run measurements | S7 scorecard rows in the orchestrator's lane log | tier2-speed plan §3 S7 | Outside fleet-v2; no typed read, no fixed format |
| Context mapping | evidence-and-acceptance → work-execution (OHS, in-process) exists | `.architecture/manifest.yaml:865` | Notes need the new consumer |
| Worker isolation | Workers receive only `RUNNER_ENV_ALLOWLIST` / `AGY_RUNNER_ENV_ALLOWLIST` variables; `FLEET_STATE_DIR` is not among them | `ExecutionRunnerAdapter.adapter.ts:204`, `AgyRunnerAdapter.adapter.ts:104` | — |

## 3. The shape

### 3.1 Inputs

| Input | Phase 1 | Phase 2 |
|---|---|---|
| Lane plans | `--sidecar <file>` (one or more v1 sidecars, validated by WB1a, cycle-checked by WB1c) | `LanePlanRepositoryPort` when WB4a lands on A's stream (ii); sidecar v2 optional fields (`estimateMinutes`, `runAs`, `wave`, `replanRef`) only if tier defaults prove too coarse (D-CR2) |
| Estimates | Defaults by tier and the §7.5 figures: T0 10 min, T1 conducted 9, T1 hand-run 35, T2 75; the sidecar's `packages`/`sharedFiles` give the serialisation | Measured per-lane medians from the scorecard and runs |
| Hand-run rows | `--scorecard <jsonl>`: `ScorecardRow { planRef, tier, track, fixRounds, escapedBy, waitMinutes { gate, review, train }, startedAtIso, mergedAtIso }`; a malformed line is skipped and counted | Same, through `LaneScorecardReadPort` over `<stateDir>/scorecard/*.jsonl` |
| Review and verification facts | `FindingCauseReadPort` (work-execution, consumer side) → `ClassifyFindingCausesPort` (evidence, in). Only `{ attemptId, headSha, kind, causeCodes[], severityCounts }` cross; never a summary | Same |
| Runs, journals, attempts, reservations | Not read (no conducted Tier 2 runs exist yet) | Read-only store instances (telemetry §3.3's `readOnly`) for queue waits (§3.2) |
| Owner state | Open plan `decisions` from the sidecar | `ListOwnerQuestionsPort`, `ListOwnerItemsPort` |
| Thresholds and quota | `--fable-weekly-passes <n>` flag, default none (forecast prints "no quota given") | `policy.replan` in `installation` (D-CR8) |

### 3.2 Analysis (pure, in `work-execution` domain)

- **Critical path.** Nodes: planned lanes not done/dropped/deferred. Edges: `after`, `exclusiveOrder`, one hand-run or conducted lane per package until KS5, shared-file serialisation. Weights: estimates. Longest path per plan and per track (§7.1's package ownership gives the track of a lane); wall = max(chain × t, count ÷ inFlight × t, PRs × trainInterval), the remaining-work plan's §2 formula, so figures reconcile with §2 and §7.5.
- **Utilisation and idle gaps.** Per track: busy minutes ÷ window from scorecard rows (Phase 1) and from runs (Phase 2); idle gap = time between a lane's merge and the next start on the same track or package.
- **Queue waits (Phase 2).** Gate wait = `collect` result → `gate` intent; review-seat wait = `gate` result → first review intent; train wait = `accept` result or `awaiting-premerge` conduct → `merged` conduct; owner wait = park → resume. **Admission wait is approximated** as `prepare` result → `dispatch` intent of the same attempt (both keyed and journalled); it over-counts by the pass interval and is labelled `approximate`. An exact figure needs a later lane, **CR3j**, that appends a keyed `wait/<reason>` entry (a journal contract change on Track A, after the Wave 2 admission chain); until then the proposal never prints an admission p50 without the label.
- **Fix-round causes.** Codes from `ClassifyFindingCausesPort` (rule table in evidence: `missing-dependent-tests`, `harness-gap`, `lint`, `design-key-mismatch`, `wrong-source-of-value`, `id-collision`, `scope-widening`, `other`), plus failed verification predicates and `StopReason`. Clustered over the trailing N lanes; a code above a share threshold yields a `brief-rule` lever naming the S1 checklist line to add.
- **Re-tier candidates.** Down: tier 2 lanes with `packages ⊆ {web, ui, docs}` and no `sharedFiles` (the §7.3 rule as far as a sidecar can see it; the brief's touch list stays the proof). Up: tier 1 lanes with ≥ 2 fix rounds or an escaped defect at CI or later. Candidates only; the owner decides (D-CR7).
- **Start-now.** Every `after` done, no open gating decision, not started, track or package free.
- **Fable forecast.** Sittings needed = remaining T2 × (S1 + pre-merge) × (1 + measured re-pass rate) + one per re-tiered sequence; consumed = review receipts in the trailing 7 days whose `reviewerModel` matches the configured family; weeks to finish at the given weekly passes.

### 3.3 Output: the `ReplanProposal`

The **domain emits canonical facts and levers; infrastructure adds identity.** `deriveReplanProposal(facts, now)` returns `ReplanProposalBody`; the CLI adapter computes `factsDigest` (sha256 of the canonical JSON, the `LanePlanRecord.digest` precedent) and injects `proposalId` and `producedAtIso`. Phase 1 prints the body plus digest and stores nothing; Phase 2's stored record is `{ version: 1, proposalId, producedAtIso, factsDigest, status, decisionRefs, ...body }`, introduced only after Q5b (D-R8).

```ts
interface ReplanProposalBody {
  readonly projectId: string; readonly planIds: readonly string[];
  readonly trigger: 'manual' | 'wave-boundary' | 'daily' | 'signal';   // Phase 1 always manual
  readonly signals: readonly { kind: string; value: number; threshold: number }[];
  readonly baseline: { remainingLanes: number; byTier: Record<'0'|'1'|'2', number>; byTrack: Record<string, number>;
    criticalPathMinutes: number; wallMinutes: number; trainWaitP50: number | null; admissionWaitP50: { minutes: number; approximate: true } | null;
    fixRoundRate: number | null; fableSittingsNeeded: number; fableWeeksAtQuota: number | null };
  readonly sources: readonly { name: string; status: 'read' | 'not-read' | 'skipped-lines'; count: number }[];
  readonly levers: readonly ReplanLever[];
}
interface ReplanLever {
  readonly leverId: string;                          // deterministic: kind + sorted subjects
  readonly kind: 'start-now' | 'parallel-track' | 're-tier' | 'review-batching' | 'brief-rule'
               | 'pull-forward' | 'batch-tier1' | 'resequence' | 'defer';
  readonly subjects: readonly PlannedLaneRef[];
  readonly expectedSavingMinutes: number;            // 0 when unknown
  readonly qualityCost: 'none' | 'review-coverage' | 'test-coverage' | 'ci-minutes' | 'owner-attention';
  readonly ruleChanged: { scope: 'schedule' | 'tier' | 'review' | 'brief-template' | 'batching' | 'seat' | 'owner-rule';
    from: string; to: string } | null;                // ≤ 200 code points, `planTextError` + shared secret patterns
  readonly needsOwner: boolean;                      // true by construction for tier, review, seat, owner-rule
  readonly reasonCodes: readonly string[];           // codes only, never a finding summary
}
```

A body that would carry a refused string is not produced; the command exits 1 with `refused`.

### 3.4 Cadence and triggers

| Phase | When | How |
|---|---|---|
| 1 | At each sequence-end Fable pass (F-TODO, F-BOARD-1, …) and each wave boundary of §7; before the morning digest | The orchestrator runs `plan replan --dry-run` by hand and pastes the lever table into the plan revision |
| 2 | Wave boundary (driver sees `wave n` terminal, `wave n+1` unstarted); daily (`--digest` from the owner's scheduler, as `todo --digest`); signals checked each driver pass: train p50 > 20 min, T2 idle gap > 60 min, fix-round rate > 1.0 over 10 lanes, estimate slip > 30 % (D-CR4) | One open proposal per plan; superseded when `factsDigest` changes; debounced to `policy.replan.minIntervalMinutes` (default 180); attention item `replan-suggested` |

Exit codes: 0 produced (also with zero levers), 1 refused (fewer than `minSourcesRead` inputs read, or refused text), 2 usage.

### 3.5 Place in the hexagon

Owned by **`work-execution`** (it owns lane plans, runs, journals and the board read model); evidence owns finding classification; coordination owns the owner surfaces. Dependency direction unchanged.

- **Domain (work-execution):** `replan-records.ts` (body, lever, validators), `replan-graph.ts` (critical path, tracks, start-now, utilisation; reuses `lane-plan-graph.ts`), `replan-waits.ts` (Phase 2), `deriveReplanProposal`: pure, never throws, no clock, **no crypto**.
- **Domain (evidence-and-acceptance):** `finding-causes.ts`: the rule table and `classifyFindingCauses(findings) → codes`.
- **Application:** in-ports `ProposeReplanPort` (work-execution), `ClassifyFindingCausesPort` (evidence); out-ports `LaneScorecardReadPort`, `FindingCauseReadPort`; Phase 2 adds `ReplanProposalRepositoryPort`, `ReplanOwnerRoutingPort` (delegates to `AskOwnerQuestionPort`, `FindOwnerQuestionByKeyPort`, `RecordAttentionItemPort`), `ReplanSettingsPort`, `InspectReplanProposalPort`, `ListReplanProposalsPort`.
- **Infrastructure:** `LaneScorecardFileAdapter` (JSONL), `FindingCauseReadAdapter` (in-process → evidence), `Sha256CanonicalDigest` for the facts digest; Phase 2 adds the proposal file/memory stores, owner routing and settings adapters.
- **Manifest (CRM, one T0 commit on Track A):** the Phase 1 ports, use cases, adapters and bindings; **extend the notes of row 865** (evidence → work-execution) with `FindingCauseReadAdapter delegates to ClassifyFindingCausesPort`; no new mapping row.
- **Composition roots:** Phase 1 touches `apps/cli/src/{index,composition}.ts` **once** (CR8-lite). Phase 2: `GET /v1/replan[/:id]` (Track C, bearer today, `read` scope after T3a), `/replan` read-only view (Track B), a TUI screen in the P9 shell (Track B). No console logging in packages; CLI I/O at the boundary.

### 3.6 Authority and safety

- A proposal grants and changes nothing. Phase 2's `status` moves to `decided` only through a recorded owner answer or a plan revision whose sidecar `replanRef` names it.
- Levers of scope `tier`, `review`, `seat`, `owner-rule` are `needsOwner: true` by construction; `schedule`/`batching` levers are the orchestrator's to adopt within existing rules, still only through a plan revision.
- No model produces a proposal, so no model re-tiers its own work. The Fable pass that narrates an accepted proposal is read-only and its output is a docs PR reviewed like any other; a re-tier of a lane whose implementer family matches the narrating model is named in the PR body.
- **Workers never apply plans.** `FLEET_STATE_DIR` is not in either runner env allow-list, so a worker that ran the CLI would see only in-memory stores and no sidecar; there is no runner route; a proposal is never injected into a brief (candidate-notes rule). The driver (Phase 2) computes and records; it dispatches nothing from a proposal.
- Public-repo rule: proposals and plan revisions committed to fleet-v2 carry lane ids, counts, minutes, cause codes and reason codes only; never hosts, finding summaries, private paths, per-seat cost or security findings.

## 4. Workbook

Each lane about 45 minutes, one PR; a Tier 2 lane costs about 75 min hand-run plus an S1 and a pre-merge Fable sitting. Shared files in bold. **Every Phase 1 lane runs on Track A** (§7.1: work-execution, the `@generated` barrels, the manifest, `index.ts`/`composition.ts` are A's); the new evidence domain file is a new file plus A's barrel. Phase 1 adds about 5 h of hand-run time and 8 Fable sittings to A's stream (iii), beside Q7b/SR/OT5; it is not free, and it enters no existing chain only because its files are new. It does not touch `advance-lane-run/*` or `conductor.ts`.

### Phase 1: the first slice (6 PRs)

| Lane | Scope | Package / shared files | Tier | After | Acceptance |
|---|---|---|---|---|---|
| CR0 | This plan; `2026-10-31_remaining-work-plan.workbook.json` (sidecar v1, every §1 unit with disposition, §7.1 track as a `packages` reading) | docs | 0 | — | Fixture passes WB1a validation and WB1c cycle check in a unit test; lane count matches §2 totals |
| CR2 | `replan-graph.ts`: weighted critical path with tier defaults, package/shared-file serialisation, tracks, start-now, utilisation | work-execution (domain), **barrel** | 2 | CR0 | The CR0 fixture reproduces §2 wave walls and §7.5 track walls within 15 %; a cycle is a typed error; a `dropped` predecessor yields `after-dropped`, never a release |
| CR4 | `finding-causes.ts` rule table; `ClassifyFindingCausesPort`/UseCase (codes and severity counts only) | evidence-and-acceptance (domain, app), **barrel** | 2 | — | Golden fixtures per code; a summary with a secret-shaped string classifies without echoing it; a port consumer test asserts no `summary` field crosses |
| CR5 | `replan-records.ts` + `deriveReplanProposal`: levers, quality costs, `needsOwner` rule, re-tier candidates, Fable forecast, canonical facts; no digest, no clock | work-execution (domain), **barrel** | 2 | CR2, CR4 | Property test: same facts → same canonical JSON; every tier/review/seat lever `needsOwner`; refused text → no body |
| CRM | Manifest: ports, use cases, adapters, bindings, row 865 notes; `yarn sync` | **manifest**, **barrels** | 0 | CR4, CR5 | `yarn lint:arch`, `yarn sync:check` |
| CR8-lite | `ProposeReplanUseCase`, `LaneScorecardFileAdapter`, `FindingCauseReadAdapter`, the digest adapter; `fleet-v2 plan replan --dry-run --sidecar <file>... [--scorecard <jsonl>] [--fable-weekly-passes n] [--json]`; exit codes; read-only evidence repositories | work-execution (app, infra); apps/cli **`index.ts`, `composition.ts`** (once) | 2 | CRM | CLI tests per exit code; `--json` round-trips the body; composes no forge adapter and no writable store; a throwing scorecard read → `not-read` and still a body |

Totals Phase 1: 4 T2 + 2 T0 PRs; about 5 h hand-run at one in flight on A, plus 8 Fable sittings.

### Phase 2 (deferred; re-decided after ten conducted Tier 2 runs, D-CR1)

| Lane | Scope | Track / shared files | Tier | After |
|---|---|---|---|---|
| CR1 | Sidecar v2 optional fields; v1 still imports | A, work-execution domain, **barrel** | 2 | D-CR2 decided yes |
| CR3 | `replan-waits.ts` from run/journal facts, admission labelled approximate | A | 2 | ten conducted T2 runs |
| CR3j | Keyed `wait/<reason>` journal entry; `performAdmissionWait` appends it | A, `advance-lane-run/*`, journal contract | 2 | Wave 2 admission chain (KS5, KS6) |
| CR6b | `ReplanProposalRepositoryPort` + stores (record v1), supersede rule, `replanRef` linking on import | A, **manifest** | 2 | Q5b (D-R8), WB4a on stream (ii) |
| CR7 | `policy.replan` keys | C, installation | 1 | D-CR4, D-CR8 |
| CR9 | `ReplanOwnerRoutingPort`/adapter: keyed questions, `replan-suggested` attention item | A (new files) + **manifest** | 2 | CR6b |
| CR10 | Driver cadence: wave boundary, signals, debounce; journalled; skipped while halted | A, `conductor.ts` | 2 | CR9, Wave 3 K11b', **Wave 5 O9** |
| CR11 | `GET /v1/replan`, `/v1/replan/:id`; `replan` feed kind | C, api wiring queue | 1 (read route, F-READS) | CR6b; after T3a's queue position |
| CR12 | `/replan` read-only view | B, `view-nav.tsx` | 1 (display-only, F-READS) | CR11 (fixture-first per §7.2) |
| CR13 | TUI Replan screen | B, `tui/**` | 1 (F-TUI) | P9, CR8-lite |
| CR-R | Runbook `docs/runbooks/replan.md`; S7 JSONL format in the speed plan §3 | docs | 0 | CR8-lite |

WB4a and WB7a are **not** pulled forward: WB4a needs WB2b and WB3b, WB7a needs WB4c and WB3b (work-board plan lines 292, 301), and they already sit on A's stream (ii). Phase 2 reads the store when stream (ii) delivers it.

## 5. Hard to undo

- **The S7 scorecard JSONL format** (D-CR5): once the orchestrator writes rows, a field rename needs a reader for the old shape. Version the first line (`{"schemaVersion":1}`).
- **The cause-code taxonomy:** codes appear in proposals and in committed plan revisions; renaming one needs an alias table. Keep it small and additive.
- **Phase 2 only:** the `ReplanProposal` record v1 (absent is 1, unknown refused, D-R8); sidecar v2 as a file format in several repositories (work-board §5); `policy.replan` keys (absent block means manual only).
- **A proposal is public text once in a plan revision.** §3.6 is the rule; the record validators are the mechanism.
- Phase 1 itself is two-way: a dry-run command over files, removable with its ports.

## 6. Decisions for the owner

**Needed now (Phase 1):**

| # | Question | Recommended |
|---|---|---|
| D-CR1 | Build the first slice now on Track A's stream (iii), one lane in flight, and re-decide Phase 2 (including whether WB4a's position in stream (ii) should change) after ten conducted Tier 2 runs? | **Yes.** Phase 1 is store-free and needs no Q5b; Phase 2 is re-decided against Wave 6 with data |
| D-CR3 | Where does Phase 1 run? | **Track A**, because every file it touches (barrels, manifest, `index.ts`/`composition.ts`) is A-owned; a second session gains nothing here |
| D-CR5 | S7 scorecard as versioned JSONL in `<stateDir>/scorecard/`, read by `--scorecard`; never committed | **Yes** |
| D-CR6 | Fix-round causes by a rule table inside evidence, codes only crossing; no model classifier | **Yes**; a model classifier is a later, owner-decided lever |
| D-CR7 | Re-tier levers are always owner decisions; down-tier candidacy = `packages ⊆ {web, ui, docs}`, no shared files, the touch list the proof | **Yes**; fleet-v2 never writes a tier |
| D-CR9 | Phase 1 cadence: the orchestrator runs `plan replan --dry-run` at each sequence-end Fable pass and wave boundary and pastes the lever table into the plan revision | **Yes** |

**At Phase 2 (after ten conducted Tier 2 runs):**

| # | Question | Default to re-decide |
|---|---|---|
| D-CR2 | Sidecar v2 optional fields (`estimateMinutes`, `runAs`, `wave`, `replanRef`) | Only if tier defaults miss measured medians by > 30 % |
| D-CR4 | Driver cadence and thresholds (train p50 > 20 min, T2 idle gap > 60 min, fix-round rate > 1.0, slip > 30 %; 180 min debounce) | Yes, tuned to the first ten proposals |
| D-CR8 | Fable quota: owner-entered `fableWeeklyPasses` in `policy.replan`; consumption measured from receipts by model family | Yes (Phase 1 uses the flag) |
| D-CR10 | Owner surface: keyed owner questions + attention item (CR9), plan-decision owner items when WB4c lands | Yes |

## 7. Assumptions

- WB1a–c are on `main` (verified); their validation accepts a sidecar for a plan whose lanes span several packages and tracks.
- Hand-run Tier 2 lanes leave attempts but no `LaneRun`; in Phase 1 every wait figure comes from scorecard rows the orchestrator keeps current, and there are none yet for conducted Tier 2 runs.
- Admission waits are not journalled today (verified); Phase 2's approximation and CR3j are the two ways to measure them.
- `reviewerModel` identifies the Fable family by prefix; a renamed model id needs the configured family updated.
- `MergeRecord` (WB5a) is not built; Phase 1 reads "done" from the sidecar's `mergedPr` and `status`; Phase 2 adds runs, `PullRequestLink` and the merge record.
- Tier defaults (T0 10, T1 conducted 9, T1 hand-run 35, T2 75 min) are the §7.5 figures; the first proposals are coarse by design.
- `hexagen arch validate` accepts the extended row 865 as it does `AcceptanceReceiptReadAdapter`.
- Track A has room for one more hand-run lane in stream (iii) without delaying KS1 → KS7 or Q5a/Q5b; if not, Phase 1 waits behind Q5b.

## 8. Challenge this

Whether a deterministic analyser earns its keep against the orchestrator's judgement: today's re-organisation came from reading plans, and a record-driven proposal can only name levers it has rules for. Phase 1 is sized so the answer is cheap: six PRs, one of them docs, and the test is whether its first dry-run on the CR0 sidecar reproduces §7's start-now list and re-tier table. If it does not, stop at Phase 1. Whether the sidecar is hand work the plan meant to remove: CR0 is one file for 184 units, and `plan check` (WB7a) will warn on drift later. Whether Phase 1's eight Fable sittings on Track A are worth more than eight sittings on Wave 6 views, given §7.5's Fable floor. Whether "parallel tracks" is fleet-v2's concern at all, since sessions live outside it; the proposal can only recommend one. And whether signals invite Goodharting (batching to lower PR counts, wider Tier 1 to lower fix-round rates): the escaped-defect guardrail of the speed plan §4 sits beside every saving figure, and Phase 2's thresholds are decided only on data.

## 9. Review record

2026-10-31, non-Fable (Opus) review of rev 0: four majors, six minors, all applied.
- **1d (major), admission waits assumed journalled:** §2 and §3.2 now state `performAdmissionWait` appends nothing; Phase 2 approximates `prepare` result → `dispatch` intent, labelled, and CR3j is the named lane for exact figures.
- **1b/1c (minor), anchors:** `AttemptRecord` at `execution-records.ts:269-305` (runner 288, usage 296, seatSelection 305); `LaneRunAdmissionResult` has `refused` (§2).
- **2a (minor), mapping row:** CRM extends row 865's notes; no new `context_mappings` row (§3.5).
- **2b (major), crypto in the domain:** the domain emits canonical facts; `factsDigest`, `proposalId` and `producedAtIso` come from infrastructure (§3.3, §3.5).
- **2d (minor), worker guard:** the allow-lists filter env vars; the real guard is that `FLEET_STATE_DIR` never reaches a worker, so its CLI sees in-memory stores (§3.6).
- **3b (minor):** CR10 also orders after Wave 5's O9 (§4).
- **3c/3d (major), packages not idle, shared files:** "without entering their chains" dropped; every lane placed on its owning track per §7.1; barrel, manifest and `index.ts`/`composition.ts` lanes marked; Phase 1 touches cli shared files once (§4).
- **3e (major), WB4a' prerequisites:** the pull-forward is withdrawn; WB4a and WB7a stay on A's stream (ii) with their prerequisites; Phase 2 reads the store when it lands (§4).
- **3f (minor), counts:** rev 0 had 13 T2 lanes (~16–17 h), not 11; rev 1 counts Phase 1 (4 T2, ~5 h) and Phase 2 separately (§4).
- **4a (major), first slice:** restructured into Phase 1 (CR0, CR2, CR4, CR5, CRM, CR8-lite) and deferred Phase 2; decisions split into now vs Phase 2; §5, §7, §8 rewritten accordingly.
