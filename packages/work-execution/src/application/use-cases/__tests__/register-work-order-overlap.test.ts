// PT1ca: open-PR and active-work-order overlap refusal, held registrations, and
// the total input validation of RegisterWorkOrderUseCase.
import { describe, expect, it } from 'vitest';

import type { ActionJournalEntryRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import {
  computeRegisterWorkOrderRequestDigest,
  overlapPathCode,
  parsePullRequestTitle,
  pureSha256Hex,
} from '../../../domain/held-work-order.js';
import type { HeldWorkOrderRecord, HeldWorkOrderRequestSnapshot } from '../../../domain/held-work-order.js';
import { WorkOrder } from '../../../domain/entities/WorkOrder.js';
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

describe('parsePullRequestTitle', () => {
  const refusal = { ok: false as const, reason: 'invalid-pull-request-title' as const };

  it('parsePullRequestTitle refuses null with invalid-pull-request-title and does not throw', () => {
    expect(parsePullRequestTitle(null)).toEqual(refusal);
  });

  it('parsePullRequestTitle refuses undefined with invalid-pull-request-title and does not throw', () => {
    expect(parsePullRequestTitle(undefined)).toEqual(refusal);
  });

  it('parsePullRequestTitle refuses a number, a boolean, a bigint, a symbol, and a function', () => {
    const fn = () => {};
    for (const value of [1, true, 1n, Symbol('t'), fn]) {
      expect(parsePullRequestTitle(value)).toEqual(refusal);
    }
  });

  it('parsePullRequestTitle refuses an array hole with a throwing getter without calling it', () => {
    let calls = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, '0', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('hostile getter');
      },
    });
    expect(parsePullRequestTitle(arr)).toEqual(refusal);
    expect(calls).toBe(0);
  });

  it('parsePullRequestTitle refuses a throwing getter and a Proxy without invoking them', () => {
    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'title', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('hostile getter');
      },
    });
    let proxyCalls = 0;
    const proxy = new Proxy({}, {
      get() {
        proxyCalls += 1;
        return 'x';
      },
    });
    expect(parsePullRequestTitle(hostile)).toEqual(refusal);
    expect(parsePullRequestTitle(proxy)).toEqual(refusal);
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  it('parsePullRequestTitle refuses an array-like with an enormous length getter without calling it', () => {
    let calls = 0;
    const arrayLike = {
      get length() {
        calls += 1;
        return 1e15;
      },
    };
    expect(parsePullRequestTitle(arrayLike)).toEqual(refusal);
    expect(calls).toBe(0);
  });

  it('parsePullRequestTitle refuses a prototype-polluting object and leaves Object.prototype clean', () => {
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    ) as Record<string, unknown>;
    expect(parsePullRequestTitle(polluted)).toEqual(refusal);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('parsePullRequestTitle refuses an empty, blank, or padded title', () => {
    for (const value of ['', '   ', ' title', 'title ']) {
      expect(parsePullRequestTitle(value)).toEqual(refusal);
    }
  });

  it('parsePullRequestTitle refuses a title longer than 256 code units', () => {
    for (const value of ['a'.repeat(257), 'a'.repeat(100000)]) {
      expect(parsePullRequestTitle(value)).toEqual(refusal);
    }
  });

  it('parsePullRequestTitle refuses a secret-shaped title and does not return the secret', () => {
    const secret = ['ghp', '_', 'x'.repeat(36)].join('');
    const result = parsePullRequestTitle(`prefix ${secret}`);
    expect(result).toEqual(refusal);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('parsePullRequestTitle accepts a trimmed title of 1 to 256 code units', () => {
    expect(parsePullRequestTitle('Add the registration title')).toEqual({
      ok: true,
      title: 'Add the registration title',
    });
    const long = 'a'.repeat(256);
    expect(parsePullRequestTitle(long)).toEqual({ ok: true, title: long });
  });
});

describe('WorkOrder pullRequestTitle', () => {
  const baseRecord: WorkOrderRecord = {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'acme/fleet',
    baseCommit: '1111111111111111111111111111111111111111',
    ownedPaths: ['packages/a/src'],
    policyRevision: 'rev-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-11-07T10:00:00.000Z',
    updatedAtIso: '2026-11-07T10:00:00.000Z',
  };

  it('WorkOrder.fromRecord throws WorkOrder pullRequestTitle is invalid for a non-string title', () => {
    expect(() =>
      WorkOrder.fromRecord({ ...baseRecord, pullRequestTitle: 1 } as unknown as WorkOrderRecord),
    ).toThrow('WorkOrder pullRequestTitle is invalid');
  });

  it('WorkOrder.getPullRequestTitle returns null when the record has no title', () => {
    const order = WorkOrder.fromRecord(baseRecord);
    expect(order.getPullRequestTitle()).toBeNull();
    expect(order.toRecord()).not.toHaveProperty('pullRequestTitle');
  });
});

describe('RegisterWorkOrderUseCase pull request title', () => {
  const secret = ['ghp', '_', 'x'.repeat(36)].join('');

  it('registerWorkOrder refuses an invalid pullRequestTitle and saves nothing', async () => {
    const { useCase, saved } = setup();
    const inputs: unknown[] = [1, null, 'a'.repeat(257), secret, ' title'];
    for (const value of inputs) {
      const result = await useCase.registerWorkOrder(request({ pullRequestTitle: value as never }));
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-pull-request-title' });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(saved).toEqual([]);
  });

  it('registerWorkOrder reports invalid-pull-request-title before a missing taskId', async () => {
    const { useCase, saved } = setup();
    const result = await useCase.registerWorkOrder(
      request({ taskId: undefined, pullRequestTitle: 1 as never }) as never,
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-pull-request-title' });
    expect(saved).toEqual([]);
  });

  it('registerWorkOrder still rejects an empty taskId when the title is valid', async () => {
    const { useCase } = setup();
    const result = await useCase.registerWorkOrder(request({ taskId: '', pullRequestTitle: 'A title' }));
    expect(result).toEqual({ outcome: 'rejected', reason: 'Missing required work order fields: taskId' });
  });

  it('registerWorkOrder refuses a throwing pullRequestTitle getter as invalid-request without calling it', async () => {
    const { useCase, saved } = setup();
    let calls = 0;
    const hostile = { ...request() };
    Object.defineProperty(hostile, 'pullRequestTitle', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('hostile getter');
      },
    });
    const result = await useCase.registerWorkOrder(hostile as never);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toBe(0);
    expect(saved).toEqual([]);
  });

  it('registerWorkOrder stores the given title and omits the field when the key is absent', async () => {
    const state = setup();
    const title = 'Add the registration title';
    const registered = await state.useCase.registerWorkOrder(request({ pullRequestTitle: title }));
    expect(registered.outcome).toBe('registered');
    const stored = await state.workOrderRepo.findWorkOrderById('wo-new');
    expect(stored?.pullRequestTitle).toBe(title);
    expect(WorkOrder.fromRecord(stored!).getPullRequestTitle()).toBe(title);

    await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-other', ownedPaths: ['packages/other/src'], pullRequestTitle: undefined }),
    );
    const other = await state.workOrderRepo.findWorkOrderById('wo-other');
    expect(Object.hasOwn(other!, 'pullRequestTitle')).toBe(false);
  });

  it('a held replay with a different title returns held-request-mismatch and does not echo the title', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    const first = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', pullRequestTitle: 'First title' }),
    );
    const second = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', pullRequestTitle: 'Second title' }),
    );
    expect(first).toMatchObject({ outcome: 'refused', held: true });
    expect(second).toEqual({ outcome: 'refused', reason: 'held-request-mismatch' });
    const listed = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(listed.outcome === 'ok' && listed.records).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('First title');
    expect(JSON.stringify(second)).not.toContain('Second title');
  });

  it('a held record does not store the pull request title text', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    const refused = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', pullRequestTitle: 'Store this title' }),
    );
    expect(refused).toMatchObject({ outcome: 'refused', held: true });
    const held = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(held.outcome).toBe('ok');
    if (held.outcome === 'ok') {
      expect(JSON.stringify(held.records[0])).not.toContain('Store this title');
    }
  });

  it('adding a title to a held no-title request returns held-request-mismatch', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }));
    const second = await state.useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', pullRequestTitle: 'New title' }),
    );
    expect(second).toEqual({ outcome: 'refused', reason: 'held-request-mismatch' });
  });
});

describe('RegisterWorkOrderUseCase titled overlap paths', () => {
  const title = 'Add the registration title';

  it('an overlapping titled registration is held without saving the work order or echoing the title', async () => {
    const { forge } = fakeForge({
      list: { outcome: 'listed', pullRequests: [openPr(42)] },
      files: { 42: { outcome: 'found', files: ['packages/a/src/x.ts'] } },
    });
    const state = setup({ forgeRead: forge });
    const refused = await state.useCase.registerWorkOrder(request({ pullRequestTitle: title }));
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'open-pr-overlap', held: true });
    expect(state.saved).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain(title);
  });

  it('a titled registration returns overlap-unknown when the forge list throws', async () => {
    const { forge } = fakeForge({ list: 'throw' });
    const state = setup({ forgeRead: forge });
    const result = await state.useCase.registerWorkOrder(request({ pullRequestTitle: title }));
    expect(result).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(state.saved).toEqual([]);
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it('a titled overlap is held false when the held store is absent', async () => {
    const workOrderRepo = new WorkOrderRepositoryAdapter();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo });
    await useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    const result = await useCase.registerWorkOrder(
      request({ workOrderId: 'wo-b', pullRequestTitle: 'A title' }),
    );
    expect(result).toMatchObject({ outcome: 'refused', reason: 'active-work-order-overlap', held: false });
  });

  it('a titled registration returns store-unavailable when save throws', async () => {
    const throwingRepo = {
      findWorkOrderById: async () => null,
      listWorkOrdersByProject: async () => [],
      saveWorkOrder: async () => {
        throw new Error('boom');
      },
    };
    const state = setup({ workOrderRepo: throwingRepo as never });
    const result = await state.useCase.registerWorkOrder(request({ pullRequestTitle: title }));
    expect(result).toEqual({ outcome: 'refused', reason: 'store-unavailable' });
  });
});

describe('computeRegisterWorkOrderRequestDigest pull request title', () => {
  const baseSnapshot = (): HeldWorkOrderRequestSnapshot => ({
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'acme/fleet',
    baseCommit: '1111111111111111111111111111111111111111',
    ownedPaths: ['packages/a/src', 'packages/b/src'],
    policyRevision: 'rev-1',
    risk: 'high',
    baseBranch: 'main',
    prerequisiteWorkOrderIds: [],
  });

  it('a snapshot with no title keeps the v1 request digest', () => {
    const workOrderId = 'wo-new';
    const snapshot = baseSnapshot();
    const expected = pureSha256Hex(
      JSON.stringify([
        'register-work-order-request/v1',
        workOrderId,
        snapshot.projectId,
        snapshot.taskId,
        snapshot.laneId,
        snapshot.repository,
        snapshot.baseCommit,
        [...snapshot.ownedPaths],
        snapshot.policyRevision,
        snapshot.risk,
        snapshot.baseBranch,
        [...snapshot.prerequisiteWorkOrderIds],
        null,
        null,
        null,
      ]),
    );
    expect(computeRegisterWorkOrderRequestDigest(workOrderId, snapshot, null)).toBe(expected);
  });

  it('two accepted titles produce two digests different from the v1 digest', () => {
    const workOrderId = 'wo-new';
    const v1 = computeRegisterWorkOrderRequestDigest(workOrderId, baseSnapshot(), null);
    const a = computeRegisterWorkOrderRequestDigest(
      workOrderId,
      { ...baseSnapshot(), pullRequestTitle: 'Add feature X' },
      null,
    );
    const b = computeRegisterWorkOrderRequestDigest(
      workOrderId,
      { ...baseSnapshot(), pullRequestTitle: 'Add feature Y' },
      null,
    );
    expect(a).not.toBe(v1);
    expect(b).not.toBe(v1);
    expect(a).not.toBe(b);
  });

  it('an invalid snapshot title does not throw and does not reuse the v1 digest', () => {
    const workOrderId = 'wo-new';
    const invalid = computeRegisterWorkOrderRequestDigest(
      workOrderId,
      { ...baseSnapshot(), pullRequestTitle: 1 } as unknown as HeldWorkOrderRequestSnapshot,
      null,
    );
    const accepted = computeRegisterWorkOrderRequestDigest(
      workOrderId,
      { ...baseSnapshot(), pullRequestTitle: 'Add feature X' },
      null,
    );
    const v1 = computeRegisterWorkOrderRequestDigest(workOrderId, baseSnapshot(), null);
    expect(invalid).not.toBe(v1);
    expect(invalid).not.toBe(accepted);
  });
});

describe('RegisterWorkOrderUseCase stale held record supersession (HR1a)', () => {
  const NEW_BASE = '2'.repeat(40);

  const releaseBlocker = async (state: ReturnType<typeof setup>, to: 'stopped' | 'merged') => {
    await state.workOrderRepo.saveWorkOrder({
      ...(await state.workOrderRepo.findWorkOrderById('wo-a'))!,
      state: to,
      revision: 2,
    });
  };

  const heldBehindWoA = async (
    state: ReturnType<typeof setup>,
    overrides: Partial<RegisterWorkOrderRequest> = {},
  ) => {
    const first = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    const second = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', ...overrides }));
    return {
      digest: (second as { requestDigest: string }).requestDigest,
      first,
      second,
    };
  };

  const seedHeld = async (
    repo: HeldWorkOrderRepositoryPort,
    overrides: Partial<HeldWorkOrderRecord> = {},
    settle = true,
  ) => {
    const record = {
      version: 1 as const,
      stage: 'intent' as const,
      intentId: 'hold-seeded',
      workOrderId: 'wo-new',
      requestDigest: 'a'.repeat(64),
      briefRequestRef: null,
      blockerKind: 'active-work-order' as const,
      blockerId: 'wo-gone',
      pathCode: 'path-000000000000',
      heldAtIso: '2026-11-07T09:00:00.000Z',
      ...overrides,
    };
    await repo.recordHoldIntent(record);
    if (settle) {
      await repo.completeHoldIntent({
        intentId: record.intentId,
        workOrderId: record.workOrderId,
        requestDigest: record.requestDigest,
      });
    }
  };

  const wrapHeld = (
    inner: HeldWorkOrderRepositoryPort,
    overrides: Partial<HeldWorkOrderRepositoryPort> = {},
  ): HeldWorkOrderRepositoryPort => ({
    listHeldWorkOrders: () => inner.listHeldWorkOrders(),
    findByWorkOrderId: (workOrderId) => inner.findByWorkOrderId(workOrderId),
    findByIntentId: (intentId) => inner.findByIntentId(intentId),
    recordHoldIntent: (record) => inner.recordHoldIntent(record),
    completeHoldIntent: (input) => inner.completeHoldIntent(input),
    deleteHeldWorkOrder: (workOrderId, requestDigest) => inner.deleteHeldWorkOrder(workOrderId, requestDigest),
    ...overrides,
  });

  const prForge = (answer: unknown) => {
    const { forge, calls } = fakeForge({ list: { outcome: 'listed', pullRequests: [] } });
    const reads: unknown[] = [];
    return {
      calls,
      reads,
      forge: {
        ...forge,
        readPullRequest: async (req: unknown) => {
          reads.push(req);
          if (answer === 'throw') throw new Error('boom');
          return answer as never;
        },
      },
    };
  };

  const prAnswer = (number: number, state: 'open' | 'merged' | 'closed') => ({
    outcome: 'found',
    pullRequest: { number, state },
  });

  it.each(['stopped', 'merged'] as const)(
    'registers a changed request once the blocker work order is %s, deletes the stale held record and reports it',
    async (to) => {
      const state = setup();
      const { digest } = await heldBehindWoA(state);
      await releaseBlocker(state, to);
      const result = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
      expect(result).toEqual({
        outcome: 'registered',
        workOrder: expect.objectContaining({ id: 'wo-b', baseCommit: NEW_BASE }),
        supersededHeld: {
          requestDigest: digest,
          blockerKind: 'active-work-order',
          blockerId: 'wo-a',
          heldAtIso: '2026-11-07T10:00:00.000Z',
        },
      });
      expect(await state.heldWorkOrderRepo.findByWorkOrderId('wo-b')).toEqual({ outcome: 'not-found' });
    },
  );

  it('refuses a changed request held-request-mismatch while the blocker work order is active and leaves the held store unchanged', async () => {
    const state = setup();
    await heldBehindWoA(state);
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }))).toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(state.saved).toHaveLength(1);
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
  });

  it('refuses held-request-mismatch when the blocker work order cannot be found', async () => {
    const state = setup();
    await seedHeld(state.heldWorkOrderRepo);
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(await state.useCase.registerWorkOrder(request())).toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
    expect(state.saved).toEqual([]);
  });

  it('refuses held-request-mismatch without throwing when the blocker lookup throws', async () => {
    const inner = new WorkOrderRepositoryAdapter();
    const state = setup({
      workOrderRepo: {
        saveWorkOrder: (r) => inner.saveWorkOrder(r),
        listWorkOrdersByProject: (p) => inner.listWorkOrdersByProject(p),
        findWorkOrderById: async (id) => {
          if (id === 'wo-gone') throw new Error('boom');
          return inner.findWorkOrderById(id);
        },
      },
    });
    await seedHeld(state.heldWorkOrderRepo);
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    await expect(state.useCase.registerWorkOrder(request())).resolves.toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
  });

  it.each(['merged', 'closed'] as const)('supersedes a stale record held behind pull request 42 once it is %s', async (state) => {
    const { reads, forge } = prForge(prAnswer(42, state));
    const setupState = setup({ forgeRead: forge as never });
    await seedHeld(setupState.heldWorkOrderRepo, { blockerKind: 'open-pr', blockerId: '42' });
    const result = await setupState.useCase.registerWorkOrder(request());
    expect(result).toEqual({
      outcome: 'registered',
      workOrder: expect.objectContaining({ id: 'wo-new' }),
      supersededHeld: {
        requestDigest: 'a'.repeat(64),
        blockerKind: 'open-pr',
        blockerId: '42',
        heldAtIso: '2026-11-07T09:00:00.000Z',
      },
    });
    expect(reads).toEqual([
      { ref: { kind: 'number', number: 42 }, repository: { owner: 'acme', repo: 'fleet' }, timeoutMs: 30000 },
    ]);
  });

  it.each([
    ['open', prAnswer(42, 'open')],
    ['not-found', { outcome: 'not-found' }],
    ['unavailable', { outcome: 'unavailable', reason: 'x' }],
    ['a different pull request number', prAnswer(43, 'merged')],
    ['null', null],
    ['a throw', 'throw'],
  ])('refuses held-request-mismatch when the blocking pull request read answers %s', async (_label, answer) => {
    const { calls, forge } = prForge(answer);
    const state = setup({ forgeRead: forge as never });
    await seedHeld(state.heldWorkOrderRepo, { blockerKind: 'open-pr', blockerId: '42' });
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(await state.useCase.registerWorkOrder(request())).toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(calls.list).toBe(0);
    expect(state.saved).toEqual([]);
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
  });

  it('refuses held-request-mismatch for a pull-request blocker when no forge read is configured, the budget is zero, or the repository is not a coordinate', async () => {
    // (i) no forgeRead at all
    const noForge = setup();
    await seedHeld(noForge.heldWorkOrderRepo, { blockerKind: 'open-pr', blockerId: '42' });
    const before = await noForge.heldWorkOrderRepo.listHeldWorkOrders();
    expect(await noForge.useCase.registerWorkOrder(request())).toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(await noForge.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);

    // (ii) a zero overlap check budget
    const merged = prForge(prAnswer(42, 'merged'));
    const zeroBudget = setup({ forgeRead: merged.forge as never, overlapCheckBudgetMs: 0 });
    await seedHeld(zeroBudget.heldWorkOrderRepo, { blockerKind: 'open-pr', blockerId: '42' });
    expect(await zeroBudget.useCase.registerWorkOrder(request())).toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(merged.reads).toEqual([]);
    expect(await zeroBudget.heldWorkOrderRepo.listHeldWorkOrders()).toMatchObject({
      outcome: 'ok',
      records: [{ workOrderId: 'wo-new', blockerKind: 'open-pr', blockerId: '42', stage: 'held' }],
    });

    // (iii) a repository value that is not a forge coordinate
    const mergedAgain = prForge(prAnswer(42, 'merged'));
    const badRepository = setup({ forgeRead: mergedAgain.forge as never });
    await seedHeld(badRepository.heldWorkOrderRepo, { blockerKind: 'open-pr', blockerId: '42' });
    expect(await badRepository.useCase.registerWorkOrder(request({ repository: 'not-a-coordinate' }))).toEqual({
      outcome: 'refused',
      reason: 'held-request-mismatch',
    });
    expect(mergedAgain.reads).toEqual([]);
    expect(await badRepository.heldWorkOrderRepo.listHeldWorkOrders()).toMatchObject({
      outcome: 'ok',
      records: [{ workOrderId: 'wo-new', blockerKind: 'open-pr', blockerId: '42', stage: 'held' }],
    });
  });

  it('replaces the stale held record when the changed request overlaps a new blocker, reports it once, and a replay reports nothing', async () => {
    const state = setup();
    const { digest, second } = await heldBehindWoA(state);
    expect(second).toMatchObject({ outcome: 'refused', reason: 'active-work-order-overlap', held: true });
    await releaseBlocker(state, 'stopped');
    expect(await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-c' }))).toMatchObject({
      outcome: 'registered',
    });
    const answer = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
    const newDigest = (answer as { requestDigest: string }).requestDigest;
    expect(newDigest).not.toBe(digest);
    expect(answer).toEqual({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'wo-c',
      pathCode: expect.stringMatching(/^path-[0-9a-f]{12}$/),
      held: true,
      requestDigest: newDigest,
      supersededHeld: {
        requestDigest: digest,
        blockerKind: 'active-work-order',
        blockerId: 'wo-a',
        heldAtIso: '2026-11-07T10:00:00.000Z',
      },
    });
    const listed = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(listed.outcome === 'ok' && listed.records).toHaveLength(1);
    expect(listed.outcome === 'ok').toBe(true);
    const record = listed.outcome === 'ok' ? listed.records[0] : undefined;
    expect(record).toMatchObject({
      workOrderId: 'wo-b',
      blockerId: 'wo-c',
      stage: 'held',
      requestDigest: newDigest,
    });
    const replay = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
    expect(Object.hasOwn(replay, 'supersededHeld')).toBe(false);
    expect(replay).toMatchObject({ reason: 'active-work-order-overlap', blockerId: 'wo-c', held: true });
    const after = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(after.outcome === 'ok' && after.records).toHaveLength(1);
  });

  it('leaves the stale held record in the store when the changed request ends overlap-unknown', async () => {
    const script: ForgeScript = { list: { outcome: 'listed', pullRequests: [] } };
    const state = setup({ forgeRead: fakeForge(script).forge });
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/z/src'] }));
    await state.workOrderRepo.saveWorkOrder({
      ...(await state.workOrderRepo.findWorkOrderById('wo-a'))!,
      state: 'stopped',
      revision: 2,
    });
    await seedHeld(state.heldWorkOrderRepo, { blockerId: 'wo-a' });
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    script.list = 'throw';
    expect(await state.useCase.registerWorkOrder(request())).toEqual({ outcome: 'refused', reason: 'overlap-unknown' });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
  });

  it.each([
    ['is refused', async () => ({ outcome: 'refused' })],
    ['answers an unknown outcome', async () => ({ outcome: 'weird' })],
    ['answers null', async () => null],
    ['throws', async () => {
      throw new Error('boom');
    }],
  ])('answers store-unavailable and records no new hold when deleting the stale record %s on the hold path', async (_label, answer) => {
    const inner = new HeldWorkOrderRepositoryAdapter();
    let recorded = 0;
    const wrapped = wrapHeld(inner, {
      deleteHeldWorkOrder: async () => (await answer()) as never,
      recordHoldIntent: (r) => {
        recorded += 1;
        return inner.recordHoldIntent(r);
      },
    });
    const state = setup({ heldWorkOrderRepo: wrapped });
    await heldBehindWoA(state);
    await releaseBlocker(state, 'stopped');
    expect(await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-c' }))).toMatchObject({
      outcome: 'registered',
    });
    recorded = 0;
    const result = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
    expect(result).toEqual({ outcome: 'refused', reason: 'store-unavailable' });
    expect(recorded).toBe(0);
    const listed = await inner.listHeldWorkOrders();
    expect(listed.outcome === 'ok' && listed.records.map((r) => [r.workOrderId, r.blockerId, r.stage])).toEqual([
      ['wo-b', 'wo-a', 'held'],
    ]);
  });

  it.each([
    ['an unknown outcome', async () => ({ outcome: 'weird' })],
    ['undefined', async () => undefined],
    ['an object without outcome', async () => ({})],
  ])('answers store-unavailable, never held, and leaves the store unchanged when recording a first-time hold answers %s', async (_label, answer) => {
    const inner = new HeldWorkOrderRepositoryAdapter();
    let armed = false;
    const wrapped = wrapHeld(inner, {
      recordHoldIntent: async (r) => (armed ? ((await answer()) as never) : inner.recordHoldIntent(r)),
    });
    const state = setup({ heldWorkOrderRepo: wrapped });
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a' }));
    armed = true;
    const result = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'store-unavailable' });
    expect(Object.hasOwn(result, 'held')).toBe(false);
    expect(await inner.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it('continues to the hold when the stale record is already gone and reports no supersession', async () => {
    const inner = new HeldWorkOrderRepositoryAdapter();
    let recorded = 0;
    const wrapped = wrapHeld(inner, {
      deleteHeldWorkOrder: async () => ({ outcome: 'not-found' }),
      recordHoldIntent: (r) => {
        recorded += 1;
        return inner.recordHoldIntent(r);
      },
    });
    const state = setup({ heldWorkOrderRepo: wrapped });
    await heldBehindWoA(state);
    await releaseBlocker(state, 'stopped');
    expect(await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-c' }))).toMatchObject({
      outcome: 'registered',
    });
    recorded = 0;
    const answer = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
    expect(answer).toEqual({ outcome: 'refused', reason: 'held-request-mismatch' });
    expect(recorded).toBe(1);
    expect(Object.hasOwn(answer, 'supersededHeld')).toBe(false);
  });

  it.each([
    ['is refused', async () => ({ outcome: 'refused' })],
    ['throws', async () => {
      throw new Error('boom');
    }],
  ])('still registers and reports no supersession when deleting the stale record %s after the save', async (_label, answer) => {
    const inner = new HeldWorkOrderRepositoryAdapter();
    const wrapped = wrapHeld(inner, { deleteHeldWorkOrder: async () => (await answer()) as never });
    const state = setup({ heldWorkOrderRepo: wrapped });
    await heldBehindWoA(state);
    await releaseBlocker(state, 'stopped');
    const result = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
    expect(result.outcome).toBe('registered');
    expect(Object.hasOwn(result, 'supersededHeld')).toBe(false);
    expect(await state.workOrderRepo.findWorkOrderById('wo-b')).not.toBeNull();
  });

  it('supersedes a stale intent-stage record whose blocker work order is stopped', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/z/src'] }));
    await state.workOrderRepo.saveWorkOrder({
      ...(await state.workOrderRepo.findWorkOrderById('wo-a'))!,
      state: 'stopped',
      revision: 2,
    });
    await seedHeld(state.heldWorkOrderRepo, { blockerId: 'wo-a' }, false);
    const result = await state.useCase.registerWorkOrder(request());
    expect(result).toMatchObject({
      outcome: 'registered',
      supersededHeld: { requestDigest: 'a'.repeat(64), blockerId: 'wo-a' },
    });
    expect(await state.heldWorkOrderRepo.findByWorkOrderId('wo-new')).toEqual({ outcome: 'not-found' });
  });

  it('refuses intent-digest-mismatch for a stale intent-stage record whose blocker is still active', async () => {
    const state = setup();
    await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-a', ownedPaths: ['packages/z/src'] }));
    await seedHeld(state.heldWorkOrderRepo, { blockerId: 'wo-a' }, false);
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(await state.useCase.registerWorkOrder(request())).toEqual({
      outcome: 'refused',
      reason: 'intent-digest-mismatch',
    });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
  });

  it('keeps an explicit intent id an idempotency key after the blocker is released', async () => {
    const state = setup();
    await heldBehindWoA(state, { intentId: 'intent-1' });
    await releaseBlocker(state, 'stopped');
    const before = await state.heldWorkOrderRepo.listHeldWorkOrders();
    expect(
      await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', intentId: 'intent-1', baseCommit: NEW_BASE })),
    ).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });
    expect(await state.heldWorkOrderRepo.listHeldWorkOrders()).toEqual(before);
    expect(await state.workOrderRepo.findWorkOrderById('wo-b')).toBeNull();
  });

  it('registers the unchanged request after release without a supersededHeld key', async () => {
    const state = setup();
    await heldBehindWoA(state);
    await releaseBlocker(state, 'stopped');
    const answer = await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b' }));
    expect(answer.outcome).toBe('registered');
    expect(Object.hasOwn(answer, 'supersededHeld')).toBe(false);
  });

  describe('replacement hold failing after the stale record was deleted', () => {
    const REFUSED = { outcome: 'refused', reason: 'store-unavailable' } as const;

    const arrange = async (overrides: (inner: HeldWorkOrderRepositoryPort, staleDigest: string) => Partial<HeldWorkOrderRepositoryPort>) => {
      const inner = new HeldWorkOrderRepositoryAdapter();
      // The overrides are armed only after the setup holds, so the first hold is a real one.
      let active: Partial<HeldWorkOrderRepositoryPort> = {};
      const wrapped = wrapHeld(inner, {
        recordHoldIntent: (record) => (active.recordHoldIntent ?? ((r) => inner.recordHoldIntent(r)))(record),
        completeHoldIntent: (input) => (active.completeHoldIntent ?? ((i) => inner.completeHoldIntent(i)))(input),
        deleteHeldWorkOrder: (id, digest) =>
          (active.deleteHeldWorkOrder ?? ((a, b) => inner.deleteHeldWorkOrder(a, b)))(id, digest),
      });
      const state = setup({ heldWorkOrderRepo: wrapped });
      const { digest } = await heldBehindWoA(state);
      await releaseBlocker(state, 'stopped');
      expect(await state.useCase.registerWorkOrder(request({ workOrderId: 'wo-c' }))).toMatchObject({
        outcome: 'registered',
      });
      const before = await inner.listHeldWorkOrders();
      expect(before).toMatchObject({ outcome: 'ok', records: [{ workOrderId: 'wo-b', stage: 'held', requestDigest: digest }] });
      active = overrides(inner, digest);
      const changed = () => state.useCase.registerWorkOrder(request({ workOrderId: 'wo-b', baseCommit: NEW_BASE }));
      return { inner, before, changed };
    };

    const isReplacement = (record: HeldWorkOrderRecord) => record.blockerId === 'wo-c';

    it.each([
      ['refuses', async () => ({ outcome: 'refused', reason: 'store-unavailable' })],
      ['throws', async () => {
        throw new Error('boom');
      }],
    ])('restores the stale record byte-identical and leaves no replacement intent when completing the hold %s', async (_label, answer) => {
      const { inner, before, changed } = await arrange((repo, staleDigest) => ({
        // Only the replacement's completion fails; the stale record's own settle must work.
        completeHoldIntent: async (input) =>
          input.requestDigest === staleDigest ? repo.completeHoldIntent(input) : ((await answer()) as never),
      }));
      const result = await changed();
      expect(result).toEqual(REFUSED);
      expect(Object.hasOwn(result, 'supersededHeld')).toBe(false);
      expect(await inner.listHeldWorkOrders()).toEqual(before);
    });

    it.each([
      ['refuses', async () => ({ outcome: 'refused', reason: 'store-unavailable' })],
      ['throws', async () => {
        throw new Error('boom');
      }],
    ])('restores the stale record when recording the replacement intent %s', async (_label, answer) => {
      const { inner, before, changed } = await arrange((repo) => ({
        recordHoldIntent: async (record) => (isReplacement(record) ? ((await answer()) as never) : repo.recordHoldIntent(record)),
      }));
      const result = await changed();
      expect(result).toEqual(REFUSED);
      expect(await inner.listHeldWorkOrders()).toEqual(before);
    });

    it('answers store-unavailable when completion keeps failing, so the stale record cannot be settled again', async () => {
      const { inner, changed } = await arrange(() => ({
        completeHoldIntent: async () => ({ outcome: 'refused', reason: 'store-unavailable' }),
      }));
      const result = await changed();
      expect(result).toEqual(REFUSED);
      expect(Object.hasOwn(result, 'supersededHeld')).toBe(false);
      const listed = await inner.listHeldWorkOrders();
      // Truthful, not clean: the stale record is back as its intent and no replacement remains.
      expect(listed.outcome === 'ok' && listed.records.map((r) => [r.blockerId, r.stage])).toEqual([['wo-a', 'intent']]);
    });

    it('answers store-unavailable and says so when the replacement intent cannot be removed after a refused completion', async () => {
      let deletes = 0;
      const { inner, changed } = await arrange((repo) => ({
        completeHoldIntent: async () => ({ outcome: 'refused', reason: 'store-unavailable' }),
        deleteHeldWorkOrder: async (workOrderId, digest) => {
          deletes += 1;
          // The first delete is the stale one; every later one (the replacement's removal) is refused.
          return deletes === 1 ? repo.deleteHeldWorkOrder(workOrderId, digest) : { outcome: 'refused' };
        },
      }));
      const result = await changed();
      expect(result).toEqual(REFUSED);
      expect(Object.hasOwn(result, 'supersededHeld')).toBe(false);
      const listed = await inner.listHeldWorkOrders();
      expect(listed.outcome === 'ok' && listed.records.map((r) => [r.blockerId, r.stage])).toEqual([['wo-c', 'intent']]);
    });

    it('answers store-unavailable, never held, when recording the replacement answers an unrecognised outcome (after a superseded stale delete)', async () => {
      const { inner, before, changed } = await arrange((repo) => ({
        recordHoldIntent: async (record) => (isReplacement(record) ? (({ outcome: 'weird' }) as never) : repo.recordHoldIntent(record)),
      }));
      const result = await changed();
      expect(result).toEqual(REFUSED);
      expect(Object.hasOwn(result, 'held')).toBe(false);
      expect(Object.hasOwn(result, 'supersededHeld')).toBe(false);
      expect(await inner.listHeldWorkOrders()).toEqual(before);
    });

    it('restores the stale record when its delete is refused although the record is gone', async () => {
      const { inner, before, changed } = await arrange((repo) => ({
        deleteHeldWorkOrder: async (workOrderId, digest) => {
          await repo.deleteHeldWorkOrder(workOrderId, digest);
          return { outcome: 'refused' };
        },
      }));
      const result = await changed();
      expect(result).toEqual(REFUSED);
      expect(Object.hasOwn(result, 'supersededHeld')).toBe(false);
      expect(await inner.listHeldWorkOrders()).toEqual(before);
    });

    it('supersedes and leaves exactly one record on the happy path', async () => {
      const { inner, before, changed } = await arrange(() => ({}));
      const result = await changed();
      expect(result).toMatchObject({
        outcome: 'refused',
        reason: 'active-work-order-overlap',
        held: true,
        supersededHeld: { blockerId: 'wo-a' },
      });
      const listed = await inner.listHeldWorkOrders();
      expect(listed.outcome === 'ok' && listed.records).toHaveLength(1);
      expect(listed).not.toEqual(before);
      expect(listed.outcome === 'ok' && listed.records[0]).toMatchObject({ blockerId: 'wo-c', stage: 'held' });
    });
  });
});
