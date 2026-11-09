# Plan: split and optimize lanes from the fleet-v2 UI

- **Status:** rev 0, 2026-11-05. The owner asked for this ("write a feature that would allow user to optimize and split lanes from within the fleet-v2 UI"). Not reviewed yet. Nothing is built until the decisions in §7 are recorded.
- **Builds on:**
  - the work-board plan (`2026-10-27_work-board-plan.md`): planned lanes and their sidecar records;
  - the feature-planning plan (`2026-11-01_feature-planning-plan.md`): items, briefs, approval, hand-off, and D-R10 (the web never gets a dispatch power);
  - the web interactivity plan (`2026-10-27_web-ui-interactivity-plan.md`): the `/v1` write path, scopes and the request channel.

## 1. Goal

An operator opens a planned lane or a drafted brief in the web UI and sees:

- how big the lane is;
- what it collides with;
- where it sits on the critical path.

They then split it into smaller lanes that can run in parallel, or reorder the plan so it finishes sooner. Today the orchestrator does this by hand. On 2026-11-04/05 alone it:

- split DT9 into DT9a/b/c because one lane was too large;
- moved DT10's CLI wiring into DT10b because `apps/cli/src/composition.ts` was held by another work order;
- split CX7 into CX7a/b because admission refused an overlap on `descriptor.ts`;
- held CO13 behind CX7b because both touched `prepare-dispatch.ts`.

Each of those took one to three hours of lane time to discover: a refused registration, a parked run, or a review round. The feature makes the same calls visible before dispatch and lets a person apply them in a few clicks.

**Not in scope:**
- **Splitting a running lane.** That is the relaunch track (CO27 save, CO28 adopt).
- **Any automatic split or reorder.** The system proposes; a person applies.

## 2. What exists

- **Lane plan records** (`packages/work-execution/src/domain/lane-plan-records.ts`): planned lanes with `scope`, `packages`, `sharedFiles`, `after` edges, decisions, `exclusiveOrders` and limits.
- **Lane plan graph** (`lane-plan-graph.ts`): dependency edges and cycle detection across plans, with no critical-path or slack computation.
- **Admission** (`LaneRunAdmissionAdapter`, `ReserveExecutionCapacityUseCase`): refuses overlapping owned paths at registration and start. This is the hard stop the analysis predicts.
- **Run journal and lane telemetry:** wall time, rounds and outcome per run, which is enough to calibrate a size estimate.
- **The feature-planning item lifecycle** (FP2–FP16): drafting, checks (including §6 check 6, overlap), approval, hand-off. Splitting a brief must enter this lifecycle, not bypass it.
- **The web:** read pages (`/lanes`, `/brief`, `/work-order`) and the same-origin write path still being built (T3b, T6).

## 3. The shape

### 3.1 Lane analysis: a pure domain function (LS1)

`analyzeLane(lane, context) → LaneAnalysis`, pure, deterministic, total, no I/O. Inputs (all ids, paths and counts):

- **The lane:** owned paths (or `packages` plus `sharedFiles` for a planned lane), `after` edges, tier.
- **Open work orders' owned paths.**
- **Per-file facts at the base:** line count and the largest function's cognitive complexity, read by an adapter (LS4).
- **Calibration:** median wall minutes and rounds for past lanes by file-count band and tier (LS7).

Output:

- **Size estimate:** files, lines touched, a minutes band from calibration, and over-size when it exceeds the 45-minute lane target.
- **Collisions:** each owned path held by an open work order, with that order's id and state, so admission's refusal is predicted, never discovered.
- **Hot files:** owned paths that are serialization points across the repository: `apps/cli/src/composition.ts`, `apps/cli/src/index.ts`, generated barrels, `.architecture/manifest.yaml`, and any path held by three or more work orders in the last 14 days.
- **Reason codes** for every flag, never prose built from file text.

### 3.2 Split proposal: a pure domain function (LS2)

`proposeSplit(lane, analysis) → SplitProposal`, deterministic, with a reason code on every cut. Rules, in order:

1. **Manifest first.** A path set that needs new manifest entries becomes a leading T0/T1 manifest part: the CO2b and KM pattern.
2. **Layers in hexagonal order.** Domain, then application, then infrastructure, then CLI and web wiring. A later part names the earlier one in `after`.
3. **Wiring last.** Every hot file goes into one final wiring part, so the bulk of the work runs while a hot file is held elsewhere. This is the DT10a/DT10b pattern.
4. **Collision isolation.** Paths held by an open work order go into a part that waits on that order. The rest can start now. This is the CX7a/CX7b pattern.
5. **Size bound.** Any part still over-size is cut by package, then by file. A single over-size file stays as one part and is flagged, never split.

Every part gets an id (`<lane>a`, `<lane>b`, …), its own owned paths (pairwise disjoint, and their union equals the original), `after` edges, a tier no lower than the original's, and an estimate. The proposal is advice. Applying it is §3.5.

### 3.3 Plan optimizer: a pure domain function (LS3)

`optimizePlan(plan, context) → PlanOptimization` over the lane plan graph:

- **Critical path:** the longest chain by estimated minutes, and each lane's slack.
- **Parallel sets:** lanes that can run at once, given the `after` edges, owned-path overlap and the configured lane cap.
- **Suggestions,** each with the minutes it saves:
  - split a critical-path lane that is over-size or hot-file bound;
  - move a hot file to a wiring part;
  - drop an `after` edge that no owned path or declared export justifies, shown as "check this" and never applied by itself.

The optimizer never rewrites the plan.

### 3.4 Read routes and the page (LS5, LS6)

- **Read routes:** `GET /v1/plans/:projectId/:planId/lanes/:laneId/analysis` and `GET /v1/plans/:projectId/:planId/optimization`.
  - Both need the `read` scope and return ids, paths, counts and reason codes only.
  - Each answer records the base commit and digest it was computed at, plus `computedAtIso`.
- **Web:** on `/lanes` (planned lanes) and `/planning` (drafted items), a "Size and split" panel:
  - the size band, collisions and hot files, with reason codes rendered as fixed strings;
  - the proposed split as editable part cards: drag a path between parts, add or remove an `after` edge, rename a part;
  - live checks on every edit, with the same rules as §3.5: disjoint parts, full cover, wiring last, size bound, no tier below the original;
  - a plan view with the critical path highlighted, and the optimizer's suggestions with their saving.
- **Accessibility:** the panel follows the interactivity plan §6. Keyboard reordering is the primary way to move paths, and dragging is an equivalent.

### 3.5 Applying a split: a request, never a dispatch (LS8)

1. The page posts a `lane-split` request under `operate`, naming the source item or planned lane, its revision, and the edited proposal.
2. The planning host job applies it. It holds `orchestrate`, and the web never does (D-R10). The job:
   - re-reads the source at the named revision and refuses if it moved;
   - re-runs every §3.2 check on the edited proposal;
   - refuses `lane-split-invalid` with the failing rule.
3. On success it writes, in one journaled step:
   - one new planning item per part, with `after` edges and owned paths;
   - the source marked `superseded-by-split` with links to its parts.

   For a planned lane it writes a sidecar revision with the parts and the source `dropped` with `renamedFrom` links, so the board keeps its history.
4. Each part then follows the normal lifecycle: a brief draft, checks, approval, hand-off. A split never approves a brief or starts a run.
5. **Already-approved or handed-off source:** if the source was already approved, the parts start as drafts, because approval does not carry across a split. If the source's work order exists but no run has started, the job refuses with `lane-split-registered`; the operator stops the work order first.

### 3.6 Calibration (LS7)

A projection over finished runs records, per run:

- files touched, lines changed and tier;
- wall minutes from start to PR, and from start to merge;
- review rounds and outcome.

It feeds the §3.1 estimate as medians per band. Until there are 20 finished runs in a band, the estimate shows "no calibration" and uses a fixed default of 12 files and 45 minutes for the over-size flag. Every estimate on the page carries its sample count.

## 4. Place in the hexagon

- **Domain** (`work-execution`): `lane-analysis.ts`, `lane-split.ts`, `plan-optimizer.ts`, all pure. LS1–LS3 add no ports.
- **Application:**
  - `AnalyzeLanePort`/`UseCase` and `OptimizePlanPort`/`UseCase`, both read-only;
  - `RepositoryFactsPort` (declared by CO2b for CO16) supplies the file facts;
  - `LaneSplitRequestPort` for applying a split, owned by the planning host job.
- **Manifest:** one manifest lane, LS0, declares them all before LS4.

## 5. Workbook

| Unit | Scope | Tier | After |
|---|---|---|---|
| LS0 | Decisions D-LS1–D-LS4 recorded; manifest declarations for LS4, LS5 and LS8; `yarn sync` | 0/1 | owner |
| LS1 | `analyzeLane`: size, collisions, hot files, reason codes; full table tests | 2 | none (pure) |
| LS2 | `proposeSplit`: the five rules, disjoint cover, ids, edges, tier floor; property tests (cover and disjointness on random path sets) | 2 | LS1 |
| LS3 | `optimizePlan`: critical path, slack, parallel sets, suggestions with savings | 2 | LS1, lane plan graph |
| LS4 | Read use cases and adapters: file facts through `RepositoryFactsPort`, open work orders, calibration read; the two read routes | 2 | LS0, LS1–LS3, CO16's adapter |
| LS5 | Web panel, read-only: size, collisions, hot files, proposed split, plan critical path | 2 | LS4, FP14 |
| LS6 | Web panel editing: part cards, keyboard moves, live checks (shared rules from LS2) | 2 | LS5 |
| LS7 | Calibration projection and its tests; "no calibration" path | 1 | none |
| LS8 | `lane-split` request kind; host-job apply (items or sidecar revision, supersede links); refusals; web submit | 2 | LS6, FP15, FP16a, T6 |
| LS9 | Runbook and `/help` text; an e2e from analysis to applied split to two drafted parts | 1 | LS8 |

**Order:**
- LS1, LS2, LS3 and LS7 are pure and can start as soon as LS0's decisions are recorded, in parallel with the write-path track.
- LS5 can ship before LS8 as a read-only advisor. That alone removes most of the discovery time named in §1.

## 6. Hard to undo

- **The `lane-split` request kind and the `superseded-by-split` state.** Both become part of stored planning history. Revert the code before any split is applied, or keep a reader for both forever. This is a one-way door, and it is the owner's to choose (D-LS1).
- **Nothing else:** analysis and optimization store nothing.

## 7. Decisions for the owner

- **D-LS1:** may the web apply a split at all, or only show it, with the orchestrator applying it through the CLI?
  - **Recommended:** web apply through the request channel (§3.5), owner identity only in v1, like approval.
- **D-LS2:** may the optimizer ever apply its own suggestions?
  - **Recommended:** never. Suggestions only; a person applies each one.
- **D-LS3:** the estimate source.
  - **Recommended:** deterministic calibration from past runs (§3.6), no model call. A model estimate can be added later behind the same output type.
- **D-LS4:** splitting a lane whose work order exists but has not started.
  - **Recommended:** refuse (`lane-split-registered`) in v1. The operator stops the work order first, which keeps one owner per path at all times.

## 8. Assumptions

- Owned paths are known before dispatch. This holds for drafted briefs (OWNED lines) and only approximately for planned lanes (`packages` plus `sharedFiles`). For a planned lane the analysis says "approximate", and the split works on packages.
- Admission's overlap rule stays path-based. If it moves to symbol-level ownership, collisions in §3.1 must follow it.
- Hot files are few and stable. The 14-day "three or more work orders" rule keeps the list current without hand curation.

## Challenge this

The five split rules (§3.2) encode the orchestrator's habits from two days. Challenge whether "wiring last" holds for a lane whose wiring is most of the work, such as a CLI-only lane. The rule then produces one tiny part and one large one. LS2's tests should include that case, and the proposal should fall back to one part with a "no useful split" reason rather than a split that saves nothing.
