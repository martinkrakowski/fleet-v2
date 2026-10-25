# Plan: live updates, owner notifications and state resilience

- **Date:** 2026-10-24
- **Target repository:** `fleet-v2`
- **Status:** draft for the owner's decisions (§6). Nothing built. Inventory checked against `main`
  on 2026-10-24 (§2).
- **Owner request (2026-10-24):** "Write a plan for the features worth adopting." It follows a
  review of comparable agent-orchestration tools, which found six designs fleet-v2 lacks or does
  worse.
- **Builds on:** `2026-10-18_orchestrator-interaction-plan.md` (rev 3: the chunked JSON-lines stream
  over `fetch` for the orchestrator thread, T2a; scoped tokens, T3a; the TUI, T8a–T8b),
  `2026-10-24_project-onboarding-and-config-ui-plan.md` (the TUI and web screens that would consume
  live updates), `2026-10-23_attempt-record-gate-predicates-usage-plan.md` (the gate predicates an
  explain command reports), and `2026-10-23_host-programs-and-client-server-packaging-plan.md`
  (P5: worktree lifecycle moves into the product).

## 1. Goal

Six changes in one direction: the operator sees what changed as it changes, is told when they
are needed, and never loses state to a bad write.

1. **Change signals.** A small stream that says *something changed* (an attempt, capacity, a
   question). Clients then re-read the existing routes. This replaces polling as the main way the
   Lanes page and the planned TUI stay current.
2. **Owner notifications.** A desktop notification when a lane ends, a question waits for the
   owner, or acceptance is blocked.
3. **`attempt explain`.** One answer to "why is this attempt in this state", across the runner's
   status, reconciliation, capacity and the gate predicates.
4. **State-file resilience.** A state file that cannot be read is kept byte for byte, and the
   operator gets a precise recovery path, not just an exception.
5. **Offline-host display.** When a host or the API stops answering, its last known state stays
   on screen dimmed and labelled with its age, and reconnection retries with back-off.
6. **Safe worktree removal.** When worktree removal moves into the product, a leftover directory
   is deleted only if it provably belongs to the repository.

**Non-goals.** No event history or replay for attempt state (§3.1). No terminal multiplexer, no
reading agent state off a screen, no resuming agent conversations (lanes stay short and fresh), no
plugin system, and no unauthenticated control socket.

## 2. What exists (checked 2026-10-24)

| Piece | State |
|---|---|
| Live updates | None. No route streams or pushes; the code has no subscribe or watch path. The Lanes page (#174) re-reads `GET /v1/attempts` every 30 s while it is visible. |
| Orchestrator thread stream | Planned (orchestrator plan T2a): chunked JSON lines over `fetch` with `after=<seq>` replay, for a conversation where every entry matters. |
| Owner attention | `AttentionReadPort` reports absence; owner questions (`/v1/questions`, `fleet-v2 questions`) reach the owner only when something polls them. |
| Explaining state | `attempt` commands return records; acceptance lists `blockers`. Nothing assembles one account across runner status, reconciliation, capacity and gates. |
| State stores | JSON files written atomically under a lock in each context's `file-store.ts`. A file that cannot be parsed makes the adapter throw (`… could not parse …`, `… expects a record list …`). Nothing is overwritten, but every command touching that store fails until someone repairs the file by hand, and no copy of the bad bytes is kept. |
| Unreachable host | The runner reports `unknown`, never a pass; the web has a labelled fixture fallback. No client keeps a last-known state or retries with back-off. |
| Worktree lifecycle | Creation and removal live in host scripts outside the product (host-programs plan P5 moves them in). `WorkspacePort` inspects worktrees but does not remove them. |

## 3. The shape

### 3.1 Change signals, not an event log

`GET /v1/changes` holds open a chunked JSON-lines response, over `fetch` as the orchestrator plan's
thread stream does, so the bearer token stays in a header and never in a URL. Each line is a
**signal**, not a record:

```json
{ "stream": "s_01J…", "seq": 1842, "kind": "attempt", "id": "att_…", "at": "2026-10-24T13:02:11Z" }
```

Kinds: `attempt`, `capacity`, `work-order`, `question`, `profile`. The client's only response to a
signal is to re-read the matching route (`GET /v1/attempts`, `GET /v1/questions`, …). A signal
never carries state, so a client cannot act on a stale payload.

- **No history, and a cursor that names its stream.** The server keeps a small in-memory ring for
  the current process. Each process start mints a random `stream` id. A client reconnects with
  `after=<stream>:<seq>`. If the stream id is not the current one (the API restarted, so `seq`
  restarted too), or `seq` has fallen out of the ring, the server's first line is
  `{ "kind": "resync" }`. A cursor from an older process therefore can never suppress new signals.
  Losing signals costs a re-read, never a wrong answer.
- **Delivery failures become a resync.** Emitting a signal never fails a save. If an emit fails,
  the server marks every open connection as needing a resync, and sends a control `resync` line
  that bypasses the bounded queue (or closes the connection, which makes the client reconnect and
  resync). A client is never left with neither a signal nor a resync.
- **Source of signals.** The repository adapters already funnel every write through
  `saveAttempt`, `saveCapacityReservation`, `saveProfile`, `saveQuestion`. A `ChangeSignalPort`
  is called after each successful save. A write made by another process (the CLI against the same
  state directory) is caught by a cheap `mtime` watch on the state files, which emits `resync`.
  **The API's own writes are not echoed:** after each local save, the adapter records the file's
  new `mtime` and size, and the watch ignores a change that matches the last local write. Only a
  change nobody in this process made becomes a `resync`.
- **Polling stays** as the fallback. The Lanes page keeps its 30 s refresh when the stream is
  unavailable or the token lacks the `read` scope.

### 3.2 Owner notifications

A `OwnerNotificationPort` in operator-coordination, with one local adapter (D1). It is triggered
by three moments: an attempt reaches `ended` or `blocked`, an owner question is asked, acceptance
records a blocker. Rate limiting is keyed by **(trigger, id)**, so an attempt that blocks and
later ends still produces both notifications. The text is fixed and names only ids and kinds, for example "Attempt att_… ended:
collect is available". It never includes lane output, brief text or a path, since lane output may
be untrusted or carry a secret. Notifications can be switched off in
the installation (`policy.notifications`, default on for a single-machine profile, off otherwise).

### 3.3 `attempt explain`

A read-only use case in work-execution returning ordered lines, each with its source:
`record` (recorded state and revision), `runner` (the last reconcile answer and when),
`capacity` (reservation held or released, host and slot), `gate` (each acceptance predicate: met,
unmet, unknown, and the receipt that decides it), `next` (the commands that are legal now and
those refused, with the reason). A line whose source could not be read says `unknown` and why,
never a guess.

**Consistency contract.** The sources are read separately, so they can disagree. Each line carries
the revision or timestamp it was read at: the attempt record's `revision`, the reservation's
journal position, the receipts' head SHA, and the runner answer's time. `explain` reads the attempt
record first and again last. If the revision changed in between, the whole answer is `unknown`
with the reason "the attempt changed while it was being explained; run it again". `next` is
derived only from lines that agree with the final record revision; a gate line whose receipt
belongs to a different head than the record says `unknown`, never `met`. Exposed as `fleet-v2 attempt explain <id>` and `GET /v1/attempts/:id/explain`.

### 3.4 State-file resilience

In every context's `file-store.ts`:
1. **Quarantine on read failure.** When a store file cannot be parsed or fails validation, copy
   its exact bytes to `<stateDir>/quarantine/<file>.<UTC timestamp>.<sha256-prefix>` (mode 600,
   the last 5 kept per file) before throwing. The thrown error names the quarantine copy.
2. **Never write over an unreadable file.** A save whose locked read fails throws and writes
   nothing; this is what happens today, and a test will pin it.
3. **`fleet-v2 state check`.** Read-only: parses every store, prints one line per file (`ok`,
   `unreadable`, `invalid record <n>: <field>`), and exits 1 if any file is bad. It is also a
   `doctor` line.
4. **`fleet-v2 state restore <file> --from <quarantine copy>`.** Validates the candidate fully,
   shows the diff in record counts, confirms, then writes atomically under the lock. It never
   repairs automatically.

### 3.5 Offline-host and offline-API display

The TUI and web keep the last snapshot they read with its timestamp. When the API, or a host
behind a route, stops answering:
- rows render dimmed with "last known <age> ago";
- actions on those rows are disabled with the reason;
- reconnection backs off from 1 s to 2 min;
- a reconnect never triggers a write.

This extends the rule "unknown is never a pass" to the screen.

### 3.6 Safe worktree removal

For the `WorkspacePort.removeWorktree` that host-programs plan P5 introduces:
1. Run `git worktree remove --force <path>`.
2. If that fails and the directory still exists, delete it only when **all** of these hold:
   - `<path>/.git` is a file whose `gitdir:` line points into this repository's
     `.git/worktrees/<name>`;
   - `git worktree list --porcelain` no longer lists the path;
   - the path is inside the project's `worktreeRoot`, using the containment check from #163.
3. Otherwise refuse and report.
4. Run git with `LC_ALL=C` so its messages are stable, but decide from exit codes, never from
   message text.

## 4. Workbook

Every lane follows the lane pipeline and its tier. Tick a lane when its PR merges and note the PR.

### 4.1 Lanes

| Lane | Scope | Depends on | Tier | Pre-merge | Done |
|---|---|---|---|---|---|
| **E0** | This plan: owner decisions D1–D4 recorded | — | 0 | owner | ☑ (owner, 2026-10-25) |
| **E1a** | Quarantine-on-read-failure in the four `file-store.ts` copies plus tests per store (corrupt file → quarantine copy with identical bytes, throw names it, nothing written) | — | 2 (data) | Fable | E1a-i ☑ #180 (work-execution, evidence); E1a-ii ☐ (operator-coordination, brief-knowledge) |
| **E1b** | `fleet-v2 state check` and `state restore`, plus the `doctor` line | E1a | 2 | Fable | ☐ |
| **E2** | `ExplainAttemptUseCase`, `fleet-v2 attempt explain`, `GET /v1/attempts/:id/explain` | gate-predicates plan S1/S2 | 1 | Grok | ☐ |
| **E3a** | `ChangeSignalPort` and an in-memory ring adapter; repository saves emit signals; `mtime` watch emits `resync` | — | 2 (concurrency) | Fable | ☐ |
| **E3b** | `GET /v1/changes` chunked JSON-lines route with `after=<seq>`, `resync`, keep-alive, and the `read` scope | E3a, orchestrator plan T3a | 2 | Fable | ☐ |
| **E3c** | Lanes page subscribes through the web's server side and refreshes on signals; 30 s polling stays as the fallback | E3b, #174 | 2 (what the operator sees) | Fable | ☐ |
| **E4** | `OwnerNotificationPort`, the local adapter (D1), the three triggers, rate limit, `policy.notifications` | E3a | 2 | Fable | ☐ |
| **E5** | Offline display in the web Lanes page and the TUI shell (last-known snapshot, dimming, back-off, disabled actions) | E3c; onboarding plan P9 for the TUI half | 2 | Fable | ☐ |
| **E6** | Safe worktree removal inside `WorkspacePort.removeWorktree` | host-programs plan P5 | 2 (deletes data) | Fable | ☐ |

### 4.2 Waves

1. **Now:** E1a, then E1b; E3a can run alongside. These have no dependencies on unbuilt work.
2. **Next:** E2, once the gate predicates (S1/S2) exist; E4 after E3a.
3. **With the orchestrator plan:** E3b after T3a's scopes; E3c and E5 after it.
4. **With host-programs P5:** E6.

### 4.3 Brief notes

- **E1a:** read each context's `file-store.ts` and one adapter that uses it. Tests per store must
  check: the quarantine copy is byte-identical (compare SHA-256); a second failure keeps the
  last five copies; the file mode is 600; and a save after a failed read writes nothing.
- **E3a:** emitting a signal must never fail a save. The signal is sent after the save resolves,
  and an emitter error is swallowed and counted, never thrown. Tests cover a burst of saves, ring
  overflow producing `resync`, and a write by a second adapter instance producing `resync` from
  the `mtime` watch.
- **E3b:** a slow client must not hold memory without bound. Each connection gets a bounded
  queue; on overflow the server sends `resync` and drops the queue.
- **E4:** a test asserts that no notification text contains a path, a brief excerpt or lane
  output. Rendering goes through a fixed template per trigger.

## 5. Hard to undo

- **The `/v1/changes` contract** (E3b): once clients depend on its signal kinds, renaming one is a
  breaking change. The kinds are deliberately few and generic.
- **The quarantine directory layout** (E1a) is what operators and `state restore` rely on.

## 6. Decisions for the owner

Decided by the owner on 2026-10-25: all four as recommended ("yes, proceed with recommendations").

| Id | Question | Recommendation (decided) |
|---|---|---|
| D1 | Where do owner notifications go? | **macOS desktop notifications on the orchestrator host first** (one local adapter). A Waves push adapter later, once Waves is wired. |
| D2 | Signals only, or signals with state? | **Signals only.** A client re-reads the route, so a stale or lost signal can never show a wrong state. |
| D3 | Does the Lanes page keep polling once the stream exists? | **Yes, as the fallback** when the stream is unavailable or the token lacks `read`. |
| D4 | Should `state restore` be allowed through the API? | **No; CLI only**, like installation writes. Restoring state is host administration. |

## 7. Assumptions

- One API process per state directory. Writes from the CLI on the same directory are seen
  through the `mtime` watch as `resync`, not as precise signals.
- The orchestrator host is a desktop that can show notifications. On a headless orchestrator, D1's
  adapter is a no-op that says so in `doctor`.

## Challenge this

- **The `mtime` watch** is the least precise part. It turns any outside write into a full
  re-read for every client. With several CLI writers active during a wave, that could mean
  frequent full refreshes. The alternative is a write-ahead signal file that every writer appends
  to. It is more precise, but it is one more file every store must keep consistent.
