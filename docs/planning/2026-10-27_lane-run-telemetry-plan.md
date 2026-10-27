# Plan: lane runs as traces in Phoenix

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 0, not yet reviewed. Decisions in §6 are open with recommended defaults. Nothing built. Anchors checked against `main` at `e000732`.
- **Owner request (2026-10-27):** "Yes write a plan to send lane runs to Phoenix as traces."
- **Builds on:** `2026-10-27_conductor-plan.md` (`LaneRun`, the keyed run journal K1b, the decider, §3.2 states, §3.5 crash and resume, §3.9 reaper, D2 driver placement), `2026-10-23_attempt-record-gate-predicates-usage-plan.md` (S1 seat selection, S3 usage), `2026-10-27_work-board-plan.md` (§3.12 telemetry, WB12), `2026-10-27_web-ui-interactivity-plan.md` (§3.7 live tail, F13 content policy, P10 usage chips).

## 1. Goal

Every lane run that fleet-v2 records shows up in Phoenix (Arize Phoenix, an LLM-observability app) as an OpenTelemetry trace: which steps ran, on which seat and model, for how long, with how many tokens and what metered cost, and how each step ended. The trace is derived from records fleet-v2 already keeps, so a lane that ran last week can be exported the same way as one running now, and exporting twice changes nothing.

Telemetry is a **copy of facts for reading**, never a source of truth and never on a lane's critical path. It is off unless configured. A failed send drops spans and is retried by the next export; it never blocks, fails, slows or changes a lane.

**Non-goals.** No prompts, briefs, diffs, code, review text or lane output in any span (§3.2). No new runner, seat or model. No instrumentation inside lanes, and no telemetry setting reaches a lane's environment. No metrics or logs pipeline (traces only). No Phoenix evaluations, datasets or prompt management. No live view: the web's live tail (web plan §3.7) is the live view; Phoenix is for after-the-fact reading, cost and seat comparison. No link from the web to Phoenix in v1 (a Phoenix URL is host configuration).

## 2. What exists (checked on `main`, 2026-10-27)

| Fact | What exists | Anchor | Gap for telemetry |
|---|---|---|---|
| OpenTelemetry | Nothing: no OTLP, OTel or Phoenix code or dependency in any package | `packages/*/package.json` (only `@fleet/*` workspace dependencies) | Everything |
| Attempts | `AttemptRecord`: kind, `fixNumber`, `priorAttemptId`, state, outcome, runner, `seatSelection`, `stopReason`, `usage` | `packages/work-execution/src/domain/execution-records.ts:174-211` | Also carries `worktreePath`, `briefPackagePath`, runner `host`: never exported (§3.2) |
| Usage | `AttemptUsageRecord`: steps, wall seconds, five token counts, `costUsd`, model, agent, `source` (`opencode-db` \| `unavailable`) | `execution-records.ts:141-156`; `UsagePort.out-port.ts:15-28`; filled at collect (S3) | Session totals only; agy attempts read `unavailable` |
| Usage read | One reviewed node script reads numeric columns of opencode's `session` table and counts assistant messages; never message text | `OpencodeDbUsageAdapter.adapter.ts:62-110` | No per-step (per model call) numbers (§3.7, D8) |
| Attempt journal | `ActionJournalEntryRecord`: `dispatch, reconcile, stop, collect, forge, accept`, status, `recordedAtIso`, `detail` (free text) | `execution-records.ts:259-276` | `detail` is free text: never exported |
| Run journal (K1b) | `LaneRunJournalEntryRecord`: `intent` / `result` / `conduct`, key, `recordedAtIso`, typed `outcome`, `reasonCode` (`^[a-z][a-z0-9-]{0,63}$`), `state` | `packages/work-execution/src/domain/lane-run-journal.ts:19-62` | Domain merged (K1b-1, K1b-2); its file and memory stores are not on `main` |
| Run keys | `<runId>/r<round>/<step>/<seatIndex>[/a<n>][@<head12>][/retry<n>]`, stop, resume, request and reaper keys; one parser | `lane-run-keys.ts:57-82`, `:353`; steps at `lane-run-records.ts:32-36` | The key is the natural span identity (§3.4) |
| Lane run | `LaneRunRecord`: run id, work order, tier, round, attempt ids, PR number, park | `lane-run-records.ts:115-136`; store `LaneRunRepositoryPort.out-port.ts:29` (K3-2) | Driver (K7) not built |
| Reviews | `ReviewReceiptRecord`: reviewer and implementer model, result, findings (severity, **summary, filePath**), head, `completedAtIso` | `packages/evidence-and-acceptance/src/domain/evidence-records.ts:30-60` | Only severity counts are exportable; review `kind` arrives with RW1 |
| Gate | `VerificationReceiptRecord`: result, exit code, coverage, **hostId, procedureName, evidenceRef** | `evidence-records.ts:13-28` | Only result, exit code and timing are exportable |
| Billing | The web labels opencode figures as recorded and agy figures as plan-billed estimates | `apps/web/src/lib/usage-view.ts:12-21`, `:86-91` | The rule lives in the web only; telemetry needs the same rule in the domain |
| Observation | `ExecutionObservationPort`: publish recorded observations, a delivery gap never fails the lane | `ExecutionObservationPort.out-port.ts:1-24`; wired at `apps/cli/src/composition.ts:1480` | The right failure contract; the wrong payload (journal entries with free text) and the wrong supplier (Waves) |
| Secret shapes | Shared registry and `containsSecretShape` | `packages/shared/src/secret-patterns.ts:51`, `:72` | Reused as one of the redaction tests' checks |
| Token files | The API reads its bearer from `FLEET_API_TOKEN_FILE` | `apps/api/server/plugins/runtime.ts:2-20` | The same pattern serves the telemetry bearer |
| Runner env | `RUNNER_ENV_ALLOWLIST` builds a lane's environment | `ExecutionRunnerAdapter.adapter.ts:204-229` | Telemetry variables must never join it (§3.5) |

Lane activity today also lives in places this plan does not read: opencode's own database beyond the S3 columns, the orchestrator's hand-kept seat telemetry (private notes, never parsed), and lanes run with the runner script outside fleet-v2's records (they have no attempt record, so there is nothing to export).

### 2.1 What Phoenix and OpenInference expect (researched 2026-10-27)

- **Span kinds.** OpenInference puts the kind in `openinference.span.kind`; values are `LLM`, `EMBEDDING`, `CHAIN`, `RETRIEVER`, `RERANKER`, `TOOL`, `AGENT`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`, `DECISION` [1].
- **LLM attributes.** `llm.model_name`, `llm.provider`, `llm.system`, `llm.invocation_parameters` (a JSON string); tokens `llm.token_count.prompt`, `.completion`, `.total`, `llm.token_count.prompt_details.cache_read`, `.cache_write`, `llm.token_count.completion_details.reasoning`; cost in USD `llm.cost.prompt`, `llm.cost.completion`, `llm.cost.total` and detail keys [1].
- **Grouping.** `session.id` groups traces into a Phoenix session; `agent.name`, `tag.tags`, `metadata`, `user.id`; content in `input.value` / `output.value` [1].
- **Project.** The resource attribute `openinference.project.name` [2]; Phoenix's `/v1/traces` takes an `x-project-name` header first, then that attribute [3].
- **Transport.** Phoenix's HTTP receiver at `/v1/traces` accepts `Content-Type: application/x-protobuf` only (415 otherwise), with optional `gzip` or `deflate` [3]; it also serves OTLP/gRPC [4].
- **Auth.** Bearer: `Authorization: Bearer <system API key>`, header name lowercased for gRPC [5].
- **Idempotency.** Phoenix inserts spans with `unique_by=("span_id",)` and `OnConflict.DO_NOTHING`: a duplicate span id is ignored, the **first write wins**, and a trace keeps the project of its first span [6].
- **OTLP itself.** OTLP/HTTP also defines a JSON encoding (`Content-Type: application/json`, trace and span ids as hex strings); retry on 429, 502, 503, 504, honour `Retry-After`; never retry a partial success [7]. A collector's OTLP receiver accepts both encodings; Phoenix's does not take JSON.

Sources: [1] OpenInference semantic conventions, `github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md`; [2] `openinference-semantic-conventions`, `semconv/resource/__init__.py` (`PROJECT_NAME = "openinference.project.name"`); [3] Phoenix `src/phoenix/server/api/routers/v1/traces.py`; [4] `arize.com/docs/phoenix/sdk-api-reference/python/arize-phoenix-otel`; [5] `arize.com/docs/phoenix/self-hosting/features/authentication`; [6] Phoenix `src/phoenix/db/insertion/span.py`; [7] `opentelemetry.io/docs/specs/otlp/`. [3] and [6] were read on Phoenix's `main`; the deployed version is unverified against them (§7).

## 3. The shape

### 3.1 What a trace is

**A conducted run is one trace.** Its id is derived from the run id. The hierarchy:

```text
lane-run                          CHAIN      root; emitted when the run is terminal (D2)
├─ round r0 | r1 | r2             CHAIN      one per round that started
│  ├─ prepare, dispatch           CHAIN      one span per step key (intent → final result)
│  ├─ attempt                     AGENT      dispatch result → collect result; agent.name = seat role
│  │  └─ usage                    LLM        only when usage.source = opencode-db
│  ├─ collect, reconcile, stop    CHAIN
│  ├─ gate                        GUARDRAIL  result, exit code
│  ├─ brief-check, code-review    EVALUATOR  reviewer model, verdict, finding counts by severity
│  └─ pre-merge                   EVALUATOR
├─ accept                         DECISION   accepted / rejected at head12
├─ open-pr, push, merge           TOOL       forge actions; PR number, head12
├─ ci-wait                        CHAIN      watching-ci conduct entry → next conduct entry; CI result
├─ park                           DECISION   park entry → its exit; reason, qualifier
└─ stop-request                   DECISION   instant; mode graceful | force
```

Steps that belong to no round (accept, forge actions, CI, parks, stops) hang under the root; steps keyed with a round hang under that round's span. The root carries `conduct` entries as span events (`state.entered`, with the state name only), so the state sequence is visible without a span per state.

**One span per key.** A keyed step's span runs from its intent's `recordedAtIso` to its **final** result's. `ambiguous` results are not final: they are counted on the span (`fleet.ambiguous_results`), and the span is emitted only once a final result exists. A retry key (`…/retry1`) is its own span. Reaper keys and request-channel keys are not part of a run trace in v1.

**A span is emitted only when it is closed.** Phoenix keeps the first write of a span id (§2.1), so a span sent with a guessed end time could never be corrected. Children are emitted as their steps close; the round span when the next round starts or the run ends; the root when the run is `merged` or `stopped` (D2).

**Hand-run attempts** (dispatched with `attempt dispatch`, no `LaneRun`) are one trace per attempt: the `attempt` AGENT span is the root, its usage LLM child, and the gate and review receipts recorded for the attempt's collected head as children. A receipt that arrives after the root was sent attaches to the existing trace by its deterministic parent id. Every span of a work order, conducted or hand-run, carries `session.id = <workOrderId>`, so Phoenix's session view shows a work order's attempts, fix rounds and runs together (D1).

**Model calls inside an attempt.** v1 knows only session totals, so an attempt has one `usage` LLM span covering the attempt. One LLM span per model call needs a per-message read of opencode's numeric columns; that is OT6, behind D8.

**Trace context propagation.** Nothing to propagate in v1. The runner script, opencode, agy, the grok CLI and the forge accept no trace context from fleet-v2 that this plan relies on, and a lane must not receive telemetry settings (§3.5). Ids are **derived, not propagated**: any component that knows a run id, attempt id or key can compute the trace and span id, so the API, the web or a later in-lane exporter can join the same trace without a header.

### 3.2 What is never sent (hard rule)

**Allowed, and nothing else.** Every attribute key is on one allow-list (`RUN_TELEMETRY_ATTRIBUTES`, domain), each with a validator. A value that fails its validator drops the attribute, never the span.

| Kind of value | Keys | Validator |
|---|---|---|
| Ids | `fleet.run.id`, `fleet.work_order.id`, `fleet.attempt.id`, `fleet.prior_attempt.id`, `session.id` | The record's own id pattern (ULID forms) |
| Project | `fleet.project` | An alias from `policy.telemetry.projectAliases`, or a 12-hex salted digest of the project id (D4) |
| Steps and states | `fleet.step`, `fleet.state`, `fleet.round`, `fleet.seat.index`, `fleet.seat.role`, `fleet.tier`, `fleet.attempt.kind`, `fleet.fix_number` | The domain's enum lists (`LANE_RUN_KEY_STEPS`, `LANE_RUN_STATES`, `SeatPlanRole`) and bounded integers |
| Outcomes | `fleet.outcome`, `fleet.reason_code`, `fleet.stop_reason`, `fleet.park.reason`, `fleet.park.qualifier`, `fleet.gate.result`, `fleet.review.kind`, `fleet.review.result`, `fleet.ci.result`, `fleet.stop.mode` | Enum lists; `reasonCode` by `LANE_RUN_JOURNAL_REASON_CODE_PATTERN` |
| Counts | `fleet.review.findings.blocker`, `.major`, `.minor`, `.nit`, `fleet.gate.exit_code`, `fleet.ambiguous_results`, `fleet.usage.steps` | Finite integers ≥ 0 (exit code: −1..255) |
| Seats | `llm.model_name`, `llm.provider`, `agent.name`, `fleet.seat.tool` (`opencode` \| `agy` \| `review-cli`), `fleet.seat.billing` (`metered` \| `plan` \| `unknown`), `llm.invocation_parameters` (`{"variant":…}` only) | Model id pattern `^[a-z0-9][a-z0-9._:/-]{0,127}$`; enums |
| Usage | `llm.token_count.*` (the six keys of §2.1), `fleet.usage.source`, `fleet.usage.wall_seconds` | Finite numbers ≥ 0 |
| Cost | `llm.cost.total` (metered seats only), `fleet.cost.estimate_usd` and `fleet.cost.basis` (`metered` \| `plan-estimate` \| `unknown`) | Finite ≥ 0; §3.6 |
| Forge | `fleet.pr.number`, `fleet.head12` | Positive integer; 12 lowercase hex |
| Schema | `fleet.telemetry.schema` (`1`), `tag.tags` (fixed tokens: `conducted`, `hand-run`, `dry-run`, `shadow`, `tier-1`, `tier-2`) | Constant; enum list |

Resource attributes: `service.name = fleet-v2`, `service.version`, `openinference.project.name`. Nothing else: no host, process, OS or SDK resource detectors run.

**Never sent, by construction.** Prompts, briefs and brief paths, handover text, diffs, code, file paths, review finding summaries and file paths, review or gate output, `detail` and any other free text, PR titles or bodies, branch names, repository names, worktree paths, host names and host ids, ports, URLs, session ids of the runner, procedure names, evidence refs, owner question text, secrets and anything secret-shaped, client content, user ids. In OpenInference terms: `input.value`, `output.value`, `llm.input_messages`, `llm.output_messages`, `llm.prompts`, `llm.prompt_template.*`, `tool.*`, `message.*`, `metadata`, `user.id`, `exception.*`, `http.*`, `url.*`, `server.*`, `host.*`, `process.*` never appear. Span status messages carry a reason code or nothing. Span names are fixed strings from §3.1.

**How it is enforced.** The pure mapper takes typed facts (§3.3), not records, and the facts type has no string field that is not an id, an enum or a validated model id. The encoder accepts only `TelemetrySpan` values built by the domain's constructor, which applies the allow-list. A text field cannot reach the wire without changing the facts type, the allow-list and the tests below at once.

**Redaction tests (OT1a; each its own test).**
1. **Canaries.** Fixture attempts, journals, receipts and runs with every string field set to `CANARY-<field>` (worktree path, brief path, host, host id, `detail`, finding summary and path, disposition reason, procedure name, evidence ref, branch); map, encode the OTLP payload, and assert no `CANARY` in the bytes.
2. **Key allow-list.** Every attribute key in every encoded span and resource is in `RUN_TELEMETRY_ATTRIBUTES`; every key on the never list above is absent.
3. **Values.** Every string value matches its key's validator; numbers are finite.
4. **Secret shapes.** `containsSecretShape` is false on the encoded payload of fixtures seeded with secret-shaped strings in every free-text field.
5. **Adapter errors.** A failed send's outcome names an error kind (`timeout`, `network`, `http-4xx`, `http-5xx`, `partial`) and never the endpoint, a header or a response body.

### 3.3 Place in the hexagon

The facts belong to `work-execution` (attempts, usage, the run journal, runs) and are read from `evidence-and-acceptance` through ports `work-execution` already consumes (`AcceptanceEvidencePort` for receipts). So telemetry is a **consumer-side out-port in `work-execution`**, not a fifth context and not a port in each supplier context; the manifest's dependency direction is unchanged.

- **Domain (`run-telemetry.ts`):** `TelemetrySpan` (trace id, span id, parent id, name, kind, start and end, status, attributes, events), `RUN_TELEMETRY_ATTRIBUTES` with validators, the id derivation (§3.4), the billing rule (§3.6), and pure `laneRunSpans(runFacts)` and `attemptTraceSpans(attemptFacts)` returning closed spans only. Never throws, never reads a clock.
- **Application:** `RunTelemetryPort` (out): `export(spans) → { outcome: 'accepted' | 'disabled' | 'dropped', dropped, errorKind }`, which never throws. `ExportRunTelemetryUseCase`: select runs and attempts (by run, work order, or `--since`), gather facts through the existing ports (attempt repository, K1b's journal store, K3's run store, `AcceptanceEvidencePort`), map, apply sampling, call the port, advance the cursor. `TelemetryExportCursorPort` (out; file and memory stores in the state directory): the last span id exported per trace, so a live export does not resend a run's earlier spans. The cursor is an optimisation, not correctness: Phoenix ignores a resent span (§2.1).
- **Infrastructure:** `NoopRunTelemetryAdapter` (the default: no endpoint configured), `RecordingRunTelemetryAdapter` (tests, dry-run), `OtlpHttpRunTelemetryAdapter` (§3.5).
- **Composition:** `apps/cli` builds the OTLP adapter when `policy.telemetry.enabled` and an endpoint and token file are configured, else the no-op; `apps/api` composes the no-op in v1, since the API drives no run (conductor D2: the driver is a CLI process on the orchestrator's machine).

`ExecutionObservationPort` is not reused: its payload is the attempt journal entry, which carries free text, and its supplier is the Waves publication. Its failure contract (a delivery gap never fails the lane) is copied.

### 3.4 Deterministic ids

- Trace id (16 bytes) = the first 16 bytes of `sha256("fleet-telemetry/v1/trace/run/" + runId)`; for a hand-run attempt, `…/trace/attempt/" + attemptId`.
- Span id (8 bytes) = the first 8 bytes of `sha256("fleet-telemetry/v1/span/" + runId + "/" + <identity>)`, where the identity is the full journal key for a keyed step, `round/<r>` for a round, `attempt/<attemptId>` and `usage/<attemptId>` for an attempt and its usage, `ci/<n>` and `park/<n>` for the n-th CI wait and park, and `root`.
- An all-zero id (invalid in OTLP) is replaced by flipping its last bit; a test covers the rule.
- Start and end times come from the records (`recordedAtIso`, `completedAtIso`), never from the clock at export, so a backfill encodes the same span byte for byte as the live export.
- `v1` is in every hash input. A change to the mapping that must replace spans already sent bumps it to `v2` and goes to a new Phoenix project (§5), because Phoenix never updates a span id it holds.

Sampling, when configured below 1.0, is decided on the trace id (the first 8 bytes as an integer against the ratio), so every span of a trace, live or backfilled, makes the same choice. Default 1.0: a run has a few dozen spans.

### 3.5 The OTLP adapter: batching, retry, drop

- **Wire format (D5).** OTLP/HTTP with the JSON encoding, built by a small encoder in the adapter over the fixed subset §3.2 allows (resource, one scope, spans with string, integer, double, boolean and string-array attributes, events, status). No new dependency, no SDK, and so no default resource detectors that would add host and process attributes. The JSON goes to the cluster's OTLP collector, which forwards to Phoenix in protobuf. Sending straight to Phoenix needs protobuf (§2.1) and therefore an OTel exporter dependency: D5's alternative.
- **Queue.** In memory, bounded (2048 spans); a full queue drops the newest and counts it. A batch is at most 512 spans or 1 MiB, flushed every 5 s or when full.
- **Send.** One request at a time per process; 5 s timeout. Retry 429, 502, 503 and 504 at most twice (1 s, then 4 s, or `Retry-After` capped at 30 s); never retry other 4xx or a partial success. After that the batch is dropped and counted; the cursor does not advance past dropped spans, so the next export or a backfill resends them.
- **Never blocks.** The use case enqueues and returns; the HTTP work runs on the adapter's own promise chain. On process exit the CLI flushes for at most 2 s, then drops. The adapter never throws to its caller, never logs (package code has no console output); its counters are written to the cursor store and `telemetry status` prints them at the CLI boundary.
- **Transport safety.** `https:` is required unless the endpoint is loopback. The bearer is read from a file (`FLEET_TELEMETRY_TOKEN_FILE`, like `FLEET_API_TOKEN_FILE`) when the adapter is built, never logged, and sent only to the configured endpoint. Neither `FLEET_TELEMETRY_*` variable may join `RUNNER_ENV_ALLOWLIST`; a test asserts that the runner environment never contains them.

### 3.6 Cost

- **Metered seats** (runner kind `opencode`): `llm.cost.total` = the recorded `costUsd`; `fleet.cost.basis = metered`. A free seat records 0, which is sent as 0.
- **Plan-billed seats** (runner kind `agy`; reviews on plan CLIs): no `llm.cost.*` ever, so Phoenix's cost totals stay spend. A figure, when one exists, goes in `fleet.cost.estimate_usd` with `fleet.cost.basis = plan-estimate`. agy usage reads `unavailable` today, so v1 sends no estimate for agy.
- **Unknown** runner kind or `costUsd: null`: no cost attribute; `fleet.cost.basis = unknown`.
- The billing rule moves from the web (`usage-view.ts:12-21`) into the work-execution domain, and the web imports it, so the board, the web and telemetry cannot disagree (OT1a).

Whether Phoenix prices spans from its own model table when `llm.cost.*` is absent, and whether it prefers a sent `llm.cost.total` over its table, is unverified; OT3's acceptance sends one fixture span to a test project and reads its cost.

### 3.7 Who emits what

| Source | How it reaches Phoenix | Lane |
|---|---|---|
| Conducted runs | The driver (K7) calls `ExportRunTelemetry` for the run after each `advance` has journalled its result, best effort; the root when the run ends | OT5 |
| Hand-run attempts (`attempt dispatch`) | `fleet-v2 telemetry export` after the fact, from attempt records, usage and receipts; an orchestrator runs it after a lane's merge, or on a schedule it owns | OT4 |
| Past runs and attempts | The same command with `--since` (§3.8) | OT4 |
| Lanes run with the runner script outside fleet-v2 | Nothing: no record exists. Registering the work order and dispatching through fleet-v2 is the way in | — |
| Per-call model spans | OT6, behind D8 | OT6 |

**opencode's own OpenTelemetry (researched; partly verified).** opencode's published config schema has `experimental.openTelemetry`, marked deprecated, described as "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)", and no exporter, endpoint or header keys; the root rejects unknown keys (verified against the schema at `opencode.ai/config.json`, 2026-10-27). Whether the server registers an OTLP exporter from the standard `OTEL_EXPORTER_OTLP_*` variables is **unverified**. The AI SDK's telemetry records prompts and responses by default, which §3.2 forbids. **Recommendation (D9): do not enable it.** If it is ever wanted, it is a separate plan with a collector that drops every content attribute before Phoenix.

**agy and the grok CLI.** No OpenTelemetry export is known for either (unverified). Their facts reach Phoenix through fleet-v2's records only: agy attempts as AGENT spans without usage, grok and other review CLIs as EVALUATOR spans from receipts.

### 3.8 Backfill

`fleet-v2 telemetry export [--since <ISO date>] [--until <ISO date>] [--run <runId>] [--work-order <id>] [--dry-run] [--json]`

- Selects conducted runs and hand-run attempts with any record time in the window, maps them, and exports. Idempotent: the ids are deterministic and Phoenix ignores a resent span, so overlapping windows and repeated runs are harmless.
- `--dry-run` sends nothing and prints the spans as JSON exactly as they would be encoded (attributes included). It is how the owner reviews what leaves the machine before the first live send (D11), and it works without any endpoint configured.
- `telemetry status` prints whether telemetry is configured (never the endpoint or token), the last export time, and sent, dropped and error-kind counters.
- Exit codes per `AGENTS.md`: `0` every selected span was sent or there was nothing to send; `1` telemetry is not configured (refused), or some spans were dropped; `2` usage error.

### 3.9 Configuration and the route to Phoenix

**Installation policy** (`policy.telemetry`, in the installation file, which lives in an ignored path): `enabled` (absent = off), `projectName` (default `fleet-lanes`), `sampleRatio` (default 1.0), `sendCost` (default true), `includeDryRun` (default true, tagged), `projectAliases` (project id → alias), `projectSalt` (for the digest, D4). **Host-side environment:** `FLEET_TELEMETRY_ENDPOINT` (the collector's OTLP/HTTP traces URL) and `FLEET_TELEMETRY_TOKEN_FILE`. Neither the endpoint nor the token is ever committed; this plan names no host.

**Where the exporter runs.** On the orchestrator's machine and the lane host side, not in the cluster: the driver and the export command are CLI processes there (conductor D2). Three routes from there to Phoenix, which runs on the staging cluster and today is fed by in-cluster apps through the cluster's OTLP collector:

1. **The collector's OTLP/HTTP receiver behind a LAN-only ingress route** with TLS and its own bearer (server-side auth on the receiver), forwarding to Phoenix with Phoenix's key. **Recommended (D13).** One ingest door; Phoenix's key never leaves the cluster; the host token is separate and revocable; the collector can add an attribute filter (drop any key outside `fleet.*`, `llm.*`, `session.id`, `agent.name`, `tag.tags`, `openinference.*`) as defence in depth.
2. **Phoenix's own ingress, directly,** with a Phoenix system API key on the host: protobuf only (D5 alternative), and the key that can also read Phoenix sits on the host.
3. **A loopback forward** (an SSH or port forward to the collector service) for one-off backfills; no ingress, `http:` allowed because the endpoint is loopback.

**In-cluster egress.** Not needed in v1: `@fleet/api` emits nothing (§3.3). If the API or a driver ever runs in the cluster, it gets the same egress policy as the other in-cluster apps that feed the collector, in the platform repository.

**Owner items (not lanes; the platform repository is private and the owner's).**
- O-1: a Phoenix project for lanes (or accept `fleet-lanes` being created on first write) and its retention (D7).
- O-2: route 1: the collector's OTLP/HTTP receiver behind a LAN-only route with server-side bearer auth and the attribute filter; the host token in a cluster secret and in a `0600` file on each exporting host. Tier 0 platform PR.
- O-3: after D11, the first live export, read back in Phoenix.

## 4. Workbook

Each lane is about 45 minutes, one PR, the standard pipeline. Shared files are flagged in bold; lanes that touch `.architecture/manifest.yaml`, `apps/cli/src/composition.ts` or `apps/cli/src/index.ts` merge one at a time, rebased, in sequence with the conductor's lanes that touch them (K7, K11b, AM5, O5).

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| OT0 | This plan and the owner's decisions | docs | 0 | — |
| OT1a | `run-telemetry.ts`: `TelemetrySpan`, `RUN_TELEMETRY_ATTRIBUTES` and validators, id derivation (§3.4), the billing rule moved from the web (the web imports it), the five redaction tests of §3.2 against a stub mapper | work-execution (domain), `apps/web/src/lib/usage-view.ts`; sync barrel | 2 | OT0 |
| OT1b | Pure `laneRunSpans` (§3.1 hierarchy from run, journal entries, attempts, receipts as facts; closed spans only; ambiguous counting; conduct events) and `attemptTraceSpans`; one test per span kind and per row of §3.1; the canary tests re-run on the real mapper | work-execution (domain) | 2 | OT1a |
| OT2 | `RunTelemetryPort`, `TelemetryExportCursorPort` (file and memory stores), `NoopRunTelemetryAdapter`, `RecordingRunTelemetryAdapter`, `ExportRunTelemetryUseCase` with selection, sampling and the cursor; a test that a throwing port leaves the use case's result `dropped` and nothing else changed | work-execution (application, infra), **manifest** | 2 | OT1b, K1b's journal stores |
| OT3 | `OtlpHttpRunTelemetryAdapter`: the OTLP/JSON encoder with golden-payload tests, queue, batching, retry and drop rules of §3.5, `https`-unless-loopback, token-file read, error kinds; tests against a loopback fake receiver (429 with `Retry-After`, 503, 400, partial success, timeout) | work-execution (infra), **manifest** | 2 | OT2 |
| OT4 | `policy.telemetry` in `installation`; composition in `apps/cli` (no-op unless configured) and the no-op in `apps/api`; `telemetry export` and `telemetry status` (§3.8); the runner-env test (§3.5); README operator row | installation, apps/cli, **`composition.ts`, `index.ts`**, `apps/api` runtime wiring | 2 | OT3; after K7 or before it, one at a time on `composition.ts` |
| OT5 | Native emission: the driver exports after each journalled `advance` and the root at a terminal state, flushes on exit; a test that a failing or slow telemetry adapter changes no decision, journal entry or timing beyond the 2 s exit flush | apps/cli (driver), **`composition.ts`** | 1 | OT4, K7 |
| OT6 | Per-call LLM spans: a read-only probe of opencode's message columns (numbers, model and time fields only), then `readUsageSteps` on `UsagePort`, one LLM span per assistant message | work-execution (port, `OpencodeDbUsageAdapter`), **manifest** | 2 | OT4, D8 |

OT1a and OT1b are pure domain and can start now, beside the conductor's K4 to K6 in other files of the same package if the briefs keep the files disjoint. OT2 waits for K1b's journal stores, since the use case reads the journal through them; until they land, OT2 can export hand-run attempts only and say so. Nothing here changes the conductor's order. The work board's WB12 lane detail reads the same facts; OT1a's move of the billing rule serves both.

## 5. Hard to undo

- **What reaches Phoenix.** Spans sent cannot be recalled from anyone who read or exported them; a Phoenix project can be deleted, which removes them from Phoenix only. §3.2 is the guard, and D11's dry-run review precedes the first send. One-way door, the owner's.
- **Span ids and attribute names.** Phoenix keeps the first write of a span id. A wrong mapping already sent stays until the project is deleted; a corrected mapping needs `v2` ids and a new project (§3.4). Version both from the first commit.
- **The trace's project.** Phoenix fixes a trace's project at its first span; renaming `projectName` later leaves old traces where they are.
- **This plan is public** and lists what fleet-v2 sends. That is intended: it is the contract a reader of a shared Phoenix can check.
- Everything else is a two-way door: the adapter is off by default and removable, and no record format changes except the new cursor store (versioned).

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Trace granularity | **One trace per conducted run; one per attempt for hand-run work**; every span carries `session.id = <workOrderId>` |
| D2 | When the run's root span is sent | **When the run is terminal.** Children appear as their steps close; a run in flight has no root yet. Alternative: an instant anchor root at start (runs listed at once, but the root shows no duration or outcome; the outcome moves to a final DECISION span) |
| D3 | Send cost? | **Yes, metered seats only, as `llm.cost.total`.** Plan-billed figures only as `fleet.cost.estimate_usd`, never as `llm.cost.*` |
| D4 | Project ids in spans | **No raw ids.** An alias the owner lists in `policy.telemetry.projectAliases`, else a salted 12-hex digest |
| D5 | Wire format and route | **OTLP/HTTP JSON to the cluster's collector**, built in-house, no new dependency. Alternative: protobuf straight to Phoenix through an OTel exporter package (a new dependency, Phoenix's key on the host) |
| D6 | Which Phoenix | **The staging cluster's Phoenix only.** Lane telemetry is operator data, not product data; no production Phoenix in v1 |
| D7 | Retention in Phoenix | **90 days** for the lanes project, where the deployed Phoenix supports a per-project retention (unverified); otherwise manual deletion |
| D8 | Per-call LLM spans (OT6) | **Later**: after a read-only probe confirms the message columns hold only numbers, model and time, and after ten exported runs show the attempt-level span is not enough |
| D9 | opencode's own OpenTelemetry | **Off.** It records prompts by default and its config offers no exporter settings |
| D10 | Dry-run and shadow runs | **Exported, tagged `dry-run` or `shadow`**, in the same project |
| D11 | First live send | **After the owner reads `telemetry export --dry-run` for five recorded runs** |
| D12 | Sampling | **All traces** (ratio 1.0); the setting exists for later |
| D13 | Route from the host | **The collector behind a LAN-only route with its own bearer and an attribute filter** (route 1 of §3.9); a loopback forward for one-off backfills |

## 7. Assumptions

- The deployed Phoenix behaves as its `main` does today: duplicate span ids are ignored, a trace keeps its first project, and `openinference.project.name` selects the project. If an older version updates or duplicates spans, re-exports may double-count; OT3's acceptance checks one resend against the deployed instance.
- The cluster's collector accepts OTLP/HTTP JSON and forwards protobuf to Phoenix with its own bearer, as it does for the in-cluster apps. If it cannot take JSON, D5's alternative applies.
- Phoenix lists a trace whose root has not arrived yet in its span views; if it hides such traces entirely, in-flight runs are invisible until their end, which D2's alternative fixes.
- Record timestamps are on one clock per installation (conductor §7); a skewed clock makes spans look out of order but never wrong in content.
- K1b's journal stores, K3's run store and K7's driver land as planned; until they do, only hand-run attempts are exported.
- Model ids, reason codes, park reasons and enum values carry no client content. A model id or enum that ever did would need its validator tightened before it ships.
- The billing rule by runner kind (opencode metered, agy plan) stays true; a new runner kind reads `unknown` until it is classified.

## 8. Review

Not yet reviewed. The research in §2.1 was read from the sources cited on 2026-10-27; opencode's export behaviour beyond its schema, Phoenix's cost pricing and its handling of root-less traces are marked unverified where they are used.

## Challenge this

Whether Phoenix is the right home. Most of a lane run's spans are not model calls: they are forge actions, gates, waits and parks, and v1 has one LLM span per attempt. Phoenix's strengths (prompts, evaluations, per-call views) are exactly what §3.2 withholds. A general trace store or the work board's lane detail (WB12) might show the same facts with less machinery. The case for Phoenix is the owner's existing instance, its session view by work order, and its token and cost roll-ups across seats; a reviewer should test whether those survive a payload with no content in it.

Whether the root should wait for the end (D2). Phoenix's first-write-wins rule makes a correct root impossible to send early, but a run that parks for two days is then absent from the trace list for two days. Test the anchor-root alternative against how the owner will actually use Phoenix: comparing finished runs (root at end is right) or watching runs in flight (the web's live tail is meant for that).

Whether the hand-built OTLP/JSON encoder is cheaper than a dependency. It avoids the SDK's resource detectors and a protected-manifest change, but it is code fleet-v2 must keep correct against the OTLP spec; the golden-payload tests are only as good as the payloads the collector actually accepts.
