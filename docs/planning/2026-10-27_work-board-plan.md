# Plan: the work board — Done, In flight, Queued and Waiting, kept by fleet-v2

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 3. Rev 0 was reviewed by Grok 4.7 (six blockers, two majors, one minor; all applied in rev 1). Grok re-reviewed rev 1 (one blocker, five majors, three minors); that was the second round, so the orchestrator decided the resolutions, applied in rev 2 (§8). The owner decided D1, D2, D8 and D9 on 2026-10-27, each as recommended; D3–D7 and D10–D12 are recommended defaults, shown to the owner the same day with no objection, and stay open until the owner decides otherwise (§6). Rev 3 (lane WB0) writes D1, D2, D8 and D9 into §6, splits WB1 into WB1a–c, makes `exclusiveOrder` a list and names a lane's packages by workspace name. Nothing built. Anchors checked against `main` at `258b1b4`.
- **Owner request (2026-10-27):** "The table that you just rendered contains highly useful data that I would want surfaced and maintained within the UI and TUI. (Done, In-flight, Queued, blocked/waiting). Write it up as a plan." The table was assembled by hand from pull-request lists, lane worktrees, briefs, a follow-up list and the plans' workbooks.
- **Builds on:** `2026-10-27_conductor-plan.md` (K1-1 to K1-2c, K1b, K3, K6, K7, §3.2 states, §3.6 park reasons, §3.9 reaper), `2026-10-27_web-ui-interactivity-plan.md` (A-R, A-WO, A-S, W7a, O2c, O8, O9, §3.6 request channel, §6 states), `2026-10-20_auto-merge-policy-plan.md` (AM3b attention store, AM4a, AM4b PR-state read), `2026-10-24_live-updates-and-state-resilience-plan.md` (`/v1/changes`, E3c, E5), `2026-10-24_project-onboarding-and-config-ui-plan.md` (project registry, P9 TUI shell, its D3), `2026-10-18_orchestrator-interaction-plan.md` (T3a scopes, T6 write path, T8a) and `2026-10-26_execution-order.md` (how lanes are ordered today).

## 1. Goal

One board, kept by fleet-v2 rather than by an orchestrator's memory, that answers four questions for every project in the installation:

1. **Done:** what merged, in which repository, as which lane of which plan.
2. **In flight:** which lane has started and is not merged, on which seat, at which step.
3. **Queued:** which planned lane has never started, and exactly what it waits on.
4. **Waiting on the owner:** which merges, secrets, decisions and backups only the owner can do.

The same read model feeds `fleet-v2 board` in the terminal and `/board` in the web. Every fact on it says when it was read and from where. A source that could not be read shows "not read"; the board never shows an old fact as current, never forgets a merge it once saw, and never calls a lane ready while one of its guards is unknown.

**Non-goals.** The board grants nothing and dispatches nothing: "ready" is a reading, not a permission, and every dispatch still passes every existing refusal. No model inference: card text is rendered from records. No markdown parsing and no free-text parsing as a source of truth. No new route around the request channel or the conductor. No credentials, host names or client content on a card.

## 2. What exists (checked on `main`, 2026-10-27)

| Column | What exists | Anchor | Gap for the board |
|---|---|---|---|
| Done | A fleet merge saves the work order `merged`; the PR number is only free text in the journal entry's `detail` | `ExecuteAuthorizedForgeActionUseCase.use-case.ts:223-235`, `:269-280` | Lanes merged by hand or by the owner leave no record. No forge read lists PRs; AM4b's PR-state read (one PR, for A13) is planned, not built. No typed PR number on any record, so "merged by fleet" cannot be derived without parsing text |
| Done | Branch name derived from the lane id | `ExecuteAuthorizedForgeActionUseCase.use-case.ts:220` (`feat/${workOrder.laneId}`) | Hand-run lanes use other branch names; a branch name is not a link |
| In flight | `AttemptRecord`: state, kind and `fixNumber`, `priorAttemptId`, runner (model, agent, variant), `seatSelection` (role, index), `stopReason`, usage | `packages/work-execution/src/domain/execution-records.ts:161-208` | Covers only lanes dispatched through `attempt dispatch`. No "step" beyond attempt state; review findings live in evidence (`GET /v1/heads/:sha/evidence`) |
| In flight | `ListAttemptsUseCase` joins attempts, work orders and held reservations; served as `GET /v1/attempts` | `ListAttemptsUseCase.use-case.ts:99-103` | Read-only and per attempt, not per lane |
| In flight | `LaneRun` (state, round, seat cursors, park) | conductor plan §3.2 | Not on `main`; K1-1 is built and in review on its branch; K1-2a onward and K3's repository are queued |
| Queued | `WorkOrderRecord` has `laneId`, `ownedPaths`, `prerequisiteWorkOrderIds` | `execution-records.ts:51-65` | Registration refuses an owned path that overlaps any active work order (`RegisterWorkOrderUseCase.use-case.ts:97-112`), so two queued lanes on one package cannot both be registered. Nothing records package, shared files, tier, plan or brief readiness |
| Queued | `WorkOrderState` declares nine states | `WorkOrderState.vo.ts:8-18` | Only `approved` (registration, `:133`) and `merged` (forge) are ever written; no use case sets the others, so the state cannot tell queued from in flight |
| Queued | Capacity reservations and the active list | `ExecutionJournalPort.out-port.ts:106` | Nothing says how many slots are free against the installation's budget |
| Queued | Plans' workbook tables (`Lane`, `Scope`, `Package / shared files`, `Tier`, `After`) | `2026-10-27_conductor-plan.md` §4 | Markdown only; dependencies, shared-file exclusivity and the manifest order live in prose and in an orchestrator's private notes |
| Waiting | `OwnerQuestion` with `blocks: [{ kind: plan \| pr \| lane \| work-order, ref }]`; served and shown (Q4) | `packages/operator-coordination/src/domain/owner-question-records.ts:34-38`, `:69` | Covers decisions asked as questions. Not merges, secrets or backups, and not a plan's open `D` rows. `acknowledged` follows a rejection as well as an answer (`AcknowledgeOwnerAnswerUseCase.use-case.ts:60-63`), so it is not proof of a choice |
| Waiting | Attention is read from an external service, read-only | `AttentionReadAdapter.adapter.ts:1-15` | AM3b's writable attention store is planned (`2026-10-20_auto-merge-policy-plan.md` A12), not built; its items are machine notices keyed (project, work order, kind) |
| All | Project registry: `ProjectProfileRecord` with `repository`, `maxConcurrentLanes`, `status` | `coordination-records.ts:49-65` | No board spans projects; repositories with no lanes have nothing to show |
| All | `/v1/changes` serves signals for `attempt`, `capacity`, `work-order`, `question`, `profile` | `apps/api/server/routes/v1/changes.get.ts`; kinds at `apps/api/server/wiring/changes/change-feed.ts:7-13`, `:45-51` | No kinds for plans, owner items, merges or forge observations |
| CLI | Command groups `work-order register\|inspect`, `attempt`, `questions`, `projects`, `doctor`, … | `apps/cli/src/index.ts:1810-1850` | No board, plan or list-work-orders command. `--json` is the payload input everywhere except `doctor`, where it selects output (`:1495-1533`) |
| TUI | None. The shared `fleet-v2 tui` shell is planned (onboarding P9, orchestrator T8a; Ink recommended in onboarding D3) | `2026-10-24_project-onboarding-and-config-ui-plan.md:152`, `:206` | No screen |
| Web | `/lanes` (attempts), `/attempt`, `/work-order` timeline (W8a), `/questions` (Q4), `/projects` | `apps/web/src/shell/view-nav.tsx:9-64` | No cross-lane, cross-project view |

Missing: a typed home for planned lanes and their dependencies, a typed home for owner to-dos that are not questions, a durable record of each merge, a recorded forge read, a typed PR number where fleet merges, a unique link between a PR and a lane, and the read model that joins them.

## 3. The shape

### 3.1 One card per lane, one column, every other fact as a badge

The unit is a **lane**: a planned lane from a plan's workbook, a work order with no plan (registered by hand), or a merged PR with no lane recorded. A lane **has started** once any attempt, lane run or declaration (§3.5) has ever been recorded for it, or a PR is linked to it. Each lane is one card in exactly one column, by the first rule that matches:

| Column | Rule | Source of truth |
|---|---|---|
| **Done** | A `MergeRecord` (§3.4) exists for a PR linked to the lane, or its work order is `merged` (a fleet merge) | `MergeRecord`, the work order. Never a title, a branch name, a plan's prose or a windowed snapshot |
| **Waiting on owner** | An open **gating** owner item names the lane in its `blocks`: kind `merge` (the lane's PR), `decision` or `secret` (§3.3) | `OwnerItem` |
| **In flight** | The lane has started and is not Done | Attempts, `LaneRunRecord` (after K3), PR links, forge observation, declarations |
| **Queued** | The lane has never started: no attempt, run, declaration or PR link was ever recorded, and it is not `dropped` or `deferred` | `PlannedLane` (§3.2), with computed `waitsOn` (§3.6) |

In flight therefore covers every "started, not running" case, each with its own step (§3.5): "PR closed without merge", "between steps" (an ended attempt, no open or closed linked PR), "run stopped, not merged", "state unknown (declaration lapsed)", "dropped in plan after work started". A lane never falls back to Queued once it has started.

**Badges carry every other fact.** Whatever column a card is in, it shows badges for each fact the column did not use: open owner items and questions on the lane (gating or not), a running attempt with its seat, an open PR with its read time, a closed linked PR ("PR #n closed as of <time>"), a park, attention notices (including a link conflict or a merge integrity finding, §3.4). A Waiting card still shows "attempt running: first-pass, <model>"; an In flight card still shows "backup open (owner item)". Nothing about a lane is hidden by its column.

**One identity rule for owner items and questions.** An open owner item appears in Waiting in one of two ways, and is listed once in the owner-items list (deduplicated by item id):
- as the Waiting reason on **each** lane card it gates, when it moved that lane into Waiting. An item whose `blocks` names several lanes is the reason on every one of those lanes' cards; a lane gated by two items lists both. Such an item gets no card of its own; or
- as its own card, in every other case: it names no lane, it is not gating (`backup`, `other`, or a lane named only in `refs`), or every lane it names is Done. An owner item that names a Done lane is never folded into the Done card; it keeps its own Waiting card, and the Done card shows it as a badge.

An open owner question follows the same rule. A question that an owner item references is the same entity as that item (the item is the card, the question its badge and its answer path); a question no item references is treated as an owner item of kind `decision`, gating the lanes in its `blocks`.

**Card content per column:**
- **Done:** PR number and repository, merged-at, first seen at, merger (`fleet` or `unknown`, §3.4), the plan.
- **In flight:** the step (§3.5), the seat (recorded model and role), the round, the attempt or run id, the PR with "open as of <time>" and CI state, the latest review receipt's finding counts by severity.
- **Queued:** each `waitsOn` reason with what it names, brief state, and "ready" only when every guard is clear.
- **Waiting:** kind, subject, since when, what resolves it, what it blocks, and the lane's badges. A lane that left Queued for Waiting also shows its other `waitsOn` guards (§3.6) as badges, each `blocked` and `unknown` one with what it names, so the move drops no reason.

### 3.2 Planned lanes: a sidecar per plan, imported into a typed record

**Recommendation (design question 2): a structured sidecar per plan, imported by the CLI.** Each plan keeps its readable markdown workbook. Beside it sits `<plan>.workbook.json`, the machine copy, and `fleet-v2 plan import <file> --project <id>` records it. Parsing the markdown table is rejected as fragile: the tables mix bold, arrows, group rows and prose in the `After` column (§4 of the conductor plan has "V2 is out of evidence" and "K1-2c, K1b, K3" in one column). Declaring rows one by one with CLI commands is rejected as the same hand work the board is meant to remove, spread over many commands with no reviewable file.

The sidecar, `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "projectId": "<a registered project id>",
  "planId": "2026-10-27_conductor",
  "revision": 3,
  "doc": "docs/planning/2026-10-27_conductor-plan.md",
  "lanes": [
    { "laneId": "K1b", "scope": "Keyed journal …", "packages": ["work-execution"],
      "sharedFiles": [".architecture/manifest.yaml"], "tier": 2,
      "after": ["K1-2a", "2026-10-23_seat-plan/S1a"], "decisions": [], "status": "planned",
      "brief": ".lane/brief-k1b.md" },
    { "laneId": "AM1", "scope": "policy.autoMerge", "packages": ["installation"], "tier": 2,
      "after": [], "status": "planned", "mergedPr": { "repository": "<repo>", "number": 251 } },
    { "laneId": "K1-2", "renamedFrom": "K1-two", "scope": "…", "packages": ["work-execution"], "tier": 2, "after": ["K1-1"] }
  ],
  "decisions": [
    { "id": "D12", "question": "How long a graceful drain runs …", "default": "45 minutes", "state": "open" }
  ],
  "exclusiveOrder": [{ "file": ".architecture/manifest.yaml", "lanes": ["A-J", "O1a", "O1b"] }]
}
```

- **Identity.** A plan is keyed `(projectId, planId)`. `--project` must equal the file's `projectId`, or the import is refused; one project's import can never replace another's plan.
- **Revision.** `revision` is an integer the author bumps. An import is accepted only when it is greater than the stored revision. The same revision with the same digest is a no-op; the same revision with a different digest, or a lower revision, is refused (`stale-revision`), so an older file is never a silent rollback. The store saves under compare-and-swap.
- **`after`** names a lane in the same plan by id, another plan of the same project as `<planId>/<laneId>`, or another project's as `<projectId>/<planId>/<laneId>`. A reference to a plan not yet imported is recorded `unresolved` and computes as `after-unresolved` (§3.6).
- **Cycles are checked across every imported plan.** At each import the dependency graph of every stored plan plus the incoming file is checked; an import that would close a cycle is refused and names the cycle. So a loop between two plans is caught by whichever import closes it, and unresolved edges are checked again when their plan arrives.
- **`packages`** and **`sharedFiles`** are what "one lane per package" and "no two lanes on one shared file" are computed from. `sharedFiles` is the bold column of today's workbooks. A package is a workspace name (`work-execution` for `packages/work-execution/`, `cli` for `apps/cli/`) or `docs`; the board maps a work order's `ownedPaths` to the same names (§3.6).
- **`decisions`** on a lane names the plan's `D` rows that gate it (K12 waits on D14's opt-in).
- **`exclusiveOrder`** is a list with one entry per shared file; each entry records a plan's stated serial order on that file (the web plan's manifest order) as data, not prose. Every lane it names is a lane of the same plan.
- **`status`**: `planned`, `deferred` or `dropped`. Deferred and dropped lanes are never queued.
- **Dropped lanes.** A lane removed from the sidecar, or marked `dropped`, is kept as `dropped`, never deleted, so its links stay readable. A dropped lane does not count as Done for its dependants: every lane whose `after` or `exclusiveOrder` names it shows `after-dropped`, naming it, until the author edits the dependant's `after`. That is visible to the owner and never silently released (D12).
- **Renames.** A lane renamed in a plan carries `renamedFrom: "<old id>"`. The import moves the old id's links, `planRef`s and declarations to the new id and keeps the old id as an alias, so a work order registered under the old id still resolves. A rename without `renamedFrom` is a drop plus an add, and the import warns that the dropped id has links.
- **`mergedPr`** (optional) backfills work that merged before the board existed: the import records a link from that PR to the lane, exactly as `plan link-pr` does. It records no merge: the merge fact comes from the forge (§3.4), and until `forge sync` has seen it the lane is In flight with step "linked PR #n: merge not yet observed".
- **`brief`** (optional) is the brief's worktree-relative path; `plan brief-check` reads that file (§3.6).
- **Decisions.** Each `open` decision becomes one owner item keyed `(projectId, planId, decisionId)` through a consumer-side port; a repeat import updates it. A decision marked `decided` resolves its item (`plan-decided`). A decision removed from the sidecar withdraws its item with reason `decision-removed`, and the board shows that reason on the item's history.
- **Validation:** unknown fields are refused; every string is length-capped, single-line plain text (no control characters) and passes `LANE_DIFF_SECRET_PATTERNS` (refused on a hit, as `OwnerQuestion` does); lane ids are unique in the plan.
- **`fleet-v2 plan check <sidecar> <markdown>`** compares the lane ids, tiers and `After` cells of the markdown workbook with the sidecar and reports drift. It is a warning tool for authors (and a Tier 0 doc check), not a source: it never feeds the board.
- **Where the sidecar lives:** in the repository that holds the plan. Plans for private repositories stay in those repositories; `plan import` reads a local file and never fetches from a forge (D10).

**Why a separate record, not early work orders.** Registration refuses an owned path that overlaps any active work order (`RegisterWorkOrderUseCase.use-case.ts:97-112`), and that rule is a safety guarantee: it is how two live lanes never own the same files. Registering queued lanes early would either break that rule or make it impossible to queue two lanes in one package. So a planned lane is its own record, and becomes a work order only when it is promoted (`work-order register --plan <planId> --lane <laneId>`), which is when the ownership check should run.

**Link to the work order.** `WorkOrderRecord` gains an optional `planRef { projectId, planId, laneId }`, set only at registration. `work-order register --plan <planId> --lane <laneId>` takes `projectId` from the work order's own project and refuses a mismatch (`plan-project-mismatch`), so the same `planId` in two projects can never join the wrong plan. A work order without it is a lane with no plan (shown with its `laneId`). Records without the field read as no plan; nothing is matched by lane-id text, since ids repeat across plans (`P1`, `A1`).

**PR links are unique.** A link `{ repository, number } → (projectId, planId, laneId)` is recorded from fleet's forge journal (§3.4), the run's `prNumber` (K-lanes), a sidecar `mergedPr`, or `plan link-pr <planId>/<laneId> <repository>#<number>`. A PR links to at most one lane: a second link to a different lane is refused (`pr-already-linked`, naming the lane); the same link again is a no-op. A lane may have several PRs (a reopened or split PR).

### 3.3 Owner items: the one wait, with attention and parks as evidence

**Recommendation (design question 1, D1): a new `OwnerItem` aggregate in `operator-coordination`.** It is the only owner wait the board computes columns and guards from. Owner questions are folded into it by the identity rule of §3.1. AM3b attention notices and conductor parks are evidence shown as badges, never separate waits.

- An **owner question** asks the owner to choose among options; it has an answer. A secret to create or a backup to take has no options.
- An **attention item** (AM3b) is a machine notice keyed (project, work order, kind) and cleared when its work order merges. An owner to-do may have no work order and must not vanish when one merges.
- So an owner item is the owner's to-do: `{ itemId, revision, projectId, kind, subject, refs, blocks, createdAtIso, createdBy, state, resolution }`.
  - `kind`: `merge`, `secret`, `decision`, `backup`, `other`.
  - `subject`: single-line plain text, at most 120 characters, no control characters, refused when secret-shaped. For a secret it names the purpose ("forge token for an app repo's deploy job"), never a value. `other` requires a subject; nothing else carries free text. Every surface renders it as text: no markdown, no links.
  - `refs`: typed, `{ kind: pr, repository, number } | { kind: lane, planId, laneId } | { kind: work-order, id } | { kind: question, id } | { kind: plan-decision, planId, decisionId } | { kind: run, id }`.
  - `blocks`: the same shape as `OwnerQuestion.blocks`. A `merge`, `decision` or `secret` item that names a lane in `blocks` **gates** it (§3.1); a lane named only in `refs`, or by a `backup` or `other` item, gets a badge.
  - **Resolution, typed by kind, and who may close it:**

    | Kind | Closed only by | Withdraw |
    |---|---|---|
    | `merge` | A `MergeRecord` for its PR (`merged`, final), or a forge observation of the PR `closed` (`pr-closed`). A `pr-closed` item returns to `open` when a later forge observation sees the same PR `open` (a reopen); only a forge observation may make that transition, the item keeps its key, and its history keeps both entries | **Refused** (D11). A merge wait ends only when the forge says so |
    | `decision` | Its linked question answered with a recorded choice (an answer whose shape is `accept`, or `answer` with an option or text; a `reject`, or an `acknowledged` state alone, does not close it), or `plan import` reading the decision `decided` (`plan-decided`) or removed (`decision-removed`) | **Refused** (D11). Only the plan or a recorded answer ends it |
    | `secret`, `backup`, `other` | The owner marking it done (`via: cli \| web`, at, by the session) | Allowed with a typed reason (`no-longer-needed`, `duplicate`, `superseded`), shown on the board |

- **One merge, one owner item.** The item is keyed `(projectId, merge, repository, number)`. The conductor's `owner-merge` park (K6) and AM4a's "needs an owner merge" routing record or find that item through a consumer-side port; their attention notice and the park are shown as badges on the card, and the card's state is the item's. If a park or attention notice exists with no owner item (before K6 or AM4a wire the port), the lane stays In flight with step "parked: owner-merge" and the badge "owner item not recorded"; the board does not invent the wait.
- **Plan decisions** become owner items on import (§3.2). A run parked `one-way-door` is answered through its keyed owner question (conductor §3.6), which the item for that decision references.
- **Who records them.** The orchestrator (`owner-items add`), `plan import` (decisions), the conductor and AM4a (merges). The owner resolves `secret`, `backup` and `other` items from the CLI and, after T6, the web.

### 3.4 Merges and forge observations

**A merge is a durable fact, recorded once.** A `MergeRecord` is keyed `(repository, number)`:

`{ repository, number, headSha, mergedAtIso, firstSeenAtIso, source: forge-observation | fleet-forge-action, merger: fleet | unknown, actionRef? }`

- **The merge fact is create-if-absent.** `mergedAtIso` and `headSha` are written the first time a merge is seen and never replaced, never deleted, never shortened by a later read. A later snapshot that no longer lists the PR changes nothing. If a later read reports a different `mergedAtIso` or `headSha`, the first values stay and one attention item is raised, keyed `(repository, number, merge-integrity)` (AM3b's store, through a consumer-side port); until AM3b lands, the differing values stay on the forge observation and the card shows a "merge integrity" badge. Done is computed from merge records, so a lane, once Done, stays Done.
- **`merger` may be upgraded once, never downgraded.** It starts `unknown` unless the fleet path wrote the record. It moves from `unknown` to `fleet` only when the fleet path's typed journal entry for that `(repository, number)` exists (whichever of `forge sync` and the fleet path saw the merge first), and never from `fleet` back to `unknown`. The board never parses the journal's free-text `detail`, never reads forge account fields, and never claims "not by fleet".
- **The fleet merge path writes the link, then the merge record (lane WB5b).** `ExecuteAuthorizedForgeActionUseCase`, which every conductor and AM4a merge uses, records the PR number as a typed field on its journal entry, then writes the `PullRequestLink` from the work order's lane (its `planRef`, or its `laneId` for a lane with no plan) to `(repository, number)`, then the merge record with `source: fleet-forge-action`, `merger: fleet` and the action id. So one fleet merge is one Done card. If the link is refused (`pr-already-linked`: the PR is linked to another lane), the merge record is still written, the PR stays on the lane it was linked to, and both lanes' cards carry an attention badge naming the conflict and both lanes.

**Forge observations are snapshots for what can change.** The board never calls the forge while it renders. `fleet-v2 forge sync [--project <id>] [--pr <repository>#<number>]` reads each active project's repository and records one observation per repository:

`{ projectId, repository, readAtIso, outcome: read | unavailable, reason?, pullRequests: [{ number, state: open | merged | closed, headSha, headRef, baseRef, title, mergedAtIso, closedAtIso, ciState: pending | passed | failed | unknown }] }`

- It reads open PRs, PRs merged within the window, and, beyond the window, every PR linked to a lane that has no merge record yet (by number, AM4b's single PR-state read). `--pr` reads one PR, which is how a backfilled `mergedPr` is confirmed.
- Every `merged` PR it sees that has no merge record gets one (`source: forge-observation`). The observation itself is replaced on the next read; the merge records are not.
- It extends AM4b's PR-state read with a list read (`listPullRequests(repository, mergedSince)`) on the same forge-read port in work-execution's infrastructure, so one adapter holds the forge credentials. It mutates nothing.
- **Titles** are single-line plain text, capped at 200 characters, no control characters; a secret-shaped title is stored as "title withheld (pattern name)". Every surface renders a title as text.
- **Open and pending facts always carry their time.** An `open` PR, a `closed` PR (which can be reopened) and a `pending` CI read are shown as "open as of 10:02" or "CI pending as of 10:02", fresh or not. Past `policy.board.forgeStaleMinutes` (default 15) the card adds "may have changed". Only merge records are shown without the time of a read, since they cannot change.
- When a PR the previous observation saw open is now merged or closed, the card says so: "merged at <time>" or "closed without merge as of <time>" (today's "this PR is no longer open").
- **Who runs it (D5).** The orchestrator on demand, and the conductor driver every 10 minutes once K7 runs (lane WB7c). A process that runs `forge sync` holds forge credentials; the board and the web never do.

**PR to lane links (D4).** A PR counts for a lane only through a recorded, unique link (§3.2). Titles such as "feat(installation): … (AM1)" are never read as links. A merged PR with no link is a Done card "no lane recorded", which is also how repositories without lanes show their owner-merged PRs; linking it later moves the merge onto the lane and removes that card.

**The window (D6) filters display only.** Done shows merges whose `mergedAtIso` is within `policy.board.doneWindowDays` (default 14), `--since` for more. A lane outside the window is still Done: it is hidden from the Done list, never moved to another column, and every guard that depends on it reads it as Done.

### 3.5 In flight: the step, honestly

The step is derived, in this order:
1. **A lane run (after K3, lane WB11):** the conductor state and round: `running` on the first-pass role, `fixing` round 2 on the second-pass role, `code-review` with the latest receipt "1 major", `watching-ci`, `awaiting-premerge`, `parked: <reason>`, `stopping` with its wait reason (conductor §3.9), `stopped` ("run stopped, not merged"). The seat is the role's recorded seat, and a seat switch reads from `stopReason` ("fix round on the next seat after the second-pass seat failed: timeout").
2. **An attempt with no run (today):** a live attempt shows `kind` and `fixNumber` ("fix round 1"), `seatSelection.role`, runner model and state. An ended or collected attempt whose linked PR is closed shows **"PR closed without merge"** (checked first). An ended or collected attempt with no open or closed linked PR shows **"between steps"**. Both carry the latest receipts at the attempt's head through the existing acceptance-evidence read ("review: 1 major, 2 minor") and the "PR #n closed as of <time>" badge where it applies.
3. **A linked PR:** "PR #n open as of <time>, CI <state> as of <time>"; "PR #n closed without merge as of <time>"; "linked PR #n: merge not yet observed".
4. **A declaration (D3).** Lanes run by hand outside `attempt dispatch` leave no record. Until the conductor runs them, the orchestrator may declare one: `plan declare <planId>/<laneId> --step <first-pass | gate | brief-check | code-review | fix-round | pre-merge | ci | other> --seat-role <role> --model <id>`. A declaration is shown as **declared, not observed**, with its time. After `policy.board.declarationTtlMinutes` (default 90, two lane sizes) it lapses to **"state unknown (declaration lapsed)"**: the lane stays In flight, never Queued, because it has started. A declaration never clears any guard and never moves a lane to Done.
5. **Dropped after start:** a lane marked `dropped` that has started and is not Done shows "dropped in plan; started work not merged".

### 3.6 Queued: `waitsOn`, computed, never typed

For each lane that has never started, a pure function computes the reasons it cannot start. Each reason is typed (`WaitReason`), and each guard evaluates to `clear`, `blocked` or `unknown`:

| Reason | Blocked when | Unknown when |
|---|---|---|
Every guard follows the rule of §3.7: `blocked` whenever the records already read block it, with any unread source named beside it; `unknown` only when nothing read blocks it and an unread source could change the answer; `clear` only when every source it depends on was read and nothing blocks it.

| Reason | Blocked when | Unknown when |
|---|---|---|
| `after-not-done` | A lane in `after` has no merge record and no `merged` work order; names them. With the forge unread, the card says "predecessor not recorded merged; forge not read since <time>". It is never `unknown` for an unread forge | The merge-record or work-order store could not be read, and nothing read blocks it |
| `after-unresolved` | A referenced plan is not imported; names the reference ("predecessor plan not imported") | — |
| `after-dropped` | A lane in `after` is `dropped`; names it, until the dependant's `after` is edited | — |
| `package-occupied` | An In flight lane with a recorded attempt or run, or a live declaration, shares a package; names it | Nothing read blocks it and: an In flight work order without a plan has `ownedPaths` that map to no package ("package unknown"); or a lapsed declaration names the package ("declared lane lapsed; package may still be in use") until it is renewed, withdrawn or replaced by a recorded attempt; or the attempt or run store could not be read |
| `shared-file-held` | An In flight lane lists one of its `sharedFiles`; names the file and the lane | Nothing read blocks it and the attempt, run or plan store could not be read |
| `exclusive-order` | An earlier lane in the plan's `exclusiveOrder` for that file has no merge record and no `merged` work order (a dropped one reads as `after-dropped`) | As `after-not-done` |
| `owner-decision` | A gating owner item on the lane is open (§3.3), or a decision in the lane's `decisions` is open in the plan | Nothing read blocks it and the owner-items read failed |
| `project-lane-cap` | In flight lanes of the project with a recorded attempt or run, or a live declaration, reach the profile's `maxConcurrentLanes`; lapsed declarations do not count | Nothing read blocks it and the profile, attempt or run store could not be read |
| `capacity` | Held reservations reach the installation's slot budget on every eligible host | Nothing read blocks it and reservations or the installation could not be read |
| `seat` | — (no seat health is recorded yet) | Always, until a recorded seat probe exists (A-S, S1); shown as "seat not checked", never as blocked or clear |
| `brief` | No successful brief read is recorded and no attempt records a `briefDigest`. A failed last read is named beside it ("brief not recorded; last read failed at <time>") | — |

- **Ready** means every guard is `clear`. A lane with only `unknown` guards left is "not known to be ready", naming each unknown guard. Because the seat guard is unknown until a seat probe is recorded, no lane reads "ready" in v1; the board instead lists **"nothing blocks it but unchecked guards"**, which is today's "K2 is the only free lane right now", stated as what it is. A lane with any `blocked` guard is never on that list.
- `package-occupied` is derived from planned `packages` and, for work orders without a plan, from `ownedPaths` by the workspace prefix (`packages/<name>/`, `apps/<name>/`). An In flight lane with a recorded attempt or run holds its package, including one between steps, since its worktree is still taken. A live declaration holds its package. A lapsed declaration holds neither a package nor a project slot; it makes that package's guard `unknown` instead, as the table says.
- Every reason names the record it came from, so a card can say "waits on K1b (in flight, run r_…)" and link to it.
- **The brief guard reads the brief itself, never a declaration.** `brief` is `frozen` when an attempt records a `briefDigest`. Before that, `fleet-v2 plan brief-check <planId>/<laneId>` reads the file at the sidecar's `brief` path in the lane's local worktree and records a brief read `{ path, sha256, bytes, readAtIso }`; the guard is clear while that read is present, and the card shows its digest and "as of <time>". The board never reads a worktree itself.

### 3.7 Freshness and honesty

- **Every fact has a source and a read time.** The read model returns, per source (plans, work orders, attempts, runs, reservations, owner items, questions, attention, project profiles, merge records, forge observation per repository, brief reads), `{ source, readAtIso, status: read | not-read, reason? }`. Cards reference the sources they used.
- **Not read is never empty.** A store that cannot be read (a quarantined state file, E1b) or a forge observation that is `unavailable` makes every card that depends on it show "not read: <source>". A column is never shown empty because its source failed; it shows "<source> not read" instead of "nothing queued".
- **Blocked by records beats unknown.** A guard is `blocked` whenever the records already read block it, whatever else is unread; the unread source is named beside the reason ("predecessor not recorded merged; forge not read since <time>"). An unread source never turns such a guard into `unknown`, even when the fact it would supply could clear it. A guard is `unknown` only when nothing read blocks it and an unread source could change the answer, and `clear` only when every source it depends on was read. This is how every guard in §3.6 is evaluated.
- **Changeable facts carry their time.** Open PRs, CI states, closed PRs, declarations and brief reads always show "as of <time>"; past their threshold they add "may have changed" or lapse (§3.4, §3.5). Merge records need no age: they cannot change back.
- **The board never fills a gap.** No step, seat, PR, merger or reason is guessed from a lane id, a branch name, a title or a journal's free text. A gap is shown as one.

### 3.8 Cross-project

The board spans every `active` project profile (onboarding P1). Each profile contributes its plans, work orders, owner items, merge records and one forge observation of its repository. A repository not in the registry is not read; the board footer says how many projects it read and that others are not shown, with the `projects add` or `projects adopt` command. A project with no plans still shows Done (its merges, "no lane recorded") and Waiting (its owner items). Filters narrow by project; the default is all.

### 3.9 Place in the hexagon (design question 8)

The board is a **read model in `work-execution`**, which already depends on `operator-coordination` and `evidence-and-acceptance` through consumer-side ports. A board context would read all four and own no rule (the conductor plan's D1 reasoning). The manifest's dependency direction is unchanged: `OwnerItem` stays in `operator-coordination`, and work-execution reaches it through consumer-side ports.

| Piece | Context, layer | New or existing |
|---|---|---|
| `LanePlan` aggregate, `PlannedLane` child (aliases, status), `PullRequestLink`, sidecar validation, the cross-plan cycle check | work-execution, domain | New |
| `MergeRecord`, `ForgeObservation`, brief-read records | work-execution, domain | New |
| `deriveWorkBoard(facts, nowIso, boardPolicy)`: started, columns, badges, identity rule, `WaitReason`, readiness, freshness | work-execution, domain (`work-board.ts`) | New, pure, never throws |
| `planRef` on `WorkOrderRecord`; `--plan`, `--lane` on registration | work-execution, domain and application | Changed, optional field |
| Typed `pullRequest { repository, number }` on forge journal entries; the fleet merge path writes the `PullRequestLink`, then its `MergeRecord` | work-execution, domain and `ExecuteAuthorizedForgeActionUseCase` | Changed (WB5b) |
| `ImportLanePlanUseCase`, `LinkPullRequestUseCase`, `DeclareLaneActivityUseCase`, `RecordBriefReadUseCase` | work-execution, application | New |
| `RecordForgeObservationUseCase` (writes merge records on first sight) | work-execution, application | New |
| `ReadWorkBoardUseCase` (`ReadWorkBoardPort` in-port) | work-execution, application | New |
| `LanePlanRepositoryPort`, `MergeRecordRepositoryPort` (create-if-absent for the merge fact; the only update is `merger` from `unknown` to `fleet`; no delete), `ForgeObservationRepositoryPort` (file and memory stores, CAS, signals `plan`, `merge`, `forge-observation`) | work-execution, out-ports and infrastructure | New |
| Forge list read | work-execution infrastructure, on AM4b's PR-state read port | Changed (AM4b's port gains a list method) |
| `OwnerItemsReadPort` (consumer side) → `ListOwnerItems`, `ListOwnerQuestions`, `ReadProjectAttention` | work-execution out-port; adapter delegates to operator-coordination in-ports | New port, existing suppliers plus one new |
| `OwnerItemsWritePort` (consumer side, for `plan import`'s decisions and, later, K6 and AM4a merges) → `RecordOwnerItem`, `ResolveOwnerItem` | work-execution out-port → operator-coordination | New |
| `ProjectProfileReadPort` gains `listActiveProfiles()` → `ListProjectProfilesPort` | work-execution out-port | Changed |
| `OwnerItem` aggregate; `RecordOwnerItem`, `ResolveOwnerItem` (typed per kind, §3.3), `ListOwnerItems` use cases; `OwnerItemRepositoryPort` (signal `owner-item`) | operator-coordination | New |
| Attempts, journal, reservations, work orders | work-execution's existing repository ports | Existing |
| Lane runs | K3's `LaneRunRepositoryPort` | Planned (K3) |
| Review finding counts at a head | `AcceptanceEvidencePort` → `InspectAcceptanceEvidence` | Existing |
| Slot budget, thresholds | The composition root passes the installation's host budget and `policy.board` as plain input (the free-seat plan's structural-subset pattern) | `policy.board` new in `installation` |

Manifest entries: the new aggregates and children, `MergeRecord`, `ForgeObservation`, the use cases and their in-ports, the out-ports and their adapters with `delegates_to` for the consumer-side ports, the `WaitReason` and `OwnerItemKind` enums, and these invariants: "A planned lane grants nothing and owns no path until registered"; "Done requires a merge record; a merge fact is never replaced, and `merger` only moves from `unknown` to `fleet`"; "A PR links to at most one lane"; "An unknown guard is never ready; a declaration clears no guard"; "An owner item grants nothing; a merge item is closed only by an observed merge or close, a decision item only by a recorded choice or the plan".

### 3.10 Terminal: `fleet-v2 board` first (design question 6)

- **`fleet-v2 board [--project <id>] [--column done|in-flight|queued|waiting] [--plan <id>] [--package <name>] [--tier 0|1|2] [--since <date>] [--json]`.** A command of its own, like `doctor`, whose `--json` selects output (one JSON document, the read model as served) rather than a payload. Table output: four sections, one row per card with its badges, a header line per source with its read time. Exit codes per `AGENTS.md`: `0` every source read; `1` the board printed but at least one source was not read (an unknown); `2` usage error.
- **`fleet-v2 board lane <planId>/<laneId>`** prints one card in full, with its reasons, badges and sources.
- **Writes** live in their own groups and confirm like `projects` does: `plan import|check|link-pr|declare|brief-check|list`, `owner-items add|resolve|withdraw|list` (withdraw refused for `merge` and `decision`), `forge sync`.
- **`fleet-v2 board --watch` (D7).** Re-renders on change. With the local state directory (the default), it watches the store files in-process, as E3a-2's watcher does, and needs no token. With `--api <url>` (a board of another installation), it reads `/v1/changes` and only after T3a's `read` scope; it composes read adapters only, never the forge adapter (a test asserts it), so conductor D9 is not engaged. It never runs `forge sync` itself; forge facts show their time.
- **A full-screen TUI (D8): not a separate program.** The board becomes one screen of the shared `fleet-v2 tui` shell (onboarding P9, orchestrator T8a), once that shell exists, using the same read model. Until then `board --watch` is the terminal view.
- All output is written at the CLI boundary; package code returns records and never logs.

### 3.11 Web: `/board` (design question 5)

- **Read first.** `GET /v1/board` (filters as query parameters) serves the read model; `/board` renders it server side, with the labelled fixture fallback `/lanes` uses. It joins the sidebar's views and links each card to `/attempt`, `/work-order`, `/questions` and, after W7a, the run board.
- **Layout.** Four columns on a wide screen, each with its count. Below 720 px, four tabs with counts, one column at a time; the chosen tab is a view control and stays immediate. Filters: project, plan, package, tier; "the filter hides N" is distinct from "nothing here" (web plan §6).
- **Text.** Subjects, titles and scopes render as plain text: no markdown, no autolinks; the only links are fleet-v2's own ids.
- **States** reuse the web plan's vocabulary: empty, error, unconfigured, unknown, offline. A not-read source shows on the header and on each affected card. Each card shows the state word and an icon, never colour alone; badges have a word each.
- **Refresh.** Signals `plan`, `owner-item`, `merge`, `forge-observation` join the feed's data kinds; the web re-reads `/v1/board` on any signal (E3c), and polls a visible tab every 30 s until then.
- **Actions come later and go through existing routes only (D9).**
  - **Dispatch a queued lane:** only when the lane has a registered work order. The button writes the request channel's `start-lane-run` (O2c, O9) or `dispatch-attempt` for a prepared attempt (O8's card, its AlertBox body and its refusals). The board's own "ready" never enables it alone: the button needs an eligible attached orchestrator, as O8 states. Promoting a planned lane to a work order stays a CLI step, shown as the command to copy.
  - **Resolve an owner item:** a direct route `POST /v1/owner-items/:id/resolution` under T3a's `operate` scope after T6, behind `AlertBox`: "records that you did <kind>: <subject>; does not merge, create a secret or take a backup; the item leaves Waiting". Only for `secret`, `backup` and `other`; the route refuses `merge` and `decision`.
  - **Never from the board:** forge actions, one-way doors, plan imports, withdrawing a merge or decision item, secret values.

### 3.12 Telemetry (design question 7)

Later lanes (WB12a–c) add a lane detail: every attempt in order with its role, seat, model, `stopReason`, usage and cost (estimates labelled for plan-billed seats, as W10 does), and every review round at each head: reviewer, kind (after RW1), finding counts by severity, and how many the next round fixed. It is read from attempts and evidence records, never from an orchestrator's notes, and it is what the orchestrator now keeps by hand per lane. Seat totals across lanes (which seat stops most often, which reviewer finds most) are a later question, not this plan.

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. One lane per package at a time; no two lanes on one shared file (`.architecture/manifest.yaml`, `apps/cli/src/composition.ts`, `apps/cli/src/index.ts`, `apps/api` wiring and `change-feed.ts`, `apps/web` shell). Manifest lanes join the existing manifest queue (conductor K1-1, K10, K11a; web plan A-J → … → A-F) one at a time, rebased; within this plan they run **WB1b → WB3a → WB3b → WB4a → WB5a → WB5c → WB6**. Lanes in `work-execution` queue behind the conductor's own `work-execution` lanes, and run one at a time in the order of the table.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| WB0 | This plan and the owner's decisions (§6) | docs | 0 | — |
| **Step 1. Records (WB1a–c ‖ WB3a, then WB2a ‖ WB3b)** | | | | |
| WB1a | Sidecar `schemaVersion: 1` validation into a typed, normalized sidecar (unknown fields, plain-text caps, secret patterns, unique ids, `after` forms, `renamedFrom`, `mergedPr`, `brief`, `exclusiveOrder`) and its canonical JSON; `planRef { projectId, planId, laneId }` on `WorkOrderRecord` (optional, read-compatible) | work-execution (domain); sync barrel | 2 | WB0 |
| WB1b | `LanePlan` record keyed `(projectId, planId)`, `PlannedLane` child (status, aliases), `PullRequestLink` and the one-lane-per-PR decision | work-execution (domain), **manifest**; sync barrels | 2 | WB1a; manifest queue |
| WB1c | The pure cycle check over a set of plans (`after` and `exclusiveOrder` edges, aliases resolved) | work-execution (domain); sync barrel | 2 | WB1a |
| WB3a | `OwnerItem` record, kinds, typed refs, gating rule, resolution and withdraw rules per kind (§3.3), plain-text subject; file and memory stores with CAS and the `owner-item` signal | operator-coordination (domain, infra), **manifest** | 2 | WB0 (D1, D11); after WB1b on the manifest |
| WB2a | `deriveWorkBoard`: "started", column precedence, badges (closed PR, link conflict, merge integrity), the identity rule for items and questions (an item gating several lanes is the reason on each), Done from merge records with the display window, In flight steps (§3.5: closed PR before between steps, stopped run, lapsed declaration, dropped after start), Waiting with the lane's other `waitsOn` as badges, freshness and not-read rules; one test per rule of §3.1, §3.5, §3.7 | work-execution (domain `work-board.ts`) | 2 | WB1b, WB1c |
| WB3b | `RecordOwnerItem`, `ResolveOwnerItem` (closes `decision` only on a recorded choice; refuses owner resolution and withdraw of `merge` and `decision`; reopens a `pr-closed` merge item only on a forge observation of `open`, keeping both history entries), `ListOwnerItems` (one entry per item id) | operator-coordination (application), **manifest** | 2 | WB3a |
| **Step 2. Stores and reads (work-execution lanes in this order)** | | | | |
| WB2b | `waitsOn`: every `WaitReason` of §3.6 including `after-unresolved` and `after-dropped`, guard values under §3.7's "blocked by records beats unknown" rule, lapsed declarations making the package guard `unknown`, readiness, "nothing blocks it but unchecked guards"; one test per row | work-execution (domain `work-board.ts`) | 2 | WB2a |
| WB-S | Sidecars for the conductor, web UI interactivity, auto-merge and this plan, with `mergedPr` for lanes already merged; `plan check` run by hand | docs | 0 | WB1a (schema) |
| WB4a | `LanePlanRepositoryPort`, file and memory stores, `plan` signal; `ImportLanePlanUseCase`: project match, revision rule, digest idempotency, the cycle check across every stored plan, dropped rows kept; registration's `--plan`/`--lane`, project taken from the work order and a mismatch refused | work-execution (application, infra), **manifest** | 2 | WB2b (same package), WB3b (manifest) |
| WB4b | Renames (`renamedFrom` moves links, `planRef`s and declarations; aliases resolve); `LinkPullRequestUseCase` with the one-lane-per-PR refusal; `mergedPr` backfill as links | work-execution (application, infra) | 2 | WB4a |
| WB4c | Decisions to owner items through `OwnerItemsWritePort` (open, `plan-decided`, `decision-removed`); `DeclareLaneActivityUseCase` with its TTL; `RecordBriefReadUseCase` and its store | work-execution (application, infra) | 2 | WB4b, WB3b |
| WB5a | `MergeRecord` and its store (`merge` signal): the merge fact create-if-absent, the one-way `merger` upgrade from `unknown` to `fleet`, a differing later read kept out of the record and reported as a merge-integrity finding; tests for each | work-execution (domain, infra), **manifest** | 2 | WB4c (same package) |
| WB5b | The fleet merge path: typed `pullRequest { repository, number }` on forge journal entries; then the `PullRequestLink`, then the merge record (`merger: fleet`); on `pr-already-linked` the merge record is still written and the conflict is recorded for the badge; tests for both orders against `forge sync` | work-execution (domain `execution-records.ts`, application `ExecuteAuthorizedForgeActionUseCase`) | 2 | WB5a; before AM4a or K6 merges, or they gain it as a follow-up |
| WB5c | `ForgeObservation` record and store; `listPullRequests` on AM4b's forge-read port with recorded `gh` outputs; linked PRs read by number beyond the window; `RecordForgeObservationUseCase` writing merge records on first sight and reopening `pr-closed` merge items on a later `open`; title rules | work-execution (domain, application, infra), **manifest** | 2 | AM4b, WB5b |
| WB6 | `ReadWorkBoardUseCase`: gathers every source with its read status, `OwnerItemsReadPort` and `listActiveProfiles` adapters, review counts through `AcceptanceEvidencePort`, `policy.board` as input | work-execution (application, infra), **manifest** | 2 | WB5c, WB2b |
| WB6p | `policy.board` (`forgeStaleMinutes`, `declarationTtlMinutes`, `doneWindowDays`, `forgeSyncMinutes`) | installation | 1 | — (one lane at a time in installation: after K2) |
| **Step 3. Terminal (one at a time on `index.ts` and `composition.ts`, with K7, AM5, O5, K11b)** | | | | |
| WB7a | `plan import\|check\|link-pr\|declare\|brief-check\|list`, `owner-items add\|resolve\|withdraw\|list`, confirmations, exit codes | apps/cli, **`index.ts`, `composition.ts`** | 2 | WB4c, WB3b |
| WB7b | `forge sync [--pr]`; `board` and `board lane` (table with badges, `--json`), exit codes; a test that `board` composes no forge adapter | apps/cli, **`index.ts`, `composition.ts`** | 2 | WB7a, WB6, WB6p |
| WB7c | The conductor driver runs `forge sync` every `policy.board.forgeSyncMinutes` (default 10), journalled; skipped while halted | apps/cli, **`index.ts`, `composition.ts`** | 2 | WB7b, K7; in sequence with K11b |
| WB10 | `board --watch` over the local state-file watcher; `--api` with `/v1/changes` behind T3a's `read` scope | apps/cli | 1 | WB7b; the `--api` half after T3a, E3b |
| **Step 4. Web (in the `apps/web` queue)** | | | | |
| WB8 | `GET /v1/board`, `GET /v1/plans`, `GET /v1/owner-items`; feed kinds `plan`, `owner-item`, `merge`, `forge-observation` in `DATA_KINDS` | apps/api (`work/` and `operator/` composition, **`change-feed.ts`**, **`runtime.ts`**) | 2 | WB6, WB3b; in sequence with O3, L3, A-R, A-C |
| WB9a | `/board` read: four columns, cards with badges, sources header, not-read, "as of" and stale states, plain-text rendering, links; sidebar entry | apps/web, **`view-nav.tsx`** | 2 | WB8; after the `apps/web` lane running at the time |
| WB9b | Filters (project, plan, package, tier), the 720 px tab layout, "the filter hides N", visible-tab poll; E3c signals when served | apps/web | 1 | WB9a |
| **Step 5. With the conductor** | | | | |
| WB11 | In flight from lane runs: state, round, seat per role, park reasons, `stopping`, `stopped`; parks and attention as badges; PR links from `prNumber`; K6's owner-merge item through `OwnerItemsWritePort` if K6 has merged without it | work-execution (application) | 2 | K3, K1-2c, WB6 |
| WB12a | Lane history read model: attempts in order with seat, `stopReason`, usage; review rounds per head with finding counts | work-execution (application) | 2 | WB11, RW1 |
| WB12b | `board lane` prints the history | apps/cli (**`index.ts`**) | 1 | WB12a, WB7b; in sequence with the other `index.ts` lanes |
| WB12c | Lane history drawer on `/board` | apps/web | 2 | WB12a, WB9b |
| **Step 6. Actions (after the write path)** | | | | |
| WB13a | `POST /v1/owner-items/:id/resolution` under `operate`; refuses `merge` and `decision` kinds | apps/api, **`security.ts`**, `composition.ts` | 2 | T6, WB8 |
| WB13b | Board actions: resolve behind `AlertBox`; dispatch through O8's request card for registered lanes; copyable `work-order register --plan` for planned ones | apps/web, packages/ui | 2 | WB13a, O8, O9, WB9b |
| WB14 | Board screen in the shared `fleet-v2 tui` shell | apps/cli | 2 | P9 or T8a, WB7b. D8 decided: a screen in the shared shell once P9 or T8a has built it; no separate TUI program |

WB1b and WB3a can run in parallel across packages but both edit the manifest, so they merge in order, rebased. WB1 is three lanes so each stays near 45 minutes: WB1a (sidecar validation and `planRef`), WB1b (the stored records; the only part that edits the manifest) and WB1c (the cycle check); WB1c needs only WB1a, so it may run while WB1b waits for the manifest queue. WB2a and WB3b run side by side (different packages; WB2a does not touch the manifest). WB12 is split because a read model, a CLI printer and a web drawer are three packages, two of them behind shared files; each part fits one lane. WB5 is three lanes because the merge record's rules, the fleet merge path's link-then-merge write and the forge read are each about 45 minutes; WB5b adds no manifest entry (its ports are declared by WB4a and WB5a). WB5b changes `ExecuteAuthorizedForgeActionUseCase`, which AM4a and K6 build on; whichever lands second rebases, and its brief says so. WB5c is the first lane after AM4b that touches the forge adapter; its brief states that AM4b's port and recorded outputs are on `main`. WB-S can run beside any lane.

## 5. Hard to undo

- **The sidecar schema (`schemaVersion: 1`)** becomes a file format in several repositories; a change needs a new version and an importer for the old one.
- **Stored records:** `LanePlan`, `PullRequestLink`, `OwnerItem`, `ForgeObservation`, brief reads and the `planRef` field on work orders. Version them from their first commit.
- **`MergeRecord` keeps its first merge fact.** `mergedAtIso` and `headSha` are never replaced or removed; a later read that differs raises one integrity attention item and leaves the record as it was, so a wrong first read could only be answered by a new record type. The single permitted change is `merger` from `unknown` to `fleet`, made only from the fleet path's typed journal entry, never the reverse. The store enforces both rules from its first commit.
- **A PR's link to a lane is unique.** Correcting a wrong link needs an explicit relink command (not in v1); refusing a second link is the safer default.
- **Wire contracts:** the `/v1/board` read model, `WaitReason` and `OwnerItemKind` values, the resolution kinds, and the feed kinds `plan`, `owner-item`, `merge`, `forge-observation` become what the web, the TUI and scripts depend on.
- **Forge reads** are read-only, but they put PR titles and states of every registered repository into the state directory; a public deployment of the web would show them. The API stays loopback-bound as `AGENTS.md` states.
- Everything in `apps/web` and the table layout of `board` is two-way.
- No one-way door: the board merges, pushes and dispatches nothing.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Owner to-dos: a new record, or reuse owner questions or AM3b attention? | **Decided (owner, 2026-10-27).** **A new `OwnerItem` in `operator-coordination`** (merge, secret, decision, backup, other): the one wait the board computes from. Questions fold into it by one identity rule; attention notices and parks are badges (§3.1, §3.3) |
| D2 | How do workbook rows become records? | **Decided (owner, 2026-10-27).** **A JSON sidecar per plan, imported by `fleet-v2 plan import`,** keyed `(projectId, planId)` with an increasing revision and a cross-plan cycle check; `plan check` warns on drift from the markdown table; no markdown parsing as a source |
| D3 | May an orchestrator declare a hand-run lane in flight? | **Yes, typed (step enum, seat role, model), shown as "declared, not observed", lapsing after 90 minutes to "state unknown" in In flight;** it clears no guard |
| D4 | How is a PR tied to a lane? | **Only by a recorded link, unique per PR:** fleet's merge path (typed journal entry and link, WB5b), the run's `prNumber`, a sidecar `mergedPr`, or `plan link-pr`. No title, branch or free-text parsing; unlinked merges show "no lane recorded" |
| D5 | Who reads the forge, and how often? | **`forge sync` on demand; the conductor driver every 10 minutes once K7 runs (WB7c).** The board and the web never call the forge |
| D6 | How far back does Done go? | **14 days on display** (`policy.board.doneWindowDays`), `--since` for more. The window never removes a merge record or changes a lane's column |
| D7 | What drives `board --watch`? | **The local state-file watcher;** `/v1/changes` only for `--api` and only after T3a's `read` scope |
| D8 | Is a full-screen TUI worth building for the board? | **Decided (owner, 2026-10-27).** **Not on its own.** A Board screen in the shared `fleet-v2 tui` shell (onboarding P9, orchestrator T8a; Ink per onboarding D3) when that shell exists; `board --watch` until then |
| D9 | Which board actions, and through what? | **Decided (owner, 2026-10-27).** **Read-only first.** Then dispatch only through the request channel's existing kinds for a registered lane, and owner-item resolve as a direct route under `operate` after T6, never for `merge` or `decision`. Promotion of a planned lane stays in the CLI |
| D10 | Where does a plan's sidecar live? | **In the repository that holds the plan;** `plan import` reads a local file and never fetches from a forge, so private plans stay private |
| D11 | May the owner withdraw a `merge` or `decision` item? | **No.** A merge item ends on an observed merge or close; a decision item on a recorded choice or the plan's `decided` or removed row. `secret`, `backup` and `other` may be withdrawn with a typed reason the board shows |
| D12 | What does a dropped dependency do to its dependants? | **Blocks them with `after-dropped`, naming it,** until the dependant's `after` is edited. It is never read as Done |

D1, D2, D8 and D9 were decided by the owner on 2026-10-27, each as recommended. The others are the recommended defaults and stay open.

## 7. Assumptions

- Lane ids are unique within a plan, and plan ids within a project; elsewhere a lane is named by its full reference.
- Authors bump `revision` and keep the sidecar current when they amend a plan. If they do not, `plan check` reports the drift and the board shows the sidecar's state, which may lag the prose; a forgotten bump is refused, not silently applied.
- The forge read used by AM4b can list PRs for a repository within a time window and read one PR by number; if the forge limits either, `forge sync` records `unavailable` for that repository and its cards show "not read". Merge records already written stay.
- A PR number identifies one PR within a repository, and a merged PR stays merged.
- One installation and one state directory see every registered project, as the conductor plan assumes.
- Orchestrators record links and declarations. A lane run by hand with neither shows as Queued, which is visible and correctable, not silent; once anything is recorded, it never returns to Queued.
- Every fleet merge goes through `ExecuteAuthorizedForgeActionUseCase`. A merge made any other way reads `merger: unknown`, which is honest, not wrong.
- No seat probe is recorded in v1, so the seat guard stays `unknown` and no lane reads "ready" until A-S or S1 records one.
- The brief file is readable from the machine that runs `plan brief-check`; if not, the brief guard is `unknown`.
- The state directory and the web stay private to the operator; PR titles shown on the board are the owner's own.

## 8. Review

**Grok 4.7, rev 0 (2026-10-27): six blockers, two majors, one minor; all applied in rev 1.**
1. Blocker: an ended attempt or a closed PR fell back to Queued. A lane that has started never returns to Queued; In flight covers "between steps", "PR closed without merge", "run stopped" and "state unknown (declaration lapsed)" (§3.1, §3.5).
2. Blocker: Done depended on the latest windowed snapshot. `MergeRecord` keyed `(repository, number)` is written on first sight and never replaced; the 14-day window filters display only (§3.4, D6).
3. Blocker: one column hid the other facts, and owner items folded onto Done lanes vanished. Badges carry every other fact; Waiting wins the column only for gating items; one identity rule covers items and questions; an item naming a Done lane keeps its own Waiting card (§3.1).
4. Blocker: `mergedByFleet` had no key. WB5a adds a typed PR number to forge journal entries and has the fleet merge path write its merge record; every other merge reads `merger: unknown` (§3.4).
5. Blocker: no backfill, duplicate links, renames as drop plus add. Sidecar `mergedPr` and `plan link-pr` backfill; a PR links to at most one lane; `renamedFrom` carries links and `planRef`s (§3.2).
6. Blocker: attention, owner items and parks could disagree. The owner item is the one wait; one merge is one item; attention and parks are badges; `merge` and `decision` items cannot be withdrawn (§3.3, D11).
7. Major: import keys, cycles, dropped lanes, removed decisions, rollbacks. Plans keyed `(projectId, planId)` with a matching `--project`; the cycle check spans every stored plan; `after-dropped` blocks visibly; a removed decision withdraws its item as `decision-removed`; the revision must increase (§3.2, D12).
8. Major: declarations cleared the brief guard, and the 10-minute sync had no lane. A declaration clears no guard; the brief guard reads the brief file (`plan brief-check`); a lapsed declaration stays In flight; WB7c runs the driver's sync; open and pending reads always carry "as of" (§3.4–§3.6).
9. Minor: the manifest order line now includes WB3b (and WB5a, WB5b); WB12 is split by package; a `decision` closes only on a recorded choice, not on `acknowledged`; subjects and titles are bounded single-line plain text, refused or withheld when secret-shaped, and rendered as text (§3.3, §3.4, §3.11, §4).

**Grok 4.7, round 2, re-review of rev 1 (2026-10-27): all nine round-1 findings resolved; one blocker, five majors, three minors.** This was the second review round, so the orchestrator decided each resolution (no third round); rev 2 applies exactly those decisions.
1. Blocker: an unreadable forge turned a locally blocked `after-not-done` into `unknown`, so a lane could read "nothing blocks it but unchecked guards". Decided: a guard is `blocked` whenever the records read block it, naming the unread source; `unknown` only when nothing read blocks it. Stated as the general rule in §3.7 and applied to every guard in §3.6 (`after-unresolved` and a failed brief read are now `blocked`).
2. Major: a closed linked PR vanished behind "between steps". Decided: a closed linked PR is a badge, and "PR closed without merge" is checked before "between steps" (§3.1, §3.5).
3. Major: a fleet merge made two Done cards, since nothing wrote its link. Decided: the fleet merge path writes the `PullRequestLink`, then the merge record; on `pr-already-linked` the merge record is still written and an attention badge names the conflict (§3.4, WB5b).
4. Major: a merge record first seen by `forge sync` froze `merger: unknown`. Decided: the merge fact is create-if-absent, a differing later read keeps the first and raises one integrity attention item, and `merger` moves once from `unknown` to `fleet`, only from the typed journal entry, never back (§3.4, §5, WB5a).
5. Major: a reopened PR left its merge item closed. Decided: a `pr-closed` merge item returns to `open` on a later forge observation of the PR `open`, only from a forge observation, same key, both entries kept (§3.3, WB3b, WB5c).
6. Major: a lapsed declaration held a package and a project slot indefinitely. Decided: it holds neither; it makes that package's guard `unknown` until renewed, withdrawn or replaced by a recorded attempt; a live declaration still counts (§3.6).
7. Minor: `planRef` lacked the project. Decided: `planRef { projectId, planId, laneId }`; registration takes the project from the work order and refuses a mismatch (§3.2, WB1, WB4a).
8. Minor: a lane moving from Queued to Waiting lost its other waits. Decided: the Waiting card shows the lane's other blocked and unknown `waitsOn` guards as badges (§3.1).
9. Minor: "exactly one entry" was ambiguous for an item gating several lanes. Decided: such an item is the Waiting reason on each gated lane's card and appears once in the owner-items list, deduplicated by item id (§3.1).

The fleet merge path's growth split WB5 into WB5a (merge record rules), WB5b (fleet path: typed journal field, link, merge record) and WB5c (forge observation, formerly WB5b); round 1's references to WB5a's fleet path now live in WB5b.

## Challenge this

Whether `PlannedLane` should exist at all. The plan keeps planned lanes out of work orders because registration refuses overlapping owned paths, and two queued lanes in one package always overlap. The other path is to move that ownership check from registration to dispatch and let every planned lane be an `approved` work order, which removes a record type, the `planRef` link and the alias logic of renames. A reviewer should test whether the ownership guarantee survives that move (a check at dispatch under the journal lock, beside the busy-worktree check), and whether an `approved` work order that may never run would mislead any existing reader.

A second candidate: whether badges plus one column is legible. Rev 1 keeps one card per lane and puts every other fact on badges so nothing is hidden. A card in Waiting with a running attempt, an open PR and a park can carry four badges; a reviewer should check at phone width whether the owner still sees at a glance why the lane is where it is.

A third: whether a sidecar per plan will be maintained. The owner's table was right because a person assembled it the same day. A sidecar edited only at plan time will drift as plans are amended. `plan check` and the revision rule report drift but do not prevent it; a reviewer should ask whether the sidecar should be the plan's only workbook, with the markdown table generated from it.
