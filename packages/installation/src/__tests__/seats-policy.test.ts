import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import {
  DEFAULT_SEATS_POLICY,
  SEATS_POLICY_KEYS,
  resolveSeatsPolicy,
} from '../seats-policy.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
const validV2 = {
  schemaVersion: 2,
  hosts: {
    'lane-host': {
      transport: 'local',
      worktreeRoot: '/srv/fleet/worktrees',
      roles: ['orchestrator', 'lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 2,
      },
    },
  },
  tools: ['opencode'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'example-provider/example-model',
      roles: ['implementer'],
      costClass: 'plan-quota',
    },
  ],
  chains: { implementer: [{ seatId: 'implementer' }] },
  policy: { forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }] },
  shelf: { provider: 'local' },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
};

function parseV2Fixture(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

function withSeats(block: unknown): unknown {
  return {
    ...validV2,
    policy: { ...validV2.policy, seats: block },
  };
}

describe('policy.seats (SR2)', () => {
  it('accepts well-formed blocks', () => {
    const blocks = [
      {},
      { rotate: [] },
      { rotate: ['first-pass', 'fix', 'review'] },
      { rotate: ['pre-merge', 'review', 'fix', 'first-pass'], cooldownMinutes: 0, observationCooldownMinutes: 1440 },
      { cooldownMinutes: 1440 },
    ];
    for (const block of blocks) {
      const parsed = parseV2Fixture(withSeats(block));
      expect(parsed.policy?.seats).toEqual(block);
    }
  });

  it('resolves an absent block to the default', () => {
    expect(resolveSeatsPolicy(parseV2Fixture(validV2).policy)).toEqual({
      rotate: [],
      cooldownMinutes: 60,
      observationCooldownMinutes: 0,
    });
    expect(resolveSeatsPolicy(undefined)).toEqual(DEFAULT_SEATS_POLICY);
  });

  it('defaults fill only absent fields', () => {
    const cases: ReadonlyArray<{ block: object; expected: object }> = [
      { block: { cooldownMinutes: 15 }, expected: { rotate: [], cooldownMinutes: 15, observationCooldownMinutes: 0 } },
      { block: { rotate: ['review'] }, expected: { rotate: ['review'], cooldownMinutes: 60, observationCooldownMinutes: 0 } },
      { block: { observationCooldownMinutes: 30 }, expected: { rotate: [], cooldownMinutes: 60, observationCooldownMinutes: 30 } },
    ];
    for (const { block, expected } of cases) {
      const resolved = resolveSeatsPolicy({ seats: block });
      expect(resolved).toEqual(expected);
      expect(Object.keys(resolved)).toEqual(SEATS_POLICY_KEYS);
    }
  });

  it.each([
    { block: 'example', expected: ['policy.seats: must be an object'] },
    { block: [], expected: ['policy.seats: must be an object'] },
    { block: null, expected: ['policy.seats: must be an object'] },
    { block: 42, expected: ['policy.seats: must be an object'] },
    { block: { extra: 1 }, expected: ['policy.seats: unknown key'] },
    { block: { rotate: 'review' }, expected: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'] },
    { block: { rotate: ['review', 'review'] }, expected: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'] },
    { block: { rotate: ['implementer'] }, expected: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'] },
    { block: { rotate: ['first-pass', 1] }, expected: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'] },
    { block: { rotate: [null] }, expected: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'] },
    { block: { cooldownMinutes: -1 }, expected: ['policy.seats.cooldownMinutes: must be an integer from 0 to 1440'] },
    { block: { cooldownMinutes: 1441 }, expected: ['policy.seats.cooldownMinutes: must be an integer from 0 to 1440'] },
    { block: { cooldownMinutes: 1.5 }, expected: ['policy.seats.cooldownMinutes: must be an integer from 0 to 1440'] },
    { block: { cooldownMinutes: '60' }, expected: ['policy.seats.cooldownMinutes: must be an integer from 0 to 1440'] },
    { block: { cooldownMinutes: Number.NaN }, expected: ['policy.seats.cooldownMinutes: must be an integer from 0 to 1440'] },
    { block: { observationCooldownMinutes: -1 }, expected: ['policy.seats.observationCooldownMinutes: must be an integer from 0 to 1440'] },
    { block: { observationCooldownMinutes: 2000 }, expected: ['policy.seats.observationCooldownMinutes: must be an integer from 0 to 1440'] },
  ])('refuses $block', ({ block, expected }) => {
    const result = parseInstallation(withSeats(block));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expected);
    }
  });

  it('errors never echo a value', () => {
    const blocks = [
      { rotate: ['XYZZY-role'] },
      { XYZZY_key: 1 },
      { cooldownMinutes: 'XYZZY' },
    ];
    for (const block of blocks) {
      const result = parseInstallation(withSeats(block));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        for (const error of result.errors) {
          expect(error).not.toContain('XYZZY');
        }
      }
    }
  });

  it('round-trips through the writer', () => {
    const blocks = [
      {},
      { rotate: [] },
      { rotate: ['first-pass', 'fix', 'review'] },
      { rotate: ['pre-merge', 'review', 'fix', 'first-pass'], cooldownMinutes: 0, observationCooldownMinutes: 1440 },
      { cooldownMinutes: 1440 },
    ];
    for (const block of blocks) {
      const parsed = parseV2Fixture(withSeats(block));
      const written = writeInstallationV2(parsed);
      expect(parseInstallation(JSON.parse(written))).toEqual({
        ok: true,
        installation: parsed,
      });
      const writtenPolicy = JSON.parse(written).policy as Record<string, unknown>;
      expect(Object.keys(writtenPolicy).at(-1)).toBe('seats');
    }
    const writtenWithoutSeats = writeInstallationV2(parseV2Fixture(validV2));
    expect(Object.hasOwn(JSON.parse(writtenWithoutSeats).policy, 'seats')).toBe(false);
    const writtenDefault = writeInstallationV2(parseV2Fixture(withSeats({ cooldownMinutes: 15 })));
    const writtenBlock = JSON.parse(writtenDefault).policy as { seats: Record<string, unknown> };
    expect(Object.keys(writtenBlock.seats)).toEqual(['cooldownMinutes']);
  });

  it('writes policy block keys in a fixed order', () => {
    const parsed = parseV2Fixture(withSeats({ observationCooldownMinutes: 5, rotate: ['fix'], cooldownMinutes: 10 }));
    const written = JSON.parse(writeInstallationV2(parsed)).policy as { seats: Record<string, unknown> };
    expect(Object.keys(written.seats)).toEqual(['rotate', 'cooldownMinutes', 'observationCooldownMinutes']);
    const both = parseV2Fixture({
      ...validV2,
      policy: { ...validV2.policy, telemetry: { enabled: false }, seats: {} },
    });
    const writtenBoth = JSON.parse(writeInstallationV2(both)).policy as Record<string, unknown>;
    expect(Object.keys(writtenBoth).slice(-2)).toEqual(['telemetry', 'seats']);
  });

  it('carries the seats section into the derived model and refuses it on a v1 file', () => {
    const model = requireValidInstallationModel(
      parseV2Fixture(withSeats({ cooldownMinutes: 5 })),
    );
    expect(model.policy?.seats).toEqual({ cooldownMinutes: 5 });
    const result = parseInstallation({
      schemaVersion: 1,
      policy: { seats: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('installation: unknown key');
    }
  });

  it('fails closed to the default for bypassed blocks', () => {
    const bypassing = [
      { seats: { rotate: ['x'] } },
      { seats: null },
      { seats: { cooldownMinutes: 5000 } },
      { seats: { extra: 1 } },
      'example',
    ];
    for (const policy of bypassing) {
      expect(resolveSeatsPolicy(policy)).toEqual(DEFAULT_SEATS_POLICY);
    }
    const throwingGetter = {
      get seats(): never {
        throw new Error('boom');
      },
    };
    expect(resolveSeatsPolicy(throwingGetter)).toEqual(DEFAULT_SEATS_POLICY);
  });

  it('returns fresh, frozen results', () => {
    const input = { seats: { rotate: ['fix'] } };
    const first = resolveSeatsPolicy(input);
    const second = resolveSeatsPolicy(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.rotate).not.toBe(second.rotate);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.rotate)).toBe(true);
    const source: { rotate?: string[] } = {};
    const resolved = resolveSeatsPolicy({ seats: source });
    source.rotate = ['first-pass'];
    expect(resolved.rotate).toEqual([]);
    const emptyOne = resolveSeatsPolicy(undefined);
    const emptyTwo = resolveSeatsPolicy(undefined);
    expect(emptyOne).not.toBe(emptyTwo);
    expect(Object.isFrozen(emptyOne)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SEATS_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SEATS_POLICY.rotate)).toBe(true);
  });
});
