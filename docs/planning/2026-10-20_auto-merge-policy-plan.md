# Plan: an auto-merge setting and how its exceptions are handled

- **Date:** 2026-10-20
- **Target repository:** `fleet-v2`
- **Status:** rev 2: the Opus review of rev 1 applied (two blockers: pending checks are
  indistinguishable from failures, and attention items have no store; five should-fixes). See §11.
  Nothing built.
- **Owner request (2026-10-20):** "We should create a setting to allow the developer to toggle 'auto'
  merge, and how to handle exceptions." Then, on the proposed shape: "yes please proceed with your
  recommended defaults" (auto-merge off for a new installation; high-risk lanes excluded unless
  opted in separately).
- **Builds on:** `2026-10-16_onboarding-and-init.md` (schema v2 `policy`),
  `2026-10-16_onboarding-settings-ui.md` (setup mode U1–U4, settings view U7–U8, unbuilt),
  `2026-10-18_orchestrator-interaction-plan.md` (the TUI, T8a, unbuilt),
  `2026-10-19_free-seat-flag-plan.md` (fleet-v2 #134: the same surfaces for another `policy` key)

## 1. Goal

One installation setting, `policy.autoMerge`:

- **off (the default, and the value when the key is absent):** today's behaviour. A merge runs only
  with a grant from an owner decision.
- **on:** when a lane's attempt is accepted at its current head and the lane is eligible (§3, A4),
  fleet-v2 issues a policy grant for exactly that merge and runs it. When it cannot, the exception is
  handled by a fixed or configured rule (§4), never guessed.

**Non-goals.** It does not weaken a single merge check that exists today (current-head acceptance
receipt, one-way doors decided, unmoved head, single-use grant). It does not change what the Claude
Code orchestrator may merge on the owner's machine; that is governed by Claude Code's own permission
system and the owner's settings. It adds no daemon: merges happen when a command runs (A6).

## 2. What exists (checked 2026-10-20, `main` at `f40707e`)

| Piece | State |
|---|---|
| Merge | `ExecuteAuthorizedForgeActionUseCase` (`packages/work-execution/src/application/use-cases/ExecuteAuthorizedForgeActionUseCase.use-case.ts`): forge mode `none` refuses; the attempt's head must equal `expectedHeadSha`; one-way doors re-checked through `attemptOwnerDecisionPort`/`OwnerDecisionPort` (`:313-342`); for `merge-pr` the acceptance assessment must be `accepted`, at this head, at the work order's `policyRevision` (`:172`), with a receipt id; then the grant is consumed (`:193`), intent journalled, and the forge runs (`:214`) |
| Forge adapter | `ForgeActionAdapter.runPrMerge` runs `gh pr merge <branch> --match-head-commit <sha> --merge`; any non-zero exit is `refused` with the first stderr line (`:190-193`), a subprocess that could not complete is `ambiguous`. Refusals carry no kind, and a merge that landed on the server with a failing exit would read as `refused` |
| Grants | `CoordinationRequest` records in state `approved` carry a `grantId`; resolve and consume need only non-empty `grantId`, `decisionRevision`, `policyRevision` and state `approved` (`CoordinationRequest.ts:35-54, 188-198`), and consult a decision transport only for `awaiting-decision` (`ResolveActionAuthorizationUseCase:144`). Nothing issues a grant from policy. Without a grant id, resolve takes the **most recent approved request for the scope across the project, whatever its head** (`:125-136`). Forge scopes are `forge:<kind>` (`work-execution/src/domain/coordination-keys.ts:8-9`). Consumption finds the attempt from coordinates written by the CLI's `resolveGrant`, else falls back to the first attempt with that head (`apps/cli/src/composition.ts:1279-1300`) |
| Policy revision | An opaque string the caller passes to `work-order register --policyRevision` (`apps/cli/src/index.ts:634`), stored at registration and compared at merge. It is **not** derived from the installation file; the installation has no revision field |
| Acceptance | `AssessHeadAcceptanceUseCase` already reads `unresolvedThreadCount` through `ForgeEvidencePort` and blocks on > 0 or unreadable (`:290-295`). Every non-passing CI state, `pending` included, becomes a text blocker (`:287-288`); the CLI adapter flattens `blocked`/`stale`/`rejected` into `rejected` with a reason string (`composition.ts:1121-1125`), and work-execution's acceptance port knows only accepted / rejected / unknown. **Pending and failed cannot be told apart** without parsing text |
| Trigger | A merge runs only when someone calls `forge execute --kind merge-pr --authorizationGrantId …` (`index.ts:944-957`) or `POST /v1/forge`. Nothing calls it after `attempt accept` |
| Risk | Work orders carry no risk class (`WorkOrderRecord`, `execution-records.ts:34-48`) |
| Policy | `PolicySection {forbiddenRoutes?, perLaneCostCeiling?}` (`packages/installation/src/types.ts:199-202`); strict keys in the parser; compare-and-swap writer |
| Owner questions / attention | `AskOwnerQuestionUseCase` (Waves question) exists. Attention is **read-only**: `ReadProjectAttentionUseCase` over an `AttentionReadAdapter` scaffold that reports absence (`composition.ts:612-613, 653`); nothing can write an attention item |

So the setting needs: a **policy grant** source, a **trigger** after acceptance, a **risk class** on
the work order, **structured acceptance blockers**, and an **attention store** that can be written.
Everything from grant consumption onward is today's merge path, unchanged.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| A1 | The key is `policy.autoMerge: { enabled: boolean; allowHighRisk: boolean; onBlocked: 'ask-owner' \| 'hold' }`. Absent key = `{enabled: false, allowHighRisk: false, onBlocked: 'ask-owner'}`. A present block must name all three fields. **v2 only:** a v1 file is refused with "migrate to v2", as in the free-seat plan (F1) | The owner chose "off by default" and "high-risk excluded unless opted in"; an explicit block avoids half-set values |
| A2 | `autoMergeRevision` is a content hash (sha256 of the canonical JSON of the `autoMerge` block, first 12 hex), computed by `@fleet/installation`. It is unrelated to the work order's `policyRevision`, which stays the caller-supplied string it is today, so toggling the setting never makes an acceptance stale | Grants and journal entries need to name which setting authorised them; the installation has no revision field to reuse |
| A3 | A **policy grant** is an ordinary `CoordinationRequest`: kind `action-decision`, state `approved`, scope `forge:merge-pr`, `expectedHeadSha` = the accepted head, `policyRevision` = the work order's, `decisionRevision` = `policy:autoMerge@<autoMergeRevision>`, `proposalDigest` over (attempt id, head, acceptance receipt id). A new `IssuePolicyMergeGrantUseCase` (operator-coordination) records it **with the attempt coordinates** the consumption adapter reads, and **cancels every earlier unconsumed policy grant for the same work order** in the same write. Resolve, consume and journal code are unchanged; the auto-merge path always passes the grant id explicitly | One grant shape keeps "one grant, one action, once". Cancelling earlier grants stops stale policy grants from shadowing an owner's `resolve-auth` for another lane (resolve without an id takes the newest approved request for the scope) |
| A4 | **Eligibility** (all must hold, else no grant): `enabled`; acceptance `accepted` at the head with a receipt id (this already covers CI, review and unresolved threads); the brief names **no** one-way door, read through `attemptOwnerDecisionPort` as the merge does; work order risk `standard`, or `high` with `allowHighRisk`; forge mode `github`; the work order is not merged and has no ambiguous forge entry awaiting reconciliation | A one-way door is the owner's by definition; the rest are the owner's two choices plus facts the merge depends on |
| A5 | Work orders gain `risk: 'standard' \| 'high'`, set at registration and frozen with the brief. **Absent = `high`** (fail closed): every existing work order, and any registered without a risk, is excluded from auto-merge | A lane that touches data safety, security or user-facing behaviour must not auto-merge because nobody labelled it |
| A6 | **Trigger:** CLI only in v1. `fleet-v2 attempt accept`, when it returns `accepted` and `enabled` is true, runs the auto-merge use case in the same invocation; `fleet-v2 attempt auto-merge <attemptId>` runs it explicitly (second look, re-try after a hold). The contexts are joined only in the CLI composition root; work-execution's application layer never imports `@fleet/operator-coordination` | Dispatch is CLI-only today; a merge side effect on an HTTP route widens what the single bearer token does |
| A7 | Turning the setting off cancels every unconsumed policy grant (state `cancelled`) | Off must mean off for grants issued a moment earlier |
| A8 | Each merge's journal entry names who authorised it (`owner-decision` or `policy:autoMerge@rev`) | An audit can separate the owner's merges from the policy's |
| A9 | The `/v1` API gains **no** route that writes the setting; editing from the web goes through setup mode (§5), as the free-seat plan's F9 | A leaked `/v1` token must not be able to turn on auto-merge |
| A10 | Turning `enabled` on (and `allowHighRisk` on) prints the eligibility rules and asks y/N; off never asks. Every write is compare-and-swap with a before/after diff | On grants authority; off only removes it |
| A11 | **Structured blockers.** Acceptance's blockers gain a kind: `ci-pending`, `ci-failed`, `threads-unresolved`, `threads-unreadable`, `review-missing`, `door`, `stale`, `other`. They travel through evidence-and-acceptance's in-port, work-execution's acceptance out-port and the CLI adapter as data; the text stays for display. No decision is ever taken by parsing a reason string. The auto-merge record keeps a `firstLookAt` per (attempt, head) for the pending rule | §4 needs to tell pending from failed (rev-1 blocker) |
| A12 | **Attention store.** operator-coordination gains `RecordAttentionItemUseCase` and a write port with a file store under the state dir (in-memory without one), keyed by (project, work order, kind) so a repeat replaces rather than piles up; `ReadProjectAttentionUseCase` reads it; an item is cleared when its work order merges or the owner dismisses it | `hold` and every "attention item" row in §4 need somewhere to write (rev-1 blocker) |
| A13 | A forge refusal of kind `other` reads the PR's state at the head before asking the owner: already merged at that head → mark the work order merged and journal a reconciliation; otherwise ask | A merge that landed with a failing `gh` exit must not be reported as refused |

## 4. Exceptions: what happens when auto-merge cannot merge

| Exception | Handling | Configurable |
|---|---|---|
| Not eligible: one-way door, high risk without opt-in, forge mode `none` | No grant. An attention item "needs an owner merge" with the reason | No |
| Acceptance blocked only by `ci-pending` | No grant; `firstLookAt` recorded. The next `accept` or `auto-merge` run re-assesses; if a `ci-pending` blocker remains on that second look, `onBlocked` applies. No timer runs | No (the second look is fixed) |
| Acceptance blocked by anything else (`ci-failed`, `threads-*`, `review-missing`, `stale`, `other`) | No grant; `onBlocked`: `ask-owner` asks a Waves question with the blockers listed; `hold` writes an attention item and asks nothing | Yes (`onBlocked`) |
| **Forge refused**: `conflict`, `protection`, `permission` | The grant is spent (consumed before the forge runs); policy never issues a second grant for the same head; an owner question carries the refusal text | No |
| **Forge refused**: `other` | A13 first; then as the row above | No |
| **Head moved** | No merge, grant unspent; the attempt goes back through acceptance at its new head | No |
| **Ambiguous** forge outcome | Journalled `ambiguous`; reconciliation decides; auto-merge is suspended for that work order until it is reconciled; never retried, never guessed | No |
| Settings or evidence **unreadable** | Treated as off for that run: no grant, an attention item | No |

`hold` is for an owner who reads the attention list and does not want a question for each blocked
lane; `ask-owner` is the default because silence is not approval.

## 5. Surfaces

- **CLI (first):** `fleet-v2 policy auto-merge [status|on|off] [--allow-high-risk|--no-allow-high-risk]
  [--on-blocked ask-owner|hold] [--yes]`: prints the diff, asks y/N as A10, writes with
  compare-and-swap, exits 0 / 1 (refused, e.g. a v1 file) / 2 (usage). `fleet-v2 attempt auto-merge
  <attemptId>`; `work-order register` gains `--risk standard|high`; `coordination attention` shows
  held items; `doctor` prints the setting and the count of eligible accepted attempts.
- **Web:** read in the planned settings view (U7/U8); change in setup mode's Policy section (U4)
  behind `AlertBox`: what it does (which kinds of lane may merge without the owner), what it does not
  do (no one-way door, no high-risk lane unless opted in, no merge without acceptance), and that the
  API must restart. Waits on U1–U4 and U7.
- **TUI (T8a):** shows the setting; changes it by running the CLI command in-process. Never through
  `/v1`.
- **MCP:** read-only, once `GET /v1/settings` exists.

## 6. Lanes

Each lane is one PR, about 45 minutes of lane time.

| Lane | What | Where | After | Review |
|---|---|---|---|---|
| AM1 | `policy.autoMerge` in types, parser (strict keys), writer; defaults; `autoMergeRevision` (A2); tests: absent key, partial block refused, v1 refused, hash stable across key order | packages/installation | — | O |
| AM2 | `risk` on `WorkOrderRecord`/`WorkOrder`, set at `RegisterWorkOrderUseCase`, frozen; absent = `high`; `work-order register --risk`; stored records without the field read as `high` | packages/work-execution, apps/cli | — | O |
| AM3a | `IssuePolicyMergeGrantUseCase` (A3: coordinates recorded, earlier policy grants for the work order cancelled) and `CancelPolicyGrantsUseCase` (A7); manifest entries; tests: one live grant per work order, resolve-without-id is not shadowed by a cancelled policy grant, cancel leaves consumed grants alone | packages/operator-coordination | — | O |
| AM3b | Attention store (A12): write port, file and in-memory stores, `RecordAttentionItemUseCase`, `ReadProjectAttentionUseCase` reading it, dismissal; replace the scaffold `AttentionReadAdapter` | packages/operator-coordination, apps/cli wiring | — | O |
| AM3c | Structured blockers (A11) in `AssessHeadAcceptanceUseCase` and its in-port; work-execution's acceptance out-port and the CLI/API adapters carry kinds; existing text unchanged | packages/evidence-and-acceptance, packages/work-execution (port), apps/cli, apps/api wiring | — | O |
| AM4b | Forge adapter: refusal kinds (`conflict`, `protection`, `permission`, `other`) from `gh` output, unknown = `other`; a PR-state read for A13; tests with recorded `gh` outputs | packages/work-execution (infrastructure) | — | O |
| AM4a | `AutoMergeAttemptUseCase` in work-execution: eligibility (A4), grant through a consumer-side out-port to AM3a, the existing `ExecuteAuthorizedForgeActionUseCase` with the grant id, §4 routing through owner-question and attention out-ports, `firstLookAt`, A8 journal field; settings through a consumer-side port over a structural subset of the installation (the free-seat plan's port pattern); manifest `use_cases` entry | packages/work-execution | AM1, AM2, AM3a–c, AM4b | **F** (it decides what merges) |
| AM5 | CLI: `policy auto-merge`, `attempt auto-merge`, the trigger inside `attempt accept` (A6), `doctor` lines; wiring in `apps/cli/src/composition.ts` | apps/cli, packages/onboarding | AM4a | O |
| AM6 | The setting in `GET /v1/settings` (folded into U7) | apps/api | AM1, U7 | O |
| AM7 | The setup-mode toggle and its `AlertBox` (folded into U4) | apps/web | AM5's engine, U4 | O |
| AM8 | TUI display and change (folded into T8a) | apps/cli (tui) | AM5, AM6, T8a | O |

Waves: AM1, AM2, AM3a, AM3b, AM3c, AM4b together → AM4a → AM5 → AM6–AM8 as their host plans land.
The first wave shares `apps/cli/src/composition.ts` (AM3b, AM3c) and the `policy` parser with the
free-seat plan's FS1 (AM1): those merge one at a time, each rebased on main. After each lane:
`yarn build && yarn typecheck && yarn lint && yarn lint:arch`, the lane's tests, `yarn sync:check`;
the manifest updated for every new port and use case.

## 7. Testing

- No `autoMerge` key: `attempt accept` returns exactly as today and nothing merges (golden of the CLI
  output).
- `enabled` on, a `standard` lane, accepted: one policy grant with coordinates, one merge, journal
  names `policy:autoMerge@rev`, the grant is consumed.
- Each row of §4 has a test: door named; risk absent (treated `high`); `high` with and without
  `allowHighRisk`; `ci-pending` on the first and second look; `ci-failed` and `threads-unresolved`
  with `ask-owner` (one question) and `hold` (no question, one attention item, replaced not
  duplicated on a repeat); each forge refusal kind (no second grant); `other` with the PR already
  merged (work order marked merged); moved head (grant unspent); ambiguous (suspended until
  reconciled); unreadable settings.
- A new policy grant for a work order cancels its earlier one; an owner's `resolve-auth` without an
  id for another lane is not answered by a policy grant.
- Turning off with an unconsumed policy grant: the grant is `cancelled` and `forge execute` with it
  is refused.

## 8. Risks

- **A wrong risk label.** The orchestrator that registers a work order labels its risk, and a
  `standard` label lets it merge without the owner. Absent = `high` limits the damage to labels that
  were set deliberately; the brief, where the label is frozen, is reviewed before dispatch.
- **Merging on stale CI.** Acceptance binds required checks to the exact head and `gh pr merge
  --match-head-commit` refuses a moved head, so a merge on a head CI did not see is refused, not run.
- **A review bot that is out of quota posts a notice, not findings.** Acceptance sees no unresolved
  thread, so the notice does not block. The fleet rule "a capped bot's notice is never 'no
  findings'" is not enforced by this plan; the independent review receipt in acceptance remains the
  review that counts.
- **Many questions at once.** With `ask-owner`, a wave of blocked lanes asks one question each;
  `hold` exists for that case.

## 9. Assumptions

- `gh` refusal messages are stable enough to classify; an unclassified refusal is `other`, reads the
  PR state (A13) and then asks the owner, so a changed message degrades to a question, not a retry.
- Changing acceptance's blocker shape (AM3c) is additive: existing callers keep the text.
- Setup mode (U1–U4), the settings view (U7) and the TUI (T8a) are built as planned; until then the
  setting is CLI-only.

## 10. Challenge this

A5's fail-closed risk default, together with the orchestrator labelling risk. It is the only thing
between auto-merge and a security or data-safety lane, and the actor that benefits from a merge is
the one setting the label. The alternatives, inferring risk from owned paths or requiring the
reviewer to confirm the label in its receipt, are stronger and add work to AM2 and to the review
receipt; this plan takes neither and asks the reviewer which is worth it.

## 11. Review

**Opus, rev 1 (2026-10-20), read-only, checked against `main`.** Applied in rev 2:

- Blocker: pending checks are text blockers, flattened to `rejected` by the CLI adapter; the
  "second look" rule could not be implemented → A11, AM3c.
- Blocker: attention is a read-only scaffold; `hold` had nowhere to write → A12, AM3b.
- A3 holds with unchanged resolve/consume code, but the scope is `forge:merge-pr`, `policyRevision`
  must be set, the grant must record the attempt coordinates, and stale policy grants could shadow an
  owner's `resolve-auth` → A3 rewritten (cancel earlier grants on issue).
- A2's premise was wrong: `policyRevision` is a caller-supplied string, not derived from the
  installation; the revision split was unnecessary → A2 is now a content hash of the block.
- Acceptance already reads unresolved review threads → the separate thread read is dropped; A4
  relies on acceptance.
- A non-zero `gh pr merge` exit after a server-side merge reads as `refused` → A13, AM4b.
- CLI group is `attempt`, not `execution`; the door check reads `attemptOwnerDecisionPort`;
  `AutoMergeAttemptUseCase` goes in the manifest; layering (work-execution → operator-coordination
  through composition-root adapters) confirmed acyclic.
