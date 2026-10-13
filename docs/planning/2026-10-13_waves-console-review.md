# Review: Waves as the operator console

*Date: 2026-10-13 · Reviews: docs/planning/2026-10-13_waves-console.md · Read-only. Source not edited.*

## 1. Dropped behaviour, or installation/history claimed as product

No current fleet behaviour is dropped. Waves stays external (`docs/architecture.md`
product boundary); M4 is not taken. Relays, registry alerts (disk, gate budget,
stopped pushes) and maintenance procedures are classified as observations, not
lanes, and the live Waves deploy script is referenced as history/installation
(W3) rather than absorbed into fleet-v2. `waves/v1` is kept intact. The doc
correctly avoids disguising host alerts as lanes with fake pull requests.

## 2. Hosts, secrets, policy history pulled into the product

Compliant. The console receives no SSH, GitHub or provider keys; no enrol-key;
no token in git; the owner registers the project and holds the token. No host
names, private paths or seat choices enter product code. One caution:
"maintenance procedures are observations" must stay bounded as operational
observations; they must not become a policy-history store inside the product.

## 3. Is the proposed order safe

Mostly, with one gap. The read-only first slice (publish one observation, read
one signed decision, no deploy) is safe at any point because it performs no
authorised action. But the doc does not place itself in the migration
sequence. The Run detail view (frozen brief, model assignment, evidence, cost)
presumes steps 1–4 of `docs/architecture.md` (typed contracts, dispatch/collect,
journal and recovery, exact-head verification), and the Decisions view's
execution receipt presumes step 7 (authorised forge actions with stale-head
rejection). The loop sentence already ends in an authorised action and a
receipt, which is end-state, not first slice. The slice order should be stated
explicitly: observation publish/decision read after step 5, execution receipts
only after step 7 is authorised and proven. Silence is not approval is kept,
which protects against a Waves outage corrupting an attempt.

## 4. One-way doors the owner has not taken

- M4: folding the Waves repository into fleet-v2 — still pending; the doc
  correctly does not take it.
- W1: new contract types for relays and host alerts beside `waves/v1` — a
  public contract surface; once projects publish against it, removal breaks
  consumers. One-way door.
- W2: whether the five views are Waves features or fleet-v2 web features fed by
  the API — placement is expensive to reverse once views are built.
- W3: staging deploy — deployment authority stays with the owner; correctly
  deferred.
- Implicit: the execution adapter performing authorised actions and writing
  receipts assumes forge authority (step 7), which the doc states as fact
  rather than as a pending owner decision.

## Verdict

**Revise** — 2026-10-13.

Three changes:

1. State where the console work sits in the migration sequence: the read-only
   slice after step 5 (integrate existing Waves decisions), and the Decisions
   view's execution receipt only after step 7 (authorised forge actions,
   stale-head rejection proven).
2. Mark W1 as a one-way door: adding relay/host-alert contract types expands
   the published `waves/v1` surface; require an owner decision before any new
   contract type exists, and keep maintenance-procedure observations bounded so
   they never become policy history in the product.
3. Resolve W2 before any view is built; record the chosen owner (Waves or
   fleet-v2 web via the API) so `apps/web` stays a pure presentation boundary
   and views are not migrated later.
