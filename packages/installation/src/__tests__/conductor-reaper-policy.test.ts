import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { canonicalConductorJson, conductorRevision } from '../conductor-revision.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import {
  CONDUCTOR_DESTRUCTIVE_REPAIR_KINDS,
  CONDUCTOR_REAPER_REPAIR_KINDS,
  DEFAULT_CONDUCTOR_POLICY,
  resolveConductorPolicy,
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

function withReaper(reaper: unknown): unknown {
  return {
    ...validV2,
    policy: {
      ...validV2.policy,
      conductor: { enabled: true, reaper },
    },
  };
}

/** Resolve a conductor policy whose reaper block is exactly `reaper`. */
function resolveWith(reaper: unknown) {
  return resolveConductorPolicy({ conductor: { enabled: true, reaper } } as never).reaper;
}

describe('policy.conductor.reaper worktrees/disk (KWp)', () => {
  it('treats an absent block as the default', () => {
    const parsed = parseV2Fixture(validV2);
    expect(resolveConductorPolicy(parsed.policy)).toEqual(DEFAULT_CONDUCTOR_POLICY);
    expect(resolveConductorPolicy(undefined)).toEqual(DEFAULT_CONDUCTOR_POLICY);
    const defaults = DEFAULT_CONDUCTOR_POLICY.reaper;
    expect(defaults.worktrees).toEqual({
      retentionHours: 24,
      maxRemovalsPerPass: 10,
      passBudgetSeconds: 120,
    });
    expect(defaults.disk).toEqual({ minFreePercent: 15, clearFreePercent: 20 });
    expect(defaults.repairs['merged-worktree']).toBe(false);
    expect(Object.isFrozen(defaults.worktrees)).toBe(true);
    expect(Object.isFrozen(defaults.disk)).toBe(true);
    expect(Object.isFrozen(defaults)).toBe(true);
    const resolved = resolveConductorPolicy(undefined);
    expect(resolved).not.toBe(DEFAULT_CONDUCTOR_POLICY);
    expect(resolved.reaper).not.toBe(defaults);
    expect(resolved.reaper.worktrees).not.toBe(defaults.worktrees);
    expect(resolved.reaper.disk).not.toBe(defaults.disk);
    expect(resolved.reaper.repairs).not.toBe(defaults.repairs);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.reaper)).toBe(true);
    expect(Object.isFrozen(resolved.reaper.worktrees)).toBe(true);
    expect(Object.isFrozen(resolved.reaper.disk)).toBe(true);
    expect(Object.isFrozen(resolved.reaper.repairs)).toBe(true);
  });

  it('defaults fill only absent fields', () => {
    expect(resolveWith({ enabled: true, worktrees: { retentionHours: 48 } }).worktrees).toEqual({
      retentionHours: 48,
      maxRemovalsPerPass: 10,
      passBudgetSeconds: 120,
    });
    expect(resolveWith({ enabled: true, worktrees: { maxRemovalsPerPass: 20 } }).worktrees).toEqual({
      retentionHours: 24,
      maxRemovalsPerPass: 20,
      passBudgetSeconds: 120,
    });
    expect(resolveWith({ enabled: true, worktrees: { passBudgetSeconds: 300 } }).worktrees).toEqual({
      retentionHours: 24,
      maxRemovalsPerPass: 10,
      passBudgetSeconds: 300,
    });
    expect(resolveWith({ enabled: true, disk: { minFreePercent: 5 } }).disk).toEqual({
      minFreePercent: 5,
      clearFreePercent: 20,
    });
    expect(resolveWith({ enabled: true, disk: { clearFreePercent: 30 } }).disk).toEqual({
      minFreePercent: 15,
      clearFreePercent: 30,
    });
    expect(
      resolveWith({ enabled: true, repairs: { 'merged-worktree': true } }).repairs['merged-worktree'],
    ).toBe(true);
    const all = resolveWith({
      enabled: true,
      worktrees: { retentionHours: 48, maxRemovalsPerPass: 20, passBudgetSeconds: 300 },
      disk: { minFreePercent: 5, clearFreePercent: 30 },
      repairs: { 'merged-worktree': true },
    });
    expect(all.worktrees).toEqual({
      retentionHours: 48,
      maxRemovalsPerPass: 20,
      passBudgetSeconds: 300,
    });
    expect(all.disk).toEqual({ minFreePercent: 5, clearFreePercent: 30 });
    expect(all.repairs['merged-worktree']).toBe(true);
  });

  it('round-trips through the writer', () => {
    const blocks: Array<{
      reaper: unknown;
      worktreesKeys?: string[];
      diskKeys?: string[];
    }> = [
      {
        reaper: {
          enabled: true,
          worktrees: { retentionHours: 48, maxRemovalsPerPass: 20, passBudgetSeconds: 300 },
          disk: { minFreePercent: 5, clearFreePercent: 30 },
          repairs: { 'merged-worktree': true },
        },
        worktreesKeys: ['retentionHours', 'maxRemovalsPerPass', 'passBudgetSeconds'],
        diskKeys: ['minFreePercent', 'clearFreePercent'],
      },
      {
        reaper: { enabled: true, worktrees: { maxRemovalsPerPass: 7 } },
        worktreesKeys: ['maxRemovalsPerPass'],
      },
      {
        reaper: { enabled: true, disk: { clearFreePercent: 40 } },
        diskKeys: ['clearFreePercent'],
      },
      { reaper: { enabled: true, worktrees: {} }, worktreesKeys: [] },
      { reaper: { enabled: true, disk: {} }, diskKeys: [] },
    ];
    for (const { reaper, worktreesKeys, diskKeys } of blocks) {
      const input = withReaper(reaper);
      const parsed = parseV2Fixture(input);
      const written = writeInstallationV2(parsed);
      expect(parseInstallation(JSON.parse(written))).toEqual({
        ok: true,
        installation: parsed,
      });
      const conductor = (JSON.parse(written).policy as Record<string, unknown>)
        .conductor as Record<string, unknown>;
      const writtenReaper = conductor.reaper as Record<string, unknown>;
      if (worktreesKeys !== undefined) {
        expect(Object.keys(writtenReaper.worktrees as Record<string, unknown>)).toEqual(worktreesKeys);
      }
      if (diskKeys !== undefined) {
        expect(Object.keys(writtenReaper.disk as Record<string, unknown>)).toEqual(diskKeys);
      }
    }
    const bare = parseV2Fixture(withReaper({ enabled: true }));
    const writtenBare = JSON.parse(writeInstallationV2(bare)) as { policy: Record<string, unknown> };
    const reaperBare = (writtenBare.policy.conductor as Record<string, unknown>)
      .reaper as Record<string, unknown>;
    expect(Object.hasOwn(reaperBare, 'worktrees')).toBe(false);
    expect(Object.hasOwn(reaperBare, 'disk')).toBe(false);
  });

  it('supports the merged-worktree opt-in and keeps the destructive set', () => {
    expect(CONDUCTOR_REAPER_REPAIR_KINDS).toEqual([
      'dead-attempt',
      'leaked-slot',
      'stale-stop',
      'stale-attention',
      'merged-worktree',
      'orphan-session',
    ]);
    expect(CONDUCTOR_DESTRUCTIVE_REPAIR_KINDS).toEqual(['orphan-session', 'merged-worktree']);
    const input = withReaper({ enabled: true, repairs: { 'merged-worktree': true } });
    const parsed = parseV2Fixture(input);
    expect(parsed.policy?.conductor?.reaper?.repairs?.['merged-worktree']).toBe(true);
    expect(resolveConductorPolicy(parsed.policy).reaper.repairs['merged-worktree']).toBe(true);
    for (const kind of ['orphan-worktree', 'driverless-run', 'remove-worktree']) {
      expect(parseInstallation(withReaper({ enabled: true, repairs: { [kind]: true } }))).toEqual({
        ok: false,
        errors: ['policy.conductor.reaper.repairs: unknown key'],
      });
    }
  });

  it('refuses malformed blocks', () => {
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ worktrees: { retentionHours: '24' } }, 'policy.conductor.reaper.worktrees.retentionHours: must be an integer 1..8760'],
      [{ worktrees: { retentionHours: 24.5 } }, 'policy.conductor.reaper.worktrees.retentionHours: must be an integer 1..8760'],
      [{ worktrees: { retentionHours: 0 } }, 'policy.conductor.reaper.worktrees.retentionHours: must be an integer 1..8760'],
      [{ worktrees: { retentionHours: 8761 } }, 'policy.conductor.reaper.worktrees.retentionHours: must be an integer 1..8760'],
      [{ worktrees: { maxRemovalsPerPass: '10' } }, 'policy.conductor.reaper.worktrees.maxRemovalsPerPass: must be an integer 1..1000'],
      [{ worktrees: { maxRemovalsPerPass: 10.5 } }, 'policy.conductor.reaper.worktrees.maxRemovalsPerPass: must be an integer 1..1000'],
      [{ worktrees: { maxRemovalsPerPass: 0 } }, 'policy.conductor.reaper.worktrees.maxRemovalsPerPass: must be an integer 1..1000'],
      [{ worktrees: { maxRemovalsPerPass: 1001 } }, 'policy.conductor.reaper.worktrees.maxRemovalsPerPass: must be an integer 1..1000'],
      [{ worktrees: { passBudgetSeconds: '120' } }, 'policy.conductor.reaper.worktrees.passBudgetSeconds: must be an integer 1..3600'],
      [{ worktrees: { passBudgetSeconds: 120.5 } }, 'policy.conductor.reaper.worktrees.passBudgetSeconds: must be an integer 1..3600'],
      [{ worktrees: { passBudgetSeconds: 0 } }, 'policy.conductor.reaper.worktrees.passBudgetSeconds: must be an integer 1..3600'],
      [{ worktrees: { passBudgetSeconds: 3601 } }, 'policy.conductor.reaper.worktrees.passBudgetSeconds: must be an integer 1..3600'],
      [{ disk: { minFreePercent: '15', clearFreePercent: 30 } }, 'policy.conductor.reaper.disk.minFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: 15.5, clearFreePercent: 30 } }, 'policy.conductor.reaper.disk.minFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: -1, clearFreePercent: 30 } }, 'policy.conductor.reaper.disk.minFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: 101, clearFreePercent: 30 } }, 'policy.conductor.reaper.disk.minFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: 5, clearFreePercent: '20' } }, 'policy.conductor.reaper.disk.clearFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: 5, clearFreePercent: 20.5 } }, 'policy.conductor.reaper.disk.clearFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: 5, clearFreePercent: -1 } }, 'policy.conductor.reaper.disk.clearFreePercent: must be an integer 0..100'],
      [{ disk: { minFreePercent: 5, clearFreePercent: 101 } }, 'policy.conductor.reaper.disk.clearFreePercent: must be an integer 0..100'],
      [{ worktrees: 'x' }, 'policy.conductor.reaper.worktrees: must be an object'],
      [{ worktrees: [] }, 'policy.conductor.reaper.worktrees: must be an object'],
      [{ disk: 'x' }, 'policy.conductor.reaper.disk: must be an object'],
      [{ disk: [] }, 'policy.conductor.reaper.disk: must be an object'],
      [{ worktrees: { retentionDays: 1 } }, 'policy.conductor.reaper.worktrees: unknown key'],
      [{ disk: { freePercent: 15 } }, 'policy.conductor.reaper.disk: unknown key'],
    ];
    for (const [extra, expectedError] of malformed) {
      const reaper = { enabled: true, ...extra };
      expect(parseInstallation(withReaper(reaper))).toEqual({
        ok: false,
        errors: [expectedError],
      });
      expect(
        resolveConductorPolicy({ conductor: { enabled: true, reaper } } as never),
      ).toEqual(DEFAULT_CONDUCTOR_POLICY);
    }
    const noEcho = parseInstallation(
      withReaper({ enabled: true, worktrees: { retentionHours: '24' } }),
    );
    if (!noEcho.ok) {
      expect(noEcho.errors.join('\n')).not.toContain('24');
    }
  });

  it('refuses a non-ordered disk pair', () => {
    const unequalPair = { minFreePercent: 15, clearFreePercent: 15 };
    const reversedPair = { minFreePercent: 25, clearFreePercent: 20 };
    for (const disk of [unequalPair, reversedPair]) {
      expect(parseInstallation(withReaper({ enabled: true, disk }))).toEqual({
        ok: false,
        errors: ['policy.conductor.reaper.disk: minFreePercent must be less than clearFreePercent'],
      });
      expect(
        resolveConductorPolicy({ conductor: { enabled: true, reaper: { enabled: true, disk } } } as never),
      ).toEqual(DEFAULT_CONDUCTOR_POLICY);
    }
    // Raised even when only one number is present (the other takes its default).
    expect(parseInstallation(withReaper({ enabled: true, disk: { minFreePercent: 25 } }))).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.disk: minFreePercent must be less than clearFreePercent'],
    });
    expect(parseInstallation(withReaper({ enabled: true, disk: { clearFreePercent: 10 } }))).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.disk: minFreePercent must be less than clearFreePercent'],
    });
    expect(
      resolveConductorPolicy({
        conductor: { enabled: true, reaper: { enabled: true, disk: { minFreePercent: 25 } } },
      } as never),
    ).toEqual(DEFAULT_CONDUCTOR_POLICY);
    expect(
      resolveConductorPolicy({
        conductor: { enabled: true, reaper: { enabled: true, disk: { clearFreePercent: 10 } } },
      } as never),
    ).toEqual(DEFAULT_CONDUCTOR_POLICY);
    const validInput = withReaper({
      enabled: true,
      disk: { minFreePercent: 10, clearFreePercent: 20 },
    });
    expect(parseInstallation(validInput)).toEqual({ ok: true, installation: validInput });
  });

  it('fails closed to the default for malformed blocks', () => {
    const malformed = [
      { enabled: true, worktrees: { retentionHours: '24' } },
      { enabled: true, worktrees: { retentionHours: 24.5 } },
      { enabled: true, worktrees: { retentionHours: 0 } },
      { enabled: true, worktrees: { retentionHours: 8761 } },
      { enabled: true, worktrees: { maxRemovalsPerPass: 0 } },
      { enabled: true, worktrees: { maxRemovalsPerPass: 1001 } },
      { enabled: true, worktrees: { passBudgetSeconds: 0 } },
      { enabled: true, worktrees: { passBudgetSeconds: 3601 } },
      { enabled: true, disk: { minFreePercent: -1, clearFreePercent: 30 } },
      { enabled: true, disk: { minFreePercent: 101, clearFreePercent: 30 } },
      { enabled: true, disk: { minFreePercent: 5, clearFreePercent: -1 } },
      { enabled: true, disk: { minFreePercent: 5, clearFreePercent: 101 } },
      { enabled: true, disk: { minFreePercent: 25, clearFreePercent: 20 } },
      { enabled: true, disk: { minFreePercent: 15, clearFreePercent: 15 } },
      { enabled: true, disk: { minFreePercent: 25 } },
      { enabled: true, disk: { clearFreePercent: 10 } },
      { enabled: true, worktrees: 'x' },
      { enabled: true, disk: [] },
      { enabled: true, worktrees: { bogon: 1 } },
      { enabled: true, disk: { bogon: 1 } },
      { enabled: true, repairs: { 'merged-worktree': 'yes' } },
    ];
    for (const reaper of malformed) {
      expect(
        resolveConductorPolicy({ conductor: { enabled: true, reaper } } as never),
      ).toEqual(DEFAULT_CONDUCTOR_POLICY);
    }
  });

  it('returns a validation error without running a throwing own getter', () => {
    const fields = [
      'retentionHours',
      'maxRemovalsPerPass',
      'passBudgetSeconds',
      'minFreePercent',
      'clearFreePercent',
    ] as const;
    const paths: Record<string, string> = {
      retentionHours: 'policy.conductor.reaper.worktrees.retentionHours: must be an integer 1..8760',
      maxRemovalsPerPass: 'policy.conductor.reaper.worktrees.maxRemovalsPerPass: must be an integer 1..1000',
      passBudgetSeconds: 'policy.conductor.reaper.worktrees.passBudgetSeconds: must be an integer 1..3600',
      minFreePercent: 'policy.conductor.reaper.disk.minFreePercent: must be an integer 0..100',
      clearFreePercent: 'policy.conductor.reaper.disk.clearFreePercent: must be an integer 0..100',
    };
    for (const field of fields) {
      let getterRan = false;
      const block: Record<string, unknown> = {};
      Object.defineProperty(block, field, {
        get() {
          getterRan = true;
          throw new Error(`getter for ${field} should not run`);
        },
        enumerable: true,
        configurable: true,
      });
      const parent = field === 'minFreePercent' || field === 'clearFreePercent' ? 'disk' : 'worktrees';
      const reaper = { enabled: true, [parent]: block };
      let result: ReturnType<typeof parseInstallation> | undefined;
      expect(() => {
        result = parseInstallation(withReaper(reaper));
      }).not.toThrow();
      expect(getterRan).toBe(false);
      expect(result).toEqual({ ok: false, errors: [paths[field]] });
      expect(
        resolveConductorPolicy({ conductor: { enabled: true, reaper } } as never),
      ).toEqual(DEFAULT_CONDUCTOR_POLICY);
      expect(getterRan).toBe(false);
    }

    for (const kind of CONDUCTOR_REAPER_REPAIR_KINDS) {
      let repairGetterRan = false;
      const repairs: Record<string, unknown> = {};
      Object.defineProperty(repairs, kind, {
        get() {
          repairGetterRan = true;
          throw new Error(`getter for repairs.${kind} should not run`);
        },
        enumerable: true,
        configurable: true,
      });
      const reaperWithRepairGetter = { enabled: true, repairs };
      let repairResult: ReturnType<typeof parseInstallation> | undefined;
      expect(() => {
        repairResult = parseInstallation(withReaper(reaperWithRepairGetter));
      }).not.toThrow();
      expect(repairGetterRan).toBe(false);
      expect(repairResult).toEqual({
        ok: false,
        errors: [`policy.conductor.reaper.repairs.${kind}: must be a boolean`],
      });
      expect(
        resolveConductorPolicy({
          conductor: { enabled: true, reaper: reaperWithRepairGetter },
        } as never),
      ).toEqual(DEFAULT_CONDUCTOR_POLICY);
      expect(repairGetterRan).toBe(false);
    }

    for (const parent of ['worktrees', 'disk'] as const) {
      let blockGetterRan = false;
      const reaperWithGetter: Record<string, unknown> = { enabled: true };
      Object.defineProperty(reaperWithGetter, parent, {
        get() {
          blockGetterRan = true;
          throw new Error(`${parent} block getter should not run`);
        },
        enumerable: true,
        configurable: true,
      });
      let blockResult: ReturnType<typeof parseInstallation> | undefined;
      expect(() => {
        blockResult = parseInstallation(withReaper(reaperWithGetter));
      }).not.toThrow();
      expect(blockGetterRan).toBe(false);
      expect(blockResult).toEqual({
        ok: false,
        errors: [`policy.conductor.reaper.${parent}: must be an object`],
      });
      expect(
        resolveConductorPolicy({ conductor: { enabled: true, reaper: reaperWithGetter } } as never),
      ).toEqual(DEFAULT_CONDUCTOR_POLICY);
      expect(blockGetterRan).toBe(false);
    }
  });

  it('carries the reaper blocks into the derived model', () => {
    const model = requireValidInstallationModel(
      parseV2Fixture(
        withReaper({
          enabled: true,
          worktrees: { retentionHours: 48 },
          disk: { minFreePercent: 10, clearFreePercent: 20 },
        }),
      ),
    );
    expect(model.policy?.conductor).toEqual({
      enabled: true,
      reaper: {
        enabled: true,
        worktrees: { retentionHours: 48 },
        disk: { minFreePercent: 10, clearFreePercent: 20 },
      },
    });
  });

  it('the revision covers the new keys', () => {
    const canonical = canonicalConductorJson(
      resolveConductorPolicy({ conductor: { enabled: true } } as never),
    );
    expect(canonical).toContain(
      '"worktrees":{"retentionHours":24,"maxRemovalsPerPass":10,"passBudgetSeconds":120}',
    );
    expect(canonical).toContain('"disk":{"minFreePercent":15,"clearFreePercent":20}');
    expect(canonical).toContain('"merged-worktree":false');

    const base = conductorRevision(resolveConductorPolicy({ conductor: { enabled: true } } as never));
    const changed = [
      { worktrees: { retentionHours: 25 } },
      { worktrees: { maxRemovalsPerPass: 11 } },
      { worktrees: { passBudgetSeconds: 121 } },
      { disk: { minFreePercent: 14 } },
      { disk: { clearFreePercent: 21 } },
      { repairs: { 'merged-worktree': true } },
    ];
    for (const extra of changed) {
      const reaper = { enabled: true, ...extra };
      expect(
        conductorRevision(
          resolveConductorPolicy({ conductor: { enabled: true, reaper } } as never),
        ),
      ).not.toBe(base);
    }
  });
});
