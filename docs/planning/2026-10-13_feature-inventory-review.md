# Fleet feature inventory review

*Date: 2026-10-13 · Read-only review of `docs/planning/2026-10-13_feature-inventory.md` against `docs/architecture.md` · One file, no source edits*

## 1. Dropped behaviour; product vs installation/history

No current behaviour is silently dropped: assembly line, dispatch/reconcile/abort,
capacity, resume limits, verification stands, independent review, exact-head
acceptance, relays, Waves observation, shelf, and the host boundary all have rows,
and every use-case name the inventory cites exists in `.architecture/manifest.yaml`.
Rows carrying operational history are classified as installation rather than
product (lane caps, slot arithmetic, the sunrise-for-Mini stand-in, campaign-foundry
profile, shared test Postgres, seat routing rules), consistent with
architecture.md's "keep operational history outside reusable product code".

Two caveats. First, the M2 installation-vs-product classification is *pending* per
the inventory's own header, yet every such row already leans on it; the
classification is load-bearing and unowned. Second, coverage was checked against
architecture.md and the manifest, not against `/Users/martin/Projects/fleet`
itself, which is not reachable from this worktree.

## 2. Hosts, secrets, policy history pulled into the product

No secrets, credentials, or token material appear. However, the text names private
hosts (twilight, sunrise), a project (campaign-foundry), and seat choices (Fable,
Opus, Gemini, Grok) directly. Each row correctly assigns the *data* to
installation, but the *names* now sit in a product-repo planning document.
Architecture.md keeps private hosts, paths, project registries and seat choices
outside reusable product code; the doc should carry generic roles ("macOS host",
"Linux AVX2 host", "high-risk reviewer seat") with the concrete names in an
installation annex. The sunrise stand-in precedent is stated as installation
history but is written as a rule ("only after ten recorded CI matches") — a
policy the owner has not ratified for v2.

## 3. Order safety

Safe. The plan column matches architecture.md's migration sequence: execution
identity, capacity reservation and recovery in the kernel first; verification and
independent review at step 4; Waves after; knowledge promotion after that; and
forge actions (`ExecuteAuthorizedForgeAction`, push/PR/merge) last with
exact-head and one-way-door checks. Nothing promotes knowledge, Waves, or forge
ahead of the execution kernel. Minor mismatches: the PR-section acceptance check
is filed under execution-kernel rather than acceptance (step 4), and the
`2026-10-13_migrate-fleet.md` ordering document the inventory cites is not
present in this repository, so step references (2, 4, 7, M2–M8) are unverifiable
from where the inventory lives.

## 4. One-way doors the owner has not taken

- **M2 classification** (installation vs product) — pending, yet the whole
  inventory's per-row labelling depends on it.
- **Licence** — pending; correctly deferred, but any external exposure of the
  repo before the choice is effectively one-way.
- **Sunrise standing in for the Mini** — a verification-trust precedent carried
  from history; adopting it in v2 is a door the owner has not opened.
- **Lane-notes draft** — the knowledge rows are built on
  `2026-10-13_lane-notes-file.md`, which the inventory itself marks "not
  adopted". Scheduling knowledge-pipeline stations before that adoption promotes
  an untaken decision.
- **Folding Waves in (M4) and deleting the old fleet repo (M8)** — both one-way;
  both correctly deferred.

## Verdict

**Revise** — 2026-10-13.

Changes (at most three):

1. Replace private host, project, and seat names with generic roles; move the
   concrete names to an installation annex kept in ignored paths.
2. Make the M2 decision explicit (or mark the dependent rows provisional) before
   the inventory is adopted, and gate knowledge-pipeline stations on owner
   adoption of the lane-notes draft.
3. Bring `2026-10-13_migrate-fleet.md` into this repo's planning directory or
   remove the step/M references, so the claimed order is verifiable where the
   inventory lives.
