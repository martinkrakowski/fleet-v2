import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { requireValidInstallationModel } from '../load.js';
import { parseInstallation } from '../parse.js';
import { DEFAULT_LIVE_TAIL_CONTENT, resolveLiveTailContent } from '../policy.js';
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

function withLiveTail(liveTail: unknown): unknown {
  return {
    ...validV2,
    policy: { ...validV2.policy, liveTail },
  };
}

describe('policy.liveTail (L1b)', () => {
  it('accepts summaries and full', () => {
    for (const content of ['summaries', 'full']) {
      const input = withLiveTail({ content });
      expect(parseInstallation(input)).toEqual({ ok: true, installation: input });
    }
  });

  it('defaults to summaries when the key is absent', () => {
    const parsed = parseV2Fixture(validV2);
    const policy = parsed.policy;
    expect(policy).toBeDefined();
    if (policy !== undefined) {
      expect(Object.hasOwn(policy, 'liveTail')).toBe(false);
      expect(resolveLiveTailContent(policy)).toBe('summaries');
    }
    expect(resolveLiveTailContent(undefined)).toBe('summaries');
    const withoutPolicy = { ...validV2 };
    delete (withoutPolicy as { policy?: unknown }).policy;
    expect(resolveLiveTailContent(parseV2Fixture(withoutPolicy).policy)).toBe('summaries');
    expect(DEFAULT_LIVE_TAIL_CONTENT).toBe('summaries');
  });

  it('resolves full only when exactly full', () => {
    expect(resolveLiveTailContent({ liveTail: { content: 'full' } })).toBe('full');
    expect(resolveLiveTailContent({ liveTail: { content: 'summaries' } })).toBe('summaries');
  });

  it.each(['everything', 'FULL', 1, null])(
    'rejects content %s with its path',
    (content) => {
      const result = parseInstallation(withLiveTail({ content }));
      expect(result).toEqual({
        ok: false,
        errors: ['policy.liveTail.content: must be one of summaries, full'],
      });
      if (!result.ok) {
        expect(result.errors.join('\n')).not.toContain('everything');
      }
    },
  );

  it('rejects missing content', () => {
    expect(parseInstallation(withLiveTail({}))).toEqual({
      ok: false,
      errors: ['policy.liveTail.content: required'],
    });
  });

  it.each(['full', ['full']])('rejects a non-object liveTail %s', (liveTail) => {
    expect(parseInstallation(withLiveTail(liveTail))).toEqual({
      ok: false,
      errors: ['policy.liveTail: must be an object'],
    });
  });

  it('rejects an extra liveTail key', () => {
    expect(
      parseInstallation(withLiveTail({ content: 'summaries', persist: true })),
    ).toEqual({
      ok: false,
      errors: ['policy.liveTail: unknown key'],
    });
  });

  it.each(['summaries', 'full'])('round-trips %s through the writer', (content) => {
    const parsed = parseV2Fixture(withLiveTail({ content }));
    const written = writeInstallationV2(parsed);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation: parsed,
    });
    const writtenPolicy = JSON.parse(written).policy as Record<string, unknown>;
    expect(Object.keys(writtenPolicy).at(-1)).toBe('liveTail');
  });

  it('leaves files without liveTail unchanged', () => {
    const written = writeInstallationV2(parseV2Fixture(validV2));
    expect(written).not.toContain('liveTail');
  });

  it('carries the liveTail section into the derived model', () => {
    const model = requireValidInstallationModel(
      parseV2Fixture(withLiveTail({ content: 'full' })),
    );
    expect(model.policy?.liveTail).toEqual({ content: 'full' });
  });

  it('refuses policy on a v1 file', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      policy: { liveTail: { content: 'full' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('installation: unknown key');
    }
  });
});
