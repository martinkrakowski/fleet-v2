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
import { ProjectProfileReadAdapter } from '../../../infrastructure/adapters/ProjectProfileReadAdapter.adapter.js';
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

  it('refuses a staging profile defaultBranch with unsupported-profile-base and writes nothing', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(
        new Map([['proj-1', profileView({ defaultBranch: 'staging' })]]),
      ),
    });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'unsupported-profile-base' });
    // The refused registration must not persist the unsupported base.
    expect(workOrderRepo.orders.size).toBe(0);
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

  it('refuses empty, non-string, oversized, and unsafe profile defaultBranch values through the real adapter', async () => {
    // Finding RP1-4: the malformed defaultBranch cases run through the real
    // ProjectProfileReadAdapter, which throws on them and produces
    // malformed-profile at the use case; no hand-built profile view is used.
    for (const defaultBranch of ['', '   ', 42, true, '../x', '-x', 'a..b', 'x.lock', 'a//b', 'a'.repeat(201)]) {
      const workOrderRepo = new FakeWorkOrderRepo();
      const useCase = new RegisterWorkOrderUseCase({
        workOrderRepo,
        profileRead: new ProjectProfileReadAdapter({
          inspect: async () => ({
            outcome: 'found',
            profile: { ...profileView(), defaultBranch },
          }),
        }),
      });
      const result = await useCase.registerWorkOrder(validRequest());
      expect(result).toEqual({ outcome: 'refused', reason: 'malformed-profile' });
      expect(workOrderRepo.orders.size).toBe(0);
    }
  });

  it('refuses a chain-shaped but unsupported profile defaultBranch through the real adapter', async () => {
    // `staging` is a safe name the adapter maps through; the registration
    // check, not the adapter, refuses it as unsupported-profile-base.
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new ProjectProfileReadAdapter({
        inspect: async () => ({
          outcome: 'found',
          profile: { ...profileView(), defaultBranch: 'staging' },
        }),
      }),
    });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'unsupported-profile-base' });
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

  it('rejects a retired project with the retired reason even when its defaultBranch is malformed or unsupported', async () => {
    for (const defaultBranch of ['staging', 'bad..branch', '-x', 'a'.repeat(201), 42]) {
      const workOrderRepo = new FakeWorkOrderRepo();
      const useCase = new RegisterWorkOrderUseCase({
        workOrderRepo,
        profileRead: new FakeProfileRead(
          new Map([['proj-1', profileView({ status: 'retired', defaultBranch: defaultBranch as string })]]),
        ),
      });
      const result = await useCase.registerWorkOrder(validRequest());
      expect(result).toEqual({
        outcome: 'rejected',
        reason: expect.stringContaining('project proj-1 is retired; it accepts no new work orders'),
      });
      expect(workOrderRepo.orders.size).toBe(0);
    }
  });

  it('accepts an explicit baseBranch main whatever the profile defaultBranch is, and refuses the same profile without one', async () => {
    for (const defaultBranch of ['bad..branch', 'staging', '-x']) {
      const workOrderRepo = new FakeWorkOrderRepo();
      const useCase = new RegisterWorkOrderUseCase({
        workOrderRepo,
        profileRead: new FakeProfileRead(new Map([['proj-1', profileView({ defaultBranch })]])),
      });
      const explicit = await useCase.registerWorkOrder(validRequest({ baseBranch: 'main' }));
      expect(explicit.outcome).toBe('registered');
      expect(workOrderRepo.orders.get('wo-1')?.baseBranch).toBe('main');

      // Without an explicit base the profile default still decides: the same profile is refused.
      const implicit = await useCase.registerWorkOrder(validRequest({ workOrderId: 'wo-2' }));
      expect(implicit).toEqual({
        outcome: 'refused',
        reason: defaultBranch === 'staging' ? 'unsupported-profile-base' : 'malformed-profile',
      });
      expect(workOrderRepo.orders.has('wo-2')).toBe(false);
    }
  });

  it('refuses a profile whose getPrototypeOf trap throws with malformed-profile and writes nothing', async () => {
    // `isPlainRecordObject` reads the prototype once. A trap that throws is
    // the typed malformed-profile refusal, not a rejection of the promise.
    let trapped = false;
    const profile = new Proxy(profileView(), {
      getPrototypeOf() {
        trapped = true;
        throw new Error('getPrototypeOf trap');
      },
    });
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({
      workOrderRepo,
      profileRead: new FakeProfileRead(new Map([['proj-1', profile as unknown as ProjectProfileView]])),
    });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(trapped).toBe(true);
    expect(result).toEqual({ outcome: 'refused', reason: 'malformed-profile' });
    expect(workOrderRepo.orders.size).toBe(0);
  });
});
