import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MembershipRecord, Role } from '../../../domain/entities/Membership.js';
import { describeMembershipRepositoryContract } from '../../../application/ports/out/__tests__/membership-repository.contract.js';
import {
  FileLockTimeoutError,
  ReadOnlyStateStoreError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  StateFileUnknownVersionError,
} from '../file-store.js';
import {
  MEMBERSHIP_STORE_VERSION_POLICY,
  MembershipRepositoryAdapter,
  UnsafeMembershipFileNameError,
} from '../MembershipRepositoryAdapter.adapter.js';

const NOW = '2026-11-26T00:00:00.000Z';

function member(
  organizationId: string,
  actor: string,
  role: Role,
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    organizationId,
    actor,
    role,
    addedAtIso: NOW,
    addedBy: 'owner-1',
    ...overrides,
  };
}

describe('MembershipRepositoryAdapter (memory mode)', () => {
  describeMembershipRepositoryContract('in-memory', () => new MembershipRepositoryAdapter());

  it('keeps two adapters over the same process independent in memory mode', async () => {
    const first = new MembershipRepositoryAdapter();
    const second = new MembershipRepositoryAdapter();
    await first.applyChange(
      'org-a',
      { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1', role: 'owner' },
      0,
      NOW,
    );
    expect(await second.listMembers('org-a')).toEqual([]);
  });
});

describe('MembershipRepositoryAdapter (file mode)', () => {
  let stateDir: string;
  const contractDirs: string[] = [];

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-fc3e-membership-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await Promise.all(
      contractDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
  });

  describeMembershipRepositoryContract('file-backed', () => {
    // A fresh directory per port instance so every contract test starts empty.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-fc3e-membership-contract-'));
    contractDirs.push(dir);
    return new MembershipRepositoryAdapter({ stateDir: dir });
  });

  it('persists {schemaVersion: 1, organizationId, revision, members} envelopes and re-reads them from a second adapter', async () => {
    const adapter = new MembershipRepositoryAdapter({ stateDir });
    await adapter.applyChange(
      'org-a',
      { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1', role: 'owner' },
      0,
      NOW,
    );
    const saved = await adapter.applyChange(
      'org-a',
      { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1', role: 'maintainer' },
      1,
      NOW,
    );
    expect(saved.outcome).toBe('saved');

    const bytes = await fs.readFile(path.join(stateDir, 'membership.json'), 'utf8');
    const onDisk: Array<Record<string, unknown>> = JSON.parse(bytes);
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toEqual([
      {
        schemaVersion: 1,
        organizationId: 'org-a',
        revision: 2,
        members: [
          member('org-a', 'owner-1', 'owner'),
          member('org-a', 'member-1', 'maintainer', { addedBy: 'owner-1' }),
        ],
      },
    ]);

    const second = new MembershipRepositoryAdapter({ stateDir });
    const listed = await second.listMembers('org-a');
    expect(listed).toHaveLength(2);
    expect(listed[0]?.actor).toBe('owner-1');
    expect((await second.findMember('org-a', 'member-1'))?.role).toBe('maintainer');
  });

  it('reads an envelope without schemaVersion as schemaVersion 1 forever', async () => {
    const target = path.join(stateDir, 'membership.json');
    await fs.writeFile(
      target,
      JSON.stringify([
        { organizationId: 'org-a', revision: 3, members: [member('org-a', 'owner-1', 'owner')] },
      ]),
    );
    const adapter = new MembershipRepositoryAdapter({ stateDir });
    const listed = await adapter.listMembers('org-a');
    expect(listed).toEqual([member('org-a', 'owner-1', 'owner')]);
    expect(MEMBERSHIP_STORE_VERSION_POLICY.acceptedVersions).toEqual([1]);
  });

  it('throws StateFileUnknownVersionError on unknown schemaVersion without quarantining, touching bytes or echoing stored values', async () => {
    const target = path.join(stateDir, 'membership.json');
    await fs.writeFile(
      target,
      JSON.stringify([
        {
          schemaVersion: 2,
          organizationId: 'org-a',
          revision: 3,
          members: [member('org-a', 'owner-1', 'owner')],
        },
      ]),
    );
    const before = await fs.readFile(target, 'utf8');
    const adapter = new MembershipRepositoryAdapter({ stateDir });
    const refused = await adapter.listMembers('org-a').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateFileUnknownVersionError);
    expect((refused as Error).message).not.toContain('owner-1');
    // The bytes on disk stay untouched and no quarantine copy exists.
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    await expect(fs.readdir(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('holds the last-owner invariant and the per-organisation revision across a fresh adapter over the same directory', async () => {
    const first = new MembershipRepositoryAdapter({ stateDir });
    await first.applyChange(
      'org-a',
      { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1', role: 'owner' },
      0,
      NOW,
    );
    await first.applyChange(
      'org-a',
      { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1', role: 'viewer' },
      1,
      NOW,
    );

    const second = new MembershipRepositoryAdapter({ stateDir });
    const lastOwner = await second.applyChange(
      'org-a',
      { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1' },
      2,
      NOW,
    );
    expect(lastOwner).toEqual({ outcome: 'refused', reason: 'last-owner' });
    expect(await second.listMembers('org-a')).toHaveLength(2);
    // The revision held at 2: a stale call answers stale, a current call lands.
    expect(
      await second.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1' },
        1,
        NOW,
      ),
    ).toMatchObject({ outcome: 'stale-revision', expectedRevision: 1, actualRevision: 2 });
    expect(
      await second.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1' },
        2,
        NOW,
      ),
    ).toMatchObject({ outcome: 'saved', revision: 3 });
  });

  it('quarantines and throws StateFileUnreadableError for corrupt JSON, non-array JSON and mismatched or duplicate organizationId envelopes', async () => {
    const target = path.join(stateDir, 'membership.json');
    const cases: readonly string[] = [
      '{ not json',
      JSON.stringify({ organizationId: 'org-a' }),
      JSON.stringify([
        {
          schemaVersion: 1,
          organizationId: 'org-a',
          revision: 1,
          members: [member('org-b', 'owner-1', 'owner')],
        },
      ]),
      JSON.stringify([
        { organizationId: 'org-a', revision: 1, members: [member('org-a', 'owner-1', 'owner')] },
        {
          schemaVersion: 1,
          organizationId: 'org-a',
          revision: 2,
          members: [member('org-a', 'owner-2', 'owner')],
        },
      ]),
      JSON.stringify([
        { schemaVersion: 1, organizationId: 'org-a', revision: -1, members: [] },
      ]),
    ];
    for (const [index, payload] of cases.entries()) {
      await fs.writeFile(target, payload);
      const adapter = new MembershipRepositoryAdapter({ stateDir });
      const refused = await adapter.listMembers('org-a').catch((error: unknown) => error);
      expect(refused, `case ${index}`).toBeInstanceOf(StateFileUnreadableError);
      // Exactly one quarantine copy holds exactly this case's bytes.
      const quarantineDir = path.join(stateDir, 'quarantine');
      const quarantine = await fs.readdir(quarantineDir);
      expect(quarantine, `case ${index} quarantined its bytes exactly once`).toHaveLength(1);
      expect(await fs.readFile(path.join(quarantineDir, quarantine[0]!), 'utf8')).toBe(payload);
      await fs.rm(quarantineDir, { recursive: true, force: true });
    }
  });

  it('throws StateFileUnreadableReadOnlyError on unreadable state in readOnly mode without locking, quarantining or writing', async () => {
    const target = path.join(stateDir, 'membership.json');
    await fs.writeFile(target, '{ not json');
    const adapter = new MembershipRepositoryAdapter({ stateDir, readOnly: true });
    const refused = await adapter.listMembers('org-a').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StateFileUnreadableReadOnlyError);
    await expect(fs.readdir(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('refuses applyChange on a readOnly store with ReadOnlyStateStoreError before locking or writing', async () => {
    const target = path.join(stateDir, 'membership.json');
    await fs.writeFile(
      target,
      JSON.stringify([
        { schemaVersion: 1, organizationId: 'org-a', revision: 1, members: [member('org-a', 'owner-1', 'owner')] },
      ]),
    );
    const before = await fs.readFile(target, 'utf8');
    const adapter = new MembershipRepositoryAdapter({ stateDir, readOnly: true });
    await expect(
      adapter.applyChange(
        'org-a',
        { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1', role: 'viewer' },
        1,
        NOW,
      ),
    ).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    await expect(fs.readdir(stateDir)).resolves.toEqual(['membership.json']);
  });

  it('throws FileLockTimeoutError when another holder keeps the store lock past the timeout', async () => {
    const adapter = new MembershipRepositoryAdapter({ stateDir, lockTimeoutMs: 60 });
    await fs.writeFile(path.join(stateDir, 'membership.json.lock'), '999-other-holder');
    await expect(
      adapter.applyChange(
        'org-a',
        { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1', role: 'owner' },
        0,
        NOW,
      ),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it('refuses an unsafe or colliding fileName option at construction', () => {
    for (const bad of ['../escape.json', 'a/b.json', '.', '..', 'membership.json ', 'a b.json']) {
      expect(() => new MembershipRepositoryAdapter({ stateDir, fileName: bad })).toThrow(
        UnsafeMembershipFileNameError,
      );
    }
    expect(
      () => new MembershipRepositoryAdapter({ stateDir, fileName: 'organizations.json' }),
    ).toThrow(UnsafeMembershipFileNameError);
    // A safe, non-colliding name is accepted.
    expect(
      () => new MembershipRepositoryAdapter({ stateDir, fileName: 'other-members.json' }),
    ).not.toThrow();
  });
});
