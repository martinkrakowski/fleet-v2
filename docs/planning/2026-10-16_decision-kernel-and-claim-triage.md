# Decision kernel and candidate-claim triage

*Date: 2026-10-16 · Status: revision 2.1 after Opus and Grok (not ready on revision 1; seven blockers answered) · Follows
`2026-10-16_decision-port.md` (D1–D5a merged; D5b, the CLI and API wiring of ranking advice split out of D5,
is in review and edits apps/cli and apps/api only)
and Fable's advisory the same day on how best to use Jev in fleet-v2.*

## Goal

1. Move the reusable decision machinery out of brief-knowledge into `@fleet/shared`, so more than one
   context can ask small structured questions under the same rules.
2. Make the ten-proposal re-ranking trial measurable.
3. Add the second, higher-value consumer: triage of candidate claims at note capture.

All decision-port invariants carry over unchanged. In short: **additive only** (a decision may order a
list, show advice or add an escalation; it never decides a disposition, check, review, door or
dispatch); **unknown means today's behaviour**; **declared fields only, secret-scanned, owner-acknowledged**;
**recorded or not made**; **off by default**.

## Non-goals

- Owner-question second opinions (use 2 in the advisory). Separate plan after the questions feature
  (Q1b–Q5) lands.
- Failure-attribution hints for re-dispatch (use 4). Separate plan.
- Anything in head acceptance, review independence, one-way doors, the seat recommender, claim
  verification, permission approval, or state built from artifacts, transcripts or diffs. Excluded.

## 1. The decision kernel in `@fleet/shared`

`@fleet/shared` (Q0, merged) is pure: no I/O, no dependencies. Only pure parts move there:

- **Question and answer types** for `yes-no` (Jev `noul`), `choice` and `score`, and the request shape.
- **Validators**, one per kind, applied to every provider and to answer files:
  - `score`: as today (`jev-advice-validator.ts`): probabilities keyed exactly `"0".."n-1"`, finite in
    [0,1], sum within 0.02, confidence in [0,1].
  - `choice`: `choice` is one of the criteria ids; `probabilities` keyed by exactly those ids, finite in
    [0,1], sum within 0.02; `choice` equals the single highest-probability id (a tie is `unknown/shape`);
    confidence in [0,1]. **Pinned against an owner-recorded `choice` response taken before K1**; until then
    K1 ships the type but the validator is not exported.
  - `yes-no`: probability finite in [0,1]; confidence is `max(p, 1 − p)`.
  - Model and request ids: ≤ 128 chars of `[A-Za-z0-9._/:-]`, as today.
- **State builder**: caller-declared named fields only; per-field and total byte caps (byte length with
  `TextEncoder`); every field checked with `containsSecretShape`; a hit or overflow refuses (never
  redacts); returns the state JSON and its SHA-256 (computed by an injected hasher, since `@fleet/shared` has
  no `node:` imports).
- **Receipt envelope**: the common fields with `consumer: string` as the discriminator. The
  consumer-specific variants live with their consumer (brief-knowledge owns `knowledge-ranking` and
  `claim-triage`), so a new consumer never edits shared.
- **Budget decision rule** (pure): refuse when `consumerSpend + assumed >= consumerBudget` or
  `totalSpend + assumed >= totalBudget`, the same at-the-cap comparison the journal uses today.

Infrastructure stays in each context: the Jev transport (fetch, key file, bounded body), the answer-file
reader and the file journal. brief-knowledge's existing adapters are refactored to import the kernel;
behaviour and tests are unchanged. A second context that needs Jev later gets its own thin transport
adapter or, if three contexts need it, a separate plan for a shared infrastructure package.

## 2. Thresholds

`minConfidence` stops being one global value. Each consumer declares its own threshold, and a threshold
only decides **whether advice is shown or applied to an order**; it never gates an action. It stays where
it is applied today, inside the validator (`low-confidence` → `unknown`). The
installation `decisions` block gains an optional `consumers` map:
`{ "knowledge-ranking": { minConfidence }, "claim-triage": { minConfidence, monthlyBudgetUsd? } }`;
absent entries fall back to the block's `minConfidence`. A consumer without `monthlyBudgetUsd` has no
sub-budget clause (only the block total applies); a present value must be greater than 0. Loader validation as for the existing fields; a
consumer `monthlyBudgetUsd` must not exceed the block's. **Consent:** `claim-triage` sends unreviewed candidate
claims, which the existing acknowledgement (task summaries and keeper claim text) does not cover, so it also
requires `consumers['claim-triage'].acknowledgeCandidateClaimsLeaveHost: true`.

## 3. Receipts that can be measured

`DecisionCallReceipt` becomes a union keyed by `consumer`:

- common: `consumer`, `contextRef`, provider, model, requestId?, costUsd?, estimated, `questionKinds`,
  `minConfidenceObserved`, unknownReason?, latencyMs. `contextRef` formats are fixed:
  `ranking:<laneId>:<proposal sha256 of the sorted candidate entry ids and task summary>` and
  `triage:<attemptId>`;
- `knowledge-ranking`: lexicalOrder, decidedOrder;
- `claim-triage`: per candidate id the chosen class and the reusability score, never the claim text. Its
  settled lines also carry `lexicalOrder: []` and `decidedOrder: []`, so the D4 parser of an older build still
  reads the month file after a rollback (K2 adds a compatibility test that parses a triage line with the D4
  parser rules).

**Reservations carry `consumer`** too (`ReserveDecisionQuery` and the reserved line), so pending spend is
attributed to its sub-budget; old reserved and settled lines without `consumer` read as
`knowledge-ranking`. Both sums are taken under the same month lock.

**Outcomes go to a separate file**, `<stateDir>/decision-receipts/outcomes-<YYYY-MM>.jsonl`, so the budget
journal's fail-closed parser never meets a line kind it does not know and a rollback to an older build
keeps working. An outcome line is `{ consumer, contextRef, kind: 'ranking-selection' | 'triage-disposition',
value, at }`: for ranking, the entry ids the orchestrator recorded through `RecordContextSelectionUseCase`;
for triage, the candidate id and the disposition a checker made. One line per ranking selection (its list of entry ids) and one per
triaged candidate disposition. Writing an outcome is best effort: a `contextRef` with no settled receipt (triage off, budget
refused, `unknown`, a claim left out) is skipped silently, and a failed outcome write never fails the
caller's own operation. Calibration (Brier score on yes/no and
choice answers) reads both files.

## 4. Ten-proposal trial: what decides keep or switch off

Run with D5b merged and decisions enabled on the owner's installation. Per proposal, from receipts plus
the recorded selection (joined by `contextRef`): order changed; top-1 changed; Kendall tau between
lexical and decided order; unknown rate by reason; lowest confidence; latency p50/p95 against the 3 s
timeout; cost; and whether the orchestrator's selection matched the decided order better than the
lexical one. `ProposeBriefContextUseCase` returns the ranking `contextRef` with its proposals;
`RecordContextSelectionUseCase` gains an optional `rankingContextRef` and, when given, writes the selection
outcome (K4). Without it the trial cannot be measured. **Keep re-ranking** if top-1 changes in at least 2 of 10 and selections agree with the
decided order at least as often as with the lexical order. Otherwise switch it off; triage (5) does not
depend on it. A small CLI report `fleet-v2 decisions report --consumer knowledge-ranking` prints these
figures from the journal and the outcomes file.

## 5. Candidate-claim triage (second consumer)

Today `CaptureCompletedAttemptNotesUseCase` turns every note bullet into a candidate claim (up to 50) and
`DecideKnowledgeDispositionUseCase` refuses to accept a claim matching `POLICY_PROPOSAL_PATTERN`.

- **When:** after capture, in as few requests as the 32 KiB state cap allows (candidates as keys `k0…kn`;
  one reservation per request). All requests of an attempt share `contextRef: triage:<attemptId>`; outcomes
  join on that and the candidate id, and "no settled receipt" means none of the attempt's requests settled.
- **Questions per candidate:** `choice` over `lesson`, `policy-proposal`, `instruction`, `status-noise`;
  `score` "reusable beyond this attempt" on four levels from "not reusable" to "broadly reusable".
- **State:** each candidate's `claimText` and the attempt's `pathPrefixes`. Nothing else. Capture caps the
  count (50) but not the length, and the state builder caps a field at 8 KiB and the total at 32 KiB. So
  claims are sent in batches that fit 32 KiB, one reservation per batch; a single claim over 8 KiB is left
  out of triage (no flag, still a candidate), never truncated.
- **Timing:** triage runs after capture has returned and stored the candidates; it never delays or fails
  capture.
- **What an answer may do:**
  - order the disposition queue: a new read `ListCandidateClaimsUseCase` (brief-knowledge) and CLI
    `fleet-v2 knowledge candidates <attemptId>` show most reusable first, noise last. A re-sorted list is
    never truncated;
  - attach an escalation `triage-flag: policy-like | instruction-like` to the candidate when the chosen
    class is `policy-proposal` or `instruction` with confidence at or above the consumer threshold.
- **What a flag changes:** `DecideKnowledgeDispositionUseCase` refuses `accepted` for a flagged candidate
  unless the request carries a non-empty `overrideReason`, recorded on the entry. Order of checks: the
  existing non-empty `reason`, then the regex guard (unchanged; it still refuses on its own), then the flag's
  `overrideReason`. `overrideReason` never substitutes for `reason` or for the regex. Flags are write-once:
  never cleared by a later triage, and triage never runs on an entry that already has a disposition. An
  `unknown` answer writes no flag. The disposition use case appends the triage outcome line.
- **What it may not do:** dispose, accept, reject, defer, change the regex, or drop a candidate.
- **Fallback:** no flags, capture order. **Failure mode:** over-flagging; bounded, because a flag costs
  one override reason and the outcome lines measure it.

## Lanes

| # | Lane | Edits | Depends on | Review |
|---|---|---|---|---|
| K0 | Owner records one real Jev `choice` response with toy claims; committed as a fixture | fixtures only | — | — |
| K1 | Kernel: types, score/choice/yes-no validators against the fixtures, state builder, receipt envelope, budget rule, tests | shared | K0 | F |
| K3 | Installation `decisions.consumers` map, sub-budget bound, triage acknowledgement | installation | — | O |
| K2 | brief-knowledge adopts the kernel; reservations and receipts gain `consumer`, `contextRef`, `latencyMs`, question kinds; old lines read as ranking; per-consumer sub-budgets; separate outcomes file and its writer | brief-knowledge | K1, K3, D5b merged | F |
| K5a | `triageFlag` and `overrideReason` on entries; disposition check order; triage outcome line; `ListCandidateClaimsUseCase` | brief-knowledge | K2 | F |
| K5b | Triage adapter, batching, post-capture hook, factory wiring | brief-knowledge | K5a | F |
| K4 | `RecordContextSelectionUseCase` writes the ranking outcome; CLI `fleet-v2 decisions report` and `fleet-v2 knowledge candidates` | apps/cli, brief-knowledge (outcome call only) | K5b | O |
| K6 | Root wiring for triage in CLI and API | apps/cli, apps/api | K4 | F |

Waves: K0 → K1 and K3 together → K2 → K5a → K5b → K4 → K6. K2, K5a, K5b and K4 all edit brief-knowledge,
so they run one per wave in that order.

## Hard to undo

- The receipt union becomes the persisted journal format; old lines stay readable by rule.
- `overrideReason` and `triageFlag` are new persisted fields on knowledge entries.
- The outcomes file is a second persisted journal.
- Candidate claim text leaves the host when the owner enables triage, under its own acknowledgement; the
  triage consumer can be disabled on its own.

## Assumptions

- Jev's `choice` answers carry the shape described here; K0's owner-recorded fixture confirms it before
  the validator is pinned, and a mismatch means `unknown/shape`, so no flags.
- Batches that fit the 32 KiB state cap stay well inside Jev's 262k-token context.

## Challenge this

Whether a triage flag that requires an override reason on acceptance is too strong for an advisory model:
a confident but wrong `instruction` classification adds friction to a real lesson. The outcome lines make
this measurable; the threshold per consumer is the dial.

## Review

- Revision 1, 2026-10-16: Opus not ready (choice validator before its fixture; false size assumption; reservations
  without consumer; outcome lines breaking the fail-closed parser; no stable contextRef; no triage outcome writer
  or review list; K4/K5 ordering and D5b undefined; K5 too large; consent scope). Revision 2 answers all of them.
- Revision 2, 2026-10-16: Grok not ready (outcome refusal could fail a disposition; selection writer lacked the
  ranking reference; optional sub-budget undefined; triage settled lines would break an older parser). Revision
  2.1 answers all four; the final check's batching note is fixed in the same revision.
