# Plan: web UI interactivity with lanes and orchestration

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 3.2. Rev 1 applied Fable's review of the research; rev 2 added the orchestrator
  request channel (§3.6) and the live tail (§3.7) from Fable's design review; rev 3 applied Grok
  4.7's review of rev 2, rev 3.1 its re-review, and rev 3.2 CodeRabbit's review (§7). Decisions in §5 are open with defaults. Nothing built. Anchors checked against `main` at `dae491f`.
  Amended 2026-10-27 by the conductor plan's amendment K-GC (§3.3 note, A-F and W7c): two run-stop
  keys, the `stop-already-forced` refusal, "Stop now", and a read-only view of the reaper's findings.
- **Owner requests (2026-10-27):**
  - "Given all of the fleet-v2 features and functionality, the UI lacks interactivity with the
    actual lanes, and orchestration. Run a sub-agent to research UI/UX improvements. The have Fable
    review it. Finally create a plan with the proposed improvements."
  - "What do you think of web being able to dispatch if a fleet-orchestrator is actually
    registered? That would mean developer runs claude, agy, opencode, etc. within the fleet-v2 repo
    and the orchestrator agent is running."
  - "One thing I'd like in the UI is for the ability to tail -f logs, meaning live view what's
    going on with the agents and lanes, etc. Maximum visibility."
- **Builds on:** `2026-10-27_conductor-plan.md` (K1–K9, `LaneRun`, keyed journal, D2, D9),
  `2026-10-24_live-updates-and-state-resilience-plan.md` (E3b, E3c, E4, E5),
  `2026-10-18_orchestrator-interaction-plan.md` (T2a, T2b, T3a, T3b, T4, T5, T6, T7, T9),
  `2026-10-16_owner-questions-in-ui.md` (Q1b, Q4, Q5), `2026-10-16_onboarding-settings-ui.md` (U3),
  `2026-10-20_auto-merge-policy-plan.md` (AM3b) and `2026-10-26_vacuous-pass-and-review-dissent-plan.md` (R2).

## 1. The problem

The backend registers work orders, freezes briefs, reserves capacity, dispatches, reconciles,
stops, collects, reads usage, prepares fix rounds, requests acceptance, records verifications and
reviews, disposes findings and runs authorised forge actions. The web reads one live list and two
project views, and every button it has records intent in browser state only. It cannot see
whether an orchestrator is working, and it cannot show what a lane is doing while it runs.

| Area | Backend | Web today |
|---|---|---|
| Lane list | `GET /v1/attempts` rows carry the whole `AttemptRecord` (`ListAttemptsUseCase` returns `{ attempt, workOrder, reservation }`; `usage` at `packages/work-execution/src/domain/execution-records.ts:156`) | `/lanes` is live, but the mapper drops usage, runner and artifacts (`apps/web/src/app/lanes/map-attempt.ts`, `parseAttempt` lines 54–88) and sets `cost: null` (`:245`). Runner facts render as `unknown`, including the recorded `kind`, `agent`, `model`, `variant`. |
| One attempt | `GET /v1/attempts/:id`; `InspectAttemptUseCase` answers `found`, `not-found` or `unknown` when the recorded host cannot be resolved (`InspectAttemptUseCase.use-case.ts:41-52`) | Live rows cannot open a page: `liveViewHref` returns `null` for recorded rows (`apps/web/src/app/lanes/derive.ts:114-115`), so the row says "no live view" (`components/lane-row.tsx:70-80`). `/attempt` is fixture-only (`app/attempt/attempt-client.tsx:5`). |
| Action history | Journal stored (`execution-records.ts:205-212`, `journal.json` through `ExecutionJournalAdapter` `:147-179`); `listJournalEntriesForAttempt` (`ExecutionJournalPort.out-port.ts:96`) | No route, no view |
| Work orders | `GET /v1/work-orders/:id`; repository port `listWorkOrdersByProject` (`WorkOrderRepositoryPort.out-port.ts:18`), no list use case or route | Only inside the fixture |
| Brief | `PrepareBriefPackage` composed, not routed | `/brief` is fixture-only; its client FNV hash is labelled `sha256:` (`app/brief/page.tsx:18`) |
| Questions, attention | `GET /v1/questions`, `/v1/attention`, `/v1/coordination` | No questions view; the attention card derives items from attempts and links to a fixture |
| Capacity | Reservations on list rows | Card says "slot budget not served" |
| Attempt actions | Routes for reconcile, stop, artifacts, fix, acceptance | Fixture buttons behind `AlertBox`; confirm only sets React state |
| Dispatch | `dispatchAttempt`, `reserveExecutionCapacity`, `prepareBriefPackage` composed but unrouted | Fixture "Dispatch" |
| Orchestrators | Nothing records that an orchestrator agent is running | Nothing |
| Live activity | Runner `inspectSession` returns status only (`ExecutionRunnerPort.out-port.ts:51-57,164-170`); no event read anywhere; the usage adapter never reads content (`OpencodeDbUsageAdapter` `:9,:60`); lane logs exist on the lane host (`bin/ocm-run:832-835`, `bin/agy-run:38-46`) and no port reads them; gate and review output is read after exit only (`VerificationExecutorAdapter` `:57,96,202`; `OcmReviewTransport` `:85,228,312-317,425`) | Nothing |
| Changes | In-process `ChangeFeed` (`apps/api/server/wiring/runtime.ts:286`; kinds `attempt`, `capacity`, `work-order`, `question`, `profile`, `resync`), not served | 30 s visible-tab refresh (`apps/web/src/app/lanes/use-auto-refresh.ts:33`) |
| Runs | Conductor planned (K1–K9); no `/v1/runs` | Nothing |
| Writes | One full-power bearer (`apps/api/server/middleware/security.ts`); no scopes | `apps/web/src/lib/api-client.ts` has GET methods only; no Next route handlers, no proxy, no session |

Two foundations are missing and already planned: a web write path (T3a scopes, T3b/T6 session and
proxy) and served change signals (E3b, E3c, E5). The conductor adds the object the UI should be
organised around, the lane run. Two pieces are new in this plan: a request channel from the web to
a registered orchestrator, and a live tail. Much of the value needs neither foundation: the read
side can be made live now.

## 2. Principles

1. **AGENTS.md web rules hold.** Every action that would change something opens `@fleet/ui`'s
   `AlertBox` and waits for an explicit confirm. The body says what the action does, what it does
   not do, and whether a live route exists. No optimistic update: the typed outcome envelope and
   the next read are the truth. Navigation and view controls (filters, row select, drawers, theme,
   the tail's Follow toggle) stay immediate.
2. **One source of truth.** State comes from the API's use cases: the conductor's `LaneRunRecord`
   and keyed journal for runs, the attempt record and journal for attempts. The web never computes
   legality itself. A "not offered, and why" list comes from the server (K1's pure decider), not
   from a second table in the web.
3. **The web never dispatches and carries no authority.** It records a typed request. A registered
   orchestrator with a live lease claims it and acts under its own existing authority, through the
   ordinary use cases and every refusal they already apply (§3.6).
4. **Idempotency is enforced per use case.** The web proxy only mints client ids (a request id, a
   question answer id). Each route's own rule decides what a repeat does (table in §3.4). The API
   does not dedupe on an `Idempotency-Key` header; only `apps/api/server/wiring/knowledge/errors.ts:35-36`
   reads it, as an operation id.
5. **Unknown is never a pass.** A runner that did not answer, a host that cannot be resolved, a
   silent tail or a receipt for another head renders as `unknown`, holds its slot, and disables
   every action whose precondition it is.
6. **Recorded facts render; observed facts are labelled.** `runner.kind`, `agent`, `model`,
   `variant` and `usage` are recorded on the attempt and shown as such. Whether the runner is
   reachable or active stays `unknown` until a reconcile answers.
7. **Lane output is untrusted.** It is model output and may contain client content. It is shown as
   plain text, summaries by default, never persisted by the tail, and every line is secret-scanned
   (§3.7).
8. **Until a write route exists, show the CLI command to copy**, as `/projects` does. Never a
   button that pretends.

## 3. Proposals

### 3.1 Read side, no new foundation

**P1. Live attempt page.** `/attempt?id=` reads `GET /v1/attempts/:id` server side, with the
labelled fixture fallback `/lanes` already uses. Lane rows open it for recorded attempts. The page
shows state, outcome, kind and fix number, session id, completion receipt, artifacts, recorded
runner facts, usage, reviewer seat and owner decision references. `InspectAttempt`'s `unknown`
renders as "recorded host cannot be resolved: holds its slot" with every action hint disabled.
A sidebar shows the attempt's work order (`GET /v1/work-orders/:id`): the work order is what the
owner calls the lane. While E3c is not built, this page refreshes on a shorter visible-tab poll
than `/lanes` (the `intervalMs` parameter of `use-auto-refresh.ts`), never in a hidden tab.

**P1-J. Journal route.** `GET /v1/attempts/:id/journal` over `listJournalEntriesForAttempt`, as a
plain API read: action, status (`intent-recorded`, `completed`, `ambiguous`, `refused`), times,
reason. It carries no `operations` or legality block. Legality arrives later from K1's decider
through the run read model, not from a second table in the API.

**P10. Usage and runner chips (web only).** `map-attempt.ts` keeps `usage`, `runner` and
`artifacts` from list rows. Rows show a seat/model chip and a cost chip; work orders sum their
attempts. `usage.source` is shown (`unavailable` reads "not measured"), and plan-billed seats are
labelled estimates. No API lane: the rows already carry the record. The per-lane cost ceiling is
shown once the conductor's `policy.perLaneCostCeiling` is served.

**P12. Remove false affordances.** The sidebar marks "Attempt" (until P1), "Brief" and "Knowledge"
as **sample**. The `/brief` digest reads "sample digest", not `sha256:`.

**P3-read. Owner inbox (Q4).** A Questions view over `GET /v1/questions` and `/v1/attention` with
an open-count badge, filters for blocking and one-way questions, and links to the attempt or run a
question names. The Lanes attention card reads `/v1/attention` and stops linking to the fixture.
This is the read half of Q4/T7, on the web's existing server-side read path. Once O8 exists, the
inbox also shows the owner's open requests with their lifecycle card.

**P8-read. Work-order and run timeline.** One vertical timeline per work order: attempts grouped
by `workOrderId` and chained by `priorAttemptId` (first pass, fix 1, fix 2), each with its journal
entries and `GET /v1/heads/:sha/evidence` (verification and review receipts, findings,
dispositions, acceptance at that head). It needs no new backend beyond A-J's journal route. R2's `reviewTally` and RW1's
review `kind` are rendered once served; until then the timeline says "not recorded", never
"passed".

### 3.2 Change signals

**P2. Push updates.** E3b serves `GET /v1/changes`; the web's server side reads it with the bearer
in a header and relays only `{seq, kind, id}` signals to the browser over a same-origin stream; the
client re-reads the affected route, debounced, and a `resync` triggers one full refresh. Polling
stays as the fallback (live-updates D3) and E5 adds the offline display.

Conductor D9 refuses a shared-bearer `/v1/changes` reader in a process that holds forge
credentials. The web server holds the bearer server-side (`api-client.ts:139-147`) and no forge
credentials, so D9 is not engaged there. By default (§5, D2) the web server, and only the web
server, may read `/v1/changes` on the shared bearer before T3a; its token is re-scoped to `read` at
T3a. This is the same interim as the tail (D11). This amends the live-updates plan's ordering of
E3b after T3a. Until E3c lands, the attempt page keeps its shorter visible-tab poll. Push updates
are polish: they rank below the inbox, the timeline and the tail.

### 3.3 Run board (conductor)

**P7-read. Run board.** Once K3 lands, `GET /v1/runs` and `GET /v1/runs/:id` (read use cases in
work-execution, manifest entries, routes). The board ships with K7, so the dry-run and shadow
rollout (conductor D4) is observable: one card per lane run with its state, round 0–2, seat per
role, PR number, park reason, lease holder, and a distinct rendering of `would <action>` entries.
Columns group states (implement, gate and review, fix, accept and merge, parked, ended). `parked`
waits for a human and can return to its parked-from state; `ended` holds the terminal states,
`merged` and `stopped`, each shown by its own word, so a stopped run never reads as parked. Each
card shows the state word and an icon, never colour alone. On a narrow screen the board is grouped lists.

**P7-write. Run controls.** The web writes records the CLI driver obeys (conductor D2); it never
drives a step.
- **Halt** is a direct route (K7) that writes the halt marker through the same adapter as
  `conductor halt`. It never depends on a live orchestrator. Body: "parks every run before its
  next external action; does not stop a running lane".
- **Stop** is a direct route (A-C) that writes a keyed run-journal entry `<runId>/stop@web`
  carrying the run's `expectedRevision`. The driver obeys it and stops the running attempt itself
  through `StopAttempt` (conductor §3.2: "a running attempt is stopped first through
  `StopAttempt`"). The web never calls `StopAttempt` for an attempt that belongs to a run. The
  driver maps `StopAttempt`'s outcome as follows:

  | `StopAttempt` outcome | Run | Capacity |
  |---|---|---|
  | `terminated`, `capacityReleased: true` | `stopped` | released |
  | `cancelled` (never started) | `stopped` | released by the cancel |
  | `terminated`, `capacityReleased: false` | `stopped` | slot stays held; one attention item names it; a reconcile releases it |
  | `still-running` or `unknown` | parked, reason `stop-unconfirmed`; the driver retries the stop and reconciles | held |
  | `refused` | parked with the refusal's reason | held |

  The run never shows `stopped` while its attempt may still be running, and a slot is never shown
  as released unless the result confirmed it. `stop-unconfirmed` is a new park reason, not a new
  state (amendment UI-B). Body: "records a stop for run <id>; the conductor stops its running
  attempt <id> and ends the run as `stopped` once the runner confirms; if the runner does not
  confirm, the run parks as `stop-unconfirmed`; does not merge, push, revert or delete anything; a
  stopped run cannot be resumed" (danger tone).
- **Resume** goes through the request channel as `resume-run`. The claimant calls `ResumeLaneRun`,
  which refuses server-side when `parked.reason === 'one-way-door'`, and refuses a `stopped` run
  with the typed reason `run-stopped` (amendment UI-B; a test for each). One-way-door parks are
  answered by the owner's signed decision on the keyed question, not by a button. The request carries the
  run's `expectedRevision`, and the claimant journals it under `<runId>/park/<n>/resume@web`, so a
  repeat is refused by K1b's uniqueness check.

**Amendment K-GC: two stop modes.** Amended 2026-10-27 by the conductor plan's amendment K-GC
(`2026-10-27_conductor-plan.md` §3.9, D11). The text above is unchanged; this note adds to it.
- **Two stop keys.** A-C writes a graceful stop as `<runId>/stop@web` and a forced stop as
  `<runId>/stop-force@web`. The mode is read from the key, and the entry's `mode` must match it. The
  `<runId>/stop@web` entry above now names a graceful stop; the outcome table above is the forced stop's.
- **Graceful (the default, "Stop").** The conductor issues no new action for the run; the running
  attempt may finish, its work is collected and gated and kept on the branch, then the run ends
  `stopped`. Body: "records a graceful stop for run <id>; the running attempt <id> may finish; its work
  is collected, gated and kept on the branch; then the run ends as `stopped`; does not merge, push,
  revert or delete anything; a stopped run cannot be resumed" (danger tone).
- **Forced ("Stop now").** Offered beside "Stop", and while a graceful stop is pending. Body: the
  P7-write stop body above, plus "uncommitted work in the attempt's worktree is abandoned" (danger tone).
- **One way only.** A force may follow a graceful stop; A-C refuses a graceful entry after a force with
  the typed reason `stop-already-forced`, shown verbatim (§6 "Error"). W7b hides "Stop" once a force is
  recorded.
- **On the card.** A run with a graceful stop pending shows "stopping" with its wait reason
  (`stop-draining`, or `stop-grace-exceeded` past the grace); it is not parked and not yet `stopped`.
  Resume stays refused with `stop-pending`.

### 3.4 Attempt actions after the write path

**P5.** Reconcile, stop, collect and request acceptance from the attempt page, through the T6
proxy, behind `AlertBox`. Each control renders only when the server offers it. A fix round and a
review are requests through the channel (§3.6), not direct routes. The direct attempt stop applies
only to an attempt that belongs to no lane run; for an attempt owned by a run, the route refuses
with a pointer to the run, and the page offers the run's stop (P7-write) instead.

| Route | Repeat behaviour (enforced by the use case) | Confirm body must say |
|---|---|---|
| `POST /v1/attempts/:id/reconcile` | Safe to repeat | "Asks the runner whether the session ended, and **ends the attempt record if the server reports the session ended**. Does not stop or restart the lane." It is a write (`ReconcileAttemptUseCase.use-case.ts:121,192,216`). |
| `POST /v1/attempts/:id/stop` | Safe to repeat; refused while the runner is `unknown`; refused with a pointer to the run when the attempt belongs to a lane run | "Stops the session of attempt <id>, which belongs to no lane run; does not collect, merge or delete anything." Destructive tone |
| `POST /v1/attempts/:id/artifacts` | Safe to repeat | Collects against the completion receipt; does not judge the work |
| `POST /v1/attempts/:id/acceptance` | Assessment at a head; repeat re-assesses | Requests acceptance; does not merge |
| Halt (K7 route) | Writing the marker twice is harmless | See P7-write |
| Run stop (A-C route) | Keyed run-journal entry `<runId>/stop@web` with `expectedRevision`; K1b refuses a second one | See P7-write |
| `POST /v1/requests` | Client-minted ULID `requestId`; a repeat POST returns the existing record | See §3.6 |
| `POST /v1/questions/:id/answers` | Q1b's revision and idempotency rules; built as Q5; never through the channel | One-way answers show the bytes to sign; the web cannot sign |
| Owner messages | T2b's idempotency keys; the only path for prose | — |
| `POST /v1/forge` | A grant is consumed once | Not offered from the web this cycle |

**P8-write.** Finding dispositions from the timeline, behind `AlertBox`, after T6.

### 3.5 The write path, modelled on settings-plan U3, built as T3b/T6

U3's session exchange (fragment token, `sessionStorage`, same-origin and `Origin`/`Host` checks,
fixed operation map, no path passthrough) is setup-mode only
(`docs/planning/2026-10-16_onboarding-settings-ui.md:99-118`). The `/v1` write path follows its
shape but is built as T3b (the session exchange minting an in-memory scoped token) and T6 (the
web's same-origin proxy and first write route). The browser never holds the on-disk bearer.

T3a's scopes are fixed at `read`, `message`, `hook`, `verdict`
(`2026-10-18_orchestrator-interaction-plan.md`, line 196). This plan needs three more:
- `operate` for the direct attempt actions and run controls (web session);
- `orchestrate` for registering, heartbeating, claiming and completing requests, held by the MCP
  process's token and the CLI, never by a web session token;
- `tail` for the tail routes (§3.7).

They are filed as one amendment to the orchestrator plan before T3a is dispatched (lane UI-A,
§5 D3), not added inside a web lane. The web posts requests under `message`. No web-minted token
ever gets a `dispatch` scope.

### 3.6 Orchestrator request channel

The owner wants the web to start work when an orchestrator agent (Claude Code, agy, opencode or
another CLI run inside the fleet-v2 repository) is registered and running. The answer is a
mailbox: the web writes a typed request; a registered orchestrator with a live lease claims it and
acts under its own existing authority. The web never dispatches.

**Authority (F1, F2, F3).** The request carries no authority. `OrchestratorRequest` is its own
aggregate in operator-coordination, **not** a `CoordinationKind` (`CoordinationKind.vo.ts:8-13`),
so `ResolveActionAuthorization` and `RecordAuthorizationConsumption` can never read it; this
follows the owner-questions plan's rev-2 reasoning and its non-goal that an answer never approves
forge, acceptance or dispatch. The claimant runs the ordinary `DispatchAttempt` or `StartLaneRun`
with every refusal intact; only ids pass through. Dispatch authority stays what it is today: the
composition root holding the bearer, the frozen brief digest (`DispatchAttemptUseCase.use-case.ts:172`),
the seat fixed by the manifest (`:160`) and the allowed-seat check (`:528-534`). The web posts under
`message`; claim and complete need `orchestrate`, which a web session token never holds (a test
asserts a web session token gets 403 on `/v1/requests/:id/claim`). The research's per-dispatch
grant for the web is dropped. `requestedBy { via: 'web', sessionId }` comes from the session,
never from the body (the `answers.post.ts:14-20` pattern; `owner-question-records.ts:49-50`).

**Payload (F8).** Closed: `{ requestId, kind, projectId, target { attemptId | workOrderId | runId },
requestedBy, createdAtIso, expiresAtIso }`. No note, instructions or seat override. Prose goes
through the T2b owner-message thread. Orchestrator to web: a typed `reasonKind`
(`seat-unavailable`, `capacity`, `brief-stale`, `policy`, `owner-asked-first`, `other`) and an
optional detail of at most 1 KiB, secret-scanned and refused on a hit (as `OwnerQuestion.ts:65`),
rendered as text only.

**Kinds (F5, F11).** Through the channel: `dispatch-attempt` (names a prepared attempt),
`start-lane-run` (names a work order), `prepare-fix` (names only the prior attempt), `request-review`
(a review `kind` enum), `resume-run` (a non-one-way park). A request never says "prepare and
dispatch". Never through the channel: halt, stop, reconcile, collect (direct routes), question
answers (Q5), free text (T2b), forge kinds and one-way doors (`open-pr`, `merge`), installation
writes, state restore. Duplicate safety for dispatch already comes from attempt state, the
`duplicate-attempt` refusal in `reserveCapacityAtomically`, and the runner's busy-worktree exit 75
(`ExecutionRunnerAdapter.adapter.ts:596`).

**Source of truth (F4).** The request is a mailbox entry, not a run record. It ends at
`dispatched` with a link `{ attemptId | runId, journalKey }`; the web derives everything after
that from the linked record. The journal key is `request/<requestId>`; with K1b's uniqueness check
a second claimant's intent fails.

**Crash safety (F6, F12).** `requestId` is a client-minted ULID and the idempotency key; a repeat
POST returns the existing record (the `RequestScopedDecisionUseCase` `:78-83` shape). A claim is a
CAS on the revision (as `OwnerQuestionRepositoryAdapter` `:108-118`) writing
`claim { orchestratorId, fence, leaseUntilIso }`. The claim lease is 2 min, renewed. An expired
claim returns the request to `queued` with `claimCount + 1` and a new, incremented fence; after two
expired claims the request is `stalled` with one attention item (AM3b).

**The fence.** Every claim mutation (renew, complete, refuse, defer) is a CAS on `revision` that
also checks that `claim.fence` equals the caller's fence and that the lease has not expired. A
stale claimant's later mutations therefore fail. Before each external action the claimant:
1. re-reads the request and checks its fence and lease;
2. appends the journal intent under `request/<requestId>` (written before the action, under K1b's
   uniqueness check);
3. acts;
4. appends the result.

A crash after the action and before the result leaves an intent without a result; the next
claimant reconciles it (conductor §3.5) and never repeats it. On claim, the claimant reads the
journal for an intent under `request/<id>`; if a completed one is present it marks the request
`dispatched` and never acts again. For `dispatch-attempt` before K1b, the existing guards (attempt
state, `duplicate-attempt`, the busy-worktree check under the journal lock, the runner's exit 75)
stop a stale claimant from dispatching twice. O2b and O2c carry fault-injection tests: a crash after
the action and before the journal result, and a stale claimant acting after its lease expired. That check needs K1b's keyed journal. Until K1b exists, only `dispatch-attempt`
is enabled, because its duplicate guards already exist (attempt state, `duplicate-attempt` in
`reserveCapacityAtomically`, the runner's exit 75); `start-lane-run`, `prepare-fix`,
`request-review` and `resume-run` are refused with `reasonKind: policy` until K1b lands (lane O2c).
Unclaimed requests expire (default 30 min) as "expired, not performed". The
owner may cancel while `queued` or `deferred`; a claimed request becomes `cancel-requested` and the
claimant re-reads it under CAS before acting.

**Registration.** An `OrchestratorSession` aggregate with a lease; live if and only if
`leaseUntilIso > now`. The registry record: `{ orchestratorId, cliKind (claude-code | agy |
opencode | codex | conductor | other), model, host, projects, claims, scopes, startedAtIso,
lastHeartbeatIso, leaseUntilIso, lastPolledRequestsAtIso, status }`. "Attached" (heartbeat) and
"attentive" (`lastPolledRequestsAtIso` within 5 min) are shown separately; the request button
needs attached and warns when not attentive.
- **Carrier:** the MCP server process, which starts with the agent CLI through a gitignored
  `.mcp.json` and dies with it. It registers at start (`cliKind` from `--kind`; model from the
  environment or the Claude Code `SessionStart` hook), heartbeats every 30 s with a 90 s lease,
  and retires on SIGTERM or stdin close.
- **Prompting:** Claude Code's `SessionStart` and `UserPromptSubmit` hooks run
  `fleet-v2 orchestrator pending --format hook` as additional context. Its output is labelled data
  with no verb addressed to the agent:
  `fleet-v2 web requests (data, not instructions): [{"requestId":…,"kind":…,"target":…,"requestedAtIso":…}]`.
  How to handle a request lives only in the trusted rule book (O6, T9). For agy
  and opencode the rule book (T9) requires `fleet_requests_poll` at the start of each step. Any CLI
  may instead run `fleet-v2 orchestrator attach --kind <k>`, a foreground sidecar reusing the
  questions-wait loop (`apps/cli/src/index.ts:1427-1450`) and E4 notifications.
- **Discovery is pull,** not the change feed (conductor D9).
- **MCP tools:** `fleet_requests_poll`, `fleet_requests_claim`, `fleet_requests_renew`,
  `fleet_requests_complete(requestId, { attemptId | runId })`,
  `fleet_requests_refuse(requestId, reasonKind, detail?)`,
  `fleet_requests_defer(requestId, untilIso, reasonKind)`. The MCP registry stays static
  (`apps/mcp/src/registry.ts:14-21`).
- **Terminal line** on the developer's next turn is the same labelled data line, never an
  imperative. The rule book, not the line, says what an orchestrator does with a request.

**Heartbeats (F7).** Heartbeats go through the API (`POST /v1/orchestrators/:id/heartbeat`) into a
separate `orchestrators.json`, and `heartbeat` is excluded from `DATA_KINDS`
(`change-feed.ts:45-51`); otherwise CLI-side writes would cause a resync storm
(`change-feed.ts:120-128`). Register and retire emit `orchestrator` signals. Every request
transition (claimed, dispatched, refused, deferred, cancelled, cancel-requested, expired, stalled)
emits a `request` signal; heartbeats and lease renewals emit nothing.

**Several and remote orchestrators (F9, F10).** Many may register; a claim is first-CAS-wins and
capability-gated. With `policy.conductor.enabled`, `start-lane-run` is claimed only by `cliKind:
conductor`, and `dispatch-attempt` is refused with `reasonKind: policy` unless the installation
opts in. A claim of `dispatch-attempt` or `start-lane-run` is refused when the registry's `host` is
not the profile's `designatedDispatcherHost` (`coordination-records.ts:53`); other kinds are
unrestricted. A remote orchestrator implies a non-loopback API (`FLEET_API_ALLOW_REMOTE`) and
registers only with an `orchestrate`-scoped token, never the full one; v1 shows it as
"attached (remote) · cannot dispatch here".

**Reuse.** `OwnerQuestionRepositoryAdapter` `:108-118` (CAS), `record-list-store.ts:27-46`,
`file-store.ts:86-164`, `ChangeSignalPort.out-port.ts:8` (add `orchestrator`, `request`),
`change-feed.ts:7-13`, `apps/api/server/wiring/operator/composition.ts:101-107`,
`runtime.ts:286-293`, and the CLI group pattern at `index.ts:1262-1343`.

**UX.**
- **Presence chip** in the top bar of every view, linking to `/orchestrators`: "Orchestrator:
  Claude Code · model · attached 12 s ago · looked 40 s ago"; "attached, not looking (6 min)";
  "none attached". Icon and word, never colour alone.
- **Button when none is live:** disabled, "Dispatch (no orchestrator attached)", with inline text
  saying to start an agent CLI in the repository on the designated host, and the copyable
  `fleet-v2 orchestrator attach`.
- **Button when no attached orchestrator is eligible** (for example none on the designated
  dispatcher host for a dispatch kind): disabled, with that reason.
- **AlertBox body.** It names no single actor, since claims are first-CAS-wins. Does: "records a
  request that the first eligible attached orchestrator will claim (eligible now: N — <kind ·
  model> list; dispatch kinds only from the designated dispatcher host), to dispatch attempt <id>
  from its frozen brief (digest <12>, seat <role> as fixed by the brief)".
  Does not: "does not start, merge, push or grant anything; the orchestrator applies every existing
  refusal; one-way doors still park for you". Route: "live: writes a request record; expires
  unclaimed in 30 min; cancel while queued". Accent tone. It shows the exact ids-only JSON.
- **Lifecycle card** on the attempt page and in the inbox, showing who actually claimed: queued
  (expires in N) → claimed by <kind · model> (lease) → dispatched → lane running (hands over to the attempt or
  run view); or refused: <reasonKind> — "<detail>"; deferred until <time> — <reason>; expired, not
  performed; cancelled; stalled (2 claims lost), with an attention item. Each step is a `<time>`
  row. Cancel appears only in cancellable states. No optimistic UI. The card re-reads on each
  `request` signal and, as the fallback, polls every 30 s on a visible tab (tested).
- **Notifications (E4):** claimed, dispatched, refused, deferred, stalled; and on the orchestrator
  host "fleet-v2 web request queued (data): <kind> <target id>", ids and kinds only, no imperative.

### 3.7 Live tail

The owner wants "tail -f" over agents and lanes. Today nothing reads lane activity while it runs
(§1). The tail adds that, bounded by one rule: lane output is untrusted model output and may be
client content, which `AGENTS.md` forbids printing (F13).

**Sources.**

| Source | Today | v1 |
|---|---|---|
| Attempt journal | Stored, no route | Tail route over the journal |
| Lane session events | No event read; runner `inspectSession` returns status only | The `LaneSessionEvent` contract first (L0, below), then a consumer-side `LaneSessionEventPort` in work-execution: `readEvents({ attemptId, after }) → { events, cursor } \| unavailable`, with an opencode-session adapter and an agy file-tail adapter (over the files `bin/agy-run` writes) |
| Gate and review output | Read after exit (last 4000 chars; review `rawOutput` last 20000) | Shown as started / ended (exit n) plus the existing summaries; streaming needs a streaming spawn with a bounded ring, later |
| Conductor journal | Planned (K1b) | Per-run journal tail after K1b |
| Orchestrator activity | None (T2a's `orchestrator-update` planned) | Claims and `PostToolUse` hook summaries (tool name, duration, exit; never arguments), heartbeat age |
| Change feed | In-process | Stays signals only; the tail never rides on it |

**The event contract (L0).** Defined before any adapter (`AGENTS.md`: refine typed contracts
before implementing a station), `schemaVersion: 1`:

```ts
type LaneSessionEvent = {
  schemaVersion: 1;
  source: { attemptId: string; kind: 'opencode' | 'agy' };
  seq: number;                 // strictly increasing per source
  at: string;                  // ISO time
  kind: 'tool' | 'step' | 'status' | 'text' | 'gap' | 'ended' | 'unavailable';
  summary: { tool?: string; path?: string; bytes?: number; exit?: number; elapsedMs?: number; model?: string };
  text?: string;               // only when policy.liveTail.content is 'full'
  redaction: 'none' | { withheld: true; pattern: string };  // pattern name only, never the value
};
```

The cursor is `<source>:<seq>`. Events from one source are delivered in `seq` order; a missing
range is reported as one `gap` event, never silently skipped; `ended` and `unavailable` are the
last events of a source until it resumes. L1 and L2 implement against this type; L3 and the web
consume the same shape.

**Content policy (F13).** `policy.liveTail.content` defaults to `summaries`: step index, tool name,
path, byte counts, elapsed time, exit codes, model and seat, runner status lines. `full` is an
opt-in per installation: stream-through only, never persisted, a bounded in-memory ring per stream
(about 2000 lines or 256 KiB, dropping the oldest with a gap marker). Rendering is text only in a
`pre` block: no markdown, no autolinks, no images; the only links are fleet-v2's own ids. Every
line passes `LANE_DIFF_SECRET_PATTERNS` (`packages/shared/src/secret-patterns.ts:51`); a hit
withholds the line as "[line withheld: secret-shaped (<pattern name>)]", name only, as
`lane-diff-check.sh` does (`:19,362`). Each connection has a bounded queue; overflow inserts a gap
and continues. The tail routes need a separate `tail` scope (T3a amendment).

**Transport.** Per-stream endpoints, chunked JSON lines, cursor `after=<source>:<seq>`, keep-alive
every 15 s, and control lines `gap`, `ended`, `unavailable`:
- `GET /v1/attempts/:id/tail`
- `GET /v1/runs/:id/journal/tail` (after K1b)
- `GET /v1/orchestrators/:id/activity`

The web server multiplexes them and relays a same-origin SSE stream `/live/tail` (redacted text)
with `Last-Event-ID` resume. Before T3a, the web server may read the tail with its server-side
bearer (`api-client.ts:139-147`): it holds no forge credentials, so conductor D9 is not engaged.
Its token is re-scoped to `tail` at T3a. This is the same interim as `/v1/changes` (D2).

**UX.**
- **`/console`:** filter chips (project, lane or attempt, orchestrator, kind: runner · tool · gate
  · review · journal · orchestrator · request); a Follow toggle (scrolling up pauses it; "N new
  lines"); jump to the next or previous error (exit ≠ 0, refused, ambiguous, seat-failed); absolute
  `<time>` with relative text; tool calls collapsed (expandable only in `full` mode); copy as plain
  text; an attempt chip per line linking `/attempt?id=`; monospace.
- **Attempt page pane:** the last 200 events and "open in console".
- **Orchestrator pane:** claims, hook summaries, heartbeat age.
- **States:** not started; "running · last event 8 s ago"; "silent 2 min · runner says active"
  (zero bytes is suspicious, not proof; unknown is never a verdict; Reconcile is offered);
  "silent 10 min · runner unreachable · last known" (dimmed); "ended · exit 0 · N events · collect
  available"; "unavailable: source host unreachable"; gap rows.
- **Accessibility:** `aria-live` off for the stream itself, polite counts only; reduced motion
  respected.

### 3.8 Deferred

Seats writes (free-tier toggle, overrides, probe trigger), the owned-path conflict graph (P11),
streaming gate and review output, and an SSE relay for `/v1/changes` if the shorter poll proves
enough. The research's web dispatch wizard (freeze, reserve, dispatch) is replaced by §3.6.

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline and its tier. **Parallel** means
different packages and no shared file. The shared files here are `apps/web/src/lib/api-client.ts`
(every web lane, until W0 splits it), `apps/api` wiring (`server/wiring/*/composition.ts`,
`runtime.ts`, `change-feed.ts`), `.architecture/manifest.yaml`,
`apps/api/server/middleware/security.ts`, `apps/cli/src/index.ts` (shared with K7 and AM5) and
`apps/web` top bar (`topbar.tsx`). One lane per package at a time, and no two lanes on one shared
file. Within each step the `apps/web` lanes run in the order given by their arrows and "After"
column, one after another; they run beside API, domain, security and conductor lanes. Lanes marked
**manifest** edit `.architecture/manifest.yaml` and run one at a time in this order: A-J → O1a →
O1b → O2a → O2b → L0 → L1 → O3 → O2c → A-R → A-C → O9 → A-WO → A-K → A-S → A-F (amendment K-GC), each rebased on the last.
`composition.ts` lanes (A-J, O3, L3, E3b, L9, A-R, A-C, L8, A-WO, A-K, A-S, A-F) likewise run one at a
time. The work-execution lanes here (A-J, L0, L1, L2, A-R, A-C, O9, A-WO) also queue behind the
conductor's own work-execution lanes.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| UI0 | This plan and the owner's decisions | docs | 0 | — |
| UI-A | Amend the orchestrator plan: `operate`, `orchestrate` and `tail` scopes in T3a; Q4/T7 read half ahead of T6; the D2 interim for E3b | docs | 0 | UI0 (D2, D3) |
| UI-B | Amend the conductor plan: the run-stop outcome mapping (§3.3), park reason `stop-unconfirmed`, `ResumeLaneRun` refuses `run-stopped` with tests for it and for one-way-door parks | docs | 0 | UI0; before K1 merges, or a K1 follow-up |
| **Step 1. Read the real attempt (parallel now: W0 ‖ A-J ‖ L1b ‖ UI-A ‖ UI-B; then O1a after A-J)** | | | | |
| W0 | Split `api-client.ts` into per-resource readers; no behaviour change | apps/web, **`api-client.ts`** | 1 | — |
| A-J | `GET /v1/attempts/:id/journal` over `listJournalEntriesForAttempt`; no legality block | work-execution (application), apps/api, **`composition.ts`, manifest** | 1 | — |
| L1b | `policy.liveTail` (`summaries` default, `full` opt-in) | installation | 2 | S1d |
| O1a | `OrchestratorSession` aggregate: record, lease, attached/attentive, statuses | operator-coordination (domain), **manifest** | 2 | UI0, A-J (manifest) |
| W1a | Live `/attempt`: inspect read, `unknown` outcome, recorded runner facts, usage, artifacts; `map-attempt.ts` keeps usage/runner/artifacts; rows open the page; shorter visible-tab poll | apps/web | 2 | W0 |
| W1b | Work-order sidebar (`GET /v1/work-orders/:id`), journal panel, P12 sample labels and "sample digest" | apps/web | 2 | W1a, A-J |
| **Step 2. Domain lanes (parallel across packages); web: Q4 → W8a → W10** | | | | |
| O1b → O2a → O2b | `OrchestratorRequest` aggregate (closed payload, `reasonKind`, lifecycle); register/heartbeat/retire/list with `orchestrators.json`; create/claim/renew/complete/refuse/defer/cancel/expire and the dispatcher-host gate, with only `dispatch-attempt` enabled; the claim use case refuses `dispatch-attempt` with `reasonKind: policy` while `policy.conductor.enabled` is on and the installation has not opted in (D7 enforced here, not in O9); the claim fence on every claim mutation; fault-injection tests (crash after the action before the journal result; a stale claimant after lease expiry) | operator-coordination, **manifest** | 2 | O1a |
| L0 | `LaneSessionEvent` contract only: type, `schemaVersion: 1`, cursor, ordering and gap semantics, tests of the invariants | work-execution (domain), **manifest** | 2 | A-J (same package), O2b (manifest) |
| L1 → L2 | `LaneSessionEventPort` and the opencode adapter against L0's type, summaries, `full` behind policy; then the agy file-tail adapter | work-execution (infra), **manifest** (L1) | 2 | L0, L1b; L2 must finish before the next work-execution lane (A-R) |
| Q4 | Questions view, badge, attention card from `/v1/attention` | apps/web | 2 | W1b |
| W8a | Work-order timeline: attempts by `workOrderId`/`priorAttemptId`, journal, head evidence; `reviewTally` and `kind` when served | apps/web | 2 | Q4; full fidelity after R2, RW1 |
| W10 | Usage and seat/model chips per row, sums per work order, `source` and estimate labels | apps/web | 2 | W8a |
| **Step 3. API wiring (one at a time: O3 → L3; E3b in sequence with them)** | | | | |
| O3 | `/v1/orchestrators*`, `/v1/requests*`; `orchestrator` and `request` feed kinds; heartbeat excluded from `DATA_KINDS` | apps/api (`operator/composition.ts`, **`change-feed.ts`**, **`runtime.ts`**), **manifest** | 2 | O2b, L1 (manifest) |
| L3 | Tail routes (`/v1/attempts/:id/tail`, `/v1/orchestrators/:id/activity`), ring, redaction, control lines | apps/api, **`composition.ts`** | 2 | L1, O3 |
| E3b | `/v1/changes` (live-updates plan), on the shared bearer for the web server until T3a (D2) | apps/api, **`change-feed.ts`, `runtime.ts`** | 2 | E3a, L3 |
| **Step 4. Reads and carriers (before the write path); web: O7 → L4 → L5 → L6** | | | | |
| O4 | MCP registration, heartbeat, retire, `fleet_requests_*` | apps/mcp | 2 | O3; serial with T4 and the MCP plan's M lanes |
| O5 | CLI `orchestrator attach \| status \| pending --format hook` (labelled data output) | apps/cli, **`index.ts`** | 2 | O3; serial with K7, AM5 |
| O6 | Hook recipe, rule-book text (how to handle requests), `.mcp.json.example` | docs | 1 | O4, O5; with T5, T9 |
| O7 | Presence chip and `/orchestrators` read | apps/web, **`topbar.tsx`** | 2 | O3, W10 |
| L4 | Web `/live/tail` SSE relay (E3c owns `/live/changes` only) | apps/web | 2 | L3, O7 |
| L5 | `/console` view | apps/web, packages/ui | 2 | L4 |
| L6 | Attempt-page lane pane, silent and ended states | apps/web | 2 | L5, W1a |
| **Step 5. Write path (orchestrator plan lanes, serial); web: T6 → E3c → E5** | | | | |
| T3a → T3b → T6 | Scopes with `operate`, `orchestrate`, `tail`; session exchange; web proxy and first write route | apps/api, **`security.ts`**; apps/web | 2 | UI-A; T3a's own prerequisites; T6 after L6 |
| L9 | `tail` scope enforced on the tail routes; the interim bearer read retired (with `read` for `/v1/changes`) | apps/api, **`security.ts`, `composition.ts`** | 2 | T6 (`security.ts`), L3, E3b |
| E3c → E5 | Web change relay; offline display | apps/web | 2 | E3b, T6 |
| **Step 6. Actions after T6; web: W5a → W5b → O8 → Q5 → W8b** | | | | |
| W5a | Reconcile, stop (attempts with no run only), collect from the attempt page | apps/web | 2 | T6, E5 |
| W5b | Request acceptance | apps/web, packages/ui | 2 | W5a |
| O8 | Request button (eligible-orchestrator list, disabled reasons), AlertBox body, lifecycle card, cancel; card in the inbox | apps/web, packages/ui | 2 | W5b, O7, T3a, T3b, T6, Q4 |
| Q5 | Question answers, one-way answers show bytes to sign | apps/web, packages/ui | 2 | O8 |
| W8b | Finding dispositions from the timeline | apps/web | 2 | Q5, W8a |
| **Step 7. Conductor; serial A-R → A-C → O9; web: W7a → W7b** | | | | |
| O2c | Journal-key reconciliation (`request/<requestId>`); enables `start-lane-run`, `prepare-fix`, `request-review`, `resume-run`; `start-lane-run` is claimable only by `cliKind: conductor` from the start (D7); intent before the action, result after; the same fault-injection tests under K1b | operator-coordination, **manifest** | 2 | O2b, K1b, O3 (manifest) |
| A-R | `GET /v1/runs`, `/v1/runs/:id`, run journal by key | work-execution, apps/api, **`composition.ts`, manifest** | 2 | K3, O2c (manifest), L2 (work-execution) |
| A-C | Direct run routes: halt marker through the CLI's adapter; run stop as a keyed run-journal entry `<runId>/stop@web` with `expectedRevision`; attempt stop refuses run-owned attempts; run reads report the stop outcome mapping (§3.3), including `stop-unconfirmed` parks | work-execution, apps/api, **`composition.ts`, manifest** | 2 | A-R, K7, T3a |
| O9 | The conductor driver registers and claims `start-lane-run` (the claim rules already exist from O2b and O2c) | work-execution, apps/cli, **`index.ts`, manifest** | 2 | A-C, O5, K3, K7, O2c |
| W7a | Run board read, dry-run and shadow entries distinct | apps/web | 2 | A-R, K7, W8b |
| W7b | Halt and run-stop controls; resume and start as requests (O8's card) | apps/web | 2 | W7a, A-C, O8 |
| L8 | Per-run journal tail | apps/api, **`composition.ts`** | 2 | K1b, L3, A-C |
| L7 | Orchestrator activity from `PostToolUse` summaries | apps/mcp, docs | 2 | O4, T2a |
| O10 | E4 triggers for requests; AM3b attention item for `stalled` | operator-coordination | 2 | E4, AM3b, O2c |
| **Step 8. Work orders, knowledge, seats; web: W6 → WK → W9** | | | | |
| A-WO | `ListWorkOrders` use case, manifest, `GET /v1/work-orders` | work-execution, apps/api, **`composition.ts`, manifest** | 1 | O9 (manifest, work-execution) |
| W6 | Work-order list and brief viewer for a real attempt's frozen brief | apps/web | 2 | A-WO, W7b |
| A-K → WK | Knowledge candidates route over `ListCandidateClaims`; live `/knowledge` read | apps/api, **`composition.ts`, manifest**; apps/web | 2 | A-WO (manifest); WK after W6 |
| A-S → W9 | Seats read route (plan, cursors, last probe); seats view | apps/api, **`composition.ts`, manifest**; apps/web | 2 | S1a, A-K (manifest); W9 after WK |
| A-F | Reaper findings read route (`GET /v1/reaper/findings`) over a list use case on K11a's findings store; read-only (amendment K-GC) | work-execution (application), apps/api, **`composition.ts`, manifest** | 2 | K11a, A-S (manifest, `composition.ts`) |
| W7c | Reaper findings on the run board: kind, subject, sightings, report or repaired; read-only; repairs stay in the CLI (amendment K-GC) | apps/web | 2 | A-F, W7b, W9 |
| **Step 9. Deferred** | Seats writes, P11 conflict graph, streaming gate and review output | — | — | owner |

Every Tier 2 lane in this plan touches data safety, security or user-facing behaviour, so every
Tier 2 lane gets its one Fable pre-merge pass. Tier 0 and Tier 1 lanes follow their tier (no model
review, or one Grok pass).

## 5. Decisions for the owner

| # | Question | Recommended default |
|---|---|---|
| D1 | May the web dispatch when an orchestrator is registered? | **The web writes a typed request; a registered orchestrator with a live lease claims it and acts under its own existing authority; the web never dispatches.** Web requests go under the `message` scope; no web token gets a `dispatch` scope, ever (§3.6). |
| D2 | May the web server read `/v1/changes` on the shared bearer before T3a's `read` scope? | **Yes, the web server only, re-scoped to `read` at T3a.** It holds no forge credentials, so conductor D9 is not engaged; the same interim as the tail (D11). The attempt page keeps its shorter visible-tab poll until E3c lands. |
| D3 | Amend T3a with `operate`, `orchestrate` and `tail` scopes? | **Yes,** filed as UI-A before T3a is dispatched. |
| D4 | Seats writes from the web? | **Deferred.** The CLI keeps the writes; the web reads seats after S1a. |
| D5 | Free text in requests? | **None.** Typed ids and enums only; prose goes through the T2b owner-message thread. |
| D6 | Request TTL, claim lease, heartbeat | **30 min / 2 min / 30 s heartbeat with a 90 s session lease.** |
| D7 | Who claims dispatch while the conductor is enabled? | **Only the conductor** claims `start-lane-run`; `dispatch-attempt` is refused with `policy` unless the installation opts in. |
| D8 | Remote orchestrators | **May register with an `orchestrate`-scoped token;** dispatch kinds only when the orchestrator's host is the profile's `designatedDispatcherHost`. |
| D9 | Which actions bypass the channel? | **Halt, stop, reconcile, collect and question answers are direct routes,** never queued. |
| D10 | Tail content | **Summaries by default;** `full` opt-in per installation, stream-through, never persisted. |
| D11 | Tail scope and interim | **A separate `tail` scope under T3a;** until then the web server, and only it, reads the tail with its server-side bearer, re-scoped to `tail` at T3a (the same interim as D2). Tail content stays `summaries` by default (D10). |
| D12 | Registration carrier | **The MCP process heartbeat plus hooks;** the `attach` sidecar as the fallback for any CLI. |

## 6. States and accessibility

Every live view uses the same vocabulary:
- **Empty:** "no runs recorded" is distinct from "the filter hides N".
- **Error:** the route answered with an error; show the typed reason from the envelope verbatim;
  a `refused` outcome names its reason.
- **Unconfigured:** no `FLEET_API_URL`; sample data labelled as such, never refreshed.
- **Unknown:** the runner did not answer or the recorded host cannot be resolved; holds its slot,
  never idle, never pass; dependent actions disabled with the reason.
- **Offline:** the API stopped answering; the last snapshot stays dimmed with "last read <time>",
  actions disabled, retries back off (E5); a reconnect never triggers a write. A header chip says
  "live · stream", "live · polling" or "offline".
- **No orchestrator:** "none attached" or "attached, not looking"; request buttons disabled or
  warned, with the `attach` command.
- **Tail:** not started, running, silent (runner says active), silent (runner unreachable, last
  known), ended, unavailable, gap, line withheld (§3.7).
- **Run:** the conductor's states, with `parked` (reason shown, including `stop-unconfirmed`)
  distinct from the terminal `merged` and `stopped`.
- **Request:** queued, claimed, dispatched, refused, deferred, expired, cancelled,
  cancel-requested, stalled (§3.6).
- **Not routed yet:** name the CLI command.

Accessibility: `AlertBox` keeps its focus trap and restore. One `aria-live="polite"` region
announces summaries ("3 lanes changed", "12 new tail lines"), never per row or per tail line;
`aria-busy` on a card while it re-reads; state words with icons, never colour alone; arrow keys
move through lane rows and Enter opens; `prefers-reduced-motion` respected; times as
`<time datetime>` with relative text.

## 7. Review

**Research subagent (2026-10-27).** Inventoried use cases, CLI, API routes and web views; proposed
P1–P12, an order and the dispatch question this plan's D1 answers.

**Fable (2026-10-27): NO BLOCKERS; 4 majors, 6 minors, all applied.**
1. Major: list rows already carry the full attempt record; the gap is `map-attempt.ts`. P10's API
   lane deleted; usage and seat/model chips are web-only; recorded runner facts render (P1, P10,
   W1a, W10).
2. Major: push updates were placed before T3a, against live-updates E3b and conductor D9. Moved
   after T3a with an owner decision (D2) and the shorter visible-tab poll as the interim (§3.2).
   Rev 3 (Grok, finding 7) sets D2's default to the web-server-only interim on the shared bearer,
   since the web server holds no forge credentials.
3. Major: the API does not dedupe on `Idempotency-Key`. Idempotency stated per route; the proxy
   only mints client ids (§2, table in §3.4).
4. Major: resume must be refused server-side for one-way-door parks. `ResumeLaneRun` refuses them;
   resume carries `expectedRevision` and a keyed journal entry; halt goes through the CLI's adapter
   (P7-write).
5. Minor: `InspectAttempt`'s `unknown` outcome renders as holding its slot with hints disabled (P1).
6. Minor: the work-order list and the knowledge read need use cases or routes, manifest entries and
   wiring (A-WO, A-K); P12 only labels `/knowledge` as sample.
7. Minor: reconcile is a write; its confirm body says it ends the record if the server reports the
   session ended (§3.4).
8. Minor: "modelled on settings-plan U3, built as T3b/T6" (§3.5).
9. Minor: `operate` amends T3a, filed before T3a (UI-A, D3).
10. Minor: the journal route ships as a pure API read; legality comes later from K1's decider, not
    a second table (P1-J).

Also applied from that review: the work-order sidebar in W1; the timeline moved to step 2; the run
board read ships with K7; push updates ranked below the inbox and the timeline; seats writes and
P11 deferred.

**Fable, design review (2026-10-27): orchestrator request channel and live tail — NO BLOCKERS;
F1–F13 applied.**
- F1 (major): the request carries no authority; `OrchestratorRequest` is its own aggregate, not a
  `CoordinationKind`; the claimant runs the ordinary use cases with every refusal (§3.6 Authority).
- F2 (major): web requests under `message`; claim and complete under a new `orchestrate` scope the
  web never holds, with a 403 test; per-dispatch web grant dropped (§3.5, §3.6, D1, D3).
- F3 (minor): `requestedBy` from the session, never the body; one-way doors are not request kinds.
- F4 (major): the request is a mailbox entry ending at `dispatched` with a link; journal key
  `request/<requestId>` under K1b's uniqueness check.
- F5 (major): requests name a prepared attempt or a work order, never "prepare and dispatch";
  existing duplicate guards named.
- F6 (minor): client-minted ULID as the idempotency key; CAS claim with fence and lease; expiry,
  `stalled` after two lost claims; journal check before acting.
- F7 (major): heartbeats through the API into `orchestrators.json`, excluded from `DATA_KINDS`.
- F8 (major): closed payload, no free text; typed `reasonKind` with a secret-scanned 1 KiB detail.
- F9 (minor): many orchestrators, first-CAS-wins, capability-gated; conductor-only start when
  enabled (D7).
- F10 (major): dispatch kinds only from the designated dispatcher host; remote orchestrators only
  with an `orchestrate` token (D8).
- F11 (major): halt, stop, reconcile, collect direct; the channel's kinds listed; answers, prose,
  forge, installation writes and state restore never through it (D9).
- F12 (minor): 30 min expiry, cancel while queued or deferred, `cancel-requested` re-read under CAS.
- F13 (major): lane output is untrusted; summaries by default, `full` opt-in and never persisted,
  plain-text rendering, secret-pattern withholding, bounded queues, a `tail` scope (§3.7, D10, D11).

**CodeRabbit (2026-10-27): 4 majors, 2 minors, all applied.**
1. Minor: the run board had no place for `stopped`. An `ended` group holds `merged` and `stopped`,
   each by its word, distinct from `parked` (§3.3).
2. Major: the run-stop outcome was undefined. `StopAttempt`'s outcomes are mapped; `stopped` only
   on a confirmed stop, `stop-unconfirmed` park otherwise, slots never released unconfirmed (§3.3,
   UI-B).
3. Major: `ResumeLaneRun` refuses a `stopped` run with `run-stopped`, beside one-way-door parks,
   with a test for each (§3.3, UI-B).
4. Major: the claim fence was undefined. Every claim mutation checks revision, fence and lease; an
   expired lease re-queues with a new fence; intent before the action, result after; fault-injection
   tests in O2b and O2c (§3.6).
5. Minor: every request transition emits a `request` signal; the card falls back to a 30 s
   visible-tab poll, tested (§3.6).
6. Major: the `LaneSessionEvent` contract is defined first, in a new lane L0 before L1, on the
   manifest order (§3.7, §4).

**Grok 4.7, re-review of rev 3 (2026-10-27):** all seven rev-2 findings RESOLVED; two new majors, applied in rev 3.1: (1) the conductor-enabled refusal of `dispatch-attempt` and the conductor-only claim of `start-lane-run` move into O2b and O2c, so no window exists before O9; (2) A-R waits for L2 (work-execution), and L9 waits for T6 (`security.ts`).

**Grok 4.7 (2026-10-27): 6 majors, 1 minor, all applied.**
1. Major: a web stop raced the conductor. A run-owned attempt is stopped only through the run:
   A-C writes `<runId>/stop@web` with `expectedRevision`, the driver stops the attempt through
   `StopAttempt`; the direct attempt stop refuses run-owned attempts (§3.3, §3.4, A-C, W5a).
2. Major: O2b's crash safety needed K1b. Journal-key reconciliation moved to O2c after K1b; until
   then only `dispatch-attempt` is enabled and the other kinds are refused with `policy` (§3.6).
3. Major: the AlertBox named one actor while claims are first-CAS-wins. The body lists the eligible
   orchestrators; the card shows who claimed; no eligible orchestrator disables the button (§3.6).
4. Major: the hook and terminal lines were imperatives in model-visible text. Now labelled data
   only; handling lives in the rule book (O6, T9); notification text likewise (§3.6).
5. Major: scheduling. A-J → O1a on the manifest; an explicit manifest order and `composition.ts`
   order; every `apps/web` lane ordered within its step; O9 after O5; A-R → A-C; further fixes
   found on recheck: L1, O3, O2c, A-WO, A-K, A-S ordered on the manifest, E3b and L8 on
   `composition.ts`, O7 after W10, T6 after L6 in `apps/web` (§4).
6. Major: every Tier 2 lane gets its one Fable pre-merge pass (§4).
7. Minor: P8-read needs no backend beyond A-J; `dispatching` removed from the lifecycle card; D2
   and D11 share one interim (web server only on the shared bearer, re-scoped at T3a) (§3.1, §3.2,
   §3.6, §3.7, §5).

## Hard to undo

- **Scope names** `operate`, `orchestrate` and `tail` become stored token data once T3a ships.
- **The request record, its kinds and `reasonKind` values, and the `orchestrators.json` layout**
  become stored data and contracts for the MCP tools; version them from the first commit.
- **The `LaneSessionEvent` contract (`schemaVersion: 1`) and the park reason `stop-unconfirmed`**
  become stored or wire data; a change needs a new schema version.
- **The run read model, the journal route and the tail line shape** become contracts the web and
  the TUI depend on.
- **Tail content in `full` mode** reaches a browser and cannot be recalled once seen. It is an
  installation opt-in, chosen by the owner.
- **Web run controls** write records the driver obeys. A halt is cheap to undo; a stop ends an
  attempt and is not undone. Neither crosses a one-way door: merges and one-way answers stay on the
  owner's signed path, and no request kind is a one-way door.
- Everything inside `apps/web` is two-way.

## Assumptions

- The conductor driver stays a CLI process (conductor D2), so the web writes records, never steps.
- The MCP server process lives and dies with its agent CLI. If a CLI keeps the MCP process alive
  after the agent stops, presence overstates; the attentive check (last poll within 5 min) and the
  claim lease limit the damage, and an unclaimed request simply expires.
- Agent CLIs honour their hooks or rule book and poll; one that never polls shows "attached, not
  looking".
- The opencode session store and agy's output files can be read from the lane host while a lane
  runs. If not, the tail says "unavailable" and the attempt page falls back to the journal.
- The profile names a `designatedDispatcherHost`; without one, dispatch kinds are refused.
- `GET /v1/attempts` keeps returning the whole record per row; if rows are trimmed, W10 needs an
  API lane.
- The web and API stay loopback-bound as `AGENTS.md` states, unless the owner sets
  `FLEET_API_ALLOW_REMOTE` for a remote orchestrator.
- T3a, T3b and T6 land in the orchestrator plan's order; if T6 slips, steps 6 and 7 wait and the
  web keeps showing CLI commands.

## Challenge this

Whether summaries by default meets the owner's "maximum visibility". The plan withholds lane text
unless the installation opts into `full`, because lane output is untrusted and may carry client
content. A summary stream (step, tool, path, bytes, exit) may feel like watching a progress bar
rather than `tail -f`, and the owner may switch `full` on everywhere, which makes the secret-pattern
filter the only guard. A reviewer should test whether that filter and plain-text rendering are
enough for `full` on a single-owner installation, or whether `full` should stay per project. A
second candidate: whether a live MCP process is a trustworthy sign that an agent is attentive; the
plan separates "attached" from "looked", and a reviewer should check that the button's warning on a
non-attentive orchestrator is enough.
