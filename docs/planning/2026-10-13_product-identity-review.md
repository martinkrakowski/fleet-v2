# Product identity review

*Date: 2026-10-13 · Reviews: `2026-10-13_product-identity.md` · Against: `docs/architecture.md`*

Read-only review. The plan is a draft, not adopted; this review does not adopt it.

## 1. Dropped or misclaimed behaviour

No current fleet behaviour is dropped. The identity pipeline (approved work → frozen brief → disposable lane → commit → verification → independent review → fixes → authorised merge) matches the behavioural contract in `docs/architecture.md`. Workshop procedures (restart, seat order, PR discipline, owner-runs-sudo) are explicitly kept out of silent defaults, and `midnight`, `twilight`, model names, quotas and absolute paths are named as installation values, so nothing operational is claimed as product code. The commands are correctly marked as proposals, not claims about today's `bin/fleet`.

Two gaps:

- The runbooks `docs/runbooks/first-run-demonstration.md` and `docs/runbooks/reconcile-an-attempt.md` do not exist; `docs/runbooks/` is empty. They are presented as references without being marked as planned.
- The pipeline omits the exact-head binding: architecture.md binds verification, review and authorization to the current exact head before merge. As written, "authorised merge" could be read as a looser flow than the contract requires.

## 2. Hosts, secrets and policy history

Hosts stay installation configuration: the first-run modes describe topology, not code. Secrets stay out: the Waves row explicitly disclaims SSH, GitHub and provider credentials, consistent with lanes never receiving credentials.

Policy is mostly clean. The product loads a policy revision id from installation and refuses disallowed actions, and approved policy is placed in the private installation. One ambiguity: the ownership table row "Policy | Approved rules and their history" sits under the "One product" heading, while only "approved policy" is assigned to the private installation. The word "history" in a product-owned row conflicts with architecture.md's rule that operational history stays outside reusable product code. One sentence fixes it: rules and their history are installation-held; the product consumes only the revision id.

## 3. Order safety

Safe. The plan's drift warning — attempt identity and recovery before wiki generation, vector infrastructure or transcript ingestion — matches the migration sequence in architecture.md: journal and capacity arbitration with proven recovery (step 3) precede Waves integration (step 5), checked lessons and scoped retrieval (step 6) and authorised forge actions (step 7). Knowledge promotion stays gated behind checked scope and provenance via keepers, and `fleet reconcile` is proposed only after the journal exists. No reordering needed.

## 4. One-way doors not taken

- P1, public repository: a true one-way door; publication is irreversible. Not taken.
- P3, licence: a true one-way door; relicensing after adoption is effectively impossible. Not taken.
- P2, SQLite for runtime records: reversible today, hardens into a one-way door once real records exist. Not taken.
- P4, independent versioning joined by contract: cheap now, disruptive later, and interacts with P1. Not taken.

The plan correctly marks all four as pending owner decisions and takes none of them.

## Verdict

**Accept**, dated 2026-10-13, with three changes before adoption:

1. Mark the two runbooks as to-be-written alongside the proposed commands; do not present them as existing.
2. State that approved rules and their history live in the private installation and the product consumes only the policy revision id; align the Policy row with that.
3. Bind verification, review and authorised merge to the current exact head in the identity pipeline.
