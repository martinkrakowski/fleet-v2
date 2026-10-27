import { describe, expect, it } from 'vitest';

import type { AutoMergePolicy, FleetInstallationV2 } from '../types.js';
import { autoMergeRevision, canonicalAutoMergeJson } from '../auto-merge-revision.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import { DEFAULT_AUTO_MERGE_POLICY, resolveAutoMergePolicy } from '../policy.js';
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

function withAutoMerge(autoMerge: unknown): unknown {
  return {
    ...validV2,
    policy: { ...validV2.policy, autoMerge },
  };
}

/** `validV2` without a `policy` section at all. */
function validV2WithoutPolicy(): unknown {
  const copy = { ...validV2 };
  delete (copy as { policy?: unknown }).policy;
  return copy;
}

const ON: AutoMergePolicy = { enabled: true, allowHighRisk: false, onBlocked: 'ask-owner' };

describe('policy.autoMerge (AM1)', () => {
  it('accepts well-formed blocks', () => {
    const blocks = [
      ON,
      { enabled: false, allowHighRisk: false, onBlocked: 'hold' },
      { enabled: true, allowHighRisk: true, onBlocked: 'hold' },
    ];
    for (const block of blocks) {
      const input = withAutoMerge(block);
      expect(parseInstallation(input)).toEqual({ ok: true, installation: input });
    }
  });

  it('treats an absent block as off', () => {
    const parsed = parseV2Fixture(validV2);
    const policy = parsed.policy;
    expect(policy).toBeDefined();
    if (policy !== undefined) {
      expect(Object.hasOwn(policy, 'autoMerge')).toBe(false);
    }
    const off = { enabled: false, allowHighRisk: false, onBlocked: 'ask-owner' };
    expect(resolveAutoMergePolicy(policy)).toEqual(off);
    expect(resolveAutoMergePolicy(undefined)).toEqual(off);
    expect(resolveAutoMergePolicy(parseV2Fixture(validV2WithoutPolicy()).policy)).toEqual(off);
    expect(DEFAULT_AUTO_MERGE_POLICY).toEqual(off);
    expect(Object.isFrozen(DEFAULT_AUTO_MERGE_POLICY)).toBe(true);
  });

  it('refuses partial blocks with per-field paths', () => {
    expect(parseInstallation(withAutoMerge({ enabled: true }))).toEqual({
      ok: false,
      errors: [
        'policy.autoMerge.allowHighRisk: required',
        'policy.autoMerge.onBlocked: required',
      ],
    });
    expect(parseInstallation(withAutoMerge({}))).toEqual({
      ok: false,
      errors: [
        'policy.autoMerge.enabled: required',
        'policy.autoMerge.allowHighRisk: required',
        'policy.autoMerge.onBlocked: required',
      ],
    });
  });

  it('refuses wrong types with their paths', () => {
    expect(parseInstallation(withAutoMerge({ ...ON, enabled: 'yes' }))).toEqual({
      ok: false,
      errors: ['policy.autoMerge.enabled: must be a boolean'],
    });
    expect(parseInstallation(withAutoMerge({ ...ON, allowHighRisk: 1 }))).toEqual({
      ok: false,
      errors: ['policy.autoMerge.allowHighRisk: must be a boolean'],
    });
    for (const onBlocked of ['ignore', 'HOLD', null]) {
      const result = parseInstallation(withAutoMerge({ ...ON, onBlocked }));
      expect(result).toEqual({
        ok: false,
        errors: ['policy.autoMerge.onBlocked: must be one of ask-owner, hold'],
      });
      if (!result.ok) {
        expect(result.errors.join('\n')).not.toContain('ignore');
      }
    }
  });

  it('refuses a non-object block', () => {
    for (const autoMerge of [true, [ON]]) {
      expect(parseInstallation(withAutoMerge(autoMerge))).toEqual({
        ok: false,
        errors: ['policy.autoMerge: must be an object'],
      });
    }
  });

  it('refuses unknown autoMerge keys', () => {
    expect(parseInstallation(withAutoMerge({ ...ON, mergeEverything: true }))).toEqual({
      ok: false,
      errors: ['policy.autoMerge: unknown key'],
    });
  });

  it.each([
    ON,
    { enabled: false, allowHighRisk: false, onBlocked: 'hold' },
    { enabled: true, allowHighRisk: true, onBlocked: 'hold' },
  ])('round-trips %s through the writer', (block) => {
    const parsed = parseV2Fixture(withAutoMerge(block));
    const written = writeInstallationV2(parsed);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation: parsed,
    });
    const writtenPolicy = JSON.parse(written).policy as Record<string, unknown>;
    expect(Object.keys(writtenPolicy).at(-1)).toBe('autoMerge');
  });

  it('leaves files without autoMerge unchanged', () => {
    const written = writeInstallationV2(parseV2Fixture(validV2));
    expect(written).not.toContain('autoMerge');
  });

  it('carries the autoMerge section into the derived model', () => {
    const model = requireValidInstallationModel(parseV2Fixture(withAutoMerge(ON)));
    expect(model.policy?.autoMerge).toEqual(ON);
  });

  it('refuses policy on a v1 file', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      policy: { autoMerge: ON },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('installation: unknown key');
    }
  });

  it('fails closed to the default for malformed blocks', () => {
    expect(
      resolveAutoMergePolicy({
        autoMerge: { enabled: 'true', allowHighRisk: false, onBlocked: 'hold' },
      } as never),
    ).toEqual(DEFAULT_AUTO_MERGE_POLICY);
    expect(
      resolveAutoMergePolicy({
        autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'later' },
      } as never),
    ).toEqual(DEFAULT_AUTO_MERGE_POLICY);
    const resolved = resolveAutoMergePolicy({ autoMerge: ON } as never);
    expect(resolved).toEqual(ON);
    expect(resolved).not.toBe(ON);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('computes the revision from the canonical JSON', () => {
    expect(autoMergeRevision(DEFAULT_AUTO_MERGE_POLICY)).toBe('0692f17be6e5');
    expect(autoMergeRevision(ON)).toBe('309ab8c40bf2');
    expect(autoMergeRevision({ enabled: true, allowHighRisk: true, onBlocked: 'hold' })).toBe(
      '2ca034b88e81',
    );
    expect(autoMergeRevision(DEFAULT_AUTO_MERGE_POLICY)).toMatch(/^[0-9a-f]{12}$/);
    expect(autoMergeRevision(ON)).toMatch(/^[0-9a-f]{12}$/);
    expect(
      autoMergeRevision({ enabled: true, allowHighRisk: true, onBlocked: 'hold' }),
    ).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable across key order', () => {
    expect(
      autoMergeRevision({ onBlocked: 'ask-owner', allowHighRisk: false, enabled: true }),
    ).toBe('309ab8c40bf2');
    const reversed = withAutoMerge({
      onBlocked: 'ask-owner',
      allowHighRisk: false,
      enabled: true,
    });
    const parsed = parseV2Fixture(reversed);
    expect(autoMergeRevision(resolveAutoMergePolicy(parsed.policy))).toBe('309ab8c40bf2');
    expect(canonicalAutoMergeJson(ON)).toBe(
      '{"enabled":true,"allowHighRisk":false,"onBlocked":"ask-owner"}',
    );
  });

  it('changes the revision when any field changes', () => {
    const base = autoMergeRevision(ON);
    expect(autoMergeRevision({ ...ON, enabled: false })).not.toBe(base);
    expect(autoMergeRevision({ ...ON, allowHighRisk: true })).not.toBe(base);
    expect(autoMergeRevision({ ...ON, onBlocked: 'hold' })).not.toBe(base);
  });
});
