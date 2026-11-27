import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  REGISTERED_CROSS_ORG_REFUSAL_TESTS,
  findPortsWithoutRefusalTest,
  runCrossOrgRefusalContract,
  type CrossOrgRefusalContractResult,
  type PortCoverageResult,
} from '../../../application/ports/out/__tests__/cross-org-refusal.contract.js';
import { OrganizationRepositoryAdapter } from '../OrganizationRepositoryAdapter.adapter.js';
import { MembershipRepositoryAdapter } from '../MembershipRepositoryAdapter.adapter.js';
import type { ProjectRecord } from '../../../domain/entities/Project.js';

const NOW = '2026-11-26T00:00:00.000Z';
const SEED_ID = 'rec-b-only';
const PORTS_DIR = fileURLToPath(new URL('../../../application/ports/out', import.meta.url));

/**
 * The one infrastructure step of the coverage check: read the real ports
 * directory. A read failure is `unreadable-directory` — never an empty list,
 * so an unreadable directory can never look fully covered.
 */
async function readPortFileNames(
  directory: string,
): Promise<{ ok: true; files: string[] } | { ok: false; reason: 'unreadable-directory' }> {
  try {
    return { ok: true, files: await fs.readdir(directory) };
  } catch {
    return { ok: false, reason: 'unreadable-directory' };
  }
}

/** A real timer promise resolving with 'timeout' after `ms` milliseconds. */
function realWaitTimeout(ms: number): Promise<'timeout'> {
  return new Promise<'timeout'>((resolve) => setTimeout(resolve, ms, 'timeout'));
}

/** An isolated in-memory org-scoped fake: closures keyed by organizationId. */
function isolatedFactory(): object {
  const store = new Map<string, Map<string, unknown>>();
  return {
    createForOrg: (orgId: string) => ({
      get: async (id: string) => store.get(orgId)?.get(id) ?? null,
      list: async () => [...(store.get(orgId)?.values() ?? [])],
      delete: async (id: string) => {
        const owned = store.get(orgId);
        if (owned === undefined || !owned.has(id)) {
          return { status: 'refused', reason: 'not-found' };
        }
        owned.delete(id);
        return { status: 'refused', reason: 'not-found' };
      },
    }),
    seedRecord: async (orgId: string, id: string) => {
      let owned = store.get(orgId);
      if (owned === undefined) {
        owned = new Map();
        store.set(orgId, owned);
      }
      owned.set(id, { id, organizationId: orgId });
    },
  };
}

/** A deliberately leaky in-memory fake that ignores `orgId` entirely. */
function leakyFactory(): object {
  const store = new Map<string, unknown>();
  return {
    createForOrg: async () => ({
      get: (id: string) => store.get(id) ?? null,
      list: () => [...store.values()],
      delete: (id: string) => {
        const removed = store.delete(id);
        return removed ? { status: 'deleted' } : { status: 'refused', reason: 'not-found' };
      },
    }),
    seedRecord: async (orgId: string, id: string) => {
      store.set(id, { id, organizationId: orgId });
    },
    cleanup: async () => {
      store.clear();
    },
  };
}

describe('cross-org refusal coverage enumeration', () => {
  it('returns empty uncovered list for empty listing and flags unregistered repository port file', () => {
    expect(findPortsWithoutRefusalTest([], [], types.isProxy)).toEqual({ ok: true, uncovered: [] });
    expect(findPortsWithoutRefusalTest(['FakeRepositoryPort.out-port.ts'], [], types.isProxy)).toEqual({
      ok: true,
      uncovered: ['FakeRepositoryPort'],
    });
  });

  it('refuses an unreadable ports directory instead of treating it as empty', async () => {
    // A regular file path is not a directory: readdir refuses it.
    const filePath = `${PORTS_DIR}/OrganizationRepositoryPort.out-port.ts`;
    expect(await readPortFileNames(filePath)).toEqual({ ok: false, reason: 'unreadable-directory' });
    // A missing path is unreadable too.
    expect(await readPortFileNames(`${PORTS_DIR}/does-not-exist`)).toEqual({
      ok: false,
      reason: 'unreadable-directory',
    });
    // The real directory reads, and every real port is registered.
    const read = await readPortFileNames(PORTS_DIR);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    const result: PortCoverageResult = findPortsWithoutRefusalTest(
      read.files,
      REGISTERED_CROSS_ORG_REFUSAL_TESTS,
      types.isProxy,
    );
    expect(result).toEqual({ ok: true, uncovered: [] });
  });

  it('refuses non-array, wrong primitive, and malformed entries without echoing values', () => {
    expect(findPortsWithoutRefusalTest('not-an-array', [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest(42, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest({}, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest([''], [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest([], {}, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-registry',
    });
    expect(findPortsWithoutRefusalTest([], [7], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-registry',
    });
  });

  it('refuses a repository whose list() returns a non-array', async () => {
    const factory = {
      createForOrg: async () => ({ get: async () => null, list: async () => 'nope' }),
      seedRecord: async () => {},
    };
    expect(await runCrossOrgRefusalContract(factory, types.isProxy)).toEqual({
      ok: false,
      reason: 'malformed-list-result',
    });
  });

  it('refuses null, undefined, and omitted or non-function isProxy inputs on both enumerator and contract helper', async () => {
    // Malformed data inputs stay typed per-list.
    expect(findPortsWithoutRefusalTest(null, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest([], undefined, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-registry',
    });
    expect(await runCrossOrgRefusalContract(null, types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-factory',
    });
    // An omitted or non-function isProxy is hostile on both entry points.
    const enumerate = findPortsWithoutRefusalTest as unknown as (
      files: unknown,
      registry: unknown,
    ) => PortCoverageResult;
    expect(enumerate([], [])).toEqual({ ok: false, reason: 'hostile-input' });
    expect(findPortsWithoutRefusalTest([], [], undefined as never)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    expect(findPortsWithoutRefusalTest([], [], 42 as never)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const run = runCrossOrgRefusalContract as unknown as (
      factory: unknown,
    ) => Promise<CrossOrgRefusalContractResult>;
    expect(await run({})).toEqual({ ok: false, reason: 'hostile-input' });
    expect(await runCrossOrgRefusalContract({}, undefined as never)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
  });

  it('refuses throwing or side-effecting getters without invoking them', async () => {
    let getterCalls = 0;
    const elementWithGetter: string[] = [];
    Object.defineProperty(elementWithGetter, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'OrganizationRepositoryPort.out-port.ts';
      },
    });
    const lengthWithGetter: Record<string, unknown> = {};
    Object.defineProperty(lengthWithGetter, 'length', {
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(findPortsWithoutRefusalTest(elementWithGetter, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    expect(findPortsWithoutRefusalTest(lengthWithGetter, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const factoryWithGetter = {};
    Object.defineProperty(factoryWithGetter, 'createForOrg', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => ({});
      },
    });
    expect(await runCrossOrgRefusalContract(factoryWithGetter, types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const repoWithGetter = {};
    Object.defineProperty(repoWithGetter, 'get', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => null;
      },
    });
    expect(
      await runCrossOrgRefusalContract(
        { createForOrg: () => repoWithGetter, seedRecord: async () => {} },
        types.isProxy,
      ),
    ).toEqual({ ok: false, reason: 'hostile-input' });
    expect(getterCalls).toBe(0);
  });

  it('refuses a native Promise with an own then getter without invoking the getter even when waitTimeout is provided', async () => {
    for (const withTimer of [false, true]) {
      let getterCalls = 0;
      const tainted = Promise.resolve(null);
      Object.defineProperty(tainted, 'then', {
        get() {
          getterCalls += 1;
          return Promise.prototype.then;
        },
      });
      const factory = {
        createForOrg: async () => ({ get: () => tainted, list: async () => [] }),
        seedRecord: async () => {},
      };
      const result = await runCrossOrgRefusalContract(
        factory,
        types.isProxy,
        undefined,
        withTimer ? realWaitTimeout : undefined,
      );
      expect(result).toEqual({ ok: false, reason: 'hostile-input' });
      expect(getterCalls).toBe(0);
    }
  });

  it('refuses Proxy inputs via types.isProxy without firing Proxy traps', async () => {
    let trapCalls = 0;
    const countingHandler = {
      get(target: object, key: PropertyKey) {
        trapCalls += 1;
        return Reflect.get(target, key);
      },
    };
    const portFiles = new Proxy([], countingHandler);
    expect(findPortsWithoutRefusalTest(portFiles, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const proxyFactory = new Proxy<object>(
      { createForOrg: () => ({}), seedRecord: async () => {} },
      countingHandler,
    );
    expect(await runCrossOrgRefusalContract(proxyFactory, types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const proxyPromise = new Proxy(Promise.resolve(null), countingHandler);
    const factory = {
      createForOrg: async () => ({ get: () => proxyPromise, list: async () => [] }),
      seedRecord: async () => {},
    };
    expect(
      await runCrossOrgRefusalContract(factory, types.isProxy, undefined, realWaitTimeout),
    ).toEqual({ ok: false, reason: 'hostile-input' });
    expect(trapCalls).toBe(0);
  });

  it('refuses array holes, array-likes, oversized lengths, and prototype-polluting keys', async () => {
    const holey: unknown[] = new Array(3);
    holey[1] = 'OrganizationRepositoryPort.out-port.ts';
    expect(findPortsWithoutRefusalTest(holey, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    expect(findPortsWithoutRefusalTest({ length: 2, 0: 'a', 1: 'b' }, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest({ length: 1_000_000 }, [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest(['__proto__'], [], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-port-list',
    });
    expect(findPortsWithoutRefusalTest([], ['__proto__'], types.isProxy)).toEqual({
      ok: false,
      reason: 'invalid-registry',
    });
    const factory = { ['constructor']: () => ({}), seedRecord: async () => {} };
    expect(await runCrossOrgRefusalContract(factory, types.isProxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    expect(
      await runCrossOrgRefusalContract(
        {
          createForOrg: () => ({ get: async () => null, list: async () => [] }),
          seedRecord: async () => {},
          ['prototype']: async () => {},
        },
        types.isProxy,
      ),
    ).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses a stalled repository operation with timeout via injected timer and runs cleanup in finally', async () => {
    let cleanupCalled = false;
    const factory = {
      createForOrg: async () => ({
        get: () => new Promise<never>(() => {}),
        list: async () => [],
      }),
      seedRecord: async () => {},
      cleanup: async () => {
        cleanupCalled = true;
      },
    };
    expect(
      await runCrossOrgRefusalContract(factory, types.isProxy, { timeoutMs: 30 }, realWaitTimeout),
    ).toEqual({ ok: false, reason: 'timeout' });
    expect(cleanupCalled).toBe(true);
  });

  it('refuses execution when operation budget is exhausted and runs cleanup after seeding', async () => {
    let cleanupCalled = false;
    const factory = {
      createForOrg: async () => ({
        get: async () => null,
        list: async () => [],
        delete: async () => ({ status: 'refused', reason: 'not-found' }),
      }),
      seedRecord: async () => {},
      cleanup: async () => {
        cleanupCalled = true;
      },
    };
    // A zero budget refuses before any operation runs.
    expect(await runCrossOrgRefusalContract(factory, types.isProxy, { maxOperations: 0 })).toEqual({
      ok: false,
      reason: 'exhausted-budget',
    });
    // With createForOrg + seedRecord + get = 3, the list operation exhausts
    // the budget after seeding, and cleanup still runs.
    expect(await runCrossOrgRefusalContract(factory, types.isProxy, { maxOperations: 3 })).toEqual({
      ok: false,
      reason: 'exhausted-budget',
    });
    expect(cleanupCalled).toBe(true);
  });

  it('refuses a repository missing get or list or supplying non-function delete', async () => {
    expect(
      await runCrossOrgRefusalContract(
        { createForOrg: async () => ({ list: async () => [] }), seedRecord: async () => {} },
        types.isProxy,
      ),
    ).toEqual({ ok: false, reason: 'missing-port-method', missingMethod: 'get' });
    expect(
      await runCrossOrgRefusalContract(
        { createForOrg: async () => ({ get: async () => null }), seedRecord: async () => {} },
        types.isProxy,
      ),
    ).toEqual({ ok: false, reason: 'missing-port-method', missingMethod: 'list' });
    expect(
      await runCrossOrgRefusalContract(
        {
          createForOrg: async () => ({
            get: async () => null,
            list: async () => [],
            delete: 5,
          }),
          seedRecord: async () => {},
        },
        types.isProxy,
      ),
    ).toEqual({ ok: false, reason: 'missing-port-method', missingMethod: 'delete' });
    // Omitting delete altogether passes for ports without a delete method.
    expect(
      await runCrossOrgRefusalContract(
        {
          createForOrg: async () => ({ get: async () => null, list: async () => [] }),
          seedRecord: async () => {},
        },
        types.isProxy,
      ),
    ).toEqual({ ok: true });
  });

  it('refuses get result that carries a refusal marker alongside the seeded record', async () => {
    const factory = {
      createForOrg: async () => ({
        get: async () => ({ status: 'refused', reason: 'not-found', record: { projectId: SEED_ID } }),
        list: async () => [],
      }),
      seedRecord: async () => {},
    };
    expect(await runCrossOrgRefusalContract(factory, types.isProxy)).toEqual({
      ok: false,
      reason: 'cross-org-leak',
      violations: ['get'],
    });
  });

  it('refuses list result whose primitive string entry exposes the seeded cross-org ID', async () => {
    const factory = {
      createForOrg: async () => ({
        get: async () => null,
        list: async () => [SEED_ID],
      }),
      seedRecord: async () => {},
    };
    expect(await runCrossOrgRefusalContract(factory, types.isProxy)).toEqual({
      ok: false,
      reason: 'cross-org-leak',
      violations: ['list'],
    });
  });

  it('requires positive record evidence after a refused delete, not merely a non-null non-refusal result', async () => {
    // A delete that returns `false` is accepted as a refusal; the verifying
    // read through the seeded organisation must then SHOW the record. A
    // seeded-org read that returns a bare primitive, an empty object or a
    // refusal marker is not evidence, and a record carrying the seeded id is.
    function falseDeleteFactory(seededRead: unknown): object {
      return {
        createForOrg: (orgId: string) => ({
          get: async () => (orgId === 'org-b' ? seededRead : null),
          list: async () => [],
          delete: async () => false,
        }),
        seedRecord: async () => undefined,
      };
    }
    const evidence = { id: SEED_ID, organizationId: 'org-b' };
    expect(await runCrossOrgRefusalContract(falseDeleteFactory(evidence), types.isProxy)).toEqual({ ok: true });
    for (const notEvidence of [false, true, 0, 'present', {}, [], null, { status: 'refused', reason: 'not-found' }]) {
      expect(await runCrossOrgRefusalContract(falseDeleteFactory(notEvidence), types.isProxy)).toEqual({
        ok: false,
        reason: 'cross-org-leak',
        violations: ['delete'],
      });
    }
  });

  it('passes for OrganizationRepositoryAdapter and MembershipRepositoryAdapter and reports cross-org leaks on a leaky fake', async () => {
    const organizationAdapter = new OrganizationRepositoryAdapter();
    const organizationFactory = {
      createForOrg: (orgId: string) => ({
        get: (id: string) => organizationAdapter.findProject(orgId, id),
        list: () => organizationAdapter.listProjects(orgId),
      }),
      seedRecord: async (orgId: string, id: string) => {
        const record: ProjectRecord = {
          organizationId: orgId,
          projectId: id,
          displayName: 'Project B',
          status: 'active',
          createdAtIso: NOW,
          retiredAtIso: null,
        };
        await organizationAdapter.createProject(record);
      },
    };
    expect(await runCrossOrgRefusalContract(organizationFactory, types.isProxy)).toEqual({
      ok: true,
    });

    const membershipAdapter = new MembershipRepositoryAdapter();
    const membershipFactory = {
      createForOrg: (orgId: string) => ({
        get: (id: string) => membershipAdapter.findMember(orgId, id),
        list: () => membershipAdapter.listMembers(orgId),
      }),
      seedRecord: async (orgId: string, id: string) => {
        await membershipAdapter.applyChange(
          orgId,
          { kind: 'add', organizationId: orgId, actingActor: id, actor: id, role: 'owner' },
          0,
          NOW,
        );
      },
    };
    expect(await runCrossOrgRefusalContract(membershipFactory, types.isProxy)).toEqual({
      ok: true,
    });

    expect(await runCrossOrgRefusalContract(isolatedFactory(), types.isProxy)).toEqual({ ok: true });
    expect(await runCrossOrgRefusalContract(leakyFactory(), types.isProxy)).toEqual({
      ok: false,
      reason: 'cross-org-leak',
      violations: ['get', 'list', 'delete'],
    });
  });
});
