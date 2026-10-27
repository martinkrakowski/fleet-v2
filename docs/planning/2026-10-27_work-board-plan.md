# Plan: the work board — Done, In flight, Queued and Waiting, kept by fleet-v2

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 0, draft for review. Not reviewed. Decisions in §6 are open with recommended defaults. Nothing built. Anchors checked against `main` at `258b1b4`.
- **Owner request (2026-10-27):** "The table that you just rendered contains highly useful data that I would want surfaced and maintained within the UI and TUI. (Done, In-flight, Queued, blocked/waiting). Write it up as a plan." The table was assembled by hand from pull-request lists, lane worktrees, briefs, a follow-up list and the plans' workbooks.
- **Builds on:** `2026-10-27_conductor-plan.md` (K1-1 to K1-2c, K1b, K3, K7, §3.2 states, §3.6 park reasons, §3.9 reaper), `2026-10-27_web-ui-interactivity-plan.md` (A-R, A-WO, A-S, W7a, O2c, O8, O9, §3.6 request channel, §6 states), `2026-10-20_auto-merge-policy-plan.md` (AM3b attention store, AM4b PR-state read), `2026-10-24_live-updates-and-state-resilience-plan.md` (`/v1/changes`, E3c, E5), `2026-10-24_project-onboarding-and-config-ui-plan.md` (project registry, P9 TUI shell, its D3), `2026-10-18_orchestrator-interaction-plan.md` (T3a scopes, T6 write path, T8a) and `2026-10-26_execution-order.md` (how lanes are ordered today).

## 1. Goal

One board, kept by fleet-v2 rather than by an orchestrator's memory, that answers four questions for every project in the installation:

1. **Done:** what merged, in which repository, as which lane of which plan.
2. **In flight:** which lane is running, on which seat, at which step.
3. **Queued:** which planned lane has not started, and exactly what it waits on.
4. **Waiting on the owner:** which merges, secrets, decisions and backups only the owner can do.

The same read model feeds `fleet-v2 board` in the terminal and `/board` in the web. Every fact on it says when it was read and from where. A source that could not be read shows "not read"; the board never shows an old fact as current, and never calls a lane ready while one of its guards is unknown.

**Non-goals.** The board grants nothing and dispatches nothing: "ready" is a reading, not a permission, and every dispatch still passes every existing refusal. No model inference: card text is rendered from records. No markdown parsing as a source of truth. No new route around the request channel or the conductor. No credentials, host names or client content on a card.

## 2. What exists (checked on `main`, 2026-10-27)

| Column | What exists | Anchor | Gap for the board |
|---|---|---|---|
| Done | A fleet merge saves the work order `merged`; the PR number is only free text in the journal entry's `detail` | `ExecuteAuthorizedForgeActionUseCase.use-case.ts:223-235`, `:269-280` | Lanes merged by hand or by the owner leave no record. No forge read lists PRs; AM4b's PR-state read (one PR, for A13) is planned, not built. No typed PR number on any record |
| Done | Branch name derived from the lane id | `ExecuteAuthorizedForgeActionUseCase.use-case.ts:220` (`feat/${workOrder.laneId}`) | Hand-run lanes use other branch names; a branch name is not a link |
| In flight | `AttemptRecord`: state, kind and `fixNumber`, `priorAttemptId`, runner (model, agent, variant), `seatSelection` (role, index), `stopReason`, usage | `packages/work-execution/src/domain/execution-records.ts:161-208` | Covers only lanes dispatched through `attempt dispatch`. No "step" beyond attempt state; review findings live in evidence (`GET /v1/heads/:sha/evidence`) |
| In flight | `ListAttemptsUseCase` joins attempts, work orders and held reservations; served as `GET /v1/attempts` | `ListAttemptsUseCase.use-case.ts:99-103` | Read-only and per attempt, not per lane |
| In flight | `LaneRun` (state, round, seat cursors, park) | conductor plan §3.2 | Not on `main`; K1-1 is built and in review on its branch; K1-2a onward and K3's repository are queued |
| Queued | `WorkOrderRecord` has `laneId`, `ownedPaths`, `prerequisiteWorkOrderIds` | `execution-records.ts:51-65` | Registration refuses an owned path that overlaps any active work order (`RegisterWorkOrderUseCase.use-case.ts:97-112`), so two queued lanes on one package cannot both be registered. Nothing records package, shared files, tier, plan or brief readiness |
| Queued | `WorkOrderState` declares nine states | `WorkOrderState.vo.ts:8-18` | Only `approved` (registration, `:133`) and `merged` (forge) are ever written; no use case sets the others, so the state cannot tell queued from in flight |
| Queued | Capacity reservations and the active list | `ExecutionJournalPort.out-port.ts:106` | Nothing says how many slots are free against the installation's budget |
| Queued | Plans' workbook tables (`Lane`, `Scope`, `Package / shared files`, `Tier`, `After`) | `2026-10-27_conductor-plan.md` §4 | Markdown only; dependencies, shared-file exclusivity and the manifest order live in prose and in an orchestrator's private notes |
| Waiting | `OwnerQuestion` with `blocks: [{ kind: plan \| pr \| lane \| work-order, ref }]`; served and shown (Q4) | `packages/operator-coordination/src/domain/owner-question-records.ts:34-38`, `:69` | Covers decisions asked as questions. Not merges, secrets or backups, and not a plan's open `D` rows |
| Waiting | Attention is read from an external service, read-only | `AttentionReadAdapter.adapter.ts:1-15` | AM3b's writable attention store is planned (`2026-10-20_auto-merge-policy-plan.md` A12), not built; its items are machine notices keyed (project, work order, kind) |
| All | Project registry: `ProjectProfileRecord` with `repository`, `maxConcurrentLanes`, `status` | `coordination-records.ts:49-65` | No board spans projects; repositories with no lanes have nothing to show |
| All | `/v1/changes` serves signals for `attempt`, `capacity`, `work-order`, `question`, `profile` | `apps/api/server/routes/v1/changes.get.ts`; kinds at `apps/api/server/wiring/changes/change-feed.ts:7-13`, `:45-51` | No kinds for plans, owner items or forge observations |
| CLI | Command groups `work-order register\|inspect`, `attempt`, `questions`, `projects`, `doctor`, … | `apps/cli/src/index.ts:1810-1850` | No board, plan or list-work-orders command. `--json` is the payload input everywhere except `doctor`, where it selects output (`:1495-1533`) |
| TUI | None. The shared `fleet-v2 tui` shell is planned (onboarding P9, orchestrator T8a; Ink recommended in onboarding D3) | `2026-10-24_project-onboarding-and-config-ui-plan.md:152`, `:206` | No screen |
| Web | `/lanes` (attempts), `/attempt`, `/work-order` timeline (W8a), `/questions` (Q4), `/projects` | `apps/web/src/shell/view-nav.tsx:9-64` | No cross-lane, cross-project view |

Missing: a typed home for planned lanes and their dependencies, a typed home for owner to-dos that are not questions, a recorded forge read, a recorded link between a PR and a lane, and the read model that joins them.

## 3. The shape

### 3.1 One card per lane, four columns, one precedence

The unit is a **lane**: a planned lane from a plan's workbook, or a work order with no plan (registered by hand), or a merged PR with no lane recorded. Each lane appears in exactly one column, by the first rule that matches:

| Column | Rule | Source of truth |
|---|---|---|
| **Done** | A PR linked to the lane is `merged` in the latest forge observation, or its work order is `merged` (a fleet merge, §2) | Forge observation (§3.4) and the work order; never inferred from a title, a branch name or a plan's prose |
| **Waiting on owner** | An open owner item (§3.3) names the lane or its PR, or the lane's run is parked `owner-merge` or `one-way-door` (conductor §3.6) | `OwnerItem`, `OwnerQuestion.blocks`, `LaneRun.parked` |
| **In flight** | A non-terminal attempt or lane run on its work order; or a linked PR that is `open`; or a live declaration (§3.5) | `AttemptRecord`, `LaneRunRecord` (after K3), forge observation |
| **Queued** | A planned lane not dropped, with none of the above | `PlannedLane` (§3.2), with computed `waitsOn` (§3.6) |

Owner items that name no lane (a secret for an infra repository, a backup before a data migration, a plan's open decision) are cards of their own in Waiting. Merged PRs with no recorded lane are cards of their own in Done, marked "no lane recorded".

A card carries the project, plan and lane id, the package, the tier, its facts with their sources and read times (§3.7), and per column:
- **Done:** PR number and repository, merged-at, whether fleet merged it (from the journal) or not, the plan.
- **In flight:** the step (§3.5), the seat (recorded model and role), the round, the attempt or run id, the PR and its CI state when one exists, the latest review receipt's finding counts by severity.
- **Queued:** each `waitsOn` reason with what it names, brief state, and "ready" only when every guard is clear.
- **Waiting:** kind, subject, since when, what resolves it, and what it blocks.

### 3.2 Planned lanes: a sidecar per plan, imported into a typed record

**Recommendation (design question 2): a structured sidecar per plan, imported by the CLI.** Each plan keeps its readable markdown workbook. Beside it sits `<plan>.workbook.json`, the machine copy, and `fleet-v2 plan import <file> --project <id>` records it. Parsing the markdown table is rejected as fragile: the tables mix bold, arrows, group rows and prose in the `After` column (§4 of the conductor plan has "V2 is out of evidence" and "K1-2c, K1b, K3" in one column). Declaring rows one by one with CLI commands is rejected as the same hand work the board is meant to remove, spread over many commands with no reviewable file.

The sidecar, `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "planId": "2026-10-27_conductor",
  "projectId": "<a registered project id>",
  "doc": "docs/planning/2026-10-27_conductor-plan.md",
  "lanes": [
    { "laneId": "K1b", "scope": "Keyed journal …", "packages": ["work-execution"],
      "sharedFiles": [".architecture/manifest.yaml"], "tier": 2,
      "after": ["K1-2a", "2026-10-23_seat-plan/S1a"], "decisions": [], "status": "planned" }
  ],
  "decisions": [
    { "id": "D12", "question": "How long a graceful drain runs …", "default": "45 minutes", "state": "open" }
  ],
  "exclusiveOrder": { "file": ".architecture/manifest.yaml", "lanes": ["A-J", "O1a", "O1b"] }
}
```

- **`after`** names a lane in the same plan by id, or another plan's lane as `<planId>/<laneId>`. An unknown reference is an import error, not a silent drop; a reference to a plan not yet imported is recorded as `unresolved` and computes as an unknown guard (§3.6).
- **`packages`** and **`sharedFiles`** are what "one lane per package" and "no two lanes on one shared file" are computed from. `sharedFiles` is the bold column of today's workbooks.
- **`decisions`** on a lane names the plan's `D` rows that gate it (K12 waits on D14's opt-in).
- **`exclusiveOrder`** records a plan's stated serial order on one shared file (the web plan's manifest order) as data, not prose.
- **`status`**: `planned`, `deferred` or `dropped`. Deferred and dropped lanes are never queued.
- **Validation:** unknown fields are refused, every string is length-capped and passes `LANE_DIFF_SECRET_PATTERNS` (refused on a hit, as `OwnerQuestion` does), lane ids are unique in the plan, `after` has no cycle.
- **Import** is a compare-and-swap on the plan record's revision, and idempotent by the file's digest: the same bytes twice is one revision. A lane removed from the sidecar is kept as `dropped`, never deleted, so a link to it stays readable.
- **`fleet-v2 plan check <sidecar> <markdown>`** compares the lane ids, tiers and `After` cells of the markdown workbook with the sidecar and reports drift. It is a warning tool for authors (and a Tier 0 doc check), not a source: it never feeds the board.
- **Where the sidecar lives:** in the repository that holds the plan. Plans for private repositories stay in those repositories; `plan import` reads a local file and never fetches from a forge (D10).

**Why a separate record, not early work orders.** Registration refuses an owned path that overlaps any active work order (`RegisterWorkOrderUseCase.use-case.ts:97-112`), and that rule is a safety guarantee, not a nuisance: it is how two live lanes never own the same files. Registering queued lanes early would either break that rule or make it impossible to queue two lanes in one package. So a planned lane is its own record, and becomes a work order only when it is promoted (`work-order register --plan <planId> --lane <laneId>`), which is when the ownership check should run.

**Link to the work order.** `WorkOrderRecord` gains an optional `planRef { planId, laneId }`, set only at registration. A work order without it is a lane with no plan (shown with its `laneId`). Records without the field read as no plan; nothing is matched by lane-id text, since ids repeat across plans (`P1`, `A1`).

### 3.3 Owner items: a new record, beside questions and attention

**Recommendation (design question 1, D1): a new `OwnerItem` aggregate in `operator-coordination`, read beside owner questions and AM3b attention, never instead of them.**

- An **owner question** asks the owner to choose among options; it has an answer. A secret to create or a backup to take has no options.
- An **attention item** (AM3b) is a machine notice keyed (project, work order, kind) and cleared when its work order merges. An owner to-do may have no work order and must not vanish when one merges.
- So an owner item is the owner's to-do: `{ itemId, revision, projectId, kind, subject, refs, blocks, createdAtIso, createdBy, state, resolution }`.
  - `kind`: `merge`, `secret`, `decision`, `backup`, `other`.
  - `subject`: a short label (at most 120 characters, secret-scanned, refused on a hit). For a secret it names the purpose ("forge token for an app repo's deploy job"), never a value. `other` requires a subject; nothing else carries free text.
  - `refs`: typed, `{ kind: pr, repository, number } | { kind: lane, planId, laneId } | { kind: work-order, id } | { kind: question, id } | { kind: plan-decision, planId, decisionId } | { kind: run, id }`.
  - `blocks`: the same shape as `OwnerQuestion.blocks`, so the board computes what each item holds up.
  - `resolution`, typed by kind: `merge` is resolved only by a forge observation that shows the PR merged (or closed: `withdrawn`); `decision` only by its linked question reaching `answered` or `acknowledged`, or by `plan import` reading the decision as `decided`; `secret`, `backup` and `other` by the owner marking it done (`via: cli | web`, at, by the session). Every kind may be `withdrawn` with a reason kind.
- **De-duplication.** A plan's open decision becomes one owner item keyed (project, planId, decisionId) when `plan import` runs, through a consumer-side port; a repeat import updates it. An owner question whose `blocks` name a lane is shown on that lane's card and listed once in Waiting; an owner item that refs the same question is collapsed into it. A run parked `owner-merge` raises no second item: the board reads the park.
- **Who records them.** The orchestrator (`owner-items add`) and, after T6, the owner from the web (resolve only). The conductor and the auto-merge use case (AM4a) may record a `merge` item where AM3b's attention would otherwise be the only trace; AM3b keeps its own notices.

### 3.4 Forge observations: read once, recorded, then shown

The board never calls the forge while it renders. `fleet-v2 forge sync [--project <id>]` reads each active project's repository and records one **forge observation** per repository:

`{ projectId, repository, readAtIso, outcome: read | unavailable, reason?, window: { mergedSinceIso }, pullRequests: [{ number, state: open | merged | closed, headSha, headRef, baseRef, title, mergedAtIso, closedAtIso, ciState: pending | passed | failed | unknown, mergedByFleet }] }`

- It extends AM4b's PR-state read with a list read (`listPullRequests(repository, mergedSince)`) on the same forge-read port in work-execution's infrastructure, so one adapter holds the forge credentials. It mutates nothing.
- `mergedByFleet` is computed from fleet's own forge journal, never from the forge's account fields; no account name is stored.
- Titles are capped and secret-scanned like a subject; a hit stores "title withheld (pattern)".
- **Terminal facts do not go stale.** A PR seen `merged` or `closed` stays so; an `open` PR or a `pending` CI read is shown with its age, and past `policy.board.forgeStaleMinutes` (default 15) its card says "read N min ago, may have changed". When a PR the previous observation saw open is now merged or closed, the card says so: "merged at <time>, not by fleet" (today's "this PR is no longer open").
- **Who runs it.** The orchestrator on demand, and the conductor driver on its own interval once K7 lands (D5). A process that runs `forge sync` holds forge credentials; the board and the web never do.

**PR to lane links (D4).** A merged PR counts for a lane only through a recorded link: fleet's forge journal for the lane's attempts, the run's `prNumber` (K-lanes), or an explicit `plan link-pr <planId>/<laneId> <repository>#<number>` recorded by the orchestrator. Titles such as "feat(installation): … (AM1)" are not read as links. A merged PR with no link is a Done card "no lane recorded", which is also how repositories without lanes show their owner-merged PRs.

### 3.5 In flight: the step, honestly

The step is derived, in this order:
1. **A lane run (after K3, lane WB11):** the conductor state and round: `running` on the first-pass role, `fixing` round 2 on the second-pass role, `code-review` with the latest receipt "1 major", `watching-ci`, `awaiting-premerge`, `parked: <reason>`, `stopping` with its wait reason (conductor §3.9). The seat is the role's recorded seat, and a seat switch reads from `stopReason` ("fix round on the next seat after the second-pass seat failed: timeout").
2. **An attempt with no run (today):** `kind` and `fixNumber` ("fix round 1"), `seatSelection.role`, runner model, state, and for an ended attempt the latest receipts at its head through the existing acceptance-evidence read ("review: 1 major, 2 minor").
3. **A linked open PR with no live attempt:** "PR #n open, CI <state>".
4. **A declaration (D3).** Lanes run by hand outside `attempt dispatch` leave no record. Until the conductor runs them, the orchestrator may declare one: `plan declare <planId>/<laneId> --step <first-pass | gate | brief-check | code-review | fix-round | pre-merge | ci | other> --seat-role <role> --model <id>`. A declaration is shown as **declared, not observed**, with its time, and lapses after `policy.board.declarationTtlMinutes` (default 90, two lane sizes) to "declared lane: state unknown". It never satisfies a guard and never moves a lane to Done.

### 3.6 Queued: `waitsOn`, computed, never typed

For each planned lane not in another column, a pure function computes the reasons it cannot start. Each reason is typed (`WaitReason`), and each guard evaluates to `clear`, `blocked` or `unknown`:

| Reason | Blocked when | Unknown when |
|---|---|---|
| `after-not-done` | A lane in `after` is not Done; names them | A referenced plan is not imported, or the forge observation of the referenced lane's repository is `unavailable` |
| `package-occupied` | An In flight lane shares a package; names it | An In flight work order without a plan whose `ownedPaths` map to no package (shown as "package unknown") |
| `shared-file-held` | An In flight lane lists one of its `sharedFiles`; names the file and the lane | — |
| `exclusive-order` | An earlier lane in the plan's `exclusiveOrder` for that file is not Done | As `after-not-done` |
| `owner-decision` | A decision in `decisions`, or an owner item or question blocking the lane, is open | The owner-items read failed |
| `project-lane-cap` | In flight lanes of the project reach the profile's `maxConcurrentLanes` | The profile could not be read |
| `capacity` | Held reservations reach the installation's slot budget on every eligible host | Reservations or the installation could not be read |
| `seat` | — (no seat health is recorded yet) | Always, until a recorded seat probe exists (A-S, S1); shown as "seat not checked", never as blocked or clear |
| `brief` | No brief recorded: no work order, or no attempt on it with a `briefDigest` | — |

- **Ready** means every guard is `clear`. A lane with only `unknown` guards left is "not known to be ready", naming each unknown guard. Because the seat guard is unknown until a seat probe is recorded, no lane reads "ready" in v1; the board instead lists **"nothing blocks it but unchecked guards"**, which is today's "K2 is the only free lane right now", stated as what it is.
- `package-occupied` is derived from planned `packages` and, for work orders without a plan, from `ownedPaths` by the workspace prefix (`packages/<name>/`, `apps/<name>/`).
- Every reason names the record it came from, so a card can say "waits on K1b (in flight, run r_…)" and link to it.
- `brief` is `drafted` only when declared on the sidecar lane or by `plan declare --brief drafted`, shown as declared. `frozen` comes from a recorded `briefDigest`. A brief file in a worktree is not read.

### 3.7 Freshness and honesty

- **Every fact has a source and a read time.** The read model returns, per source (plans, work orders, attempts, runs, reservations, owner items, questions, attention, project profiles, forge observation per repository), `{ source, readAtIso, status: read | not-read, reason? }`. Cards reference the sources they used.
- **Not read is never empty.** A store that cannot be read (a quarantined state file, E1b) or a forge observation that is `unavailable` makes every card that depends on it show "not read: <source>", and its guards `unknown`. A column is never shown empty because its source failed; it shows "<source> not read" instead of "nothing queued".
- **Old is labelled.** A source older than its threshold shows its age on the board header and on each card that uses it. Only terminal facts (merged, closed, ended, stopped) are shown without an age warning, because they cannot change back.
- **The board never fills a gap.** No step, seat, PR or reason is guessed from a lane id, a branch name or a title. A gap is shown as one.

### 3.8 Cross-project

The board spans every `active` project profile (onboarding P1). Each profile contributes its plans, work orders, owner items and one forge observation of its repository. A repository not in the registry is not read; the board footer says how many projects it read and that others are not shown, with the `projects add` or `projects adopt` command. A project with no plans still shows Done (its merged PRs, "no lane recorded") and Waiting (its owner items). Filters narrow by project; the default is all.

### 3.9 Place in the hexagon (design question 8)

The board is a **read model in `work-execution`**, which already depends on `operator-coordination` and `evidence-and-acceptance` through consumer-side ports. A board context would read all four and own no rule (the conductor plan's D1 reasoning). The manifest's dependency direction is unchanged.

| Piece | Context, layer | New or existing |
|---|---|---|
| `LanePlan` aggregate, `PlannedLane` child, sidecar validation | work-execution, domain | New |
| `ForgeObservation` record | work-execution, domain | New |
| `deriveWorkBoard(facts, nowIso, boardPolicy)`: columns, precedence, `WaitReason`, readiness, freshness | work-execution, domain (`work-board.ts`) | New, pure, never throws |
| `planRef` on `WorkOrderRecord`; `--plan`, `--lane` on registration | work-execution, domain and application | Changed, optional field |
| `ImportLanePlanUseCase`, `LinkPullRequestUseCase`, `DeclareLaneActivityUseCase` | work-execution, application | New |
| `RecordForgeObservationUseCase` | work-execution, application | New |
| `ReadWorkBoardUseCase` (`ReadWorkBoardPort` in-port) | work-execution, application | New |
| `LanePlanRepositoryPort`, `ForgeObservationRepositoryPort` (file and memory stores, CAS, change signals `plan`, `forge-observation`) | work-execution, out-ports and infrastructure | New |
| Forge list read | work-execution infrastructure, on AM4b's PR-state read port | Changed (AM4b's port gains a list method) |
| `OwnerItemsReadPort` (consumer side) → `ListOwnerItems`, `ListOwnerQuestions`, `ReadProjectAttention` | work-execution out-port; adapter delegates to operator-coordination in-ports | New port, existing suppliers plus one new |
| `OwnerItemsWritePort` (consumer side, for `plan import`'s decisions) → `RecordOwnerItem` | work-execution out-port → operator-coordination | New |
| `ProjectProfileReadPort` gains `listActiveProfiles()` → `ListProjectProfilesPort` | work-execution out-port | Changed |
| `OwnerItem` aggregate; `RecordOwnerItem`, `ResolveOwnerItem`, `ListOwnerItems` use cases; `OwnerItemRepositoryPort` (signal `owner-item`) | operator-coordination | New |
| Attempts, journal, reservations, work orders | work-execution's existing repository ports | Existing |
| Lane runs | K3's `LaneRunRepositoryPort` | Planned (K3) |
| Review finding counts at a head | `AcceptanceEvidencePort` → `InspectAcceptanceEvidence` | Existing |
| Slot budget, thresholds | The composition root passes the installation's host budget and `policy.board` as plain input (the free-seat plan's structural-subset pattern) | `policy.board` new in `installation` |

Manifest entries: the new aggregates and child, `ForgeObservation`, the five use cases and their in-ports, the four out-ports and their adapters with `delegates_to` for the two consumer-side ports, the `WaitReason` and `OwnerItemKind` enums, and these invariants: "A planned lane grants nothing and owns no path until registered"; "Done requires a recorded merge"; "An unknown guard is never ready"; "An owner item grants nothing; a merge item is resolved only by an observed merge".

### 3.10 Terminal: `fleet-v2 board` first (design question 6)

- **`fleet-v2 board [--project <id>] [--column done|in-flight|queued|waiting] [--plan <id>] [--package <name>] [--tier 0|1|2] [--since <date>] [--json]`.** A command of its own, like `doctor`, whose `--json` selects output (one JSON document, the read model as served) rather than a payload. Table output: four sections, one row per card, a header line per source with its read time. Exit codes per `AGENTS.md`: `0` every source read; `1` the board printed but at least one source was not read (an unknown); `2` usage error.
- **`fleet-v2 board lane <planId>/<laneId>`** prints one card in full, with its reasons and sources.
- **Writes** live in their own groups and confirm like `projects` does: `plan import|check|link-pr|declare|list`, `owner-items add|resolve|withdraw|list`, `forge sync`.
- **`fleet-v2 board --watch` (D7).** Re-renders on change. With the local state directory (the default), it watches the store files in-process, as E3a-2's watcher does, and needs no token. With `--api <url>` (a board of another installation), it reads `/v1/changes` and only after T3a's `read` scope; it composes read adapters only, never the forge adapter (a test asserts it), so conductor D9 is not engaged. It never runs `forge sync` itself; forge facts show their age.
- **A full-screen TUI (D8): not a separate program.** The board becomes one screen of the shared `fleet-v2 tui` shell (onboarding P9, orchestrator T8a), once that shell exists, using the same read model. Until then `board --watch` is the terminal view.
- All output is written at the CLI boundary; package code returns records and never logs.

### 3.11 Web: `/board` (design question 5)

- **Read first.** `GET /v1/board` (filters as query parameters) serves the read model; `/board` renders it server side, with the labelled fixture fallback `/lanes` uses. It joins the sidebar's views and links each card to `/attempt`, `/work-order`, `/questions` and, after W7a, the run board.
- **Layout.** Four columns on a wide screen, each with its count. Below 720 px, four tabs with counts, one column at a time; the chosen tab is a view control and stays immediate. Filters: project, plan, package, tier; "the filter hides N" is distinct from "nothing here" (web plan §6).
- **States** reuse the web plan's vocabulary: empty, error, unconfigured, unknown, offline. A not-read source shows on the header and on each affected card. Each card shows the state word and an icon, never colour alone.
- **Refresh.** Signals `plan`, `owner-item`, `forge-observation` join the feed's data kinds; the web re-reads `/v1/board` on any signal (E3c), and polls a visible tab every 30 s until then.
- **Actions come later and go through existing routes only (D9).**
  - **Dispatch a queued lane:** only when the lane has a registered work order. The button writes the request channel's `start-lane-run` (O2c, O9) or `dispatch-attempt` for a prepared attempt (O8's card, its AlertBox body and its refusals). The board's own "ready" never enables it alone: the button needs an eligible attached orchestrator, as O8 states. Promoting a planned lane to a work order stays a CLI step, shown as the command to copy.
  - **Resolve an owner item:** a direct route `POST /v1/owner-items/:id/resolution` under T3a's `operate` scope after T6, behind `AlertBox`: "records that you did <kind>: <subject>; does not merge, create a secret or take a backup; the item leaves Waiting". Not offered for `merge` (resolved by an observed merge) or `decision` (answered on its question, Q5).
  - **Never from the board:** forge actions, one-way doors, plan imports, secret values.

### 3.12 Telemetry (design question 7)

A later lane (WB12) adds a lane detail: every attempt in order with its role, seat, model, `stopReason`, usage and cost (estimates labelled for plan-billed seats, as W10 does), and every review round at each head: reviewer, kind (after RW1), finding counts by severity, and how many the next round fixed. It is read from attempts and evidence records, never from an orchestrator's notes, and it is what the orchestrator now keeps by hand per lane. Seat totals across lanes (which seat stops most often, which reviewer finds most) are a later question, not this plan.

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. One lane per package at a time; no two lanes on one shared file (`.architecture/manifest.yaml`, `apps/cli/src/composition.ts`, `apps/cli/src/index.ts`, `apps/api` wiring and `change-feed.ts`, `apps/web` shell). Manifest lanes join the existing manifest queue (conductor K1-1, K10, K11a; web plan A-J → … → A-F) one at a time, rebased; within this plan they run WB1 → WB3a → WB4a → WB5 → WB6. Lanes in `work-execution` queue behind the conductor's own `work-execution` lanes.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| WB0 | This plan and the owner's decisions (§6) | docs | 0 | — |
| **Step 1. Records (WB1 ‖ WB3a, then WB2a ‖ WB3b)** | | | | |
| WB1 | `LanePlan`, `PlannedLane`, sidecar `schemaVersion: 1` validation (unknown fields, caps, secret patterns, unique ids, acyclic `after`, cross-plan refs); `planRef` on `WorkOrderRecord` (optional, read-compatible) | work-execution (domain), **manifest**; sync barrel | 2 | WB0; manifest queue |
| WB3a | `OwnerItem` record, kinds, typed refs and resolutions, validation; file and memory stores with CAS and the `owner-item` signal | operator-coordination (domain, infra), **manifest** | 2 | WB0 (D1); after WB1 on the manifest |
| WB2a | `deriveWorkBoard`: column precedence, Done, In flight steps from attempts and declarations, Waiting, freshness and not-read rules; one test per rule of §3.1, §3.5, §3.7 | work-execution (domain `work-board.ts`) | 2 | WB1 |
| WB3b | `RecordOwnerItem`, `ResolveOwnerItem` (typed resolution per kind), `ListOwnerItems` | operator-coordination (application), **manifest** | 2 | WB3a |
| **Step 2. Stores and reads** | | | | |
| WB2b | `waitsOn`: every `WaitReason` of §3.6, guard values, readiness, "nothing blocks it but unchecked guards"; one test per row | work-execution (domain `work-board.ts`) | 2 | WB2a |
| WB-S | Sidecars for the conductor, web UI interactivity, auto-merge and this plan; `plan check` run by hand | docs | 0 | WB1 (schema) |
| WB4a | `LanePlanRepositoryPort`, file and memory stores, `plan` signal; `ImportLanePlanUseCase` (CAS, digest idempotency, dropped rows kept); registration's `--plan`/`--lane` | work-execution (application, infra), **manifest** | 2 | WB2b (same package), WB3b (manifest) |
| WB4b | Decisions to owner items through `OwnerItemsWritePort`; `LinkPullRequestUseCase`; `DeclareLaneActivityUseCase` with its TTL | work-execution (application, infra) | 2 | WB4a, WB3b |
| WB5 | `ForgeObservation` record and store; `listPullRequests` on AM4b's forge-read port with recorded `gh` outputs; `RecordForgeObservationUseCase`; `mergedByFleet` from the journal; title withholding | work-execution (domain, application, infra), **manifest** | 2 | AM4b, WB4b (same package) |
| WB6 | `ReadWorkBoardUseCase`: gathers every source with its read status, `OwnerItemsReadPort` and `listActiveProfiles` adapters, review counts through `AcceptanceEvidencePort`, `policy.board` as input | work-execution (application, infra), **manifest** | 2 | WB5, WB2b |
| WB6p | `policy.board` (`forgeStaleMinutes`, `declarationTtlMinutes`, `doneWindowDays`) | installation | 1 | — (one lane at a time in installation: after K2) |
| **Step 3. Terminal (one at a time on `index.ts` and `composition.ts`, with K7, AM5, O5, K11b)** | | | | |
| WB7a | `plan import\|check\|link-pr\|declare\|list`, `owner-items add\|resolve\|withdraw\|list`, confirmations, exit codes | apps/cli, **`index.ts`, `composition.ts`** | 2 | WB4b, WB3b |
| WB7b | `forge sync`; `board` and `board lane` (table and `--json`), exit codes; a test that `board` composes no forge adapter | apps/cli, **`index.ts`, `composition.ts`** | 2 | WB7a, WB6, WB6p |
| WB10 | `board --watch` over the local state-file watcher; `--api` with `/v1/changes` behind T3a's `read` scope | apps/cli | 1 | WB7b; the `--api` half after T3a, E3b |
| **Step 4. Web (in the `apps/web` queue)** | | | | |
| WB8 | `GET /v1/board`, `GET /v1/plans`, `GET /v1/owner-items`; feed kinds `plan`, `owner-item`, `forge-observation` in `DATA_KINDS` | apps/api (`work/` and `operator/` composition, **`change-feed.ts`**, **`runtime.ts`**) | 2 | WB6, WB3b; in sequence with O3, L3, A-R, A-C |
| WB9a | `/board` read: four columns, cards, sources header, not-read and stale states, links; sidebar entry | apps/web, **`view-nav.tsx`** | 2 | WB8; after the `apps/web` lane running at the time |
| WB9b | Filters (project, plan, package, tier), the 720 px tab layout, "the filter hides N", visible-tab poll; E3c signals when served | apps/web | 1 | WB9a |
| **Step 5. With the conductor** | | | | |
| WB11 | In flight from lane runs: state, round, seat per role, park reasons, `stopping`; `owner-merge` and `one-way-door` parks to Waiting; PR from `prNumber` | work-execution (application) | 2 | K3, K1-2c, WB6 |
| WB12 | Lane detail: seat history, `stopReason`, usage, review rounds per head with finding counts; `board lane` and a web drawer | work-execution (application), apps/cli, apps/web | 2 | WB11, RW1, WB9b; split per package if over 45 min |
| **Step 6. Actions (after the write path)** | | | | |
| WB13a | `POST /v1/owner-items/:id/resolution` under `operate`; refuses `merge` and `decision` kinds | apps/api, **`security.ts`**, `composition.ts` | 2 | T6, WB8 |
| WB13b | Board actions: resolve behind `AlertBox`; dispatch through O8's request card for registered lanes; copyable `work-order register --plan` for planned ones | apps/web, packages/ui | 2 | WB13a, O8, O9, WB9b |
| WB14 | Board screen in the shared `fleet-v2 tui` shell | apps/cli | 2 | P9 or T8a, WB7b; only if D8 is changed to a TUI screen now |

WB1 and WB3a can run in parallel across packages but both edit the manifest, so they merge in order, rebased. WB2a and WB3b run side by side (different packages, WB2a does not touch the manifest). WB5 is the first lane after AM4b that touches the forge adapter; it states in its brief that AM4b's port and recorded outputs are on `main`. WB-S can run beside any lane.

## 5. Hard to undo

- **The sidecar schema (`schemaVersion: 1`)** becomes a file format in several repositories; a change needs a new version and an importer for the old one.
- **Stored records:** `LanePlan`, `OwnerItem`, `ForgeObservation` and the `planRef` field on work orders. Version them from their first commit.
- **Wire contracts:** the `/v1/board` read model, `WaitReason` and `OwnerItemKind` values, and the feed kinds `plan`, `owner-item`, `forge-observation` become what the web, the TUI and scripts depend on.
- **Forge reads** are read-only, but they put PR titles and states of every registered repository into the state directory; a public deployment of the web would show them. The API stays loopback-bound as `AGENTS.md` states.
- Everything in `apps/web` and the table layout of `board` is two-way.
- No one-way door: the board merges, pushes and dispatches nothing.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Owner to-dos: a new record, or reuse owner questions or AM3b attention? | **A new `OwnerItem` in `operator-coordination`** (merge, secret, decision, backup, other), read beside questions and attention and collapsed with them by reference (§3.3) |
| D2 | How do workbook rows become records? | **A JSON sidecar per plan, imported by `fleet-v2 plan import`;** `plan check` warns on drift from the markdown table; no markdown parsing as a source |
| D3 | May an orchestrator declare a hand-run lane in flight? | **Yes, typed (step enum, seat role, model), shown as "declared, not observed", lapsing after 90 minutes;** it satisfies no guard |
| D4 | How is a merged PR tied to a lane? | **Only by a record:** fleet's forge journal, the run's `prNumber`, or `plan link-pr`. No title or branch parsing; unlinked merges show "no lane recorded" |
| D5 | Who reads the forge, and how often? | **`forge sync` on demand; the conductor driver every 10 minutes once K7 runs.** The board and the web never call the forge |
| D6 | How far back does Done go? | **14 days** (`policy.board.doneWindowDays`), `--since` for more |
| D7 | What drives `board --watch`? | **The local state-file watcher;** `/v1/changes` only for `--api` and only after T3a's `read` scope |
| D8 | Is a full-screen TUI worth building for the board? | **Not on its own.** A Board screen in the shared `fleet-v2 tui` shell (onboarding P9, orchestrator T8a; Ink per onboarding D3) when that shell exists; `board --watch` until then |
| D9 | Which board actions, and through what? | **Read-only first.** Then dispatch only through the request channel's existing kinds for a registered lane, and owner-item resolve as a direct route under `operate` after T6, never for `merge` or `decision`. Promotion of a planned lane stays in the CLI |
| D10 | Where does a plan's sidecar live? | **In the repository that holds the plan;** `plan import` reads a local file and never fetches from a forge, so private plans stay private |

## 7. Assumptions

- Lane ids are unique within a plan; across plans a lane is named `<planId>/<laneId>`. A plan that reuses an id inside itself fails import.
- Authors keep the sidecar current when they amend a plan. If they do not, `plan check` reports the drift, and the board shows the sidecar's state, which may lag the prose.
- The forge read used by AM4b can list PRs for a repository within a time window; if the forge limits that read, `forge sync` records `unavailable` for that repository and its cards show "not read".
- One installation and one state directory see every registered project, as the conductor plan assumes.
- Orchestrators record links and declarations. A lane run by hand with neither shows as queued, which is visible and correctable, not silent.
- No seat probe is recorded in v1, so the seat guard stays `unknown` and no lane reads "ready" until A-S or S1 records one.
- The state directory and the web stay private to the operator; PR titles shown on the board are the owner's own.

## 8. Review

Not yet reviewed. Suggested pass: one read-only reviewer on the three things most worth checking: the precedence rules of §3.1 against a lane that has both an open owner item and a live attempt; whether `OwnerItem` duplicates AM3b's attention store in a way that will drift; and whether any card can show "ready" or "done" from a fact that is unknown or stale.

## Challenge this

Whether `PlannedLane` should exist at all. The plan keeps planned lanes out of work orders because registration refuses overlapping owned paths, and two queued lanes in one package always overlap. The other path is to move that ownership check from registration to dispatch and let every planned lane be an `approved` work order, which removes a record type and the `planRef` link. A reviewer should test whether the ownership guarantee survives that move (a check at dispatch under the journal lock, beside the busy-worktree check), and whether an `approved` work order that may never run would mislead any existing reader.

A second candidate: whether a sidecar per plan will be maintained. The owner's table was right because a person assembled it the same day. A sidecar edited only at plan time will drift as plans are amended, and the board will then be confidently wrong in a new way. `plan check` reports drift but does not prevent it; a reviewer should ask whether the sidecar should be the plan's only workbook, with the markdown table generated from it.
