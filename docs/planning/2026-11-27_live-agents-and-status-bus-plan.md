# Plan: live agents, attach-to-watch, and the lightweight status bus

- **Date:** 2026-11-27
- **Target repository:** `fleet-v2`
- **Status:** rev 0, draft. Nothing built. No independent review yet; run one before the first brief.
- **Builds on:** `2026-10-27_conductor-plan.md` (§3.1, §3.2, §3.7, §3.8), `2026-10-31_daemon-tick-plan.md` (§3.4 `events.jsonl` projection), `2026-11-05_orchestrator-gap-closure-plan.md` (driver safety, recovery), `2026-11-02_feature-progress-view-plan.md` (format, honesty fields), `docs/architecture.md`, and `.architecture/manifest.yaml`. Inspired by the AWS Labs CLI Agent Orchestrator (Apache-2.0) for its session-watch and agent-handoff/inbox patterns; inspiration only — no code is copied.

**Short answer.** This plan covers three features in strict priority order: (1) a lightweight status/event path (`SB1`–`SB7`) that stops `fleet-v2 conductor status` from peaking at 4–4.7 GB RSS on a 16 GB operator host; (2) a read-only attach-to-watch stream (`AW1`–`AW6`) with ingestion-time secret redaction across CLI, TUI, API, and `/conductor`; and (3) a typed, journaled handoff/assign/inbox channel (`LH1`–`LH7`) where messages never grant authority and lane changes always become a new frozen brief.

---

## 1. Goal and non-goals

**Goal.**
1. **Priority 1 — Lightweight status/event path:** Bring `conductor status` (all-runs and per-run) under explicit peak RSS budgets (1 GB all-runs, 512 MB per-run) using a regenerable, append-only status projection and per-run snapshot index, single-flight coalescing, and a streaming rebuild path.
2. **Priority 2 — Attach-to-watch:** Give operators a read-only live tail of a running lane's session output (`opencode` event stream or `agy` output log) from CLI, TUI, and `/conductor`, with secret-shaped strings redacted at ingestion before buffering or serving.
3. **Priority 3 — Live handoff/assign/inbox:** Provide a typed, journaled agent coordination channel (`handoff`, `assign`, `inbox`) with bounded timeouts, depth/rate caps, and step-boundary delivery, while keeping frozen briefs as the sole instruction source for lanes.

**Non-goals.**
- No compaction or deletion of `journal.json` or other historical stores in this plan (deferred; we stop loading full stores on status reads first).
- No interactive input, keystroke forwarding, or text injection into a running lane session.
- No automatic promotion of handoff payloads or helper candidate notes into lane instructions or authority.
- No HTML rendering or auto-followed links in the web watch view.
- No copying of external orchestrator code.

---

## 2. What exists today

Verified against `fleet-v2` source:

- **Status read path:** `fleet-v2 conductor status [<runId>]` routes through `conductorStatusExit` in `apps/cli/src/conductor.ts` to `InspectLaneRunsUseCase` (`packages/work-execution/src/application/use-cases/InspectLaneRunsUseCase.use-case.ts`), wired in `apps/cli/src/composition/conductor.ts` with `runRepo`, `runJournal`, `halt`, `driverLease`, `attemptRepo`, `reviewReceipts`, and `executionJournal`.
  - Without `runId`, `InspectLaneRunsUseCase` calls `runRepo.list()`, then `runJournal.listForRun(record.runId)` for every run, plus per-run attempt, review-receipt, and active-reservation lookups (`crashedStartsOf`).
  - Even with `runId`, `crashedStartsOf` calls `runRepo.list()` to check all attempt ids across all runs.
- **Store adapters & sizes:** Adapters in `packages/work-execution/src/infrastructure/adapters/` (`LaneRunRepositoryAdapter`, `LaneRunJournalAdapter`, `AttemptRepositoryAdapter`, `ExecutionJournalAdapter`, using `withFileLock` from `file-store.ts`) read and parse whole-file JSON documents in full. Measured state-directory sizes total ~69 MB: `journal.json` (23.8 MB), `assessments.json` (12.9 MB), `orchestrators.json` (10.3 MB), `run-journal.json` (9.5 MB), `attempts.json` (7.3 MB), `reservations.json` (1.2 MB), `work-orders.json` (0.8 MB), `lane-runs.json` (0.4 MB), `conductor-passes.json` (0.3 MB).
- **Measured memory pressure:** One status read peaks at ~4–4.7 GB RSS due to full JSON parsing of multi-MB files and object duplication. Several concurrent status calls from the conductor driver put a 16 GB operator host under OOM pressure.
- **Projection precedent:** `DaemonEventProjectionAdapter` (`packages/work-execution/src/infrastructure/adapters/DaemonEventProjectionAdapter.adapter.ts`) appends `daemon/events.jsonl` as a regenerable projection (never a source of truth) with domain-owned cursor rules (`eventsAfterCursor`).
- **Secret-shape detection:** `@fleet/shared` (`packages/shared/src/secret-patterns.ts`) already exports `LANE_DIFF_SECRET_PATTERNS` (17 named patterns) and `SECRET_PATTERNS`.
- **Surfaces:** `apps/cli/src/tui/` provides the read-only Ink TUI (`tuiCommand`, `TuiApp`); `apps/web/src/app/conductor/` provides the `/conductor` run board backed by `apps/api` (`GET /v1/runs`, `GET /v1/runs/passes`).
- **Architecture constraints:** Domain is pure; application depends on ports; infrastructure owns filesystem/subprocess I/O; `.architecture/manifest.yaml` must be updated and regenerated with `yarn sync`; no `console` logging in package code.

---

## 3. Shape

### 3.1 Feature 3 (Priority 1): Lightweight status/event path (`SB1`–`SB7`)

1. **Memory-budget harness first (`SB1`).** Build a deterministic synthetic state-directory generator matching the measured ~69 MB footprint (`journal.json` 23.8 MB, `assessments.json` 12.9 MB, `run-journal.json` 9.5 MB, `attempts.json` 7.3 MB, etc.) and a peak-RSS test harness that fails if a per-run status read exceeds **512 MB** or an all-runs status read exceeds **1 GB**.
2. **Per-run status projection and snapshot index (`SB2`–`SB4`).**
   - Add an append-only, versioned, regenerable JSONL projection (`status-events.jsonl`, keyed by `runId`) plus a compact per-run snapshot index file written atomically (temp + rename under `withFileLock`).
   - Code paths that already append to `run-journal.json` or save `lane-runs.json` append the corresponding status event and update the run's compact snapshot entry.
   - The index is **never** a source of truth. Every read reports the index revision and age (`indexRevision`, `indexAgeMs`). When the index is missing or stale, `InspectLaneRunsUseCase` falls back to the full store path and explicitly marks the response as fallback/stale — never silently serving stale data.
   - Provide a streaming rebuild (`fleet-v2 conductor status --rebuild-index`) that scans the source stores in a streaming/chunked pass without materializing the entire 69 MB object graph in memory at once, plus a `state check` probe (`SB7`) that verifies index presence, schema version, revision, and age.
3. **Indexed `InspectLaneRunsUseCase` & single-flight coalescing (`SB5`–`SB6`).**
   - For all-runs `status`, `InspectLaneRunsUseCase` reads the compact snapshot index instead of loading `run-journal.json` and `attempts.json` for every run. For per-run `status <runId>`, it reads only that run's snapshot/journal slice.
   - Add a single-flight coalescing guard so the conductor driver issues **one** status read per pass and shares the result across the pass, and concurrent status callers await/reuse the in-flight read rather than each parsing multi-MB stores simultaneously.
4. **Deferred:** Compaction/retention of `journal.json` and sharding of large stores are deferred to a separate plan; this plan stops the status path from loading them.

### 3.2 Feature 2 (Priority 2): Attach-to-watch (`AW1`–`AW6`)

1. **Ingestion-time redaction & bounded ring buffer (`AW1`, `AW3`).**
   - Add a pure domain redactor reusing `LANE_DIFF_SECRET_PATTERNS` from `@fleet/shared` (plus a dedicated test corpus) that masks matched secret-shaped spans **at the ingestion port** before any line is buffered, persisted, or served.
   - Store tailed output per run in a bounded in-memory/file-backed ring buffer with strict size and age caps (e.g., 512 KB / 2,000 lines per run, 24h TTL). Output is advisory evidence only, never authority.
   - No input path exists: no keystrokes, no stdin forwarding, no message injection.
   - An unreadable, missing, or unconfigured stream returns a typed `'unavailable'` result with a reason code, never an empty success.
2. **Read-only surfaces (`AW4`–`AW6`).**
   - **API:** `GET /v1/runs/:id/watch?cursor=<id>` using cursor polling by default (same read-only authorization as `/v1/runs`).
   - **CLI:** `fleet-v2 conductor watch <runId>` (read-only tail, exits cleanly on interrupt or run end).
   - **TUI:** A read-only watch screen/pane in `apps/cli/src/tui/`.
   - **Web:** A watch drawer/panel on `/conductor` (`apps/web/src/app/conductor/`) that polls the API cursor, renders escaped plain text only (no HTML, no auto-linked URLs), and renders typed `'unavailable'` states honestly.

### 3.3 Feature 1 (Priority 3): Live handoff/assign between agents (`LH1`–`LH7`)

1. **Typed, journaled channel (`LH1`–`LH4`).**
   - Uses the existing `run-journal` conventions: keyed intent before action, typed result after, with idempotency keys of the form `<runId>/handoff/<n>`.
   - Payload is strictly typed (`kind`, `subjectIds`, size-capped `text`, `depth`, `senderId`, `targetId`) and carries **zero authority**. Frozen briefs remain the sole instruction source for lanes.
   - **Three modes:**
     - `handoff`: synchronous; sender blocks up to a bounded timeout (default **10 minutes**) for a typed result or a typed timeout refusal.
     - `assign`: asynchronous dispatch with a journaled callback record (`intent` + `callback` result).
     - `inbox`: messages queued and delivered **only when the target session is idle at a step boundary** (`LH5`), never mid-step.
2. **How a handoff becomes work (`LH6`).**
   - A handoff requesting changes to a lane's work **never** injects text into a running session. Instead, it triggers the existing `PrepareFixAttemptUseCase` / brief-authoring path to produce a **new frozen brief and a new round**, passing brief-lint, owned-paths checks, and review.
   - Handoffs between non-lane orchestrator helpers deliver their result as a **candidate note**, which never becomes an instruction or authority automatically (`AGENTS.md`).
3. **Safety caps & refusals (`LH1`, `LH7`).**
   - Depth limit of **2** (handoff chains deeper than 2 are refused with `handoff-depth-exceeded`).
   - Per-run message caps and rate limits, each returning an explicit typed refusal reason (`handoff-rate-limited`, `handoff-cap-exceeded`, `handoff-timeout`, `handoff-payload-oversized`, `handoff-target-busy`).

---

## 4. Units

Each unit is sized for a single ~45-minute lane.

| Unit | What | OWNED paths | Tier | After | ~45 min lane |
|---|---|---|---|---|---|
| `SB1` | Synthetic ~69 MB state-dir fixture & peak RSS budget test (512 MB per-run, 1 GB all-runs) | `packages/work-execution/src/__tests__/status-memory-budget.test.ts` | 1 | — | Yes |
| `SB2` | Domain status-event & compact snapshot index model (versioned schema, pure reducer, revision/age checks) | `packages/work-execution/src/domain/status-projection.ts`, `packages/work-execution/src/__tests__/status-projection.test.ts` | 2 | — | Yes |
| `SB3` | Status projection outbound port, `.architecture/manifest.yaml` updates & `yarn sync` | `.architecture/manifest.yaml`, `packages/work-execution/src/application/ports/out/LaneRunStatusIndexPort.out-port.ts` | 1 | `SB2` | Yes |
| `SB4` | Status JSONL + atomic snapshot index adapter (`withFileLock`) & streaming rebuild from stores | `packages/work-execution/src/infrastructure/adapters/LaneRunStatusIndexAdapter.adapter.ts`, `packages/work-execution/src/infrastructure/adapters/LaneRunJournalAdapter.adapter.ts`, `packages/work-execution/src/infrastructure/adapters/LaneRunRepositoryAdapter.adapter.ts` | 2 | `SB3` | Yes |
| `SB5` | Wire `InspectLaneRunsUseCase` to index/per-run reads with explicit stale/missing fallback & metadata | `packages/work-execution/src/application/use-cases/InspectLaneRunsUseCase.use-case.ts`, `packages/work-execution/src/application/ports/in/InspectLaneRunsPort.in-port.ts`, `apps/cli/src/composition/conductor.ts` | 2 | `SB4` | Yes |
| `SB6` | Single-flight coalescing guard for concurrent status callers & shared per-pass read in conductor driver | `packages/work-execution/src/application/use-cases/RunConductorPassUseCase.use-case.ts`, `packages/work-execution/src/infrastructure/adapters/SingleFlightStatusGuard.adapter.ts` | 2 | `SB5` | Yes |
| `SB7` | CLI `conductor status --rebuild-index` and `state check` index health probe + RSS budget verification | `apps/cli/src/conductor.ts`, `apps/cli/src/state.ts`, `apps/cli/src/__tests__/conductor-status-index.test.ts` | 1 | `SB5`, `SB1` | Yes |
| `AW1` | Pure domain stream redactor (reusing `LANE_DIFF_SECRET_PATTERNS` + corpus) & bounded ring buffer | `packages/work-execution/src/domain/watch-stream.ts`, `packages/work-execution/src/__tests__/watch-stream.test.ts` | 2 | — | Yes |
| `AW2` | Watch stream ports (`WatchLaneRunPort`, `LaneStreamTailPort`), `.architecture/manifest.yaml` & `yarn sync` | `.architecture/manifest.yaml`, `packages/work-execution/src/application/ports/in/WatchLaneRunPort.in-port.ts`, `packages/work-execution/src/application/ports/out/LaneStreamTailPort.out-port.ts` | 1 | `AW1` | Yes |
| `AW3` | Stream-tail adapters (`opencode` / `agy`) with ingestion redaction, ring buffer & `'unavailable'` handling | `packages/work-execution/src/infrastructure/adapters/LaneStreamTailAdapter.adapter.ts` | 2 | `AW2` | Yes |
| `AW4` | `WatchLaneRunUseCase` & read-only API route `GET /v1/runs/:id/watch` (cursor polling) | `packages/work-execution/src/application/use-cases/WatchLaneRunUseCase.use-case.ts`, `apps/api/server/routes/v1/runs/[id]/watch.get.ts` | 2 | `AW3`, `SB5` | Yes |
| `AW5` | CLI `fleet-v2 conductor watch <runId>` & read-only TUI watch view | `apps/cli/src/conductor.ts`, `apps/cli/src/tui/` | 1 | `AW4` | Yes |
| `AW6` | Web `/conductor` watch panel with escaped plain-text rendering, cursor polling & unavailable state | `apps/web/src/app/conductor/` | 2 | `AW4` | Yes |
| `LH1` | Domain handoff/assign/inbox types, `<runId>/handoff/<n>` keys, depth/rate/size caps & refusal reasons | `packages/work-execution/src/domain/agent-handoff.ts`, `packages/work-execution/src/__tests__/agent-handoff.test.ts` | 2 | — | Yes |
| `LH2` | Handoff/inbox ports, `.architecture/manifest.yaml` & `yarn sync` | `.architecture/manifest.yaml`, `packages/work-execution/src/application/ports/in/SendAgentHandoffPort.in-port.ts`, `packages/work-execution/src/application/ports/out/AgentHandoffJournalPort.out-port.ts` | 1 | `LH1` | Yes |
| `LH3` | Journaled handoff & inbox repository adapter (intent-before-action, `assign` callback records) | `packages/work-execution/src/infrastructure/adapters/AgentHandoffJournalAdapter.adapter.ts` | 2 | `LH2`, `SB4` | Yes |
| `LH4` | `SendAgentHandoffUseCase` (bounded sync `handoff` timeout & async `assign` with journaled callback) | `packages/work-execution/src/application/use-cases/SendAgentHandoffUseCase.use-case.ts` | 2 | `LH3` | Yes |
| `LH5` | `DeliverInboxAtStepBoundaryUseCase` & driver step-boundary hook (deliver only when idle between steps) | `packages/work-execution/src/application/use-cases/DeliverInboxAtStepBoundaryUseCase.use-case.ts`, `packages/work-execution/src/application/use-cases/RunConductorPassUseCase.use-case.ts` | 2 | `LH4`, `SB6` | Yes |
| `LH6` | Brief-authoring bridge for lane-change handoffs (new frozen brief/round) & candidate-note bridge for helpers | `packages/work-execution/src/application/use-cases/ApplyHandoffOutcomeUseCase.use-case.ts` | 2 | `LH4` | Yes |
| `LH7` | CLI `fleet-v2 conductor handoff\|assign\|inbox` subcommands & depth/rate/timeout refusal tests | `apps/cli/src/conductor.ts`, `apps/cli/src/composition/conductor.ts`, `apps/cli/src/__tests__/conductor-handoff.test.ts` | 1 | `LH5`, `LH6` | Yes |

---

## 5. Decisions

| # | Decision | Recommended default | Why |
|---|---|---|---|
| `D-LA1` | Status index format | Append-only versioned JSONL (`status-events.jsonl` keyed by `runId`) + atomic per-run snapshot index file | Matches `DaemonEventProjectionAdapter` (`events.jsonl`) precedent while giving O(1) list reads without scanning history |
| `D-LA2` | Status memory budgets | 512 MB peak RSS per-run read; 1 GB peak RSS all-runs read | Fits comfortably inside a 16 GB operator host even with other processes, down from 4–4.7 GB today |
| `D-LA3` | Is the status index a source of truth? | No — regenerable projection only, with explicit fallback and `indexRevision`/`indexAgeMs` reporting | Preserves `run-journal.json` and `lane-runs.json` as authoritative; never silently serves stale state |
| `D-LA4` | Compaction of `journal.json` and large stores | Deferred — do not compact in this plan; only stop loading full stores on status reads | Compaction is hard to undo and risks losing audit history; index + per-run reads solve the immediate OOM pressure safely |
| `D-LA5` | Watch transport (SSE vs cursor polling) | Cursor polling (`GET /v1/runs/:id/watch?cursor=...`); SSE deferred | Simpler proxy/Nitro behavior, stateless retries, matches `eventsAfterCursor` and existing `useAutoRefresh` patterns |
| `D-LA6` | Secret redaction point | At the ingestion port (domain redactor reusing `LANE_DIFF_SECRET_PATTERNS`) before buffering or serving | Guarantees raw secrets never enter the ring buffer, disk, API responses, or browser |
| `D-LA7` | Watch stream retention | Bounded per-run ring buffer (512 KB / 2,000 lines, 24h TTL) | Prevents unbounded memory/disk growth on long-running or noisy lanes; watch output is disposable |
| `D-LA8` | Synchronous `handoff` timeout | 10 minutes default (configurable cap, never unbounded) | Prevents a blocked sender from holding a pass or lease indefinitely; returns a typed timeout refusal |
| `D-LA9` | Handoff chain depth limit | Maximum depth of 2, plus per-run message and rate caps | Stops runaway agent-to-agent handoff loops while allowing a primary handoff and one follow-up |
| `D-LA10` | How a handoff becomes lane work | New frozen brief and new round via `PrepareFixAttemptUseCase` / brief-authoring path | Enforces brief-lint, owned-paths checks, and review; never injects unreviewed text into a running session |
| `D-LA11` | `inbox` delivery timing | Only at step boundaries when the target session is idle | Avoids mid-step context corruption or race conditions inside an active tool/model turn |
| `D-LA12` | Are `assign` callbacks journaled? | Yes — keyed intent before dispatch and journaled callback record after | Preserves crash-safe reconciliation and auditability consistent with `run-journal.json` |

---

## 6. Security notes

- **Secret redaction at ingestion (`AW1`, `AW3`):** All stream lines pass through the domain redactor (using `LANE_DIFF_SECRET_PATTERNS` from `@fleet/shared`) before entering the ring buffer or leaving the adapter. Matched values are replaced with `[REDACTED:<rule>]` and never logged.
- **Read-only watch boundary (`AW4`–`AW6`):** `conductor watch`, the TUI watch pane, `GET /v1/runs/:id/watch`, and the `/conductor` watch panel have no write or input path. Authorization matches the existing read-only run board. Web rendering escapes all output as plain text (no `dangerouslySetInnerHTML`, no auto-linked URLs).
- **Zero-authority messaging (`LH1`, `LH6`):** Handoff, assign, and inbox payloads are untrusted data, never instructions. Lane changes must pass `PrepareFixAttemptUseCase` / brief-lint / owned-paths validation as a new frozen brief; helper handoffs emit candidate notes only.
- **No `console` in packages:** All CLI output goes through `CliIo`; package code uses typed return values and ports only.

---

## 7. Risks

- **Index drift on crash:** A crash between appending `run-journal.json` and updating the snapshot index could leave the index behind. Mitigation: `InspectLaneRunsUseCase` compares index revision/age against store metadata and falls back to the authoritative stores (reporting stale/fallback explicitly), and `--rebuild-index` recovers cleanly.
- **Redactor false negatives on novel token formats:** Custom or novel credential shapes not in `LANE_DIFF_SECRET_PATTERNS` could pass through watch output. Mitigation: test corpus in `AW1`, explicit advisory-only framing, and no persistence beyond the bounded ring buffer.
- **Handoff fan-out / deadlock:** Synchronous `handoff` callers blocking while holding a pass slot or lease could stall other runs. Mitigation: 10-minute timeout (`D-LA8`), depth limit 2 (`D-LA9`), and releasing/not holding unrelated run leases while awaiting a handoff.

---

## 8. Order

1. **Feature 3 first (Priority 1 — Status Bus):**
   `SB1` (parallel with `SB2`) → `SB3` → `SB4` → `SB5` → `SB6` & `SB7` (after `SB5` and `SB1`).
   `SB5` must land before `AW4` and `LH5` so no new feature adds load to the unindexed status path.
2. **Feature 2 second (Priority 2 — Attach-to-Watch):**
   `AW1` → `AW2` → `AW3` → `AW4` (after `AW3`, `SB5`) → `AW5` & `AW6` in parallel (after `AW4`).
3. **Feature 1 third (Priority 3 — Live Handoff/Assign):**
   `LH1` → `LH2` → `LH3` (after `LH2`, `SB4`) → `LH4` → `LH5` (after `LH4`, `SB6`) & `LH6` (after `LH4`) in parallel → `LH7` (after `LH5`, `LH6`).

---

## Hard to undo

- **Journal key formats (`<runId>/handoff/<n>`):** Once written to `run-journal.json`, old entries must remain readable by future builds (`OG-27` compatibility rule).
- **Public API/CLI shapes (`GET /v1/runs/:id/watch`, `conductor watch`, `conductor handoff|assign|inbox`):** Flag and envelope changes after release break operator scripts and the web client.
- **Deferring compaction (`D-LA4`):** Reversible later, whereas premature compaction of `journal.json` is irreversible if audit records are dropped.

## Assumptions

- The measured ~69 MB state-directory breakdown and ~4–4.7 GB peak RSS reproduce with synthetic fixtures of matching size and record counts (`SB1`).
- `opencode` event streams and `agy` output logs are readable as line-oriented text/NDJSON from the runner adapter without adding new host credentials.
- Existing `PrepareFixAttemptUseCase` and brief-lint paths can accept a structured handoff summary as input for authoring a new frozen brief (`LH6`).

## Challenge this

- Should `SB6` (single-flight guard) also cache the all-runs index snapshot for a short TTL (e.g. 1–2 s) for bursty web `/conductor` polling, or is in-flight coalescing alone enough once the index is <1 MB?
- Is 512 KB / 2,000 lines per run in `AW1` enough for debugging long `agy` or `opencode` runs, or should `AW3` support reading the tail directly from the runner's log file with an offset cursor?
- Does `LH4` need synchronous `handoff` at all in v1, or would `assign` + `inbox` alone avoid blocking driver passes while keeping the same journal semantics?
