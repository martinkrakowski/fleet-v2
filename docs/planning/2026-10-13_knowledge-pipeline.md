# Knowledge pipeline

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

Source: identity reference part 1 §5 and parts 2–3; the unadopted lane-notes draft in the fleet workshop (`docs/planning/2026-10-13_lane-notes-file.md`). That draft is not a tool. This plan does not adopt it.

## Lifecycle

```text
Completed attempt
  → lane notes and selected evidence
  → candidate observations
  → orchestrator: reject, leave unresolved, propose a policy change, or accept
  → scoped retrieval
  → proposal for the next brief
  → orchestrator freezes the selection
```

Automatic capture creates candidates. It does not create keepers. A model may suggest lessons from selected artifacts. The project orchestrator disposes of them. The fleet master receives summaries and fleet-relevant proposals, not another project's raw notes or transcripts.

Collection runs only after the runner reports the attempt ended on the server that owns the session. Unknown is not ended.

## Layers

| Layer | Holds |
|---|---|
| L0 | Source artifacts: notes, verification receipts, review references |
| L1 | One scoped claim per lesson |
| L2 | Area context (for example, testing one package) |
| L3 | Links to approved operating profiles |

L3 does not become policy. Changing a rule is an owner decision, logged outside this context.

## Keeper provenance

Claim, project, paths or symbols, source attempt and commit, tool versions where they matter, evidence and who checked it, verification status, created and last-checked dates, entries superseded, briefs that used it, reported wrong turns. A model confidence score is not verification status.

## Retrieval

Start with structured filters and full text: authorised project and shared entries only; drop rejected, superseded, and inapplicable entries; match task, paths, symbols, and environment; rank; cap count, size, and latency; present the proposal with the reason each row was included. Add vectors only after a recorded lookup shows lexical search missing useful notes. No vector service in the first stations.

Repository maps and caller/callee indexes are navigation hints during brief preparation. They are not proof of runtime behaviour.

## Role versus attempt

A stable role profile (implementer, reviewer) is not the attempt. The same project knowledge can inform different seats. They still receive different context and different permissions. Memory belongs to the project and the task, not to a seat. Vendor, seat, and host choices are installation decisions recorded outside this context.

## What this context refuses

- A secret, a credential, or client content.
- A policy or seat change stored as a keeper.
- A note treated as an instruction that overrides the brief, the rulebook, or a current decision.
- Ingestion from a session that has not ended.
- Publishing by the lane. Only the orchestrator publishes.

## Shelf

`stash` remains a create-and-read adapter: no edit, no delete, signed author, no secrets. A failed publish keeps the local candidate and does not block accepting the attempt's commit.

## Order

After migration steps 1–3 have a real attempt id, the first slice is the lane-notes file, candidates, and lexical proposal. Keeper acceptance comes only after migration step 4 binds evidence to an exact head. Wiki, CodeGraph, and a database backend are optional and later. Any database backend, if ever connected, is an adapter behind this context, not a replacement for the assembly line.
