import { describe, expect, it } from 'vitest';

import {
  deriveInstallationModel,
  isFleetInstallationV2,
  parseInstallation,
  validateSeatPolicy,
  writeInstallationV2,
} from '../index.js';

/** A minimal raw v2 value in the shape of the free-tier tests (S1d). */
function fixture(overrides?: {
  seats?: Record<string, unknown>[];
  chains?: Record<string, unknown>;
  policy?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      host: {
        transport: 'local',
        worktreeRoot: '/tmp/wt',
        roles: ['orchestrator', 'lane-runner', 'verifier'],
        runner: { kind: 'opencode', port: 4166, maxLanes: 1 },
      },
    },
    seats:
      overrides?.seats ??
      [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
    chains:
      overrides?.chains ??
      {
        implementer: [{ seatId: 'impl' }],
        reviewer: [{ seatId: 'rev' }],
      },
    ...(overrides?.policy !== undefined ? { policy: overrides.policy } : {}),
  };
}

function parseV2Fixture(value: unknown) {
  const result = parseInstallation(value);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

describe('seat health and fix chain (S1d)', () => {
  it('parses a seat health into the seat and the derived model', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
          health: 'unhealthy',
        },
      ],
    });
    const installation = parseV2Fixture(raw);
    expect(installation.seats?.[1].health).toBe('unhealthy');
    expect('health' in installation.seats![0]).toBe(false);
    const { model } = deriveInstallationModel(installation);
    expect(model.seats?.[1].health).toBe('unhealthy');
    expect('health' in model.seats![0]).toBe(false);
  });

  it('refuses an unknown health value', () => {
    const raw = fixture({
      seats: [
        {
          id: 'sick',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
          health: 'sick',
        },
      ],
      chains: { implementer: [{ seatId: 'sick' }] },
    });
    const result = parseInstallation(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('seats[0].health: must be healthy or unhealthy');
  });

  it('accepts a fix chain whose seat holds implementer', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'impl-b',
          tool: 'opencode',
          model: 'acme/alpha-2',
          roles: ['implementer'],
          costClass: 'paid',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'impl-b' }],
        reviewer: [{ seatId: 'rev' }],
      },
    });
    const installation = parseV2Fixture(raw);
    const { model } = deriveInstallationModel(installation);
    expect(validateSeatPolicy(model)).toEqual([]);
  });

  it('requires fix chain seats to hold the implementer role', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'rev' }],
        reviewer: [{ seatId: 'rev' }],
      },
    });
    const installation = parseV2Fixture(raw);
    const { model } = deriveInstallationModel(installation);
    expect(validateSeatPolicy(model)).toContain(
      'chains.fix[0]: seat "rev" does not hold the role "implementer"',
    );
  });

  it('reports an unknown seat id in the fix chain', () => {
    const raw = fixture({
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'ghost' }],
        reviewer: [{ seatId: 'rev' }],
      },
    });
    const result = parseInstallation(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('chains.fix[0].seatId: unknown seat');
  });

  it('counts the fix chain as an implementer chain for the family rule', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'fix-b',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['implementer'],
          costClass: 'paid',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-2',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'fix-b' }],
        reviewer: [{ seatId: 'rev' }],
      },
    });
    const installation = parseV2Fixture(raw);
    const { model } = deriveInstallationModel(installation);
    expect(validateSeatPolicy(model)).toContain(
      'chains.reviewer: seat "rev" shares the implementer chain\'s model family (acme/beta-2)',
    );
  });

  it('refuses a fix chain whose only seat is free', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'free-fix',
          tool: 'opencode',
          model: 'acme/alpha-2',
          roles: ['implementer'],
          costClass: 'free',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'free-fix' }],
        reviewer: [{ seatId: 'rev' }],
      },
    });
    const installation = parseV2Fixture(raw);
    const { model } = deriveInstallationModel(installation);
    expect(validateSeatPolicy(model)).toContain(
      'chains.fix: the free seat "free-fix" must not be the only seat of the role',
    );
  });

  it('drops a free-only fix chain when useFreeSeats is false', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
        {
          id: 'free-fix',
          tool: 'opencode',
          model: 'acme/alpha-2',
          roles: ['implementer'],
          costClass: 'free',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'free-fix' }],
        reviewer: [{ seatId: 'rev' }],
      },
      policy: { useFreeSeats: false },
    });
    const installation = parseV2Fixture(raw);
    const outcome = deriveInstallationModel(installation);
    expect(outcome.errors).toContain(
      'chains.fix: every seat is free and policy.useFreeSeats is false; add a paid or plan-quota seat',
    );
  });

  it('round-trips health and fix chains through the writer in order', () => {
    const raw = fixture({
      seats: [
        {
          id: 'impl',
          tool: 'opencode',
          model: 'acme/alpha-1',
          roles: ['implementer'],
          costClass: 'plan-quota',
          health: 'unhealthy',
        },
        {
          id: 'impl-b',
          tool: 'opencode',
          model: 'acme/alpha-2',
          roles: ['implementer'],
          costClass: 'paid',
        },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'acme/beta-1',
          roles: ['reviewer'],
          costClass: 'paid',
        },
        {
          id: 'hrr',
          tool: 'opencode',
          model: 'acme/gamma-1',
          roles: ['high-risk-reviewer'],
          costClass: 'paid',
        },
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        fix: [{ seatId: 'impl-b' }],
        reviewer: [{ seatId: 'rev' }],
        'high-risk-reviewer': [{ seatId: 'hrr' }],
      },
    });
    const installation = parseV2Fixture(raw);
    const written = writeInstallationV2(installation);
    const reparsed = parseInstallation(JSON.parse(written));
    expect(reparsed).toEqual({ ok: true, installation });
    const writtenChains = JSON.parse(written).chains;
    expect(Object.keys(writtenChains)).toEqual([
      'implementer',
      'fix',
      'reviewer',
      'high-risk-reviewer',
    ]);
  });
});
