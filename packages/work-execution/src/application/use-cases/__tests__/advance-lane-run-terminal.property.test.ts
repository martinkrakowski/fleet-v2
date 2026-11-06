/**
 * Q4b: the `fast-check`-adjacent property over `AdvanceLaneRunUseCase` (plan
 * §4.4, third property). Once the run's projected state is terminal (`merged`
 * or `stopped`), the conductor never leaves it: every later pass decides
 * `done` and writes nothing — the journal length and the record's revision
 * stay unchanged, and no acting port is called. The transition table itself
 * must have no exit from a terminal state.
 */

import { describe, expect, it } from 'vitest';

import {
  LANE_RUN_EXITS,
  canEnterLaneRunState,
} from '../../../domain/lane-run-transitions.js';
import {
  LANE_RUN_STATES,
  LANE_RUN_TERMINAL_STATES,
} from '../../../domain/value-objects/LaneRunState.vo.js';
import { makeLaneRunScenario } from './lane-run-property-generators.js';

describe('Q4b: a terminal lane-run state is absorbing', () => {
  it('a terminal run does nothing and changes nothing', async () => {
    for (const terminal of ['merged', 'stopped'] as const) {
      const scenario = await makeLaneRunScenario([], { terminalState: terminal });
      const before = await scenario.journal();
      const recordBefore = await scenario.record();
      for (let pass = 0; pass < 3; pass += 1) {
        // A terminal pass calls no acting port: capture every wired port's
        // call count before the pass and refuse any increase after it — a
        // pass that called dispatch (or the forge or merge port) without
        // changing the journal or the record would otherwise pass.
        const callsBefore = [
          scenario.dispatchCalls(),
          scenario.reconcileCalls(),
          scenario.forgeActionCalls(),
          scenario.mergeCalls(),
        ];
        const result = await scenario.advance();
        expect(result).toEqual({ outcome: 'done' });
        expect(scenario.dispatchCalls()).toBe(callsBefore[0]);
        expect(scenario.reconcileCalls()).toBe(callsBefore[1]);
        expect(scenario.forgeActionCalls()).toBe(callsBefore[2]);
        expect(scenario.mergeCalls()).toBe(callsBefore[3]);
      }
      const after = await scenario.journal();
      expect(after.length).toBe(before.length);
      const recordAfter = await scenario.record();
      expect(recordAfter?.revision).toBe(recordBefore?.revision);
      const conducts = after.filter((entry) => entry.kind === 'conduct');
      expect(conducts[conducts.length - 1]?.state).toBe(terminal);
    }
  });

  it('the transition table has no exit from a terminal state', () => {
    for (const terminal of LANE_RUN_TERMINAL_STATES) {
      expect(LANE_RUN_EXITS[terminal]).toEqual([]);
      for (const to of LANE_RUN_STATES) {
        expect(canEnterLaneRunState(terminal, to)).toBe(false);
      }
    }
  });
});
