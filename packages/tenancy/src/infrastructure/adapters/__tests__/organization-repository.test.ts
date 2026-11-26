import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  StateFileUnknownVersionError,
} from '../file-store.js';
import { OrganizationRepositoryAdapter } from '../OrganizationRepositoryAdapter.adapter.js';
import type { OrganizationRecord } from '../../../domain/entities/Organization.js';
import {
  describeOrganizationRepositoryContract,
  makeOrg,
} from '../../../application/ports/out/__tests__/organization-repository.contract.js';

describe('OrganizationRepositoryAdapter (memory mode)', () => {
  describeOrganizationRepositoryContract('in-memory', () => new OrganizationRepositoryAdapter());

  it('keeps two adapters over the same process independent in memory mode', async () => {
    const first = new OrganizationRepositoryAdapter();
    const second = new OrganizationRepositoryAdapter();
    await first.createOrganization(makeOrg());
    expect(await second.findOrganization('org-1')).toBeNull();
  });
});

describe('OrganizationRepositoryAdapter (file mode)', () => {
  let stateDir: string;
  const contractDirs: string[] = [];

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fc3d-organizations-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await Promise.all(
      contractDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
  });

  describeOrganizationRepositoryContract('file-backed', () => {
    // A fresh directory per port instance so every contract test starts empty.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-fc3d-organizations-contract-'));
    contractDirs.push(dir);
    return new OrganizationRepositoryAdapter({ stateDir: dir });
  });

  it('persists flat envelopes {...record, revision, schemaVersion: 1} and re-reads them from a second adapter', async () => {
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    await adapter.createOrganization(makeOrg());
    const saved = await adapter.saveOrganization(makeOrg({ displayName: 'Renamed' }), 0);
    expect(saved.status).toBe('saved');

    const bytes = await fs.readFile(path.join(stateDir, 'organizations.json'), 'utf8');
    const onDisk: unknown[] = JSON.parse(bytes);
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toEqual([
      {
        organizationId: 'org-1',
        displayName: 'Renamed',
        status: 'active',
        createdAtIso: '2026-11-01T00:00:00.000Z',
        retiredAtIso: null,
        revision: 1,
        schemaVersion: 1,
      },
    ]);

    const second = new OrganizationRepositoryAdapter({ stateDir });
    const found = await second.findOrganization('org-1');
    expect(found?.record).toEqual(makeOrg({ displayName: 'Renamed' }));
    expect(found?.revision).toBe(1);
  });

  it('reads an envelope without schemaVersion or revision as schemaVersion 1 and revision 0', async () => {
    const target = path.join(stateDir, 'organizations.json');
    await fs.writeFile(target, JSON.stringify([{ ...makeOrg() }]));
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    const found = await adapter.findOrganization('org-1');
    expect(found?.record).toEqual(makeOrg());
    expect(found?.revision).toBe(0);
  });

  it('persists a created record with revision 0 and increments to 1 on the next save on disk', async () => {
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    await adapter.createOrganization(makeOrg());
    const bytes = await fs.readFile(path.join(stateDir, 'organizations.json'), 'utf8');
    const onDisk: Array<Record<string, unknown>> = JSON.parse(bytes);
    expect(onDisk[0]?.['revision']).toBe(0);
    expect(onDisk[0]?.['schemaVersion']).toBe(1);
    await adapter.saveOrganization(makeOrg({ displayName: 'Second' }), 0);
    const after: Array<Record<string, unknown>> = JSON.parse(
      await fs.readFile(path.join(stateDir, 'organizations.json'), 'utf8'),
    );
    expect(after[0]?.['revision']).toBe(1);
    expect(after[0]?.['displayName']).toBe('Second');
  });

  it('throws StateFileUnknownVersionError on unknown schemaVersion without quarantining or echoing stored values', async () => {
    const target = path.join(stateDir, 'organizations.json');
    await fs.writeFile(
      target,
      JSON.stringify([{ ...makeOrg(), revision: 3, schemaVersion: 2 }]),
    );
    const before = await fs.readFile(target, 'utf8');
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    const refused = await adapter.findOrganization('org-1').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateFileUnknownVersionError);
    expect((refused as Error).message).not.toContain('Org One');
    // The bytes on disk stay untouched and no quarantine copy exists.
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    await expect(fs.readdir(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('throws StateFileUnreadableError and quarantines bytes on invalid JSON, non-array JSON, malformed record, invalid revision, or duplicate id', async () => {
    const target = path.join(stateDir, 'organizations.json');
    const cases: readonly string[] = [
      '{ not json',
      JSON.stringify({ organizationId: 'org-1' }),
      JSON.stringify([{ ...makeOrg(), displayName: 7 }]),
      JSON.stringify([{ ...makeOrg(), revision: -1 }]),
      JSON.stringify([{ ...makeOrg(), revision: 1.5 }]),
      JSON.stringify([{ ...makeOrg(), revision: 0 }, { ...makeOrg(), displayName: 'Dup', revision: 2 }]),
    ];
    for (const [index, payload] of cases.entries()) {
      await fs.writeFile(target, payload);
      const adapter = new OrganizationRepositoryAdapter({ stateDir });
      const refused = await adapter.findOrganization('org-1').catch((error: unknown) => error);
      expect(refused, `case ${index}`).toBeInstanceOf(StateFileUnreadableError);
      // The quarantine directory is emptied after every case (it prunes old
      // copies, so a running count is unreliable): exactly one copy, holding
      // exactly this case's bytes, proves THIS case quarantined them.
      const quarantineDir = path.join(stateDir, 'quarantine');
      const quarantine = await fs.readdir(quarantineDir);
      expect(quarantine, `case ${index} quarantined its bytes exactly once`).toHaveLength(1);
      expect(await fs.readFile(path.join(quarantineDir, quarantine[0]!), 'utf8')).toBe(payload);
      await fs.rm(quarantineDir, { recursive: true, force: true });
    }
  });

  it('refuses symlinked and oversized store files with StateFileUnreadableError and no quarantine copy', async () => {
    const outside = path.join(stateDir, 'outside.json');
    await fs.writeFile(outside, JSON.stringify([makeOrg()]));
    const target = path.join(stateDir, 'organizations.json');
    await fs.symlink(outside, target);
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    const symlinked = await adapter.listOrganizations().catch((error: unknown) => error);
    expect(symlinked).toBeInstanceOf(StateFileUnreadableError);
    expect((symlinked as StateFileUnreadableError).quarantinePath).toBeNull();
    expect((symlinked as StateFileUnreadableError).message).toMatch(/regular file/);
    await fs.unlink(target);
    await fs.writeFile(target, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    const oversized = await adapter.findOrganization('org-1').catch((error: unknown) => error);
    expect(oversized).toBeInstanceOf(StateFileUnreadableError);
    expect((oversized as StateFileUnreadableError).quarantinePath).toBeNull();
    await expect(fs.stat(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('never writes a refused record to disk and leaves the store absent', async () => {
    const adapter = new OrganizationRepositoryAdapter({ stateDir });
    await adapter.createOrganization(makeOrg());
    await expect(adapter.createOrganization(makeOrg())).resolves.toEqual({
      status: 'refused',
      reason: 'already-exists',
    });
    await expect(
      adapter.saveOrganization(makeOrg({ displayName: 'Never' }), 99),
    ).resolves.toEqual({ status: 'refused', reason: 'stale-revision' });
    await expect(
      adapter.saveOrganization(
        makeOrg({ displayName: 'x'.repeat(5000) }) as unknown as OrganizationRecord,
        1,
      ),
    ).resolves.toEqual({ status: 'refused', reason: 'invalid-record' });
    const onDisk: unknown[] = JSON.parse(
      await fs.readFile(path.join(stateDir, 'organizations.json'), 'utf8'),
    );
    expect(onDisk).toHaveLength(1);
    expect((onDisk[0] as Record<string, unknown>)['displayName']).toBe('Org One');
  });

  it('serializes concurrent saves over one stateDir: of many saves at the same expected revision exactly one is saved and the rest are stale', async () => {
    const seed = new OrganizationRepositoryAdapter({ stateDir });
    await seed.createOrganization(makeOrg());
    const adapters = Array.from({ length: 6 }, () => new OrganizationRepositoryAdapter({ stateDir }));
    const outcomes = await Promise.all(
      adapters.map((adapter, index) =>
        adapter.saveOrganization(makeOrg({ displayName: `Racer ${index}` }), 0),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'saved')).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'refused' && outcome.reason === 'stale-revision'),
    ).toHaveLength(5);
    const stored = await seed.findOrganization('org-1');
    expect(stored?.revision).toBe(1);
  });
});

describe('OrganizationRepositoryAdapter reads hostile create/save inputs once', () => {
  it('refuses a record carrying a caller-supplied revision key instead of silently dropping it', async () => {
    const adapter = new OrganizationRepositoryAdapter();
    const withRevision = { ...makeOrg(), revision: 7 } as unknown as OrganizationRecord;
    await expect(adapter.createOrganization(withRevision)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-record',
    });
    expect(await adapter.findOrganization('org-1')).toBeNull();
    await adapter.createOrganization(makeOrg());
    await expect(adapter.saveOrganization(withRevision, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-record',
    });
    expect((await adapter.findOrganization('org-1'))?.revision).toBe(0);
  });

  it('never runs a Proxy get trap and refuses a Proxy-wrapped record on create and save', async () => {
    let getRan = 0;
    const hostile = new Proxy(makeOrg(), {
      get() {
        getRan += 1;
        throw new Error('get trap ran');
      },
    }) as unknown as OrganizationRecord;
    const adapter = new OrganizationRepositoryAdapter();
    await expect(adapter.createOrganization(hostile)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-record',
    });
    await adapter.createOrganization(makeOrg());
    await expect(adapter.saveOrganization(hostile, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'invalid-record',
    });
    expect(getRan).toBe(0);
  });
});
