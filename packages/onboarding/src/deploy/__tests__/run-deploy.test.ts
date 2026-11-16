import { describe, expect, it } from 'vitest';

import type { DeployProbes, DeployRequest, DeployResult } from '../types.js';
import { runCheckedDeploy } from '../run-deploy.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

function sampleRequest(overrides: Partial<DeployRequest> = {}): DeployRequest {
  return {
    repoPath: '/repo',
    commit: COMMIT_A,
    buildArgv: ['yarn', 'build'],
    suiteArgvs: [['yarn', 'test:unit'], ['yarn', 'test:integration']],
    stagingPath: '/staging',
    installLink: '/install',
    ...overrides,
  };
}

/**
 * Fake probes: every default passes and the deploy succeeds; individual
 * probes are overridden per test. Every call to every probe is recorded
 * in order for assertions.
 */
function fakeProbes(
  overrides: Partial<DeployProbes> = {},
  request: DeployRequest = sampleRequest(),
): { probes: DeployProbes; calls: string[] } {
  const calls: string[] = [];
  const probes: DeployProbes = {
    mergeInProgress: async (repoPath) => {
      calls.push(`mergeInProgress:${repoPath}`);
      return false;
    },
    headCommit: async (repoPath) => {
      calls.push(`headCommit:${repoPath}`);
      return request.commit;
    },
    runCommand: async (argv, cwd) => {
      calls.push(`runCommand:${cwd}:${argv.join(' ')}`);
      return { exitCode: 0 };
    },
    digestTree: async (path) => {
      calls.push(`digestTree:${path}`);
      return 'digest-ok';
    },
    currentTarget: async (link) => {
      calls.push(`currentTarget:${link}`);
      return undefined;
    },
    repoint: async (link, target) => {
      calls.push(`repoint:${link}:${target}`);
    },
    ...overrides,
  };
  return { probes, calls };
}

describe('runCheckedDeploy', () => {
  it('refuses a shell-string argv without calling probes', async () => {
    const { probes, calls } = fakeProbes();
    const result = await runCheckedDeploy(
      sampleRequest({ buildArgv: ['yarn build && echo pwned'] }),
      probes,
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
      detail: 'invalid-request',
    });
    expect(calls).toEqual([]);
  });

  it('refuses empty or malformed request fields and throwing getters', async () => {
    const { probes, calls } = fakeProbes();
    const cases: Array<Partial<DeployRequest> | (() => never)> = [
      sampleRequest({ repoPath: '' }),
      sampleRequest({ stagingPath: '   ' }),
      sampleRequest({ installLink: '' }),
      sampleRequest({ commit: 'zzzz' }),
      sampleRequest({ commit: 'a'.repeat(39) }),
      sampleRequest({ buildArgv: [] }),
      sampleRequest({ buildArgv: ['yarn', ''] }),
      sampleRequest({ suiteArgvs: [] }),
      sampleRequest({ suiteArgvs: [['yarn', '']] }),
    ];
    for (const bad of cases) {
      const result: DeployResult = await runCheckedDeploy(
        bad as DeployRequest,
        probes,
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
        detail: 'invalid-request',
      });
    }
    expect(calls).toEqual([]);
  });

  it('refuses a throwing getter on the request as invalid-request', async () => {
    const { probes, calls } = fakeProbes();
    const request = Object.create({
      get repoPath(): string {
        throw new Error('getter boom');
      },
    }) as unknown as DeployRequest;
    const result = await runCheckedDeploy(request, probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
      detail: 'invalid-request',
    });
    expect(calls).toEqual([]);
  });

  it('refuses when merge is in progress before the build and runs nothing else', async () => {
    const { probes, calls } = fakeProbes({
      mergeInProgress: async (repoPath) => {
        calls.push(`mergeInProgress:${repoPath}`);
        return true;
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'merge-in-progress',
      detail: 'merge-in-progress',
    });
    expect(calls).toEqual(['mergeInProgress:/repo']);
  });

  it('refuses on commit mismatch without running build or repoint', async () => {
    const { probes, calls } = fakeProbes({
      headCommit: async (repoPath) => {
        calls.push(`headCommit:${repoPath}`);
        return COMMIT_B;
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'commit-mismatch',
      detail: 'commit-mismatch',
    });
    expect(calls).toEqual([
      'mergeInProgress:/repo',
      'headCommit:/repo',
    ]);
  });

  it('treats an empty headCommit as a commit mismatch', async () => {
    const { probes } = fakeProbes({
      headCommit: async () => '   ',
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'commit-mismatch',
      detail: 'commit-mismatch',
    });
  });

  it('refuses when build fails or exits with null and leaves repoint uncalled', async () => {
    for (const exitCode of [1, null] as const) {
      const { probes, calls } = fakeProbes({
        runCommand: async (argv, cwd) => {
          calls.push(`runCommand:${cwd}:${argv.join(' ')}`);
          return { exitCode };
        },
      });
      const result = await runCheckedDeploy(sampleRequest(), probes);
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'build-failed',
        detail: 'build-failed at step 0',
      });
      expect(calls).toEqual([
        'mergeInProgress:/repo',
        'headCommit:/repo',
        'runCommand:/repo:yarn build',
      ]);
      expect(calls.some((c) => c.startsWith('repoint:'))).toBe(false);
    }
  });

  it('refuses when second suite fails, names step index only, and leaves repoint uncalled', async () => {
    const { probes, calls } = fakeProbes({
      runCommand: async (argv, cwd) => {
        calls.push(`runCommand:${cwd}:${argv.join(' ')}`);
        if (argv[1] === 'test:integration') return { exitCode: 3 };
        return { exitCode: 0 };
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'suite-failed',
      detail: 'suite-failed at step 1',
    });
    expect(calls).toEqual([
      'mergeInProgress:/repo',
      'headCommit:/repo',
      'runCommand:/repo:yarn build',
      'runCommand:/repo:yarn test:unit',
      'runCommand:/repo:yarn test:integration',
    ]);
    expect(calls.some((c) => c.startsWith('repoint:'))).toBe(false);
  });

  it('refuses when merge appears between suites and repoint and never repoints', async () => {
    const request = sampleRequest();
    const { probes, calls } = fakeProbes(
      {
        mergeInProgress: async (repoPath) => {
          calls.push(`mergeInProgress:${repoPath}`);
          const mergeCalls = calls.filter((c) =>
            c.startsWith('mergeInProgress:'),
          ).length;
          // The second check — immediately before repoint — finds a merge.
          return mergeCalls === 2;
        },
      },
      request,
    );
    const result = await runCheckedDeploy(request, probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'merge-in-progress',
      detail: 'merge-in-progress before repoint',
    });
    expect(calls.some((c) => c.startsWith('repoint:'))).toBe(false);
    // The staging digest and the merge re-check both happened.
    expect(calls).toContain('digestTree:/staging');
    expect(
      calls.filter((c) => c.startsWith('mergeInProgress:')),
    ).toHaveLength(2);
  });

  it('restores previous target and returns bytes-mismatch when installed digest differs', async () => {
    const { probes, calls } = fakeProbes({
      digestTree: async (path) => {
        calls.push(`digestTree:${path}`);
        return path === '/staging' ? 'digest-staged' : 'digest-installed';
      },
      currentTarget: async (link) => {
        calls.push(`currentTarget:${link}`);
        return '/previous';
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'bytes-mismatch',
      detail: 'bytes-mismatch',
    });
    expect(calls).toContain('currentTarget:/install');
    expect(calls).toContain('repoint:/install:/staging');
    expect(calls).toContain('repoint:/install:/previous');
  });

  it('returns probe-failed when a probe throws before repoint', async () => {
    const { probes, calls } = fakeProbes({
      headCommit: async () => {
        throw new Error('probe boom');
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'probe-failed',
      detail: 'probe-failed',
    });
    expect(calls.some((c) => c.startsWith('repoint:'))).toBe(false);
  });

  it('attempts rollback and returns probe-failed when post-repoint digest probe throws', async () => {
    const { probes, calls } = fakeProbes({
      currentTarget: async (link) => {
        calls.push(`currentTarget:${link}`);
        return '/previous';
      },
      digestTree: async (path) => {
        calls.push(`digestTree:${path}`);
        if (path === '/staging') return 'digest-staged';
        throw new Error('digest boom');
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'probe-failed',
      detail: 'probe-failed',
    });
    expect(calls).toContain('repoint:/install:/staging');
    expect(calls).toContain('repoint:/install:/previous');
  });

  it('returns probe-failed when probes is null or a probe method is missing', async () => {
    for (const broken of [
      null,
      {},
      { ...fakeProbes().probes, digestTree: undefined },
    ] as unknown as DeployProbes[]) {
      const result = await runCheckedDeploy(sampleRequest(), broken);
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'probe-failed',
        detail: 'probe-failed',
      });
    }
  });

  it('returns probe-failed when digestTree returns an empty string', async () => {
    const { probes } = fakeProbes({
      digestTree: async () => '   ',
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'probe-failed',
      detail: 'probe-failed',
    });
  });

  it('succeeds, calls repoint exactly once, and returns the verified digest', async () => {
    const { probes, calls } = fakeProbes({
      currentTarget: async (link) => {
        calls.push(`currentTarget:${link}`);
        return '/previous';
      },
    });
    const result = await runCheckedDeploy(sampleRequest(), probes);
    expect(result).toEqual({
      outcome: 'deployed',
      digest: 'digest-ok',
      previousTarget: '/previous',
    });
    expect(calls.filter((c) => c === 'repoint:/install:/staging')).toHaveLength(
      1,
    );
    // Ordering: merge check, head, build, suites, staging digest, merge
    // re-check, previous target, repoint, installed digest.
    expect(calls).toEqual([
      'mergeInProgress:/repo',
      'headCommit:/repo',
      'runCommand:/repo:yarn build',
      'runCommand:/repo:yarn test:unit',
      'runCommand:/repo:yarn test:integration',
      'digestTree:/staging',
      'mergeInProgress:/repo',
      'currentTarget:/install',
      'repoint:/install:/staging',
      'digestTree:/install',
    ]);
  });
});
