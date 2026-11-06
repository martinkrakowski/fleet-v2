/**
 * Q4b: the `fast-check` property over `AdvanceLaneRunUseCase.advanceLaneRun`
 * (plan §4.4, second property). For any generated sequence of port outcomes,
 * once a one-way step key is settled — the journal holds a `result` entry for
 * it whose outcome is final (`ambiguous` is the only non-final outcome) — the
 * conductor performs no further act under that key: no new journal entry, and
 * no further call of the acting port. Every one-way step's act is counted:
 * prepare (its intent append through the journal), dispatch
 * (`DispatchAttemptPort`), the forge (`ExecuteAuthorizedForgeActionPort`,
 * the acting port of `open-pr` and `push`) and merge (`AutoMergeAttemptPort`),
 * so a duplicate act after a settled result fails the property with or
 * without a new journal entry. The open-pr/push/merge steps are exercised by
 * seeded scenarios that place the run into `opening-pr`, `pushing` or
 * `merging` with the step's key already settled — the states the random
 * pipeline never reaches because it parks before those acts.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import {
  buildLaneRunStepKey,
  laneRunPremergeKey,
  parseLaneRunKey,
} from '../../../domain/lane-run-keys.js';
import { LANE_RUN_ONE_WAY_STEPS } from '../../../domain/lane-run-records.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import type { AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import {
  AdvanceLaneRunUseCase,
  type AdvanceLaneRunDependencies,
} from '../AdvanceLaneRunUseCase.use-case.js';
import {
  FakePortThrowError,
  makeLaneRunScenario,
  portOutcomeSequenceArb,
  RUN_ID,
  type LaneRunScenario,
} from './lane-run-property-generators.js';

const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const HEAD12 = 'a'.repeat(12);
const MOVED_COMMIT = 'b'.repeat(40);

function settledOneWayKeys(entries: readonly LaneRunJournalEntryRecord[]): Set<string> {
  const settled = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step') {
      continue;
    }
    if (!(LANE_RUN_ONE_WAY_STEPS as readonly string[]).includes(parsed.step)) {
      continue;
    }
    settled.add(entry.key);
  }
  return settled;
}

/** The distinct one-way steps of the settled keys. */
function settledOneWaySteps(settled: ReadonlySet<string>): Set<string> {
  const steps = new Set<string>();
  for (const key of settled) {
    const parsed = parseLaneRunKey(key);
    if (parsed !== null && parsed.kind === 'step') {
      steps.add(parsed.step);
    }
  }
  return steps;
}

/**
 * The acting-port counter each one-way step maps to: `prepare` counts its
 * intent append through the journal (`scenario.prepareCalls`), `dispatch`
 * calls `DispatchAttemptPort`, `open-pr` and `push` both act through the forge
 * (`ExecuteAuthorizedForgeActionPort`), and `merge` acts through
 * `AutoMergeAttemptPort`. A settled key whose step has a counter refuses any
 * further call of that port — a duplicate act without a new journal entry
 * still fails the property.
 */
function actingPortCallsOf(
  step: string,
  scenario: LaneRunScenario,
): (() => number) | null {
  if (step === 'prepare') {
    return scenario.prepareCalls;
  }
  if (step === 'dispatch') {
    return scenario.dispatchCalls;
  }
  if (step === 'open-pr' || step === 'push') {
    return scenario.forgeActionCalls;
  }
  if (step === 'merge') {
    return scenario.mergeCalls;
  }
  return null;
}

/** Append a settled intent + final result under `key`. */
async function appendSettledStep(
  scenario: LaneRunScenario,
  key: string,
  reasonCode: LaneRunResultReasonCode,
): Promise<void> {
  const journal = scenario.deps.runJournal;
  const intent = await journal.append(
    laneRunIntentEntry(scenario.deps.newUlid(), RUN_ID, key, null, NOW),
  );
  if (intent.outcome !== 'appended') {
    throw new Error('seed: the step intent was not appended');
  }
  const result = await journal.append(
    laneRunResultEntry(scenario.deps.newUlid(), RUN_ID, key, 'completed', reasonCode, NOW),
  );
  if (result.outcome !== 'appended') {
    throw new Error('seed: the step result was not appended');
  }
}

/**
 * Put the run into `opening-pr`, `pushing` or `merging` with the step's key
 * already settled: the attempt is collected at the lane head, acceptance at
 * the head is settled, the merge case also settles the premerge post at the
 * head (KS7a-2), and a single conduct entry projects the target state. The
 * decider then decides the one-way act on that spent key, so the pass must
 * perform no second act. Returns the settled step key.
 */
async function seedSettledOneWayStep(
  scenario: LaneRunScenario,
  step: 'open-pr' | 'push' | 'merge',
): Promise<string> {
  const attemptId = 'attempt-example-1';
  const stored = await scenario.deps.attemptRepo.findAttemptById(attemptId);
  if (stored === null) {
    throw new Error('seed: the attempt record is missing');
  }
  await scenario.deps.attemptRepo.saveAttempt({
    ...stored,
    state: 'collected',
    artifacts: {
      headCommit: COMMIT,
      commitsSinceBase: [COMMIT],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    revision: (stored.revision ?? 0) + 1,
  });

  const acceptBuilt = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'accept',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: HEAD12,
    retry: null,
  });
  if (!acceptBuilt.ok) {
    throw new Error('seed: the accept key must build');
  }
  await appendSettledStep(scenario, acceptBuilt.key, 'accepted');

  let conduct: 'opening-pr' | 'pushing' | 'merging';
  let stepKey: string;
  if (step === 'open-pr') {
    conduct = 'opening-pr';
    const built = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'open-pr',
      seatIndex: 0,
      attemptOrdinal: null,
      head12: HEAD12,
      retry: null,
    });
    if (!built.ok) {
      throw new Error('seed: the open-pr key must build');
    }
    stepKey = built.key;
    await appendSettledStep(scenario, stepKey, 'pr-opened');
  } else if (step === 'push') {
    conduct = 'pushing';
    const built = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'push',
      seatIndex: 0,
      attemptOrdinal: null,
      head12: HEAD12,
      retry: null,
    });
    if (!built.ok) {
      throw new Error('seed: the push key must build');
    }
    stepKey = built.key;
    await appendSettledStep(scenario, stepKey, 'pushed');
  } else {
    conduct = 'merging';
    const premerge = laneRunPremergeKey(RUN_ID, 0, HEAD12);
    if (!premerge.ok) {
      throw new Error('seed: the premerge key must build');
    }
    await appendSettledStep(scenario, premerge.key, 'premerge-success');
    const built = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'merge',
      seatIndex: 0,
      attemptOrdinal: null,
      head12: HEAD12,
      retry: null,
    });
    if (!built.ok) {
      throw new Error('seed: the merge key must build');
    }
    stepKey = built.key;
    await appendSettledStep(scenario, stepKey, 'merged');
  }

  const appendedConduct = await scenario.deps.runJournal.append(
    laneRunConductEntry(scenario.deps.newUlid(), RUN_ID, conduct, NOW),
  );
  if (appendedConduct.outcome !== 'appended') {
    throw new Error('seed: the conduct entry was not appended');
  }
  return stepKey;
}

/** One advance of a seeded scenario; the pushing PR is read from a different head. */
function advanceSeeded(
  scenario: LaneRunScenario,
  step: 'open-pr' | 'push' | 'merge',
): Promise<AdvanceLaneRunResult> {
  const deps: AdvanceLaneRunDependencies =
    step === 'push'
      ? {
          ...scenario.deps,
          forgeRead: {
            readPullRequest: async (): Promise<ReadPullRequestResult> => ({
              outcome: 'found',
              pullRequest: {
                number: 1,
                state: 'open',
                mergeState: 'clean',
                headSha: MOVED_COMMIT,
                headRef: 'wt-example-1',
                baseRef: 'main',
                mergedAtIso: null,
                closedAtIso: null,
                mergeCommitSha: null,
              },
            }),
            isConfigured: () => true,
          },
        }
      : scenario.deps;
  const useCase = new AdvanceLaneRunUseCase(deps);
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
  });
}

describe('Q4b: a one-way key is never acted on twice', () => {
  it('a settled one-way key gets no second act', async () => {
    await fc.assert(
      fc.asyncProperty(portOutcomeSequenceArb, async (outcomes) => {
        const scenario = await makeLaneRunScenario(outcomes);
        for (let pass = 0; pass < 4; pass += 1) {
          const before = await scenario.journal();
          const settled = settledOneWayKeys(before);
          // (b) snapshot: each settled one-way step's acting-port call count,
          // taken before the pass, so a duplicate act after settlement — with
          // or without a new journal entry — fails the property.
          const callsBefore = new Map<string, number>();
          for (const step of settledOneWaySteps(settled)) {
            const portCalls = actingPortCallsOf(step, scenario);
            if (portCalls !== null) {
              callsBefore.set(step, portCalls());
            }
          }
          try {
            await scenario.advance();
          } catch (error) {
            // Only the fake ports' throws are exempt: a port throw leaves the
            // act's intent open for the next pass to settle. Any other
            // exception is an application-code defect and must fail loudly.
            if (!(error instanceof FakePortThrowError)) {
              throw error;
            }
          }
          const after = await scenario.journal();
          // (a) no new journal entry under a key that already had a final result
          for (const entry of after.slice(before.length)) {
            if (entry.key !== null && settled.has(entry.key)) {
              throw new Error('a settled one-way key was acted on again');
            }
          }
          // (b) no acting port is called again once its step's key is settled:
          // a duplicate prepare, open-pr, push or merge call without a new
          // journal entry must still fail this property.
          for (const [step, countBefore] of callsBefore) {
            const portCalls = actingPortCallsOf(step, scenario);
            if (portCalls === null) {
              continue;
            }
            expect(portCalls()).toBe(countBefore);
          }
        }
      }),
      { numRuns: 25 },
    );
  });

  it('a settled open-pr, push or merge key gets no second act', async () => {
    for (const step of ['open-pr', 'push', 'merge'] as const) {
      const scenario = await makeLaneRunScenario([], { laterActs: true });
      const settledKey = await seedSettledOneWayStep(scenario, step);
      const before = await scenario.journal();
      const settled = settledOneWayKeys(before);
      expect(settled.has(settledKey)).toBe(true);
      const callsBefore = actingPortCallsOf(step, scenario)!();
      const result = await advanceSeeded(scenario, step);
      // The spent-key guard parks `step-refused <step>` instead of re-acting:
      // the act under the settled key must not run, and its acting port must
      // not be called again.
      expect(result).toMatchObject({
        outcome: 'parked',
        reason: 'step-refused',
        qualifier: step,
      });
      const after = await scenario.journal();
      for (const entry of after.slice(before.length)) {
        if (entry.key !== null && settled.has(entry.key)) {
          throw new Error('a settled one-way key was acted on again');
        }
      }
      expect(actingPortCallsOf(step, scenario)!()).toBe(callsBefore);
    }
  });
});
