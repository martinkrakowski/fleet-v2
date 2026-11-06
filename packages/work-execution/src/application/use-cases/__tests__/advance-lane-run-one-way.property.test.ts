/**
 * Q4b: the `fast-check` property over `AdvanceLaneRunUseCase.advanceLaneRun`
 * (plan §4.4, second property). For any generated sequence of port outcomes,
 * once a one-way step key is settled — the journal holds a `result` entry for
 * it whose outcome is final (`ambiguous` is the only non-final outcome) — the
 * conductor performs no further act under that key: no new journal entry, and
 * no further call of the acting port. Each acting port is counted: dispatch
 * (`DispatchAttemptPort`), the forge (`ExecuteAuthorizedForgeActionPort`,
 * the acting port of `open-pr` and `push`) and merge (`AutoMergeAttemptPort`),
 * so a duplicate act after a settled result fails the property with or
 * without a new journal entry.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import { LANE_RUN_ONE_WAY_STEPS } from '../../../domain/lane-run-records.js';
import {
  FakePortThrowError,
  makeLaneRunScenario,
  portOutcomeSequenceArb,
  type LaneRunScenario,
} from './lane-run-property-generators.js';

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
 * The acting-port counter each one-way step maps to: `dispatch` calls
 * `DispatchAttemptPort`, `open-pr` and `push` both act through the forge
 * (`ExecuteAuthorizedForgeActionPort`), and `merge` acts through
 * `AutoMergeAttemptPort`. A settled key whose step has a counter refuses any
 * further call of that port — a duplicate act without a new journal entry
 * still fails the property.
 */
function actingPortCallsOf(
  step: string,
  scenario: LaneRunScenario,
): (() => number) | null {
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
          // a duplicate open-pr, push or merge call without a new journal
          // entry must still fail this property.
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
});
