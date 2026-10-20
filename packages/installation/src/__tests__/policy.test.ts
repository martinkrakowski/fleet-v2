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
      // Every Claude model shares the `claude` vendor-line family, so
      // sonnet vs opus is no longer a distinct pair (owner rule:
      // one family per vendor line); gemini, grok, gpt and glm stay
      // distinct.
      ['gemini-3.1-pro', 'grok-4.7'],
      ['gpt-6-luna', 'glm-5.3'],
      ['claude-opus-5-5', 'glm-5.3'],
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
          seat({ id: 'impl', model: 'provider-a/glm-5.3', costClass: 'paid' }),
          seat({ id: 'reviewer', model: 'provider-b/grok-4.7', roles: ['reviewer'] }),
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

  it('refuses a seat whose model yields an empty model family', () => {
    for (const model of ['', '/', 'z-ai/', '#low']) {
      const errors = validateSeatPolicy(
        installation({
          seats: [seat({ id: 'impl', model })],
          chains: { implementer: [{ seatId: 'impl' }] },
        }),
      );
      expect(errors).toContainEqual(
        `seats.impl: model "${model}" yields an empty model family`,
      );
    }
  });

  it('applies the family rule to reviewer-role seats that are not chain members', () => {
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'impl', model: 'openrouter/z-ai/glm-5.3' }),
          seat({
            id: 'standalone-reviewer',
            model: 'z-ai/glm-5.3-flash',
            roles: ['reviewer'],
            costClass: 'paid',
          }),
        ],
        chains: { implementer: [{ seatId: 'impl' }] },
      }),
    );
    expect(errors).toContainEqual(
      'seats.standalone-reviewer: seat "standalone-reviewer" shares the implementer chain\'s model family (z-ai/glm-5.3-flash)',
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

  it('reports unknown chain seats at the file positions when file chains are given', () => {
    // The derived chains come from a useFreeSeats false installation, so
    // free-a is already dropped and ghost's reduced position is 0; the file
    // position is 1 and must be named exactly once.
    const errors = validateSeatPolicy(
      installation({
        seats: [seat({ id: 'free-a', model: 'a/m1', costClass: 'free' })],
        chains: { implementer: [{ seatId: 'ghost' }] },
        policy: { useFreeSeats: false },
      }),
      { implementer: [{ seatId: 'free-a' }, { seatId: 'ghost' }] },
    );
    expect(errors).toEqual(['chains.implementer[1]: references unknown seat "ghost"']);
  });

  it('reports chain role errors at the file positions when file chains are given', () => {
    // The reduced position of wrong is 0 (free-a was dropped); the file
    // position is 1 and must be the one the message names.
    const errors = validateSeatPolicy(
      installation({
        seats: [
          seat({ id: 'free-a', model: 'a/m1', costClass: 'free' }),
          seat({ id: 'wrong', model: 'b/m2', roles: ['reviewer'], costClass: 'paid' }),
        ],
        chains: { implementer: [{ seatId: 'wrong' }] },
        policy: { useFreeSeats: false },
      }),
      { implementer: [{ seatId: 'free-a' }, { seatId: 'wrong' }] },
    );
    expect(errors).toContainEqual(
      'chains.implementer[1]: seat "wrong" does not hold the role "implementer"',
    );
    expect(errors).not.toContainEqual(
      'chains.implementer[0]: seat "wrong" does not hold the role "implementer"',
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
          seat({ id: 'impl', model: 'a/glm-5.3' }),
          seat({ id: 'impl-fallback', model: 'b/grok-4.7' }),
          seat({
            id: 'hr-reviewer',
            model: 'c/grok-4.7-fast#high',
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
      forge: { mode: 'none' },
      hosts: {
        host: {
          transport: 'local',
          worktreeRoot: '/tmp/wt',
          roles: ['orchestrator', 'lane-runner', 'verifier'],
          runner: { kind: 'opencode', port: 4166, maxLanes: 1 },
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

  const policyHosts = {
    host: {
      transport: 'local',
      worktreeRoot: '/tmp/wt',
      roles: ['orchestrator', 'lane-runner', 'verifier'],
      runner: { kind: 'opencode', port: 4166, maxLanes: 1 },
    },
  };

  it('with useFreeSeats false, drops free seats from chains and keeps paid ones', () => {
    const file = writeV2({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: policyHosts,
      seats: [
        seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' }),
        seat({ id: 'paid-impl', model: 'b/m2', costClass: 'paid' }),
      ],
      chains: {
        implementer: [{ seatId: 'free-impl' }, { seatId: 'paid-impl' }],
      },
      policy: { useFreeSeats: false },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('loaded');
      if (result.status === 'loaded') {
        expect(result.model.chains?.implementer).toEqual([{ seatId: 'paid-impl' }]);
      }
    } finally {
      cleanup();
    }
  });

  it('with useFreeSeats false, refuses a role left without any seat', () => {
    const file = writeV2({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: policyHosts,
      seats: [seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' })],
      chains: { implementer: [{ seatId: 'free-impl' }] },
      policy: { useFreeSeats: false },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toContainEqual(
          'chains.implementer: every seat is free and policy.useFreeSeats is false; add a paid or plan-quota seat',
        );
      }
    } finally {
      cleanup();
    }
  });

  it('with useFreeSeats false, does not report a role with no chain', () => {
    const file = writeV2({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: policyHosts,
      seats: [
        seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' }),
        seat({
          id: 'paid-reviewer',
          model: 'b/m2',
          roles: ['reviewer'],
          costClass: 'paid',
        }),
      ],
      chains: { reviewer: [{ seatId: 'paid-reviewer' }] },
      policy: { useFreeSeats: false },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('loaded');
    } finally {
      cleanup();
    }
  });

  it('with useFreeSeats false, an unknown chain seat is refused at the file position', () => {
    // The parser refuses the unknown seat before the policy runs and names
    // the position itself: ghost sits at file position 1, while the reduced
    // chain (free-a dropped) would place it at 0.
    const file = writeV2({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: policyHosts,
      seats: [seat({ id: 'free-a', model: 'a/m1', costClass: 'free' })],
      chains: { implementer: [{ seatId: 'free-a' }, { seatId: 'ghost' }] },
      policy: { useFreeSeats: false },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toContainEqual('chains.implementer[1].seatId: unknown seat');
        expect(result.errors).not.toContainEqual('chains.implementer[0].seatId: unknown seat');
      }
    } finally {
      cleanup();
    }
  });

  it('with useFreeSeats false, chain role errors name the file position', () => {
    // free-a is dropped from the derived chain, so the reduced position of
    // wrong is 0; the reported position must be the file's 1.
    const file = writeV2({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: policyHosts,
      seats: [
        seat({ id: 'free-a', model: 'a/m1', costClass: 'free' }),
        seat({ id: 'wrong', model: 'b/m2', roles: ['reviewer'], costClass: 'paid' }),
      ],
      chains: { implementer: [{ seatId: 'free-a' }, { seatId: 'wrong' }] },
      policy: { useFreeSeats: false },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toContainEqual(
          'chains.implementer[1]: seat "wrong" does not hold the role "implementer"',
        );
        expect(result.errors).not.toContainEqual(
          'chains.implementer[0]: seat "wrong" does not hold the role "implementer"',
        );
      }
    } finally {
      cleanup();
    }
  });

  it('with useFreeSeats false, refuses seats that look free but are not declared free', () => {
    const cases: { seat: Partial<SeatModel> & { id: string }; expected: string }[] = [
      {
        seat: { id: 'impl', model: 'x/y:free', costClass: 'paid' },
        expected:
          'seats.impl: model "x/y:free" looks free but costClass is "paid"; declare it free or remove it',
      },
      {
        seat: { id: 'impl', model: 'x/y', variant: 'free', costClass: 'paid' },
        expected:
          'seats.impl: model "x/y" variant "free" looks free but costClass is "paid"; declare it free or remove it',
      },
      {
        seat: { id: 'impl', model: 'x/y', variant: 'FREE', costClass: 'plan-quota' },
        expected:
          'seats.impl: model "x/y" variant "FREE" looks free but costClass is "plan-quota"; declare it free or remove it',
      },
      {
        seat: { id: 'impl', model: 'x/y-free', costClass: 'paid' },
        expected:
          'seats.impl: model "x/y-free" looks free but costClass is "paid"; declare it free or remove it',
      },
      {
        seat: { id: 'impl', model: 'x/y', variant: 'turbo-free', costClass: 'paid' },
        expected:
          'seats.impl: model "x/y" variant "turbo-free" looks free but costClass is "paid"; declare it free or remove it',
      },
    ];
    for (const { seat: seatOverrides, expected } of cases) {
      const file = writeV2({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: policyHosts,
        seats: [seat(seatOverrides)],
        chains: { implementer: [{ seatId: 'impl' }] },
        policy: { useFreeSeats: false },
      });
      try {
        const result = loadInstallation({ file, env: {} });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.errors).toContainEqual(expected);
        }
      } finally {
        cleanup();
      }
    }
  });

  it('with useFreeSeats false, an explicit empty chain is not reported as emptied', () => {
    // The parser refuses an empty chain outright, before the free-seat drop
    // could empty it; the emptied message never appears.
    const file = writeV2({
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: policyHosts,
      seats: [seat({ id: 'paid-impl', model: 'b/m2', costClass: 'paid' })],
      chains: { implementer: [{ seatId: 'paid-impl' }], reviewer: [] },
      policy: { useFreeSeats: false },
    });
    try {
      const result = loadInstallation({ file, env: {} });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toContainEqual('chains.reviewer: must be a non-empty array');
        expect(result.errors).not.toContainEqual(
          'chains.reviewer: every seat is free and policy.useFreeSeats is false; add a paid or plan-quota seat',
        );
      }
    } finally {
      cleanup();
    }
  });

  it('with useFreeSeats false, a dropped free implementer relaxes the reviewer family rule', () => {
    // free-impl (family m) shares a family with the reviewer rev; the flag
    // absent refuses that file. With the flag off the drop removes the
    // family from the implementer chain and the error disappears.
    const base = {
      schemaVersion: 2 as const,
      forge: { mode: 'none' as const },
      hosts: policyHosts,
      seats: [
        seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' }),
        seat({ id: 'paid-impl', model: 'b/gpt2', costClass: 'paid' }),
        seat({ id: 'rev', model: 'c/m1', roles: ['reviewer'], costClass: 'paid' }),
      ],
      chains: {
        implementer: [{ seatId: 'free-impl' }, { seatId: 'paid-impl' }],
        reviewer: [{ seatId: 'rev' }],
      },
    };
    const familyError =
      'chains.reviewer: seat "rev" shares the implementer chain\'s model family (c/m1)';
    try {
      const absent = loadInstallation({ file: writeV2(base), env: {} });
      expect(absent.status).toBe('invalid');
      if (absent.status === 'invalid') {
        expect(absent.errors).toContainEqual(familyError);
      }
      cleanup();
      const off = loadInstallation({
        file: writeV2({ ...base, policy: { useFreeSeats: false } }),
        env: {},
      });
      expect(off.status).toBe('loaded');
      if (off.status === 'loaded') {
        expect(off.model.chains?.implementer).toEqual([{ seatId: 'paid-impl' }]);
      }
    } finally {
      cleanup();
    }
  });

  it('without the flag, a single free implementer seat still fails the only-seat rule', () => {
    const base = {
      schemaVersion: 2 as const,
      forge: { mode: 'none' as const },
      hosts: policyHosts,
      seats: [seat({ id: 'free-impl', model: 'a/m1', costClass: 'free' })],
      chains: { implementer: [{ seatId: 'free-impl' }] },
    };
    for (const policy of [undefined, { useFreeSeats: true }]) {
      const file = writeV2(policy === undefined ? base : { ...base, policy });
      try {
        const result = loadInstallation({ file, env: {} });
        expect(result.status).toBe('invalid');
        if (result.status === 'invalid') {
          expect(result.errors).toContainEqual(
            'chains.implementer: the free seat "free-impl" must not be the only seat of the role',
          );
        }
      } finally {
        cleanup();
      }
    }
  });

  it('with the flag absent or true, a free-looking paid seat produces no looks-free error', () => {
    const base = {
      schemaVersion: 2 as const,
      forge: { mode: 'none' as const },
      hosts: policyHosts,
      seats: [seat({ id: 'impl', model: 'x/y:free', costClass: 'paid' })],
      chains: { implementer: [{ seatId: 'impl' }] },
    };
    for (const policy of [undefined, { useFreeSeats: true }]) {
      const file = writeV2(policy === undefined ? base : { ...base, policy });
      try {
        const result = loadInstallation({ file, env: {} });
        expect(result.status).toBe('loaded');
      } finally {
        cleanup();
      }
    }
  });
});
