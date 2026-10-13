# Runbook: first-run demonstration

*Date: 2026-10-13 · Status: draft, not a tool · Owner decision: pending*

A local demonstration of the assembly line with no provider credential and no remote host. It is the "Local demonstration" mode in `docs/planning/2026-10-13_product-identity.md`. Do not run this against a live workshop host, a key proxy, or a live Waves token.

## What the demo shows

- One sample project in the repo, with no absolute paths from the workshop.
- Two isolated simulated lanes, different attempt ids, different role profiles.
- An implementer assignment and a reviewer assignment that are not the same model.
- One check that fails on purpose, then a fresh fix attempt. The fix attempt does not resume the first session.
- One scoped operator decision. Silence is left as "no answer" (an owner decision, not settled).
- One notes file captured only after the simulated runner reports the attempt ended.
- One keeper accepted by the orchestrator and proposed for the next brief. One candidate rejected. This line is the migration step-6 pilot slice only; it is not knowledge promotion ahead of checked scope and provenance.
- Stop the controller between reserving capacity and dispatch. Start it again. Reconciliation does not dispatch a second time.

## Prerequisites

The demo assumes the journal and persisted intent from migration steps 2-3, plus the readiness receipt. Without those, this runbook does not apply.

## Proof

Each artifact names its attempt id. The failed check names the commit it ran against. The second dispatch is absent from the journal. No file under `installation/` is required. No network call is made.

## Not this runbook

Onboarding a container, setting a key, deploying Waves, or choosing a licence.
