/**
 * Unit tests for lane K11a2: the file-backed `ReaperFindingRepositoryAdapter`
 * and the in-process `InMemoryReaperFindingRepositoryAdapter`. The fakes cover
 * the store's own guarantees: one finding per open (subject, kind), the
 * revision arithmetic of the CAS close, closed findings leaving the open
 * list, an unreadable or unknown-version file reported and never treated as
 * empty, a lock timeout leaving the file unchanged while the next pass
 * completes the upsert, and the memory adapter keeping the same semantics.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REAPER_FINDING_SCHEMA_VERSION, type ReaperFinding } from '../../../domain/reaper-findings.js';
import type { ReaperFindingRepositoryPort } from '../../../application/ports/out/ReaperFindingRepositoryPort.out-port.js';
import {
  ReaperFindingRepositoryAdapter,
  ReaperFindingStoreUnreadableError,
} from '../ReaperFindingRepositoryAdapter.adapter.js';
import { InMemoryReaperFindingRepositoryAdapter } from '../InMemoryReaperFindingRepositoryAdapter.adapter.js';
import { withFileLock } from '../file-store.js';

const NOW = '2026-11-06T00:00:00.000Z';

function finding(overrides: Partial<ReaperFinding> = {}): ReaperFinding {
  return {
    schemaVersion: REAPER_FINDING_SCHEMA_VERSION,
    kind: 'dead-attempt',
    subject: 'attempt-01',
    action: 'report',
    firstSightingIso: NOW,
    lastSightingIso: NOW,
    sightings: 1,
    ...overrides,
  };
}

const FINDING_ID = '01J00000000000000000000000';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeFileAdapter(lockTimeoutMs?: number): Promise<ReaperFindingRepositoryAdapter> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reaper-findings-'));
  dirs.push(stateDir);
  return new ReaperFindingRepositoryAdapter(lockTimeoutMs === undefined ? { stateDir } : { stateDir, lockTimeoutMs });
}

function makeMemoryAdapter(): InMemoryReaperFindingRepositoryAdapter {
  return new InMemoryReaperFindingRepositoryAdapter();
}

const adapters = (): [string, () => ReaperFindingRepositoryPort | Promise<ReaperFindingRepositoryPort>][] => [
  ['file', () => makeFileAdapter() as unknown as ReaperFindingRepositoryPort],
  ['memory', () => makeMemoryAdapter()],
];

describe.each(adapters())('reaper finding store (%s)', (name, make) => {
  it('an upsert creates one finding for a subject and kind', async () => {
    const store = await make();
    const result = await store.upsertFinding(finding(), FINDING_ID);
    expect(result).toMatchObject({ outcome: 'stored' });
    if (result.outcome !== 'stored') return;
    expect(result.record.findingId).toBe(FINDING_ID);
    expect(result.record.revision).toBe(1);
    expect(result.record.state).toBe('open');
    const open = await store.listOpenFindings();
    expect(open).toHaveLength(1);
    expect(open[0]?.finding.subject).toBe('attempt-01');
  });

  it('a second upsert keeps the finding id and moves the revision', async () => {
    const store = await make();
    await store.upsertFinding(finding({ sightings: 1 }), FINDING_ID);
    const second = await store.upsertFinding(
      finding({ sightings: 2, lastSightingIso: '2026-11-06T00:10:00.000Z' }),
      '01J00000000000000000000001',
    );
    expect(second).toMatchObject({ outcome: 'stored' });
    if (second.outcome !== 'stored') return;
    expect(second.record.findingId).toBe(FINDING_ID);
    expect(second.record.revision).toBe(2);
    expect(second.record.finding.sightings).toBe(2);
    // A different subject is a different finding.
    await store.upsertFinding(finding({ subject: 'attempt-02' }), '01J00000000000000000000002');
    const open = await store.listOpenFindings();
    expect(open).toHaveLength(2);
  });

  it('a stale close is refused and writes nothing', async () => {
    const store = await make();
    await store.upsertFinding(finding(), FINDING_ID);
    const conflict = await store.closeFinding(FINDING_ID, 99);
    expect(conflict.outcome).toBe('conflict');
    if (conflict.outcome === 'conflict') {
      expect(conflict.record.revision).toBe(1);
    }
    const open = await store.listOpenFindings();
    expect(open).toHaveLength(1);
    expect(open[0]?.revision).toBe(1);
  });

  it('a closed finding is not listed as open', async () => {
    const store = await make();
    await store.upsertFinding(finding(), FINDING_ID);
    const closed = await store.closeFinding(FINDING_ID, 1);
    expect(closed.outcome).toBe('stored');
    const open = await store.listOpenFindings();
    expect(open).toHaveLength(0);
    const unknown = await store.closeFinding(FINDING_ID, 1);
    // The closed record keeps its moved revision: a stale second close conflicts.
    expect(unknown.outcome).toBe('conflict');
  });

  it('a bad input is refused and writes nothing', async () => {
    const store = await make();
    const badId = await store.upsertFinding(finding(), 'not-a-ulid');
    expect(badId).toMatchObject({ outcome: 'refused' });
    const badKind = await store.upsertFinding(
      finding({ kind: 'not-a-kind' as ReaperFinding['kind'] }),
      FINDING_ID,
    );
    expect(badKind).toMatchObject({ outcome: 'refused' });
    expect(await store.listOpenFindings()).toHaveLength(0);
  });

  it('an unsupported schema version, an invalid action or a bad sighting time is refused', async () => {
    const store = await make();
    const badVersion = await store.upsertFinding(finding({ schemaVersion: 2 }), FINDING_ID);
    expect(badVersion).toMatchObject({ outcome: 'refused', reason: 'invalid-schema-version' });
    const badAction = await store.upsertFinding(
      finding({ action: 'nuke' as ReaperFinding['action'] }),
      FINDING_ID,
    );
    expect(badAction).toMatchObject({ outcome: 'refused', reason: 'unknown-action' });
    const badTime = await store.upsertFinding(finding({ lastSightingIso: 'not-a-time' }), FINDING_ID);
    expect(badTime).toMatchObject({ outcome: 'refused', reason: 'invalid-sighting-time' });
    expect(await store.listOpenFindings()).toHaveLength(0);
  });
});

describe('reaper finding store: file-specific behaviour', () => {
  it('an unreadable file is reported and never treated as empty', async () => {
    const store = await makeFileAdapter();
    await store.upsertFinding(finding(), FINDING_ID);
    await fs.writeFile(path.join((store as unknown as { stateDir: string }).stateDir, 'reaper-findings.json'), '{not json', 'utf8');
    await expect(store.listOpenFindings()).rejects.toThrow(ReaperFindingStoreUnreadableError);
    await expect(store.listOpenFindings()).rejects.toMatchObject({ reason: 'unreadable' });
  });

  it('an unknown schema version is reported', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reaper-findings-'));
    dirs.push(stateDir);
    const store = new ReaperFindingRepositoryAdapter({ stateDir });
    const record = {
      schemaVersion: 2,
      findingId: FINDING_ID,
      revision: 1,
      state: 'open',
      finding: finding(),
    };
    await fs.writeFile(path.join(stateDir, 'reaper-findings.json'), JSON.stringify([record]), 'utf8');
    await expect(store.listOpenFindings()).rejects.toThrow(ReaperFindingStoreUnreadableError);
    await expect(store.listOpenFindings()).rejects.toMatchObject({ reason: 'unknown-version' });
  });

  it('a lock timeout leaves the file unchanged and the next pass completes the upsert', async () => {
    const store = await makeFileAdapter(50);
    const stateDir = (store as unknown as { stateDir: string }).stateDir;
    const lockPath = path.join(stateDir, 'reaper-findings.json.lock');
    // Hold the lock the way a real holder does, then let the upsert time out.
    let releaseHolder: (() => void) | null = null;
    const holder = withFileLock(lockPath, () => new Promise<void>((resolve) => {
      releaseHolder = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(store.upsertFinding(finding(), FINDING_ID)).rejects.toMatchObject({
      name: 'FileLockTimeoutError',
    });
    const release = releaseHolder as (() => void) | null;
    if (release === null) {
      throw new Error('holder never started');
    }
    release();
    await holder;
    // The file was never written; the next pass completes the upsert.
    expect(await store.listOpenFindings()).toHaveLength(0);
    const retry = await store.upsertFinding(finding(), FINDING_ID);
    expect(retry).toMatchObject({ outcome: 'stored' });
  });
});

describe('reaper finding store: memory adapter parity', () => {
  it('the memory adapter keeps the same semantics', async () => {
    const memory = makeMemoryAdapter();
    const file = await makeFileAdapter();
    const findings = [finding({ sightings: 1 }), finding({ sightings: 2, subject: 'attempt-02' })];
    for (const store of [memory, file]) {
      await store.upsertFinding(findings[0] as ReaperFinding, FINDING_ID);
      await store.upsertFinding(findings[1] as ReaperFinding, '01J00000000000000000000002');
      const stale = await store.closeFinding(FINDING_ID, 42);
      expect(stale.outcome).toBe('conflict');
      const closed = await store.closeFinding('01J00000000000000000000002', 1);
      expect(closed.outcome).toBe('stored');
      const open = await store.listOpenFindings();
      expect(open.map((record) => record.finding.subject)).toEqual(['attempt-01']);
      const again = await store.upsertFinding(
        finding({ subject: 'attempt-02', sightings: 5 }),
        '01J00000000000000000000003',
      );
      expect(again).toMatchObject({ outcome: 'stored', record: { findingId: '01J00000000000000000000003' } });
    }
  });
});
