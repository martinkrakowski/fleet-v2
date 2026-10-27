# Plan: lane runs as traces in Phoenix

- **Date:** 2026-10-27
- **Target repository:** `fleet-v2`
- **Status:** rev 3.1, after a Grok review (rev 2), a Fable review (rev 3) and a Grok re-check (rev 3.1); §8. Decisions in §6 are open with recommended defaults. Nothing built. Anchors checked against `origin/main` at `db47edd` (K1b-3, PR #281, merged).
- **Owner request (2026-10-27):** "Yes write a plan to send lane runs to Phoenix as traces."
- **Builds on:** `2026-10-27_conductor-plan.md` (`LaneRun`, the keyed run journal K1b, the decider, §3.2 states, §3.5 crash and resume, §3.9 reaper, D2 driver placement), `2026-10-23_attempt-record-gate-predicates-usage-plan.md` (S1 seat selection, S3 usage), `2026-10-27_work-board-plan.md` (§3.12 telemetry, WB12), `2026-10-27_web-ui-interactivity-plan.md` (§3.7 live tail, F13 content policy, P10 usage chips).

## 1. Goal

Every lane run that fleet-v2 records shows up in Phoenix (Arize Phoenix, an LLM-observability app) as an OpenTelemetry trace: which steps ran, on which seat and model, for how long, with how many tokens and what metered cost, and how each step ended. The trace is derived from records fleet-v2 already keeps, so a lane that ran last week can be exported the same way as one running now, and exporting twice changes nothing.

Telemetry is a **copy of facts for reading**, never a source of truth and never on a lane's critical path. It is off unless configured. A span that is not sent stays pending and goes with the next export; nothing about telemetry blocks, fails, slows or changes a lane.

**Non-goals.** No prompts, briefs, diffs, code, review text or lane output in any span (§3.2). No operator-chosen id (work order, attempt, receipt) in any span: those are sent only as salted digests (§3.2, D14). No new runner, seat or model. No instrumentation inside lanes, and no telemetry setting reaches a lane's environment. No metrics or logs pipeline (traces only). No Phoenix evaluations, datasets or prompt management. No live view: the web's live tail (web plan §3.7) is the live view; Phoenix is for after-the-fact reading, cost and seat comparison. No link from the web to Phoenix in v1 (a Phoenix URL is host configuration).

## 2. What exists (checked on `origin/main`, 2026-10-27)

| Fact | What exists | Anchor | Gap for telemetry |
|---|---|---|---|
| OpenTelemetry | Nothing: no OTLP, OTel or Phoenix code or dependency in any package | `packages/*/package.json` (only `@fleet/*` workspace dependencies) | Everything |
| Ids | Work order and attempt ids are **operator-chosen free text**: registration checks only that they are non-empty, the CLI passes strings through, docs use forms like `wo-0142`, tests `attempt-a`. Run ids and run journal `entryId`s are ULIDs minted by fleet-v2 | `RegisterWorkOrderUseCase`; `lane-run-journal.ts` (`entryId`) | Operator ids may carry branch, client or project words: never sent raw (§3.2, D14) |
| Attempts | `AttemptRecord`: kind, `fixNumber`, `priorAttemptId`, state, outcome, runner, `seatSelection`, `stopReason`, `usage`, `createdAtIso`, `updatedAtIso`, `completionReceipt` (`endedAtIso`) | `packages/work-execution/src/domain/execution-records.ts:15-25`, `:174-221` | Also carries `worktreePath`, `briefPackagePath`, runner `host`, `sessionId`: never exported (§3.2) |
| Usage | `AttemptUsageRecord`: steps, wall seconds, five token counts, `costUsd`, model, agent, `source` (`opencode-db` \| `unavailable`) | `execution-records.ts:141-156`; `UsagePort.out-port.ts:15-28`; filled at collect (S3) | Session totals only; agy attempts read `unavailable` |
| Usage read | One reviewed node script reads numeric columns of opencode's `session` table and counts assistant messages; never message text | `OpencodeDbUsageAdapter.adapter.ts:62-110` | No per-step (per model call) numbers (§3.7, D8) |
| Attempt journal | `ActionJournalEntryRecord`: `dispatch, reconcile, stop, collect, forge, accept`, status, `recordedAtIso`, `detail` (free text) | `execution-records.ts:259-276` | `detail` is free text: never exported or read for timing |
| Run journal (K1b) | `LaneRunJournalEntryRecord`: `entryId` (ULID), `intent` / `result` / `conduct`, key, `recordedAtIso`, typed `outcome`, `reasonCode` (`^[a-z][a-z0-9-]{0,63}$`), `state`, `mintedId` | `packages/work-execution/src/domain/lane-run-journal.ts:19-62`; store `LaneRunJournalPort` (K1b-3) | Domain and file and memory stores merged |
| Run keys | `<runId>/r<round>/<step>/<seatIndex>[/a<n>][@<head12>][/retry<n>]`, stop, resume, request and reaper keys; one parser | `lane-run-keys.ts:57-82`, `:353`; steps at `lane-run-records.ts:32-36` | The journalled key is the natural span identity (§3.4); keys embed ids, so they are hash input only |
| Park | `LANE_RUN_PARK_REASONS`; `LANE_RUN_PARK_QUALIFIER[reason]` selects `none`, `step` (a `LANE_RUN_KEY_STEPS` value) or `stop-refusal` (a `RUN_STOP_REFUSAL_KINDS` value) | `lane-run-records.ts:58-90` | The qualifier validator follows that table (§3.2) |
| Lane run | `LaneRunRecord`: run id, work order, tier, round, attempt ids, PR number, park | `lane-run-records.ts:115-136`; store `LaneRunRepositoryPort.out-port.ts:29` (K3-2) | Driver (K7, after K4) not built |
| Acceptance read | `AcceptanceEvidencePort.readAcceptance` returns only `{ state, candidateHeadSha, policyRevision, acceptanceReceiptId }` | `packages/work-execution/src/application/ports/out/AcceptanceEvidencePort.out-port.ts` | No receipts: telemetry needs its own consumer-side read port (§3.3) |
| Receipts | Evidence's `InspectAcceptanceEvidencePort` returns the `EvidenceAssessmentRecord` (by assessment id or candidate head), which holds `verificationReceipts`, `reviewReceipts` and the assessment's `attemptId` | `packages/evidence-and-acceptance/src/application/ports/in/InspectAcceptanceEvidencePort.in-port.ts`; `evidence-records.ts:79-111` | The new port's adapter delegates to it |
| Reviews | `ReviewReceiptRecord`: id, reviewer and implementer model, result, findings (severity, **summary, filePath**), head, `completedAtIso` | `evidence-records.ts:30-60` | Only severity counts are exportable; review `kind` arrives with RW1 |
| Gate | `VerificationReceiptRecord`: id, result, exit code, coverage, **hostId, procedureName, evidenceRef** | `evidence-records.ts:13-28` | Only result, exit code and timing are exportable |
| Billing | The web labels opencode figures as recorded and agy figures as plan-billed estimates | `apps/web/src/lib/usage-view.ts:12-21`, `:86-91` | The rule lives in the web only. `apps/web` has manifest `depends_on: []` and depends only on `@fleet/ui`, so it cannot import `work-execution`; the rule moves to `@fleet/shared` (§3.6) |
| File stores | An unreadable state file is **quarantined** on read (a copy is written beside it) | `packages/work-execution/src/infrastructure/adapters/file-store.ts:454` (`quarantineUnreadable`) | Telemetry's reads need a read-only mode that copies nothing (§3.3) |
| Observation | `ExecutionObservationPort`: publish recorded observations, a delivery gap never fails the lane | `ExecutionObservationPort.out-port.ts:1-24`; wired at `apps/cli/src/composition.ts:1480` | The right failure contract; the wrong payload (journal entries with free text) and the wrong supplier (Waves) |
| Secret shapes | Shared registry and `containsSecretShape` | `packages/shared/src/secret-patterns.ts:51`, `:72` | Reused in the redaction tests and in the project, model and version validators |
| Token files | The API reads its bearer from `FLEET_API_TOKEN_FILE` | `apps/api/server/plugins/runtime.ts:2-20` | The same pattern serves the telemetry bearer |
| Runner env | `RUNNER_ENV_ALLOWLIST` builds a lane's environment | `ExecutionRunnerAdapter.adapter.ts:204-229` | Telemetry variables must never join it (§3.5) |

Lane activity today also lives in places this plan does not read: opencode's own database beyond the S3 columns, the orchestrator's hand-kept seat telemetry (private notes, never parsed), and lanes run with the runner script outside fleet-v2's records (they have no attempt record, so there is nothing to export).

### 2.1 What Phoenix and OpenInference expect (researched 2026-10-27)

- **Span kinds.** OpenInference puts the kind in `openinference.span.kind`; values are `LLM`, `EMBEDDING`, `CHAIN`, `RETRIEVER`, `RERANKER`, `TOOL`, `AGENT`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`, `DECISION` [1].
- **LLM attributes.** `llm.model_name`, `llm.provider`, `llm.system`, `llm.invocation_parameters` (a JSON string); tokens `llm.token_count.prompt`, `.completion`, `.total`, `llm.token_count.prompt_details.cache_read`, `.cache_write`, `llm.token_count.completion_details.reasoning`; cost in USD `llm.cost.prompt`, `llm.cost.completion`, `llm.cost.total` and detail keys [1].
- **Grouping.** `session.id` groups traces into a Phoenix session; `agent.name`, `tag.tags`, `metadata`, `user.id`; content in `input.value` / `output.value` [1].
- **Project.** The resource attribute `openinference.project.name` [2]; Phoenix's `/v1/traces` takes an `x-project-name` header first, then that attribute [3]. fleet-v2 never sends the header and relies on the attribute; the collector drops the header (§3.9).
- **Transport.** Phoenix's HTTP receiver at `/v1/traces` accepts `Content-Type: application/x-protobuf` only (415 otherwise), with optional `gzip` or `deflate` [3]; it also serves OTLP/gRPC [4].
- **Auth.** Bearer: `Authorization: Bearer <system API key>`, header name lowercased for gRPC [5].
- **Idempotency.** Phoenix inserts spans with `unique_by=("span_id",)` and `OnConflict.DO_NOTHING`: a duplicate span id is ignored, the **first write wins**, and a trace keeps the project of its first span [6].
- **OTLP itself.** OTLP/HTTP also defines a JSON encoding (`Content-Type: application/json`, trace and span ids as hex strings); retry on 429, 502, 503, 504, honour `Retry-After`; never retry a partial success [7]. A partial success carries a **count** of rejected spans (`rejectedSpans`) and a message, not which spans were rejected; a partial-success object with a count of 0 is a full success [7]. A collector's OTLP receiver accepts both encodings; Phoenix's does not take JSON.

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
│  ├─ brief-check, code-review    EVALUATOR  reviewer seat label, verdict, finding counts by severity
│  └─ pre-merge                   EVALUATOR
├─ accept                         DECISION   accepted / rejected at head12
├─ open-pr, push, merge           TOOL       forge actions; PR number, head12
├─ ci-wait                        CHAIN      watching-ci conduct entry → next conduct entry; CI result
├─ park                           DECISION   park step key → its exit; reason, qualifier
└─ stop-request                   DECISION   instant; mode graceful | force
```

Steps that belong to no round (accept, forge actions, CI, parks, stops) hang under the root; steps keyed with a round hang under that round's span. The root carries `conduct` entries as span events (`state.entered`, with the state name only), so the state sequence is visible without a span per state.

**One span per key.** A keyed step's span runs from its intent's `recordedAtIso` to its **final** result's. `ambiguous` results are not final: they are counted on the span (`fleet.ambiguous_results`), and the span is emitted only once a final result exists. A retry key (`…/retry1`) is its own span. Reaper keys and request-channel keys are not part of a run trace in v1.

**A span is emitted only when it is closed.** Phoenix keeps the first write of a span id (§2.1), so a span sent with a guessed end time could never be corrected. Children are emitted as their steps close; the round span when the next round starts or the run ends; the root when the run is `merged` or `stopped` (D2).

**Hand-run attempts** (dispatched with `attempt dispatch`, no `LaneRun`) are one trace per attempt, rooted at the attempt (§3.4): the `attempt` AGENT span is the root, its usage LLM child, and the gate and review receipts recorded for the attempt's collected head as children, each identified by its receipt id (hash input only). The root runs from `AttemptRecord.createdAtIso` to `completionReceipt.endedAtIso`, falling back to `updatedAtIso` when there is no completion receipt, and is emitted only once the attempt is in a terminal state; the attempt journal's `detail` is never read for timing. A receipt that arrives after the root was sent attaches to the existing trace by its deterministic parent id. An attempt that belongs to a run (its id is in a `LaneRunRecord`'s attempt ids, or equals a run journal intent's `mintedId`) is part of that run's trace and never exported as a hand-run trace; `mintedId` is compared for this and never exported. Every span of a work order, conducted or hand-run, carries `session.id` = the work order's salted digest (§3.2), so Phoenix's session view shows a work order's attempts, fix rounds and runs together (D1, D14).

**Model calls inside an attempt.** v1 knows only session totals, so an attempt has one `usage` LLM span covering the attempt. One LLM span per model call needs a per-message read of opencode's numeric columns; that is OT6, behind D8. When OT6 emits per-call spans for an attempt, they **replace** the aggregate's token and cost attributes: the aggregate `usage` span becomes a CHAIN span carrying only `fleet.usage.steps` and `fleet.usage.wall_seconds`, with no `llm.token_count.*`, `llm.cost.*` or `llm.model_name`, so Phoenix's roll-ups count each token once. Because a span already sent cannot change, the choice is made per attempt from the disposition store (§3.3): an attempt whose aggregate `usage` span is already exported keeps it and gets no per-call spans; any other attempt gets per-call spans and the stripped aggregate. A test asserts no trace holds token counts on both an aggregate and its per-call children.

**Trace context propagation.** Nothing to propagate in v1. The runner script, opencode, agy, the grok CLI and the forge accept no trace context from fleet-v2 that this plan relies on, and a lane must not receive telemetry settings (§3.5). Ids are **derived, not propagated**: any component that holds the installation's telemetry salt and knows a run id, attempt id or journalled key can compute the trace and span id, so the API, the web or a later in-lane exporter can join the same trace without a header.

### 3.2 What is never sent (hard rule)

**Allowed, and nothing else.** Every attribute key is on one allow-list (`RUN_TELEMETRY_ATTRIBUTES`, domain), each with a validator. A value that fails its validator drops the attribute, never the span.

**Ids.** Only ids fleet-v2 mints as ULIDs go out as they are: the run id and run journal `entryId`s. Every operator-chosen id (work order, attempt, prior attempt, receipt, project) is sent only as a **salted digest**: the first 16 hex characters (64 bits) of `HMAC-SHA256(salt, "<kind>:" + id)`, where `salt` is `policy.telemetry.salt` and `<kind>` is `work-order`, `attempt` or `project`. Every digest that serves as a key has this one length. At 64 bits the chance of any collision among a million ids of one kind is about 3 in 100 million. The raw ids are hash input only, here and in §3.4 (D4, D14).

**One salt per installation.** The salt is at least 32 random bytes, kept in the telemetry section of the ignored installation file and never sent. It is an installation-wide value: the same salt is copied unchanged to every exporting host (the orchestrator's machine and every lane host), because ids computed with different salts would split one run into unrelated traces. Its **fingerprint**, the first 8 hex of `HMAC-SHA256(salt, "fleet-telemetry/v1/fingerprint")`, is printed by `telemetry status` on every host, so a mismatch is visible, and is recorded in the disposition store on its first write. An export whose current fingerprint differs from the store's recorded one is refused with error kind `salt-mismatch` and sends nothing.

| Kind of value | Keys | Validator |
|---|---|---|
| Minted ids | `fleet.run.id` | ULID pattern |
| Digests | `fleet.work_order.digest`, `session.id` (= the work order digest), `fleet.attempt.digest`, `fleet.prior_attempt.digest` | Exactly 16 lowercase hex, built only by the domain's digest function |
| Project | `fleet.project` | Either an alias from `policy.telemetry.projectAliases` matching `^[a-z][a-z0-9-]{0,31}$`, or the 16-hex project digest; in both cases `containsSecretShape` is false. Sourced only from installation policy, never from a record, environment variable or repository name |
| Steps and states | `fleet.step`, `fleet.state`, `fleet.round`, `fleet.seat.index`, `fleet.seat.role`, `fleet.tier`, `fleet.attempt.kind`, `fleet.fix_number` | The domain's enum lists (`LANE_RUN_KEY_STEPS`, `LANE_RUN_STATES`, `SeatPlanRole`) and bounded integers |
| Outcomes | `fleet.outcome`, `fleet.reason_code`, `fleet.stop_reason`, `fleet.park.reason`, `fleet.gate.result`, `fleet.review.kind`, `fleet.review.result`, `fleet.ci.result`, `fleet.stop.mode` | Enum lists; `reasonCode` by `LANE_RUN_JOURNAL_REASON_CODE_PATTERN` |
| Park qualifier | `fleet.park.qualifier` | Chosen by `LANE_RUN_PARK_QUALIFIER[reason]`: `step` → a `LANE_RUN_KEY_STEPS` value; `stop-refusal` → a `RUN_STOP_REFUSAL_KINDS` value; `none` → the attribute is absent |
| Counts | `fleet.review.findings.blocker`, `.major`, `.minor`, `.nit`, `fleet.gate.exit_code`, `fleet.ambiguous_results`, `fleet.usage.steps` | Finite integers ≥ 0 (exit code: −1..255) |
| Seats | `fleet.seat.model`, `fleet.seat.provider`, `agent.name`, `fleet.seat.tool` (`opencode` \| `agy` \| `review-cli`), `fleet.seat.billing` (`metered` \| `plan` \| `unknown`), `llm.invocation_parameters` (`{"variant":…}` only) | Model id pattern `^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,127}$` and `containsSecretShape` false; enums; the variant matches `^[a-z0-9][a-z0-9-]{0,31}$` with `containsSecretShape` false, otherwise `llm.invocation_parameters` is dropped |
| Metered model | `llm.model_name`, `llm.provider`: **only on a `usage` (or OT6 per-call) LLM span whose billing is `metered`** (§3.6) | Model id pattern; the span-kind and billing rule is part of the validator |
| Usage | `llm.token_count.*` (the six keys of §2.1), `fleet.usage.source`, `fleet.usage.wall_seconds` | Finite numbers ≥ 0 |
| Cost | `llm.cost.total` (metered seats only), `fleet.cost.estimate_usd` and `fleet.cost.basis` (`metered` \| `plan-estimate` \| `unknown`) | Finite ≥ 0; §3.6 |
| Forge | `fleet.pr.number`, `fleet.head12` | Positive integer; 12 lowercase hex |
| Schema | `fleet.telemetry.schema` (`1`), `tag.tags` (fixed tokens: `conducted`, `hand-run`, `dry-run`, `shadow`, `tier-1`, `tier-2`) | Constant; enum list |

Resource attributes: `service.name = fleet-v2`, `service.version`, `openinference.project.name`. `service.version` is a build-time constant (the CLI package's version baked in at build), never read from git, the environment or a file at run time; its validator is `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.-]{1,32})?$`, at most 64 characters, `containsSecretShape` false. `openinference.project.name` comes from `policy.telemetry.projectName` and uses the alias validator above. Nothing else: no host, process, OS or SDK resource detectors run.

**Never sent, by construction.** Raw work order, attempt, receipt and project ids; journal keys (they embed those ids); `mintedId`; prompts, briefs and brief paths, handover text, diffs, code, file paths, review finding summaries and file paths, review or gate output, `detail` and any other free text, PR titles or bodies, branch names, repository names, worktree paths, host names and host ids, ports, URLs, session ids of the runner, message ids, procedure names, evidence refs, owner question text, the salt, secrets and anything secret-shaped, client content, user ids. In OpenInference terms: `input.value`, `output.value`, `llm.input_messages`, `llm.output_messages`, `llm.prompts`, `llm.prompt_template.*`, `tool.*`, `message.*`, `metadata`, `user.id`, `exception.*`, `http.*`, `url.*`, `server.*`, `host.*`, `process.*` never appear. Span status messages carry a reason code or nothing. Span names are fixed strings from §3.1. The identity strings of §3.4 go into a hash only and never onto the wire.

**How it is enforced.** The pure mapper takes typed facts (§3.3), not records, and the facts type has no string field that is not a minted id, a digest, an enum or a validated model id; raw operator ids enter the facts only inside a `HashInput` value the encoder cannot serialise. `TelemetrySpan` is a **nominal type**: a class with a private `#brand` field and a private constructor, built only by the domain's `TelemetrySpan.build(...)`, which applies the allow-list and validators and freezes a copy of the attributes. The encoder checks `#brand in span` for every span and refuses anything else (the span is not encoded and is recorded as `rejected` with reason class `invalid`), so an object built structurally or cast to the type cannot reach the wire. A text field cannot reach the wire without changing the facts type, the allow-list and the tests below at once.

**Redaction tests (OT1r; each its own test).** The checks are one pure function, `redactionChecks(payloadBytes, canaryValues)`, so the CLI can run them on real records (§3.8, `--canary`).
1. **Canaries.** Fixture attempts, journals, receipts and runs with every string field set to `CANARY-<field>` (worktree path, brief path, host, host id, `detail`, finding summary and path, disposition reason, procedure name, evidence ref, branch, receipt id), plus a project alias, a project name and a build version set to `CANARY-…` or a secret-shaped string; map, encode the OTLP payload, and assert no `CANARY` in the bytes and that the invalid project and version attributes were dropped.
2. **Operator ids.** A work order id shaped like a branch or a client name (`feat/acme-billing-CANARY`, `CANARY Client Ltd`) and an attempt id built from it never appear in any payload, raw or as a substring; their digests do.
3. **Key allow-list.** Every attribute key in every encoded span and resource is in `RUN_TELEMETRY_ATTRIBUTES`; every key on the never list above is absent.
4. **Values.** Every string value matches its key's validator; numbers are finite.
5. **Secret shapes.** `containsSecretShape` is false on the encoded payload of fixtures seeded with secret-shaped strings in every free-text field.
6. **Adapter errors.** A failed send's outcome names an error kind (`timeout`, `network`, `auth`, `http-4xx`, `http-5xx`, `partial`) and never the endpoint, a header or a response body.
7. **Brand.** An object literal with every `TelemetrySpan` field, cast with `as unknown as TelemetrySpan`, is refused by the encoder and appears nowhere in the payload.

### 3.3 Place in the hexagon

The facts belong to `work-execution` (attempts, usage, the run journal, runs) and to `evidence-and-acceptance` (receipts). Telemetry is a **consumer-side out-port in `work-execution`**, not a fifth context and not a port in each supplier context; the manifest's dependency direction is unchanged (`work-execution → evidence-and-acceptance` already exists).

- **Domain (`run-telemetry.ts`):** `TelemetrySpan` (trace id, span id, parent id, name, kind, start and end, status, attributes, events; nominal, §3.2), `RUN_TELEMETRY_ATTRIBUTES` with validators, the digest function, the id derivation (§3.4), the span disposition values, `pricingSafe` (§3.6), and pure `laneRunSpans(runFacts)` and `attemptTraceSpans(attemptFacts)` returning closed spans only. Never throws, never reads a clock. The billing rule lives in `@fleet/shared` (§3.6) and the domain imports it.
- **Application:**
  - `RunTelemetryMarkPort` (out): `mark(runId | attemptId): void`. The only thing the driver calls. Constant time (adds an id to an in-memory set and wakes the background exporter), never throws (the adapter catches everything), never awaits, reads nothing.
  - `TelemetryDispositionPort` (out; file and memory stores in the state directory, versioned): per trace, a **set of span dispositions**, keyed by span id: `pending`, `exported@<route>` (`collector` or `phoenix`, from `policy.telemetry.route`), or `rejected` with a reason class (`invalid`, `too-large`, `partial-rejected`, `http-4xx`; never a value or a response body). Parallel seats, gaps and late receipts are just more entries in the set; there is no per-trace "last span" cursor. It also keeps the salt fingerprint (§3.2) and the counters `telemetry status` prints.
    - **Single writer.** Every write holds an exclusive lock file (`withFileLock`, the helper the file repositories use for writes) for its whole read-modify-write, so the driver's background exporter and a `telemetry export` never write at the same time. A write is a merge per span id into the current file read under the lock, never a whole-file replace from an earlier read. A lock that cannot be taken within 500 ms skips that write: the spans it would have finalised stay `pending` and go with the next export, and the driver's 2 s stop bound still holds. A test interleaves two writers and asserts no span is marked exported without its own HTTP result and no disposition is lost.
  - `AcceptanceReceiptReadPort` (out): `readReceiptsForHead(attemptId, headSha) → { verification: [...], review: [...] }`, each entry projected to its receipt id (hash input only), result, exit code (verification), finding counts by severity and review kind (review), and `completedAtIso`. Nothing else crosses the port: no host id, procedure name, evidence ref, finding summary or path. `AcceptanceEvidencePort` is not widened, since it serves forge decisions and returns no receipts.
  - `RunTelemetryPort` (out): `send(spans, deadline) → Promise<SpanDisposition[]>`, one disposition per span it was given, plus an error kind; it never rejects and never throws.
  - `ExportRunTelemetryUseCase`: for a selection (one marked run or attempt, a run, a work order, or a `--since` window) it reads facts through the attempt repository, `LaneRunJournalPort`, K3's run store and `AcceptanceReceiptReadPort`, maps, applies sampling, drops spans whose disposition is already `exported@…` or `rejected`, records the rest as `pending` **before** sending, calls `send`, and records each returned disposition. A disposition moves to `exported@…` or `rejected` only on an HTTP result for that span, never on enqueue. A process killed at any point leaves `pending` entries (or none, for spans never selected); the next export maps the same records again and resends them, which is safe because ids are deterministic and Phoenix is first-write-wins.
- **Infrastructure:** `NoopRunTelemetryAdapter` and a no-op mark adapter (the default: no endpoint configured), `RecordingRunTelemetryAdapter` (tests, dry-run), `OtlpHttpRunTelemetryAdapter` (§3.5), the disposition file store, and `AcceptanceReceiptReadAdapter`, which delegates to evidence's `InspectAcceptanceEvidencePort` by `candidateHeadSha`, keeps only the assessment whose `attemptId` matches, and projects its `verificationReceipts` and `reviewReceipts`. The inspect port it is given is **telemetry's own instance**: the telemetry composition builds a separate `InspectAcceptanceEvidenceUseCase` over `readOnly` evidence repositories, with no forge reader and nothing that can quarantine or write. It never shares the instance the CLI's other commands use.
- **Read-only stores.** The file stores quarantine an unreadable file on read by writing a copy (`quarantineUnreadable`). The repositories handed to telemetry, including those under its own evidence read path, are built with a `readOnly` option that makes an unreadable file a read error, with no copy and no other write, in both `work-execution` and `evidence-and-acceptance`. Telemetry writes only its own disposition store.
- **Composition (both roots).** `apps/cli` builds the OTLP adapter when `policy.telemetry.enabled`, a salt, an endpoint and a token file are configured, else the no-ops, and wires `AcceptanceReceiptReadAdapter` to telemetry's own read-only inspect use case (above). `apps/api` wires the same receipt-read adapter and the no-op telemetry adapters in v1, since the API drives no run (conductor D2: the driver is a CLI process on the orchestrator's machine).

**Off the critical path.** The driver's only telemetry call is `mark`. Reads, mapping, disposition writes and sends run in the background exporter (driver process) or in the `telemetry export` command, never inside `advance`. The background exporter uses its own read-only repository instances and takes no lease or lock the driver takes. A failed or slow read leaves the run marked for its next pass; it writes nothing outside the disposition store and changes no record the driver reads. The records stay the source, so a lost mark costs only delay until the next `telemetry export`.

**Exporter lifetime in the CLI.** The CLI exits by draining the event loop (it sets `process.exitCode`; it never calls `process.exit` and installs no signal handlers), so a stray timer or rejection could otherwise hold or change the exit. The mechanism:
- The driver command owns the exporter: it calls `exporter.start()` after composition, and in a `finally` it awaits `Promise.race([exporter.stop(), a 2 s timer])` before returning its exit code. `stop()` stops draining marks, aborts in-flight requests, and resolves; spans without a result stay `pending`.
- Every timer the exporter or adapter creates (flush interval, retry backoff, the 2 s race timer) is `unref()`'d, so none keeps the process alive.
- Every request runs under `AbortSignal.timeout(5000)`, combined with the stop signal.
- The loop is started as `void loop().catch(countErrorKind)`, and each iteration's body is wrapped in its own `try`/`catch` that records only an error kind. No rejection from telemetry is unhandled, and none can change `process.exitCode`.

`ExecutionObservationPort` is not reused: its payload is the attempt journal entry, which carries free text, and its supplier is the Waves publication. Its failure contract (a delivery gap never fails the lane) is copied.

### 3.4 Deterministic ids

Every span's identity comes from a durable key written once in a record, **never from an ordinal counted at export time**, so a live export and a backfill of a longer or shorter slice of the same journal give the same ids. Identities can contain operator ids, so every hash below is keyed with the installation salt.

- **Trace root.** A conducted run: `run/<runId>`. A hand-run attempt (no run id): `attempt/<attemptId>`.
- **Trace id** (16 bytes) = the first 16 bytes of `HMAC-SHA256(salt, "fleet-telemetry/v1/trace/" + traceRoot)`.
- **Span id** (8 bytes) = the first 8 bytes of `HMAC-SHA256(salt, "fleet-telemetry/v1/span/" + traceRoot + "/" + identity)`, with the identity per span kind:

| Span | Identity | Durable source |
|---|---|---|
| Root of a run | `root` | the run id |
| Root of a hand-run trace | `attempt/<attemptId>` | the attempt record; start `createdAtIso`, end `completionReceipt.endedAtIso` (else `updatedAtIso`) |
| Round | `round/r<r>` | the round segment of the journalled keys |
| Keyed step: prepare, dispatch, collect, reconcile, stop, gate, brief-check, code-review, pre-merge, accept, open-pr, push, merge, park (retries included) | `key/<journalled key>` | the intent entry's `key`, as written |
| Stop request | `key/<journalled stop key>` | the stop intent's `key` |
| Attempt (both trace kinds) | `attempt/<attemptId>` | the attempt record |
| Usage aggregate | `usage/<attemptId>` | the attempt record |
| Per-call LLM (OT6) | `usage/<attemptId>/msg/<message id>` | opencode's message id (hashed only, never sent) |
| CI wait | `ci/<entryId>` | the `entryId` of the `watching-ci` conduct entry that opens it |
| Gate receipt (hand-run) | `verification/<receiptId>` | the verification receipt's `id` |
| Review receipt (hand-run) | `review/<receiptId>` | the review receipt's `id` |

- A span kind added later must name its durable source in this table before it ships; the mapper test fails on a span whose identity is not built by one of these functions.
- An all-zero id (invalid in OTLP) is replaced by flipping its last bit; a test covers the rule.
- Start and end times come from the record fields named above and in §3.1 (`recordedAtIso`, `completedAtIso`, `createdAtIso`, `endedAtIso`), never from the clock at export, so a backfill encodes the same span byte for byte as the live export. A test maps a journal prefix and then the full journal and asserts the shared spans have identical ids and bytes.
- `v1` is in every hash input. A change to the mapping that must replace spans already sent bumps it to `v2` and goes to a new Phoenix project (§5), because Phoenix never updates a span id it holds. Changing the salt changes every id and digest, with the same consequence; the fingerprint check of §3.2 stops an export with a different salt from mixing the two.

Sampling, when configured below 1.0, is decided on the trace id (the first 8 bytes as an integer against the ratio), so every span of a trace, live or backfilled, makes the same choice. A sampled-out trace is never selected and gets no disposition. Default 1.0: a run has a few dozen spans.

### 3.5 The OTLP adapter: batching, retry, dispositions

- **Wire format (D5).** OTLP/HTTP with the JSON encoding, built by a small encoder in the adapter over the fixed subset §3.2 allows (resource, one scope, spans with string, integer, double, boolean and string-array attributes, events, status). No new dependency, no SDK, and so no default resource detectors that would add host and process attributes. No `x-project-name` header is sent. The JSON goes to the cluster's OTLP collector, which forwards to Phoenix in protobuf. Sending straight to Phoenix needs protobuf (§2.1) and therefore an OTel exporter dependency: D5's alternative.
- **Queue.** In memory, bounded (2048 spans). When full, the **oldest** queued spans are dropped from memory and counted; they stay `pending` in the disposition store, so the next export resends them. Nothing is lost, only delayed. A batch is at most 512 spans or 1 MiB, flushed every 5 s or when full.
- **Send.** One request at a time per process; 5 s timeout per request. Retry 429, 502, 503 and 504 at most twice (1 s, then 4 s, or `Retry-After` capped at 30 s), and never past the caller's deadline.
- **Dispositions from a result.**
  - 2xx with no partial success, or with a partial success whose `rejectedSpans` is 0: every span in the batch is `exported@<route>`.
  - 2xx with `rejectedSpans > 0`, or a 400 or 413: OTLP does not say which spans failed (§2.1), so a batch of more than one span is **split** and resent one span per request within the deadline (a resend of an accepted span is harmless under first-write-wins). A single-span request that is accepted is `exported@<route>`; one that is rejected is `rejected` with its reason class (`partial-rejected`, `http-4xx`, `too-large`). A rejected span is not retried automatically; `telemetry export --retry-rejected` moves rejected spans back to `pending` (§3.8).
  - **Misconfiguration breaker.** A 4xx on single spans may mean a misconfigured receiver, not bad spans. After **three consecutive single-span 4xx with no 2xx between them**, the export stops with error kind `http-4xx`: those three spans go back to `pending`, and every span not yet sent stays `pending`.
  - 401, 403, 404, other 4xx, 5xx after retries, timeout, network error, deadline reached: nothing is attributable to the spans, so they stay `pending` and the error kind is recorded (`auth`, `http-4xx`, `http-5xx`, `timeout`, `network`).
  - A span refused by the encoder (failed brand check, §3.2, or `pricingSafe`, §3.6) is `rejected` with reason class `invalid` without being sent.
  - A salt fingerprint that differs from the disposition store's (§3.2) refuses the whole export before any send, with error kind `salt-mismatch`; every span stays as it was.
- **Two paths, two deadlines.**
  - **Live path (driver, OT5).** The background exporter sends with no deadline of its own beyond the request rules above. On exit the driver command waits at most 2 s for `exporter.stop()` (§3.3); a request in flight at that point is aborted and its spans stay `pending`. The live path never reports a span as sent that has no HTTP result, and never delays the driver's exit by more than those 2 s.
  - **Foreground export (`telemetry export`, OT4b).** Runs in the foreground with a bounded total deadline (`--deadline <seconds>`, default 120, at most 600) that covers every request, retry, `Retry-After` wait and split resend. It waits for results and records them. Exit codes in §3.8.
- **Never blocks the lane.** The adapter never throws to its caller and never logs (package code has no console output); its counters are written to the disposition store and `telemetry status` prints them at the CLI boundary.
- **Transport safety.** `https:` is required unless the endpoint is loopback. **Loopback** means: after parsing with the WHATWG `URL` parser, the URL has no user name or password, and its `hostname` is exactly `127.0.0.1` or `[::1]`. `localhost`, `localhost.`, other names, and any other address do not count, so they need `https:`. The bearer is read from a file (`FLEET_TELEMETRY_TOKEN_FILE`, like `FLEET_API_TOKEN_FILE`) when the adapter is built, never logged, and sent only to the configured endpoint. Neither `FLEET_TELEMETRY_*` variable may join `RUNNER_ENV_ALLOWLIST`; a test asserts that the runner environment never contains them. Tests cover `http://localhost/`, `http://localhost./`, `http://127.0.0.2/` and `http://user@127.0.0.1/` as refused.

### 3.6 Cost

Phoenix may price an LLM span from its own model table when it sees `llm.model_name` (unverified). So a model name reaches Phoenix's pricing keys only where the spend is real.

- **Metered seats** (runner kind `opencode`): the `usage` LLM span carries `llm.model_name`, `llm.provider` and `llm.cost.total` = the recorded `costUsd`; `fleet.cost.basis = metered`. A free seat records 0, which is sent as 0.
- **Plan-billed seats** (runner kind `agy`; reviews on plan CLIs) and **unknown** runner kinds or `costUsd: null`: no `llm.model_name`, no `llm.provider` and no `llm.cost.*` on any span; the model goes in `fleet.seat.model`. A figure, when one exists, goes in `fleet.cost.estimate_usd` with `fleet.cost.basis = plan-estimate` (or `unknown`). agy usage reads `unavailable` today, so v1 sends no estimate for agy.
- **AGENT and EVALUATOR spans** never carry `llm.model_name` or `llm.provider`, metered or not; they carry `fleet.seat.model`, `fleet.seat.provider` and `fleet.seat.billing`. Only the metered `usage` span (and OT6's metered per-call spans) can be priced.
- **One billing rule.** `billingOf(runnerKind)` moves from the web (`usage-view.ts:12-21`) into `@fleet/shared`, which has no Node imports in its source. `work-execution` already depends on `@fleet/shared`; `apps/web` gains a `@fleet/shared` workspace dependency beside `@fleet/ui`. `apps/web`'s manifest `depends_on: []` lists bounded contexts only and `@fleet/ui` already sits outside it, so web → shared should pass `yarn lint:arch`; OT1s proves it before anything else moves. If `hexagen arch validate` refuses it, the web keeps its copy and a test in `@fleet/shared` checks both copies against one fixture table.

**Pricing gate (OT3a, hard).** Before the first live export:
1. **Test.** A predicate `pricingSafe(span)` (no `llm.model_name`, `llm.provider` or `llm.cost.*` unless the span is an LLM span with billing `metered`) runs over every mapper fixture; the encoder refuses a batch containing a span that fails it.
2. **Dry-run check.** `telemetry export --dry-run` prints, beside the spans, the count of spans failing `pricingSafe`; it must be 0 for the five runs the owner reads under D11.
3. **Read-back.** One metered and one plan-billed fixture span go to a throwaway Phoenix project (O-3); the plan span must show no cost, and the metered span must show the sent `llm.cost.total`, not a table price. If Phoenix prefers its table, metered spans drop `llm.model_name` too and the cost stays in `llm.cost.total` only; the first real export waits for that change.

### 3.7 Who emits what

| Source | How it reaches Phoenix | Lane |
|---|---|---|
| Conducted runs | The driver (K7) calls `RunTelemetryMarkPort.mark(runId)` after each `advance` has journalled its result; the background exporter reads, maps and sends from the records; the root when the run is terminal | OT5 |
| Hand-run attempts (`attempt dispatch`) | `fleet-v2 telemetry export` after the fact, from attempt records, usage and receipts; an orchestrator runs it after a lane's merge, or on a schedule it owns | OT4b |
| Past runs and attempts, and anything left `pending` | The same command with `--since` (§3.8) | OT4b |
| Lanes run with the runner script outside fleet-v2 | Nothing: no record exists. Registering the work order and dispatching through fleet-v2 is the way in | — |
| Per-call model spans | OT6, behind D8 | OT6 |

**OT5's isolation test.** The driver runs a fixture run with telemetry off, then again with each of these faults in the telemetry path: repository reads that throw; reads that take ten seconds; a mark adapter that throws; a mapper that throws; a disposition store whose write rejects asynchronously; a disposition lock held by another writer; a corrupt evidence assessment file. Decisions, journal entries and the exit code are identical across all runs, the driver's exit is delayed by at most the 2 s stop race, and no unhandled rejection is reported. For the corrupt evidence file, the export records a read error and the state directory holds no new or changed file outside the disposition store (no quarantine copy).

**opencode's own OpenTelemetry (researched; partly verified).** opencode's published config schema has `experimental.openTelemetry`, marked deprecated, described as "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)", and no exporter, endpoint or header keys; the root rejects unknown keys (verified against the schema at `opencode.ai/config.json`, 2026-10-27). Whether the server registers an OTLP exporter from the standard `OTEL_EXPORTER_OTLP_*` variables is **unverified**. The AI SDK's telemetry records prompts and responses by default, which §3.2 forbids. **Recommendation (D9): do not enable it.** If it is ever wanted, it is a separate plan with a collector that drops every content attribute before Phoenix.

**agy and the grok CLI.** No OpenTelemetry export is known for either (unverified). Their facts reach Phoenix through fleet-v2's records only: agy attempts as AGENT spans without usage, grok and other review CLIs as EVALUATOR spans from receipts, all with `fleet.seat.model` and never `llm.model_name` (§3.6).

### 3.8 Backfill

`fleet-v2 telemetry export [--since <ISO date>] [--until <ISO date>] [--run <runId>] [--work-order <id>] [--deadline <seconds>] [--retry-rejected] [--dry-run [--canary]] [--json]`

- Selects conducted runs and hand-run attempts with any record time in the window, maps them, and sends every span whose disposition is not already `exported@…` or `rejected` (so `pending` spans left by the live path go here). Idempotent: the ids are deterministic and Phoenix ignores a resent span, so overlapping windows and repeated runs are harmless.
- It is a foreground command: it waits for HTTP results within `--deadline` (§3.5) and records each span's disposition.
- `--retry-rejected` first moves the selection's `rejected` spans back to `pending`, then exports as usual. It is safe for the same first-write-wins reason, and it is the repair after a misconfiguration that was fixed.
- `--dry-run` sends nothing, writes no disposition, and prints the spans as JSON exactly as they would be encoded (attributes included), with the `pricingSafe` failure count (§3.6). It is how the owner reviews what leaves the machine before the first live send (D11), and it works without any endpoint configured. Its exit code is `0` when every selected span passes encoding (brand and validators), `pricingSafe` and, with `--canary`, every redaction check; `1` when any span would be refused or any check fails; `2` on a usage error.
- `--dry-run --canary` also runs `redactionChecks` (§3.2) on the encoded payload of the real state directory's records, using every free-text value and raw operator id from those records as the canary list. It prints only pass or fail per check and the count of offending spans, never a matched value.
- `telemetry status` prints whether telemetry is configured (never the endpoint, token or salt), the salt fingerprint (§3.2) and the one recorded in the disposition store, the schema version (`fleet.telemetry.schema`) and id hash prefix (`fleet-telemetry/v1`), the route, the last export time, counts of spans by disposition (`pending`, `exported@<route>`, `rejected` by reason class), queue drops and error-kind counters.
- Exit codes per `AGENTS.md`: `0` every selected span ended `exported@…`, or nothing was selected; `1` telemetry is not configured (refused), the salt fingerprint does not match the store's (`salt-mismatch`), the misconfiguration breaker tripped, or any selected span ended `pending` or `rejected` (the counts are printed); `2` usage error. Spans rejected by an earlier export are not selected again unless `--retry-rejected` is given; they are listed in the counts.

### 3.9 Configuration and the route to Phoenix

**Installation policy** (`policy.telemetry`, in the installation file, which lives in an ignored path): `enabled` (absent = off), `projectName` (default `fleet-lanes`; alias validator of §3.2), `route` (`collector` \| `phoenix`, default `collector`; recorded in each `exported@<route>` disposition), `sampleRatio` (default 1.0), `sendCost` (default true), `includeDryRun` (default true, tagged), `projectAliases` (project id → alias, each alias validated), `salt` (at least 32 random bytes; the one salt for digests and ids, D4, D14; telemetry refuses to start without it; the same value on every exporting host, §3.2).

- **`sendCost: false`** omits every `llm.cost.*` and `fleet.cost.*` attribute from every span; token counts are still sent.
- **`includeDryRun: false`** removes dry-run and shadow runs (and their attempts) from selection entirely: none of their spans is mapped, sent or given a disposition. With `true` they are sent with the `dry-run` or `shadow` tag (D10).
- Each setting has its own test in OT2c.

The telemetry section (salt, project name, aliases, route) is distributed as one unit to each exporting host; the endpoint and token file are per host. **Host-side environment:** `FLEET_TELEMETRY_ENDPOINT` (the collector's OTLP/HTTP traces URL) and `FLEET_TELEMETRY_TOKEN_FILE`. Neither the endpoint, the token nor the salt is ever committed; this plan names no host.

**Where the exporter runs.** On the orchestrator's machine and the lane host side, not in the cluster: the driver and the export command are CLI processes there (conductor D2). Three routes from there to Phoenix, which runs on the staging cluster and today is fed by in-cluster apps through the cluster's OTLP collector:

1. **The collector's OTLP/HTTP receiver behind a LAN-only ingress route** with TLS and its own bearer (server-side auth on the receiver), forwarding to Phoenix with Phoenix's key. **Recommended (D13).** One ingest door; Phoenix's key never leaves the cluster; the host token is separate and revocable; the collector adds an attribute filter (drop any key outside `fleet.*`, `llm.*`, `session.id`, `agent.name`, `tag.tags`, `openinference.*`) and drops any `x-project-name` header, as defence in depth. The project is selected by `openinference.project.name` only.
2. **Phoenix's own ingress, directly,** with a Phoenix system API key on the host: protobuf only (D5 alternative), and the key that can also read Phoenix sits on the host.
3. **A loopback forward** (an SSH or port forward to the collector service) for one-off backfills; no ingress, `http:` allowed because the endpoint is loopback (§3.5's definition). It reaches the collector, so its route label is `collector`.

**In-cluster egress.** Not needed in v1: `@fleet/api` emits nothing (§3.3). If the API or a driver ever runs in the cluster, it gets the same egress policy as the other in-cluster apps that feed the collector, in the platform repository.

**Owner items (not lanes; the platform repository is private and the owner's).**
- O-1: a Phoenix project for lanes (or accept `fleet-lanes` being created on first write) and its retention (D7).
- O-2: route 1: the collector's OTLP/HTTP receiver behind a LAN-only route with server-side bearer auth, the attribute filter and the header drop; the host token in a cluster secret and in a `0600` file on each exporting host; the installation's one telemetry salt copied to each exporting host's installation file, with `telemetry status` showing the same fingerprint everywhere. Tier 0 platform PR plus host configuration.
- O-3: after D11, the pricing read-back of §3.6 against a throwaway project, then the first live export, read back in Phoenix.

### 3.10 Manifest entries (owned by OT0)

OT0's plan names every manifest entry now, so each later lane adds only its own entry and binding, one at a time:

- `work-execution` domain: `run-telemetry.ts` (`TelemetrySpan`, `RUN_TELEMETRY_ATTRIBUTES`, digests, id derivation, `pricingSafe`, `laneRunSpans`, `attemptTraceSpans`), with the invariants "only allow-listed keys reach the wire" and "no raw operator id is encoded".
- `work-execution` out-ports and their adapters: `RunTelemetryMarkPort` (no-op, in-memory), `TelemetryDispositionPort` (file, memory), `RunTelemetryPort` (no-op, recording, OTLP/HTTP), `AcceptanceReceiptReadPort` (`AcceptanceReceiptReadAdapter`).
- `work-execution` use case: `ExportRunTelemetryUseCase`.
- `adapter_bindings`: `AcceptanceReceiptReadAdapter` `delegates_to: [evidence-and-acceptance/InspectAcceptanceEvidencePort]`, plus a context-map note beside the existing `evidence-and-acceptance → work-execution` row.
- `@fleet/shared`: `billingOf` (not a manifest symbol; noted in the web row of the README).

## 4. Workbook

Each lane is about 45 minutes (about 100 steps), one PR, the standard pipeline. Shared files are flagged in bold; lanes that touch `.architecture/manifest.yaml`, `apps/cli/src/composition.ts`, `apps/cli/src/index.ts` or a `package.json` merge one at a time, rebased, in sequence with the conductor's lanes that touch them (K7, K11b, AM5, O5). A `package.json` line is a protected path: the orchestrator commits it, not the lane.

| Lane | Scope | Package / shared files | Tier | After |
|---|---|---|---|---|
| OT0 | This plan and the owner's decisions | docs | 0 | — |
| OT1a | `run-telemetry.ts` model: nominal `TelemetrySpan` and its builder, `RUN_TELEMETRY_ATTRIBUTES` and validators (digests, minted ids, project alias, model id, park qualifier, `service.version`), the salted digest function, id derivation and the identity table (§3.4), dispositions, `pricingSafe`, the salt fingerprint, the variant validator; validator and id unit tests | work-execution (domain); sync barrel | 2 | OT0; can start now on `main` |
| OT1r | `redactionChecks` and the seven redaction tests of §3.2 against a stub mapper | work-execution (domain) | 2 | OT1a |
| OT1s | `billingOf` moved to `@fleet/shared`; the web imports it; `@fleet/shared` added to `apps/web`'s dependencies (orchestrator commits the line); `yarn lint:arch` passes, else the §3.6 fallback | shared, apps/web, **`apps/web/package.json`** | 1 | OT0; independent of OT1a |
| OT1b | Pure `laneRunSpans` (§3.1 hierarchy from run, journal entries, attempts, receipts as facts; closed spans only; ambiguous counting; conduct events; hand-run root timing) and `attemptTraceSpans`; one test per span kind and per row of the §3.4 identity table; the prefix-versus-full journal id test; the redaction tests re-run on the real mapper | work-execution (domain) | 2 | OT1a, OT1r, OT1s |
| OT2a | `RunTelemetryMarkPort`, `TelemetryDispositionPort` (file and memory stores; lock, per-span merge, recorded salt fingerprint; the two-writer test), `RunTelemetryPort`, the no-op and recording adapters | work-execution (application, infra), **manifest** | 2 | OT1a |
| OT2b | `AcceptanceReceiptReadPort` and `AcceptanceReceiptReadAdapter` (delegates to `InspectAcceptanceEvidencePort`, projection only); the `adapter_bindings` entry; wiring in both composition roots to telemetry's own read-only inspect use case | work-execution, **manifest**, **`apps/cli/src/composition.ts`**, `apps/api` runtime wiring | 2 | OT1a |
| OT2d | The `readOnly` option on the file stores of `work-execution` and `evidence-and-acceptance`: an unreadable file is a read error with no quarantine copy; a test that a read-only read writes nothing | work-execution, evidence-and-acceptance (infra) | 2 | OT0 |
| OT2c | `ExportRunTelemetryUseCase` with selection, sampling and dispositions (pending before send, final only on a result); the `salt-mismatch` refusal; `sendCost` and `includeDryRun` effects; tests that a killed export leaves `pending` and the next export resends them, and that a throwing port leaves dispositions `pending` and nothing else changed | work-execution (application), **manifest** | 2 | OT1b, OT2a, OT2b, K1b-3 (merged) |
| OT3a | `OtlpHttpRunTelemetryAdapter`'s encoder: OTLP/JSON over the §3.2 subset, the brand check, the `pricingSafe` refusal, golden-payload tests; no network code | work-execution (infra) | 2 | OT2a |
| OT3b | Transport: queue (drop oldest in memory, still pending), batching, retry, split only when `rejectedSpans > 0`, the misconfiguration breaker, per-span dispositions, deadlines, `AbortSignal.timeout`, unref'd timers, loopback rule, token-file read, error kinds; tests against a loopback fake receiver (429 with `Retry-After`, 503, 400 on a batch, partial success with count > 0 and with count 0, three single-span 400s, 401, timeout, deadline reached) | work-execution (infra), **manifest** | 2 | OT3a |
| OT4a | `policy.telemetry` in `installation` (§3.9, including `salt` and `route`), with validation | installation | 1 | OT0 |
| OT4b | Composition in `apps/cli` (no-ops unless configured, read-only repositories for telemetry) and the no-ops in `apps/api`; `telemetry export` (foreground, `--deadline`, `--retry-rejected`, `--dry-run` with its exit codes, `--canary`, exit codes of §3.8) and `telemetry status` (with the salt fingerprints); the runner-env test (§3.5); README operator row | apps/cli, **`composition.ts`, `index.ts`**, `apps/api` runtime wiring | 2 | OT2c, OT2d, OT3b, OT4a; one at a time with K7 on `composition.ts` |
| OT5 | Native emission: the driver calls `mark` after each journalled `advance`; the background exporter in the driver process (own read-only repositories, drains marks, root at a terminal state) with the lifetime mechanism of §3.3; the isolation test of §3.7 | apps/cli (driver), **`composition.ts`** | 2 | OT4b and K7 (unbuilt; K7 needs K4), strictly after both (shares `apps/cli/src/composition.ts` with them) |
| OT6 | Per-call LLM spans: a read-only probe of opencode's message columns (numbers, model, id and time fields only), then `readUsageSteps` on `UsagePort`, one LLM span per assistant message; the aggregate `usage` span stripped of token and cost attributes for attempts not already exported (§3.1); the no-double-count test | work-execution (port, `OpencodeDbUsageAdapter`), **manifest** | 2 | OT4b, D8 |

OT1a, OT1s, OT2d and OT4a can start now on `main`; OT1b follows OT1a, OT1r and OT1s. The domain lanes touch only `run-telemetry.ts` and the barrel, so they run beside the conductor's K4 to K6 if the briefs keep the files disjoint. K1b-3 has merged, so OT2c exports conducted runs as well as hand-run attempts. OT2b and OT4b both touch `composition.ts` and go one at a time with K7; OT5 is the last of OT4b, K7 and OT5 on that file and is rebased onto both. Nothing here changes the conductor's order. The work board's WB12 lane detail reads the same facts; OT1s's move of the billing rule serves both.

## 5. Hard to undo

- **What reaches Phoenix.** Spans sent cannot be recalled from anyone who read or exported them; a Phoenix project can be deleted, which removes them from Phoenix only. §3.2 is the guard, and D11's dry-run review (with `--canary`) and §3.6's pricing gate precede the first send. One-way door, the owner's.
- **Span ids, digests and attribute names.** Phoenix keeps the first write of a span id. A wrong mapping already sent stays until the project is deleted; a corrected mapping needs `v2` ids and a new project (§3.4). Version both from the first commit. The identity table of §3.4 is part of this door: an identity changed after spans were sent produces duplicates under new ids.
- **The salt (one-way).** Every id and digest depends on `policy.telemetry.salt`, one value per installation and the same on every exporting host. Changing it, or losing it, splits every trace and every work order's session from what was sent before, as a schema bump would, and that split cannot be undone in Phoenix; it is kept with the installation file's backups, and the fingerprint check refuses an export that would mix salts. A leaked salt lets someone with a guess of an operator id confirm it from a digest; rotating it is the same split. The owner's choice.
- **Token counts per attempt.** Once an attempt's aggregate `usage` span is exported with token counts, OT6 cannot add per-call spans for it without double counting (§3.1); that attempt stays aggregate-only.
- **The trace's project.** Phoenix fixes a trace's project at its first span; renaming `projectName` later leaves old traces where they are.
- **This plan is public** and lists what fleet-v2 sends. That is intended: it is the contract a reader of a shared Phoenix can check.
- Everything else is a two-way door: the adapter is off by default and removable, and no record format changes except the new disposition store (versioned).

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Trace granularity | **One trace per conducted run; one per attempt for hand-run work**; every span carries `session.id` = the work order's digest (D14) |
| D2 | When the run's root span is sent | **When the run is terminal.** Children appear as their steps close; a run in flight has no root yet. Alternative: an instant anchor root at start (runs listed at once, but the root shows no duration or outcome; the outcome moves to a final DECISION span) |
| D3 | Send cost? | **Yes, metered seats only, as `llm.cost.total` on the `usage` span**, the only span that carries `llm.model_name`. Plan-billed figures only as `fleet.cost.estimate_usd`, never as `llm.cost.*`, and plan-billed spans carry no `llm.model_name` (§3.6) |
| D4 | Project ids in spans | **No raw ids.** An alias the owner lists in `policy.telemetry.projectAliases`, else a salted 16-hex digest (the one salt of D14) |
| D5 | Wire format and route | **OTLP/HTTP JSON to the cluster's collector**, built in-house, no new dependency. Alternative: protobuf straight to Phoenix through an OTel exporter package (a new dependency, Phoenix's key on the host) |
| D6 | Which Phoenix | **The staging cluster's Phoenix only.** Lane telemetry is operator data, not product data; no production Phoenix in v1 |
| D7 | Retention in Phoenix | **90 days** for the lanes project, where the deployed Phoenix supports a per-project retention (unverified); otherwise manual deletion |
| D8 | Per-call LLM spans (OT6) | **Later**: after a read-only probe confirms the message columns hold only numbers, model, ids and time, and after ten exported runs show the attempt-level span is not enough |
| D9 | opencode's own OpenTelemetry | **Off.** It records prompts by default and its config offers no exporter settings |
| D10 | Dry-run and shadow runs | **Exported, tagged `dry-run` or `shadow`**, in the same project. `includeDryRun: false` leaves them out of selection entirely (§3.9) |
| D11 | First live send | **After the owner reads `telemetry export --dry-run --canary` for five recorded runs** (pricing count 0, every canary check passing) and the §3.6 read-back passes |
| D12 | Sampling | **All traces** (ratio 1.0); the setting exists for later |
| D13 | Route from the host | **The collector behind a LAN-only route with its own bearer, an attribute filter and the `x-project-name` drop** (route 1 of §3.9); a loopback forward for one-off backfills |
| D14 | Operator-chosen ids in spans (work order, attempt, prior attempt, receipt) | **Salted 16-hex digests only** (`fleet.work_order.digest`, `session.id`, `fleet.attempt.digest`, `fleet.prior_attempt.digest`), with one installation salt shared with D4; raw ids are hash input only. Run ids and journal entry ids (ULIDs) are sent as they are. Alternative: raw ids, which are readable in Phoenix but may carry branch, client or project words |

## 7. Assumptions

- The deployed Phoenix behaves as its `main` does today: duplicate span ids are ignored, a trace keeps its first project, and `openinference.project.name` selects the project. Resending `pending` spans, split resends and `--retry-rejected` rely on this. If an older version updates or duplicates spans, re-exports may double-count; OT3b's acceptance checks one resend against the deployed instance.
- The cluster's collector accepts OTLP/HTTP JSON and forwards protobuf to Phoenix with its own bearer, as it does for the in-cluster apps. If it cannot take JSON, D5's alternative applies.
- `exported@collector` means the collector accepted the span; a span the collector later fails to forward is invisible to fleet-v2. Clearing that trace's dispositions and re-exporting is the repair, and is safe for the same first-write-wins reason. `exported@phoenix` means Phoenix itself accepted it.
- OTLP partial success names a count, not spans; the split resend of §3.5 attributes it. A receiver that answers a single-span request ambiguously leaves that span `pending`, never exported.
- Phoenix lists a trace whose root has not arrived yet in its span views; if it hides such traces entirely, in-flight runs are invisible until their end, which D2's alternative fixes.
- Phoenix's pricing from its model table needs `llm.model_name`; without it a span is not priced. §3.6's read-back checks this before the first real export.
- `hexagen arch validate` treats `@fleet/shared` like `@fleet/ui`, outside the context dependency rules, so `apps/web` may depend on it. OT1s checks this first; §3.6 has the fallback.
- Record timestamps are on one clock per installation (conductor §7); a skewed clock makes spans look out of order but never wrong in content.
- Journal `entryId`s, journalled keys, attempt ids, receipt ids, `createdAtIso` and `completionReceipt.endedAtIso` are written once and never rewritten; the identities and times of §3.1 and §3.4 rely on it. `updatedAtIso`, the fallback end of a hand-run root, can move after the attempt is terminal; a root sent with it keeps the first value. K3's run store and K7's driver land as planned; until K7 does, conducted runs are exported only by `telemetry export`.
- Run ids and journal `entryId`s are ULIDs minted by fleet-v2 and carry nothing chosen by an operator.
- Model ids, reason codes, park reasons and enum values carry no client content. A model id or enum that ever did would need its validator tightened before it ships.
- The billing rule by runner kind (opencode metered, agy plan) stays true; a new runner kind reads `unknown` until it is classified, and so is never priced.

## 8. Review

- **Rev 2** followed a Grok review of rev 0 (2026-10-27): seven majors and four minors, all addressed: span identities for every kind from durable keys, with a defined root for hand-runs (§3.4); a per-span disposition set in place of a per-trace cursor, advanced only on HTTP results (§3.3); per-span dispositions for partial success (§3.5); separate live and foreground deadlines (§3.5, §3.8); the driver limited to a constant-time mark (§3.3, §3.7); model names only on metered usage spans and a hard pricing gate (§3.6); OT6 replacing the aggregate's tokens (§3.1); validators for project and version (§3.2); a nominal span type (§3.2); a precise loopback rule and a lossless full-queue policy (§3.5); the workbook's tiers and order (§4).
- **Rev 3** follows a Fable review of rev 2 (2026-10-27): one blocker, six majors and five minors, all addressed: operator-chosen ids sent only as salted digests, with salted id hashes and a new canary test (§3.2, §3.4, D14); a consumer-side receipt-read port delegating to evidence's inspect port (§2, §3.3, §3.10); the billing rule in `@fleet/shared`, not imported from `work-execution` by the web (§3.6); a misconfiguration breaker and `--retry-rejected` (§3.5, §3.8); splitting only when `rejectedSpans > 0` (§3.5); the exporter's lifetime in an event-loop-drained CLI and a wider isolation test (§3.3, §3.7); read-only stores with no quarantine copy (§3.3); smaller lanes (§4); the domain lanes starting on `main` without the web edit (§4); a wider model id validator (§3.2); hand-run root timing from named fields (§3.1, §3.4); the park qualifier validator and `mintedId` compared, never exported (§3.1, §3.2). It also adds the manifest entries (§3.10), `--dry-run --canary`, the schema and hash prefix in `telemetry status`, `exported@<route>` dispositions, and the collector's `x-project-name` drop.
- **Rev 3.1** follows a Grok re-check of rev 3 (2026-10-27), which found the eleven earlier findings resolved and raised two majors and five minors, all addressed: one salt per installation on every exporting host, with a fingerprint in `telemetry status` and a `salt-mismatch` refusal (§3.2, §3.9, §5, O-2); a telemetry-only read-only evidence read path, covered by the isolation test (§3.3, §3.7); 16-hex digests everywhere (§3.2, D4, D14); a validator for the variant (§3.2); a single locked writer with per-span merges for the disposition store (§3.3); defined effects of `sendCost` and `includeDryRun` (§3.9, D10); `--dry-run` exit codes (§3.8).
- The research in §2.1 was read from the sources cited on 2026-10-27; opencode's export behaviour beyond its schema, Phoenix's cost pricing and its handling of root-less traces are marked unverified where they are used.

## Challenge this

Whether Phoenix is the right home. Most of a lane run's spans are not model calls: they are forge actions, gates, waits and parks, and v1 has one LLM span per attempt. Phoenix's strengths (prompts, evaluations, per-call views) are exactly what §3.2 withholds, and with D14 even the work order is a digest. A general trace store or the work board's lane detail (WB12) might show the same facts with less machinery. The case for Phoenix is the owner's existing instance, its session view by work order, and its token and cost roll-ups across seats; a reviewer should test whether those survive a payload with no content in it, with model names withheld from every non-metered span, and with sessions named by digests.

Whether the root should wait for the end (D2). Phoenix's first-write-wins rule makes a correct root impossible to send early, but a run that parks for two days is then absent from the trace list for two days. Test the anchor-root alternative against how the owner will actually use Phoenix: comparing finished runs (root at end is right) or watching runs in flight (the web's live tail is meant for that).

Whether the hand-built OTLP/JSON encoder is cheaper than a dependency. It avoids the SDK's resource detectors and a protected-manifest change, but it is code fleet-v2 must keep correct against the OTLP spec, now including the split resend, the misconfiguration breaker and per-span dispositions; the golden-payload tests are only as good as the payloads the collector actually accepts.
