import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeProjectRepositoryContract } from '../../../application/ports/out/__tests__/project-repository.contract.js';
import type { ProjectRecord } from '../../../domain/entities/Project.js';
import {
  parseVersionedProjectStateRecord,
  PROJECT_STORE_VERSION_POLICY,
  OrganizationRepositoryAdapter,
} from '../OrganizationRepositoryAdapter.adapter.js';
import {
  StateFileUnreadableError,
  StateFileUnknownVersionError,
} from '../file-store.js';

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
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

describe('OrganizationRepositoryAdapter projects (memory mode)', () => {
  describeProjectRepositoryContract('in-memory', () => new OrganizationRepositoryAdapter());
});

describe('OrganizationRepositoryAdapter projects (file mode)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fc3d2-projects-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  describeProjectRepositoryContract('file-backed', () =>
    new OrganizationRepositoryAdapter({ stateDir: freshDir() }),
  );

  /** A unique subdirectory per port so contract tests never share a store file. */
  let contractRun = 0;
  function freshDir(): string {
    contractRun += 1;
    return path.join(stateDir, `contract-${contractRun}`);
  }

  it('persists to projects.json as { schemaVersion: 1, revision, ...project } and re-reads from a second adapter', async () => {
    expect(PROJECT_STORE_VERSION_POLICY).toEqual({ writerVersion: 1, acceptedVersions: [1] });
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    expect((await adapter.createProject(project())).status).toBe('saved');
    const bytes = await fs.readFile(path.join(stateDir, 'projects.json'), 'utf8');
    const onDisk: unknown[] = JSON.parse(bytes);
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toHaveLength(1);
    const envelope = onDisk[0] as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.revision).toBe(0);
    expect(envelope.organizationId).toBe('org-a');
    expect(envelope.projectId).toBe('proj-1');

    const second = new OrganizationRepositoryAdapter({ stateDir });
    expect(await second.findProject('org-a', 'proj-1')).toEqual({
      record: project(),
      revision: 0,
    });
    expect(await second.listProjects('org-a')).toEqual([{ record: project(), revision: 0 }]);
  });

  it('reads a record written without schemaVersion or revision as schemaVersion 1 and revision 0, then saves to revision 1', async () => {
    const raw = project() as unknown as Record<string, unknown>;
    await fs.writeFile(path.join(stateDir, 'projects.json'), JSON.stringify([raw]));
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    expect(await adapter.findProject('org-a', 'proj-1')).toEqual({ record: project(), revision: 0 });
    expect(await adapter.saveProject(project({ displayName: 'Renamed' }), 0)).toEqual({
      status: 'saved',
      record: project({ displayName: 'Renamed' }),
      revision: 1,
    });
    const onDisk: Record<string, unknown>[] = JSON.parse(
      await fs.readFile(path.join(stateDir, 'projects.json'), 'utf8'),
    );
    expect(onDisk[0]).toMatchObject({ revision: 1, schemaVersion: 1, displayName: 'Renamed' });
  });

  it('refuses saveProject with invalid-record when the stored revision is the largest safe integer and leaves the store file byte-identical', async () => {
    // Seed the store at the overflow boundary: the next increment would leave
    // the safe-integer range, so the save must be refused before the file is
    // rewritten (previously it persisted the unsafe revision 2 ** 53).
    const envelope = { ...project(), schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER };
    const storePath = path.join(stateDir, 'projects.json');
    await fs.writeFile(storePath, JSON.stringify([envelope]));
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    expect(
      await adapter.saveProject(project({ displayName: 'Overflowed' }), Number.MAX_SAFE_INTEGER),
    ).toEqual({ status: 'refused', reason: 'invalid-record' });
    // No save happened: bytes on disk are unchanged and the stored record and
    // revision are untouched.
    expect(await fs.readFile(storePath, 'utf8')).toBe(JSON.stringify([envelope]));
    expect(await adapter.findProject('org-a', 'proj-1')).toEqual({
      record: project(),
      revision: Number.MAX_SAFE_INTEGER,
    });
  });

  it('throws StateFileUnknownVersionError on unknown schemaVersion in projects.json without quarantining or echoing stored values', async () => {
    await fs.writeFile(
      path.join(stateDir, 'projects.json'),
      JSON.stringify([{ ...project(), note: 'not for you', schemaVersion: 2 }]),
    );
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    const refused = await adapter.findProject('org-a', 'proj-1').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateFileUnknownVersionError);
    expect((refused as Error).message).not.toContain('not for you');
    // Bytes on disk are untouched and no quarantine copy exists.
    expect(
      JSON.parse(await fs.readFile(path.join(stateDir, 'projects.json'), 'utf8'))[0].schemaVersion,
    ).toBe(2);
    await expect(fs.readdir(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('throws StateFileUnreadableError and quarantines bytes on invalid JSON, non-array, malformed record, or duplicate project key', async () => {
    const target = path.join(stateDir, 'projects.json');
    const adapter = new OrganizationRepositoryAdapter({ stateDir });

    await fs.writeFile(target, '{ not json');
    await expect(adapter.findProject('org-a', 'proj-1')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    expect((await fs.readdir(path.join(stateDir, 'quarantine'))).length).toBe(1);
    await fs.rm(path.join(stateDir, 'quarantine'), { recursive: true, force: true });

    await fs.writeFile(target, JSON.stringify({ projectId: 'proj-1' }));
    await expect(adapter.listProjects('org-a')).rejects.toBeInstanceOf(StateFileUnreadableError);
    await fs.rm(path.join(stateDir, 'quarantine'), { recursive: true, force: true });

    // A malformed record: missing every required field.
    await fs.writeFile(
      target,
      JSON.stringify([{ schemaVersion: 1, revision: 0, projectId: 'proj-1' }]),
    );
    await expect(adapter.findProject('org-a', 'proj-1')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    await fs.rm(path.join(stateDir, 'quarantine'), { recursive: true, force: true });

    // A duplicate (organizationId, projectId) key must not let the last win.
    await fs.writeFile(
      target,
      JSON.stringify([
        { schemaVersion: 1, revision: 0, ...project() },
        { schemaVersion: 1, revision: 3, ...project({ displayName: 'Duplicate' }) },
      ]),
    );
    await expect(adapter.listProjects('org-a')).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantine = await fs.readdir(path.join(stateDir, 'quarantine'));
    expect(quarantine.length).toBeGreaterThan(0);
  });

  it('refuses symlinked and oversized projects.json files with StateFileUnreadableError and no quarantine copy', async () => {
    const outside = path.join(stateDir, 'outside.json');
    await fs.writeFile(outside, JSON.stringify([]));
    const target = path.join(stateDir, 'projects.json');
    await fs.symlink(outside, target);
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    const linked = await adapter.listProjects('org-a').catch((error: unknown) => error);
    expect(linked).toBeInstanceOf(StateFileUnreadableError);
    expect((linked as StateFileUnreadableError).quarantinePath).toBeNull();
    expect((linked as StateFileUnreadableError).message).toMatch(/regular file/);
    await fs.unlink(target);

    await fs.writeFile(target, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    const oversized = await adapter.findProject('org-a', 'proj-1').catch((error: unknown) => error);
    expect(oversized).toBeInstanceOf(StateFileUnreadableError);
    expect((oversized as StateFileUnreadableError).quarantinePath).toBeNull();
    expect((oversized as StateFileUnreadableError).message).toMatch(/bytes/);
    await expect(fs.stat(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('createProject never checks organizations.json and keeps same projectId under two organizations', async () => {
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    expect((await adapter.createProject(project())).status).toBe('saved');
    expect((await adapter.createProject(project({ organizationId: 'org-b' }))).status).toBe('saved');
    // organizations.json was never consulted or created.
    await expect(fs.stat(path.join(stateDir, 'organizations.json'))).rejects.toThrow();
    expect(await adapter.listProjects('org-b')).toEqual([
      { record: project({ organizationId: 'org-b' }), revision: 0 },
    ]);
  });

  it('parseVersionedProjectStateRecord returns invalid, never throws, on a throwing getter', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter');
        },
      },
    );
    expect(parseVersionedProjectStateRecord(hostile)).toEqual({ status: 'invalid' });
    let reads = 0;
    const getterRecord = {
      get projectId(): string {
        reads += 1;
        return 'proj-1';
      },
    };
    expect(parseVersionedProjectStateRecord(getterRecord)).toEqual({ status: 'invalid' });
    expect(reads).toBe(0);
  });
});
