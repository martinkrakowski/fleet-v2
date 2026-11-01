# Seam register

A seam invariant is a rule the system must hold across the boundaries between
contexts or between a use case and its adapters — the seams the composition
roots wire. Each row lists one invariant, where the code enforces it, the test
that pins it, and the defect the invariant exists to close. A new invariant is
added in the same PR as its test. The mechanical trigger list for touching seam
files is Q9's (production-quality plan §4.9): this register only records the
invariants and their tests.

| Invariant | Enforced in | Test | Defect |
| --- | --- | --- | --- |
| a conducted attempt always carries its runner host | `packages/work-execution/src/application/use-cases/advance-lane-run/conducted-host.ts`, `packages/work-execution/src/application/use-cases/advance-lane-run/prepare-dispatch.ts` | `packages/work-execution/src/application/use-cases/__tests__/advance-lane-run-conducted-host.test.ts` (the `readVerifiedFrozenManifest`/`manifestVerdictOf`, act-guard and fix-round describes) | KF-8, KF-10 |
| a recorded host must confirm against the installation | `packages/work-execution/src/infrastructure/adapters/ConfirmRecordedHost.ts`, `packages/work-execution/src/infrastructure/adapters/ExecutorForHost.helper.ts` | `packages/work-execution/src/infrastructure/adapters/__tests__/ConfirmRecordedHost.test.ts`, `packages/work-execution/src/infrastructure/adapters/__tests__/recorded-alias-routing.test.ts`, e2e scenario 3 (`apps/cli/src/__tests__/e2e/conducted-start-dispatch.e2e.test.ts`) | KF-8 |
| the frozen model assignment equals the selected seat, agent included | `packages/work-execution/src/domain/seat-selection.ts` (`seatMatchesAssignment`) | `packages/work-execution/src/application/use-cases/__tests__/start-lane-run.test.ts` (tests 2e/2f), `packages/work-execution/src/application/use-cases/__tests__/prepare-brief-validation.test.ts` (runner agent), e2e scenarios 1a/1b | KF-7 |
| every journalled intent gets a result or a park within one pass | `packages/work-execution/src/domain/lane-run-journal.ts` (`laneRunJournalPendingIntent`), `packages/work-execution/src/application/use-cases/advance-lane-run/step-context.ts` | `packages/work-execution/src/domain/__tests__/lane-run-journal.test.ts` (`laneRunJournalPendingIntent`), `packages/work-execution/src/application/use-cases/__tests__/advance-lane-run-crash-resume.test.ts`, e2e scenario 4 (`apps/cli/src/__tests__/e2e/conducted-accept-park.e2e.test.ts`); the property test is Q4a (pending) | KF-9 |
| every read before dispatch goes through the reserved host | `packages/work-execution/src/application/use-cases/advance-lane-run/frozen-manifest.ts` | `packages/work-execution/src/application/use-cases/__tests__/advance-lane-run-dispatch.test.ts` (test 7e), `packages/work-execution/src/application/use-cases/__tests__/advance-lane-run-conducted-host.test.ts` (the `readVerifiedFrozenManifest`/`manifestVerdictOf` describe), e2e scenario 2 | KF-10 |
