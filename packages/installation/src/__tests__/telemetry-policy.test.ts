import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import {
  DEFAULT_TELEMETRY_POLICY,
  resolveTelemetryPolicy,
} from '../telemetry-policy.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

const SALT = '0123456789abcdef'.repeat(4);

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

function withTelemetry(block: unknown): unknown {
  return {
    ...validV2,
    policy: { ...validV2.policy, telemetry: block },
  };
}

/** `validV2` without a `policy` section at all. */
function validV2WithoutPolicy(): unknown {
  const copy = { ...validV2 };
  delete (copy as { policy?: unknown }).policy;
  return copy;
}

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const FULL_BLOCK = {
  enabled: true,
  projectName: 'fleet-lanes',
  route: 'phoenix',
  sampleRatio: 0.5,
  sendCost: false,
  includeDryRun: false,
  projectAliases: { 'example-project': 'example' },
  salt: SALT,
};

const SIXTY_FIVE_ALIASES: Record<string, string> = {};
for (let index = 0; index < 65; index += 1) {
  SIXTY_FIVE_ALIASES[`project-${index}`] = `alias-${index}`;
}

const REFUSALS: { block: unknown; error: string }[] = [
  { block: {}, error: 'policy.telemetry.enabled: required' },
  { block: { enabled: 'yes' }, error: 'policy.telemetry.enabled: must be a boolean' },
  { block: { enabled: true }, error: 'policy.telemetry.salt: required when enabled' },
  {
    block: { enabled: false, projectName: 'Fleet' },
    error: 'policy.telemetry.projectName: must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
  },
  { block: { enabled: false, route: 'direct' }, error: 'policy.telemetry.route: must be one of collector, phoenix' },
  {
    block: { enabled: false, sampleRatio: 1.5 },
    error: 'policy.telemetry.sampleRatio: must be a number from 0 to 1',
  },
  {
    block: { enabled: false, sampleRatio: -0.1 },
    error: 'policy.telemetry.sampleRatio: must be a number from 0 to 1',
  },
  {
    block: { enabled: false, sampleRatio: Number.NaN },
    error: 'policy.telemetry.sampleRatio: must be a number from 0 to 1',
  },
  { block: { enabled: false, sendCost: 'no' }, error: 'policy.telemetry.sendCost: must be a boolean' },
  { block: { enabled: false, includeDryRun: 1 }, error: 'policy.telemetry.includeDryRun: must be a boolean' },
  { block: { enabled: false, projectAliases: [] }, error: 'policy.telemetry.projectAliases: must be an object' },
  {
    block: { enabled: false, projectAliases: SIXTY_FIVE_ALIASES },
    error: 'policy.telemetry.projectAliases: at most 64 entries',
  },
  {
    block: { enabled: false, projectAliases: { '': 'x' } },
    error: 'policy.telemetry.projectAliases: every project id must be a non-empty id of at most 128 characters with no secret-shaped value',
  },
  {
    block: { enabled: false, projectAliases: JSON.parse('{"constructor":"x"}') },
    error: 'policy.telemetry.projectAliases: every project id must be a non-empty id of at most 128 characters with no secret-shaped value',
  },
  {
    block: { enabled: false, projectAliases: { 'example-project': 'Bad Alias' } },
    error: 'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
  },
  {
    block: { enabled: false, projectAliases: { 'project-one': 'same', 'project-two': 'same' } },
    error: 'policy.telemetry.projectAliases: two projects share an alias',
  },
  {
    block: { enabled: true, salt: 'ABCDEF'.repeat(11) },
    error: 'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)',
  },
  {
    block: { enabled: true, salt: '0'.repeat(63) },
    error: 'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)',
  },
  {
    block: { enabled: true, salt: '0'.repeat(258) },
    error: 'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)',
  },
  {
    block: { enabled: true, salt: 'g'.repeat(64) },
    error: 'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)',
  },
  {
    block: { enabled: true, salt: 42 },
    error: 'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)',
  },
  {
    block: { enabled: true, salt: '01'.repeat(32) },
    error: 'policy.telemetry.salt: looks like a placeholder; generate at least 32 random bytes',
  },
  { block: { enabled: false, endpoint: 'x' }, error: 'policy.telemetry: unknown key' },
];

describe('policy.telemetry (OT4a)', () => {
  it('accepts well-formed blocks', () => {
    const blocks = [
      { enabled: false },
      { enabled: true, salt: SALT },
      FULL_BLOCK,
      { enabled: false, sampleRatio: 0 },
      { enabled: false, sampleRatio: 1 },
      { enabled: true, salt: SALT.repeat(4) },
    ];
    for (const block of blocks) {
      const input = withTelemetry(block);
      expect(parseInstallation(input)).toEqual({ ok: true, installation: input });
    }
  });

  it('treats an absent block as off', () => {
    const parsed = parseV2Fixture(validV2);
    expect(resolveTelemetryPolicy(parsed.policy)).toEqual(DEFAULT_TELEMETRY_POLICY);
    expect(resolveTelemetryPolicy(undefined)).toEqual(DEFAULT_TELEMETRY_POLICY);
    expect(resolveTelemetryPolicy(parseV2Fixture(validV2WithoutPolicy()).policy)).toEqual(
      DEFAULT_TELEMETRY_POLICY,
    );
    expect(DEFAULT_TELEMETRY_POLICY.enabled).toBe(false);
    expect(DEFAULT_TELEMETRY_POLICY.projectName).toBe('fleet-lanes');
    expect(DEFAULT_TELEMETRY_POLICY.route).toBe('collector');
    expect(DEFAULT_TELEMETRY_POLICY.sampleRatio).toBe(1);
    expect(DEFAULT_TELEMETRY_POLICY.sendCost).toBe(true);
    expect(DEFAULT_TELEMETRY_POLICY.includeDryRun).toBe(true);
    expect(DEFAULT_TELEMETRY_POLICY.projectAliases).toEqual({});
    expect(DEFAULT_TELEMETRY_POLICY.salt).toBeNull();
    expect(Object.isFrozen(DEFAULT_TELEMETRY_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TELEMETRY_POLICY.projectAliases)).toBe(true);
  });

  it('defaults fill only absent fields', () => {
    expect(resolveTelemetryPolicy({ telemetry: { enabled: true, salt: SALT } })).toEqual({
      enabled: true,
      projectName: 'fleet-lanes',
      route: 'collector',
      sampleRatio: 1,
      sendCost: true,
      includeDryRun: true,
      projectAliases: {},
      salt: SALT,
    });
    expect(resolveTelemetryPolicy({ telemetry: FULL_BLOCK })).toEqual(FULL_BLOCK);
  });

  it.each(REFUSALS)('refuses malformed blocks', ({ block, error }) => {
    const result = parseInstallation(withTelemetry(block));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(error);
    }
  });

  it('refuses a non-object telemetry value', () => {
    const result = parseInstallation(withTelemetry('on'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('policy.telemetry: must be an object');
    }
  });

  it('refuses secret-shaped values and never echoes them', () => {
    const secret = fakeSecretShape();
    const secretBlocks = [
      { enabled: false, projectName: secret },
      { enabled: false, projectAliases: { 'example-project': secret } },
      { enabled: false, projectAliases: { [secret]: 'example' } },
    ];
    const checkNoEcho = (errors: readonly string[], forbidden: readonly string[]): void => {
      for (const error of errors) {
        for (const token of forbidden) {
          expect(error).not.toContain(token);
        }
      }
    };
    for (const { block } of REFUSALS) {
      const result = parseInstallation(withTelemetry(block));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const saltInput = (block as { salt?: unknown }).salt;
        const forbidden = ['example-project', 'XYZZY'];
        if (typeof saltInput === 'string') {
          forbidden.push(saltInput);
        }
        checkNoEcho(result.errors, forbidden);
      }
    }
    for (const block of secretBlocks) {
      const result = parseInstallation(withTelemetry(block));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        checkNoEcho(result.errors, [secret, 'example-project', 'XYZZY']);
      }
    }
  });

  it('round-trips through the writer', () => {
    const blocks = [
      { enabled: false },
      { enabled: true, salt: SALT },
      FULL_BLOCK,
      { enabled: false, sampleRatio: 0 },
      { enabled: false, sampleRatio: 1 },
      { enabled: true, salt: SALT.repeat(4) },
    ];
    for (const block of blocks) {
      const parsed = parseV2Fixture(withTelemetry(block));
      const written = writeInstallationV2(parsed);
      expect(parseInstallation(JSON.parse(written))).toEqual({
        ok: true,
        installation: parsed,
      });
      const writtenPolicy = JSON.parse(written).policy as Record<string, unknown>;
      expect(Object.keys(writtenPolicy).at(-1)).toBe('telemetry');
    }
    const written = writeInstallationV2(parseV2Fixture(validV2));
    expect(written).not.toContain('telemetry');
  });

  it('carries the telemetry section into the derived model', () => {
    const model = requireValidInstallationModel(
      parseV2Fixture(withTelemetry({ enabled: false })),
    );
    expect(model.policy?.telemetry).toEqual({ enabled: false });
  });

  it('refuses telemetry on a v1 file', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      policy: { telemetry: { enabled: false } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('installation: unknown key');
    }
  });

  it('fails closed to the default for bypassed blocks', () => {
    const bypassing = [
      { telemetry: { enabled: true } },
      { telemetry: { enabled: true, salt: SALT, route: 'x' } },
      { telemetry: null },
      { telemetry: { enabled: true, salt: SALT, extra: 1 } },
    ];
    for (const policy of bypassing) {
      expect(resolveTelemetryPolicy(policy)).toEqual(DEFAULT_TELEMETRY_POLICY);
    }
    const throwingGetter = {
      get telemetry(): never {
        throw new Error('boom');
      },
    };
    expect(resolveTelemetryPolicy(throwingGetter)).toEqual(DEFAULT_TELEMETRY_POLICY);
  });

  it('returns fresh resolved objects', () => {
    const policyWithAliases: {
      telemetry: { enabled: boolean; salt: string; projectAliases: Record<string, string> };
    } = {
      telemetry: { enabled: true, salt: SALT, projectAliases: { 'example-project': 'example' } },
    };
    const first = resolveTelemetryPolicy(policyWithAliases);
    const second = resolveTelemetryPolicy(policyWithAliases);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.projectAliases).not.toBe(second.projectAliases);
    policyWithAliases.telemetry.projectAliases['example-project'] = 'changed';
    expect(first.projectAliases).toEqual({ 'example-project': 'example' });
  });

  it('returns a fresh, frozen default for an absent or malformed block', () => {
    for (const policy of [undefined, {}, { telemetry: { enabled: 'yes' } }]) {
      const first = resolveTelemetryPolicy(policy);
      const second = resolveTelemetryPolicy(policy);
      expect(first).toEqual(DEFAULT_TELEMETRY_POLICY);
      expect(first).not.toBe(DEFAULT_TELEMETRY_POLICY);
      expect(first).not.toBe(second);
      expect(first.projectAliases).not.toBe(DEFAULT_TELEMETRY_POLICY.projectAliases);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.projectAliases)).toBe(true);
    }
  });
});
