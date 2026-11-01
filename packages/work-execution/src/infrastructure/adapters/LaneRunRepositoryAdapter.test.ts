import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { StateFileUnreadableError } from './file-store.js';
import { LaneRunRepositoryAdapter } from './LaneRunRepositoryAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';

/** K1-1's VALID run record; overrides are spread last so tests can tweak one field. */
function validRun(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: 1,
    runId: 'run-01JB0000000000000000000000',
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
    schemaVersion: 1,
    ...overrides,
  };
}

const LEASE = { holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN };
const ACQUIRE = { holderId: 'driver-example-1', observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW };
const HOLD = { holderId: 'driver-example-1', fence: 1, nowIso: NOW };

describe.each(['memory', 'file'] as const)('LaneRunRepositoryAdapter (%s)', (mode) => {
  const isFile = mode === 'file';
  let tempDir: string;
  let adapter: LaneRunRepositoryAdapter;

  beforeEach(async () => {
    if (isFile) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-run-repo-test-'));
      adapter = new LaneRunRepositoryAdapter({ stateDir: tempDir });
    } else {
      adapter = new LaneRunRepositoryAdapter();
    }
  });

  afterEach(async () => {
    if (isFile) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('create stores VALID and refuses duplicates, bad revisions, leases and unknown keys', async () => {
    expect(await adapter.create(validRun())).toEqual({ outcome: 'saved', record: validRun() });
    expect(await adapter.create(validRun())).toEqual({ outcome: 'refused', reason: 'run-exists' });
    expect(await adapter.create(validRun({ revision: 2 }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-record',
    });
    expect(await adapter.create(validRun({ lease: LEASE }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-record',
    });
    expect(await adapter.create({ ...validRun(), state: 'ready' } as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-record',
    });
    expect(await adapter.get(validRun().runId)).toEqual(validRun());
    expect(await adapter.create(validRun({ runId: 'run-01JB0000000000000000000002', branchName: 'fleet/run-01JB0000000000000000000002' }))).toEqual({
      outcome: 'saved',
      record: validRun({ runId: 'run-01JB0000000000000000000002', branchName: 'fleet/run-01JB0000000000000000000002' }),
    });
    // A distinct run written without the field keeps its absence on read (KF-5a).
    expect(await adapter.create(validRun({ runId: 'run-01JB0000000000000000000001' }))).toEqual({
      outcome: 'saved',
      record: validRun({ runId: 'run-01JB0000000000000000000001' }),
    });
    // The round-tripped VALUE is asserted in both modes, not just key presence (fix round 1).
    expect((await adapter.get('run-01JB0000000000000000000001'))?.branchName).toBeUndefined();
    expect((await adapter.get('run-01JB0000000000000000000002'))?.branchName).toBe('fleet/run-01JB0000000000000000000002');
  });

  it('lease then save: acquire raises the fence without moving the revision and save lands', async () => {
    await adapter.create(validRun());

    const acquired = await adapter.acquireLease(validRun().runId, ACQUIRE);
    expect(acquired).toEqual({
      outcome: 'saved',
      record: validRun({ lease: LEASE }),
    });
    expect((await adapter.get(validRun().runId))?.revision).toBe(1);

    const saved = await adapter.save(
      validRun({ round: 1, attemptIds: ['attempt-example-1', 'attempt-example-2'], revision: 2, lease: LEASE }),
      HOLD,
    );
    expect(saved).toEqual({
      outcome: 'saved',
      record: validRun({ round: 1, attemptIds: ['attempt-example-1', 'attempt-example-2'], revision: 2, lease: LEASE }),
    });
    const stored = await adapter.get(validRun().runId);
    expect(stored?.round).toBe(1);
    expect(stored?.attemptIds).toEqual(['attempt-example-1', 'attempt-example-2']);
    expect(stored?.revision).toBe(2);
  });

  it('save refusals write nothing, one per reason', async () => {
    await adapter.create(validRun());
    const runId = validRun().runId;

    // no lease taken → lease-not-held
    expect(await adapter.save(validRun({ revision: 2 }), HOLD)).toEqual({
      outcome: 'refused',
      reason: 'lease-not-held',
    });

    await adapter.acquireLease(runId, ACQUIRE);

    // revision 3 skipping 2 → stale-revision
    expect(await adapter.save(validRun({ revision: 3, lease: LEASE }), HOLD)).toEqual({
      outcome: 'refused',
      reason: 'stale-revision',
    });
    // revision 1 → stale-revision
    expect(await adapter.save(validRun({ revision: 1, lease: LEASE }), HOLD)).toEqual({
      outcome: 'refused',
      reason: 'stale-revision',
    });
    // another holder → lease-not-held
    expect(
      await adapter.save(
        validRun({ revision: 2, lease: LEASE }),
        { holderId: 'driver-other', fence: 1, nowIso: NOW },
      ),
    ).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
    // the right holder after leaseUntilIso → lease-expired
    expect(
      await adapter.save(
        validRun({ revision: 2, lease: LEASE }),
        { holderId: 'driver-example-1', fence: 1, nowIso: '2026-10-27T10:03:00.000Z' },
      ),
    ).toEqual({ outcome: 'refused', reason: 'lease-expired' });
    // a record carrying another lease → lease-changed
    expect(
      await adapter.save(
        validRun({ revision: 2, lease: { holderId: 'driver-example-1', fence: 2, leaseUntilIso: IN_2_MIN } }),
        HOLD,
      ),
    ).toEqual({ outcome: 'refused', reason: 'lease-changed' });
    // a changed workOrderId and dropped first attempt id → identity-changed
    expect(
      await adapter.save(
        validRun({ workOrderId: 'wo-example-2', attemptIds: ['attempt-example-2'], revision: 2, lease: LEASE }),
        HOLD,
      ),
    ).toEqual({ outcome: 'refused', reason: 'identity-changed' });
    // an unknown run → run-not-found
    expect(
      await adapter.save(
        validRun({ runId: 'run-01JB0000000000000000000001', revision: 2, lease: LEASE }),
        HOLD,
      ),
    ).toEqual({ outcome: 'refused', reason: 'run-not-found' });

    // after every refusal the stored run is unchanged
    expect(await adapter.get(runId)).toEqual(validRun({ lease: LEASE }));
  });

  it('save refuses a changed, added or dropped branch name and accepts the same one (KF-5a fix round 1)', async () => {
    await adapter.create(validRun({ branchName: 'fleet/run-01JB0000000000000000000000' }));
    const runId = validRun().runId;
    await adapter.acquireLease(runId, ACQUIRE);
    const base = { revision: 2, lease: LEASE };

    // a changed branch name → identity-changed
    expect(await adapter.save(validRun({ branchName: 'fleet/other', ...base }), HOLD)).toEqual({
      outcome: 'refused',
      reason: 'identity-changed',
    });
    // a dropped branch name → identity-changed
    expect(await adapter.save(validRun(base), HOLD)).toEqual({
      outcome: 'refused',
      reason: 'identity-changed',
    });

    // an added branch name where the stored record has none → identity-changed
    await adapter.create(validRun({ runId: 'run-01JB0000000000000000000003' }));
    await adapter.acquireLease('run-01JB0000000000000000000003', ACQUIRE);
    expect(
      await adapter.save(
        validRun({ runId: 'run-01JB0000000000000000000003', branchName: 'fleet/run-01JB0000000000000000000003', ...base }),
        HOLD,
      ),
    ).toEqual({ outcome: 'refused', reason: 'identity-changed' });

    // the same branch name saves
    expect(
      await adapter.save(
        validRun({
          branchName: 'fleet/run-01JB0000000000000000000000',
          round: 1,
          attemptIds: ['attempt-example-1', 'attempt-example-2'],
          ...base,
        }),
        HOLD,
      ),
    ).toEqual({
      outcome: 'saved',
      record: validRun({
        branchName: 'fleet/run-01JB0000000000000000000000',
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
        lease: LEASE,
      }),
    });
  });

  it('save refuses a changed, added or dropped baseBranch and accepts the same one (CB1)', async () => {
    await adapter.create(validRun({ branchName: 'fleet/run-01JB0000000000000000000000', baseBranch: 'chain/example' }));
    const runId = validRun().runId;
    await adapter.acquireLease(runId, ACQUIRE);
    const base = { revision: 2, lease: LEASE };

    // a changed baseBranch → identity-changed
    expect(
      await adapter.save(validRun({ branchName: 'fleet/run-01JB0000000000000000000000', baseBranch: 'main', ...base }), HOLD),
    ).toEqual({ outcome: 'refused', reason: 'identity-changed' });
    // a dropped baseBranch → identity-changed
    expect(
      await adapter.save(validRun({ branchName: 'fleet/run-01JB0000000000000000000000', ...base }), HOLD),
    ).toEqual({ outcome: 'refused', reason: 'identity-changed' });

    // an added baseBranch on a stored run that had none → identity-changed
    await adapter.create(validRun({ runId: 'run-01JB0000000000000000000003' }));
    await adapter.acquireLease('run-01JB0000000000000000000003', ACQUIRE);
    expect(
      await adapter.save(validRun({ runId: 'run-01JB0000000000000000000003', baseBranch: 'main', ...base }), HOLD),
    ).toEqual({ outcome: 'refused', reason: 'identity-changed' });

    // the same baseBranch saves
    expect(
      await adapter.save(
        validRun({
          branchName: 'fleet/run-01JB0000000000000000000000',
          baseBranch: 'chain/example',
          round: 1,
          attemptIds: ['attempt-example-1', 'attempt-example-2'],
          ...base,
        }),
        HOLD,
      ),
    ).toEqual({
      outcome: 'saved',
      record: validRun({
        branchName: 'fleet/run-01JB0000000000000000000000',
        baseBranch: 'chain/example',
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
        lease: LEASE,
      }),
    });
  });

  it('fencing: a lapsed lease moves on; stale saves and renewals never land', async () => {
    await adapter.create(validRun());
    const runId = validRun().runId;
    const LAPSE_NOW = '2026-10-27T10:03:00.000Z';
    const LAPSE_UNTIL = '2026-10-27T10:04:00.000Z';
    const NEW_LEASE = { holderId: 'driver-b', fence: 2, leaseUntilIso: LAPSE_UNTIL };

    await adapter.acquireLease(runId, { holderId: 'driver-a', observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW });
    const bAcquired = await adapter.acquireLease(runId, {
      holderId: 'driver-b',
      observedFence: 1,
      leaseUntilIso: LAPSE_UNTIL,
      nowIso: LAPSE_NOW,
    });
    expect(bAcquired).toEqual({ outcome: 'saved', record: validRun({ lease: NEW_LEASE }) });

    // A's save with fence 1 → lease-not-held
    expect(
      await adapter.save(
        validRun({ revision: 2, lease: NEW_LEASE }),
        { holderId: 'driver-a', fence: 1, nowIso: LAPSE_NOW },
      ),
    ).toEqual({ outcome: 'refused', reason: 'lease-not-held' });

    // B's save → saved
    const bSaved = await adapter.save(
      validRun({ round: 1, attemptIds: ['attempt-example-1', 'attempt-example-2'], revision: 2, lease: NEW_LEASE }),
      { holderId: 'driver-b', fence: 2, nowIso: LAPSE_NOW },
    );
    expect(bSaved).toEqual({
      outcome: 'saved',
      record: validRun({ round: 1, attemptIds: ['attempt-example-1', 'attempt-example-2'], revision: 2, lease: NEW_LEASE }),
    });

    // A's renew → lease-not-held
    expect(
      await adapter.renewLease(runId, {
        holderId: 'driver-a',
        fence: 1,
        leaseUntilIso: IN_2_MIN,
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'lease-not-held' });

    // B's release keeps fence 2 and sets leaseUntilIso to the release time
    const released = await adapter.releaseLease(runId, {
      holderId: 'driver-b',
      fence: 2,
      nowIso: LAPSE_NOW,
    });
    expect(released).toEqual({
      outcome: 'saved',
      record: validRun({
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
        lease: { holderId: 'driver-b', fence: 2, leaseUntilIso: LAPSE_NOW },
      }),
    });

    // a later acquire by A with observedFence 2 → fence 3
    expect(
      await adapter.acquireLease(runId, {
        holderId: 'driver-a',
        observedFence: 2,
        leaseUntilIso: '2026-10-27T10:05:00.000Z',
        nowIso: LAPSE_NOW,
      }),
    ).toEqual({
      outcome: 'saved',
      record: validRun({
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
        lease: { holderId: 'driver-a', fence: 3, leaseUntilIso: '2026-10-27T10:05:00.000Z' },
      }),
    });
  });

  it('lease operations never move the revision; a save built before a renewal still passes', async () => {
    await adapter.create(validRun());
    const runId = validRun().runId;

    await adapter.acquireLease(runId, ACQUIRE);
    expect((await adapter.get(runId))?.revision).toBe(1);

    const view = await adapter.get(runId); // read before the renewal
    expect(view?.revision).toBe(1);

    const RENEWED_UNTIL = '2026-10-27T10:05:00.000Z';
    const renewed = await adapter.renewLease(runId, {
      holderId: 'driver-example-1',
      fence: 1,
      leaseUntilIso: RENEWED_UNTIL,
      nowIso: NOW,
    });
    expect(renewed).toEqual({
      outcome: 'saved',
      record: validRun({ lease: { holderId: 'driver-example-1', fence: 1, leaseUntilIso: RENEWED_UNTIL } }),
    });
    expect((await adapter.get(runId))?.revision).toBe(1);

    // save built on the pre-renewal read still passes with the renewed lease
    const saved = await adapter.save(
      validRun({
        lease: { holderId: 'driver-example-1', fence: 1, leaseUntilIso: RENEWED_UNTIL },
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
      }),
      HOLD,
    );
    expect(saved).toEqual({
      outcome: 'saved',
      record: validRun({
        lease: { holderId: 'driver-example-1', fence: 1, leaseUntilIso: RENEWED_UNTIL },
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
      }),
    });

    // release also never moves the revision
    const released = await adapter.releaseLease(runId, HOLD);
    expect(released).toEqual({
      outcome: 'saved',
      record: validRun({
        lease: { holderId: 'driver-example-1', fence: 1, leaseUntilIso: NOW },
        round: 1,
        attemptIds: ['attempt-example-1', 'attempt-example-2'],
        revision: 2,
      }),
    });
    expect((await adapter.get(runId))?.revision).toBe(2);
  });

  it('concurrency: one of two parallel acquires wins, one of two parallel saves wins', async () => {
    await adapter.create(validRun());
    const runId = validRun().runId;
    await adapter.acquireLease(runId, ACQUIRE);

    const LAPSE_NOW = '2026-10-27T10:03:00.000Z';
    const LAPSE_UNTIL = '2026-10-27T10:04:00.000Z';
    const NEW_LEASE = { holderId: 'driver-example-1', fence: 2, leaseUntilIso: LAPSE_UNTIL };

    const firstAdapter = isFile ? new LaneRunRepositoryAdapter({ stateDir: tempDir }) : adapter;
    const secondAdapter = isFile ? new LaneRunRepositoryAdapter({ stateDir: tempDir }) : adapter;

    const acquires = await Promise.all([
      firstAdapter.acquireLease(runId, {
        holderId: 'driver-example-1',
        observedFence: 1,
        leaseUntilIso: LAPSE_UNTIL,
        nowIso: LAPSE_NOW,
      }),
      secondAdapter.acquireLease(runId, {
        holderId: 'driver-example-1',
        observedFence: 1,
        leaseUntilIso: LAPSE_UNTIL,
        nowIso: LAPSE_NOW,
      }),
    ]);
    expect(acquires.map((result) => result.outcome).sort()).toEqual(['refused', 'saved']);
    const refusedAcquire = acquires.find((result) => result.outcome === 'refused');
    expect(refusedAcquire?.outcome === 'refused' && refusedAcquire.reason).toBe('lease-held');

    const current = await adapter.get(runId);
    expect(current?.lease).toEqual(NEW_LEASE);
    const candidate = { ...current!, revision: 2 };

    const saves = await Promise.all([
      firstAdapter.save(candidate, { holderId: 'driver-example-1', fence: 2, nowIso: LAPSE_NOW }),
      secondAdapter.save(candidate, { holderId: 'driver-example-1', fence: 2, nowIso: LAPSE_NOW }),
    ]);
    expect(saves.map((result) => result.outcome).sort()).toEqual(['refused', 'saved']);
    const refusedSave = saves.find((result) => result.outcome === 'refused');
    expect(refusedSave?.outcome === 'refused' && refusedSave.reason).toBe('stale-revision');
  });
});

describe('LaneRunRepositoryAdapter file read-back, quarantine and file name', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-run-repo-file-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists what a fresh adapter wrote, sorted by run id, and returns fresh copies', async () => {
    const writer = new LaneRunRepositoryAdapter({ stateDir: tempDir });
    await writer.create(validRun());
    const second = validRun({ runId: 'run-01JB0000000000000000000001' });
    await writer.create(second);

    const reader = new LaneRunRepositoryAdapter({ stateDir: tempDir });
    const listed = await reader.list();
    expect(listed.map((record) => record.runId)).toEqual([validRun().runId, second.runId]);

    // mutating a returned record changes nothing stored
    (listed[0]!.attemptIds as string[]).push('tampered');
    (listed[0]!.cursors as Record<string, number | null>)['first-pass'] = 99;
    const after = await reader.get(validRun().runId);
    expect(after?.attemptIds).toEqual(['attempt-example-1']);
    expect(after?.cursors['first-pass']).toBe(0);
  });

  it('quarantines a file holding one invalid record with the exact bytes kept', async () => {
    const garbage = JSON.stringify([{ bogus: true }]);
    await fs.writeFile(path.join(tempDir, 'lane-runs.json'), garbage, 'utf8');
    const adapter = new LaneRunRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
    await expect(
      adapter.save(validRun({ revision: 2 }), HOLD),
    ).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries).toHaveLength(1);
    const kept = await fs.readFile(path.join(quarantineDir, entries[0]!), 'utf8');
    expect(kept).toBe(garbage);
  });

  it('quarantines a non-JSON lane-runs.json', async () => {
    const garbage = '{ not json';
    await fs.writeFile(path.join(tempDir, 'lane-runs.json'), garbage, 'utf8');
    const adapter = new LaneRunRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.get(validRun().runId)).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries).toHaveLength(1);
    const kept = await fs.readFile(path.join(quarantineDir, entries[0]!), 'utf8');
    expect(kept).toBe(garbage);
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    const colliding = new LaneRunRepositoryAdapter({ stateDir: tempDir, fileName: 'run-journal.json' });
    await expect(colliding.list()).rejects.toThrow(/collides with another store/);

    const escaping = new LaneRunRepositoryAdapter({ stateDir: tempDir, fileName: '../x.json' });
    await expect(escaping.list()).rejects.toThrow(/unsafe state file name/);
  });
});
