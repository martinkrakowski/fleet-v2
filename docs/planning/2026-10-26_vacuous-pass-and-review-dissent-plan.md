# Plan: a check that ran nothing never passes, and one passing review does not outvote a failing one

- **Date:** 2026-10-26
- **Target repository:** `fleet-v2`
- **Status:** decided (owner 2026-10-26: "Accept all of fable's recommendations"; see `2026-10-26_execution-order.md`). D1, D3, D4 as recommended; D2 with the abandoned-request rule added to §3.2. R1 runs first in the queue, then V1. Nothing built. Anchors checked against `main` at `b6ede22` on 2026-10-26 (§2).
- **Owner request (2026-10-26):** analyse [fabio-rovai/open-ontologies](https://github.com/fabio-rovai/open-ontologies) for features that would benefit fleet-v2, then "go ahead and write up the recommended ideas worth taking". The read-only review found little: no code or dependency worth taking, and two ideas from its decision records. This plan writes up those two.
- **Credit:** open-ontologies' decision records: "conformance is not truth" (a check that did not run must say so, because a missing result and a clean one look the same) and "a second reviewer can contradict, never confirm". It is MIT-licensed. This plan takes ideas only: no code is copied (it is Rust), briefs describe the behaviour in our own words, and lanes are not given its source. Credit is given as a courtesy and a record of provenance; no licence review was done, and none is claimed.
- **Builds on:** `2026-10-23_attempt-record-gate-predicates-usage-plan.md` (S2, gate predicates, not built yet) and `2026-10-25_hexagen-integration-plan.md` (F5, the lint mapping).

## 1. Goal

1. **No vacuous pass.** A verification check that exits 0 but covered nothing is `unknown`, never `pass`. Examples: a test filter that matched no tests, a suite that skipped everything, a linter that scanned no files.
2. **A failing review is not outvoted.** When independent reviews of the same head disagree, the failing one blocks acceptance until it is answered. Agreement between reviews never strengthens a result, and the number of disagreements is recorded and shown.

## 2. What exists (checked 2026-10-26)

| Area | On `main` | Gap |
|---|---|---|
| Verification result | `packages/evidence-and-acceptance/src/infrastructure/adapters/VerificationExecutorAdapter.adapter.ts:217`: `executed.exitCode === 0 ? 'pass' : 'fail'`. A spawn failure, a null exit code and ssh's 255 already map to `unknown` (lines 189–212) | Exit 0 is a pass whatever the command covered |
| Executor contract | `application/ports/out/VerificationExecutorPort.out-port.ts`: the result carries `result`, `exitCode`, `outputSummary`, `completedAtIso` | No coverage field |
| Stored receipt | `domain/evidence-records.ts`, `VerificationReceiptRecord`: `procedureName`, `result`, `exitCode`, `evidenceRef` | Same |
| Required checks | `application/use-cases/AssessHeadAcceptanceUseCase.use-case.ts`, `collectCheckBlockers`: the first receipt for the procedure and head must be in `PASSING_RESULTS` (`pass`, `not-applicable`) | Fine as is; it inherits whatever the adapter decided |
| Review rule | Same file, `collectReviewBlockers` (from line 97): receipts from a non-independent seat are blockers; then `passing = true` if **any** independent read-only receipt for the head says `pass` | An independent receipt that says `fail` is ignored when another says `pass`. Only its findings can block, through `collectFindingBlockers`. A `fail` with no parsed findings is silently outvoted |
| Gate predicates | S2 of the 2026-10-23 plan: `AcceptanceSpec.commands[]` (fixed argv), one result per predicate | Not built; the place to declare what each command must cover |

## 3. The shape

### 3.1 Coverage on verification receipts (evidence-and-acceptance)

- **Domain value:** `CheckCoverage` is a discriminated union: `{ ran: true, unitKind: 'tests' | 'files' | 'checks', units: number }` or `{ ran: false, reason: string }`. It is optional on `ExecuteVerificationCheckResult` and on `VerificationReceiptRecord`; records written before it existed load without it.
- **Domain rule:** a pure function `applyCoverage(result, coverage, expectation)`.
  - **Expectation:** `expectation` is `{ unitKind, minUnits }` for a procedure that declares one, or absent.
  - **Downgrade to `unknown`:** with an expectation, a `pass` becomes `unknown` when `coverage` is missing, is the `ran: false` variant, has a different `unitKind`, or has `units < minUnits`.
  - **No change:** without an expectation, nothing changes, so procedures without a declaration behave exactly as today. `fail` is never upgraded.
- **Adapter:** each allow-listed procedure in `VerificationExecutorAdapter` may name one **coverage reader** from a fixed set, keyed by tool and implemented in infrastructure. Starting set:
  - `vitest-summary`: the number of **executed** tests from vitest's summary (passed plus failed). Skipped and todo tests are not counted, so an all-skipped run has 0 units;
  - `hexagen-lint-json`: `filesScanned` from `hexagen-lint --json`;
  - `eslint-json`: the file count of `--format json`.

  A reader that finds no count returns `{ ran: false, reason: 'no count in output' }`. Readers consume the full combined stdout and stderr that the adapter captures, before it is truncated into `outputSummary`; they never parse `outputSummary`, and they never re-run anything.
- **Exit codes:** only 0 can become `pass`, as today. The readers also never turn a non-zero exit into anything but `fail` or `unknown`. A checker crash whose code looks like a verdict is the reason the rule is "0 or nothing".
- **Declaration:** the expectation lives with the allow-list entry for now. When S2 lands, each `AcceptanceSpec.commands[]` entry carries `{ argv, coverage?: { reader, unitKind, minUnits } }`, and the S2 acceptance use case applies the same `applyCoverage`.
- **Turning coverage on invalidates old receipts.** Adding or tightening a procedure's expectation is a policy change: it increments `policyRevision`, which already marks an assessment stale. Receipts recorded under the earlier revision, including every receipt without coverage, cannot satisfy acceptance; the check runs again.

### 3.2 A failing independent review blocks (evidence-and-acceptance)

- **Rule change in `collectReviewBlockers`:**
  - Among the receipts that are independent and read-only for this head, take the **latest per reviewer model**. "Latest" is the last one recorded in the assessment's append-only `reviewReceipts`, never `completedAtIso`, which records when a run finished, not when it was asked for. To make recording order equal request order, a review request for a reviewer and head is refused while an earlier request from the same reviewer for that head is still outstanding, so runs from the same reviewer never overlap.
  - **An outstanding request can be abandoned.** A review run can die with its host, and its request would then block every later request from that reviewer for that head. A request is abandoned when the transport reports the run ended without a receipt, or when it is older than a fixed limit (default 2 hours) with no receipt; an abandoned request is journaled as such and no longer blocks. A receipt that arrives for an abandoned request is recorded for audit only: it never becomes the latest receipt and never counts toward a blocker or the tally, whatever order it arrives in. "Latest" is therefore the receipt of the most recent non-abandoned request from that reviewer for that head, by request sequence (decided 2026-10-26).
  - If any of those says `fail`, acceptance is blocked with "review by `<reviewer>` failed for this head", even when another reviewer passed.
  - `unknown` neither passes nor blocks. It is listed, and acceptance still needs a passing review as today.
- **How a dissent is answered (D2 default):**
  - the same reviewer passes on a later run for the same head (latest wins);
  - or the code changes, which means a new head and new reviews.

  A different reviewer's pass never answers it.
- **Disagreement is shown, not scored:**
  - `AssessHeadAcceptance` returns `reviewTally: { pass, fail, unknown, disagreement: boolean }` for the head.
  - The CLI and API show it. It is derived, never stored, and never feeds a verdict.
  - There is no "corroborated" or "confirmed by N reviewers" state, and none may be added.

### 3.3 Not in this plan

- **Coverage readers for every tool.** The starting set covers the three tools the gate runs today. Others are added when a procedure needs one.
- **Mutation testing as coverage.** It is a different question (do the tests detect a change?) and stays a lane-brief practice.
- **open-ontologies' other features.** Ontology or SHACL modelling of the architecture would compete with hexagen's manifest. Learned suppression of warnings would turn operator clicks into authority. Embeddings would break lexical-by-design retrieval. A fire-and-forget webhook breaks "persist intent before external actions". fleet-v2 has its own MCP plan.

## 4. Workbook

| Lane | Scope | Tier | Depends on |
|---|---|---|---|
| V1 | `CheckCoverage` and `applyCoverage` in the domain; optional field on the port result and the receipt record; record round-trip and table tests (each downgrade case; no expectation means no change; `fail` never upgraded) | 2 (data) | none |
| V2 | The three coverage readers on the full captured output; the allow-list entry's optional `coverage` declaration; the `policyRevision` increment when an expectation is added; adapter tests from captured fixture outputs (zero tests, all skipped with 0 executed units, no files, missing summary, a summary beyond the 4,000-character `outputSummary` cut, normal run) | 2 (acceptance) | V1 |
| R1 | `collectReviewBlockers` latest-per-reviewer rule, the dissent blocker, `reviewTally`; the refusal of an overlapping request from the same reviewer; tests: pass plus fail from two reviewers blocks; a late receipt from an abandoned request, in either order and with either verdict, changes nothing; the same reviewer's later pass clears it; another reviewer's pass does not; `unknown` neither passes nor blocks; selection follows recording order even when `completedAtIso` runs backwards | 2 (acceptance) | none |
| R2 | CLI and API show `reviewTally`; docs in the README's acceptance section | 1 | R1 |

V1 and R1 are independent and can run in parallel. Each follows the standard pipeline (Mercury-3, gate, Grok, Argon fix rounds, the Fable pass on the Tier 2 lanes). S2, when it is built, takes the coverage declaration in its own lane.

## 5. Hard to undo

- **R1 makes acceptance stricter.** A head that is accepted today, with one passing review and one failing review that has no findings, will be blocked. This is a two-way door (one function), but a visible behaviour change; the owner chooses it through D1.
- **V1 adds an optional field to stored verification receipts.** It defaults on read, so it can be undone, but receipts written with it stay written.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Should a failing independent review block even when another reviewer passed? | **Yes.** Disagreement is the signal; outvoting it hides it |
| D2 | What answers a dissent? | **The same reviewer's later pass on the same head, or a new head.** Never another reviewer's pass. An owner override, if wanted later, goes through the existing authorization path. Decided 2026-10-26, with abandoned requests (§3.2); the "newest receipt overall" alternative is rejected |
| D3 | Should a procedure without a coverage declaration keep today's exit-0 pass? | **Yes,** so nothing changes until a procedure opts in. The gate's test, lint and lint:arch procedures opt in with V2 |
| D4 | Minimum units for a targeted test run? | **1.** A filter that matches nothing is the failure this plan exists for; a higher floor belongs in the lane brief |

## 7. Assumptions

- **Tool output stays parseable.** vitest's summary line, `hexagen-lint --json` and eslint's JSON format are stable enough to read a count from. If a tool changes its format, the reader finds no count and the check goes `unknown`. That fails closed, and it shows up as a blocked acceptance, not a false pass.
- **Reviewer receipts carry a usable `fail`.** `OcmReviewTransport` already maps `VERDICT: FAIL` to `fail` and a missing verdict to `unknown`. Reviews recorded by hand follow the same three values.
- **Disagreement is rare enough to be worth a stop.** If reviewers disagree on most heads, R1 will block often. That cost is the data D1 is meant to surface; the tally makes it visible.

## Challenge this

Is R1 too strict for the review set we actually run? The pre-merge pass and the step-5 Grok review are often different seats looking at different diffs, the fix round's and the final head's. They only count against each other when both are recorded for the same head. If they are, a stale `fail` from a reviewer who never re-ran blocks acceptance until that reviewer runs again, which costs a review round. The alternative is to block only when the failing review is the newest receipt overall. That is cheaper, but it lets the order of runs decide whether a dissent counts.
