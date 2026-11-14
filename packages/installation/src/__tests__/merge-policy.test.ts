import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';
import {
  canonicalMergePolicyJson,
  mergePolicyRevision,
  readProjectPrepareArgv,
  resolveMergePolicy,
} from '../policy.js';
import { loadInstallation, requireValidInstallationModel } from '../load.js';
import { writeInstallationV2 } from '../write.js';
import type {
  FleetInstallationV2,
  MergePolicyRead,
  PolicySection,
  ProjectPrepareArgvRead,
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

const fullRepository = {
  projectId: 'project-a',
  shadow: false,
  unattended: true,
  requiredContexts: ['premerge', 'gate', 'lint'],
  updateBranch: true,
  macosProcedure: 'macos-smoke',
  maxAttempts: 12,
  checksGraceMinutes: 90,
  veto: { mode: 'live', holdConfidence: 0.65 },
};

function policyWith(merge: unknown, daemon?: unknown): PolicySection {
  return {
    ...(merge !== undefined ? { merge } : {}),
    ...(daemon !== undefined ? { daemon } : {}),
  } as PolicySection;
}

function reposWith(entry: unknown, key = 'owner/repo'): PolicySection {
  return policyWith({ repos: { [key]: entry } });
}

function expectInvalid(read: MergePolicyRead, reason: string): void {
  expect(read).toEqual({ outcome: 'invalid', reason });
}

function expectResolved(read: MergePolicyRead): Extract<MergePolicyRead, { outcome: 'resolved' }> {
  if (read.outcome !== 'resolved') {
    throw new Error(`expected resolved, got ${read.reason}`);
  }
  return read;
}

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

const daemonDefaults: ResolvedMergeDaemonPolicy = {
  intervalSeconds: 60,
  budgetSeconds: 45,
  settleSeconds: 20,
  chainRefresh: 'shadow',
  stallAfterMinutes: 30,
  autoResumeMax: 2,
};

describe('resolveMergePolicy', () => {
  it('resolveMergePolicy applies the documented defaults when policy.merge and policy.daemon are absent', () => {
    const read = expectResolved(resolveMergePolicy({}));
    expect(read.repositories).toEqual([]);
    expect(read.daemon).toEqual(daemonDefaults);
    expect(read.policyRevision).toMatch(/^[0-9a-f]{12}$/);

    const minimal = expectResolved(resolveMergePolicy(reposWith({ projectId: 'p' })));
    expect(minimal.repositories).toEqual([repository()]);
    expect(minimal.daemon).toEqual(daemonDefaults);
    expect(Object.isFrozen(minimal)).toBe(true);
    expect(Object.isFrozen(minimal.repositories)).toBe(true);
    expect(Object.isFrozen(minimal.repositories[0].requiredContexts)).toBe(true);
    expect(Object.isFrozen(minimal.daemon)).toBe(true);
  });

  it('resolveMergePolicy keeps every value the installation wrote', () => {
    const read = expectResolved(
      resolveMergePolicy(
        policyWith(
          { repos: { 'zeta/last': { projectId: 'p-z' }, 'Acme-1/web.app_2': fullRepository } },
          { intervalSeconds: 120, budgetSeconds: 100, settleSeconds: 0 },
        ),
      ),
    );
    expect(read.repositories).toEqual([
      {
        owner: 'Acme-1',
        repo: 'web.app_2',
        repositoryKey: 'Acme-1/web.app_2',
        projectId: 'project-a',
        shadow: false,
        unattended: true,
        requiredContexts: ['premerge', 'gate', 'lint'],
        updateBranch: true,
        macosProcedure: 'macos-smoke',
        maxAttempts: 12,
        checksGraceMinutes: 90,
        veto: { mode: 'live', holdConfidence: 0.65 },
      },
      repository({ owner: 'zeta', repo: 'last', repositoryKey: 'zeta/last', projectId: 'p-z' }),
    ]);
    expect(read.daemon).toEqual({ intervalSeconds: 120, budgetSeconds: 100, settleSeconds: 0, chainRefresh: 'shadow', stallAfterMinutes: 30, autoResumeMax: 2 });

    const boundary = expectResolved(
      resolveMergePolicy(
        policyWith(
          {
            repos: {
              'o/r': {
                projectId: 'x'.repeat(128),
                requiredContexts: ['c'.repeat(64)],
                macosProcedure: 'm'.repeat(200),
                maxAttempts: 32,
                checksGraceMinutes: 1440,
                veto: { holdConfidence: 0 },
              },
            },
          },
          { intervalSeconds: 10, budgetSeconds: 5 },
        ),
      ),
    );
    expect(boundary.repositories[0].veto).toEqual({ mode: 'off', holdConfidence: 0 });
    expect(boundary.daemon).toEqual({ intervalSeconds: 10, budgetSeconds: 5, settleSeconds: 20, chainRefresh: 'shadow', stallAfterMinutes: 30, autoResumeMax: 2 });
  });

  const malformedMerge: readonly (readonly [string, unknown, string?])[] = [
    ['projectId missing', { shadow: true }],
    ['projectId blank', { projectId: '   ' }],
    ['projectId empty', { projectId: '' }],
    ['projectId too long', { projectId: 'x'.repeat(129) }],
    ['projectId not a string', { projectId: 7 }],
    ['shadow not a boolean', { projectId: 'p', shadow: 'yes' }],
    ['unattended not a boolean', { projectId: 'p', unattended: 1 }],
    ['updateBranch not a boolean', { projectId: 'p', updateBranch: null }],
    ['requiredContexts empty', { projectId: 'p', requiredContexts: [] }],
    ['requiredContexts not an array', { projectId: 'p', requiredContexts: 'gate' }],
    ['requiredContexts holds a non-string', { projectId: 'p', requiredContexts: ['gate', 3] }],
    ['requiredContexts holds a blank', { projectId: 'p', requiredContexts: ['gate', ' '] }],
    ['requiredContexts holds a duplicate', { projectId: 'p', requiredContexts: ['gate', 'gate'] }],
    ['requiredContexts holds a long name', { projectId: 'p', requiredContexts: ['c'.repeat(65)] }],
    [
      'requiredContexts holds too many',
      { projectId: 'p', requiredContexts: Array.from({ length: 17 }, (_, index) => `c${index}`) },
    ],
    ['maxAttempts 0', { projectId: 'p', maxAttempts: 0 }],
    ['maxAttempts 33', { projectId: 'p', maxAttempts: 33 }],
    ['maxAttempts not an integer', { projectId: 'p', maxAttempts: 2.5 }],
    ['maxAttempts a string', { projectId: 'p', maxAttempts: '9' }],
    ['checksGraceMinutes 0', { projectId: 'p', checksGraceMinutes: 0 }],
    ['checksGraceMinutes 1441', { projectId: 'p', checksGraceMinutes: 1441 }],
    ['veto.mode unknown', { projectId: 'p', veto: { mode: 'sometimes' } }],
    ['veto.holdConfidence 1.5', { projectId: 'p', veto: { holdConfidence: 1.5 } }],
    ['veto.holdConfidence NaN', { projectId: 'p', veto: { holdConfidence: Number.NaN } }],
    ['veto.holdConfidence negative', { projectId: 'p', veto: { holdConfidence: -0.1 } }],
    ['veto not an object', { projectId: 'p', veto: 'live' }],
    ['veto unknown key', { projectId: 'p', veto: { mode: 'off', extra: true } }],
    ['macosProcedure blank', { projectId: 'p', macosProcedure: '  ' }],
    ['macosProcedure too long', { projectId: 'p', macosProcedure: 'm'.repeat(201) }],
    ['macosProcedure not a string', { projectId: 'p', macosProcedure: null }],
    ['repository entry unknown key', { projectId: 'p', branchPrefix: 'x' }],
    ['repository entry not an object', 'project-a'],
    ['repository entry null', null],
    ['repository entry an array', []],
  ];

  it('resolveMergePolicy refuses a malformed merge section', () => {
    for (const [name, entry] of malformedMerge) {
      expect([name, resolveMergePolicy(reposWith(entry))]).toEqual([
        name,
        { outcome: 'invalid', reason: 'policy-merge-invalid' },
      ]);
    }
    for (const key of ['owner/repo/extra', 'owner', 'own er/repo', '/repo', 'owner/', 'a/..', '../b', 'o/r?']) {
      expect([key, resolveMergePolicy(reposWith({ projectId: 'p' }, key))]).toEqual([
        key,
        { outcome: 'invalid', reason: 'policy-merge-invalid' },
      ]);
    }
    expect(resolveMergePolicy(reposWith({ projectId: 'p' }, `${'o'.repeat(101)}/repo`))).toEqual({
      outcome: 'invalid',
      reason: 'policy-merge-invalid',
    });
    for (const merge of [null, 'repos', [], 3, { repos: [] }, { repos: null }, { other: {} }]) {
      expectInvalid(resolveMergePolicy(policyWith(merge)), 'policy-merge-invalid');
    }
  });

  it('resolveMergePolicy refuses a malformed daemon section', () => {
    const malformedDaemon: readonly unknown[] = [
      { intervalSeconds: 9 },
      { intervalSeconds: 3601 },
      { budgetSeconds: 4 },
      { budgetSeconds: 601 },
      { intervalSeconds: 60, budgetSeconds: 60 },
      { intervalSeconds: 60, budgetSeconds: 61 },
      { intervalSeconds: 30 },
      { settleSeconds: -1 },
      { settleSeconds: 601 },
      { intervalSeconds: '60' },
      { budgetSeconds: null },
      { settleSeconds: 1.5 },
      { intervalSeconds: Number.NaN },
      { tickSeconds: 60 },
      null,
      'daemon',
      [],
    ];
    for (const daemon of malformedDaemon) {
      expect([daemon, resolveMergePolicy(policyWith(undefined, daemon ?? null))]).toEqual([
        daemon,
        { outcome: 'invalid', reason: 'policy-daemon-invalid' },
      ]);
    }
  });

  it('resolveMergePolicy refuses a policy that is null, a non-object or an array', () => {
    for (const policy of [undefined, null, 'policy', 7, true, [], [{ merge: {} }]]) {
      expectInvalid(resolveMergePolicy(policy as unknown as PolicySection), 'policy-unreadable');
    }
  });

  it('resolveMergePolicy refuses a policy whose getter throws', () => {
    const policy = {};
    Object.defineProperty(policy, 'merge', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    expect(() => resolveMergePolicy(policy as PolicySection)).not.toThrow();
    expectInvalid(resolveMergePolicy(policy as PolicySection), 'policy-merge-invalid');

    const daemonGetter = {};
    Object.defineProperty(daemonGetter, 'daemon', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    expectInvalid(resolveMergePolicy(daemonGetter as PolicySection), 'policy-daemon-invalid');

    const entry = { projectId: 'p' };
    Object.defineProperty(entry, 'maxAttempts', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    expectInvalid(resolveMergePolicy(reposWith(entry)), 'policy-merge-invalid');

    const nested = { repos: {} };
    Object.defineProperty(nested.repos, 'owner/repo', {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    expectInvalid(resolveMergePolicy(policyWith(nested)), 'policy-merge-invalid');

    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap ran');
        },
      },
    );
    expectInvalid(resolveMergePolicy(proxy as PolicySection), 'policy-unreadable');
  });

  it('resolveMergePolicy refuses a sparse requiredContexts array', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = ['gate', , 'premerge'] as unknown as string[];
    expectInvalid(
      resolveMergePolicy(reposWith({ projectId: 'p', requiredContexts: sparse })),
      'policy-merge-invalid',
    );
    const holey = new Array<string>(2);
    holey[0] = 'gate';
    expectInvalid(
      resolveMergePolicy(reposWith({ projectId: 'p', requiredContexts: holey })),
      'policy-merge-invalid',
    );
  });

  it('resolveMergePolicy refuses a secret-shaped projectId', () => {
    const secret = `sk-${'a1'.repeat(15)}`;
    expectInvalid(resolveMergePolicy(reposWith({ projectId: secret })), 'policy-secret-shape');
    expectInvalid(
      resolveMergePolicy(reposWith({ projectId: 'p', requiredContexts: [secret] })),
      'policy-secret-shape',
    );
    expectInvalid(
      resolveMergePolicy(reposWith({ projectId: 'p', macosProcedure: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ') })),
      'policy-secret-shape',
    );
    expectInvalid(resolveMergePolicy(reposWith({ projectId: 'p' }, `${secret}/repo`)), 'policy-secret-shape');
    expect(JSON.stringify(resolveMergePolicy(reposWith({ projectId: secret })))).not.toContain(secret);
  });

  it('resolveMergePolicy refuses more than 256 repositories', () => {
    const repos = (count: number): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`owner/repo-${index}`, { projectId: 'p' }]));
    expectInvalid(resolveMergePolicy(policyWith({ repos: repos(257) })), 'policy-too-large');
    const atBound = expectResolved(resolveMergePolicy(policyWith({ repos: repos(256) })));
    expect(atBound.repositories).toHaveLength(256);
  });

  it('resolveMergePolicy answers invalid for a policy that was not parsed', () => {
    const handBuilt = {
      merge: { repos: { 'owner/repo': { projectId: 'p', shadow: 'maybe' } } },
      daemon: { intervalSeconds: 60 },
      liveTail: { content: 'full' },
    } as unknown as PolicySection;
    expect(() => resolveMergePolicy(handBuilt)).not.toThrow();
    expectInvalid(resolveMergePolicy(handBuilt), 'policy-merge-invalid');

    const withUnrelated = {
      merge: { repos: { 'owner/repo': { projectId: 'p' } } },
      liveTail: { content: 'full' },
    } as PolicySection;
    expect(expectResolved(resolveMergePolicy(withUnrelated)).repositories).toHaveLength(1);

    const classInstance = new (class Policy {})() as PolicySection;
    expectInvalid(resolveMergePolicy(classInstance), 'policy-unreadable');
  });
});

describe('mergePolicyRevision', () => {
  it('mergePolicyRevision is stable for the same normalized sections', () => {
    const input = { repositories: [repository()], daemon: daemonDefaults };
    const first = mergePolicyRevision(input);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(mergePolicyRevision({ repositories: [repository()], daemon: { ...daemonDefaults } })).toBe(first);

    const written = policyWith(
      { repos: { 'b/two': { projectId: 'p' }, 'a/one': { projectId: 'q' } } },
      { settleSeconds: 5 },
    );
    const reordered = policyWith(
      { repos: { 'a/one': { projectId: 'q' }, 'b/two': { projectId: 'p' } } },
      { settleSeconds: 5 },
    );
    expect(expectResolved(resolveMergePolicy(written)).policyRevision).toBe(
      expectResolved(resolveMergePolicy(reordered)).policyRevision,
    );
    expect(expectResolved(resolveMergePolicy({})).policyRevision).toBe(
      mergePolicyRevision({ repositories: [], daemon: daemonDefaults }),
    );
    expect(
      expectResolved(resolveMergePolicy(reposWith({ projectId: 'p', requiredContexts: ['premerge', 'gate'] })))
        .policyRevision,
    ).toBe(expectResolved(resolveMergePolicy(reposWith({ projectId: 'p' }))).policyRevision);
  });

  it('mergePolicyRevision changes when any field changes', () => {
    const base = { repositories: [repository()], daemon: daemonDefaults };
    const baseRevision = mergePolicyRevision(base);
    const changes: readonly (readonly [string, Parameters<typeof mergePolicyRevision>[0]])[] = [
      ['projectId', { ...base, repositories: [repository({ projectId: 'other' })] }],
      ['shadow', { ...base, repositories: [repository({ shadow: false })] }],
      ['unattended', { ...base, repositories: [repository({ unattended: true })] }],
      ['requiredContexts', { ...base, repositories: [repository({ requiredContexts: ['gate'] })] }],
      ['updateBranch', { ...base, repositories: [repository({ updateBranch: true })] }],
      ['macosProcedure', { ...base, repositories: [repository({ macosProcedure: 'macos' })] }],
      ['maxAttempts', { ...base, repositories: [repository({ maxAttempts: 8 })] }],
      ['checksGraceMinutes', { ...base, repositories: [repository({ checksGraceMinutes: 31 })] }],
      ['veto.mode', { ...base, repositories: [repository({ veto: { mode: 'shadow', holdConfidence: 0.8 } })] }],
      ['veto.holdConfidence', { ...base, repositories: [repository({ veto: { mode: 'off', holdConfidence: 0.9 } })] }],
      [
        'repository set',
        {
          ...base,
          repositories: [
            repository(),
            repository({ owner: 'o2', repo: 'r2', repositoryKey: 'o2/r2' }),
          ],
        },
      ],
      ['repository removed', { ...base, repositories: [] }],
      ['intervalSeconds', { ...base, daemon: { ...daemonDefaults, intervalSeconds: 61 } }],
      ['budgetSeconds', { ...base, daemon: { ...daemonDefaults, budgetSeconds: 44 } }],
      ['settleSeconds', { ...base, daemon: { ...daemonDefaults, settleSeconds: 21 } }],
    ];
    const seen = new Set<string>([baseRevision]);
    for (const [name, input] of changes) {
      const revision = mergePolicyRevision(input);
      expect([name, revision === baseRevision]).toEqual([name, false]);
      seen.add(revision);
    }
    expect(seen.size).toBe(changes.length + 1);
  });

  it('canonicalMergePolicyJson sorts repositories and required contexts and carries no whitespace', () => {
    const json = canonicalMergePolicyJson({
      repositories: [
        repository({
          owner: 'zeta',
          repo: 'last',
          repositoryKey: 'zeta/last',
          requiredContexts: ['premerge', 'gate'],
        }),
        repository({ owner: 'alpha', repo: 'first', repositoryKey: 'alpha/first', macosProcedure: 'mac' }),
      ],
      daemon: daemonDefaults,
    });
    expect(json).toBe(
      '{"daemon":{"budgetSeconds":45,"intervalSeconds":60,"settleSeconds":20},' +
        '"merge":{"repos":{' +
        '"alpha/first":{"checksGraceMinutes":30,"macosProcedure":"mac","maxAttempts":9,"projectId":"p",' +
        '"requiredContexts":["gate","premerge"],"shadow":true,"unattended":false,"updateBranch":false,' +
        '"veto":{"holdConfidence":0.8,"mode":"off"}},' +
        '"zeta/last":{"checksGraceMinutes":30,"macosProcedure":null,"maxAttempts":9,"projectId":"p",' +
        '"requiredContexts":["gate","premerge"],"shadow":true,"unattended":false,"updateBranch":false,' +
        '"veto":{"holdConfidence":0.8,"mode":"off"}}}}}',
    );
    expect(json).not.toMatch(/\s/);
  });

  it('canonicalMergePolicyJson does not mutate its input', () => {
    const contexts = Object.freeze(['premerge', 'gate']);
    const repositories = Object.freeze([
      repository({ requiredContexts: contexts }),
      repository({ owner: 'a', repo: 'b', repositoryKey: 'a/b' }),
    ]);
    expect(() => canonicalMergePolicyJson({ repositories, daemon: daemonDefaults })).not.toThrow();
    expect(contexts).toEqual(['premerge', 'gate']);
    expect(repositories[0].repositoryKey).toBe('owner/repo');
  });
});

describe('the parsed installation', () => {
  const merge = {
    repos: {
      'example-owner/example-repo': {
        projectId: 'project-a',
        shadow: false,
        requiredContexts: ['gate', 'premerge', 'lint'],
        macosProcedure: 'macos-smoke',
        maxAttempts: 5,
        veto: { mode: 'shadow', holdConfidence: 0.7 },
      },
      'example-owner/other-repo': { projectId: 'project-b' },
    },
  };
  const daemon = { intervalSeconds: 90, budgetSeconds: 60, settleSeconds: 15 };

  function parsePolicy(policy: unknown): ReturnType<typeof parseInstallation> {
    return parseInstallation({ ...validV2, policy: { ...validV2.policy, ...(policy as object) } });
  }

  it('the parsed installation carries the merge and daemon sections', () => {
    const parsed = parsePolicy({ merge, daemon });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('; '));
    }
    const { model } = deriveInstallationModel(parsed.installation);
    expect(model.policy?.merge).toEqual(merge);
    expect(model.policy?.daemon).toEqual(daemon);

    const read = expectResolved(resolveMergePolicy(model.policy));
    expect(read.daemon).toEqual({ ...daemon, chainRefresh: 'shadow', stallAfterMinutes: 30, autoResumeMax: 2 });
    expect(read.repositories.map((entry) => entry.repositoryKey)).toEqual([
      'example-owner/example-repo',
      'example-owner/other-repo',
    ]);
    expect(read.repositories[0]).toEqual({
      owner: 'example-owner',
      repo: 'example-repo',
      repositoryKey: 'example-owner/example-repo',
      projectId: 'project-a',
      shadow: false,
      unattended: false,
      requiredContexts: ['gate', 'premerge', 'lint'],
      updateBranch: false,
      macosProcedure: 'macos-smoke',
      maxAttempts: 5,
      checksGraceMinutes: 30,
      veto: { mode: 'shadow', holdConfidence: 0.7 },
    });
    expect(read.repositories[1].shadow).toBe(true);

    const absent = parseInstallation(validV2);
    if (!absent.ok) {
      throw new Error(absent.errors.join('; '));
    }
    const absentRead = expectResolved(resolveMergePolicy(deriveInstallationModel(absent.installation).model.policy));
    expect(absentRead.repositories).toEqual([]);
    expect(absentRead.daemon).toEqual(daemonDefaults);
  });

  it('the parser refuses a file whose merge or daemon section is malformed, naming the field', () => {
    const cases: readonly (readonly [string, unknown, string])[] = [
      ['merge not an object', { merge: 'x' }, 'policy.merge: must be an object'],
      ['merge unknown key', { merge: { other: {} } }, 'policy.merge: unknown key'],
      ['repos not an object', { merge: { repos: [] } }, 'policy.merge.repos: must be an object'],
      [
        'repository key',
        { merge: { repos: { 'owner/repo/extra': { projectId: 'p' } } } },
        'policy.merge.repos[#0]: key must be <owner>/<repo>',
      ],
      [
        'projectId missing',
        { merge: { repos: { 'owner/repo': {} } } },
        'policy.merge.repos["owner/repo"].projectId: required',
      ],
      [
        'maxAttempts',
        { merge: { repos: { 'owner/repo': { projectId: 'p', maxAttempts: 33 } } } },
        'policy.merge.repos["owner/repo"].maxAttempts: must be an integer between 1 and 32',
      ],
      [
        'requiredContexts empty',
        { merge: { repos: { 'owner/repo': { projectId: 'p', requiredContexts: [] } } } },
        'policy.merge.repos["owner/repo"].requiredContexts: must hold 1 to 16 entries',
      ],
      [
        'unknown repository key',
        { merge: { repos: { 'owner/repo': { projectId: 'p', extra: 1 } } } },
        'policy.merge.repos["owner/repo"]: unknown key',
      ],
      [
        'veto mode',
        { merge: { repos: { 'owner/repo': { projectId: 'p', veto: { mode: 'sometimes' } } } } },
        'policy.merge.repos["owner/repo"].veto.mode: must be one of off, shadow, live',
      ],
      [
        'daemon budget',
        { daemon: { intervalSeconds: 60, budgetSeconds: 60 } },
        'policy.daemon.budgetSeconds: must be less than intervalSeconds',
      ],
      [
        'daemon interval below default budget',
        { daemon: { intervalSeconds: 30 } },
        'policy.daemon.budgetSeconds: must be less than intervalSeconds',
      ],
      [
        'daemon interval',
        { daemon: { intervalSeconds: 9 } },
        'policy.daemon.intervalSeconds: must be an integer between 10 and 3600',
      ],
      ['daemon unknown key', { daemon: { tickSeconds: 1 } }, 'policy.daemon: unknown key'],
      ['daemon not an object', { daemon: [] }, 'policy.daemon: must be an object'],
    ];
    for (const [name, policy, message] of cases) {
      const parsed = parsePolicy(policy);
      expect([name, parsed.ok ? [] : parsed.errors]).toEqual([name, [message]]);
    }
  });

  it('policy.daemon.chainRefresh: shadow resolves to shadow; live and unknown values load with a warning and resolve to invalid', () => {
    const shadow = parsePolicy({ daemon: { chainRefresh: 'shadow' } });
    expect(shadow.ok).toBe(true);
    if (shadow.ok) {
      expect(shadow.warnings ?? []).toEqual([]);
    }
    expect(
      expectResolved(resolveMergePolicy(policyWith(undefined, { chainRefresh: 'shadow' }))).daemon.chainRefresh,
    ).toBe('shadow');
    expect(expectResolved(resolveMergePolicy(policyWith(undefined, {}))).daemon.chainRefresh).toBe('shadow');

    const live = parsePolicy({ daemon: { chainRefresh: 'live' } });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.warnings ?? []).toEqual(['policy.daemon.chainRefresh: chain-refresh-mode-invalid']);
      expect(live.installation.policy?.daemon).toMatchObject({ chainRefresh: 'live' });
    }
    expect(
      expectResolved(resolveMergePolicy(policyWith(undefined, { chainRefresh: 'live' }))).daemon.chainRefresh,
    ).toBe('invalid');

    for (const value of ['sometimes', 1, null, true, '']) {
      const unknown = parsePolicy({ daemon: { chainRefresh: value } });
      expect(unknown.ok).toBe(true);
      if (unknown.ok) {
        // The warning names the key and the reason code, never the value.
        expect(unknown.warnings ?? []).toEqual(['policy.daemon.chainRefresh: chain-refresh-mode-invalid']);
        if (value !== '') {
          expect((unknown.warnings ?? []).join(' ')).not.toContain(String(value));
        }
        // The raw value round-trips untouched.
        expect(unknown.installation.policy?.daemon).toMatchObject({ chainRefresh: value });
      }
      expect(
        expectResolved(resolveMergePolicy(policyWith(undefined, { chainRefresh: value }))).daemon.chainRefresh,
      ).toBe('invalid');
    }
  });

  it('PT1a: policy.daemon.stallAfterMinutes defaults to 30, takes 1..1440, reads anything else as 30 with a warning, and leaves the policy revision alone', () => {
    expect(expectResolved(resolveMergePolicy(policyWith(undefined, {}))).daemon.stallAfterMinutes).toBe(30);
    for (const value of [1, 45, 1440]) {
      const parsed = parsePolicy({ daemon: { stallAfterMinutes: value } });
      expect(parsed.ok).toBe(true);
      expect(
        expectResolved(resolveMergePolicy(policyWith(undefined, { stallAfterMinutes: value }))).daemon
          .stallAfterMinutes,
      ).toBe(value);
    }
    // Like chainRefresh: a bad value is a warning naming the key and a code (never the value); the
    // installation loads, the raw value is kept, and the policy resolves with the default, never refused.
    for (const value of [0, 1441, -3, 2.5, '30', null, true, 'sometimes']) {
      const parsed = parsePolicy({ daemon: { stallAfterMinutes: value } });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.warnings ?? []).toEqual(['policy.daemon.stallAfterMinutes: stall-after-minutes-invalid']);
        expect((parsed.warnings ?? []).join(' ')).not.toContain('sometimes');
        expect(parsed.installation.policy?.daemon).toMatchObject({ stallAfterMinutes: value });
      }
      const read = expectResolved(resolveMergePolicy(policyWith(undefined, { stallAfterMinutes: value })));
      expect(read.daemon.stallAfterMinutes).toBe(30);
    }
    const valid = parsePolicy({ daemon: { stallAfterMinutes: 45 } });
    expect(valid.ok && (valid.warnings ?? [])).toEqual([]);
    const base = expectResolved(resolveMergePolicy(policyWith(undefined, {})));
    const changed = expectResolved(resolveMergePolicy(policyWith(undefined, { stallAfterMinutes: 90 })));
    expect(changed.policyRevision).toBe(base.policyRevision);
  });

  it('PT1b1: policy.daemon.autoResumeMax defaults to 2, takes 0..32, reads anything else as 2 with a warning, and leaves the policy revision alone', () => {
    expect(expectResolved(resolveMergePolicy(policyWith(undefined, {}))).daemon.autoResumeMax).toBe(2);
    // `0` and `32` are valid bounds: `0` means never auto-resume.
    for (const value of [0, 1, 2, 31, 32]) {
      const parsed = parsePolicy({ daemon: { autoResumeMax: value } });
      expect(parsed.ok).toBe(true);
      expect(
        expectResolved(resolveMergePolicy(policyWith(undefined, { autoResumeMax: value }))).daemon
          .autoResumeMax,
      ).toBe(value);
    }
    // Like stallAfterMinutes: a bad value is a warning naming the key and a code (never the
    // value); the installation loads, the raw value is kept, and the policy resolves fail-closed
    // to `0` (never auto-resume), never refused and never the permissive default.
    for (const value of [-1, 33, 2.5, '2', null, true, 'plenty']) {
      const parsed = parsePolicy({ daemon: { autoResumeMax: value } });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.warnings ?? []).toEqual(['policy.daemon.autoResumeMax: auto-resume-max-invalid']);
        expect((parsed.warnings ?? []).join(' ')).not.toContain('plenty');
        expect(parsed.installation.policy?.daemon).toMatchObject({ autoResumeMax: value });
      }
      const read = expectResolved(resolveMergePolicy(policyWith(undefined, { autoResumeMax: value })));
      expect(read.daemon.autoResumeMax).toBe(0);
    }
    const valid = parsePolicy({ daemon: { autoResumeMax: 5 } });
    expect(valid.ok && (valid.warnings ?? [])).toEqual([]);
    const base = expectResolved(resolveMergePolicy(policyWith(undefined, {})));
    const changed = expectResolved(resolveMergePolicy(policyWith(undefined, { autoResumeMax: 9 })));
    expect(changed.policyRevision).toBe(base.policyRevision);
  });

  it('the parser never echoes a secret-shaped repository key or value', () => {
    const secret = `sk-${'a1'.repeat(15)}`;
    const keyed = parsePolicy({ merge: { repos: { [`${secret}/repo`]: { projectId: 'p' } } } });
    const valued = parsePolicy({ merge: { repos: { 'owner/repo': { projectId: secret } } } });
    for (const parsed of [keyed, valued]) {
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(secret);
    }
  });
});

describe('per-project prepare argv policy (CO22)', () => {
  const repoKey = 'acme/web';
  const projectId = 'proj-web';

  function expectInvalidRead(read: ProjectPrepareArgvRead, reason: string): void {
    expect(read).toEqual({ outcome: 'invalid', reason });
  }

  function expectResolvedRead(read: ProjectPrepareArgvRead): Extract<ProjectPrepareArgvRead, { outcome: 'resolved' }> {
    if (read.outcome !== 'resolved') {
      throw new Error(`expected resolved, got ${read.reason}`);
    }
    return read;
  }

  /** The minimal v2 file with one merge repository entry carrying the given prepare argv. */
  function v2WithPrepare(prepare: unknown): Record<string, unknown> {
    return {
      ...validV2,
      policy: {
        ...validV2.policy,
        merge: { repos: { [repoKey]: { projectId, ...(prepare !== undefined ? { prepare } : {}) } } },
      },
    };
  }

  function parseWithPrepare(prepare: unknown): ReturnType<typeof parseInstallation> {
    return parseInstallation(v2WithPrepare(prepare));
  }

  it('parses, writes, resolves, and reads a valid per-project prepare argv as a frozen array and updates mergePolicyRevision', () => {
    const argv = ['yarn', 'install', '--immutable'];
    const parsed = parseWithPrepare(argv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('; '));
    }
    const model = requireValidInstallationModel(parsed.installation);
    expect(model.policy?.merge?.repos?.[repoKey]).toEqual({ projectId, prepare: argv });

    // The writer preserves the argv (round trip), and re-parsing the written
    // text gives the same model — never a shell string.
    const written = writeInstallationV2(parsed.installation as FleetInstallationV2);
    expect(JSON.parse(written).policy.merge.repos[repoKey].prepare).toEqual(argv);
    const reparsed = parseInstallation(JSON.parse(written));
    expect(reparsed.ok).toBe(true);

    const policy = model.policy;
    const resolved = expectResolved(resolveMergePolicy(policy));
    const entry = resolved.repositories.find((candidate) => candidate.repositoryKey === repoKey);
    expect(entry?.prepare).toEqual(argv);
    expect(Object.isFrozen(entry?.prepare)).toBe(true);

    const read = expectResolvedRead(readProjectPrepareArgv(policy, projectId));
    expect(read.repositoryKey).toBe(repoKey);
    expect(read.argv).toEqual(argv);
    expect(Object.isFrozen(read.argv)).toBe(true);
    expect(read.policyRevision).toBe(resolved.policyRevision);

    // The revision covers prepare: changing it changes the digest, so prepare
    // is neither ignored by canonical digesting nor replaced by a constant.
    const policyOf = (prepare: readonly string[]): PolicySection | undefined => {
      const attempt = parseWithPrepare(prepare);
      if (!attempt.ok) {
        throw new Error(attempt.errors.join('; '));
      }
      return requireValidInstallationModel(attempt.installation).policy;
    };
    const installRevision = expectResolved(resolveMergePolicy(policyOf(['yarn', 'install']))).policyRevision;
    const buildRevision = expectResolved(resolveMergePolicy(policyOf(['yarn', 'build']))).policyRevision;
    expect(installRevision).not.toBe(buildRevision);
  });

  it('keeps prepare optional when omitted and returns null argv from readProjectPrepareArgv', () => {
    const parsed = parseWithPrepare(undefined);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('; '));
    }
    const policy = requireValidInstallationModel(parsed.installation).policy;
    expect(policy?.merge?.repos?.[repoKey]).toEqual({ projectId });

    const resolved = expectResolved(resolveMergePolicy(policy));
    const entry = resolved.repositories.find((candidate) => candidate.repositoryKey === repoKey);
    expect(entry?.prepare).toBeUndefined();

    const read = expectResolvedRead(readProjectPrepareArgv(policy, projectId));
    expect(read).toEqual({
      outcome: 'resolved',
      projectId,
      repositoryKey: repoKey,
      argv: null,
      policyRevision: resolved.policyRevision,
    });

    // A project no repository names resolves with a null repository key too.
    const unmatched = expectResolvedRead(readProjectPrepareArgv(policy, 'other-project'));
    expect(unmatched.repositoryKey).toBeNull();
    expect(unmatched.argv).toBeNull();
  });

  it('refuses an empty prepare array in both parseInstallation and resolveMergePolicy', () => {
    const parsed = parseWithPrepare([]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([`${'policy.merge.repos'}["${repoKey}"].prepare: must hold 1 to 32 entries`]);
    }
    const entry = { projectId, prepare: [] };
    expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-merge-invalid');
    expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-merge-invalid');
  });

  it('refuses non-array prepare values including null, primitives, plain objects, and non-array iterables', () => {
    for (const value of [null, 'yarn build', 42, {}, true, new Set(['yarn'])]) {
      const entry = { projectId, prepare: value };
      const parsed = parseWithPrepare(value);
      expect([value, parsed.ok ? [] : parsed.errors]).toEqual([
        value,
        [`policy.merge.repos["${repoKey}"].prepare: must be an array`],
      ]);
      expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-merge-invalid');
      expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-merge-invalid');
    }
  });

  it('refuses prepare arrays containing non-string elements', () => {
    for (const value of [['yarn', 123], [null], [undefined], [{}]]) {
      const entry = { projectId, prepare: value };
      const parsed = parseWithPrepare(value);
      const field = `policy.merge.repos["${repoKey}"].prepare`;
      const index = (value as readonly unknown[]).indexOf(123) === 1 ? 1 : 0;
      expect([value, parsed.ok ? [] : parsed.errors]).toEqual([
        value,
        [`${field}[${index}]: must be a non-empty string`],
      ]);
      expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-merge-invalid');
      expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-merge-invalid');
    }
  });

  it('refuses prepare arrays containing empty or whitespace-only tokens', () => {
    for (const value of [[''], ['yarn', ''], ['yarn', '   ']]) {
      const entry = { projectId, prepare: value };
      const parsed = parseWithPrepare(value);
      const field = `policy.merge.repos["${repoKey}"].prepare`;
      const index = value.length === 1 ? 0 : 1;
      expect([value, parsed.ok ? [] : parsed.errors]).toEqual([
        value,
        [`${field}[${index}]: must be a non-empty string`],
      ]);
      expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-merge-invalid');
      expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-merge-invalid');
    }
  });

  it('refuses prepare tokens with shell metacharacters, whitespace, or control characters without echoing the token', () => {
    for (const token of ['install;rm', 'a&&b', 'a|b', '$HOME', '`id`', 'a>b', 'a b', 'a\nb', 'a\0b']) {
      const value = ['yarn', token];
      const parsed = parseWithPrepare(value);
      expect([token, parsed.ok ? [] : parsed.errors]).toEqual([
        token,
        [`policy.merge.repos["${repoKey}"].prepare[1]: must not contain whitespace, control characters or shell metacharacters`],
      ]);
      // The token itself is never echoed into the error text.
      expect((parsed.ok ? [] : parsed.errors).join(' ')).not.toContain(token);
      const entry = { projectId, prepare: value };
      expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-merge-invalid');
      expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-merge-invalid');
    }
  });

  it('refuses prepare executable tokens that start with a flag dash or traverse parent directories', () => {
    for (const argv of [['-c', 'yarn'], ['../bin/prep'], ['..']]) {
      const parsed = parseWithPrepare(argv);
      expect([argv, parsed.ok ? [] : parsed.errors]).toEqual([
        argv,
        [`policy.merge.repos["${repoKey}"].prepare[0]: must be an executable name or path without flag prefix or parent traversal`],
      ]);
      const entry = { projectId, prepare: argv };
      expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-merge-invalid');
      expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-merge-invalid');
    }
  });

  it('refuses prepare arrays exceeding 32 entries or 256 characters per token in bounded time', () => {
    const long = Array.from({ length: 33 }, (_, index) => (index === 0 ? 'yarn' : `step-${index}`));
    const parsed = parseWithPrepare(long);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([`policy.merge.repos["${repoKey}"].prepare: must hold 1 to 32 entries`]);
    }
    expectInvalid(resolveMergePolicy(reposWith({ projectId, prepare: long }, repoKey)), 'policy-merge-invalid');

    const wide = ['yarn', 'a'.repeat(257)];
    const wideParsed = parseWithPrepare(wide);
    expect(wideParsed.ok).toBe(false);
    if (!wideParsed.ok) {
      expect(wideParsed.errors).toEqual([`policy.merge.repos["${repoKey}"].prepare[1]: must be at most 256 characters`]);
    }
    expectInvalid(resolveMergePolicy(reposWith({ projectId, prepare: wide }, repoKey)), 'policy-merge-invalid');

    // An array-like with an enormous length is not an array at all: refused
    // in O(1) before any element scan.
    const huge = { length: 1_000_000_000, 0: 'yarn' };
    const hugeParsed = parseWithPrepare(huge);
    expect(hugeParsed.ok).toBe(false);
    if (!hugeParsed.ok) {
      expect(hugeParsed.errors).toEqual([`policy.merge.repos["${repoKey}"].prepare: must be an array`]);
    }
    expectInvalid(
      resolveMergePolicy(reposWith({ projectId, prepare: huge }, repoKey)),
      'policy-merge-invalid',
    );

    // The accepted bounds themselves still pass.
    expect(parseWithPrepare(Array.from({ length: 32 }, (_, index) => (index === 0 ? 'yarn' : `s${index}`))).ok).toBe(true);
    expect(parseWithPrepare(['yarn', 'a'.repeat(256)]).ok).toBe(true);
  });

  it('refuses sparse prepare arrays, element getters, and hostile proxies without throwing', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = ['yarn', , 'build'] as unknown as string[];
    const sparseParsed = parseWithPrepare(sparse);
    expect(sparseParsed.ok).toBe(false);
    if (!sparseParsed.ok) {
      expect(sparseParsed.errors).toEqual([`policy.merge.repos["${repoKey}"].prepare[1]: must be a non-empty string`]);
    }
    expectInvalid(resolveMergePolicy(reposWith({ projectId, prepare: sparse }, repoKey)), 'policy-merge-invalid');

    const withGetter = ['yarn', 'build'];
    Object.defineProperty(withGetter, 1, {
      enumerable: true,
      get: () => {
        throw new Error('getter ran');
      },
    });
    const getterParsed = parseWithPrepare(withGetter);
    expect(getterParsed.ok).toBe(false);
    if (!getterParsed.ok) {
      expect(getterParsed.errors).toEqual([`policy.merge.repos["${repoKey}"].prepare[1]: must be a non-empty string`]);
    }
    expect(() => resolveMergePolicy(reposWith({ projectId, prepare: withGetter }, repoKey))).not.toThrow();
    expectInvalid(resolveMergePolicy(reposWith({ projectId, prepare: withGetter }, repoKey)), 'policy-merge-invalid');

    const hostile = new Proxy(['yarn', 'build'], {
      getOwnPropertyDescriptor: () => {
        throw new Error('trap ran');
      },
    });
    expect(() => parseWithPrepare(hostile)).not.toThrow();
    expect(() => resolveMergePolicy(reposWith({ projectId, prepare: hostile }, repoKey))).not.toThrow();
    expectInvalidRead(
      readProjectPrepareArgv(reposWith({ projectId, prepare: hostile }, repoKey), projectId),
      'policy-unreadable',
    );
  });

  it('refuses secret-shaped prepare tokens with policy-secret-shape and never echoes the secret', () => {
    for (const token of ['ghp_1234567890abcdefghijklmnopqrstuvwx', 'sk-1234567890abcdefghijklmnop']) {
      const value = ['yarn', token];
      const parsed = parseWithPrepare(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors).toEqual([`policy.merge.repos["${repoKey}"].prepare[1]: must not look like a credential or secret`]);
        expect(parsed.errors.join(' ')).not.toContain(token);
      }
      const entry = { projectId, prepare: value };
      expectInvalid(resolveMergePolicy(reposWith(entry, repoKey)), 'policy-secret-shape');
      expectInvalidRead(readProjectPrepareArgv(reposWith(entry, repoKey), projectId), 'policy-secret-shape');
      expect(JSON.stringify(readProjectPrepareArgv(reposWith(entry, repoKey), projectId))).not.toContain(token);
    }
  });

  it('refuses invalid or ambiguous projectId in readProjectPrepareArgv', () => {
    const policy = reposWith({ projectId, prepare: ['yarn', 'install'] }, repoKey);
    const secret = `sk-${'a1'.repeat(15)}`;
    for (const [value, reason] of [
      ['', 'project-id-invalid'],
      ['  ', 'project-id-invalid'],
      [' padded ', 'project-id-invalid'],
      [42, 'project-id-invalid'],
      [null, 'project-id-invalid'],
      ['x'.repeat(129), 'project-id-invalid'],
      [secret, 'policy-secret-shape'],
    ] as const) {
      expect(() => readProjectPrepareArgv(policy, value as unknown as string)).not.toThrow();
      expectInvalidRead(readProjectPrepareArgv(policy, value as unknown as string), reason);
    }

    const ambiguous = policyWith({
      repos: {
        'acme/web': { projectId, prepare: ['yarn', 'install'] },
        'acme/other': { projectId, prepare: ['yarn', 'build'] },
      },
    });
    expectInvalidRead(readProjectPrepareArgv(ambiguous, projectId), 'project-id-ambiguous');

    // A hostile policy never throws.
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap ran');
        },
      },
    );
    expectInvalidRead(readProjectPrepareArgv(proxy as unknown as PolicySection, projectId), 'policy-unreadable');
  });

  describe('the load boundary refuses an installation whose prepare argv is invalid', () => {
    let tempDir: string;

    afterEach(() => {
      if (tempDir !== undefined) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('loadInstallation returns invalid with the prepare error and never loads the file', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'fleet-co22-'));
      const file = join(tempDir, 'fleet.json');
      writeFileSync(file, JSON.stringify(v2WithPrepare(['yarn', 'install;rm'])));
      const result = loadInstallation({ file, cwd: tempDir });
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.errors).toEqual([
          'policy.merge.repos["acme/web"].prepare[1]: must not contain whitespace, control characters or shell metacharacters',
        ]);
      }
    });

    it('loadInstallation loads a valid prepare argv into the model', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'fleet-co22-'));
      const file = join(tempDir, 'fleet.json');
      writeFileSync(file, JSON.stringify(v2WithPrepare(['yarn', 'install', '--immutable'])));
      const result = loadInstallation({ file, cwd: tempDir });
      expect(result.status).toBe('loaded');
      if (result.status === 'loaded') {
        expect(result.model.policy?.merge?.repos?.[repoKey]).toEqual({
          projectId,
          prepare: ['yarn', 'install', '--immutable'],
        });
        const read = expectResolvedRead(readProjectPrepareArgv(result.model.policy, projectId));
        expect(read.argv).toEqual(['yarn', 'install', '--immutable']);
      }
    });
  });
});
