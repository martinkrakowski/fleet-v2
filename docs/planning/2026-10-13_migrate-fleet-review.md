# Review of 2026-10-13_migrate-fleet.md

*Date: 2026-10-13 · Read-only pass on a fleet-v2 lane · This file does not edit the plan.*

## 1. Mapping table coverage

Almost every current workflow lands in exactly one context, and the "Stays outside"
column is consistently populated. Verified rows: briefs, dispatch, caps, artifact
collection, forge, verification, independent review, lane notes, relays, Waves,
project values/status, host scripts, policy/registry history, external repositories.
`test-db-service.sh`, egress, and the key proxy all appear inside the host-scripts row,
and the four read-only `fleet` actions are distributed across rows.

Gaps. `fleet project onboard` (owner-tty) and the planned `project verify` /
`project decommission` stubs are named in "What exists" but have no row. Onboard is a
real, exercised workflow; decommission is a stub (exit 3), but the table claims to say
where every current piece lands. `fleet worktrees list` is only implicitly covered by
the worktree-inspection port in step 1. These omissions are the main coverage defect.
Nothing is silently routed to two contexts, and the acyclic direction is respected.

## 2. Hosts, secrets, paths, policy history in product code

No step pulls those into reusable product code. M2, the mapping-table "Stays outside"
column, and the risks section explicitly forbid copying `registry/`, `policy.md`, or
`projects/*.values` into packages. Tokens, the Waves token, the shelf key, and lane
models all stay out. Two minor watch items, not violations:

- Step 2's verification names port 4166. For the proof this is a host fact in a plan
  document, but the adapter itself should read the endpoint from `installation/` at
  the composition root (M2), not from adapter code.
- Row 44 says operator-coordination "reads them" (`projects/*.values`) — the row's
  outside-column keeps the files themselves out, so the intent is right; the wording
  should not be read as the product parsing the workshop's files directly.

## 3. First proof: size and order

Right size and right order. Steps 1–2 mirror architecture steps 1–2 exactly: typed
contracts first (placeholders still refusing), then one `ocm-run` adapter, one frozen
brief in, one commit out, one collect, reconcile only by asking `--status`. No forge,
no push, no journal, no Waves — each of those is correctly deferred to a later step.
The plan also gets the sequencing inside step 3 right: journal before shared-host
arbitration, and the risk section forbids starting arbitration first. The proof
carries its own rollback (revert one commit; M8 keeps the shell tools live). One thing
to make explicit: until the journal exists (step 3), the "unknown outcome does not
free capacity" rule can only be enforced by the single CLI process of the proof. That
is fine for one lane on one disposable worktree, but it should be stated so nobody
generalizes step 2's capacity handling.

## 4. One-way doors not yet taken by the owner

- **M8 cutover (per workflow).** Once the owner declares a workflow moved, history
  and live practice split between the workshop and fleet-v2; returning is a migration,
  not a revert. He has not chosen which workflow moves first or what "moved" is
  measured by.
- **M6 capacity precedent.** Recording a cap on `fleet-v2-lanes` — even the
  one-lane proof cap — is the first entry in shared-host arbitration. The plan avoids
  inventing a standing cap, but the proof's cap should be labelled temporary so it
  does not become the default M6 warns about.
- **M4 adapter shape.** Keeping Waves external is the conservative choice, but the
  adapter's contract (silence-is-not-approval, idempotent reads) becomes the API other
  work codes against. Reversing it later means re-proving every consumer.
- **M2/M7 reclassification.** Treating `policy.md` and `registry/` as history the
  product may only cite, with `~/.claude/CLAUDE.md` still the rulebook, is pending
  adoption. Once product code cites revision ids, un-adopting means re-establishing
  the rulebook as sole authority.

Steps 1–7 themselves are reversible (each is one commit); the doors are the M1–M8
adoption at step 0 and the per-workflow cutover after step 7.

## Verdict

**Revise** — 2026-10-13

The plan is architecturally faithful, correctly sequenced, and honest about its own
risks; the mapping-table gaps and the unlabelled proof cap are worth fixing before
adoption, and none of the fixes touch design.

Changes most wanted:

1. Add mapping-table rows for `fleet project onboard` and the `project verify` /
   `project decommission` stubs (even if the answer is "not in the first stations"),
   so "every current piece lands somewhere" is literally true.
2. State that step 2's capacity hold lives only in the proof's single CLI process and
   is superseded by the step-3 journal, and that the proof's one-lane cap on
   `fleet-v2-lanes` is temporary, not a standing cap under M6.
3. Require the dispatch adapter to load its endpoint (port 4166) from `installation/`
   at the composition root rather than from adapter code, keeping M2 true of step 2
   from the first commit.
