# Runbook review: first run, reconcile, runner readiness

*Date: 2026-10-13 · Status: review, read-only · Verdict at end*

Review of `docs/runbooks/first-run-demonstration.md`, `docs/runbooks/reconcile-an-attempt.md` and `docs/runbooks/runner-readiness.md` against `docs/architecture.md`. No source file was edited.

## 1. Dropped behaviour, or installation/history claimed as product

- Current behaviour is preserved where it matters. `reconcile-an-attempt.md` keeps `ocm-run --status` as the live check until the kernel persists intent, and its proof keeps the `--detach` watcher/server semantics of the existing script. `first-run-demonstration.md` explicitly declines live operation. No runbook claims to replace an existing script.
- All three drafts are marked "not a tool · Owner decision: pending". None claims an implemented guarantee, which matches architecture.md: manifest descriptions are requirements, not assertions.
- Minor: the demo and the readiness runbook cite `docs/planning/2026-10-13_product-identity.md` and `docs/planning/2026-10-13_execution-kernel.md`; neither file is present in this tree. Draft status makes this tolerable, but the citations currently point at nothing.

## 2. Hosts, secrets, or policy history pulled into the product

- Secrets: none. No runbook embeds a key, token or credential; `runner-readiness.md` fails the dispatch on any readable credential and keeps the host-side key proxy as the provider boundary. Good.
- Hosts: one violation. `first-run-demonstration.md` names the private workshop host ("midnight"). Architecture.md keeps private hosts, seat choices and operational history outside reusable product code. The same file guards against absolute workshop paths and `installation/` files, so the intent is there; the host name leaks it anyway. The vendor-key anti-example ("a Gemini key in the guest") names a seat choice for no gain; generic wording costs nothing.
- Policy history: none pulled in. Every policy stance is flagged as a pending owner decision rather than recorded as history.

## 3. Is the proposed order safe: identity and recovery before Waves, knowledge promotion, forge

- Yes, in substance. Runner readiness gates dispatch on identity, isolation, credentials and capacity; reconcile handles unknown outcomes without a second dispatch and never releases capacity on unknown state. Both match "persist intent before external actions" and migration steps 1-3.
- Waves is correctly absent: the demo forbids a live Waves token and no runbook integrates decisions.
- Forge is correctly absent: reconcile disclaims merging and pushing and defers them to receipts re-read at the current head.
- One blur: the first-run demo promotes a keeper into the next brief. That is migration step 6 behaviour shown at first-run time, and the file does not state its prerequisites (persisted intent/journal, readiness receipt, steps 2-3) or mark the keeper line as the step-6 slice. Because the demo is simulated and collects notes only after authoritative lane end, the risk is presentational, not operational; but a reader could take the first run as blessing knowledge promotion before checked scope and provenance exist.

## 4. One-way doors the owner has not taken

1. Terminal refusal: "A quota or permission refusal is a terminal refusal, not a return to the queue" (reconcile, step 7). Once journals record refusals as terminal, requeue semantics change recovery and receipts; reversing breaks stored evidence.
2. Silence = "no answer": the demo fixes a standing operator-decision default. If it later became silence-implies-consent, every prior no-answer would be re-read. The default is safe, but it is a policy stance, and policy remains an explicit owner decision in architecture.md.
3. Capacity release bound to "the process group is gone" (reconcile, step 6). This binds journal and receipt semantics to one liveness definition of the existing runner; changing it later rewrites what "ended" means in every stored receipt.

All three sit inside drafts honestly marked "Owner decision: pending"; none is taken, and none should be assumed by implementation.

## Verdict

Revise. 2026-10-13.

Changes:

1. Remove the private host name from `first-run-demonstration.md` (generic "a live workshop host"), and genericize the vendor-key anti-example for the same reason.
2. State the demo's prerequisites (persisted intent/journal and the readiness receipt, migration steps 2-3) and label the keeper-promotion line as the step-6 pilot slice, so the first run cannot be read as knowledge promotion ahead of checked scope and provenance.
3. Take the three one-way-door decisions (terminal refusal, silence = no answer, process-group capacity release) to the owner before any runbook moves from draft to tool.
