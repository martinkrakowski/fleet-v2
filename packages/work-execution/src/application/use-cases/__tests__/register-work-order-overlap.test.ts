// PT1ca: open-PR and active-work-order overlap refusal, held registrations, and
// the total input validation of RegisterWorkOrderUseCase.
import { describe, expect, it } from 'vitest';

import type { ActionJournalEntryRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { overlapPathCode } from '../../../domain/held-work-order.js';
import { ForgeReadAdapter } from '../../../infrastructure/adapters/ForgeReadAdapter.adapter.js';
import { HeldWorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/HeldWorkOrderRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import type {
  ListOpenPullRequestsByBaseResult,
  ReadPullRequestChangedFilesResult,
  ForgeReadPort,
} from '../../ports/out/ForgeReadPort.out-port.js';
import type { HeldWorkOrderRepositoryPort } from '../../ports/out/HeldWorkOrderRepositoryPort.out-port.js';
import type { RegisterWorkOrderRequest } from '../../ports/in/RegisterWorkOrderPort.in-port.js';
import { ListHeldWorkOrdersUseCase } from '../ListHeldWorkOrdersUseCase.use-case.js';
import {
  RegisterWorkOrderUseCase,
  type RegisterWorkOrderDependencies,
} from '../RegisterWorkOrderUseCase.use-case.js';

const HEAD = '3dd5d90509461e3d2154b52da28671aeffa84130';

function request(overrides: Partial<RegisterWorkOrderRequest> = {}): RegisterWorkOrderRequest {
  return {
    workOrderId: 'wo-new',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'acme/fleet',
    baseCommit: '1111111111111111111111111111111111111111',
    ownedPaths: ['packages/a/src', 'packages/b/src'],
    policyRevision: 'rev-1',
    nowIso: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

interface ForgeScript {
  list?: ListOpenPullRequestsByBaseResult | 'throw';
  files?: Readonly<Record<number, ReadPullRequestChangedFilesResult | 'throw'>>;
  onFiles?: (pullRequestNumber: number) => void;
}

function fakeForge(script: ForgeScript) {
  const calls = { list: 0, files: [] as number[], listRequests: [] as unknown[] };
  const forge: ForgeReadPort = {
    isConfigured: () => true,
    readPullRequest: async () => ({ outcome: 'unavailable', reason: 'unused' }),
    listOpenPullRequestsByBase: async (listRequest) => {
      calls.list += 1;
      calls.listRequests.push(listRequest);
      if (script.list === 'throw') throw new Error('boom');
      return script.list ?? { outcome: 'listed', pullRequests: [] };
    },
    readPullRequestChangedFiles: async (filesRequest) => {
      calls.files.push(filesRequest.pullRequestNumber);
      script.onFiles?.(filesRequest.pullRequestNumber);
      const entry = script.files?.[filesRequest.pullRequestNumber];
      if (entry === 'throw') throw new Error('boom');
      return entry ?? { outcome: 'unknown', reason: 'files-failed' };
    },
  };
  return { forge, calls };
}

function openPr(number: number) {
  return { number, headSha: HEAD, baseRef: 'main' };
}

function setup(deps: Partial<RegisterWorkOrderDependencies> = {}) {
  const workOrderRepo = new WorkOrderRepositoryAdapter();
  const heldWorkOrderRepo = new HeldWorkOrderRepositoryAdapter();
  const saved: WorkOrderRecord[] = [];
  const spyRepo = {
    findWorkOrderById: (id: string) => workOrderRepo.findWorkOrderById(id),
    listWorkOrdersByProject: (projectId?: string) => workOrderRepo.listWorkOrdersByProject(projectId),
    saveWorkOrder: async (record: WorkOrderRecord) => {
      saved.push(record);
      await workOrderRepo.saveWorkOrder(record);
    },
  };
  const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: spyRepo, heldWorkOrderRepo, ...deps });
  const listHeld = new ListHeldWorkOrdersUseCase({ heldRepo: heldWorkOrderRepo });
  return { useCase, workOrderRepo, heldWorkOrderRepo, saved, listHeld };
}

describe('RegisterWorkOrderUseCase open-PR overlap', () => {
  it('refuses on the first overlapping owned path, holds with the briefRequestRef and never saves', async () => {
    const { forge } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(42)] },
      files: { 42: { outcome: 'found', files: ['packages/b/src/y.ts', 'packages/a/src/x.ts'] } },
    });
    const { useCase, saved, heldWorkOrderRepo } = setup({ forgeRead: forge });
    const result = await useCase.registerWorkOrder(request({ briefRequestRef: 'brief-req-01' }));
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'open-pr-overlap',
      pullRequestNumber: 42,
      blockerKind: 'open-pr',
      blockerId: '42',
      pathCode: overlapPathCode('packages/a/src'),
      held: true,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(saved).toEqual([]);
    const stored = await heldWorkOrderRepo.findByWorkOrderId('wo-new');
    expect(stored.outcome === 'found' && stored.record).toMatchObject({
      stage: 'held',
      briefRequestRef: 'brief-req-01',
      blockerKind: 'open-pr',
      blockerId: '42',
    });
  });

  it('refuses a directory-prefix overlap and ignores shared append paths', async () => {
    const prefix = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(7)] },
      files: { 7: { outcome: 'found', files: ['packages/a/src/x.ts'] } },
    });
    const first = setup({ forgeRead: prefix.forge });
    expect(await first.useCase.registerWorkOrder(request({ ownedPaths: ['packages/a'] }))).toMatchObject({
      outcome: 'refused',
      reason: 'open-pr-overlap',
    });

    const shared = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(8)] },
      files: { 8: { outcome: 'found', files: ['.architecture/manifest.yaml', 'packages/index.ts'] } },
    });
    const second = setup({ forgeRead: shared.forge });
    expect(
      await second.useCase.registerWorkOrder(request({ ownedPaths: ['.architecture/manifest.yaml', 'packages/c/src'] })),
    ).toMatchObject({ outcome: 'registered' });
  });

  it('admits when no open PR touches an owned path', async () => {
    const { forge, calls } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(9), openPr(3)] },
      files: {
        3: { outcome: 'found', files: ['docs/readme.md'] },
        9: { outcome: 'found', files: ['packages/c/src/z.ts'] },
      },
    });
    const { useCase, saved } = setup({ forgeRead: forge });
    expect(await useCase.registerWorkOrder(request())).toMatchObject({ outcome: 'registered' });
    expect(saved).toHaveLength(1);
    expect(calls.files).toEqual([3, 9]);
    expect(calls.listRequests[0]).toMatchObject({ base: 'main', repository: { owner: 'acme', repo: 'fleet' } });
  });

  it('skips an open PR bound to the same work order through a lane run', async () => {
    const { forge, calls } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(42)] },
      files: { 42: { outcome: 'found', files: ['packages/a/src/x.ts'] } },
    });
    const { useCase, saved } = setup({
      forgeRead: forge,
      runRepo: { list: async () => [{ workOrderId: 'wo-new', prNumber: 42 }, { workOrderId: 'wo-other', prNumber: 9 }] as never },
    });
    expect(await useCase.registerWorkOrder(request())).toMatchObject({ outcome: 'registered' });
    expect(saved).toHaveLength(1);
    expect(calls.files).toEqual([]);
  });

  it('skips an open PR bound to the same work order through a forge journal entry', async () => {
    const { forge, calls } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(42), openPr(43)] },
      files: {
        42: { outcome: 'found', files: ['packages/a/src/x.ts'] },
        43: { outcome: 'found', files: ['docs/a.md'] },
      },
    });
    const entry = (pullRequest: ActionJournalEntryRecord['pullRequest'], workOrderId = 'wo-new') =>
      ({ id: 'j', attemptId: 'att-1', workOrderId, pullRequest }) as ActionJournalEntryRecord;
    const { useCase } = setup({
      forgeRead: forge,
      attemptRepo: { listAttemptsByWorkOrder: async () => [{ id: 'att-1' }] as never },
      executionJournal: {
        listJournalEntriesForAttempt: async () => [
          entry({ repository: 'ACME/Fleet', number: 42 }),
          entry({ repository: 'other/repo', number: 43 }),
        ],
      },
    });
    expect(await useCase.registerWorkOrder(request())).toMatchObject({ outcome: 'registered' });
    expect(calls.files).toEqual([43]);
  });

  it('refuses overlap-unknown when a bound-PR read throws', async () => {
    const { forge } = fakeForge({});
    const { useCase, saved, heldWorkOrderRepo } = setup({
      forgeRead: forge,
      runRepo: {
        list: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(await useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(saved).toEqual([]);
    expect(await heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it.each([
    ['an unavailable listing', { list: { outcome: 'unavailable', reason: 'x' } } satisfies ForgeScript],
    ['a thrown listing', { list: 'throw' } satisfies ForgeScript],
    [
      'an unknown file read',
      {
        list: { outcome: 'listed', pullRequests: [openPr(5)] },
        files: { 5: { outcome: 'unknown', reason: 'too-many-files' } },
      } satisfies ForgeScript,
    ],
    [
      'a thrown file read',
      { list: { outcome: 'listed', pullRequests: [openPr(5)] }, files: { 5: 'throw' } } satisfies ForgeScript,
    ],
  ])('refuses overlap-unknown and neither admits nor holds on %s', async (_name, script) => {
    const { forge } = fakeForge(script);
    const { useCase, saved, heldWorkOrderRepo } = setup({ forgeRead: forge });
    expect(await useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(saved).toEqual([]);
    expect(await heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it('a PR with changedFiles: 150 and 100 files, none overlapping, refuses overlap-unknown', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `packages/other/file-${i}.ts` }));
    const forge = new ForgeReadAdapter({
      owner: 'acme',
      repo: 'fleet',
      runGh: async (args) => {
        if (args[0] === 'api') {
          return { exitCode: 0, stdout: JSON.stringify({ number: 42, head: { sha: HEAD }, base: { ref: 'main' } }), stderr: '' };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ files, changedFiles: 150 }),
          stderr: '',
        };
      },
    });
    const { useCase, saved, heldWorkOrderRepo } = setup({ forgeRead: forge });
    const result = await useCase.registerWorkOrder(request({ ownedPaths: ['packages/a/src'] }));
    expect(result).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(saved).toEqual([]);
    expect(await heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it('a PR whose changedFiles equals the returned files, none overlapping, is found and admits', async () => {
    const { forge, calls } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(11)] },
      files: { 11: { outcome: 'found', files: ['packages/other/x.ts', 'packages/other/y.ts'] } },
    });
    const { useCase, saved } = setup({ forgeRead: forge });
    expect(await useCase.registerWorkOrder(request({ ownedPaths: ['packages/a/src'] }))).toMatchObject({
      outcome: 'registered',
    });
    expect(saved).toHaveLength(1);
    expect(calls.files).toEqual([11]);
  });

  it('a PR with changedFiles missing refuses overlap-unknown', async () => {
    const files = [{ path: 'packages/other/file.ts' }];
    const forge = new ForgeReadAdapter({
      owner: 'acme',
      repo: 'fleet',
      runGh: async (args) => {
        if (args[0] === 'api') {
          return { exitCode: 0, stdout: JSON.stringify({ number: 42, head: { sha: HEAD }, base: { ref: 'main' } }), stderr: '' };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ files }),
          stderr: '',
        };
      },
    });
    const { useCase, saved, heldWorkOrderRepo } = setup({ forgeRead: forge });
    const result = await useCase.registerWorkOrder(request({ ownedPaths: ['packages/a/src'] }));
    expect(result).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(saved).toEqual([]);
    expect(await heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it('refuses overlap-unknown for a repository that is not an owner/repo coordinate or a forge without the file read', async () => {
    const { forge } = fakeForge({});
    const first = setup({ forgeRead: forge });
    expect(await first.useCase.registerWorkOrder(request({ repository: 'https://example.com/x.git' }))).toEqual({
      outcome: 'refused',
      reason: 'overlap-unknown',
    });
    const withoutFiles: ForgeReadPort = {
      isConfigured: () => true,
      readPullRequest: async () => ({ outcome: 'unavailable', reason: 'unused' }),
      listOpenPullRequestsByBase: async () => ({ outcome: 'listed', pullRequests: [] }),
    };
    const second = setup({ forgeRead: withoutFiles });
    expect(await second.useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    const third = setup({ forgeRead: forge, overlapCheckBudgetMs: 0 });
    expect(await third.useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
  });

  it('cuts short with overlap-unknown when overlapCheckBudgetMs expires mid-scan and leaves clean state for retry', async () => {
    let now = 1_000;
    const budgeted = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(1), openPr(2)] },
      files: { 1: { outcome: 'found', files: ['docs/a.md'] }, 2: { outcome: 'found', files: ['docs/b.md'] } },
      onFiles: () => {
        now += 100;
      },
    });
    const state = setup({ forgeRead: budgeted.forge, clock: () => now, overlapCheckBudgetMs: 50 });
    expect(await state.useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(budgeted.calls.files).toEqual([1]);
    expect(state.saved).toEqual([]);
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });

    const retry = new RegisterWorkOrderUseCase({
      workOrderRepo: state.workOrderRepo,
      heldWorkOrderRepo: state.heldWorkOrderRepo,
      forgeRead: budgeted.forge,
    });
    expect(await retry.registerWorkOrder(request())).toMatchObject({ outcome: 'registered' });
  });

  it('enforces ownedPaths, open-PR scan, and held-store size bounds', async () => {
    const tooManyPaths = Array.from({ length: 257 }, (_, index) => `packages/p${index}`);
    const first = setup();
    expect(await first.useCase.registerWorkOrder(request({ ownedPaths: tooManyPaths }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(
      await first.useCase.registerWorkOrder(
        request({ prerequisiteWorkOrderIds: Array.from({ length: 129 }, (_, index) => `wo-${index}`) }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(
      await first.useCase.registerWorkOrder(request({ ownedPaths: [`packages/${'a'.repeat(520)}`] })),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    const crowded = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(1), openPr(2), openPr(3)] },
      files: {},
    });
    const second = setup({ forgeRead: crowded.forge, maxOpenPullRequestsChecked: 2 });
    expect(await second.useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(crowded.calls.files).toEqual([]);

    const full: HeldWorkOrderRepositoryPort = {
      ...second.heldWorkOrderRepo,
      listHeldWorkOrders: async () => ({ outcome: 'ok', records: [] }),
      findByWorkOrderId: async () => ({ outcome: 'not-found' }),
      findByIntentId: async () => ({ outcome: 'not-found' }),
      recordHoldIntent: async () => ({ outcome: 'refused', reason: 'store-full' }),
      completeHoldIntent: async () => ({ outcome: 'refused', reason: 'intent-not-found' }),
      deleteHeldWorkOrder: async () => ({ outcome: 'not-found' }),
    };
    const overlap = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(1)] },
      files: { 1: { outcome: 'found', files: ['packages/a/src/x.ts'] } },
    });
    const third = setup({ forgeRead: overlap.forge, heldWorkOrderRepo: full });
    expect(await third.useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'store-unavailable' });
  });
});

describe('RegisterWorkOrderUseCase active work-order overlap', () => {
  it('refuses, holds and names only the blocker id and the path code', async () => {
    const state = setup();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/a/src/x.ts'] })),
    ).toMatchObject({ outcome: 'registered' });
    const refused = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', ownedPaths: ['packages/c', 'packages/a/src/x.ts'], briefRequestRef: 'brief-req-02' }),
    );
    expect(refused).toEqual({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'wo-a',
      pathCode: overlapPathCode('packages/a/src/x.ts'),
      held: true,
      requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(refused)).not.toContain('packages/');
    expect(await state.workOrderRepo.findWorkOrderById('wo-b')).toBeNull();
    expect(
      await state.listHeld.listHeldWorkOrders({ nowIso: '2026-11-07T10:30:00.000Z' }),
    ).toEqual({
      outcome: 'listed',
      held: [{ workOrderId: 'wo-b', blockerKind: 'active-work-order', blockerId: 'wo-a', ageMinutes: 30 }],
    });
  });

  it('holds an overlapping registration when the active blocker id contains @ (wo@block)', async () => {
    const state = setup();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo@block', ownedPaths: ['packages/a/src/x.ts'] })),
    ).toMatchObject({ outcome: 'registered' });
    const refused = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', ownedPaths: ['packages/a/src/x.ts'] }),
    );
    expect(refused).toMatchObject({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'wo@block',
      held: true,
    });
  });

  it('a held record serialised to JSON contains no owned path string and no taskId or laneId value', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/a/src/x.ts'] }));
    const refused = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', taskId: 'task-99', laneId: 'lane-88', ownedPaths: ['packages/a/src/x.ts'] }),
    );
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'active-work-order-overlap', held: true });
    const held = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(held.outcome).toBe('ok');
    if (held.outcome === 'ok') {
      const record = held.records[0];
      const json = JSON.stringify(record);
      expect(json).not.toContain('packages/a/src/x.ts');
      expect(json).not.toContain('task-99');
      expect(json).not.toContain('lane-88');
      expect(json).not.toContain('ownedPaths');
      expect(json).not.toContain('taskId');
      expect(json).not.toContain('laneId');
      expect(json).not.toContain('policyRevision');
    }
  });

  it('an active packages/a vs new packages/a/src/index.ts refuses', async () => {
    const state = setup();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/a'] })),
    ).toMatchObject({ outcome: 'registered' });
    const refused = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', ownedPaths: ['packages/a/src/index.ts'] }),
    );
    expect(refused).toMatchObject({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'wo-a',
    });
  });

  it('the reverse direction (active packages/a/src/index.ts vs new packages/a) refuses', async () => {
    const state = setup();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/a/src/index.ts'] })),
    ).toMatchObject({ outcome: 'registered' });
    const refused = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', ownedPaths: ['packages/a'] }),
    );
    expect(refused).toMatchObject({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'wo-a',
    });
  });

  it('the existing exemption (the identical shared-append file) is unchanged', async () => {
    const state = setup();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/a/src/index.ts'] })),
    ).toMatchObject({ outcome: 'registered' });
    const second = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', ownedPaths: ['packages/a/src/index.ts'] }),
    );
    expect(second).toMatchObject({
      outcome: 'registered',
    });
  });

  it('an active order with id "legacy id!" vs an overlapping new order gives active-work-order-overlap, and no held record is written', async () => {
    const attentionCodes: string[] = [];
    const state = setup({
      recordAttentionCode: (code) => {
        attentionCodes.push(code);
      },
    });
    await state.workOrderRepo.saveWorkOrder({
      id: 'legacy id!',
      projectId: 'proj-1',
      taskId: 'task-legacy',
      laneId: 'lane-legacy',
      repository: 'acme/fleet',
      baseCommit: '1111111111111111111111111111111111111111',
      ownedPaths: ['packages/a/src'],
      policyRevision: 'rev-1',
      risk: 'high',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-11-07T08:00:00.000Z',
      updatedAtIso: '2026-11-07T08:00:00.000Z',
    });

    const result = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', ownedPaths: ['packages/a/src'] }),
    );
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'legacy id!',
      held: false,
    });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
    expect(attentionCodes).toEqual(['hold-skipped-invalid-blocker-id']);
  });

  it('is held: false without a held store', async () => {
    const workOrderRepo = new WorkOrderRepositoryAdapter();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo });
    await useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    expect(await useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }))).toMatchObject({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      held: false,
    });
  });

  it('re-registers an overlap-refused request idempotently without duplicating held state', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    const first = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }));
    const again = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', nowIso: '2026-11-07T12:00:00.000Z' }));
    expect(again).toEqual(first);
    const listed = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(listed.outcome === 'ok' && listed.records).toHaveLength(1);
    expect(listed.outcome === 'ok' && listed.records[0]?.heldAtIso).toBe('2026-11-07T10:00:00.000Z');

    const mutated = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', taskId: 'task-2' }));
    expect(mutated).toEqual({ outcome: 'refused', reason: 'held-request-mismatch' });
  });

  it('refuses before writing when a failed hold intent is retried with a changed workOrderId or changed request digest (F129)', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    const first = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', intentId: 'intent-1' }));
    expect(first).toMatchObject({ outcome: 'refused', held: true });
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-c', intentId: 'intent-1' })),
    ).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', intentId: 'intent-1', taskId: 'task-2' })),
    ).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
  });

  it('refuses store-unavailable when the held store is unreadable or throws', async () => {
    const unreadable: HeldWorkOrderRepositoryPort = {
      listHeldWorkOrders: async () => ({ outcome: 'unreadable' }),
      findByWorkOrderId: async () => ({ outcome: 'unreadable' }),
      findByIntentId: async () => ({ outcome: 'unreadable' }),
      recordHoldIntent: async () => {
        throw new Error('boom');
      },
      completeHoldIntent: async () => {
        throw new Error('boom');
      },
      deleteHeldWorkOrder: async () => ({ outcome: 'refused' }),
    };
    const { useCase, saved } = setup({ heldWorkOrderRepo: unreadable });
    expect(await useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'store-unavailable' });
    expect(saved).toEqual([]);
  });

  it('deletes the held entry once the same request is admitted', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }));
    expect(await state.heldWorkOrderRepo.findByWorkOrderId('wo-b')).toMatchObject({ outcome: 'found' });
    await state.workOrderRepo.saveWorkOrder({
      ...(await state.workOrderRepo.findWorkOrderById('wo-a'))!,
      state: 'stopped',
      revision: 2,
    });
    expect(await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }))).toMatchObject({ outcome: 'registered' });
    expect(await state.heldWorkOrderRepo.findByWorkOrderId('wo-b')).toEqual({ outcome: 'not-found' });
  });
});

describe('RegisterWorkOrderUseCase total input validation', () => {
  const secret = ['ghp', '_', 'x'.repeat(36)].join('');

  it('refuses null, non-object, wrong-typed fields, sparse arrays, secret shapes, and throwing getters without throwing', async () => {
    const { useCase, saved } = setup();
    const sparse = new Array<string>(2);
    sparse[0] = 'packages/a';
    const throwing = { ...request() };
    Object.defineProperty(throwing, 'taskId', {
      enumerable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    const inputs: unknown[] = [
      null,
      undefined,
      7,
      'text',
      [],
      { ...request(), unknownKey: 1 },
      { ...request(), taskId: 5 },
      { ...request(), laneId: { nested: true } },
      { ...request(), ownedPaths: 'packages/a' },
      { ...request(), ownedPaths: [7] },
      { ...request(), ownedPaths: sparse },
      { ...request(), ownedPaths: ['../escape'] },
      { ...request(), ownedPaths: ['/absolute'] },
      { ...request(), ownedPaths: ['packages//a'] },
      { ...request(), ownedPaths: [`packages/${secret}`] },
      { ...request(), prerequisiteWorkOrderIds: sparse },
      { ...request(), prerequisiteWorkOrderIds: ['a/b'] },
      { ...request(), taskId: secret },
      { ...request(), repository: ['https://x:', 'p'.repeat(8), '@example.com/a.git'].join('') },
      { ...request(), projectId: 'p'.repeat(129) },
      { ...request(), workOrderId: 'wo/with/slash' },
      { ...request(), briefRequestRef: 'path/like' },
      { ...request(), briefRequestRef: '..' },
      { ...request(), briefRequestRef: secret },
      { ...request(), intentId: 'bad intent' },
      { ...request(), nowIso: 5 },
      throwing,
    ];
    for (const input of inputs) {
      const result = await useCase.registerWorkOrder(input as never);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(saved).toEqual([]);
  });

  it('keeps the existing rejections for empty fields, risk and base branch, without echoing values', async () => {
    const { useCase } = setup();
    expect(await useCase.registerWorkOrder(request({ taskId: '' }))).toEqual({
      outcome: 'rejected',
      reason: 'Missing required work order fields: taskId',
    });
    expect(await useCase.registerWorkOrder(request({ risk: 'low' as never }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await useCase.registerWorkOrder(request({ baseBranch: 'release' }))).toEqual({
      outcome: 'rejected',
      reason: 'invalid-base-branch',
    });
  });

  it('screens secret-shaped inputs and never echoes paths or secrets in refusal or held outputs', async () => {
    const { forge } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(42)] },
      files: { 42: { outcome: 'found', files: ['packages/a/src/x.ts'] } },
    });
    const state = setup({ forgeRead: forge });
    const refused = await state.useCase.registerWorkOrder(request({ briefRequestRef: 'brief-req-01' }));
    const listed = await state.listHeld.listHeldWorkOrders({ nowIso: '2026-11-07T11:00:00.000Z' });
    for (const output of [JSON.stringify(refused), JSON.stringify(listed)]) {
      expect(output).not.toContain('packages/');
      expect(output).not.toContain('x.ts');
    }
    const secretInput = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-2', taskId: secret }));
    expect(JSON.stringify(secretInput)).not.toContain(secret);
  });
});

describe('ListHeldWorkOrdersUseCase', () => {
  it('reports unreadable held store as refused unreadable rather than empty list', async () => {
    const unreadable: HeldWorkOrderRepositoryPort = {
      listHeldWorkOrders: async () => ({ outcome: 'unreadable' }),
      findByWorkOrderId: async () => ({ outcome: 'unreadable' }),
      findByIntentId: async () => ({ outcome: 'unreadable' }),
      recordHoldIntent: async () => ({ outcome: 'refused', reason: 'store-unavailable' }),
      completeHoldIntent: async () => ({ outcome: 'refused', reason: 'store-unavailable' }),
      deleteHeldWorkOrder: async () => ({ outcome: 'refused' }),
    };
    expect(await new ListHeldWorkOrdersUseCase({ heldRepo: unreadable }).listHeldWorkOrders()).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
    const throwing: HeldWorkOrderRepositoryPort = {
      ...unreadable,
      listHeldWorkOrders: async () => {
        throw new Error('boom');
      },
    };
    expect(await new ListHeldWorkOrdersUseCase({ heldRepo: throwing }).listHeldWorkOrders()).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
  });

  it('refuses malformed requests, skips unsettled intents and sorts oldest first', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-z', nowIso: '2026-11-07T09:00:00.000Z' }));
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', nowIso: '2026-11-07T09:00:00.000Z' }));
    const listed = await state.listHeld.listHeldWorkOrders({ nowIso: '2026-11-07T10:00:00.000Z' });
    expect(listed).toEqual({
      outcome: 'listed',
      held: [
        { workOrderId: 'wo-b', blockerKind: 'active-work-order', blockerId: 'wo-a', ageMinutes: 60 },
        { workOrderId: 'wo-z', blockerKind: 'active-work-order', blockerId: 'wo-a', ageMinutes: 60 },
      ],
    });
    const bad: unknown[] = [null, 5, { extra: 1 }, { projectId: '' }, { projectId: 'other' }, { nowIso: 'yesterday' }];
    for (const input of bad) {
      expect(await state.listHeld.listHeldWorkOrders(input as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
  });
});
