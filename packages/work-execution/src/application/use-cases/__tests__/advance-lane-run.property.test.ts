/**
 * Q4a: the `fast-check` property over `AdvanceLaneRunUseCase.advanceLaneRun`
 * (plan §4.4, first property). For any generated sequence of port outcomes
 * (completed, refused, unknown, thrown), after every driver pass either every
 * step-key intent in the run journal has at least one result entry, or the
 * run record is parked — and the record's parked flag always agrees with the
 * journal's last conduct state. A pass whose port call threw leaves the act's
 * intent open; the property asserts the settlement on the next pass that does
 * not throw. Every store is in-memory; no runner, no subprocess, no network.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FakePortThrowError,
  RUN_ID,
  makeLaneRunScenario,
  portOutcomeSequenceArb,
  stepIntentKeysWithoutResult,
} from './lane-run-property-generators.js';

describe('Q4a: the lane-run journal settles every intent within one pass', () => {
  it('every pass either gives the intent it wrote a result or parks the run', async () => {
    await fc.assert(
      fc.asyncProperty(portOutcomeSequenceArb, async (outcomes) => {
        const scenario = await makeLaneRunScenario(outcomes);
        for (let pass = 0; pass < 4; pass += 1) {
          let portThrew = false;
          try {
            await scenario.advance();
          } catch (error) {
            // Only the fake ports' throws are exempted from P1(a): such a throw
            // comes from the dispatch or reconcile port and leaves the act's
            // intent open for the next pass to settle. Any other exception is an
            // application-code defect — it must fail the test loudly instead of
            // being mistaken for a port throw and silently skipping P1(a).
            if (!(error instanceof FakePortThrowError)) {
              throw error;
            }
            portThrew = true;
          }
          const entries = await scenario.journal();
          const record = await scenario.record();
          const unsettled = stepIntentKeysWithoutResult(entries, RUN_ID);
          if (!portThrew) {
            // P1 (a): every step-key intent has a result, or the run is parked.
            // A prior pass whose port threw left its intent open; this
            // non-throwing pass settles it, so the deferred check lands here.
            expect(unsettled.length === 0 || (record?.parked ?? null) !== null).toBe(true);
          }
          // P1 (b): the record's parked flag and the last conduct state agree —
          // the record is parked iff the last conduct entry's state is 'parked'.
          const conducts = entries.filter((entry) => entry.kind === 'conduct');
          const lastConduct = conducts.length === 0 ? null : conducts[conducts.length - 1].state;
          expect(lastConduct === 'parked').toBe((record?.parked ?? null) !== null);
        }
      }),
      { numRuns: 25 },
    );
  });
});
