import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FleetInstallationModel, SeatModel } from '../types.js';
import { validateSeatPolicy, v1FamilyWarnings, underlyingModelFamily } from '../policy.js';
import { loadInstallation } from '../load.js';

function seat(overrides: Partial<SeatModel> & { id: string }): SeatModel {
  return {
    tool: 'opencode',
    model: 'example-provider/example-model',
    roles: ['implementer'],
    costClass: 'plan-quota',
    ...overrides,
  };
}

function installation(
  overrides: Partial<FleetInstallationModel> = {},
): FleetInstallationModel {
  return {
    schemaVersion: 2,
    hosts: Object.create(null),
    ...overrides,
  };
}

describe('underlyingModelFamily (installation copy)', () => {
  it('matches the shared rule across prefixes, variants and suffixes', () => {
    const sameFamily: readonly [string, string][] = [
      ['nvidia/z-ai/glm-5.3-flash', 'openrouter/z-ai/glm-5.3'],
      ['openrouter/z-ai/glm-5.3', 'z-ai/glm-5.3#none'],
      ['opencode/longcat-2.5-preview-free', 'longcat-2.5'],
      ['bare-model', 'bare-model'],
    ];
    for (const [left, right] of sameFamily) {
      expect(underlyingModelFamily(left)).toBe(underlyingModelFamily(right));
    }
    const distinct: readonly [string, string][] = [
      ['claude-sonnet', 'claude-opus'],
      ['glm-5.3', 'glm-5.4'],
      ['gpt-6-luna', 'glm-5.3'],
    ];
    for (const [left, right] of distinct) {
      expect(underlyingModelFamily(left)).not.toBe(underlyingModelFamily(right));
    }
  });
});

describe('validateSeatPolicy', () => {
  it('accepts a policy-clean catalogue', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl', model: 'provider-a/model-a', costClass: 'paid' }),
          seat({ id: 'reviewer', model: 'provider-b/model-b', roles: ['reviewer'] }),
        ],
        chains: {
          implementer: [{ seatId: 'impl' }],
          reviewer: [{ seatId: 'reviewer' }],
        },
      }),
    );
    expect(errors).toEqual([]);
  });

  it('refuses a chain that references an unknown seat', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [seat({ id: 'impl' })],
        chains: { implementer: [{ seatId: 'impl' }, { seatId: 'missing' }] },
      }),
    );
    expect(errors).toContainEqual(
      'chains.implementer[1]: references unknown seat "missing"',
    );
  });

  it('refuses a chain seat that does not hold the chain role', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl' }),
          seat({ id: 'wrong', roles: ['reviewer'] }),
        ],
        chains: { implementer: [{ seatId: 'impl' }, { seatId: 'wrong' }] },
      }),
    );
    expect(errors).toContainEqual(
      'chains.implementer[1]: seat "wrong" does not hold the role "implementer"',
    );
  });

  it('refuses a seat holding implementer and a reviewer role', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [seat({ id: 'both', roles: ['implementer', 'reviewer'] })],
        chains: { implementer: [{ seatId: 'both' }] },
      }),
    );
    expect(errors).toContainEqual(
      'seats.both: a seat must not hold implementer and a reviewer role',
    );
  });

  it('refuses a reviewer sharing the implementer family across providers and variants', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl', model: 'openrouter/z-ai/glm-5.3' }),
          seat({
            id: 'reviewer',
            model: 'nvidia/z-ai/glm-5.3-flash',
            roles: ['reviewer'],
            costClass: 'paid',
          }),
        ],
        chains: {
          implementer: [{ seatId: 'impl' }],
          reviewer: [{ seatId: 'reviewer' }],
        },
      }),
    );
    expect(errors).toContainEqual(
      expect.stringContaining('chains.reviewer: seat "reviewer" shares the implementer'),
    );
  });

  it('refuses a high-risk reviewer sharing any implementer-chain family', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl', model: 'a/m1' }),
          seat({ id: 'impl-fallback', model: 'b/m2' }),
          seat({
            id: 'hr-reviewer',
            model: 'c/m2#high',
            roles: ['high-risk-reviewer'],
            costClass: 'paid',
          }),
        ],
        chains: {
          implementer: [{ seatId: 'impl' }, { seatId: 'impl-fallback' }],
          'high-risk-reviewer': [{ seatId: 'hr-reviewer' }],
        },
      }),
    );
    expect(errors).toContainEqual(
      expect.stringContaining('chains.high-risk-reviewer: seat "hr-reviewer"'),
    );
  });

  it('accepts a free seat beside a paid seat of the same role', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' }),
          seat({ id: 'paid-impl', model: 'b/m2', costClass: 'paid' }),
        ],
        chains: {
          implementer: [{ seatId: 'free-impl' }, { seatId: 'paid-impl' }],
        },
      }),
    );
    expect(errors).toEqual([]);
  });

  it('refuses a free seat that is the only seat of a role', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' }),
          seat({ id: 'reviewer', model: 'b/m2', roles: ['reviewer'] }),
        ],
        chains: {
          implementer: [{ seatId: 'free-impl' }],
          reviewer: [{ seatId: 'reviewer' }],
        },
      }),
    );
    expect(errors).toContainEqual(
      'chains.implementer: the free seat "free-impl" must not be the only seat of the role',
    );
  });

  it('refuses seats matching a forbidden route glob', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl', model: 'provider-a/model-a' }),
          seat({ id: 'blocked', model: 'provider-a/forbidden-model-x' }),
        ],
        chains: { implementer: [{ seatId: 'impl' }, { seatId: 'blocked' }] },
        policy: {
          forbiddenRoutes: [{ tool: 'opencode', modelPattern: 'provider-a/forbidden-*' }],
        },
      }),
    );
    expect(errors).toContainEqual(
      expect.stringContaining(
        'policy.forbiddenRoutes[0]: seat "blocked" matches the forbidden route',
      ),
    );
  });

  it('does not refuse seats of another tool or a non-matching model', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl', model: 'provider-a/model-a' }),
          seat({ id: 'other-tool', tool: 'agy', model: 'provider-a/forbidden-model-x' }),
        ],
        chains: { implementer: [{ seatId: 'impl' }, { seatId: 'other-tool' }] },
        policy: {
          forbiddenRoutes: [{ tool: 'opencode', modelPattern: 'provider-a/forbidden-*' }],
        },
      }),
    );
    expect(errors).toEqual([]);
  });

  it('refuses a non-positive per-lane cost ceiling', () => {
    for (const ceiling of [0, -1]) {
      const errors = validateSeatPolicy(
        installation({
          seats: [seat({ id: 'impl' })],
          chains: { implementer: [{ seatId: 'impl' }] },
          policy: { perLaneCostCeiling: ceiling },
        }),
      );
      expect(errors).toContainEqual('policy.perLaneCostCeiling: must be a positive number');
    }
    const positive = validateSeatPolicy(
      installation({
        seats: [seat({ id: 'impl' })],
        chains: { implementer: [{ seatId: 'impl' }] },
        policy: { perLaneCostCeiling: 1.5 },
      }),
    );
    expect(positive).toEqual([]);
  });
});

describe('loader policy enforcement', () => {
  let tempDir: string;

  const writeV2 = (value: unknown): string => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-policy-'));
    const file = join(tempDir, 'fleet.json');
    writeFileSync(file, JSON.stringify(value));
    return file;
  };

  const cleanup = (): void => {
    rmSync(tempDir, { recursive: true, force: true });
  };

  it('refuses a hand-edited v2 file that violates the policy without any hook', () => {
    const file = writeV2({
      schemaVersion: 2,
      hosts: {
        host: {
          transport: 'local',
          worktreeRoot: '/tmp/wt',
          roles: ['orchestrator', 'lane-runner', 'verifier'],
        },
      },
      seats: [
        seat({ id: 'impl', model: 'openrouter/z-ai/glm-5.3' }),
        seat({
          id: 'reviewer',
          model: 'z-ai/glm-5.3-flash',
          roles: ['reviewer'],
          costClass: 'paid',
        }),
      ],
      chains: {
        implementer: [{ seatId: 'impl' }],
        reviewer: [{ seatId: 'reviewer' }],
      },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors.join('\n')).toContain('shares the implementer');
      }
    } finally {
      cleanup();
    }
  });

  it('warns, but never refuses, a v1 reviewer sharing the implementer family', () => {
    const file = writeV2({
      schemaVersion: 1,
      runner: { agent: 'a', model: 'openrouter/z-ai/glm-5.3' },
      reviewer: { agent: 'b', model: 'nvidia/z-ai/glm-5.3-flash' },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('loaded');
      if (result.status === 'loaded') {
        expect(
          result.warnings.some((warning) =>
            warning.startsWith('policy: v1 reviewer shares the implementer model family'),
          ),
        ).toBe(true);
      }
      const reloaded = loadInstallation({ file, env: {} });
      if (reloaded.status !== 'invalid') {
        expect(v1FamilyWarnings(reloaded.model)).toHaveLength(1);
      }
    } finally {
      cleanup();
    }
  });
});
