/**
 * Lane H3a: `CAPACITY_RELEASE_STATES` is exported once, from the domain, and
 * every capacity decision reads that one list. `fleet-v2 hosts remove` needs
 * the same set to decide whether a host still holds work, so a second
 * hand-written copy here would let the two drift.
 */

import { describe, expect, it } from 'vitest';

import { Attempt } from '../entities/Attempt.js';
import {
  ATTEMPT_STATES,
  CAPACITY_RELEASE_STATES,
  AttemptState,
} from '../value-objects/AttemptState.vo.js';
import * as workExecution from '../../index.js';
import type { AttemptRecord } from '../execution-records.js';

function attemptIn(state: AttemptRecord['state']): Attempt {
  return Attempt.fromRecord({
    id: 'att-capacity',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    state,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: 'ses-capacity',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
  });
}

describe('CAPACITY_RELEASE_STATES', () => {
  it('names exactly the states whose attempt releases its slot', () => {
    expect(CAPACITY_RELEASE_STATES).toEqual(['ended', 'collected', 'cancelled']);
  });

  it('is reachable from the package root so other contexts read the same list', () => {
    expect(workExecution.CAPACITY_RELEASE_STATES).toBe(CAPACITY_RELEASE_STATES);
  });

  it('agrees with Attempt.canReleaseCapacity for every attempt state', () => {
    for (const state of ATTEMPT_STATES) {
      expect(attemptIn(state).canReleaseCapacity()).toBe(CAPACITY_RELEASE_STATES.includes(state));
    }
  });

  it('agrees with AttemptState.canReleaseCapacity for every attempt state', () => {
    for (const state of ATTEMPT_STATES) {
      const created = AttemptState.create(state);
      expect(created.success).toBe(true);
      expect(created.value?.canReleaseCapacity()).toBe(CAPACITY_RELEASE_STATES.includes(state));
    }
  });

  it('keeps every non-terminal state holding its reservation, unknown included', () => {
    for (const state of ['intent-recorded', 'dispatching', 'running', 'reconciling', 'blocked']) {
      expect(CAPACITY_RELEASE_STATES).not.toContain(state);
      expect(attemptIn(state as AttemptRecord['state']).canReleaseCapacity()).toBe(false);
    }
  });
});