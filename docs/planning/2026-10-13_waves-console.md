# Waves as the operator console

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

Source: identity reference part 1 §2 and §6; fleet-v2 `docs/architecture.md` (Waves stays external). Decision M4 in the migration plan is still pending: do not fold the Waves repository into fleet-v2.

## Boundary

Waves is an independently usable observation and decision service. Projects publish versioned observations. Signed decisions bind a proposal and a revision. Fleet consumes those contracts through an adapter in `operator-coordination`. A Waves outage must not corrupt an attempt. Silence is not approval.

The console does not receive SSH keys, GitHub credentials, or provider keys. It records decisions. The execution adapter performs authorised actions and writes the receipt back.

Keep `waves/v1` intact. Add a contract when a new resource type appears. Do not disguise a host alert or a relay as a lane with a fake pull request.

Fleet relays, registry alerts (disk, gate budget, a project that stopped pushing), and maintenance procedures are observations. They are not lanes.

## Views

| View | Shows |
|---|---|
| Work | Projects, waves, lanes, attempts, dependencies |
| Attention | Failures, stale observations, disagreements, unresolved decisions |
| Decisions | Exact proposal, scope, evidence, answer, execution receipt |
| Knowledge | Candidates, keepers, contradictions, reuse outcomes |
| Run detail | Frozen brief, model assignment, evidence, cost |

Loop: see a blocked lane, inspect evidence, answer the precise question, the owning controller checks scope and revision and prior use, the authorised action runs, the receipt appears on that view.

Reported facts and derived facts stay distinct. The console does not "correct" another project's status. Session-written state and a signed owner answer stay distinct. A signature proves who answered that text. The controller still checks action, scope, revision, and present conditions.

The web app in fleet-v2 (`apps/web`) is a presentation boundary. It calls `apps/api`. It does not own domain rules and it is not the store for Waves.

## First slice

Read-only: publish one observation for an attempt and read one signed decision. No deploy of the live Waves service. No enrol-key. No token in git. The owner registers a project and holds the token.

## Pending

| Id | Decision |
|---|---|
| W1 | New contract types for relays and host alerts, beside `waves/v1` lane events |
| W2 | Whether the five views are Waves features or fleet-v2 web features fed by the API |
| W3 | No staging deploy until a staging overlay exists. The current Waves deploy script is the live service |
