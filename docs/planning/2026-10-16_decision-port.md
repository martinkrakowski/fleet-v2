# Decision port and Jev adapter

Revision 1.2, 2026-10-16. Status: draft. Rev 1.0 reviewed by Fable and Grok
(both NOT READY); rev 1.1 re-checked by Grok (three blockers, closed here).

## Goal

Let brief-knowledge ask small structured judgements (graded score first) of
TypeSafe Jev (`typesafe/jev-1.14` via OpenRouter `POST /api/alpha/decisions`),
with a local answer file and a null adapter as the deterministic alternatives.
The first and only consumer in this plan is advisory knowledge ranking.

## Invariants

1. **Additive only.** A decision may reorder advisory candidates, and in later
   plans add a blocker or escalation. It never satisfies a required check,
   replaces a review, grants authority, removes a blocker or admits an entry.
2. **Unknown means today's behaviour.** Timeout, HTTP error, bad shape,
   redaction refusal, budget, missing receipt store or low confidence yield
   `unknown`; the consumer then returns exactly the deterministic result.
3. **Control plane only.** Lanes never call the port or see the key. The key is
   read by the host process from a mode-600 file at call time; it never enters
   argv, runner env, installation JSON, logs, receipts or briefs.
4. **Declared fields only, owner-acknowledged.** The state sent is exactly
   `taskSummary` and each candidate's `claimText` (plus `pathPrefixes`). Never
   `dispositionReason`, `checks`, `reuses` or anything else. Before sending,
   every field is scanned with `SECRET_PATTERNS` and size caps (8 KiB per field, 32 KiB total); a hit refuses
   the call (`unknown/redaction-refused`), it never redacts and sends. A regex
   cannot detect client prose, so enabling decisions requires
   `decisions.acknowledgeProseLeavesHost: true` in the installation: the owner
   accepts that task summaries and keeper claim text reach the provider. A
   project may opt out with `decisions.disabledProjects`.
5. **Recorded or not made.** Every decision, from any adapter including the
   answer file, is appended to a receipt store
   before its answer is used. Without `--state-dir` there is no durable store,
   so the port answers `unknown/not-configured`.
6. **Off by default.** No provider unless the installation declares one.

## Placement (hexagonal)

The port is owned by **brief-knowledge**, the only consumer. No shared kernel
yet: `layer-rules.yaml` allows only `@fleet/shared` (which does not exist),
and `@fleet/tooling` is I/O-free and depends on installation. If a second
context needs decisions, a later plan promotes the types to `@fleet/shared`
with the linter whitelist in the same lane.

New in brief-knowledge (manifest entries, Hexagen sync):

- out-port `KnowledgeRankingAdvicePort`
  `adviseRanking({ taskSummary, pathPrefixes, candidates: {id, claimText}[] })
   → { status: 'advised', scores: Record<id, number /*0..1*/>, receipt } | { status: 'unknown', reason }`
- out-port `DecisionReceiptJournalPort` — append-only.
- adapters `JevRankingAdviceAdapter`, `AnswerFileRankingAdviceAdapter`,
  `NullRankingAdviceAdapter`, `FileDecisionReceiptJournalAdapter`
  (JSONL under `<stateDir>/decision-receipts/`, never the signed owner-decision
  inbox `<stateDir>/decisions/`), and the decorator
  `AdvisedKnowledgeRetrievalAdapter` around `KnowledgeRetrievalPort`.

`SECRET_PATTERNS` is already in brief-knowledge, so no cycle.

## Ranking semantics (exact)

1. The decorator calls the inner `KnowledgeRetrievalPort` with the **original
   query**. The result (already filtered to positive lexical score, cut to
   `maxEntries`/`maxTotalChars`, tie-broken by `entry.id`) is the set.
2. Decisions **only reorder that set**. Membership never changes, so no
   entry can be admitted or dropped. (Widening the pool and re-cutting is
   explicitly out of scope.)
3. Order key: the inner `RankedKeeperMatch.score` (lexical overlap plus path
   weight, always > 0 in the set) divided by the set maximum, in (0,1], plus
   `w × decisionScore`,
   `w = 0.5` constant, ties by `entry.id`. `decisionScore` is the expectation
   `Σ p_i × i / (levels−1)` in [0,1], with `criteria` ordered from least
   relevant (index 0) to most relevant (index 3).
   A reorder changes the `bkp-<id>-<index>` proposal ids, which are rank
   positions; nothing keys on them across proposals.
4. With 0 or 1 entries in the set the port is not called (no fee, no
   receipt).
5. On `unknown`, the decorator returns the inner result object unchanged
   (reference-equal; tested).
6. `matchReason` becomes `lexical+decision(<model>, c=<confidence>)`; no hash
   or request id (it flows into `proposedBecause`).

## Jev mapping

- One request per proposal: `state` = JSON of the declared fields, one
  `score` question per candidate keyed `k<index>`, `criteria` = four fixed
  relevance levels.
- Strict validator, also applied to answer-file content: every asked key
  present; `probabilities` length equals levels; all numbers finite in [0,1];
  probabilities sum within 0.02 of 1; `confidence` in [0,1] and
  ≥ `minConfidence`, else `low-confidence`. (Yes-no and choice validation is
  specified when a consumer needs them; yes-no confidence will be
  `max(p, 1−p)`.)
- Transport: `fetch`, AbortController timeout 3 s, one attempt, response size
  cap 64 KiB, `Authorization` never logged, errors carry HTTP status only,
  never bodies. Served model id is recorded, not trusted.
- **Fixtures are owner-recorded, not lane-invented.** Before D2, the
  orchestrator runs one smoke call with toy state from the host and commits the
  raw response into `__fixtures__/jev/`. The lane builds the parser against it.

## Budget

`monthlyBudgetUsd` is enforced by the receipt journal, months in UTC. Under the
existing `withFileLock` the adapter sums this month's costs, refuses at or above
budget (`unknown/budget`, no fetch), and appends a `reserved` entry costed at
`assumedCostPerCallUsd` (a required field of the jev block) before the fetch.
After the call it appends a `settled` entry with the reported cost, or keeps the
assumed cost when the response has none. If the settled append fails, the
answer is not used (`unknown/not-configured`) and the reservation still
counts, so a paid call is never invisible to the budget.

## Installation

v2-only optional block, discriminated like `shelf`:
`decisions: { provider: 'none' } | { provider: 'jev', model, keyFile, minConfidence, monthlyBudgetUsd, assumedCostPerCallUsd, acknowledgeProseLeavesHost: true, disabledProjects? } | { provider: 'answer-file', answerFile }`.
The loader checks shape and absolute paths only. Key-file mode/symlink/type
checks run in the adapter on every read (`O_NOFOLLOW`, regular file,
`mode & 0o077 == 0`), following `WavesHttpClient`.

## Lanes

| Lane | Scope | Seat | Size |
|---|---|---|---|
| D1 | Ports, Null adapter, decorator with pure reorder + reference-equal unknown tests, manifest, Hexagen | glm-5.3 | medium |
| D2 | Jev adapter + validator + transport hygiene against owner fixtures; answer-file adapter | glm-5.3 | medium |
| D3 | Installation `decisions` block: parse, types, write, model, tests; v1 rejects | glm-5.3-flash | small |
| D4 | Receipt journal adapter, budget ledger, in-memory → not-configured | glm-5.3-flash | small |
| D5 | Wiring in CLI and API roots (API plumbing from the runtime plugin's installation) | glm-5.3 | medium |

D1 and D3 in parallel; then D2 and D4; D5 last. Fable pre-merge pass on D2,
D4 and D5 (data leaving the host, key handling, receipts); the rest use the
standard review order. Standard seat fallback order applies.

## Proof

- Every `unknown` reason returns the inner result reference-equal.
- Secret hit, budget reached, no state dir, disabled project: spy transport
  records zero calls.
- Validator accepts the recorded fixture; mutated shapes (missing key, NaN,
  out-of-range, bad sum, wrong length) give `unknown/shape`.
- Reorder never changes membership (property test over random inputs).
- CI never calls the network. One owner-run smoke call, cost in the PR.

## Trial

Enable on the owner's installation for ten recorded proposals. Receipts carry
`lexicalOrder` and `decidedOrder` ids, cost, latency and unknown reason, so the
trial measures how often order changed and whether the orchestrator's
selection differed. Keep or disable on that record.

## Excluded: permission auto-approval

OpenRouter's cookbook shows Jev clearing coding-agent permission prompts
(ask → allow above a 0.9 threshold, behind a static risk list). That turns a
decision into authority and violates invariant 1. fleet-v2 lanes run with
fixed agent permissions and should never prompt. It is out of scope; adopting
it anywhere needs its own plan and an explicit owner decision.

## Later consumers (separate plans)

An extra rejection reason for note classification, an escalation-only risk
gate, routing hints to the O6 recommender, semantic verification blockers.
Each cites invariant 1.

## Hard to undo

- State sent to a third party cannot be recalled. Off by default; enabling it
  is the owner's per-installation acknowledgement (invariant 4).
- Keeping the port in brief-knowledge means a second consumer later moves types
  to `@fleet/shared`; chosen deliberately over a premature shared kernel.

## Assumptions

- `/api/alpha/decisions` keeps its shape through the trial; if it changes the
  validator yields `unknown` and the receipt unknown-rate shows it.
- A score's expectation is a meaningful relevance signal; the trial tests it.
- Cost stays near $0.00002 per call; the budget ledger caps surprises.

## Challenge this

Whether reorder-only within the deterministic set is worth a network hop at
all, given the default set is five entries the orchestrator reads anyway; the
trial's "selection differed" count is the test. And whether `w = 0.5` lets a
confident score overturn a clear lexical lead.
