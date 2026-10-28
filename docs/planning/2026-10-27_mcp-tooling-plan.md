# Plan: MCP tooling for lane orchestration, with seats and assignments, generated through hexagen

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2` (lanes SR*, MX*, BP1). The hexagen side (HM1–HM4) is a set of work orders against `hexagen-monaco`, owned and planned there (hexagen integration plan §2.3).
- **Status:** rev 1.1. Rev 1 applied a Fable review of rev 0 (one blocker, six majors, four minors). Grok 4.7 re-checked rev 1: the blocker and all six majors resolved, with two new majors and two minors, all applied in rev 1.1 (§8). Nothing built. Decisions in §6 are open with recommended defaults. Anchors checked against fleet-v2 `origin/main` at `a56a0a8` and hexagen-monaco `origin/main` at `f071763` (read from the local clone, not fetched).
- **Owner request (2026-10-27):** "write a plan for the mcp tooling, use the hexagen template engine, including seats and assignments."
- **Why now:** no tool exposes seat selection. The orchestrator picks every lane's model by hand and passes it per dispatch; the round-robin between seats lives in the orchestrator's memory. The conductor gets a seat plan from K4 on, but nothing gives the orchestrating agent the same answer before then, or alongside it.
- **Builds on:** `2026-10-16_mcp-server.md` (the narrow `apps/mcp`; M1a and M1b merged, M2–M4 open), `2026-10-23_attempt-record-gate-predicates-usage-plan.md` (S1 `SeatPlan`, `stopReason`, S3 usage), `2026-10-27_conductor-plan.md` (§3.2 rounds, §3.3 seats and review rows, §3.4, K4, K5, PC, D8 rotation state, D10), `2026-10-18_orchestrator-interaction-plan.md` (§4.5 and §4.6: T3a scopes, the MCP token's scopes), `2026-10-27_web-ui-interactivity-plan.md` (§3.6 request channel, O2c, O3, A-C, A-R, A-S, A-F), `2026-10-27_work-board-plan.md` and `2026-10-27_waits-for-view-plan.md` (WB8, WB8w), `2026-10-27_lane-run-telemetry-plan.md` (§3.2 never-send list, OT1s `billingOf`, OT2b), `2026-10-19_free-seat-flag-plan.md` (`policy.useFreeSeats`), `2026-10-25_hexagen-integration-plan.md` (contract ownership, release fan-out, `generator.name`).
- **Supersedes:** the open lanes M2, M3 and M4 of the 2026-10-16 MCP plan. Their scope is carried into MX2, MX3 and MX6 below; that plan's design rules still hold.

## 1. Goal

An orchestrating agent (Claude Code, opencode, agy or another MCP client on the orchestrator's machine) can ask fleet-v2, through typed MCP tools:

1. **which seat comes next** for a role (first pass, fix round, review of a given kind, pre-merge) on a project or an existing lane, with the fallback chain behind it, the seats skipped and why, and how each seat is billed;
2. **who holds which role** on a lane (its assignments), and whether the reviewer-never-implementer rule holds;
3. **the state of the work**: attempts, lane runs, the board, why a lane waits, reaper findings, evidence, questions;
4. and can **leave requests**: a request for a dispatch or a review that the conductor or a registered orchestrator claims, a question for the owner, a seat observation.

The seat answer comes from the same domain selector and the same fact gathering the conductor uses (K4, K5), driven by data in the installation file, so the round-robin is a policy, not a habit.

The MCP server's shape is hexagen's: a hexagen app framework and, if hexagen accepts it, a manifest section that declares the tools (§3.6).

**Non-goals.**
- **No new authority.** The MCP server is a boundary adapter over existing use cases. It never dispatches, stops, halts, merges, pushes, accepts, signs, commits a seat, or writes the installation file. Live dispatch keeps its existing explicit authority (the composition root, the frozen brief digest, the allowed-seat check, the conductor's policy grants). A request record carries no authority (web UI plan §3.6).
- **No second seat selector.** No tool computes a seat itself.
- **No new seat, model or provider.** Seats stay installation data.
- **No HTTP transport** in this plan (D15).
- **No business logic in `apps/mcp`.** Everything a tool answers is a use case in a context, served by a `/v1` route.

## 2. What exists (checked on `origin/main`, 2026-10-27)

| Area | What exists | Anchor | Gap |
|---|---|---|---|
| MCP app | `@fleet/mcp`, stdio, a client of `/v1` with the token-file read; static registry with `fleet_coordination` and three resources; envelopes capped at 256 KiB | `apps/mcp/src/{server,registry,client,envelope,sdk}.ts` | Outside the hexagen manifest (hand-placed, 2026-10-16 plan); tools carry no kind, scope or annotations; no seat, run, board or request tools |
| hexagen MCP templates | `mcp-server` (stdio) and `mcp-server-http` (always authenticated) in the template engine | hexagen `packages/template-engine/templates/mcp-server*`; design `docs/planning/generator-templates/18-mcp-server.md` | The template engine interpolates flat `{variable}`s with no loops; the template places files under `src/infrastructure/mcp` and `bin/cli.ts`, which does not fit an `apps/*` workspace (`rootDir: src`, reported upstream by M1a) |
| hexagen sync | Stubs per **bounded context** (`generateStubs(moduleName)` over the `StubKind` list: in-port, out-port, use case, adapter; `packages/sync/src/generators/stubs.ts`, `types/manifest/generator.ts`); `@generated` barrels; the apps generator emits only `package.json`, `tsconfig`, `entryPoint` and `extraFiles` through flat `interpolate`, from `BUILTIN_FRAMEWORK_TEMPLATES` (`generators/apps-framework-templates.ts`); `safeWriteFileAtomic` skips an existing file without an `@generated` header (`fs-utils.ts`); the linter lives in the same package (`src/linter.ts`, `src/arch-linter-bin.ts`) | hexagen `packages/sync` | No MCP app framework; no app-scoped stub generation; no manifest section for tools. `generator.name` (H1, #903) and `sync --check --json` (H2b, #904) are merged but **unreleased**: `@hexagen-monaco/sync` is still `0.14.0`, the version fleet-v2 pins |
| Seat registry | Installation v2 `seats` (id, tool, model, variant, agent, roles, `costClass` free / plan-quota / paid, `health`) and `chains` (`implementer`, `fix`, `reviewer`, `high-risk-reviewer`); `policy.forbiddenRoutes` refuses matching seats at load; `policy.useFreeSeats` | `packages/installation/src/types.ts:186-213`, `:335-348`; `policy.ts:249` | No rotation policy, no cooldown |
| Seat plan | `SeatPlan` v1 (roles `first-pass`, `fix`, `review`; seats with optional `on` triggers), frozen in the brief manifest; `seatSelection` and `stopReason` on attempts | `SeatPlan.vo.ts`; `StopReason.vo.ts` | No `pre-merge` role; `no-route` is not a stop class (it reads as `runner-refused`, which is not a model refusal) |
| Where a seat is committed | **First pass:** at `brief prepare`; the frozen `modelAssignment` must match a first-pass seat, and `DispatchAttempt.bindSeat` only checks the assignment against it. **Fix:** `PrepareFixAttempt` binds the next eligible fix seat. **Review:** chosen by whoever requests the review | `DispatchAttemptUseCase.use-case.ts:873-922`; `PrepareFixAttemptUseCase.use-case.ts:138-150` | Nothing chooses the first-pass seat; the orchestrator does |
| Selector | Pure `selectSeat` (cursor = after this role's last seat **within one lane**, refused models skipped, `on` triggers), `selectReviewSeat` (`round mod n`, family check), `seatPlanFamilyConflicts`, `classifyRunnerRefusal`, `historyEntryOf` (the model that ran, else the bound model) | `packages/work-execution/src/domain/seat-selection.ts` | No rotation across lanes; refusals in one lane do not cool the seat for the next; no busy input |
| Seat CLI | A `seats` command group (`seats free-tier`); `brief prepare --seatPlanFromInstallation`; `attempt next-seat --role fix\|review` | `apps/cli/src/seats.ts`; `apps/cli/src/index.ts:1109-1148`, `:1987`; `apps/cli/src/seat-plan.ts` | `next-seat` composes the selector **inside the CLI's command table**, so the API and MCP cannot reuse it; its review branch takes implementer models from `runner.model` only, so a fix attempt with no runner record (an agy round) is missed |
| Conductor review facts | `LaneRunFacts.reviewSeat` (a recorded fail pins the same seat, D10), `LaneRunReviewFact { verdict, seatIndex, retries }` (one retry for a request with no receipt) | `lane-run-decider.ts:70-103` | The supplier (K5, PC) is not built |
| Billing | `billingOf(runnerKind)`: `opencode` → metered, `agy` → plan, else unknown | `packages/shared/src/billing.ts` (OT1s, #287) | Review seats run by a CLI outside the runner read as `unknown` |
| API auth | One bearer token; constant-time compare; orchestrator sessions bound to their token (O3-0, #289) | `apps/api/server/middleware/security.ts` | T3a scopes not built |
| Routes | Attempts, journals, work orders (read one), evidence, questions, coordination, capabilities, attention, projects, reviews | `apps/api/server/routes/v1/**` | No `/v1/seats*`, `/v1/runs*` (A-R), `/v1/board*` (WB8, WB8w), `/v1/requests*` (O3), `/v1/reaper/findings` (A-F). `GET /v1/attempts/:id` returns the worktree path and runner host fields, and journal entries carry `detail` text that can embed a runner's refusal text |

## 3. Design

### 3.1 Place in the hexagon

**`apps/mcp` stays a client of `/v1` (D1).** The 2026-10-16 plan chose this and this plan keeps it:

- The API is the composition root the MCP server reaches. The MCP process owns no repository, no adapter of any context and no installation reader. It cannot reach anything `/v1` does not expose.
- **Composition is not duplicated.** A capability is added once: a use case and in-port in its context; the CLI composes it in `apps/cli/src/composition.ts`; the API composes it and serves a route; the MCP tool calls the route. Two composition roots exist today (CLI, API) and stay two.
- The other choice, composing use cases in-process like the CLI, gives a third composition root, a second authority path for every store, and an MCP process that holds the installation file. It is rejected.
- **Consequence:** every tool in §3.3 needs a route. Where none exists, the route is part of this plan or of the plan that already lists it.

**Seat selection moves behind in-ports.** The selection that `attempt next-seat` does inside the CLI's command table becomes `PreviewSeatSelectionUseCase` in `work-execution`, and the commit of a seat becomes `CommitSeatSelectionUseCase` (§3.5.3). The CLI, the API, the MCP tool and the conductor's K4 and K5 reach the same application helper and the same pure selectors.

### 3.2 Transport

- **stdio only.** The server runs as a subprocess of a trusted client on the orchestrator's machine. It is never configured inside lane worktrees or the runner environment, and `.mcp.json` stays ignored (2026-10-16 plan).
- **HTTP later, separately (D15).** If it is ever wanted, it comes from hexagen's `mcp-server-http` addon (always authenticated), bound to loopback, only after T3a, with its own plan and decision.

### 3.3 The tool catalogue

**Naming (D16).** `fleet_<singular noun>[_<verb or facet>]`, lower snake case, at most 64 characters; a list is `_list`. Several clients reject dots in tool names, and the existing tool is `fleet_coordination`. The owner's names map as shown in the first column.

**Kinds.** `read` tools call `GET` routes, or a `POST` that computes and stores nothing. `mutating` tools create a record and nothing else. Every tool declares MCP annotations: `readOnlyHint` on reads, `destructiveHint: false` and `idempotentHint: true` on mutating tools (each takes a client-minted idempotency key). No tool is destructive.

**Scopes.** Named as T3a will define them. Every tool here needs `read` or `message`, so the MCP token stays `read` + `message` (orchestrator plan §4.5). Seat observations are `message`: like a request or a question they are mailbox-class records that act only through a rule fleet-v2 applies (§3.5.5), and they cannot name anything but fleet's own attempts and review requests. The `orchestrate` scope that §4.6 grants the MCP token is for the claim side of the request channel (T4 and the conductor), which no tool here uses. Until T3a lands, the MCP process holds the shared bearer and only `read` tools ship (D10).

| Owner's name | Tool | Kind | Scope | Use case, route | Status |
|---|---|---|---|---|---|
| `seats.plan` | `fleet_seat_catalog` | read | read | `ReadSeatCatalogUseCase` (SR4a2); `GET /v1/seats` (SR7, which builds A-S's read route) | Planned |
| `seats.next` | `fleet_seat_next` | read | read | `PreviewSeatSelectionUseCase` (SR4a2); `GET /v1/seats/next?projectId=&role=[&kind=][&workOrderId=][&attemptId=][&round=]` | Planned |
| assignments | `fleet_seat_assignments` | read | read | `ReadSeatAssignmentsUseCase` (SR8); `GET /v1/work-orders/:id/seats` | Planned |
| `seats.record` | `fleet_seat_observe` | mutating | message | `RecordSeatObservationUseCase` (SR6); `POST /v1/seats/observations` (with `dryRun`) | Planned; CLI first, MCP after T3a |
| `lanes.list` | `fleet_attempt_list` | read | read | `ListAttempts`; `GET /v1/attempts`, projected (§3.7) | Route exists: MX2 |
| `lanes.status` | `fleet_attempt` | read | read | `InspectAttempt`; `GET /v1/attempts/:id`, projected (§3.7) | Route exists: MX2 |
| | `fleet_attempt_journal` | read | read | `ListAttemptJournal`; `GET /v1/attempts/:id/journal`, projected (§3.7) | Route exists: MX2 |
| | `fleet_work_order` | read | read | `InspectWorkOrder`; `GET /v1/work-orders/:id` | Route exists: MX2 |
| | `fleet_head_evidence` | read | read | `InspectAcceptanceEvidence`; `GET /v1/heads/:sha/evidence` | Route exists: MX2 |
| | `fleet_lane_run_list`, `fleet_lane_run` | read | read | A-R's read use cases; `GET /v1/runs`, `GET /v1/runs/:id` | Depends on A-R: MX5a |
| `conductor.status` | `fleet_conductor_status` | read | read | The halt marker (A-C) and live runs by state and park, from A-R's read model; no new store | Depends on A-R, A-C, K7: MX5a |
| `work-board.read` | `fleet_board` | read | read | `ReadWorkBoard` (WB6); `GET /v1/board` (WB8) | Depends on WB8: MX5b |
| `waits-for.read` | `fleet_board_lane` | read | read | `ReadBoardLane` (WB6w); `GET /v1/board/lane?ref=` (WB8w) | Depends on WB8w: MX5b |
| | `fleet_reaper_finding_list` | read | read | A-F's list use case; `GET /v1/reaper/findings` | Depends on A-F: MX5b |
| | `fleet_coordination` and the three resources | read | read | Existing | Exists (M1b) |
| | `fleet_question_list`, `fleet_question` | read | read | `ListOwnerQuestions`, `ReadOwnerQuestion`; `GET /v1/questions[/:id]` | Route exists: MX2 |
| | `fleet_project_list` | read | read | `ListProjectProfiles`; `GET /v1/projects` | Route exists: MX2 |
| `briefs.render` | `fleet_brief_preview` | read | read | `PrepareBriefPackage` with `dryRun: true` (BP1): validates and returns what it would freeze, projected (§3.7): the digest, a projection of the acceptance spec (flags, command count, one digest per command), the seat plan, and the first-pass seat a commit would take now. It writes nothing and takes no ticket; `POST /v1/briefs/preview` | Planned: BP1, MX7 |
| telemetry read | `fleet_telemetry_status` | read | read | Export dispositions and the salt fingerprint (OT2a, OT4b); route added with OT4b's API composition | Deferred: MX8 |
| `dispatch.request` | `fleet_request` | mutating | message | `POST /v1/requests` (O3): kinds `dispatch-attempt`, `start-lane-run`, `prepare-fix`, `resume-run`; ids only, no seat override, no free text | Depends on O2c, O3, O3-dry, T3a: MX6b |
| `reviews.request` | `fleet_request`, kind `request-review` | mutating | message | The same channel; never `POST /v1/reviews` (D12) | As above |
| | `fleet_owner_ask`, `fleet_owner_answer_wait` | mutating, read | message, read | `POST /v1/questions`, `GET /v1/questions/:id` (the 2026-10-16 plan's M3) | Routes exist; after T3a: MX6c |
| | `fleet_context_propose` | mutating | message | `POST /v1/knowledge/proposals` (the 2026-10-16 M2 remainder); may spend the decision budget | After T3a: MX6c |
| | `fleet_thread_read`, `fleet_thread_post` | read, mutating | read, message | Orchestrator plan T4 | Owned by T4 |

**Excluded on purpose**, as in the 2026-10-16 plan: dispatch, stop, halt, resume, reconcile, collect, acceptance, forge kinds, merges, authorizations, decisions, knowledge disposition and publication, relays, installation writes (including seat health and `seats free-tier`), state restore, and **committing a seat** (§3.5.3). They keep their CLI and API paths with their existing authority.

### 3.4 Rules for mutating tools

1. **A mutating tool creates a record that asks; it never acts.** `fleet_request` writes an `OrchestratorRequest` that a claimant with `orchestrate` and a live lease acts on under its own authority, with every refusal intact (web UI plan §3.6). A dispatch requested through MCP faces exactly the checks a CLI dispatch faces.
2. **Dry run first, validated by the server where the route can (D11).** `dry_run` defaults to `true`. The tool computes a **preview digest** (SHA-256 of the canonical request body) and returns it with the record that would be written. A write needs `dry_run: false` and the same digest echoed back; any change to the input changes the digest and is refused.
   - **Routes this plan owns or extends** validate on the server: `POST /v1/seats/observations` takes `dryRun` (SR7), and `POST /v1/requests` gains `dryRun: true` through **O3-dry**, a small addition filed against the web UI plan: the route runs the same validation it runs for a write (kind allowed, target exists and is in a state the kind accepts, project known, idempotency key unused) and writes nothing. The result says `validated: server`.
   - **Routes without a server dry run** (`POST /v1/questions`, `POST /v1/knowledge/proposals`) are validated against the tool's schema only, and the result says `validated: schema-only`, never more.
   - This guards against a confused agent, not a hostile one: the same agent can do both steps. The controls are the scopes, the closed request payload and the claimant's own authority.
3. **Idempotency.** Every mutating input carries a client-minted ULID; a repeat returns the existing record (the `RequestScopedDecision` shape).
4. **Who asked.** `requestedBy { via: "mcp", sessionId }` comes from the token's bound orchestrator session (O3-0), never from the tool input.
5. **No free text** beyond the fields the route already accepts; a field the route caps (1 KiB detail) is secret-scanned and refused on a hit, as `OwnerQuestion` does.

### 3.5 Seats and assignments as data

#### 3.5.1 The registry is the installation file

No new registry. The installation's `seats` and `chains` already hold every seat, and `policy.forbiddenRoutes` refuses a forbidden route at load (for example a model family that must only run through its own CLI). Roles map as follows:

| Pipeline role | Installation chain | `SeatPlan` v1 role | Committed when |
|---|---|---|---|
| First pass | `chains.implementer` | `first-pass` | `PrepareBriefPackage` freezes the brief |
| Second pass and fix rounds | `chains.fix` (falls back to `implementer`) | `fix` | `PrepareFixAttempt` prepares the fix attempt |
| Brief check and code review | `chains.reviewer` | `review` | The review is requested |
| Pre-merge (Tier 2) | `chains['high-risk-reviewer']` | none | The pre-merge review is requested (D8) |

Chain order is the owner's priority (for example fast metered seats before free ones). A seat without `on` is **in rotation**; a seat with `on` is a fallback that joins only after one of its triggers occurred in the lane. That is how "alternate A and B; fall back to C on a 429" is written as data.

#### 3.5.2 The rotation policy

A new installation block, `policy.seats`, read through a resolver like `policy.conductor`:

```yaml
policy:
  seats:
    rotate: [first-pass, fix, review]   # absent or []: fixed order, today's behaviour
    cooldownMinutes: 60                 # a model refused in one lane is skipped by every lane this long
    observationCooldownMinutes: 0       # observations cool seats only when the owner opts in (> 0)
```

- `rotate` (D4) lists the roles whose starting seat rotates **across lanes** of one project. A role not listed starts at its first in-rotation seat, as today.
- `cooldownMinutes` (D5): after a model refusal recorded on an attempt (`rate-limited`, `payment`, `timeout`, `model-missing`, `no-route`), that seat is `cooling` for every lane of the installation until the window passes. Default 60; 0 turns it off.
- `observationCooldownMinutes` (D7): the same, for observations (§3.5.5). Default 0, off.
- Free-seat and forbidden-route rules apply before rotation, unchanged.

#### 3.5.3 Rotation state: a ticket per committed seat (D3)

The seat is committed at preparation, not at dispatch (§2: `bindSeat` only checks the frozen assignment). A cursor advanced at dispatch would let two lanes prepared in parallel freeze the same seat, and an absolute "next after the one dispatched" write would move the cursor backwards when dispatches arrive out of order. So:

- **`SeatTicketRecord`** `{ version: 1, projectId, role, ticket, revision, updatedAtIso }`, one per (project, role), in `seat-tickets.json` in the state directory (memory store when no state directory is set). `ticket` only ever increases.
- **`CommitSeatSelectionUseCase`** reads the stored counter `t`, writes `t + 1` under compare-and-swap (`revision + 1`; a lost race re-reads and retries), and owns ticket `t`. It then selects **over the seats available at commit time**: `available = inRotation minus unavailable` (§3.5.4), in chain order, and the seat is `available[t mod available.length]`. An empty `available` is `exhausted`. The ticket number `t` and the available list's length are stored on the attempt's `seatSelection` beside the seat.
  - **Why this and not "skip forward":** skipping forward from `inRotation[t mod n]` lets consecutive tickets land on the same seat. With `[A, B, C]` and A cooling, tickets 0 and 1 would both map past A to B. Indexing into the available list maps consecutive tickets to different available seats.
  - **Why this and not "take tickets until one lands on an available seat":** that also works, but costs one compare-and-swap per skipped seat, burns tickets, and makes a commit's cost depend on how many seats are cooling. Indexing the available list needs exactly one compare-and-swap per commit.
  - **Fairness:** while the available set is stable, commits cycle through it, so each of `k` available seats gets one of every `k` consecutive commits. When the set changes (a seat cools or recovers), the mapping shifts. A seat can then get at most one extra or one fewer commit around that change, and the cycle resumes. Fallback seats with `on` triggers are not in `inRotation` and never take tickets.
  - **Tests (SR5a):** `[A, B, C]`, A cooling, two parallel commits land on B and C, one each. `[A, B]`, A cooling, two parallel commits both land on B, the only available seat, and take tickets `t` and `t + 1`. Nothing available is `exhausted`, and no ticket is reused.
- **Durability order (SR5a).** The ticket write is durable (the compare-and-swap has returned and the file is synced the way every store syncs) **before** the brief manifest or the attempt record that names the seat is written. That record carries the ticket number it used.
  - A crash after the ticket write and before the record leaves a gap: harmless, and never a reuse, because the next commit reads `t + 1`.
  - The reverse order can never be produced. A reader that finds a record whose ticket is greater than or equal to the stored counter for its (project, role) treats the store as corrupt for that key and refuses to commit or preview there, with one attention item. It never rewinds or repairs the counter.
  - **Crash tests (SR5a):** kill between the two writes in both orders, simulated with a failing writer. Ticket first, then crash: the next commit takes `t + 1`, and the gap is reported by `state check` as a gap, not an error. Record first (impossible in correct code; the test forces it): the refusal and its attention item.
- **Who commits:**
  - **first pass:** `PrepareBriefPackage` when the first-pass seat is `auto` (§3.5.9);
  - **fix:** `PrepareFixAttempt`, for a lane's **first** fix attempt only. Later fix rounds keep the existing per-lane cursor ("after this role's last seat");
  - **review and pre-merge:** the work-side review request (K5 through PC's `ReviewRequestPort`), and `fleet-v2 seats take --role review|pre-merge --workOrder <id> --kind <kind>` for reviews the orchestrator runs by hand.
- **Previews read and never write.** `PreviewSeatSelectionUseCase` reads the counter and answers with the seat the next commit would take (`available[t mod available.length]`) **if no other commit lands first and availability does not change**, which is advisory, and says so. A test asserts that a preview leaves every store byte-identical.
- **`DispatchAttempt` never advances anything.** It keeps checking the frozen assignment.
- A ticket taken by a preparation that then fails is a gap, not an error: the next commit takes the next ticket.
- With rotation off for a role, commits still record their ticket, but selection starts at the first in-rotation seat.

**The alternative (D3).** Drop the store and derive the start from the latest committed `seatSelection` per (project, role) across attempt records. It needs no new file, but two preparations that read the same latest selection freeze the same seat, which is the race above; it would need a lock around preparation to be correct. The ticket store is chosen because compare-and-swap on one small record is the cheapest correct serialisation, and every store already does it.

#### 3.5.4 Selection inputs and pivots

`selectSeat` and `selectReviewSeat` gain two optional inputs (SR1b), so callers that pass neither behave exactly as today:

- `rotationStart`: the ticket, used only when the lane has no earlier attempt in that role. The selector applies it to the available seats (`available[ticket mod available.length]`, §3.5.3), never to the full list;
- `unavailable`: a map of seat id to `unhealthy` (installation health), `cooling` (from attempts), `cooling-observed` (from an observation, with its `observationId`) or `busy`.

**`busy` (D6)** is defined narrowly: every host in the installation whose runner kind equals the seat's `tool` is at its `maxLanes`, counting live capacity reservations. Seats name no host, so this is the only reading the data supports. When reservations cannot be read, or a host declares no `maxLanes`, the seat is not marked busy and the preview reports `busy: unknown` for it; capacity is then left to dispatch and to conductor admission, as today. A busy seat is skipped and never waited for.

Pivots, all from typed facts, never from prose:

| Fact | Effect |
|---|---|
| `stopReason` `rate-limited`, `payment`, `timeout`, `model-missing`, `no-route` | The model is skipped for the rest of the lane (today) and `cooling` across lanes (new) |
| `no-commit`, `gate-failed`, `length`, `step-cap` | Triggers fallback seats whose `on` lists it; no cooling (the model was reachable) |
| `busy` | Skipped now, never waited for |
| No eligible seat | `exhausted`, with one reason per skipped seat; the conductor parks `seat-plan-exhausted` |

`no-route` becomes a stop class (D9, SR1a): `classifyRunnerRefusal` maps a provider's "no route" or "no endpoints" refusal to it, and it joins `MODEL_REFUSAL_CLASSES`. Today such a refusal reads as `runner-refused`, which is not a model refusal, so the same seat could be chosen again.

#### 3.5.5 Seat observations

Seats that run outside fleet's runner (a review CLI, a pre-merge agent) leave no attempt record when they fail before producing a receipt. **`SeatObservation`** `{ version: 1, observationId, seatId, outcome, observedAtIso, subject, via }` records that, with `outcome` one of the model-refusal classes or `empty-response`, and `subject` either `{ attemptId }` or `{ reviewRequestId }`.

Because an observation can steer selection, it is held to these rules (SR6):
- it is accepted only when its subject exists, the subject's committed seat is `seatId`, and the subject has **no** result: an attempt not ended with a result, a review request with no receipt;
- at most one cooling observation per seat per window; a second is stored and reported as `duplicate`, and cools nothing;
- it cools a seat only when `policy.seats.observationCooldownMinutes` is above 0 (default 0, D7);
- its effect is visible: the preview and the assignments name it as `cooling-observed` with its `observationId`;
- it never rewrites an attempt, never edits the installation's `health`, and is not evidence.

The CLI's `seats observe` ships first (SR6). The MCP tool follows after T3a (MX6a).

#### 3.5.6 The reviewer is never the implementer

**Implementer models** are, for every first-pass and fix attempt of the lane, `historyEntryOf(record).model`: the model that ran, else the bound model from `seatSelection`. A fix attempt run through the agy round driver, whose `runner` is null, still counts by its bound seat. SR4a2 fixes `attempt next-seat`'s review branch, which reads `runner.model` only.

Enforced in three places:
- at freeze: `seatPlanFamilyConflicts` refuses a plan where a review seat shares a model family with any first-pass or fix seat;
- at selection: `selectReviewSeat` and the new `selectPreMergeSeat` (SR1c) skip any seat sharing a family with an implementer model of the lane;
- at acceptance: R1's per-(reviewer, kind) rules and conductor D10.

**`fleet_seat_assignments`** (SR8) reads attempts for implementer seats and review receipts for review seats, which needs the same consumer-side read of review receipts as §3.5.7. For each role and round it returns the seat and `familyCheck: pass | conflict | unknown`. `unknown` appears only when an implementer attempt has neither a ran nor a bound model, or a review has neither a request nor a receipt naming its seat.

#### 3.5.7 One selector and one fact gathering

```
PreviewSeatSelectionUseCase ─┐
CommitSeatSelectionUseCase  ─┤──► gatherSeatSelectionFacts (application helper)
ReadSeatAssignmentsUseCase  ─┤        plan · lane history · ticket · cooling · busy · review receipts per (reviewer, kind)
K4 / K5 facts supplier      ─┘──► selectSeat / selectReviewSeat / selectPreMergeSeat (pure, domain)
```

- `gatherSeatSelectionFacts` lives in `work-execution`'s application layer from its first commit. K4 and K5 call it; their briefs say so. A test asserts that the conductor's seat fact and a preview for the same lane at the same instant name the same seat.
- **Reviews honour D10 and the one retry.** For a review preview the input names the review `kind` (`brief-check`, `code-review` or `pre-merge`) and the lane. The helper reads the receipts and requests per (reviewer, kind) at the lane's current head, through the consumer-side read the conductor's K5 uses (PC's `ReviewRequestPort` and the receipts behind `AcceptanceEvidencePort`; OT2b's `AcceptanceReceiptReadPort` if it lands first). The rules match `LaneRunReviewFact`:
  - a recorded `fail` at this head for this kind pins the same seat: `outcome: pinned`, `reason: recorded-fail`. If that seat is unavailable, the outcome is `exhausted` with that reason, never another seat;
  - a request that ended with no receipt and has `retries: 0` pins the same seat once: `outcome: pinned`, `reason: retry-once`; after the retry, normal selection resumes;
  - otherwise, normal selection.

  Before RW1, receipts carry no `kind` and read as `code-review` (conductor §3.4).
- The plan comes from the attempt's frozen `seatPlan` when a lane exists, otherwise from the installation through a new out-port, `SeatCatalogPort`. Its adapter takes a structural subset of the installation (the `AllowedSeatAdapter` pattern), and `seatPlanFromInstallation` moves into it from `apps/cli` (SR4a1).
- `attempt next-seat` is re-pointed onto the preview use case. Its outputs are unchanged except for the implementer-model fix of §3.5.6, which has its own test.

**The answer** of `fleet_seat_next` (and `fleet-v2 seats next --json`):

```json
{ "asOfIso": "2026-10-27T17:40:00Z",
  "input": { "projectId": "…", "role": "review", "kind": "code-review", "workOrderId": "…", "round": 1 },
  "outcome": "selected",
  "seat": { "id": "rv-a", "tool": "review-cli", "model": "<model id>", "agent": null, "variant": null,
            "costClass": "plan-quota", "billing": "unknown" },
  "fallbackChain": [ { "id": "rv-b", "on": null, "costClass": "paid", "billing": "metered" } ],
  "skipped": [ { "id": "rv-b", "reason": "cooling", "until": "2026-10-27T18:40:00Z" },
               { "id": "rv-c", "reason": "cooling-observed", "observationId": "…" } ],
  "ticket": { "read": 41, "revision": 41, "advisory": true },
  "startingSeatLine": null }
```

`outcome` is `selected`, `pinned` (with `reason`), `exhausted` or `refused` (no plan, invalid plan). `startingSeatLine` is the brief's "Starting seat" line for implementer roles.

#### 3.5.8 Billing

- `costClass` is the owner's claim about how a seat is paid (`free`, `plan-quota`, `paid`). `billing` says what recorded figures mean: `billingOf(seat.tool)` from `@fleet/shared` (`metered`, `plan`, `unknown`).
- **Precedence:** `billing` decides how a figure is labelled (spend or estimate), because it describes the data; `costClass` decides selection policy (free-seat rules). Neither overrides the other.
- When they disagree on a runner seat (`plan-quota` with `metered`, or `paid` / `free` with `plan`), the preview and assignments emit `billing: mismatch` with both values, and the figure reads as unknown, never as spend.
- Every `fallbackChain` entry carries both. Plan-billed figures are estimates, never spend.

#### 3.5.9 Closing the hand-picked model gap

`brief prepare --seatPlanFromInstallation --firstPassSeat auto` (SR5a) commits a first-pass seat through `CommitSeatSelectionUseCase` for the work order's project, fills `--modelAssignment` and `--seatTool` from it, and refuses when the result is not `selected`. The explicit form keeps working, and the existing check that the assignment matches a first-pass seat of the frozen plan is unchanged. The orchestrator then reads `fleet_seat_next` to see what is coming, and lets `auto` take it.

### 3.6 The hexagen work

**What hexagen can do today.** The template engine has no loops, so it cannot emit a file per tool. `hexagen sync` generates stubs per bounded context only, and its apps generator writes four kinds of file through flat interpolation. An existing file without an `@generated` header is skipped, never overwritten. So per-tool generation for an app is new hexagen work, and whether it is wanted is hexagen's call (it owns the contract).

**Order of the work orders (owned by hexagen-monaco):**

| Work order | What | Why fleet-v2 needs it |
|---|---|---|
| **HM2, filed first, as a question** | Will hexagen accept an app-level `mcp` manifest section with `binding: http-client` and a `route:` field per tool (tools bound to an in-port name for validation, served over HTTP), or only in-process tools bound to in-ports? Would it generate app-scoped tool stubs (today stubs are per context)? What would a generated tool table import from a tool file (a named export, a default export)? The answer decides HM1's extra files and HM3's shape | Without the answer, fleet-v2 cannot lay out `apps/mcp` for adoption |
| HM1 | An `mcp-stdio` app framework: a `BUILTIN_FRAMEWORK_TEMPLATES['mcp-stdio']` entry (`package.json` with the MCP SDK and zod, `tsconfig` with `rootDir: src`, entry `src/bin.ts`, extra files per HM2's answer) and the `AppFramework` union; the wizard's framework list | `apps/mcp` declared in the manifest instead of hand-placed; fixes the `rootDir` mismatch M1a reported |
| HM3 | Per HM2's answer: the manifest section and its validation in `hexagen arch validate` (the port exists in the context's `ports.in`; names unique and matching `^[a-z][a-z0-9_]{0,63}$`; a mutating tool declares `dryRun: true`; every scope declared); app-scoped tool stubs from an overridable `mcpTool` stub template, `createOnlyIfMissing`; a `@generated` tool table; `sync --check` (and `--json`) reports drift; the consumer-contract entry (H3) | `yarn sync` keeps tool stubs and the table in step with the manifest |
| HM4 | A linter rule for MCP apps in `@hexagen-monaco/sync` (`src/linter.ts`, `arch-linter-bin.ts`): an `http-client` app imports no context package; an in-process app's tools import only application in-ports. A refresh of the `mcp-server` template (annotations, scope field, dry-run and digest helper) | `lint:arch` checks the boundary in §3.1 |
| HM-R | A release with HM1 and HM3; the **first release that also carries H1 (`generator.name`) and H2b (`sync --check --json`)**, both merged but unreleased | fleet-v2 pins `0.14.0` and adopts only published releases |

**Adoption (MX9).** Through a pin-bump pull request (hexagen integration plan §2.4, F7 template). The bump also brings H1 and H2b, so MX9 runs `hexagen manifest migrate` if the release needs it, and F-lane checks run against the new version. `apps: mcp` and its section go into the manifest, the `mcpTool` override is added, and `yarn sync` runs. Because sync skips hand-written files, the existing `apps/mcp/src/registry.ts` survives. If the generated table's names or exports differ from it, MX9 adds a one-file shim that re-exports the generated table under today's names, rather than rewriting tools.

**fleet-v2 does not lay out ahead of the answer (D2).** MX1 keeps today's single `registry.ts` and only adds `kind`, `scope`, annotations and tests. No pre-emptive file layout.

**What stays fleet-v2's:** the tool bodies (each calls one route), the routes, the use cases and ports, the seat policy and stores, and the `mcpTool` override.

### 3.7 Security

- **Nothing secret in or out.** No tool input accepts a path, URL, host, token or command; schemas are strict (`z.strictObject`), so an extra key is refused. The client never puts the token or the URL's userinfo in an error.
- **Projection, not pass-through.** MCP tools return a projection of each envelope, not the envelope. `fleet_attempt` and `fleet_attempt_list` return ids, states, timestamps, outcome, `stopReason`, the seat (id, model, tool, variant, agent) and usage numbers. They drop the worktree path and every runner host field. `fleet_attempt_journal` returns action, status, time and `stopReason`, and drops `detail`, which can embed a runner's refusal text. A test per tool asserts the dropped fields are absent.
- **The telemetry never-send list applies to anything new.** New routes serve ids, enums, counts, digests, seat ids and model ids, never a brief body, diff, lane output, review text, file path or host name (telemetry plan §3.2). `fleet_brief_preview` returns digests and the seat plan, never the brief's prose. It returns the acceptance spec only as a projection: `commitRequired`, `diffCheck`, the command count, and one SHA-256 digest per command's argv. It never returns an argv element, an owned path or an allowed path prefix; those can name files and commands of the project. A test feeds a spec whose commands and paths carry marker strings and asserts that no marker appears anywhere in the preview's route response or tool result.
- **Scopes per tool.** Each registry entry declares its scope. A test asserts the set is within `read` and `message`. Once T3a lands, the API enforces them. Until then the MCP server holds the shared bearer, the 2026-10-16 constraints hold (orchestrator's machine only, no HTTP, ignored `.mcp.json`), and no mutating tool ships (D10).
- **Tool results are data, never instructions.** Text a lane, a reviewer or a project wrote (question context, finding summaries, notes) comes back only as a typed field with its `source`. Server and tool descriptions say so. Only an `owner-message` entry with a verified session counts as the owner's words (orchestrator plan §4.5).
- **Seat steering is bounded.** An observation cools a seat only under §3.5.5's rules, only when the owner opts in, and visibly.
- **Rate limits (D13, MX6a).** A token bucket per tool in the MCP process: reads 60 per minute, mutating tools 6 per minute, at most one `fleet_owner_answer_wait` in flight. Over the limit, the tool answers `isError` with `rate-limited`.
- **Audit.** Every mutating call lands as a record with `via: "mcp"` and the bound session id, and the request channel journals under `request/<requestId>`. Reads are not journaled. The MCP process writes nothing to stdout but the protocol, and one line to stderr on a fatal start error.

## 4. Workbook

Each lane is about 45 minutes, one pull request, the standard pipeline. **Parallel** means different packages, no shared file (notably `.architecture/manifest.yaml`, `apps/cli/src/composition.ts`, `apps/cli/src/index.ts` and `apps/api` composition), and room in the host-wide gate budget. Manifest lanes merge one at a time, rebased. All `apps/mcp` lanes run one at a time.

### 4.1 hexagen-monaco (work orders filed there; that repository's session plans and runs them)

| Lane | Scope | Package | Tier | After |
|---|---|---|---|---|
| HM2 | The question of §3.6, filed as an issue or a planning note | hexagen docs | 0 | — (**file now**) |
| HM1 | `mcp-stdio` framework entry and union | hexagen `sync`, `wizard-orchestration` | 2 | HM2's answer |
| HM3 | Manifest section, validation, app-scoped stubs, tool table, drift | hexagen `sync` | 2 | HM2's answer, HM1 |
| HM4 | Linter rule; `mcp-server` template refresh | hexagen `sync` (linter), `template-engine` | 2 | HM3 |
| HM-R | Release with HM1, HM3, H1 and H2b | hexagen | 0 | HM3 |

### 4.2 fleet-v2: seats

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| SR0 | This plan; the owner's decisions | docs | 0 | — |
| SR1a | `no-route` in `STOP_REASONS` and `MODEL_REFUSAL_CLASSES`; `classifyRunnerRefusal` patterns; a test per pattern and that stored records without it still parse | work-execution (domain `StopReason.vo.ts`, `seat-selection.ts`) | 2 | — (**now**) |
| SR1b | `rotationStart` and `unavailable` on `selectSeat` and `selectReviewSeat`; pure `coolingSeatIds(attempts, observations, nowIso, policy)` with the one-per-window rule; `SeatTicketRecord`, `SeatObservation` and the ticket on `seatSelection` (version 1); a test that omitted inputs reproduce today's selections | work-execution (domain `seat-selection.ts`, `execution-records.ts`); sync barrel | 2 | SR1a |
| SR1c | `selectPreMergeSeat` over a plain chain, family-checked against every implementer model from `historyEntryOf` | work-execution (domain `seat-selection.ts`) | 2 | SR1b |
| SR2 | `policy.seats` (`rotate`, `cooldownMinutes`, `observationCooldownMinutes`): parse, validate, write, resolver | installation | 1 | — (**now**, one installation lane at a time: K2, KWp, WB6p) |
| SR3 | `SeatTicketRepositoryPort` and `SeatObservationRepositoryPort`; file stores (`seat-tickets.json` with compare-and-swap, `seat-observations.json` append-only, both refusing `.` and `..`) and memory stores; `state check` covers both | work-execution (application ports, infra), **manifest** | 2 | SR1b |
| SR4a1 | `SeatCatalogPort` and its structural adapter; `seatPlanFromInstallation` moved out of `apps/cli`; a parity test against today's CLI output | work-execution (application port, infra), apps/cli (`seat-plan.ts` removed), **manifest** | 2 | SR2 |
| SR4a2 | `gatherSeatSelectionFacts` (plan, history via `historyEntryOf`, ticket, cooling, busy, review receipts and requests per (reviewer, kind) at the head); `PreviewSeatSelectionUseCase` (with `kind`, `pinned`), `ReadSeatCatalogUseCase`; the "preview writes nothing" test | work-execution (application), **manifest** | 2 | SR3, SR4a1, SR1c; the review-receipt read reuses PC's port if PC has merged, else adds the consumer-side read PC will use |
| SR4b | CLI: `seats next`, `seats show`, `seats take`; `attempt next-seat` re-pointed onto the preview, with the §3.5.6 fix | apps/cli, **`index.ts`, `composition.ts`** | 2 | SR4a2, SR5a (for `take`); in sequence with the other `composition.ts` lanes |
| SR5a | `CommitSeatSelectionUseCase`: one compare-and-swap per commit, the seat chosen over the available list (§3.5.3); the durable ticket write before the record that names the seat, the ticket recorded on it, and the corrupt-store refusal; tests: two concurrent commits get different tickets, the cooling-seat cases of §3.5.3, and the crash between the two writes in both orders; `PrepareBriefPackage` commits when `auto`; `brief prepare --firstPassSeat auto` | work-execution (`PrepareBriefPackageUseCase`, application), apps/cli, **manifest** | 2 | SR4a2; in sequence with BP1 and AM2 (same use case) |
| SR5b | `PrepareFixAttempt` commits a ticket for a lane's first fix attempt | work-execution (`PrepareFixAttemptUseCase`) | 2 | SR5a; **before K4** |
| SR6 | `RecordSeatObservationUseCase` with §3.5.5's subject checks; `seats observe` in the CLI | work-execution, apps/cli (**`index.ts`, `composition.ts`**), **manifest** | 2 | SR3; in sequence with SR4b |
| SR7 | Routes `GET /v1/seats`, `GET /v1/seats/next`, `GET /v1/work-orders/:id/seats`, `POST /v1/seats/observations` (with `dryRun`); route scopes declared for T3a. Builds A-S's read route; A-S keeps only W9 | apps/api (**`composition.ts`**, routes), **manifest** | 2 | SR4a2, SR6, SR8; in the web plan's `composition.ts` sequence |
| SR8 | `ReadSeatAssignmentsUseCase` (§3.5.6) | work-execution (application), **manifest** | 2 | SR4a2 |
| BP1 | `dryRun` on `PrepareBriefPackage`: validate and compute the would-be manifest, digest and seat plan; take no ticket; write nothing (byte-identical stores test); the dry-run result carries the acceptance spec only as §3.7's projection, with the marker-string test | work-execution (`PrepareBriefPackageUseCase`) | 2 | — (**now**, if no other lane holds that use case) |

**Queue position among the other plans' work-execution lanes.**
- SR1a–SR1c edit `seat-selection.ts`, `StopReason.vo.ts` and `execution-records.ts`, which no K1-2 lane touches. They queue behind any in-flight lane on `execution-records.ts` (WB5a, WB5b, the telemetry OT lanes when they add fields), one at a time.
- **SR4a2 should merge before K4**, so K4 calls `gatherSeatSelectionFacts` instead of building its own; if K4 goes first, SR4a2 extracts K4's gathering (§7).
- SR5a shares `PrepareBriefPackageUseCase` with BP1 and AM2, and SR5b shares `PrepareFixAttemptUseCase` with S1b's refusal-to-fix, so each runs in sequence with those lanes.
- SR3, SR4a1, SR4a2, SR5a, SR6, SR7 and SR8 edit the manifest and merge one at a time with the conductor's, the board's and the web plan's manifest lanes.

### 4.3 fleet-v2: the MCP app (one lane at a time in `apps/mcp`)

| Lane | Scope | Package | Tier | After |
|---|---|---|---|---|
| MX1 | Today's `registry.ts` gains `kind`, `scope` and annotations per entry; tests: the names are exactly the registry's list, scopes are within `read` and `message`, strict schemas refuse extra keys. No new layout | apps/mcp | 2 | — (**now**) |
| MX2 | Read tools over existing routes with the §3.7 projections: `fleet_work_order`, `fleet_attempt`, `fleet_attempt_list`, `fleet_attempt_journal`, `fleet_head_evidence`, `fleet_question_list`, `fleet_question`, `fleet_project_list` | apps/mcp | 1 | MX1 |
| MX3 | `.mcp.json.example`, `.mcp.json` ignored, runbook section (the 2026-10-16 M4) | apps/mcp, docs | 1 | MX2 |
| MX4 | `fleet_seat_catalog`, `fleet_seat_next`, `fleet_seat_assignments` | apps/mcp | 2 | MX1, SR7 |
| MX5a | `fleet_lane_run_list`, `fleet_lane_run`, `fleet_conductor_status` | apps/mcp | 1 | MX1, A-R, A-C, K7 |
| MX5b | `fleet_board`, `fleet_board_lane`, `fleet_reaper_finding_list`, each when its route exists | apps/mcp | 1 | MX1, WB8, WB8w, A-F |
| MX6a | The first mutating lane: the dry-run and preview-digest helper, `validated: server \| schema-only`, the per-tool rate limiter; `fleet_seat_observe` | apps/mcp | 2 | MX1, SR7, T3a |
| MX6b | `fleet_request` (dispatch, lane-run, fix, resume and review kinds) | apps/mcp | 2 | MX6a, O2c, O3, O3-dry, T3a |
| MX6c | `fleet_owner_ask`, `fleet_owner_answer_wait`, `fleet_context_propose` | apps/mcp | 2 | MX6a, T3a |
| MX7 | `fleet_brief_preview` and `POST /v1/briefs/preview`, serving only BP1's projection (the marker-string test repeated at the route and the tool) | apps/mcp, apps/api (**`composition.ts`**) | 2 | BP1, MX1; joins the `apps/api` `composition.ts` sequence SR7 names (the web plan's sequence), never beside SR7 or another lane on that file |
| MX8 | `fleet_telemetry_status` and its route | apps/mcp, apps/api | 1 | OT4b |
| MX9 | Adopt HM-R (§3.6): pin bump, migrate if required, `apps: mcp` with its section, the `mcpTool` override, `yarn sync`, a shim if names differ; `sync:check` and `lint:arch` pass | manifest, apps/mcp, `package.json` | 1 | HM-R, MX1 |

**MX9's order against the other MX lanes.** MX9 runs as soon as HM-R is released, whichever MX lanes have merged by then, and declares in the manifest's `mcp` section every tool already in `registry.ts`. From the moment MX9 merges, **each later MX lane adds its own tool to the manifest section** in the same pull request, and `sync:check` must pass. That makes those lanes manifest lanes: they merge one at a time with the other manifest lanes, rebased. MX9 does not wait for MX2–MX8. MX8 depends on OT4b and could be far off, and waiting would leave every merged tool undeclared.

**Filed against the web UI plan:** **O3-dry**, `dryRun: true` on `POST /v1/requests` (§3.4.2). It is about one lane in O3's files, after O3.

**Can start now:** SR2 (when no other installation lane is running), MX1, the HM2 question, and SR1a or BP1 (both in `work-execution`, different files; one or both as the gate budget allows). SR0 is this document.

**Critical path to `fleet_seat_next` in an agent's hands:** SR1a → SR1b → SR1c → SR3 → SR4a2 (with SR4a1 after SR2) → SR8 → SR7 → MX4. `seats next` in the CLI (SR4b) arrives two lanes before MX4.

## 5. Hard to undo

- **Tool names and input schemas** become an interface that agents' configurations and prompts depend on. A rename needs an alias for one release.
- **`policy.seats` keys** become installation data the owner edits; versioned through the installation schema like every policy block.
- **`SeatTicketRecord`, `SeatObservation` and the ticket on `seatSelection`** become stored data. Each carries `version: 1` from its first commit.
- **The `no-route` stop class** becomes stored data on attempts and a value the web and telemetry read. It is additive; removing it later would leave records that read as `unknown`.
- **hexagen's MCP manifest section**, once released, is hexagen's contract and every consumer's. fleet-v2 asks for it; hexagen owns its shape and migrations.
- **The scope set of the MCP token** (`read`, `message`). Widening it is a security decision for the owner, never a lane's.

None of these is a one-way door in the sense of a merge, a push or a data deletion. Each is a format other code will depend on.

## 6. Decisions for the owner

| # | Question | Recommended default |
|---|---|---|
| D1 | Does `apps/mcp` stay a client of `/v1`, or compose use cases in-process? | **Client of `/v1`** (§3.1) |
| D2 | Generate `apps/mcp` through hexagen, and how far does fleet-v2 go before hexagen answers? | **Through hexagen, HM2 first as a question.** fleet-v2 builds tools in today's `registry.ts` and adopts the release in MX9, with a shim if needed |
| D3 | Rotation state (this settles conductor D8) | **A monotonic ticket per (project, role), taken under compare-and-swap when a seat is committed** (first pass at prepare with `auto`, a lane's first fix at prepare-fix, review at request). The seat is `available[ticket mod available.length]` over the seats available at commit, and the ticket is durable before the record that names it. Previews and dispatch never write. *Alternative:* derive the start from the latest committed `seatSelection` with no store; rejected because parallel preparations would freeze the same seat |
| D4 | Is rotation opt-in per role? | **Yes:** `policy.seats.rotate`, absent = fixed order; this installation sets `first-pass`, `fix` and `review` |
| D5 | Cross-lane cooling after a model refusal recorded on an attempt | **60 minutes** (`cooldownMinutes`), derived, never written into the installation's `health` |
| D6 | Busy seats | **In v1, narrowly:** busy only when every host of the seat's runner kind is at `maxLanes`; unreadable is `unknown`, not busy; a busy seat is skipped, never waited for |
| D7 | May observations cool seats? | **Only under §3.5.5's rules, and only when the owner sets `observationCooldownMinutes` above 0** (default 0, off); CLI first, MCP after T3a |
| D8 | Pre-merge seat | **Selected and committed at request time from `chains['high-risk-reviewer']`**, family-checked; no `SeatPlan` v2 now |
| D9 | Add `no-route` as a stop class | **Yes** (additive) |
| D10 | When do mutating tools ship? | **After T3a.** Read tools now on the shared bearer under the 2026-10-16 constraints |
| D11 | Dry-run validation | **Server-side where the route can** (`POST /v1/seats/observations`, and `POST /v1/requests` through O3-dry); `validated: schema-only` stated elsewhere; the preview digest is echoed for every write |
| D12 | How does MCP ask for a review? | **Through the request channel (`request-review`)**, never `POST /v1/reviews` |
| D13 | Rate limits | **Reads 60/min per tool, mutating 6/min per tool, one answer-wait in flight** |
| D14 | Overlap with A-S | **SR7 builds the seat read routes; A-S keeps only W9** |
| D15 | HTTP transport | **Not in this plan** |
| D16 | Tool naming | **`fleet_<singular noun>[_<facet>]`, lists as `_list`** |
| D17 (new) | Billing disagreement on a runner seat | **Emit `billing: mismatch` with both values; figures read as unknown**, never as spend (§3.5.8) |

## 7. Assumptions, open questions and what is unverified

- **Assumed:** O2c, O3 and O3-dry land as described. If O3-dry is declined, `fleet_request` reports `validated: schema-only` like the other mailbox tools, and D11 still holds.
- **Assumed:** K4 and K5 can be briefed to call `gatherSeatSelectionFacts`. If K4 merges first with its own gathering, SR4a2 extracts it from K4 instead, and the "same seat" test is added there.
- **Unverified:** whether rounds driven by `bin/agy-round` outside `DispatchAttempt` take a capacity reservation. If not, `busy` cannot see them and the selector may name an occupied agy seat. Dispatch then refuses or queues as today. SR4a2 checks this first and raises it to the owner if the answer is no.
- **Open, for hexagen (HM2):** an `http-client` binding and `route:` field, app-scoped stubs, and what a generated table imports.
- **Open:** whether a seat with `costClass: plan-quota` and a non-runner tool should read `billing: plan` rather than `unknown`. This changes `@fleet/shared` and the web chips, so it is not decided here.
- **Unverified:** which MCP clients honour tool annotations and elicitation. Nothing depends on them.
- **Unverified:** hexagen `origin/main` was read from the local clone at `f071763`, not fetched.
- **Assumed:** one state directory per installation, as the conductor assumes; the ticket store is per installation, keyed by project.

## 8. Revision notes

- **rev 0 (2026-10-27).** Drafted from the research named in the header.
- **rev 1 (2026-10-27), after a Fable review of rev 0 (one blocker, six majors, four minors). All applied:**
  1. **Blocker:** the cursor advanced at dispatch is replaced by a monotonic ticket taken under compare-and-swap when a seat is committed (prepare with `auto`, a lane's first fix, the review request). Previews and `DispatchAttempt` never write; a "preview writes nothing" test was added. The no-store derivation is the alternative in D3 (§3.5.3, SR5a, SR5b).
  2. Review previews take a `kind` and honour D10 and the one retry (`pinned`: `recorded-fail`, `retry-once`) from per-(reviewer, kind) receipts at the head (§3.5.7).
  3. Implementer models come from `historyEntryOf` (ran, else bound); `familyCheck` is `unknown` only when both are absent; SR8 reads review receipts (§3.5.6).
  4. Observations cool a seat only when bound to a matching, result-less attempt or review request, once per seat per window, visibly, and only with `observationCooldownMinutes` above 0 (default 0); CLI first (§3.5.5, D7).
  5. Dry runs are validated by the server where possible (observations route; O3-dry filed for `/v1/requests`), else marked `schema-only`; O2c added to MX6b (§3.4, D11).
  6. The hexagen section is corrected to what sync does today (context-scoped stubs, a flat apps generator, skipping hand-written files, the linter inside `sync`, H1 and H2b unreleased). HM2 is filed first as a question; MX1 keeps `registry.ts`; MX9 may add a shim (§3.6).
  7. SR1 and SR4a are split; the rate limiter and digest helper move to MX6a; the queue position against other plans' lanes is stated; MX5a depends on A-C; the "start now" set is revised (§4).
  8. `busy` is defined as every host of the seat's runner kind at `maxLanes`, else `unknown` (D6).
  9. The precedence between `costClass` and `billing` is stated, with `billing: mismatch` (D17); fallback entries carry both (§3.5.8).
  10. MX2 projects away worktree paths, host fields and journal `detail` (§3.7).
  11. Observations are `message` scope; the MCP token stays `read` and `message` (§3.3).

  Also adopted: `asOfIso`, the ticket read and echoed inputs in the preview's answer; singular tool-name nouns; §2 notes the existing `seats` command group, which SR4b extends.
- **rev 1.1 (2026-10-27), after a Grok 4.7 re-check of rev 1.** The blocker and the six majors were confirmed resolved. Four new findings, all applied:
  1. **Major:** skipping unavailable seats did not consume tickets, so consecutive tickets could land on the same seat. The seat is now `available[ticket mod available.length]` over the seats available at commit time: one compare-and-swap per commit. Taking tickets until one lands on an available seat was considered and rejected (one compare-and-swap per skipped seat, burnt tickets). Fairness is stated, with tests for one cooling seat and two parallel commits (§3.5.3, §3.5.4, SR5a, D3).
  2. **Major:** ticket durability order. The ticket write is durable before the brief or attempt that names the seat, which records the ticket. A crash between them leaves a harmless gap, never a reuse. A record whose ticket is at or above the stored counter is treated as corruption and refused, with an attention item. Crash tests cover both orders (§3.5.3, SR5a).
  3. **Minor:** MX9 runs when HM-R is released and declares every tool already present; each later MX lane adds its own manifest entry and joins the manifest sequence. MX7 joins the `apps/api` `composition.ts` sequence (§4.3).
  4. **Minor:** `fleet_brief_preview` returns the acceptance spec only as a projection (flags, command count, per-command digests), never an argv element or a path, with a marker-string test (§3.3, §3.7, BP1, MX7).

  No decision changed in substance; D3's text now names the available-list choice and the durability order.

## Challenge this

Whether cross-lane rotation belongs in fleet-v2 at all. It spreads quota and rate limits across seats, but the next lane's seat then depends on what other lanes did, which is harder to predict and to replay. The alternative is no ticket: every lane starts at the first seat, cooling does the spreading, and the owner reorders chains when he wants another default. A reviewer should test whether cooling alone gives most of the parallelism the owner asked for, with one store fewer.

Whether the MCP server should reach seats through `/v1` at all. A seat preview is a pure function of the installation and the records, and `fleet-v2 seats next --json` (SR4b) answers without the API running. A reviewer should ask whether agents should simply call the CLI for seats, and whether MCP earns its place there before T3a's scopes exist.
