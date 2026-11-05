/**
 * Q4b: the `fast-check` property over `AdvanceLaneRunUseCase.advanceLaneRun`
 * (plan §4.4, second property). For any generated sequence of port outcomes,
 * once a one-way step key is settled — the journal holds a `result` entry for
 * it whose outcome is final (`ambiguous` is the only non-final outcome) — the
 * conductor performs no further act under that key: no new journal entry, and
 * no further call of the acting port. The fixture holds exactly one attempt
 * and one dispatch key, so a single dispatch-call counter covers property (b).
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

function hasSettledDispatchKey(settled: ReadonlySet<string>): boolean {
  for (const key of settled) {
    const parsed = parseLaneRunKey(key);
    if (parsed !== null && parsed.kind === 'step' && parsed.step === 'dispatch') {
      return true;
    }
  }
  return false;
}

describe('Q4b: a one-way key is never acted on twice', () => {
  it('a settled one-way key gets no second act', async () => {
    await fc.assert(
      fc.asyncProperty(portOutcomeSequenceArb, async (outcomes) => {
        const scenario = await makeLaneRunScenario(outcomes);
        for (let pass = 0; pass < 4; pass += 1) {
          const before = await scenario.journal();
          const settled = settledOneWayKeys(before);
          const callsBefore = scenario.dispatchCalls();
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
          // (b) the dispatch port is not called again once the dispatch key is settled
          if (hasSettledDispatchKey(settled)) {
            expect(scenario.dispatchCalls()).toBe(callsBefore);
          }
        }
      }),
      { numRuns: 25 },
    );
  });
});
