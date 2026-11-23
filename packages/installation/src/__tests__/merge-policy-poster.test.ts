import { describe, expect, it } from 'vitest';

import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';
import {
  canonicalMergePolicyJson,
  mergePolicyRevision,
  resolveMergePolicy,
} from '../policy.js';
import type {
  MergePolicyRead,
  PolicySection,
  ResolvedMergeDaemonPolicy,
  ResolvedMergeRepositoryPolicy,
} from '../types.js';

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

const daemonDefaults: ResolvedMergeDaemonPolicy = {
  intervalSeconds: 60,
  budgetSeconds: 45,
  settleSeconds: 20,
  chainRefresh: 'shadow',
  stallAfterMinutes: 30,
  autoResumeMax: 2,
};

/** The golden resolved entry without `premergePosterLogin` (the pre-EV1a shape). */
function repository(overrides: Partial<ResolvedMergeRepositoryPolicy> = {}): ResolvedMergeRepositoryPolicy {
  return {
    owner: 'owner',
    repo: 'repo',
    repositoryKey: 'owner/repo',
    projectId: 'p',
    shadow: true,
    unattended: false,
    requiredContexts: ['gate', 'premerge'],
    updateBranch: false,
    macosProcedure: null,
    maxAttempts: 9,
    checksGraceMinutes: 30,
    veto: { mode: 'off', holdConfidence: 0.8 },
    ...overrides,
  };
}

function reposWith(entry: unknown, key = 'owner/repo'): PolicySection {
  return { merge: { repos: { [key]: entry } } } as unknown as PolicySection;
}

function expectResolved(read: MergePolicyRead): Extract<MergePolicyRead, { outcome: 'resolved' }> {
  if (read.outcome !== 'resolved') {
    throw new Error(`expected resolved, got ${read.reason}`);
  }
  return read;
}

function expectInvalid(read: MergePolicyRead, reason: string): void {
  expect(read).toEqual({ outcome: 'invalid', reason });
}

function parsePolicy(merge: unknown): ReturnType<typeof parseInstallation> {
  return parseInstallation({
    ...validV2,
    policy: { ...validV2.policy, merge },
  });
}

/**
 * True when some parse error names the field without echoing `rejected`.
 * The echo probe is the JSON-encoded value, so whitespace values (whose text
 * appears in ordinary message prose) do not produce false positives.
 */
function parseRefusalNamesFieldWithoutEchoing(
  parsed: ReturnType<typeof parseInstallation>,
  rejected: unknown,
): boolean {
  if (parsed.ok) {
    return false;
  }
  const joined = parsed.errors.join('\n');
  const echoed = JSON.stringify(rejected) ?? String(rejected);
  return parsed.errors.length > 0 && joined.includes('premergePosterLogin') && !joined.includes(echoed);
}

describe('parseInstallation premergePosterLogin', () => {
  it('the parsed installation omits premergePosterLogin when the written entry omits the key', () => {
    const parsed = parsePolicy({ repos: { 'owner/repo': { projectId: 'p' } } });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('; '));
    }
    const { model } = deriveInstallationModel(parsed.installation);
    const repo = model.policy?.merge?.repos?.['owner/repo'];
    expect(repo).toEqual({ projectId: 'p' });
    expect(Object.hasOwn(repo ?? {}, 'premergePosterLogin')).toBe(false);
  });

  it('the parsed installation carries a written valid premergePosterLogin verbatim', () => {
    const parsed = parsePolicy({
      repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: 'octocat' } },
    });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('; '));
    }
    const { model } = deriveInstallationModel(parsed.installation);
    expect(model.policy?.merge?.repos?.['owner/repo']).toEqual({
      projectId: 'p',
      premergePosterLogin: 'octocat',
    });
  });

  it('refuses null premergePosterLogin with a typed error naming the field and not the value', () => {
    const parsed = parsePolicy({
      repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: null } },
    });
    expect(parsed.ok).toBe(false);
    expect(parseRefusalNamesFieldWithoutEchoing(parsed, null)).toBe(true);
    if (!parsed.ok) {
      expect(parsed.errors.some((error) => error.includes('must be a string'))).toBe(true);
    }
  });

  it('refuses explicit undefined premergePosterLogin with a typed error naming the field', () => {
    const entry: Record<string, unknown> = { projectId: 'p' };
    Object.defineProperty(entry, 'premergePosterLogin', {
      enumerable: true,
      value: undefined,
    });
    const parsed = parsePolicy({ repos: { 'owner/repo': entry } });
    expect(parsed.ok).toBe(false);
    expect(parseRefusalNamesFieldWithoutEchoing(parsed, undefined)).toBe(true);
    if (!parsed.ok) {
      expect(parsed.errors.some((error) => error.includes('must be a string'))).toBe(true);
    }
  });

  it('refuses non-string, array, and array-like premergePosterLogin values with typed errors naming the field', () => {
    for (const value of [123, true, [], { length: 1, 0: 'a' }]) {
      const parsed = parsePolicy({
        repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: value } },
      });
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
      expect(
        parseRefusalNamesFieldWithoutEchoing(parsed, value),
        JSON.stringify(value),
      ).toBe(true);
    }
  });

  it('refuses an empty string premergePosterLogin as an invalid GitHub login', () => {
    const parsed = parsePolicy({
      repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: '' } },
    });
    expect(parsed.ok).toBe(false);
    expect(parseRefusalNamesFieldWithoutEchoing(parsed, '')).toBe(true);
    if (!parsed.ok) {
      expect(parsed.errors.some((error) => error.includes('must be a valid GitHub login'))).toBe(true);
    }
  });

  it('refuses whitespace in premergePosterLogin as an invalid GitHub login', () => {
    for (const value of [' ', 'octo cat', '\t']) {
      const parsed = parsePolicy({
        repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: value } },
      });
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
      expect(parseRefusalNamesFieldWithoutEchoing(parsed, value), JSON.stringify(value)).toBe(true);
      if (!parsed.ok) {
        expect(
          parsed.errors.some((error) => error.includes('must be a valid GitHub login')),
          JSON.stringify(value),
        ).toBe(true);
      }
    }
  });

  it('refuses a 40-character and an enormous premergePosterLogin in O(1) without echoing the value', () => {
    // Cost bound: `isValidGithubLogin` checks `value.length` (O(1)) before the
    // regex runs, so the 100,000-character value never reaches the pattern.
    for (const value of ['x'.repeat(40), 'x'.repeat(100_000)]) {
      const parsed = parsePolicy({
        repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: value } },
      });
      expect(parsed.ok, `length ${value.length}`).toBe(false);
      expect(parseRefusalNamesFieldWithoutEchoing(parsed, value), `length ${value.length}`).toBe(true);
    }
  });

  it('refuses a leading or trailing hyphen in premergePosterLogin', () => {
    for (const value of ['-octo', 'octo-', '-']) {
      const parsed = parsePolicy({
        repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: value } },
      });
      expect(parsed.ok, JSON.stringify(value)).toBe(false);
      expect(parseRefusalNamesFieldWithoutEchoing(parsed, value), JSON.stringify(value)).toBe(true);
      if (!parsed.ok) {
        expect(
          parsed.errors.some((error) => error.includes('must be a valid GitHub login')),
          JSON.stringify(value),
        ).toBe(true);
      }
    }
  });

  it('refuses __proto__ as a premergePosterLogin value and as an own property key', () => {
    // As a value: `_` is outside the GitHub login alphabet.
    const asValue = parsePolicy({
      repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: '__proto__' } },
    });
    expect(asValue.ok).toBe(false);
    expect(parseRefusalNamesFieldWithoutEchoing(asValue, '__proto__')).toBe(true);

    // As an own property key: outside the `MERGE_REPO_KEYS` allowlist.
    const entry: Record<string, unknown> = { projectId: 'p' };
    Object.defineProperty(entry, '__proto__', { enumerable: true, value: 'x' });
    const asKey = parsePolicy({ repos: { 'owner/repo': entry } });
    expect(asKey.ok).toBe(false);
    if (!asKey.ok) {
      expect(asKey.errors.some((error) => error.includes('unknown key'))).toBe(true);
    }
  });

  it('refuses a getter-bearing premergePosterLogin without invoking the getter', () => {
    // A throwing getter: if the implementation ever read the value through the
    // getter, `parseInstallation` would throw instead of returning a refusal.
    const throwing: Record<string, unknown> = { projectId: 'p' };
    Object.defineProperty(throwing, 'premergePosterLogin', {
      enumerable: true,
      get() {
        throw new Error('getter ran');
      },
    });
    expect(() => parsePolicy({ repos: { 'owner/repo': throwing } })).not.toThrow();
    const refused = parsePolicy({ repos: { 'owner/repo': throwing } });
    expect(refused.ok).toBe(false);

    // A counting getter returning a perfectly valid login: the refusal must
    // still happen and the invocation count must stay at zero.
    let calls = 0;
    const counting: Record<string, unknown> = { projectId: 'p' };
    Object.defineProperty(counting, 'premergePosterLogin', {
      enumerable: true,
      get() {
        calls += 1;
        return 'octocat';
      },
    });
    const parsed = parsePolicy({ repos: { 'owner/repo': counting } });
    expect(parsed.ok).toBe(false);
    expect(calls).toBe(0);
    if (!parsed.ok) {
      expect(parsed.errors.some((error) => error.includes('must be a string'))).toBe(true);
    }
  });

  it('refuses a secret-shaped premergePosterLogin naming the field and never the value', () => {
    // Built from parts so no credential-shaped literal appears in this file.
    const value = `ghp_${'a'.repeat(36)}`;
    const parsed = parsePolicy({
      repos: { 'owner/repo': { projectId: 'p', premergePosterLogin: value } },
    });
    expect(parsed.ok).toBe(false);
    expect(parseRefusalNamesFieldWithoutEchoing(parsed, value)).toBe(true);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((error) => error.includes('must not contain secret-shaped text')),
      ).toBe(true);
    }
  });
});

describe('resolveMergePolicy premergePosterLogin', () => {
  it('resolves an absent premergePosterLogin to no own property and preserves the golden mergePolicyRevision', () => {
    const resolved = expectResolved(resolveMergePolicy(reposWith({ projectId: 'p' })));
    expect(resolved.repositories).toHaveLength(1);
    const repo = resolved.repositories[0];
    expect(Object.hasOwn(repo, 'premergePosterLogin')).toBe(false);
    expect(repo.premergePosterLogin).toBeUndefined();

    // The digest over the resolved entry is byte-identical to the digest over
    // the pre-EV1a golden shape, which never carried the key.
    const golden = { repositories: [repository()], daemon: daemonDefaults };
    expect(canonicalMergePolicyJson({ repositories: [repo], daemon: daemonDefaults })).toBe(
      canonicalMergePolicyJson(golden),
    );
    expect(resolved.policyRevision).toBe(mergePolicyRevision(golden));
  });

  it('resolves a written premergePosterLogin to the written string and changes mergePolicyRevision versus absent', () => {
    const login39 = `o${'c'.repeat(37)}t`;
    for (const login of ['octocat', 'a', 'fleet-bot-1', login39]) {
      const resolved = expectResolved(
        resolveMergePolicy(reposWith({ projectId: 'p', premergePosterLogin: login })),
      );
      expect(resolved.repositories[0].premergePosterLogin, login).toBe(login);
      expect(resolved.policyRevision, login).not.toBe(
        expectResolved(resolveMergePolicy(reposWith({ projectId: 'p' }))).policyRevision,
      );
      expect(Object.isFrozen(resolved.repositories[0])).toBe(true);
    }
  });

  it('refuses invalid premergePosterLogin values with policy-merge-invalid', () => {
    const login39PlusOne = `o${'c'.repeat(38)}t`;
    const values: readonly unknown[] = [
      null,
      undefined,
      123,
      true,
      [],
      { length: 1, 0: 'a' },
      '',
      ' ',
      'octo cat',
      '\t',
      'x'.repeat(40),
      'x'.repeat(100_000),
      '-octo',
      'octo-',
      '-',
      '__proto__',
      login39PlusOne,
    ];
    for (const value of values) {
      expectInvalid(
        resolveMergePolicy(reposWith({ projectId: 'p', premergePosterLogin: value })),
        'policy-merge-invalid',
      );
    }
  });

  it('refuses a secret-shaped premergePosterLogin with policy-secret-shape', () => {
    const value = `ghp_${'a'.repeat(36)}`;
    expectInvalid(
      resolveMergePolicy(reposWith({ projectId: 'p', premergePosterLogin: value })),
      'policy-secret-shape',
    );
  });

  it('refuses a getter-bearing premergePosterLogin without invoking the getter and without throwing', () => {
    const entry: Record<string, unknown> = { projectId: 'p' };
    Object.defineProperty(entry, 'premergePosterLogin', {
      enumerable: true,
      get() {
        throw new Error('getter ran');
      },
    });
    expect(() => resolveMergePolicy(reposWith(entry))).not.toThrow();
    expectInvalid(resolveMergePolicy(reposWith(entry)), 'policy-merge-invalid');
  });

  it('refuses an own __proto__ property key with policy-merge-invalid', () => {
    const entry: Record<string, unknown> = { projectId: 'p' };
    Object.defineProperty(entry, '__proto__', { enumerable: true, value: 'x' });
    expectInvalid(resolveMergePolicy(reposWith(entry)), 'policy-merge-invalid');
  });

  it('refuses a non-plain-object repository entry and an unreadable top-level policy', () => {
    const instance = new (class Repository {})();
    expectInvalid(resolveMergePolicy(reposWith(instance)), 'policy-merge-invalid');

    const classInstance = new (class Policy {})() as PolicySection;
    expectInvalid(resolveMergePolicy(classInstance), 'policy-unreadable');
  });
});
