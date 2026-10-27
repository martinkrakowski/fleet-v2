import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { canonicalConductorJson, conductorRevision } from '../conductor-revision.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import {
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

function withConductor(conductor: unknown): unknown {
  return {
    ...validV2,
    policy: { ...validV2.policy, conductor },
  };
}

/** `validV2` without a `policy` section at all. */
function validV2WithoutPolicy(): unknown {
  const copy = { ...validV2 };
  delete (copy as { policy?: unknown }).policy;
  return copy;
}

const RECORD_ONLY = {
  'dead-attempt': true,
  'leaked-slot': true,
  'stale-stop': true,
  'stale-attention': true,
};

const REVERSED_DEFAULT_ON = {
  reaper: {
    repairs: {
      'orphan-session': false,
      'stale-attention': false,
      'stale-stop': false,
      'leaked-slot': false,
      'dead-attempt': false,
    },
    staleStopMinutes: 30,
    graceMinutes: 5,
    intervalMinutes: 10,
    enabled: true,
  },
  stopGraceMinutes: 45,
  enabled: true,
};

describe('policy.conductor (K2)', () => {
  it('accepts well-formed blocks', () => {
    const blocks = [
      { enabled: false },
      { enabled: true },
      {
        enabled: true,
        stopGraceMinutes: 30,
        reaper: {
          enabled: true,
          intervalMinutes: 10,
          graceMinutes: 5,
          staleStopMinutes: 30,
          repairs: { 'leaked-slot': true },
        },
      },
    ];
    for (const block of blocks) {
      const input = withConductor(block);
      expect(parseInstallation(input)).toEqual({ ok: true, installation: input });
    }
  });

  it('treats an absent block as off', () => {
    const parsed = parseV2Fixture(validV2);
    const policy = parsed.policy;
    expect(policy).toBeDefined();
    if (policy !== undefined) {
      expect(Object.hasOwn(policy, 'conductor')).toBe(false);
    }
    const off = DEFAULT_CONDUCTOR_POLICY;
    expect(resolveConductorPolicy(policy)).toEqual(off);
    expect(resolveConductorPolicy(undefined)).toEqual(off);
    expect(resolveConductorPolicy(parseV2Fixture(validV2WithoutPolicy()).policy)).toEqual(off);
    expect(off.enabled).toBe(false);
    expect(off.stopGraceMinutes).toBe(45);
    expect(off.reaper.enabled).toBe(true);
    expect(off.reaper.intervalMinutes).toBe(10);
    expect(off.reaper.graceMinutes).toBe(5);
    expect(off.reaper.staleStopMinutes).toBe(30);
    expect(off.reaper.repairs).toEqual({
      'dead-attempt': false,
      'leaked-slot': false,
      'stale-stop': false,
      'stale-attention': false,
      'orphan-session': false,
    });
    expect(Object.isFrozen(off)).toBe(true);
    expect(Object.isFrozen(off.reaper)).toBe(true);
    expect(Object.isFrozen(off.reaper.repairs)).toBe(true);
  });

  it('defaults fill only absent fields', () => {
    const defaultRepairs = { ...DEFAULT_CONDUCTOR_POLICY.reaper.repairs };
    expect(resolveConductorPolicy({ conductor: { enabled: true } } as never)).toEqual({
      ...DEFAULT_CONDUCTOR_POLICY,
      enabled: true,
    });
    expect(
      resolveConductorPolicy({ conductor: { enabled: true, reaper: { enabled: false } } } as never),
    ).toEqual({
      ...DEFAULT_CONDUCTOR_POLICY,
      enabled: true,
      reaper: { ...DEFAULT_CONDUCTOR_POLICY.reaper, enabled: false },
    });
    expect(
      resolveConductorPolicy({
        conductor: { enabled: true, reaper: { enabled: true, repairs: { 'stale-stop': true } } },
      } as never),
    ).toEqual({
      ...DEFAULT_CONDUCTOR_POLICY,
      enabled: true,
      reaper: {
        ...DEFAULT_CONDUCTOR_POLICY.reaper,
        repairs: { ...defaultRepairs, 'stale-stop': true },
      },
    });
    expect(
      resolveConductorPolicy({
        conductor: { enabled: true, reaper: { repairs: { 'stale-stop': true } } },
      } as never),
    ).toEqual(DEFAULT_CONDUCTOR_POLICY);
  });

  it('keeps the destructive repair opt-in only', () => {
    const off = DEFAULT_CONDUCTOR_POLICY.reaper.repairs['orphan-session'];
    expect(off).toBe(false);
    expect(resolveConductorPolicy({ conductor: { enabled: true } } as never).reaper.repairs['orphan-session']).toBe(false);
    expect(
      resolveConductorPolicy({
        conductor: { enabled: true, reaper: { enabled: true, repairs: RECORD_ONLY } },
      } as never).reaper.repairs['orphan-session'],
    ).toBe(false);
    expect(
      resolveConductorPolicy({
        conductor: { enabled: true, reaper: { enabled: true, repairs: { 'orphan-session': true } } },
      } as never).reaper.repairs['orphan-session'],
    ).toBe(true);
  });

  it('requires enabled in a present block', () => {
    expect(parseInstallation(withConductor({}))).toEqual({
      ok: false,
      errors: ['policy.conductor.enabled: required'],
    });
    expect(parseInstallation(withConductor({ enabled: true, reaper: {} }))).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.enabled: required'],
    });
  });

  it('refuses wrong types and bounds with their paths', () => {
    expect(parseInstallation(withConductor({ enabled: 'yes' }))).toEqual({
      ok: false,
      errors: ['policy.conductor.enabled: must be a boolean'],
    });
    for (const stopGraceMinutes of [4, 481, 45.5, '45']) {
      const result = parseInstallation(withConductor({ enabled: true, stopGraceMinutes }));
      expect(result).toEqual({
        ok: false,
        errors: ['policy.conductor.stopGraceMinutes: must be an integer 5..480'],
      });
      if (!result.ok) {
        expect(result.errors.join('\n')).not.toContain('45');
      }
    }
    for (const intervalMinutes of [0, 1441]) {
      expect(
        parseInstallation(
          withConductor({ enabled: true, reaper: { enabled: true, intervalMinutes } }),
        ),
      ).toEqual({
        ok: false,
        errors: ['policy.conductor.reaper.intervalMinutes: must be an integer 1..1440'],
      });
    }
    expect(
      parseInstallation(
        withConductor({ enabled: true, reaper: { enabled: true, graceMinutes: 3 } }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.graceMinutes: must be an integer 4..1440'],
    });
    expect(
      parseInstallation(
        withConductor({ enabled: true, reaper: { enabled: true, staleStopMinutes: 4 } }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.staleStopMinutes: must be an integer 5..1440'],
    });
    expect(
      parseInstallation(
        withConductor({
          enabled: true,
          reaper: { enabled: true, repairs: { 'leaked-slot': 'on' } },
        }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.repairs.leaked-slot: must be a boolean'],
    });
    expect(
      parseInstallation(
        withConductor({
          enabled: true,
          stopGraceMinutes: 4,
          reaper: { enabled: true, intervalMinutes: 1441, graceMinutes: 3 },
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [
        'policy.conductor.stopGraceMinutes: must be an integer 5..480',
        'policy.conductor.reaper.intervalMinutes: must be an integer 1..1440',
        'policy.conductor.reaper.graceMinutes: must be an integer 4..1440',
      ],
    });
  });

  it('refuses non-object sections', () => {
    for (const conductor of [true, [{ enabled: true }]]) {
      expect(parseInstallation(withConductor(conductor))).toEqual({
        ok: false,
        errors: ['policy.conductor: must be an object'],
      });
    }
    expect(
      parseInstallation(withConductor({ enabled: true, reaper: 'on' })),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper: must be an object'],
    });
    expect(
      parseInstallation(withConductor({ enabled: true, reaper: { enabled: true, repairs: [] } })),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.repairs: must be an object'],
    });
  });

  it('refuses unknown keys (D15 and report-only kinds)', () => {
    expect(
      parseInstallation(
        withConductor({
          enabled: true,
          reaper: { enabled: true, repairs: { 'orphan-worktree': true } },
        }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.repairs: unknown key'],
    });
    expect(
      parseInstallation(
        withConductor({
          enabled: true,
          reaper: { enabled: true, repairs: { 'driverless-run': true } },
        }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.repairs: unknown key'],
    });
    expect(
      parseInstallation(
        withConductor({
          enabled: true,
          reaper: { enabled: true, repairs: { 'remove-worktree': true } },
        }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper.repairs: unknown key'],
    });
    expect(
      parseInstallation(
        withConductor({ enabled: true, reaper: { enabled: true, removeWorktrees: true } }),
      ),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor.reaper: unknown key'],
    });
    expect(
      parseInstallation(withConductor({ enabled: true, forgeSyncMinutes: 10 })),
    ).toEqual({
      ok: false,
      errors: ['policy.conductor: unknown key'],
    });
    expect(parseInstallation(withConductor({ enabled: true, globalCap: 2 }))).toEqual({
      ok: false,
      errors: ['policy.conductor: unknown key'],
    });
  });

  it('round-trips through the writer', () => {
    const blocks = [
      { enabled: false },
      { enabled: true },
      {
        enabled: true,
        stopGraceMinutes: 30,
        reaper: {
          enabled: true,
          intervalMinutes: 10,
          graceMinutes: 5,
          staleStopMinutes: 30,
          repairs: { 'leaked-slot': true },
        },
      },
      REVERSED_DEFAULT_ON,
    ];
    for (const block of blocks) {
      const parsed = parseV2Fixture(withConductor(block));
      const written = writeInstallationV2(parsed);
      expect(parseInstallation(JSON.parse(written))).toEqual({
        ok: true,
        installation: parsed,
      });
      const writtenPolicy = JSON.parse(written).policy as Record<string, unknown>;
      expect(Object.keys(writtenPolicy).at(-1)).toBe('conductor');
    }
    const parsedRecordOnly = parseV2Fixture(
      withConductor({ enabled: true, reaper: { enabled: true, repairs: RECORD_ONLY } }),
    );
    const writtenRepairs = (
      (JSON.parse(writeInstallationV2(parsedRecordOnly)).policy as Record<string, unknown>)
        .conductor as Record<string, unknown>
    ).reaper as Record<string, unknown>;
    expect(Object.keys(writtenRepairs.repairs as Record<string, unknown>)).toEqual([
      'dead-attempt',
      'leaked-slot',
      'stale-stop',
      'stale-attention',
    ]);
  });

  it('leaves files without conductor unchanged', () => {
    const written = writeInstallationV2(parseV2Fixture(validV2));
    expect(written).not.toContain('conductor');
    const withAutoMergeOnly = {
      ...validV2,
      policy: {
        ...validV2.policy,
        autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'ask-owner' },
      },
    };
    const writtenAutoMergeOnly = writeInstallationV2(parseV2Fixture(withAutoMergeOnly));
    expect(writtenAutoMergeOnly).not.toContain('conductor');
  });

  it('carries the conductor section into the derived model', () => {
    const model = requireValidInstallationModel(
      parseV2Fixture(withConductor({ enabled: true })),
    );
    expect(model.policy?.conductor).toEqual({ enabled: true });
  });

  it('refuses policy on a v1 file', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      policy: { conductor: { enabled: true } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('installation: unknown key');
    }
  });

  it('fails closed to the default for malformed blocks', () => {
    const malformed = [
      { conductor: { enabled: 'true' } },
      { conductor: { enabled: true, stopGraceMinutes: 2 } },
      { conductor: { enabled: true, reaper: { enabled: true, repairs: { 'orphan-worktree': true } } } },
      { conductor: { enabled: true, reaper: { enabled: true, repairs: { 'orphan-session': 'yes' } } } },
      Object.create({ conductor: { enabled: true } }),
      { conductor: Object.create({ enabled: true }) },
      { conductor: Object.assign(Object.create({ reaper: { enabled: false } }), { enabled: true }) },
      { conductor: { enabled: true, reaper: Object.create({ enabled: false }) } },
      { conductor: { enabled: true, forgeSyncMinutes: 10 } },
      { conductor: { enabled: true, reaper: { enabled: true, removeWorktrees: true } } },
      { conductor: {} },
      { conductor: { stopGraceMinutes: 30, reaper: { enabled: false } } },
      { conductor: { enabled: undefined } },
      { conductor: { enabled: undefined, stopGraceMinutes: 30, reaper: { enabled: false } } },
      { conductor: { enabled: true, reaper: {} } },
      { conductor: { enabled: true, reaper: { intervalMinutes: 20 } } },
      { conductor: { enabled: true, reaper: { enabled: undefined } } },
      { conductor: { enabled: true, reaper: { enabled: undefined, intervalMinutes: 20 } } },
    ];
    for (const bad of malformed) {
      expect(resolveConductorPolicy(bad as never)).toEqual(DEFAULT_CONDUCTOR_POLICY);
    }
    let getterRan = false;
    const withGetter = {
      conductor: {
        get enabled(): boolean {
          getterRan = true;
          return true;
        },
      },
    };
    expect(resolveConductorPolicy(withGetter as never)).toEqual(DEFAULT_CONDUCTOR_POLICY);
    expect(getterRan).toBe(false);
    const resolved = resolveConductorPolicy({ conductor: { enabled: true } } as never);
    expect(resolved).toEqual({
      ...DEFAULT_CONDUCTOR_POLICY,
      enabled: true,
    });
    expect(resolved).not.toBe(DEFAULT_CONDUCTOR_POLICY);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.reaper)).toBe(true);
    expect(Object.isFrozen(resolved.reaper.repairs)).toBe(true);
  });

  it('computes the revision from the canonical JSON', () => {
    expect(conductorRevision(DEFAULT_CONDUCTOR_POLICY)).toBe('4f455a6c4093');
    expect(
      conductorRevision(resolveConductorPolicy({ conductor: { enabled: true } } as never)),
    ).toBe('7844746b0277');
    expect(
      conductorRevision(
        resolveConductorPolicy({
          conductor: { enabled: true, reaper: { enabled: true, repairs: RECORD_ONLY } },
        } as never),
      ),
    ).toBe('82afb846ea78');
    expect(
      conductorRevision(
        resolveConductorPolicy({
          conductor: { enabled: true, reaper: { enabled: true, repairs: { 'orphan-session': true } } },
        } as never),
      ),
    ).toBe('5bb8328117df');
    for (const revision of ['4f455a6c4093', '7844746b0277', '82afb846ea78', '5bb8328117df']) {
      expect(revision).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(canonicalConductorJson(DEFAULT_CONDUCTOR_POLICY)).toBe(
      '{"enabled":false,"stopGraceMinutes":45,"reaper":{"enabled":true,"intervalMinutes":10,"graceMinutes":5,"staleStopMinutes":30,"repairs":{"dead-attempt":false,"leaked-slot":false,"stale-stop":false,"stale-attention":false,"orphan-session":false}}}',
    );
  });

  it('is stable across key order', () => {
    const canonical = parseV2Fixture(withConductor({ enabled: true }));
    const reversed = parseV2Fixture(withConductor(REVERSED_DEFAULT_ON));
    expect(conductorRevision(resolveConductorPolicy(canonical.policy))).toBe('7844746b0277');
    expect(conductorRevision(resolveConductorPolicy(reversed.policy))).toBe('7844746b0277');
  });

  it('changes the revision when any field changes', () => {
    const base = '7844746b0277';
    expect(
      conductorRevision(resolveConductorPolicy({ conductor: { enabled: false } } as never)),
    ).not.toBe(base);
    expect(
      conductorRevision(resolveConductorPolicy({ conductor: { enabled: true, stopGraceMinutes: 44 } } as never)),
    ).not.toBe(base);
    expect(
      conductorRevision(
        resolveConductorPolicy({ conductor: { enabled: true, reaper: { enabled: true, intervalMinutes: 11 } } } as never),
      ),
    ).not.toBe(base);
    expect(
      conductorRevision(
        resolveConductorPolicy({ conductor: { enabled: true, reaper: { enabled: true, graceMinutes: 6 } } } as never),
      ),
    ).not.toBe(base);
    expect(
      conductorRevision(
        resolveConductorPolicy({ conductor: { enabled: true, reaper: { enabled: true, staleStopMinutes: 31 } } } as never),
      ),
    ).not.toBe(base);
    expect(
      conductorRevision(
        resolveConductorPolicy({ conductor: { enabled: true, reaper: { enabled: false } } } as never),
      ),
    ).not.toBe(base);
    for (const kind of CONDUCTOR_REAPER_REPAIR_KINDS) {
      expect(
        conductorRevision(
          resolveConductorPolicy({
            conductor: { enabled: true, reaper: { enabled: true, repairs: { [kind]: true } } },
          } as never),
        ),
      ).not.toBe(base);
    }
  });
});
