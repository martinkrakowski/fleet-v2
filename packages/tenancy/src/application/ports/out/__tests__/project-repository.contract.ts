import { describe, expect, it } from 'vitest';

import type { ProjectRecord } from '../../../../domain/entities/Project.js';
import type { OrganizationRepositoryPort } from '../OrganizationRepositoryPort.out-port.js';

/**
 * The shared contract suite for the project half of
 * OrganizationRepositoryPort. Every implementation (the adapter's in-memory
 * and file-backed modes, and any future fake) runs it, so the
 * implementations cannot drift apart. Holds no `.test.ts` suffix: the
 * runners that import it collect it.
 */
export function describeProjectRepositoryContract(
  label: string,
  createPort: () => OrganizationRepositoryPort,
): void {
  describe(`OrganizationRepositoryPort project contract (${label})`, () => {
    it('stores a created project at revision 0 and reads it back isolated', async () => {
      const port = createPort();
      const record = makeProject();
      const outcome = await port.createProject(record);
      expect(outcome).toEqual({ status: 'saved', record, revision: 0 });

      const found = await port.findProject('org-a', 'proj-1');
      expect(found).not.toBeNull();
      expect(found?.record).toEqual(record);
      expect(found?.revision).toBe(0);

      // The returned record is a copy: mutating it must not touch the store.
      const mutable = { ...record } as { -readonly [K in keyof ProjectRecord]: ProjectRecord[K] };
      mutable.displayName = 'tampered';
      expect((await port.findProject('org-a', 'proj-1'))?.record.displayName).toBe('Project 1');
    });

    it('an unknown (organizationId, projectId) reads as null', async () => {
      const port = createPort();
      expect(await port.findProject('org-a', 'proj-1')).toBeNull();
    });

    it('refuses createProject when (organizationId, projectId) already exists while allowing same projectId under another organization', async () => {
      const port = createPort();
      expect((await port.createProject(makeProject())).status).toBe('saved');
      expect(await port.createProject(makeProject())).toEqual({
        status: 'refused',
        reason: 'already-exists',
      });
      // A different organisation owns its own `proj-1`.
      expect((await port.createProject(makeProject({ organizationId: 'org-b' }))).status).toBe(
        'saved',
      );
      expect((await port.findProject('org-a', 'proj-1'))?.record.organizationId).toBe('org-a');
      expect((await port.findProject('org-b', 'proj-1'))?.record.organizationId).toBe('org-b');
    });

    it('refuses saveProject with not-found when project does not exist', async () => {
      const port = createPort();
      expect(await port.saveProject(makeProject(), 0)).toEqual({
        status: 'refused',
        reason: 'not-found',
      });
      // Not-found even when the organisation exists but the project id differs.
      await port.createProject(makeProject());
      expect(await port.saveProject(makeProject({ projectId: 'proj-2' }), 0)).toEqual({
        status: 'refused',
        reason: 'not-found',
      });
    });

    it('saves at expectedRevision + 1 when expectedRevision matches the stored revision', async () => {
      const port = createPort();
      await port.createProject(makeProject());
      const stored = (await port.findProject('org-a', 'proj-1'))!;
      const next = { ...stored.record, displayName: 'Renamed' } as ProjectRecord;
      const outcome = await port.saveProject(next, stored.revision);
      expect(outcome).toEqual({ status: 'saved', record: next, revision: 1 });
      const reread = (await port.findProject('org-a', 'proj-1'))!;
      expect(reread.record.displayName).toBe('Renamed');
      expect(reread.revision).toBe(1);
    });

    it('refuses saveProject with stale-revision when expectedRevision does not match and stores nothing', async () => {
      const port = createPort();
      await port.createProject(makeProject());
      const stored = (await port.findProject('org-a', 'proj-1'))!;
      expect(
        await port.saveProject(
          { ...stored.record, displayName: 'Raced' } as ProjectRecord,
          stored.revision + 5,
        ),
      ).toEqual({ status: 'refused', reason: 'stale-revision' });
      const unchanged = (await port.findProject('org-a', 'proj-1'))!;
      expect(unchanged.record.displayName).toBe('Project 1');
      expect(unchanged.revision).toBe(0);
    });

    it('refuses saveProject with invalid-record when expectedRevision is non-integer, negative, or non-finite', async () => {
      const port = createPort();
      await port.createProject(makeProject());
      const stored = (await port.findProject('org-a', 'proj-1'))!;
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expect(await port.saveProject(stored.record, bad)).toEqual({
          status: 'refused',
          reason: 'invalid-record',
        });
      }
      const unchanged = (await port.findProject('org-a', 'proj-1'))!;
      expect(unchanged.revision).toBe(0);
    });

    it('refuses saveProject with stale-revision when expectedRevision is the largest safe integer but the stored revision does not match', async () => {
      const port = createPort();
      await port.createProject(makeProject());
      const stored = (await port.findProject('org-a', 'proj-1'))!;
      // A mismatched revision is a stale-revision refusal, never
      // invalid-record: the overflow guard only applies when the stored
      // revision actually equals expectedRevision (see the file-mode test
      // seeding the store at the overflow boundary).
      expect(await port.saveProject(stored.record, Number.MAX_SAFE_INTEGER)).toEqual({
        status: 'refused',
        reason: 'stale-revision',
      });
      const unchanged = (await port.findProject('org-a', 'proj-1'))!;
      expect(unchanged.record.displayName).toBe('Project 1');
      expect(unchanged.revision).toBe(0);
    });

    it('lists only the required organizationId projects in insertion order', async () => {
      const port = createPort();
      await port.createProject(makeProject({ projectId: 'proj-2', displayName: 'Second' }));
      await port.createProject(makeProject({ projectId: 'proj-1', displayName: 'First' }));
      await port.createProject(makeProject({ organizationId: 'org-b' }));
      const listed = await port.listProjects('org-a');
      expect(listed.map((item) => item.record.projectId)).toEqual(['proj-2', 'proj-1']);
      expect(listed.map((item) => item.record.organizationId)).toEqual(['org-a', 'org-a']);
      expect((await port.listProjects('org-b')).map((item) => item.record.projectId)).toEqual([
        'proj-1',
      ]);
      expect(await port.listProjects('org-absent')).toEqual([]);
    });

    it('isolates findProject and listProjects by required organizationId and fails closed on invalid organizationId', async () => {
      const port = createPort();
      await port.createProject(makeProject()); // org-a/proj-1
      // Cross-organisation lookup: null, never org-b's data.
      expect(await port.findProject('org-b', 'proj-1')).toBeNull();
      // Invalid organisation ids fail closed (the ids below are built at
      // runtime so no polluting key or path appears as a literal).
      for (const bad of ['', 'org a', 'ORG-A', null, undefined, 7, {}]) {
        expect(await port.findProject(bad as string, 'proj-1')).toBeNull();
        expect(await port.listProjects(bad as string)).toEqual([]);
      }
      expect((await port.findProject('org-a', 'proj-1'))?.record.projectId).toBe('proj-1');
    });

    it('refuses invalid project records and hostile inputs with invalid-record without throwing or invoking getters', async () => {
      const port = createPort();
      // A getter is never invoked: reading it would throw, but the refusal
      // must arrive as a typed result instead.
      let getterReads = 0;
      const getterRecord = {
        get projectId(): string {
          getterReads += 1;
          return 'proj-1';
        },
      };
      expect(await port.createProject(getterRecord as unknown as ProjectRecord)).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      expect(getterReads).toBe(0);
      expect(await port.saveProject(getterRecord as unknown as ProjectRecord, 0)).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      expect(getterReads).toBe(0);
      expect(await port.createProject(new Proxy({}, {}) as unknown as ProjectRecord)).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      for (const bad of [null, undefined, 'proj-1', 7, [], () => {}]) {
        expect(await port.createProject(bad as unknown as ProjectRecord)).toEqual({
          status: 'refused',
          reason: 'invalid-record',
        });
        expect(await port.saveProject(bad as unknown as ProjectRecord, 0)).toEqual({
          status: 'refused',
          reason: 'invalid-record',
        });
      }
      // A prototype-polluting own key is refused (key built at runtime).
      const polluting = makeProject();
      Object.defineProperty(polluting as unknown as Record<string, unknown>, '__' + 'proto__', {
        value: { admin: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(await port.createProject(polluting)).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      // Field-level validation failures are the same typed refusal.
      expect(await port.createProject(makeProject({ displayName: '' }))).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      expect(await port.createProject(makeProject({ status: 'retired', retiredAtIso: null }))).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      // Nothing was stored by any refused call.
      expect(await port.listProjects('org-a')).toEqual([]);
    });

    it('refuses a caller-supplied revision key with invalid-record', async () => {
      const port = createPort();
      const withRevision = makeProject() as unknown as Record<string, unknown>;
      withRevision.revision = 7;
      expect(await port.createProject(withRevision as unknown as ProjectRecord)).toEqual({
        status: 'refused',
        reason: 'invalid-record',
      });
      expect(await port.findProject('org-a', 'proj-1')).toBeNull();
    });
  });
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: 'proj-1',
    organizationId: 'org-a',
    displayName: 'Project 1',
    status: 'active',
    createdAtIso: '2026-11-20T10:00:00.000Z',
    retiredAtIso: null,
    ...overrides,
  };
}
