# Work-execution kernel: migration steps 1 & 2

*Date: 2026-10-14 · Status: in execution (wave 1) · Parent plans: `2026-10-13_migrate-fleet.md` (steps 1–3), `2026-10-13_execution-kernel.md`*

This plan sequences the `work-execution` kernel work for migration steps 1 and 2
of `docs/planning/2026-10-13_migrate-fleet.md`. It follows the kernel's rules:
the durable attempt is not the runner session; unknown is not ended; capacity
is released only on a confirmed end; the journal records intent before the
subprocess.

## Scope fence

- Wave 1 refines **types only**. No adapter gains behaviour, no port is wired
  to a live runner, no host, credential or forge is contacted. Generated
  placeholders keep refusing execution.
- Wave 2 implements use cases and adapters behind the wave 1 contracts. The
  `ocm-run` adapter is the first runner; its endpoint loads from `installation/`
  at the composition root, never from adapter code (decision M2, M3).
- Wave 3 composes the CLI and API roots. The proof of step 2 (M5) is one
  dispatch and one collect on a disposable worktree, no forge action.

## Wave 1 — domain records, entities, value objects, typed ports (this lane)

1. `WorkOrderState`, `AttemptState`, `AttemptOutcome` value objects validate
   membership in the manifest's enum values. `AttemptState.canReleaseCapacity()`
   returns `true` only for `ended | collected | cancelled`.
2. `ModelAssignment`, `ExecutionLimits`, `BriefPackage`, `RunnerObservation`
   value objects validate their props (non-empty strings, positive limits,
   at least one owned path).
3. `execution-records.ts` gains clean serializable records: `WorkOrderRecord`,
   `AttemptKind`, `AttemptRecord`, `CapacityReservationRecord`,
   `ActionJournalEntryRecord`, beside the existing `CommandCompletionReceipt`
   and `CollectedAttemptArtifacts`.
4. `WorkOrder`, `Attempt`, `CapacityReservation`, `ActionJournalEntry` entities
   wrap their records and expose `getId()`, `toRecord()` and invariant methods.
5. Nine inbound ports (`RegisterWorkOrder`, `InspectWorkOrder`,
   `ReserveExecutionCapacity`, `DispatchAttempt`, `ReconcileAttempt`,
   `StopAttempt`, `PrepareFixAttempt`, `RequestAttemptAcceptance`,
   `ExecuteAuthorizedForgeAction`) get discriminated-union request/result
   contracts. `PrepareBriefPackage` and `CollectAttemptArtifacts` stay as
   refined in the earlier station.
6. Outbound ports `WorkOrderRepositoryPort`, `AttemptRepositoryPort`,
   `ExecutionJournalPort` get persistence methods over the records;
   `AcceptanceAssessmentPort`, `ActionAuthorizationPort`,
   `ExecutionObservationPort`, `ForgeActionPort` get typed interfaces so no
   empty `{}` contract remains in the package. Matching adapter stubs reject
   with `Not implemented` errors so `tsc` passes without behaviour.
7. `src/index.ts` re-exports domain, application and infrastructure layers.

Verification (wave 1): `yarn build && yarn typecheck && yarn lint &&
yarn lint:arch && yarn test && yarn sync:check`. No behaviour change; `sync:check`
reports 0 ops.

## Wave 2 — use cases and adapters (next lanes)

Order per the kernel and the migration plan:

1. `ExecutionJournalAdapter` first: durable intent, capacity reservations and
   action receipts (migration step 3's journal lands here as typed
   persistence; step 2's proof may hold capacity in-process until then).
2. `WorkOrderRepositoryAdapter`, `AttemptRepositoryAdapter` over the same
   local transactional store.
3. `ExecutionRunnerAdapter` wrapping `ocm-run` (start, inspect, stop) with
   allow-listed argument arrays; `WorkspaceAdapter` and `AttemptArtifactAdapter`
   over reviewed Git subprocesses and ignored paths.
4. Use cases in dispatch order: `RegisterWorkOrderUseCase`,
   `PrepareBriefPackageUseCase`, `ReserveExecutionCapacityUseCase`,
   `DispatchAttemptUseCase`, `ReconcileAttemptUseCase`,
   `CollectAttemptArtifactsUseCase`, `StopAttemptUseCase`,
   `PrepareFixAttemptUseCase`, `InspectWorkOrderUseCase`.
5. `AcceptanceAssessmentAdapter`, `BriefKnowledgeAdapter`,
   `ActionAuthorizationAdapter`, `ExecutionObservationAdapter` delegate in
   process to the supplier contexts' application ports (OHS mappings in the
   manifest). `ForgeActionAdapter` stays stubbed until migration step 7.

Each adapter is a short lane with `yarn typecheck && yarn lint:arch` plus the
tests for its implemented behaviour.

## Wave 3 — CLI and API composition roots

1. CLI wiring for the step 2 proof: register → prepare brief → reserve →
   dispatch → reconcile → collect, one lane, disposable worktree.
2. API envelope stays `{ operationId, code, result }`; submit work returns an
   operation id with queued/running/blocked states.
3. Installation facts (endpoint, slot counts, reviewer seats) load from
   `installation/` at the roots. Nothing privileged enters package code.

## Risks

- Refining ports must not grant behaviour: a typed contract is not an
  implemented guarantee (manifest constraint). Adapters stay refusing stubs.
- The journal is what makes recovery safe; until wave 2 implements it, unknown
  dispatch outcomes retain their reservation in process memory only, per M6.
- No live dispatch, host administration or forge action is authorized by this
  plan.
