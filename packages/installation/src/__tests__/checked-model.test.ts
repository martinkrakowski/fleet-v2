import { describe, expect, it } from 'vitest';

import {
  checkInstallationModel,
  InvalidInstallationError,
  requireValidInstallationModel,
} from '../load.js';
import { deriveInstallationModel } from '../model.js';
import type { FleetInstallation } from '../types.js';

const hosts = {
  here: {
    transport: 'local',
    worktreeRoot: '/tmp/wt',
    roles: ['orchestrator', 'lane-runner', 'verifier'],
    runner: { kind: 'opencode', port: 4166 },
  },
} as const;

function v2(overrides: Partial<FleetInstallation> = {}): FleetInstallation {
  return { schemaVersion: 2, forge: { mode: 'none' }, hosts, ...overrides };
}

const freeImplementer = {
  id: 'free-impl',
  tool: 'opencode',
  model: 'provider-b/free-model',
  roles: ['implementer'],
  costClass: 'free',
} as const;

const paidImplementer = {
  id: 'paid-impl',
  tool: 'opencode',
  model: 'provider-a/glm-5.3',
  roles: ['implementer'],
  costClass: 'paid',
} as const;

describe('checkInstallationModel / requireValidInstallationModel', () => {
  it('accepts a valid v2 installation with a paid implementer', () => {
    const installation = v2({
      seats: [paidImplementer],
      chains: { implementer: [{ seatId: 'paid-impl' }] },
    });
    expect(checkInstallationModel(installation).errors).toEqual([]);
    expect(requireValidInstallationModel(installation)).toEqual(
      deriveInstallationModel(installation).model,
    );
  });

  it('refuses an all-free implementer chain when useFreeSeats is false', () => {
    const installation = v2({
      policy: { useFreeSeats: false },
      seats: [freeImplementer],
      chains: { implementer: [{ seatId: 'free-impl' }] },
    });
    const message =
      'chains.implementer: every seat is free and policy.useFreeSeats is false; add a paid or plan-quota seat';
    expect(checkInstallationModel(installation).errors).toContain(message);
    let threw = false;
    try {
      requireValidInstallationModel(installation);
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(InvalidInstallationError);
      expect((error as InvalidInstallationError).errors).toContain(message);
    }
    expect(threw).toBe(true);
  });

  it('refuses a single free seat as the only seat of a role', () => {
    const installation = v2({
      seats: [freeImplementer],
      chains: { implementer: [{ seatId: 'free-impl' }] },
    });
    const message =
      'chains.implementer: the free seat "free-impl" must not be the only seat of the role';
    expect(checkInstallationModel(installation).errors).toContain(message);
    let threw = false;
    try {
      requireValidInstallationModel(installation);
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(InvalidInstallationError);
      expect((error as InvalidInstallationError).errors).toContain(message);
    }
    expect(threw).toBe(true);
  });

  it('keeps v1 behaviour: warnings only, never an error', () => {
    const installation: FleetInstallation = { schemaVersion: 1 };
    expect(checkInstallationModel(installation).errors).toEqual([]);
    expect(() => requireValidInstallationModel(installation)).not.toThrow();
  });
});
