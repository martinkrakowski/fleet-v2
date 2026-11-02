# Plan: merge acceleration, a speculative batched merge train

- **Date:** 2026-11-02
- **Target repository:** `fleet-v2`, with the running train in the private orchestrator repository until cutover.
- **Status:** rev 0, written from the owner's design. The owner asked for it to be deployed at once, so no independent review preceded the first lane. A review of this plan runs before MC5.
- **Principle:** merging stays serial; proving future merges does not have to be.

## 1. Problem

Each PR to a base merges alone, after re-running the gate on the base's latest state. Measured on 2026-11-01/02 over 44 merges: 10 min from head of train to merge, a median gate of 5.1 min (4.4 to 9.7), queue entry to merge of 10.3 min median and 30.4 min p90, and 77% of sampled merges needing a branch update. Each merge makes the next PR stale, so running more CI jobs side by side does not help on its own. The train needs to reason about the base's future state.

Two mechanisms solve two different problems:

- **Batching** reduces the full gates per merged PR.
- **Speculation** overlaps the gates of successive batches, while each batch is still validated against what lands ahead of it.

## 2. Guarantees

1. Every PR keeps its own approval, review and required checks.
2. Every promoted commit has integration evidence for that exact repository state.
3. Each base branch has one promotion sequence, however many validation jobs run.
4. Turning this off needs no reset, force-push or history repair. Single-PR mode stays available.

## 3. Speculative batches

```
B0 = base@sha0
C1 = merge(B0, PR1..PR4)
C2 = merge(C1, PR5..PR8)
C3 = merge(C2, PR9..PR12)
```

All candidates may run at once, because each contains everything ahead of it. Promotion is in order: promote C1, confirm the base is exactly C1, then C2's evidence holds, and so on.

If C1 fails or changes, every descendant's evidence is void and the chain is rebuilt from the new expected state.

**Promotion preserves identity.** The exact tested commit is promoted, by a compare-and-swap against the expected base SHA. If the forge's merge produces a different commit, the train proves the tree and CI inputs are equivalent or verifies again. A green status from a different integration result is never reused.

## 4. Admission

| Change | Policy |
|---|---|
| Independent features, different modules | Prefer together |
| Same files with overlapping edits | Separate, or inspect for conflicts |
| Dependency upgrades, lockfiles | Smaller batch |
| Database migrations | Smaller batch or alone |
| CI workflows, branch protection, security, release infrastructure | Alone |

File compatibility is a scheduling heuristic, never proof. The combined gate decides.

Starting values, to be tuned from data: at most 4 PRs per batch, a desired minimum of 2, a 90 s collection wait, 2 batches of speculative depth, strict first-in first-out promotion, and recursive failure isolation. A quiet repository does not wait to fill a batch.

## 5. Failure handling

| Failure | Response |
|---|---|
| Infrastructure: runner lost, provider outage, CI timeout | Retry the same candidate. Never split |
| One PR breaks | Split, find it, keep order, let the good PRs proceed |
| Interaction: each half passes, the whole fails | Validate the real sequence, as below |

```
[1,2,3,4] on B0   FAIL
[1,2]     on B0   PASS, promote, base is B1
[3,4]     on B1   FAIL
[3]       on B1   PASS, promote, base is B2
[4]       on B2   PASS, promote
```

The second half is tested against the base that contains the first half. Diagnostic runs may go concurrently, but independent green results never prove their combination. A failed PR gets a specific blocked disposition and stays available for remediation.

## 6. Architecture

A new bounded context, `packages/merge-coordination`.

**Domain:** per-repository and per-base queue, admission, batch formation, candidate chains, validation lifecycle, failure isolation, ordered promotion, reconciliation.

**Ports:** `MergeTrainStatePort`, `ForgeQueuePort`, `CandidateBuilderPort`, `GateExecutionPort`, `CandidatePromotionPort`, `TrainEventPort`.

**Authority:** `work-execution` keeps work orders, attempts and forge actions. `evidence-and-acceptance` keeps verification and review evidence. This context consumes acceptance decisions and never invents another approval path.

**States:** `waiting`, `eligible`, `batched`, `candidate-built`, `validating`, `splitting`, `ready-to-promote`, `promoting`, `invalidated`, `landed`. Every transition is durable and idempotent. A restarted worker resumes from recorded evidence, not from assumptions about the forge.

**Records:** Train (repository, base, generation, current SHA); QueueEntry (PR, exact head, eligibility); Batch (ordered members with heads); Candidate (base, result, parent); GateReceipt (exact SHA, profile, result); PromotionReceipt (previous SHA, promoted SHA, members).

**One writer.** A per-repository, per-base lease with a fencing token. A stale worker cannot promote after another has taken over. Self-hosted starts on the existing file state; hosted uses a transactional store with an append-only journal and outbox behind the same port.

**Two layers, no global lock.** Merge coordination is per repository and base. The execution scheduler is installation-wide: runner placement, gate slots, quotas and fair admission. One tenant's base never waits for another's merge, though shared capacity can slow its gates; that is a scheduler concern. No repository may take every speculative slot.

## 7. Expected throughput

At a 10-minute gate, with no failures: 6 PRs an hour singly, 24 with batches of four, and a theoretical 72 with three concurrent full gates. These are ceilings, not forecasts. On a saturated runner pool, speculation only adds waiting jobs.

Track: gates per landed PR, first-attempt batch pass rate, split depth, invalidation rate, eligibility-to-landing time, CI slot use, per-project queue wait, fairness across projects, and integration failures after landing. The merge rate is not optimised at the expense of the last one.

## 8. Decisions

| # | Decision | Default | Owner |
|---|---|---|---|
| D-MC1 | Sonar | Stays a per-PR admission requirement. Analysis of the combined candidate is advisory until its behaviour is proven | Applied as default |
| D-MC2 | Forge-native merge queues | Build our own, because they need an organisation-owned repository and we need other forges later. An adapter may use a native queue where one exists | Moving the repository to an organisation is the owner's call, and is not assumed here |

## 9. Lanes

| Lane | What | Where | Tier | After |
|---|---|---|---|---|
| MC1 | Context scaffold, records and pure state machine | manifest, `merge-coordination` | 2 | none |
| MC2 | Batch formation and admission policy, pure | domain | 2 | MC1 |
| MC3 | Candidate chain and invalidation, pure | domain | 2 | MC1 |
| MC4 | Failure classification and isolation plan, pure | domain | 2 | MC1 |
| MC5 | Ports, file state, lease and fencing, event journal | application, infrastructure | 2 | MC2–4 |
| MC6 | Promotion use case: compare-and-swap, exact SHA, reconcile | application | 2 | MC5 |
| MC7 | Forge, git and gate adapters | infrastructure | 2 | MC6 |
| MC8 | `fleet-v2 train` commands and a shadow mode beside the running train | apps/cli | 2 | MC7 |
| MC9 | Metrics of §7 | telemetry | 1 | MC8 |
| MC10 | Scheduler integration: per-project slot budgets | work-execution, installation | 2 | MC8 |

**The running train, in parallel, because it brings the speed soonest:**

| Step | What | State |
|---|---|---|
| TR1 | Batches behind the off-by-default switch | PR open; needs a token scope because it changes CI |
| TR2 | Infrastructure failures retry and never split | To brief |
| TR3 | Split by the real sequence of §5 | To brief |
| TR4 | One speculative descendant | To brief |

## 10. Rollout

| Stage | Deliverable | Exit condition |
|---|---|---|
| 1 | Batches, single promotion | Four PRs validated and landed as one unit, at size 2 and then 4 |
| 2 | Failure isolation | A planted failure isolates with no good PR lost |
| 3 | Speculation | Two future batches validated with no redundant gates; one descendant first, then more by observed pass rate |
| 4 | Coordinator in fleet-v2, scheduler | Shadow agrees with the running train, independent trains, fair capacity, restart recovery |

Canaries use exact-SHA checks and a deliberately planted interaction failure.

## 11. Risks

- **A green candidate that lands as something else.** Guarded by §3's identity rule.
- **Speculation wasting capacity.** Invalidation discards gate runs, so depth grows only with the observed pass rate.
- **Two trains during migration.** Only one holds promotion at any time. Shadow mode decides and records, and does not write to the forge.
- **Review time.** Batching does not shorten it. Waiting on threads and premerge stays outside this plan's speedup.
