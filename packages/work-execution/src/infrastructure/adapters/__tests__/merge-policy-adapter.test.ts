import { describe, expect, it } from 'vitest';

import type {
  MergePolicyAnswer,
  MergePolicyRepository,
  MergePolicySource,
} from '../../../application/ports/out/MergePolicyPort.out-port.js';
import { MergePolicyAdapter } from '../MergePolicyAdapter.adapter.js';

function repository(overrides: Record<string, unknown> = {}): MergePolicyRepository {
  return {
    owner: 'acme',
    repo: 'widgets',
    repositoryKey: 'acme/widgets',
    projectId: 'project-a',
    shadow: true,
    unattended: false,
    requiredContexts: ['gate', 'premerge'],
    updateBranch: false,
    macosProcedure: null,
    maxAttempts: 9,
    checksGraceMinutes: 30,
    veto: { mode: 'off', holdConfidence: 0.8 },
    ...overrides,
  } as MergePolicyRepository;
}

function resolved(overrides: Record<string, unknown> = {}): MergePolicySource {
  return {
    outcome: 'resolved',
    policyRevision: 'abcdef012345',
    repositories: [repository()],
    daemon: { intervalSeconds: 60, budgetSeconds: 45, settleSeconds: 20 },
    ...overrides,
  } as MergePolicySource;
}

function adapterFor(read: () => unknown): MergePolicyAdapter {
  return new MergePolicyAdapter({ readInstallation: async () => read() as MergePolicySource });
}

function throwingGetter(target: object, key: string): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    get: () => {
      throw new Error('getter ran');
    },
  });
}

const installationInvalid: MergePolicyAnswer = { outcome: 'unknown', reason: 'installation-invalid' };

describe('MergePolicyAdapter', () => {
  it('readMergePolicy answers known with the repositories, daemon settings and revision', async () => {
    const source = resolved({
      repositories: [
        repository(),
        repository({
          owner: 'acme',
          repo: 'gadgets',
          repositoryKey: 'acme/gadgets',
          shadow: false,
          unattended: true,
          macosProcedure: 'macos-smoke',
          requiredContexts: ['gate'],
          veto: { mode: 'live', holdConfidence: 0 },
        }),
      ],
      daemon: { intervalSeconds: 120, budgetSeconds: 90, settleSeconds: 0 },
    });
    const answer = await adapterFor(() => source).readMergePolicy();
    expect(answer).toEqual({
      outcome: 'known',
      policyRevision: 'abcdef012345',
      repositories: [
        repository(),
        repository({
          owner: 'acme',
          repo: 'gadgets',
          repositoryKey: 'acme/gadgets',
          shadow: false,
          unattended: true,
          macosProcedure: 'macos-smoke',
          requiredContexts: ['gate'],
          veto: { mode: 'live', holdConfidence: 0 },
        }),
      ],
      daemon: { intervalSeconds: 120, budgetSeconds: 90, settleSeconds: 0 },
    });
  });

  it('readMergePolicy answers known with zero repositories when none is configured', async () => {
    const answer = await adapterFor(() => resolved({ repositories: [] })).readMergePolicy();
    expect(answer).toMatchObject({ outcome: 'known', repositories: [] });
  });

  it('readMergePolicy hands back frozen copies, never the source objects', async () => {
    const source = resolved();
    const answer = await adapterFor(() => source).readMergePolicy();
    if (answer.outcome !== 'known' || source.outcome !== 'resolved') {
      throw new Error('expected a known answer');
    }
    expect(answer.repositories).not.toBe(source.repositories);
    expect(answer.repositories[0]).not.toBe(source.repositories[0]);
    expect(answer.repositories[0].requiredContexts).not.toBe(source.repositories[0].requiredContexts);
    expect(answer.daemon).not.toBe(source.daemon);
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(answer.repositories)).toBe(true);
    expect(Object.isFrozen(answer.repositories[0])).toBe(true);
    expect(Object.isFrozen(answer.repositories[0].requiredContexts)).toBe(true);
    expect(Object.isFrozen(answer.repositories[0].veto)).toBe(true);
    expect(Object.isFrozen(answer.daemon)).toBe(true);
    (source.repositories as MergePolicyRepository[])[0] = repository({ projectId: 'changed' });
    expect(answer.repositories[0].projectId).toBe('project-a');
  });

  it('readMergePolicy answers unknown when the installation read throws', async () => {
    const rejecting = new MergePolicyAdapter({
      readInstallation: () => Promise.reject(new Error('boom')),
    });
    expect(await rejecting.readMergePolicy()).toEqual({
      outcome: 'unknown',
      reason: 'installation-unreadable',
    });
    const throwing = new MergePolicyAdapter({
      readInstallation: () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.readMergePolicy()).toEqual({
      outcome: 'unknown',
      reason: 'installation-unreadable',
    });
  });

  it('readMergePolicy answers unknown when the section is invalid', async () => {
    const answer = await adapterFor(() => ({
      outcome: 'invalid',
      reason: 'policy-merge-invalid',
    })).readMergePolicy();
    expect(answer).toEqual({ outcome: 'unknown', reason: 'policy-invalid' });
  });

  it('readMergePolicy answers unknown for a null or non-object source', async () => {
    for (const source of [null, undefined, 'resolved', 7, true, [], [resolved()], { outcome: 'other' }, {}]) {
      expect([source, await adapterFor(() => source).readMergePolicy()]).toEqual([
        source,
        installationInvalid,
      ]);
    }
  });

  it('readMergePolicy answers unknown for a source whose getter throws', async () => {
    const outcomeGetter = {};
    throwingGetter(outcomeGetter, 'outcome');
    expect(await adapterFor(() => outcomeGetter).readMergePolicy()).toEqual(installationInvalid);

    for (const key of ['policyRevision', 'repositories', 'daemon']) {
      const source = resolved();
      Object.defineProperty(source, key, {
        enumerable: true,
        get: () => {
          throw new Error('getter ran');
        },
      });
      expect([key, await adapterFor(() => source).readMergePolicy()]).toEqual([key, installationInvalid]);
    }

    const entry = repository();
    throwingGetter(entry, 'maxAttempts');
    expect(await adapterFor(() => resolved({ repositories: [entry] })).readMergePolicy()).toEqual(
      installationInvalid,
    );

    const veto = { mode: 'off', holdConfidence: 0.8 };
    throwingGetter(veto, 'mode');
    expect(
      await adapterFor(() => resolved({ repositories: [repository({ veto })] })).readMergePolicy(),
    ).toEqual(installationInvalid);

    const contexts = ['gate'];
    throwingGetter(contexts, '0');
    expect(
      await adapterFor(() => resolved({ repositories: [repository({ requiredContexts: contexts })] })).readMergePolicy(),
    ).toEqual(installationInvalid);

    const daemon = { intervalSeconds: 60, budgetSeconds: 45 };
    throwingGetter(daemon, 'settleSeconds');
    expect(await adapterFor(() => resolved({ daemon })).readMergePolicy()).toEqual(installationInvalid);

    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap ran');
        },
      },
    );
    expect(await adapterFor(() => proxy).readMergePolicy()).toEqual(installationInvalid);
  });

  it('readMergePolicy answers unknown for a sparse repositories array', async () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [repository(), , repository({ repo: 'other', repositoryKey: 'acme/other' })];
    expect(await adapterFor(() => resolved({ repositories: sparse })).readMergePolicy()).toEqual(
      installationInvalid,
    );
    const holes = new Array<MergePolicyRepository>(1);
    expect(await adapterFor(() => resolved({ repositories: holes })).readMergePolicy()).toEqual(
      installationInvalid,
    );
    // eslint-disable-next-line no-sparse-arrays
    const sparseContexts = ['gate', , 'premerge'];
    expect(
      await adapterFor(() => resolved({ repositories: [repository({ requiredContexts: sparseContexts })] })).readMergePolicy(),
    ).toEqual(installationInvalid);
  });

  it('readMergePolicy answers unknown for an unknown veto mode', async () => {
    for (const veto of [
      { mode: 'sometimes', holdConfidence: 0.8 },
      { mode: 'off', holdConfidence: 1.5 },
      { mode: 'off', holdConfidence: -0.1 },
      { mode: 'off', holdConfidence: Number.NaN },
      { mode: 'off', holdConfidence: '0.8' },
      { mode: 'off' },
      null,
      'off',
    ]) {
      const answer = await adapterFor(() => resolved({ repositories: [repository({ veto })] })).readMergePolicy();
      expect([veto, answer]).toEqual([veto, installationInvalid]);
    }
  });

  it('readMergePolicy answers unknown for a malformed policy revision', async () => {
    for (const policyRevision of ['', 'ABCDEF012345', 'abcdef01234', 'abcdef0123456', 'abcdef01234g', 12, null, undefined]) {
      const answer = await adapterFor(() => resolved({ policyRevision })).readMergePolicy();
      expect([policyRevision, answer]).toEqual([policyRevision, installationInvalid]);
    }
  });

  it('readMergePolicy answers unknown for a malformed repository or daemon block', async () => {
    const badRepositories: readonly Record<string, unknown>[] = [
      { owner: 1 },
      { repo: '' },
      { repositoryKey: null },
      { projectId: undefined },
      { shadow: 'true' },
      { unattended: 0 },
      { updateBranch: undefined },
      { macosProcedure: undefined },
      { macosProcedure: 5 },
      { maxAttempts: 0 },
      { maxAttempts: 2.5 },
      { maxAttempts: Number.NaN },
      { checksGraceMinutes: '30' },
      { requiredContexts: 'gate' },
      { requiredContexts: ['gate', 3] },
      { requiredContexts: ['c'.repeat(65)] },
      { requiredContexts: Array.from({ length: 17 }, (_, index) => `c${index}`) },
    ];
    for (const overrides of badRepositories) {
      const answer = await adapterFor(() => resolved({ repositories: [repository(overrides)] })).readMergePolicy();
      expect([overrides, answer]).toEqual([overrides, installationInvalid]);
    }
    expect(await adapterFor(() => resolved({ repositories: [null] })).readMergePolicy()).toEqual(installationInvalid);
    expect(await adapterFor(() => resolved({ repositories: 'none' })).readMergePolicy()).toEqual(installationInvalid);

    const badDaemons: readonly unknown[] = [
      null,
      [],
      {},
      { intervalSeconds: 0, budgetSeconds: 45, settleSeconds: 20 },
      { intervalSeconds: 60, budgetSeconds: 0, settleSeconds: 20 },
      { intervalSeconds: 60, budgetSeconds: 45, settleSeconds: -1 },
      { intervalSeconds: 60, budgetSeconds: 45, settleSeconds: Number.POSITIVE_INFINITY },
      { intervalSeconds: '60', budgetSeconds: 45, settleSeconds: 20 },
      { intervalSeconds: 60, budgetSeconds: Number.NaN, settleSeconds: 20 },
    ];
    for (const daemon of badDaemons) {
      expect([daemon, await adapterFor(() => resolved({ daemon })).readMergePolicy()]).toEqual([
        daemon,
        installationInvalid,
      ]);
    }
  });

  it('readMergePolicy never echoes a path or a file name', async () => {
    const thrown = new Error('ENOENT: no such file /home/operator/.config/fleet/installation.json');
    const answers = [
      await adapterFor(() => {
        throw thrown;
      }).readMergePolicy(),
      await adapterFor(() => ({
        outcome: 'invalid',
        reason: 'cannot parse /etc/fleet/installation.json',
      })).readMergePolicy(),
      await adapterFor(() => null).readMergePolicy(),
      await adapterFor(() => resolved({ policyRevision: '/etc/fleet/installation.json' })).readMergePolicy(),
    ];
    for (const answer of answers) {
      expect(answer.outcome).toBe('unknown');
      if (answer.outcome !== 'unknown') {
        continue;
      }
      expect(['installation-unreadable', 'policy-invalid', 'installation-invalid']).toContain(answer.reason);
      const text = JSON.stringify(answer);
      expect(text).not.toMatch(/\/(home|etc|srv|tmp|var|usr)\//);
      expect(text).not.toContain('installation.json');
      expect(text).not.toContain('ENOENT');
      expect(text).not.toContain(thrown.message);
      expect(Object.keys(answer).sort()).toEqual(['outcome', 'reason']);
    }
  });

  it('readMergePolicy reads the installation on every call', async () => {
    let reads = 0;
    const adapter = new MergePolicyAdapter({
      readInstallation: async () => {
        reads += 1;
        return reads === 1
          ? resolved()
          : resolved({ policyRevision: '0123456789ab', repositories: [repository({ projectId: 'project-b' })] });
      },
    });
    const first = await adapter.readMergePolicy();
    expect(reads).toBe(1);
    const second = await adapter.readMergePolicy();
    expect(reads).toBe(2);
    expect(first).toMatchObject({ outcome: 'known', policyRevision: 'abcdef012345' });
    expect(second).toMatchObject({
      outcome: 'known',
      policyRevision: '0123456789ab',
      repositories: [{ projectId: 'project-b' }],
    });
  });

  it('readMergePolicy follows the installation from known to unknown and back without caching', async () => {
    const reads: (() => unknown)[] = [
      () => resolved(),
      () => {
        throw new Error('gone');
      },
      () => resolved(),
    ];
    const adapter = new MergePolicyAdapter({
      readInstallation: async () => {
        const next = reads.shift();
        if (next === undefined) {
          throw new Error('unexpected read');
        }
        return next() as MergePolicySource;
      },
    });
    expect((await adapter.readMergePolicy()).outcome).toBe('known');
    expect(await adapter.readMergePolicy()).toEqual({ outcome: 'unknown', reason: 'installation-unreadable' });
    expect((await adapter.readMergePolicy()).outcome).toBe('known');
  });

  it('readMergePolicy refuses a repository list beyond the bound', async () => {
    const many = (count: number): MergePolicyRepository[] =>
      Array.from({ length: count }, (_, index) =>
        repository({ repo: `repo-${index}`, repositoryKey: `acme/repo-${index}` }),
      );
    expect(await adapterFor(() => resolved({ repositories: many(257) })).readMergePolicy()).toEqual(
      installationInvalid,
    );
    const atBound = await adapterFor(() => resolved({ repositories: many(256) })).readMergePolicy();
    expect(atBound).toMatchObject({ outcome: 'known' });
    if (atBound.outcome === 'known') {
      expect(atBound.repositories).toHaveLength(256);
    }
  });
});
