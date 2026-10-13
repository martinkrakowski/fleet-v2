# Knowledge pipeline review

*Date: 2026-10-13 · Read-only review of `2026-10-13_knowledge-pipeline.md` (draft, not adopted)*

## 1. Dropped behaviour or misclassified code

No current fleet behaviour is dropped. `stash` is preserved as a create-and-read
adapter, failed publish does not block accepting the attempt's commit, and the
unadopted lane-notes draft is explicitly not adopted. Wiki, CodeGraph and a
database backend are deferred, not replaced.

Two installation/history details drift into a product-context plan: the named
seats (GLM lane, Luna review) and the named TencentDB backend. Architecture
keeps seat choices and private infrastructure outside reusable product code.
They are illustrative here, but a planning doc for this context should not
anchor them.

## 2. Hosts, secrets, policy history

Clean. No hosts or paths. Secrets, credentials and client content are refused
outright; policy changes are refused as keepers; L3 explicitly does not become
policy and rule changes are logged outside this context. Ingestion requires an
ended session on the owning server, matching the unknown-is-not-ended rule.

## 3. Order

Partially safe. Starting after migration steps 1–3 is correct for collection:
attempt identity, ended-session reporting and recovery exist, and unknown
outcomes cannot leak in. But the first slice includes disposition, which
includes `accept`. Acceptance creates keepers whose provenance requires
verification status and a checker, and exact-head verification and independent
review are migration step 4. Keepers accepted on the strength of steps 1–3
alone would carry evidence the assembly line cannot yet bind to an exact head.
Collection and candidacy after step 3 is safe; promotion should wait for step 4.

## 4. Untaken one-way doors

- The "later export" of an approved, revision-pinned bundle into the lane
  worktree. The text promises it does not open a lane-to-shelf network path,
  but it still delivers shelf content to a lane, which the trust boundary
  currently forbids outright. That is a boundary change the owner has not taken.
- The named TencentDB backend. Naming a vendor in the product plan pre-decides
  an installation choice the owner has not made, even hedged as "optional".
- Disposition-to-accept in the first slice (see §3): once keepers exist with
  weak provenance, superseding them later does not undo briefs already built
  on them.

## Verdict

**Revise.**

Changes (at most three):

1. Split the first slice: lane-notes file, candidates and lexical proposal
   after migration step 3; keeper acceptance only after step 4 binds evidence
   to an exact head.
2. Remove the lane-worktree bundle export from this plan; it needs an explicit
   owner decision on the lane trust boundary before it is written down as a
   future path.
3. Drop seat names and the TencentDB name; keep vendor, seat and host choices
   as installation decisions recorded outside this context.
