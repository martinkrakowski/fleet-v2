/**
 * Unit tests for the RP1 profile-default-branch addition to
 * RegisterWorkOrderUseCase. In-memory work-order repo and profile-read fakes;
 * no filesystem or clock.
 */

import { describe, expect, it } from 'vitest';

import type { WorkOrderRecord } from '../../../domain/execution-records.js';
import type {
  ProjectProfileReadPort,
  ProjectProfileView,
} from '../../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';

class FakeWorkOrderRepo implements WorkOrderRepositoryPort {
  readonly orders = new Map<string, WorkOrderRecord>();

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    this.orders.set(record.id, record);
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.orders.get(workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId: string): Promise<readonly WorkOrderRecord[]> {
    return [...this.orders.values()].filter((order) => order.projectId === projectId);
  }
}

class FakeProfileRead implements ProjectProfileReadPort {
  constructor(
    private readonly profiles: ReadonlyMap<string, ProjectProfileView>,
    private readonly throwOnRead = false,
  ) {}

  async readProjectProfile(projectId: string): Promise<ProjectProfileView | null> {
    if (this.throwOnRead) {
      throw new Error('profile read exploded');
    }
    // A stored `undefined` profile stays `undefined` (RP1: malformed-profile);
    // only a missing project maps to `null` (no profile).
    return this.profiles.has(projectId) ? this.profiles.get(projectId)! : null;
  }
}

function profileView(overrides: Partial<ProjectProfileView> = {}): ProjectProfileView {
  return {
    projectId: 'proj-1',
    status: 'active',
    repository: 'git@example.org:acme/app.git',
    clones: {},
    gateProcedures: [],
    revision: 1,
    ...overrides,
  };
}

function validRequest(
  overrides: Partial<Parameters<RegisterWorkOrderUseCase['registerWorkOrder']>[0]> = {},
) {
  return {
    workOrderId: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/app-a/**'],
    policyRevision: 'policy-7',
    nowIso: '2026-11-21T08:00:00.000Z',
    ...overrides,
  };
}

describe('RegisterWorkOrderUseCase profile defaultBranch (RP1)', () => {
  it('falls back to main when defaultBranch is absent, undefined, or null', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(
        new Map([
          ['proj-1', profileView()],
          ['proj-2', profileView({ projectId: 'proj-2', defaultBranch: undefined })],
          ['proj-3', profileView({ projectId: 'proj-3', defaultBranch: null })],
        ]),
      ),
    });
    for (const projectId of ['proj-1', 'proj-2', 'proj-3']) {
      const result = await useCase.registerWorkOrder(validRequest({ projectId, workOrderId: `wo-${projectId}` }));
      expect(result.outcome).toBe('registered');
      if (result.outcome === 'registered') {
        expect(result.workOrder.baseBranch).toBe('main');
      }
    }
    expect(workOrderRepo.orders.get('wo-proj-1')?.baseBranch).toBe('main');
  });

  it('resolves staging from active profile defaultBranch when request.baseBranch is absent', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(
        new Map([['proj-1', profileView({ defaultBranch: 'staging' })]]),
      ),
    });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result).toEqual({
      outcome: 'registered',
      workOrder: expect.objectContaining({ id: 'wo-1', baseBranch: 'staging' }),
    });
    expect(workOrderRepo.orders.get('wo-1')?.baseBranch).toBe('staging');
  });

  it('prefers explicit request.baseBranch over profile defaultBranch', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(
        new Map([['proj-1', profileView({ defaultBranch: 'staging' })]]),
      ),
    });
    const result = await useCase.registerWorkOrder(validRequest({ baseBranch: 'chain/example-1' }));
    expect(result.outcome).toBe('registered');
    if (result.outcome === 'registered') {
      expect(result.workOrder.baseBranch).toBe('chain/example-1');
    }
  });

  it('keeps main fallback when profileRead is not configured', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result.outcome).toBe('registered');
    if (result.outcome === 'registered') {
      expect(result.workOrder.baseBranch).toBe('main');
    }
  });

  it('preserves existing rejection when profile is missing or retired', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(
        new Map([['proj-1', profileView({ status: 'retired' })]]),
      ),
    });
    const retired = await useCase.registerWorkOrder(validRequest());
    expect(retired.outcome).toBe('rejected');
    if (retired.outcome === 'rejected') {
      expect(retired.reason).toContain('retired');
    }

    const missing = await useCase.registerWorkOrder(
      validRequest({ projectId: 'proj-other', workOrderId: 'wo-2' }),
    );
    expect(missing).toEqual({ outcome: 'rejected', reason: expect.stringContaining('no profile') });
  });

  it('refuses empty, non-string, oversized, and unsafe profile defaultBranch values', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(
        new Map([['proj-1', profileView({ defaultBranch: 'a'.repeat(1_000_000) })]]),
      ),
    });
    const oversized = await useCase.registerWorkOrder(validRequest());
    expect(oversized).toEqual({
      outcome: 'refused',
      reason: 'invalid-profile-default-branch',
    });

    for (const defaultBranch of ['', '   ', 42, true, '../x', '-x', 'a..b', 'x.lock', 'a//b']) {
      const refusing = new RegisterWorkOrderUseCase({
        workOrderRepo: new FakeWorkOrderRepo(),
        profileRead: new FakeProfileRead(new Map([['proj-1', profileView({ defaultBranch } as never)]])),
      });
      const result = await refusing.registerWorkOrder(validRequest());
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-profile-default-branch' });
    }
    expect(workOrderRepo.orders.size).toBe(0);
  });

  it('refuses non-plain profile values with malformed-profile', async () => {
    class Profile {
      defaultBranch = 'staging';
    }
    // `null` keeps the existing no-profile rejection; every other non-plain
    // value is a malformed answer and refuses typed.
    const holey: unknown[] = [1];
    delete holey[0];
    for (const profile of [undefined, 42, true, 'staging', Symbol('x'), holey, new Profile()]) {
      const useCase = new RegisterWorkOrderUseCase({
        workOrderRepo: new FakeWorkOrderRepo(),
        profileRead: new FakeProfileRead(
          new Map([['proj-1', profile as unknown as ProjectProfileView]]),
        ),
      });
      const result = await useCase.registerWorkOrder(validRequest());
      expect(result).toEqual({ outcome: 'refused', reason: 'malformed-profile' });
    }
  });

  it('refuses own __proto__, constructor, and prototype keys individually', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const profile: Record<string, unknown> = { status: 'active', defaultBranch: 'staging' };
      Object.defineProperty(profile, key, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const useCase = new RegisterWorkOrderUseCase({
        workOrderRepo: new FakeWorkOrderRepo(),
        profileRead: new FakeProfileRead(new Map([['proj-1', profile as unknown as ProjectProfileView]])),
      });
      const result = await useCase.registerWorkOrder(validRequest());
      expect(result).toEqual({ outcome: 'refused', reason: 'malformed-profile' });
    }
  });

  it('refuses accessor or throwing getter on defaultBranch without invoking it', async () => {
    let called = false;
    const profile: Record<string, unknown> = { projectId: 'proj-1', status: 'active' };
    Object.defineProperty(profile, 'defaultBranch', {
      enumerable: true,
      configurable: true,
      get() {
        called = true;
        throw new Error('getter must never run');
      },
    });
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo: new FakeWorkOrderRepo(),
      profileRead: new FakeProfileRead(new Map([['proj-1', profile as unknown as ProjectProfileView]])),
    });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'malformed-profile' });
    expect(called).toBe(false);
  });

  it('refuses malformed defaultBranch in ProjectProfileReadAdapter and thrown reads in RegisterWorkOrderUseCase', async () => {
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo: new FakeWorkOrderRepo(),
      profileRead: new FakeProfileRead(new Map(), true),
    });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'malformed-profile' });
  });
});
