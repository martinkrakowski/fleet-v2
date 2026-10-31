# Plan: continuous replanning — fleet-v2 re-organises the remaining work on a cadence

- **Date:** 2026-10-31
- **Target repository:** `fleet-v2`. The orchestrator's own scripts (lane log / S7 scorecard, merge-train driver) stay outside and are named only where this plan reads them.
- **Status:** rev 0. Nothing built. Decisions D-CR1–D-CR9 (§6) are open with recommended defaults. Anchors checked against `main` at `a05c2e34`; the remaining-work plan read from `origin/docs/remaining-work-plan-2026-10-31`.
- **Owner request (2026-10-31):** "The way that you just re-organized the work, we should have that occur regularly as part of fleet-v2."
- **What happened by hand today:** the orchestrator noticed `2026-10-31_remaining-work-plan.md` (184 PRs, ~98–101 h) was bound by serial bottlenecks, not by work: one orchestrator driving every Tier 2 lane (~75 min each, ~3 in flight), a serial train (~10 min/PR), Waves 6–7 (98 PRs) queued behind waves they barely depend on, Tier 2 ceremony on display-only units, and predictable fix rounds (dependent-package tests missing from briefs, harness gaps, lint). It proposed levers, the owner chose, and a Fable plan revision turned the choice into tracks.
- **Builds on:** `2026-10-31_remaining-work-plan.md` (waves, D-R1–D-R17), `2026-10-30_tier2-speed-plan.md` (S1 checklist, S7 scorecard), `2026-10-27_work-board-plan.md` (§3.2 sidecar, WB1a–c built, WB4a/WB4c/WB7a planned, D2, D12), `2026-10-27_conductor-plan.md` (lane runs, keyed journal, driver passes), `2026-10-27_lane-run-telemetry-plan.md` (§3.3 consumer-side read ports, §3.2 what never leaves), `2026-10-28_owner-todo-section-plan.md`, `AGENTS.md`.

**Short answer.** Replanning is **a read model plus a typed, advisory proposal**, not a scheduler. Every pass reads what fleet-v2 already records (lane plans, lane runs and their keyed journals, attempts, receipts, reservations, owner questions and items) plus one new input, the S7 scorecard for hand-run lanes, and derives: the critical path and wall estimate per plan, per-track utilisation and idle gaps, queue waits (admission, gate, review seat, train), fix-round causes as codes, start-now lanes, re-tier candidates and a Fable quota forecast. It writes one **`ReplanProposal`** record: levers with expected saving, quality cost, the rule each changes and whether it needs the owner. It is produced deterministically from records (no model in the loop), surfaced as `fleet-v2 plan replan`, `GET /v1/replan` and a read-only `/replan` view, and runs at wave boundaries, daily and on signals. **It applies nothing.** Owner-needed levers become keyed owner questions (later plan-decision owner items); an accepted lever becomes a plan revision (a docs PR bumping the sidecar revision, which the next `plan import` links back to the proposal) or a brief-template change made by the orchestrator. Tiers, seats, review rules and owner rules never move without a recorded owner decision.

## 1. Goal

After every wave, every morning, and whenever the measured pipeline drifts, the owner and orchestrator see the same analysis the orchestrator produced by hand on 2026-10-31, computed from records, with a short list of levers to accept or decline.

**Non-goals.** No dispatch, re-tiering, seat change, review-rule change or brief edit by fleet-v2. No model inference in v1 (the narrative plan revision stays a Fable task the orchestrator runs on the proposal). No markdown parsing as a source (work-board D2). No host names, finding texts, file paths of private repositories or secrets in a proposal. Workers never see or run it: it is a CLI/driver read on the orchestrator's machine, not in any runner environment or lane.

## 2. What exists (checked on `main`, a05c2e34)

| Need | What exists | Anchor | Gap |
|---|---|---|---|
| Unit/dependency graph | `LanePlanRecord` v1 with `PlannedLaneRecord { laneId, aliases, scope, packages, sharedFiles, tier 0-2, after[], decisions[], status planned/deferred/dropped, brief, mergedPr }`, `exclusiveOrder`, plan `decisions` open/decided; sidecar validation (WB1a), aggregate (WB1b), cycle check `findLanePlanCycle` (WB1c) | `packages/work-execution/src/domain/lane-plan-records.ts:104-133`, `entities/LanePlan.ts`, `lane-plan-graph.ts:66` | No store or import (WB4a, W6), no `plan` CLI group (WB7a, W6; `apps/cli/src/index.ts` has `seats`, `conductor`, `telemetry`); no sidecar written for the remaining-work plan; no estimate, run mode or wave on a lane |
| Lane runs and steps | `LaneRunRecord` (tier, round, attemptIds, prNumber, parked, lease); keyed journal with intent/result/conduct entries; states incl. `gating`, `awaiting-premerge`, `watching-ci`, `merging`, `merged` | `packages/work-execution/src/domain/lane-run-records.ts`, manifest `LaneRunJournalPort` | Conducted runs only; hand-run Tier 2 lanes leave attempts but no run |
| Admission waits | `LaneRunAdmissionPort` (`admitted` / `no-capacity`), reservations in the execution journal | `.../ports/out/LaneRunAdmissionPort.out-port.ts` | Wait durations only derivable from journal conduct entries |
| Fix-round evidence | `ReviewReceiptRecord { reviewerModel, implementerModel, kind, findings[] }`, `ReviewFindingRecord { severity, summary, filePath, state }`; verification receipts per predicate | `packages/evidence-and-acceptance/src/domain/evidence-records.ts:40-72` | `summary` is free text and untrusted; no cause taxonomy; `AcceptanceReceiptReadPort` deliberately projects counts only |
| Seats, cost | `AttemptRecord.runner`, `seatSelection`, `usage` (tokens, `costUsd`) | `.../domain/execution-records.ts:191-210` | No Fable quota figure anywhere |
| Owner surfaces | `AskOwnerQuestionPort`, `FindOwnerQuestionByKeyPort`, `RecordAttentionItemPort`, `OwnerItem` kind `decision`; `LaneRunParkNoticeAdapter` shows the consumer-side pattern | manifest operator-coordination; `LaneRunParkNoticePort` binding | Plan-decision items need WB4c (W6) |
| Hand-run measurements | S7 scorecard rows in the orchestrator's lane log (fix rounds, escaped defects by stage, wait times) | tier2-speed plan §3 S7 | Outside fleet-v2; no typed read |
| Board read model | `deriveWorkBoard` pure, never throws; `waitsOn` planned (WB2b) | `.../domain/work-board.ts:150` | Columns, not time or capacity |

## 3. The shape

### 3.1 Inputs

| Input | Port (existing unless marked) | Notes |
|---|---|---|
| Lane plans | `LanePlanRepositoryPort` (**WB4a, pulled forward**, D-CR1); until then `--sidecar <file>` in `--dry-run` only | Sidecar **schemaVersion 2** (D-CR2) adds optional per-lane `estimateMinutes`, `runAs: conducted \| hand \| orchestrator \| owner \| external`, `wave`; v1 files still import; defaults by tier and runAs (`T1 conducted 15`, `T2 hand 75`, `T0 10`) |
| Runs, journals, attempts, reservations | `LaneRunRepositoryPort`, `LaneRunJournalPort`, `AttemptRepositoryPort`, `ExecutionJournalPort` (read only) | Read-only store instances (telemetry §3.3's `readOnly` option) |
| Merge facts | run `merged`, `PullRequestLink`, sidecar `mergedPr`; `MergeRecord` once WB5a lands | Train wait = `awaiting-premerge` or `accept` result → merged time |
| Review and verification facts | **new** `FindingCauseReadPort` (work-execution, consumer side) → **new** `ClassifyFindingCausesPort` (evidence, in) | Only `{ attemptId, headSha, kind, causeCodes[], severityCounts }` cross; never a summary |
| Hand-run rows | **new** `LaneScorecardReadPort` (file adapter over S7 JSONL in `<stateDir>/scorecard/`, D-CR9) | Typed `ScorecardRow { planRef, tier, fixRounds, escapedBy, waitMinutes{gate,review,train}, startedAtIso, mergedAtIso }`; a malformed line is skipped and counted |
| Owner state | `ListOwnerQuestionsPort`, `ListOwnerItemsPort`, plan `decisions` | An open decision gating a lane blocks its start-now |
| Thresholds and quota | **new** `policy.replan` in `installation` (D-CR4, D-CR8) | `fableWeeklyPasses`, `fableModelFamily`, trigger thresholds, cadence |

### 3.2 Analysis (pure, in `work-execution` domain)

- **Critical path.** Nodes: planned lanes not done/dropped/deferred. Edges: `after`, `exclusiveOrder`, same-package serialisation for hand-run T2 and conducted lanes (until KS5), shared-file serialisation. Weights: `estimateMinutes`. Longest path per plan and per package sequence; wall = max(chain × t, count ÷ inFlight × t, PRs × trainInterval), the same formula as the remaining-work plan §2 so figures reconcile.
- **Per-track utilisation.** A track is a package sequence (and, when the scorecard names it, an orchestrator session). Busy minutes ÷ window; **idle gaps** = time between a run's terminal entry and the next dispatch in that package.
- **Queue waits** (p50/p90 over the trailing N lanes): admission (`wait admission` conduct → dispatch intent), gate (collect result → gate intent), review seat (gate result → first review intent), train (accept/premerge → merged), owner (park `owner-merge`/`one-way-door` → resume). Hand-run waits from scorecard rows.
- **Fix-round causes.** Codes from `ClassifyFindingCausesPort` (rule table in evidence: `missing-dependent-tests`, `harness-gap`, `lint`, `design-key-mismatch`, `wrong-source-of-value`, `id-collision`, `scope-widening`, `other`), plus failed verification predicates and `StopReason`. Clustered per code over the trailing N lanes; a code above `policy.replan.causeShareThreshold` yields a `brief-rule` lever.
- **Re-tier candidates.** Down: tier 2 lanes with `packages ⊆ {web, ui, docs}`, no `sharedFiles`, no manifest. Up: tier 1 lanes with ≥ 2 fix rounds or an escaped defect at CI or later. Candidates only; the owner decides (D-CR7).
- **Start-now.** Every `after` done, no open gating decision, not started, package track free or admissible.
- **Quota forecast.** Fable passes needed = remaining T2 × (1 S1 + 1 pre-merge) × (1 + measured re-pass rate); consumed = review receipts in the trailing 7 days whose `reviewerModel` matches `fableModelFamily`; weeks to finish at `fableWeeklyPasses`.

### 3.3 Output: the `ReplanProposal` record (version 1, D-R8 convention)

```ts
interface ReplanProposalRecord {
  readonly version: 1; readonly proposalId: string; readonly projectId: string;
  readonly planIds: readonly string[]; readonly producedAtIso: string;
  readonly factsDigest: string;                      // sha256 of the canonical facts; same digest → no new proposal
  readonly trigger: 'wave-boundary' | 'daily' | 'signal' | 'manual';
  readonly signals: readonly { kind: ReplanSignalKind; value: number; threshold: number }[];
  readonly baseline: { remainingLanes: number; byTier: Record<'0'|'1'|'2', number>; criticalPathMinutes: number;
    wallMinutes: number; trainWaitP50: number; fixRoundRate: number; fablePassesNeeded: number; fableWeeksAtQuota: number };
  readonly sources: readonly { name: string; readAtIso: string; status: 'read' | 'not-read' }[];
  readonly levers: readonly ReplanLever[];
  readonly status: 'proposed' | 'superseded' | 'decided';
  readonly decisionRefs: readonly { leverId: string; questionId: string | null; planRevision: number | null }[];
}
interface ReplanLever {
  readonly leverId: string;
  readonly kind: 'start-now' | 'parallel-track' | 're-tier' | 'review-batching' | 'brief-rule'
               | 'pull-forward' | 'batch-tier1' | 'resequence' | 'defer';
  readonly subjects: readonly PlannedLaneRef[];
  readonly expectedSavingMinutes: number;            // from the model; 0 when unknown
  readonly qualityCost: 'none' | 'review-coverage' | 'test-coverage' | 'ci-minutes' | 'owner-attention';
  readonly ruleChanged: { scope: 'schedule' | 'tier' | 'review' | 'brief-template' | 'batching' | 'seat' | 'owner-rule';
    from: string; to: string } | null;                // plain text ≤ 200 code points, secret-pattern checked
  readonly needsOwner: boolean;                      // always true for tier, review, seat, owner-rule
  readonly reasonCodes: readonly string[];           // codes only, never a finding summary
}
```

Every string passes `planTextError` and the shared secret patterns; a proposal that would carry a refused string is not written and the pass reports `refused`.

### 3.4 Cadence and triggers

| When | How | Result |
|---|---|---|
| Wave boundary | driver pass sees every lane with `wave = n` terminal and `wave = n+1` has unstarted lanes | proposal `wave-boundary`; attention item `replan-suggested` |
| Daily | `fleet-v2 plan replan --digest` from the owner's scheduler (as `todo --digest`, TD-D9) | plain-text digest on stdout |
| Signals, checked each driver pass | `trainWaitP50 > 20 min`, `tier2IdleGap > 60 min`, `fixRoundRate > 1.0 / lane` over 10, `estimateSlip > 30 %` (D-CR4) | one open proposal per plan; a new one supersedes when `factsDigest` changes; debounced to `policy.replan.minIntervalMinutes` (default 180) |
| Manual | `fleet-v2 plan replan [--dry-run] [--json] [--sidecar <file>...]` | exit 0 produced (also with zero levers), 1 refused (inputs below `minSourcesRead`), 2 usage |

### 3.5 Place in the hexagon

Owned by **`work-execution`** (it already owns lane plans, runs, journals and the board read model); the dependency direction is unchanged. Evidence owns finding classification; coordination owns the owner surfaces.

- **Domain (work-execution):** `replan-records.ts` (the records above, validators), `replan-graph.ts` (critical path, tracks, start-now; reuses `lane-plan-graph.ts`'s alias resolution), `replan-waits.ts` (durations from journal facts), `deriveReplanProposal(facts)`: pure, never throws, never reads a clock.
- **Domain (evidence-and-acceptance):** `finding-causes.ts`: the rule table and `classifyFindingCauses(findings) → codes`.
- **Application:** in-ports `ProposeReplanPort`, `InspectReplanProposalPort`, `ListReplanProposalsPort` (work-execution); `ClassifyFindingCausesPort` (evidence). Out-ports `ReplanProposalRepositoryPort`, `LaneScorecardReadPort`, `FindingCauseReadPort`, `ReplanOwnerRoutingPort` (delegates to `AskOwnerQuestionPort`, `FindOwnerQuestionByKeyPort`, `RecordAttentionItemPort`, the `LaneRunParkNoticeAdapter` pattern), `ReplanSettingsPort` (structural subset of `policy.replan`, like `AutoMergeSettingsPort`). Use cases `ProposeReplanUseCase`, `ClassifyFindingCausesUseCase`.
- **Infrastructure:** `ReplanProposalRepositoryAdapter` (file + memory, `<stateDir>/replan-proposals.json`, CAS), `LaneScorecardFileAdapter` (JSONL), `FindingCauseReadAdapter` (in-process → evidence), `ReplanOwnerRoutingAdapter`, `ReplanSettingsAdapter`. Manifest `adapter_bindings` and a `context_mappings` row (evidence → work-execution, OHS) added in the orchestrator's manifest commit (CRM).
- **Composition roots:** `apps/cli` wires `plan replan|replan show|replan list` and the driver cadence; `apps/api` serves `GET /v1/replan`, `GET /v1/replan/:id` (bearer today, `read` scope after T3a); `apps/web` renders `/replan` read-only with sources header, "as of" and not-read states; a TUI screen in the P9 shell later. No console logging in packages; CLI I/O at the boundary.

### 3.6 Authority and safety

- A proposal grants and changes nothing: it is a reading. `ReplanProposal.status` moves to `decided` only through a recorded owner answer (question) or a plan revision whose sidecar `replanRef` names it; the record never applies itself.
- Levers of scope `tier`, `review`, `seat`, `owner-rule` are `needsOwner: true` by construction; `schedule`/`batching` levers are the orchestrator's to adopt within existing rules, and still only through a plan revision.
- No model participates in producing a proposal, so no model re-tiers its own work. The Fable plan-revision pass that narrates an accepted proposal is read-only, runs on the orchestrator's machine, and its output is a docs PR reviewed like any other; a re-tier of a lane whose implementer family matches the narrating model is marked in the PR body.
- Workers never run it: the command is not in the runner environment allow-list, there is no runner route, and a proposal is never injected into a brief (candidate notes rule, `AGENTS.md`).
- Public-repo rule: the proposal and any plan revision committed to fleet-v2 carry lane ids, counts, minutes, cause codes and reason codes only; never hosts, finding summaries, private paths, seat cost or security findings. `plan replan --json` redacts nothing further because nothing sensitive enters the record.

## 4. Workbook

Each lane about 45 minutes, one PR. Shared files in bold merge one at a time. **Track CR** runs beside Waves 1–3 on packages idle there (evidence, installation, apps/api, apps/web, new `replan-*.ts` files in work-execution); it never touches `advance-lane-run/*` or `conductor.ts` before Wave 3's K11b' (Wave 0–1 untouched). It is the pilot of the second orchestrator session (D-CR3), capped at 1 lane in flight so the main track keeps 2–3.

| Lane | Scope | Package / shared files | Tier | After | Acceptance |
|---|---|---|---|---|---|
| CR0 | This plan; `2026-10-31_remaining-work-plan.workbook.json` (v1) | docs | 0 | — | `plan check` drift report clean once WB7a exists; cycle check passes via a unit test fixture |
| CR1 | Sidecar v2: optional `estimateMinutes`, `runAs`, `wave`, plan `replanRef`; v1 still accepted; canonical JSON | work-execution (domain) | 2 | CR0 | v1 and v2 fixtures import; unknown field refused; `LANE_PLAN_RECORD_VERSION` unchanged |
| CR2 | `replan-graph.ts`: weighted critical path, package/shared-file serialisation, tracks, start-now, utilisation | work-execution (domain) | 2 | CR1 | Remaining-work plan fixture reproduces §2 walls within 10 %; cycle → typed error |
| CR3 | `replan-waits.ts`: queue waits from run/journal facts; scorecard rows merged; p50/p90 | work-execution (domain) | 2 | — | Journal fixtures with gaps and ambiguous results; a missing entry is `unknown`, never 0 |
| CR4 | `finding-causes.ts` rule table; `ClassifyFindingCausesPort`/UseCase; codes only | evidence-and-acceptance, **manifest** | 2 | — | Golden fixtures per code; a summary with a secret-shaped string classifies without echoing it |
| CR5 | `replan-records.ts` + `deriveReplanProposal`: levers, quality costs, `needsOwner` rule, quota forecast, `factsDigest` | work-execution (domain) | 2 | CR2, CR3 | Property test: same facts → same digest; every tier/review/seat lever `needsOwner`; refused text → no record |
| CRM | Manifest commit: ports, adapters, bindings, context mapping; `yarn sync` | **manifest**, barrels | 0 | CR4, CR5 | `yarn lint:arch`, `yarn sync:check` |
| CR6a | `ProposeReplanUseCase` over `--sidecar` files (no store), `LaneScorecardReadPort` + JSONL adapter, `FindingCauseReadAdapter`, `ReplanSettingsPort` | work-execution (app, infra) | 2 | CRM | Dry-run against fixtures; a throwing port leaves `sources[].status = not-read` and still produces a proposal when `minSourcesRead` is met |
| WB4a' | `LanePlanRepositoryPort`, file/memory stores, `ImportLanePlanUseCase` (pulled from W6, D-CR1) | work-execution, **manifest** | 2 | CR1 | Work-board plan's WB4a acceptance unchanged |
| CR6b | Store-backed proposals: `ReplanProposalRepositoryPort` + adapters, supersede rule, `replanRef` linking on import → `decided` | work-execution (app, infra) | 2 | CR6a, WB4a' | Two proposals, same digest → one record; import with `replanRef` moves status |
| CR7 | `policy.replan` keys with validation and defaults | installation | 1 | — | Reject negative thresholds; defaults as §3.4 |
| CR8 | `plan import` (minimal, from WB7a) and `plan replan [--dry-run\|--json\|--digest\|--sidecar]`, `replan show\|list`, exit codes | apps/cli, **`index.ts`, `composition.ts`** | 2 | CR6b, CR7 | CLI tests per exit code; composes read-only repositories; no forge adapter |
| CR9 | `ReplanOwnerRoutingPort`/adapter: keyed questions for `needsOwner` levers, `replan-suggested` attention item; repeat returns existing | work-execution → operator-coordination, **manifest** | 2 | CR6b | One question per (proposal, lever); answer recorded → `decisionRefs` |
| CR10 | Driver cadence: wave-boundary detection, signal checks, debounce; journalled; skipped while halted | apps/cli (`conductor.ts`) | 2 | CR8, CR9, Wave 3 K11b' | Scenario test: boundary fires once; halted driver computes nothing |
| CR11 | `GET /v1/replan`, `/v1/replan/:id`; `replan` feed kind | apps/api, `composition.ts` | 2 | CR6b | 501 unconfigured; bearer required; `read` scope after T3a |
| CR12 | `/replan` read-only view: baseline, levers table, sources header, not-read/as-of states | apps/web, **`view-nav.tsx`** | 2 | CR11 | Fixture render; no action buttons |
| CR13 | TUI Replan screen in the P9 shell | apps/cli | 1 | CR8, P9 | After Wave 7's P9 |
| CR-R | Runbook `docs/runbooks/replan.md`; S7 JSONL format in tier2-speed plan §3 | docs | 0 | CR8 | — |

Totals: 14 lanes here (11 T2, 2 T1, 1 T0 PR) plus two T0 commits; about 11 h of hand-run time at 1 in flight, landing across Waves 1–4 without entering their chains. WB4a' and CR8's `plan import` are moved out of Wave 6; its work-execution sequence shortens by one.

## 5. Hard to undo

- **`ReplanProposal` record v1** and the **sidecar v2 fields**: stored data and a file format in several repositories (work-board §5). Absent version means 1; unknown refused (D-R8).
- **Cause-code taxonomy**: codes appear in stored proposals and in committed plan revisions; renaming one needs an alias table. Keep the set small and additive.
- **`policy.replan` keys**: an installation file change; defaults chosen so an absent block means "manual only, no signals".
- **A proposal is public text once in a plan revision**: §3.6's rule is the guard; the record validators are the mechanism.
- Everything else is two-way: the view, the CLI, the driver hook and the question routing are removable.

## 6. Decisions for the owner

| # | Question | Recommended |
|---|---|---|
| D-CR1 | Pull WB4a and a minimal `plan import` forward from Wave 6 into Track CR? | **Yes.** They are the data foundation; `--sidecar` dry-run bridges until they land |
| D-CR2 | Sidecar v2 with optional `estimateMinutes`, `runAs`, `wave`, `replanRef`? | **Yes**; v1 files keep importing |
| D-CR3 | Run Track CR as the pilot of a second orchestrator session on disjoint packages, 1 lane in flight? | **Yes**; measure in S7 before a third session |
| D-CR4 | Cadence and thresholds: wave boundary + daily digest + signals (train p50 > 20 min, T2 idle gap > 60 min, fix-round rate > 1.0, slip > 30 %), 180 min debounce | **Yes**; tune after ten proposals |
| D-CR5 | Fix-round causes by a rule table inside evidence, codes only crossing; no model classifier | **Yes**; a model classifier is a later lever, owner-decided |
| D-CR6 | Owner surface: keyed owner questions plus a `replan-suggested` attention item now; plan-decision owner items when WB4c lands | **Yes** |
| D-CR7 | Re-tier levers are always owner decisions; down-tier eligibility = `packages ⊆ {web, ui, docs}`, no shared files | **Yes**; fleet-v2 never writes a tier |
| D-CR8 | Fable quota as an owner-entered `fableWeeklyPasses`, consumption measured from receipts by model family | **Yes** |
| D-CR9 | S7 scorecard as JSONL in the state directory, read through `LaneScorecardReadPort`; never committed | **Yes** |

## 7. Assumptions

- WB1a–c are on `main` (verified); lane runs and the keyed journal are stored (`LaneRunRepositoryPort`, `LaneRunJournalPort` in the manifest) and conduct entries carry the time a state was entered.
- Hand-run Tier 2 lanes have attempts but no `LaneRun`; their waits come only from S7 rows, and the orchestrator keeps those rows current.
- `reviewerModel` on receipts identifies the Fable family by prefix; a renamed model id needs the `fableModelFamily` setting updated.
- `MergeRecord` (WB5a) is not built; "merged" is read from runs, `PullRequestLink`, `mergedPr`, and later the merge record, in that precedence.
- Estimates default by tier and runAs when the sidecar carries none; the first proposals are coarse until S7 fills in.
- `hexagen arch validate` accepts the new evidence → work-execution in-process mapping as it does `AcceptanceReceiptReadAdapter`.

## 8. Challenge this

Whether a deterministic analyser earns its keep against the orchestrator's judgement: today's re-organisation came from reading plans, not from metrics, and a record-driven proposal can only name levers it has rules for. The counter-case is that the inputs (waits, idle gaps, cause clusters, start-now sets) are exactly what the orchestrator assembled by hand and will keep needing; a reviewer should ask whether S7 plus a markdown template would deliver most of the value with none of the stores. Whether maintaining a sidecar for 184 units is hand work the plan meant to remove: WB7a's `plan check` is the mitigation, and the remaining-work plan is already in table form. Whether "parallel tracks" is fleet-v2's concern at all, since orchestrator sessions live outside it; the proposal can only recommend one. And whether signals invite Goodharting (batching to lower PR counts, wider Tier 1 to lower fix-round rates): the escaped-defect guardrail of the speed plan §4 must sit beside every saving figure.
