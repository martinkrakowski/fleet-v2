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
    expect(read.daemon).toEqual({ intervalSeconds: 120, budgetSeconds: 100, settleSeconds: 0, chainRefresh: 'shadow' });

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
    expect(boundary.daemon).toEqual({ intervalSeconds: 10, budgetSeconds: 5, settleSeconds: 20, chainRefresh: 'shadow' });
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
      '{"daemon":{"budgetSeconds":45,"chainRefresh":"shadow","intervalSeconds":60,"settleSeconds":20},' +
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
    expect(read.daemon).toEqual({ ...daemon, chainRefresh: 'shadow' });
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
