import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2, PolicySection } from '../types.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import {
  BOARD_BOUNDS,
  DEFAULT_BOARD_POLICY,
  resolveBoardPolicy,
} from '../policy.js';
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

function withBoard(board: unknown): unknown {
  return {
    ...validV2,
    policy: { ...validV2.policy, board },
  };
}

/** `validV2` without a `policy` section at all. */
function validV2WithoutPolicy(): unknown {
  const copy = { ...validV2 };
  delete (copy as { policy?: unknown }).policy;
  return copy;
}

function policyOf(installation: { policy?: PolicySection }): PolicySection | undefined {
  return installation.policy;
}

describe('policy.board (WB6p)', () => {
  it('treats an absent block as the default', () => {
    const parsed = parseV2Fixture(validV2);
    const policy = parsed.policy;
    expect(policy).toBeDefined();
    if (policy !== undefined) {
      expect(Object.hasOwn(policy, 'board')).toBe(false);
    }
    const defaults = DEFAULT_BOARD_POLICY;
    expect(resolveBoardPolicy(policy)).toEqual(defaults);
    expect(resolveBoardPolicy(undefined)).toEqual(defaults);
    expect(resolveBoardPolicy(policyOf(validV2))).toEqual(defaults);
    expect(resolveBoardPolicy(parseV2Fixture(validV2WithoutPolicy()).policy)).toEqual(defaults);
    expect(defaults.forgeStaleMinutes).toBe(15);
    expect(defaults.declarationTtlMinutes).toBe(90);
    expect(defaults.doneWindowDays).toBe(14);
    expect(defaults.forgeSyncMinutes).toBe(10);
    expect(Object.isFrozen(defaults)).toBe(true);
  });

  it('defaults fill only absent fields and round-trips', () => {
    const blocks = [
      {},
      { forgeStaleMinutes: 30 },
      { doneWindowDays: 7 },
      { forgeStaleMinutes: 20, declarationTtlMinutes: 120, doneWindowDays: 30, forgeSyncMinutes: 5 },
    ];
    for (const block of blocks) {
      const typed = block as {
        forgeStaleMinutes?: number;
        declarationTtlMinutes?: number;
        doneWindowDays?: number;
        forgeSyncMinutes?: number;
      };
      const resolved = resolveBoardPolicy({ board: block } as never);
      expect(resolved.forgeStaleMinutes).toBe(typed.forgeStaleMinutes ?? 15);
      expect(resolved.declarationTtlMinutes).toBe(typed.declarationTtlMinutes ?? 90);
      expect(resolved.doneWindowDays).toBe(typed.doneWindowDays ?? 14);
      expect(resolved.forgeSyncMinutes).toBe(typed.forgeSyncMinutes ?? 10);
      const parsed = parseV2Fixture(withBoard(block));
      const written = writeInstallationV2(parsed);
      expect(parseInstallation(JSON.parse(written))).toEqual({
        ok: true,
        installation: parsed,
      });
    }
    const withConductor = parseV2Fixture({
      ...validV2,
      policy: {
        ...validV2.policy,
        conductor: { enabled: true },
        board: { forgeStaleMinutes: 20 },
      },
    });
    const writtenPolicy = JSON.parse(writeInstallationV2(withConductor)).policy as Record<string, unknown>;
    expect(Object.keys(writtenPolicy).indexOf('board')).toBeGreaterThan(
      Object.keys(writtenPolicy).indexOf('conductor'),
    );
  });

  it('fails closed to the default for malformed blocks', () => {
    const malformed: Array<[unknown, string[]]> = [
      ['x', ['policy.board: must be an object']],
      [{ forgeStaleMinutes: '15' }, ['policy.board.forgeStaleMinutes: must be an integer 1..1440']],
      [{ forgeStaleMinutes: 1.5 }, ['policy.board.forgeStaleMinutes: must be an integer 1..1440']],
      [{ forgeStaleMinutes: 0 }, ['policy.board.forgeStaleMinutes: must be an integer 1..1440']],
      [{ forgeStaleMinutes: 1441 }, ['policy.board.forgeStaleMinutes: must be an integer 1..1440']],
      [{ declarationTtlMinutes: 0 }, ['policy.board.declarationTtlMinutes: must be an integer 1..10080']],
      [{ declarationTtlMinutes: 10081 }, ['policy.board.declarationTtlMinutes: must be an integer 1..10080']],
      [{ doneWindowDays: 0 }, ['policy.board.doneWindowDays: must be an integer 1..3650']],
      [{ doneWindowDays: 3651 }, ['policy.board.doneWindowDays: must be an integer 1..3650']],
      [{ forgeSyncMinutes: 0 }, ['policy.board.forgeSyncMinutes: must be an integer 1..1440']],
      [{ forgeSyncMinutes: 1441 }, ['policy.board.forgeSyncMinutes: must be an integer 1..1440']],
      [{ forgeSyncMinutes: 10, extra: true }, ['policy.board: unknown key']],
    ];
    for (const [board, expectedErrors] of malformed) {
      expect(parseInstallation(withBoard(board))).toEqual({
        ok: false,
        errors: expectedErrors,
      });
      expect(resolveBoardPolicy({ board } as never)).toEqual(DEFAULT_BOARD_POLICY);
    }
    const noEcho = parseInstallation(withBoard({ forgeStaleMinutes: '15' }));
    expect(noEcho).toEqual({
      ok: false,
      errors: ['policy.board.forgeStaleMinutes: must be an integer 1..1440'],
    });
    if (!noEcho.ok) {
      expect(noEcho.errors.join('\n')).not.toContain('15');
    }
    let getterRan = false;
    const withGetter = {
      board: Object.assign(
        Object.create({
          get forgeStaleMinutes(): number {
            getterRan = true;
            return 15;
          },
        }),
        { extra: true },
      ),
    };
    expect(parseInstallation(withBoard(withGetter.board))).toEqual({
      ok: false,
      errors: ['policy.board: unknown key'],
    });
    expect(getterRan).toBe(false);
    expect(resolveBoardPolicy(withGetter as never)).toEqual(DEFAULT_BOARD_POLICY);
    expect(getterRan).toBe(false);
  });

  it('refuses board on a v1 file', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      policy: { board: { forgeStaleMinutes: 15 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('installation: unknown key');
    }
  });

  it('carries the board section into the derived model', () => {
    const model = requireValidInstallationModel(
      parseV2Fixture(withBoard({ forgeStaleMinutes: 20 })),
    );
    expect(model.policy?.board).toEqual({ forgeStaleMinutes: 20 });
  });

  it('matches the work-execution defaults and domain bounds', () => {
    expect(DEFAULT_BOARD_POLICY.forgeStaleMinutes).toBe(15);
    expect(DEFAULT_BOARD_POLICY.declarationTtlMinutes).toBe(90);
    expect(DEFAULT_BOARD_POLICY.doneWindowDays).toBe(14);
    expect(DEFAULT_BOARD_POLICY.forgeSyncMinutes).toBe(10);
    expect(BOARD_BOUNDS.forgeStaleMinutes).toEqual({ min: 1, max: 1440 });
    expect(BOARD_BOUNDS.declarationTtlMinutes).toEqual({ min: 1, max: 10080 });
    expect(BOARD_BOUNDS.doneWindowDays).toEqual({ min: 1, max: 3650 });
  });
});
