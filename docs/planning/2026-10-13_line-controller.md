# Line controller

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

Source file, in this repository: `docs/planning/2026-10-13_waves-dashboard.html` (124078 bytes, title "Fleet · line controller", copied 2026-10-13 from the desktop draft). An implementer reads that file. This plan does not restate its markup, its CSS, or its fixture records. Guessing the page from the tables below is a failed reading.

The file is one static page with an in-memory `FIXTURE` and a `simulate` function. The stamp says nothing reaches a runner. This plan is how that page becomes `apps/web` talking only to the Nitro API. It does not start a lane.

What to take from the file, and what to leave:

| In the HTML | Use it as |
|---|---|
| The layout, the four views (`viewLine`, `viewAttempt`, `viewBrief`, `viewKnowledge`), and the project strip | The `apps/web` markup. Do not redesign it. |
| `FIXTURE` | The shape of the read model, and the only data behind `?fixture=1` |
| `recomputeLegal` | The rules the API must apply. The browser does not keep this function. |
| `simulate` | Not product code. It is the fixture's stand-in for routes that return 501. |
| Sample project names, the sample port, and the random cost drift | Fixture only. The live page reads projects, slots, and cost from the API. |

## What the draft is

Four views, one project strip, and a 15-second reread:

| View | Shows | Writes |
|---|---|---|
| Line | Attempts grouped by state, five facts, capacity, attention | Reconcile is a reread, not a button that invents facts |
| Attempt | Work order, record, worktree, readiness, receipts, legal operations | Reconcile, stop, collect, fix, merge |
| Brief | Unfrozen work orders, proposed knowledge rows, freeze, then dispatch | Freeze is its own step. Dispatch uses the frozen digest |
| Knowledge | Candidates and keepers in the selected project | Accept, reject, leave unresolved, propose a policy change |

The page computes which buttons are legal (`recomputeLegal`). Unknown stays unknown. A 409 does not upgrade a fact. A 501 stays "not implemented on this station". Every write is one POST with an idempotency key and an operation id, and the receipt is shown. Cost on a live row drifts by a random number. That drift is a fixture. The product must not invent cost.

Sample project names and a sample port are in the fixture. The comment says they are samples, not an installation. The product reads projects and the runner endpoint from the API, which reads `installation/`.

## What is already on the API

`docs/planning/2026-10-13_nitro-api.md` is the route table. As of `main` at `00170f4`, those routes exist and return 501 while the use cases throw `Not implemented`. `GET /` is the process check. The envelope is `{ operationId, code, result }`. `Idempotency-Key` is read on the knowledge routes. Unknown is specified as HTTP 409, not 200.

W2 is still unresolved: whether the five operator views belong to Waves or to this web app. This draft is the Fleet line, not the Waves service. It does not receive a Waves token. Building it in `apps/web` does not decide W2. Waves stays a separate product. The page links to an inbox URL supplied by installation, and does not call Waves itself.

## Gaps the draft already marks

These are the chips that say "gap". They are new API work. They are not a restyle of a 501.

| Draft need | Today | Add |
|---|---|---|
| List the line | `GET /v1/attempts/:id` only | `GET /v1/attempts?project=` returns the attempt summaries for one project. No body that includes a secret or a host path beyond the worktree path the attempt already recorded. |
| Capacity | none | `GET /v1/capacity` returns slots, how many are held, and how many are pending. The port number stays an installation fact. The response may name the slot id. It does not name a provider key. |
| Legal operations | the page decides | `GET /v1/attempts/:id` includes `legal` and `notOffered`. The rules are the ones in the draft: no reconcile without a session, no collect before a completion receipt, no fix unless verification failed on the latest attempt and nothing else on that order is unfinished, no merge without an acceptance receipt at the current head. Unknown never adds stop, collect, or merge. |
| Freeze, then dispatch | both are folded into `POST /v1/attempts` | `POST /v1/work-orders/:id/brief` freezes the selected rows and returns the digest. `POST /v1/attempts` accepts that digest and does not accept a different one. Dispatch stays step 2. Freeze does not start a runner. |
| Knowledge lists | only POSTs | `GET /v1/knowledge/candidates?project=` and `GET /v1/knowledge/keepers?project=`. Disposition stays the existing POST. |
| Completion receipt | `GET /v1/heads/:sha/evidence` is head evidence | The attempt record includes the completion receipt. Head evidence stays on the head route. |
| Unknown outcome | specified, not implemented | `GET /v1/attempts/:id` returns 409 and `attempt.unknown` when the runner cannot be read. The last known facts are in `result` and are marked stale. The slot stays held. |

`POST /v1/attempts/:id/artifacts` stays 501 until migration step 2, and the button stays disabled with that code. `POST /v1/forge` stays 501 until step 7 and an owner grant. The draft's merge simulation looks up a pull request and then merges. The product does not. The button calls `POST /v1/forge` only when `legal` contains `merge`.

## Read model

One attempt summary, which is what the line and the record share:

```text
id, workOrderId, project, kind, number, fixOf,
capacity: pending | held | released,
facts: reachable, prepared, active, ended, collected  // yes | no | unknown
observedAt, observedFrom, stale,
legal: string[], notOffered: { op, reason }[]
```

The record adds the worktree inspection, the readiness lines, the receipts, the brief digest, and the cost as last reported by the runner. The page does not add steps or dollars between reads.

A reread every 15 seconds calls `GET /v1/attempts?project=` and, if a record is open, `GET /v1/attempts/:id`. It does not call reconcile as a write. Reconcile remains `GET` on that id, which is the existing route. The draft's reconcile button is that GET, not a second POST.

## Client

`apps/web` is the only place the page lives. It calls `apps/api` on port 3001. It does not import a domain package. It does not ship the fixture as the live source. A `?fixture=1` mode loads a copy of the draft's records from `apps/web` so the layout can be checked with no API. That mode shows the same stamp the draft shows: fixture, no live host. The default mode hides that stamp and shows the API's `observedFrom`.

Theme, the 15-second countdown, and copy-the-id stay in the browser. They are not routes.

Writes send `Idempotency-Key`. A 409 leaves the facts as the body says. A 501 leaves the button visible and inert, with the code. The client does not retry a 501.

## Steps

| # | Step | Who | Verification |
|---|---|---|---|
| D1 | Add the list, capacity, and knowledge-list routes, and the `legal` / `notOffered` fields on the attempt record. Handlers call use cases and return 501 until the use case exists. | one fleet-v2 lane, `apps/api` only | `yarn typecheck` in `apps/api`. Each new path returns 501. `GET /` still returns ok. |
| D2 | Split freeze from dispatch: `POST /v1/work-orders/:id/brief` then `POST /v1/attempts` with that digest. | one lane after D1 | A dispatch whose digest does not match the frozen brief is 409. Freeze does not create a session. |
| D3 | Build the four views in `apps/web` by following `docs/planning/2026-10-13_waves-dashboard.html`. Wire them to the D1 routes. Fixture mode loads that file's `FIXTURE` and stays behind `?fixture=1`. | one lane, `apps/web` only, after D1's paths exist | The line, the record, the brief, and knowledge match the draft's sections. No request leaves the browser in fixture mode. |
| D4 | Point the default mode at the API. Unknown renders as stale. 501 does not change a fact. | one lane after D3 | A 409 response leaves the previous yes/no facts marked stale. A stopped attempt does not show as a pass. |

D1 and D3 can be sequenced. They must not edit the same files. D2 waits on D1. D4 waits on D3. None of these lanes enables forge, adds a Waves contract, or reads a token.

## What this plan does not do

- It does not decide W2, and it does not move Waves into this repository.
- It does not turn 501 routes into real runner calls. That remains migration steps 2–7.
- It does not copy the draft's `simulate` function into the API. The fixture's random cost drift and the fake merge stay in `?fixture=1` only.
- It does not choose a licence or bind the API past loopback.

## Risks and rollback

- If the page treats a 501 body as a successful observation, a dark route looks like a finished attempt. D4's check is that case.
- Computing `legal` in the browser lets the client offer merge before the API agrees. The buttons follow the API field.
- Rollback of D1–D2 is reverting the API commit. The web app's fixture mode still renders. Rollback of D3–D4 is reverting the web commit. The API is unchanged.

## Review

Not reviewed.
