# Execution kernel review

*Date: 2026-10-13 · Reviewed: `2026-10-13_execution-kernel.md` (draft, not adopted) · Against: `docs/architecture.md`*

## 1. Dropped behaviour, or installation claimed as product

- Architecture step 1 requires typed contracts for brief preparation, runner
  start/inspection, **worktree inspection**, and completed-attempt artifact
  collection. The kernel covers brief preparation (the bind), runner
  start/inspection (the five states), and artifact collection (the completion
  receipt), but has no worktree-inspection contract: readiness checks
  repository, base commit, toolchain, dependencies, brief presence and limits,
  never the state of the worktree itself. Step 1 is claimed but incomplete.
- Steps 2 and 3 are covered in substance: OpenCode through `ocm-run` wraps the
  existing reviewed commands, dispatch/completion/collect must be measured
  before any second backend, and intent persistence, session recording,
  reconciliation before redispatch, and unknown-never-frees-capacity carry the
  journal and recovery proof.
- Misclaimed as product: the model assignment digest is "seat, variant, and
  the named paid fallback." Seat choice and the named fallback are
  installation; architecture.md keeps seat choices outside reusable product
  code. The durable attempt record must not name host seats.

## 2. Hosts, secrets, policy history

- Secrets: safe. The key stays at the host-side proxy, the worker never holds
  it, passing a provider key into a container is prohibited, Substrate's MITM
  gateway is rejected, and control-plane access stays in the controller adapter.
- Hosts: `ocm-run` and "the attempt's port" appear at adapter level only and do
  not enter the domain. Isolation is a runner-declared profile matched before
  dispatch; Kubernetes and Substrate types are excluded. Naming a provider key
  in a planning doc is acceptable; the boundary rule targets reusable product
  code.
- Policy history: the bind carries policy revision, matching the frozen
  manifest, and policy proposals are not memory entries. Nothing pulls policy
  history into the product.

## 3. Order

- Safe. Identity, capacity, receipts and recovery precede Waves, knowledge
  promotion and forge, which matches architecture steps 1–3 before 5–7. The
  receipt gate — nothing downstream until a receipt names the attempt — is the
  right barrier.
- Two cautions. First, the order is cited to `2026-10-13_migrate-fleet.md`,
  which does not exist in this tree; the authority is architecture.md's
  migration sequence. Second, fix rounds are defined here, but fresh fix
  attempts are architecture step 4: defining the attempt concept early is
  sound, dispatching fix attempts must wait for the journal and recovery proof.
  Deferring checkpointing is correct and reversible.

## 4. One-way doors the owner has not taken

- Digest composition. Once digests are recorded per attempt, changing what
  they cover breaks comparability of all recorded evidence.
- Attempt identity and journal schema. "A branch name is not an attempt id"
  plus the attempt/session/slot split become irreversible once journal,
  capacity records and receipts persist against them.
- Runner state taxonomy. The five states bind adapters, receipts and the
  journal; renaming or collapsing them later migrates persisted history.
- Not doors: OpenCode-first with AX/Substrate deferred (the port keeps it
  reversible); rejecting the MITM gateway and the RBAC-less control plane
  (rejections keep options open); the API shape (explicitly deferred).
- The status line honestly marks all of this "Owner decision: pending."

## Verdict

Revise. 2026-10-13.

Changes:

1. Reduce the model assignment digest to the model, variant and fallback as
   bound in the brief manifest; drop host seat naming from the durable record.
2. Cite architecture.md's migration sequence as the order authority (or land
   `2026-10-13_migrate-fleet.md`), and land `docs/runbooks/runner-readiness.md`
   and `docs/runbooks/reconcile-an-attempt.md` — all three are currently
   dangling references treated as authority.
3. Add a worktree-inspection contract to the runner port or readiness scope so
   step 1's typed contracts are complete.
