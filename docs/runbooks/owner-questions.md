# Runbook: answer owner questions

*Date: 2026-11-28 · Status: tool (CLI and API; web read-only until Q5) · Owner decisions 2026-10-16*

When the orchestrator needs the owner's advice, it records an **owner question** and the owner answers it. The answer is recorded advice: it **grants no authority** — it never approves a forge, merge, acceptance or dispatch action by itself, and it never fires anything. An answer only unblocks; the orchestrator acts.

Two doors exist:

- **Two-way**: the owner's answer is recorded and that is all — advice the orchestrator follows.
- **One-way**: the question is the readable presentation of an already-recorded `CoordinationRequest` (`linkedRequestId`). The web cannot sign and records nothing; the authority stays in the owner's **signed decision file** for that request, verified outside this runbook. The question settles only when `fleet-v2 questions sync` finds a verified decision for the linked request: `approved` maps to `accept`, `declined` to `reject`. Free text on a one-way question is recorded as advice beside it, never as authority.

All commands below take the global `--state-dir <path>` (or `FLEET_STATE_DIR`). Exit codes: `0` completed, `1` refused, rejected, blocked or expired, `2` usage error.

## Answering a two-way question

In the web app (`/questions`), each card shows the title, body, options with their consequences, the recommendation and why, what the question blocks, and the door kind. Until Q5 is deployed there is no answer button on the web; answer with the CLI (the card prints the exact command):

```sh
fleet-v2 questions answer <question-id> --revision <n> --accept
fleet-v2 questions answer <question-id> --revision <n> --reject [--reason <text>]
fleet-v2 questions answer <question-id> --revision <n> --option <id> [--text <text>]
```

Exactly one of `--accept`, `--reject` or `--option <id>` is given: `--accept` takes no `--reason` or `--text`, `--reject` takes an optional `--reason` only, and `--text` answers alongside `--option <id>`.

The Q5 design (not yet deployed) adds the web answer flow: **Accept recommendation**, **Reject** and **Answer differently** buttons, each opening an `AlertBox` that states what the action does (records an answer and unblocks the named items), what it does not do (no dispatch, merge, acceptance or deployment; grants nothing) and that no live route exists until Q5 is deployed. Nothing fires on click alone.

## Answering a one-way question

The question card shows the linked request id and a note that `fleet-v2 questions sync` settles the question once a verified decision exists — nothing more: it does not display the canonical decision bytes, the decision-file path, or the linked request's state. Sign the decision file outside fleet-v2 at `<state-dir>/decisions/<request-id>.json`, then:

```sh
fleet-v2 questions sync
```

`sync` settles every one-way question whose linked request now carries a verified decision. `fleet-v2 questions wait` also syncs on every poll, so a waiting terminal settles itself.

## Lifecycle

```sh
fleet-v2 questions ask --file <path>        # one JSON question record
fleet-v2 questions list [--state open|answered|rejected|expired|acknowledged] [--since <iso-with-zone>]
fleet-v2 questions show <question-id>
fleet-v2 questions wait <question-id> [--max <duration>] [--interval <duration>]
fleet-v2 questions expire
fleet-v2 questions acknowledge <question-id> --by <name>
fleet-v2 questions sync
```

- `--since` must be an ISO timestamp with an explicit zone (e.g. `2026-10-16T08:00:00Z` or `+02:00`).
- `wait` polls (defaulting per the CLI's `--max`/`--interval` durations) and **syncs first on every round**: a one-way question is settled by the signed owner decision its linked request carries, never by the poll. Exit `0` on a terminal answer, `1` on rejected, expired or timeout (the result says which), `2` on a usage error. A timeout fails closed — it is not an answer.
- `acknowledge` records that the orchestrator acted on the answer; only the orchestrator's own composition writes it, never the answer path.

## Through the API

`/v1` routes (bearer token required):

| Operation | Route |
|---|---|
| list | `GET /v1/questions[?state=...&since=...]` |
| show | `GET /v1/questions/:id` (`404` when absent) |
| answer | `POST /v1/questions/:id/answers` |

A refusal is `422` with the reason. `answeredVia` is set server-side from the presented token: a body-supplied `answeredVia` or `sessionId` is deleted, and attribution comes exclusively from the token — a session-minted token records the web surface and its session, everything else the CLI surface.

## Failure rules (all fail closed, never succeed silently)

- **Expired two-way questions** stay blocking and are re-asked; they **never fall back to the recommendation** (owner decision, 2026-10-16).
- **Stale revisions**: an answer naming an older `questionRevision` is refused; answers are idempotent on `(questionId, questionRevision)`.
- **Secret-pattern hits** in the title, body, options, recommendation, answer text or reject reason refuse the record; they are never redacted.
- **One-way answers without a signed decision**: no web or CLI answer settles a one-way question; only a verified decision file for its linked request does.
- **Unreadable `<state-dir>/owner-questions.json`**: the store is quarantined and every command touching it is refused until it is restored — see [recover a state file](recover-a-state-file.md).

## Not this runbook

Signing keys or `coordination sign-decision`, restoring a quarantined state file, or dispatching lanes.
