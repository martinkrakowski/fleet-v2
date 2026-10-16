# Owner questions in the UI, answers back to the orchestrator

*Date: 2026-10-16 · Status: revision 2, after Fable and Grok (both not ready on revision 1; every blocker
answered below) · Owner request, 2026-10-16: "I would love to surface your questions directly within the
UI, and have the answers bubble up to the orchestrator once accepted, rejected or directly answered by
user."*

## Goal

Every question the orchestrator needs the owner to answer appears in `@fleet/web` with its options and the
orchestrator's recommendation. The owner accepts the recommendation, rejects it, or writes another answer.
The orchestrator reads the answer from fleet-v2, not from chat.

## Non-goals

- Replacing chat. The orchestrator still explains; the UI is where the answer is recorded.
- Any new way to grant authority. An answer never approves a forge, acceptance or dispatch action by itself.
- Any action fired by an answer. An answer unblocks; the orchestrator acts.

## What exists today (verified)

- `CoordinationRequest` records proposals (`RequestScopedDecisionUseCase`); `POST /v1/decisions` records a
  proposal, it does not accept an answer.
- The only approval path: the owner writes `<stateDir>/decisions/<requestId>.json` carrying an Ed25519
  signature over `canonicalDecisionBytes` (`requestId, projectId, actionScope, expectedHeadSha,
  decisionRevision, grantId, state`); `DecisionTransportAdapter` verifies it with the owner public key.
  There is no CLI or HTTP command that signs or records an owner answer.
- `ResolveActionAuthorizationUseCase` matches requests by `actionScope` only, whatever their kind.
- The web app is read-only and server-side: the browser never holds the `/v1` token, and the API refuses
  browser origins. The Attention view is Waves-backed and unavailable locally; local outstanding items come
  from `GET /v1/coordination`.
- `SECRET_PATTERNS` lives in brief-knowledge; operator-coordination cannot import it.

## Design

### 1. `OwnerQuestion`, its own aggregate (operator-coordination)

Not a `CoordinationKind`, so the authorization use cases never read it. Own repository port and adapter,
store file `<stateDir>/owner-questions.json`, manifest and ownership-registry entries, Hexagen sync.

Record: `{ questionId, revision, askedBy, title, body, options: [{ id, label, consequence }], recommendation:
{ optionId, because }, doorKind: 'one-way' | 'two-way', linkedRequestId?, blocks: [{ kind, ref }], state:
'open' | 'answered' | 'rejected' | 'expired' | 'acknowledged', askedAt, expiresAt?, answer?, acknowledgement? }`.

- `doorKind` defaults to `one-way` unless the asker explicitly declares `two-way`. Door kind changes only
  the UI flow; it never changes what an answer authorizes (nothing, see 2).
- A **one-way** question must carry `linkedRequestId`: an existing `action-decision` or `policy-proposal`
  request the orchestrator already recorded. The question is the readable presentation of that request.
- Bounds and secrets: title ≤ 200 chars, body ≤ 8 KiB, each option ≤ 1 KiB, answer text ≤ 4 KiB, 32 KiB per
  record. Body, options, recommendation, answer text and reject reason are scanned with the secret patterns;
  a hit refuses, it never redacts. The patterns move to a new `@fleet/shared` package (already allowed by
  the linter), imported by brief-knowledge and operator-coordination, with brief-knowledge's tests kept.
- Clock values come from the composition root, never from a request body.

### 2. Answers carry no authority

Answer shapes: `accept` (the recommendation), `reject` (optional reason), `answer` (another option id or
bounded text). Each records `questionRevision`; an answer to an older revision is refused. Idempotent on
`(questionId, questionRevision)`.

- **Two-way questions:** the answer is recorded and that is all. It is advice the orchestrator follows; it
  grants nothing, and no authorization use case can read it.
- **One-way questions:** the authority stays exactly where it is today: the owner's signed decision file for
  `linkedRequestId`, verified by the existing verifier and checked again by `CheckOwnerDecisionPort` at
  forge and acceptance time. The UI shows the canonical decision bytes and the target file path for the
  owner to sign outside fleet-v2 (as today). The question moves to `answered` only when
  `DecisionTransportAdapter` reports a verified decision for that request: `approved` maps to `accept`,
  `declined` to `reject`. Free text on a one-way question is recorded as advice beside it, never as
  authority. No new canonical form, no new key type, no signing command in fleet-v2 in this plan.

### 3. Bubbling up to the orchestrator

- `GET /v1/questions?state=…&since=…`, `GET /v1/questions/:id`.
- CLI `fleet-v2 questions ask --file q.json | list | show <id> | wait <id> [--max 30m]`. `wait` polls every
  15 s up to `--max`; exit 0 answered, 1 rejected or expired (the JSON body says which), 2 usage.
- `fleet-v2 questions acknowledge <id>` records that the orchestrator acted on the answer; only the
  orchestrator's own composition writes it, never the answer path.
- The MCP plan's `fleet_ask_owner` / `fleet_wait_for_answer` call the same routes.

### 4. Web

- A **Questions** entry in the main navigation with an open-count badge, fed by `GET /v1/questions`.
- Question page: title, body, options and consequences, recommendation and reason, what it blocks, door
  kind. Two-way: **Accept recommendation**, **Reject**, **Answer differently**, each through `AlertBox`
  stating what it does (records an answer; unblocks the named items), what it does not do (no dispatch,
  merge, acceptance or deployment; grants nothing) and, until Q3 is deployed, that no live route exists.
  One-way: the canonical bytes, the decision file path and the state of the linked request; no button
  records authority.
- **The web's first write route.** A Next.js route handler (server side) attaches the `/v1` token for
  `POST /v1/questions/:id/answers`. It enforces same origin (`Origin` equals the app origin and
  `Sec-Fetch-Site: same-origin`), a per-browser session obtained the way the settings plan's U3 does, a body
  cap, and idempotency; it records `answeredVia: 'web'` with the session id. Nothing else is writable from
  the browser. It is a separate handler from the settings plan's fixed six-route setup proxy (U3), which stays
  setup-mode only; Q5 runs in a different wave from settings U4–U6 because both edit `apps/web`.

## Lanes

| # | Lane | Edits | Depends on | Review |
|---|---|---|---|---|
| Q0 | `@fleet/shared` with the secret patterns; brief-knowledge imports them, tests kept | shared (new), brief-knowledge | — | F |
| Q1a | `OwnerQuestion` aggregate, records, repository port and adapter, manifest, ownership registry, sync | operator-coordination, `.architecture` | Q0 | F |
| Q1b | ask, answer, expire, acknowledge use cases; revision and idempotency rules; one-way linkage to `DecisionTransportAdapter` results | operator-coordination | Q1a | F |
| Q2 | CLI `questions ask|list|show|wait|acknowledge` | apps/cli | Q1b | O |
| Q3 | API `GET/POST /v1/questions…` | apps/api | Q1b | F |
| Q4 | Web Questions view and badge, read path | apps/web | Q3 | O |
| Q5 | Web write route (same origin, session, idempotency) and answer flow with `AlertBox` | apps/web, packages/ui | Q4, settings U3 | F |
| Q6 | Runbook section | docs | Q5 | O |

Waves: Q0 → Q1a → Q1b → Q2 and Q3 together (different apps) → Q4 → Q5 → Q6.

## Hard to undo

- The `OwnerQuestion` record shape persists in state directories.
- `@fleet/shared` becomes the shared kernel the layer rules allow; later moves are cheap but visible.
- The web gains its first write route; its same-origin and session rules become the pattern for later ones.

## Assumptions

- The owner keeps signing decision files outside fleet-v2, as today.
- The orchestrator declares `two-way` only for genuinely reversible choices; a wrong declaration still
  grants nothing (section 2).

## Open questions for the owner

1. A signing command inside fleet-v2 (owner private key file, mode 600) to make one-way answers one step
   shorter? Recommendation: not now; keep signing out of fleet-v2.
2. Should expired two-way questions fall back to the recommendation? Recommendation: no; they stay blocking
   and are re-asked.

## Challenge this

Whether two-way answers through the web write route are safe enough, given they steer the orchestrator on
reversible choices without a signature.

## Review

- Revision 1, 2026-10-16: Grok not ready (asker-chosen door kind; UI answer not an owner decision under the
  verifier; nonexistent sign command; poor fit as a coordination kind). Fable not ready (seven blockers:
  wrong premise; answer could become forge authority via scope-only resolution; separate aggregate; verifier
  has no slot for answers; signing key handling; no web write boundary; secret patterns have no home).
  Revision 2 adopts Fable's design: questions are their own aggregate and grant nothing; one-way questions
  present an existing request and are answered by the existing signed decision.
