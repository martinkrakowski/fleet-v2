# Product identity

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

Source: `2026-10-13_fleet-architecture-and-identity.md` (parts 1–3), read 2026-10-13. That file is a proposal. This plan records what fleet-v2 should keep from it. It does not adopt it.

## Identity

Fleet is a barebones assembly line for agentic work:

Approved work → frozen brief → disposable lane → commit → verification → independent review → fixes → authorised merge. Verification, review, and authorised merge bind to the current exact head.

The process persists. Workers are disposable. Memory enters the next brief only when an orchestrator selects it. Waves shows where work is and which decisions are open. Fleet coordinates the line. Neither replaces the other.

This is not a memory product that also runs work. TencentDB's asset model is a borrowed pattern for the knowledge context (provenance, atomic lessons, reviewed promotion, bounded retrieval). Its proxy, agent-centred memory, and management panel are not the blueprint. Fleet would drift if wiki generation, vector infrastructure, or transcript ingestion came before attempt identity and recovery.

## One product, separate ownership

| Piece | Owns | Does not own |
|---|---|---|
| Fleet runtime | Attempts, capacity, journals, receipts, recovery | A project's interpretation of its evidence |
| Project orchestrator | Briefs, proposed next actions | Forge, unless a decision authorises that action |
| Knowledge | Candidates, keepers, provenance, retrieval proposals | Policy. A keeper does not change a rule. |
| Waves | Observations, disagreements, attention, signed decisions, the console | SSH, GitHub, or provider credentials |
| Runner | Execution and the authoritative session status | The decision to dispatch |
| Policy | The policy revision id it consumes | Approved rules and their history, generated summaries |

Waves remains usable without Fleet. Fleet remains usable without the web app. A shared console records decisions. Authorised adapters carry them out.

The open-source tree holds contracts, the CLI, adapters, example profiles, docs, and a synthetic demo. The private installation holds hosts, seats, approved rules and their history, registry, relays, and runtime data; the product consumes only the policy revision id. `midnight`, `twilight`, model names, quotas, and absolute paths are installation values. Markdown stays valid for policy and handovers.

## First-run modes

Same contracts for each:

| Mode | Needs |
|---|---|
| Local demonstration | No provider credential and no remote host |
| Single operator | Local controller, local Waves, one execution host |
| Distributed | Remote execution and verification hosts, shared console |

Proposed commands, not claims about today's `bin/fleet`: `fleet init`, `fleet doctor`, `fleet run`, `fleet reconcile`, `fleet knowledge review`. Draft runbooks, not tools: `docs/runbooks/first-run-demonstration.md`, `docs/runbooks/reconcile-an-attempt.md`.

## What stays a workshop procedure

Until the owner moves a rule, `~/.claude/CLAUDE.md` is the rulebook. The restart, seat order, PR discipline, and "the owner runs sudo" are not reimplemented as silent defaults. The product loads a policy revision id from installation and refuses an action that revision does not allow.

## Measures, once the kernel exists

Track steps to a first meaningful edit, fix-round count, rediscovery of a documented fact, context selected versus context that changed the outcome, wrong turns attributed to memory, review overhead, tokens and cost per completed task, and duplicate or orphaned attempts. A keeper cited in a brief is not by itself a saving.

## Pending decisions

| Id | Decision | Pending because |
|---|---|---|
| P1 | Public repository is fleet-v2, not a scrubbed copy of the fleet workshop history | The owner has not chosen a public release |
| P2 | SQLite for local runtime records; files for large artifacts | A dependency the scaffold does not have |
| P3 | Licence | README: none chosen |
| P4 | Waves and Fleet stay independently versioned, joined by contract | A monorepo is not required for a cohesive line |
