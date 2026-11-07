import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeRegisterWorkOrderRequestDigest,
  overlapPathCode,
  pureSha256Hex,
  validateHeldWorkOrderRecord,
  type HeldWorkOrderRecord,
  type HeldWorkOrderRequestSnapshot,
} from '../../../domain/held-work-order.js';
import {
  HELD_WORK_ORDERS_FILE,
  HeldWorkOrderRepositoryAdapter,
  duplicateHeldWorkOrderKeyError,
} from '../HeldWorkOrderRepositoryAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from '../state-files.js';

const REQUEST: HeldWorkOrderRequestSnapshot = {
  projectId: 'proj-1',
  taskId: 'task-1',
  laneId: 'lane-1',
  repository: 'acme/fleet',
  baseCommit: '1111111111111111111111111111111111111111',
  ownedPaths: ['packages/a/src'],
  policyRevision: 'rev-1',
  risk: 'high',
  baseBranch: 'main',
  prerequisiteWorkOrderIds: [],
};

function intentRecord(overrides: Partial<HeldWorkOrderRecord> & { request?: HeldWorkOrderRequestSnapshot } = {}): HeldWorkOrderRecord {
  const workOrderId = overrides.workOrderId ?? 'wo-1';
  const request = overrides.request ?? REQUEST;
  const briefRequestRef = overrides.briefRequestRef === undefined ? 'brief-req-01' : overrides.briefRequestRef;
  const requestDigest = computeRegisterWorkOrderRequestDigest(workOrderId, request, briefRequestRef);
  return {
    version: 1,
    stage: 'intent',
    intentId: `hold-${requestDigest.slice(0, 24)}`,
    workOrderId,
    requestDigest,
    briefRequestRef,
    request,
    blockerKind: 'open-pr',
    blockerId: '42',
    pathCode: overlapPathCode('packages/a/src'),
    heldAtIso: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('pure SHA-256 and the canonical request digest', () => {
  it('matches node:crypto for ASCII, multi-block and non-ASCII input', () => {
    for (const text of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000), 'héllo ✓ 😀 \ud800']) {
      expect(pureSha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('is stable across timestamps and sensitive to every request field', () => {
    const base = computeRegisterWorkOrderRequestDigest('wo-1', REQUEST, null);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRegisterWorkOrderRequestDigest('wo-1', { ...REQUEST }, null)).toBe(base);
    expect(computeRegisterWorkOrderRequestDigest('wo-2', REQUEST, null)).not.toBe(base);
    expect(computeRegisterWorkOrderRequestDigest('wo-1', REQUEST, 'brief-req-01')).not.toBe(base);
    expect(computeRegisterWorkOrderRequestDigest('wo-1', { ...REQUEST, ownedPaths: ['packages/b'] }, null)).not.toBe(base);
    expect(computeRegisterWorkOrderRequestDigest('wo-1', { ...REQUEST, risk: 'standard' }, null)).not.toBe(base);
  });
});

describe('validateHeldWorkOrderRecord', () => {
  it('accepts a valid record and rejects a tampered digest, path code or secret-shaped field', () => {
    const record = intentRecord();
    expect(validateHeldWorkOrderRecord(record)).toEqual(record);
    expect(validateHeldWorkOrderRecord({ ...record, requestDigest: 'a'.repeat(64) })).toBeNull();
    expect(validateHeldWorkOrderRecord({ ...record, pathCode: 'path-xyz' })).toBeNull();
    expect(validateHeldWorkOrderRecord({ ...record, heldAtIso: '2026-11-07' })).toBeNull();
    expect(validateHeldWorkOrderRecord({ ...record, blockerKind: 'open-pr', blockerId: '0' })).toBeNull();
    expect(validateHeldWorkOrderRecord({ ...record, extra: true })).toBeNull();
    expect(validateHeldWorkOrderRecord({ ...record, request: { ...REQUEST, ownedPaths: ['../escape'] } })).toBeNull();
    expect(validateHeldWorkOrderRecord(null)).toBeNull();
    expect(validateHeldWorkOrderRecord('text')).toBeNull();
  });

  it('refuses a sparse ownedPaths array and a getter without throwing', () => {
    const record = intentRecord();
    const sparse = new Array<string>(2);
    sparse[0] = 'packages/a/src';
    expect(validateHeldWorkOrderRecord({ ...record, request: { ...REQUEST, ownedPaths: sparse } })).toBeNull();
    const hostile = { ...record };
    Object.defineProperty(hostile, 'workOrderId', {
      enumerable: true,
      get() {
        throw new Error('hostile');
      },
    });
    expect(validateHeldWorkOrderRecord(hostile)).toBeNull();
  });
});

describe('HeldWorkOrderRepositoryAdapter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-held-work-orders-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const filePath = () => path.join(stateDir, HELD_WORK_ORDERS_FILE);

  it.each(['file', 'memory'])('round-trips an intent to held in %s mode', async (mode) => {
    const adapter = new HeldWorkOrderRepositoryAdapter(mode === 'file' ? { stateDir } : undefined);
    const record = intentRecord();
    expect(await adapter.recordHoldIntent(record)).toEqual({ outcome: 'recorded', record });
    expect(await adapter.findByWorkOrderId('wo-1')).toEqual({ outcome: 'found', record });
    const completed = await adapter.completeHoldIntent({
      intentId: record.intentId,
      workOrderId: 'wo-1',
      requestDigest: record.requestDigest,
    });
    expect(completed).toEqual({ outcome: 'held', record: { ...record, stage: 'held' } });
    expect(await adapter.findByIntentId(record.intentId)).toEqual({
      outcome: 'found',
      record: { ...record, stage: 'held' },
    });
    expect(await adapter.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [{ ...record, stage: 'held' }] });
    if (mode === 'file') {
      const descriptor = WORK_EXECUTION_STATE_FILES.find((entry) => entry.basename === HELD_WORK_ORDERS_FILE)!;
      const bytes = await fs.readFile(filePath());
      expect(descriptor.inspect(bytes)).toEqual({ status: 'ok', recordCount: 1, schemaVersions: [1] });
    }
    expect(await adapter.deleteHeldWorkOrder('wo-1', 'b'.repeat(64))).toEqual({ outcome: 'refused' });
    expect(await adapter.deleteHeldWorkOrder('wo-1', record.requestDigest)).toEqual({ outcome: 'deleted' });
    expect(await adapter.deleteHeldWorkOrder('wo-1', record.requestDigest)).toEqual({ outcome: 'not-found' });
    expect(await adapter.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [] });
  });

  it('keeps the original heldAtIso and writes nothing when an identical held request is recorded again', async () => {
    const adapter = new HeldWorkOrderRepositoryAdapter({ stateDir });
    const record = intentRecord();
    await adapter.recordHoldIntent(record);
    await adapter.completeHoldIntent({ intentId: record.intentId, workOrderId: 'wo-1', requestDigest: record.requestDigest });
    const before = await fs.readFile(filePath(), 'utf8');
    const later = { ...record, heldAtIso: '2026-11-07T12:00:00.000Z' };
    const again = await adapter.recordHoldIntent(later);
    expect(again.outcome).toBe('already-held');
    expect(again.outcome === 'already-held' && again.record.heldAtIso).toBe('2026-11-07T10:00:00.000Z');
    expect(await fs.readFile(filePath(), 'utf8')).toBe(before);
  });

  it('recovers an unfinished hold intent on replay with matching workOrderId and requestDigest', async () => {
    const record = intentRecord();
    await new HeldWorkOrderRepositoryAdapter({ stateDir }).recordHoldIntent(record);
    // A new adapter instance stands for the process that replays after a crash.
    const replay = new HeldWorkOrderRepositoryAdapter({ stateDir });
    const before = await fs.readFile(filePath(), 'utf8');
    expect(await replay.recordHoldIntent(record)).toEqual({ outcome: 'recorded', record });
    expect(await fs.readFile(filePath(), 'utf8')).toBe(before);
    expect(
      await replay.completeHoldIntent({ intentId: record.intentId, workOrderId: 'wo-1', requestDigest: record.requestDigest }),
    ).toEqual({ outcome: 'held', record: { ...record, stage: 'held' } });
    expect(await replay.listHeldWorkOrders()).toEqual({ outcome: 'ok', records: [{ ...record, stage: 'held' }] });
  });

  it('refuses before writing when a failed hold intent is retried with a changed workOrderId or changed request digest (F129)', async () => {
    const adapter = new HeldWorkOrderRepositoryAdapter({ stateDir });
    const record = intentRecord();
    await adapter.recordHoldIntent(record);
    const before = await fs.readFile(filePath(), 'utf8');

    const otherWorkOrder = intentRecord({ workOrderId: 'wo-2', intentId: record.intentId });
    expect(await adapter.recordHoldIntent(otherWorkOrder)).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });

    const mutated = intentRecord({ request: { ...REQUEST, ownedPaths: ['packages/b'] } });
    expect(mutated.requestDigest).not.toBe(record.requestDigest);
    expect(await adapter.recordHoldIntent(mutated)).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });

    const otherIntent = intentRecord({ intentId: 'another-intent' });
    expect(await adapter.recordHoldIntent(otherIntent)).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });

    expect(
      await adapter.completeHoldIntent({ intentId: record.intentId, workOrderId: 'wo-2', requestDigest: record.requestDigest }),
    ).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });
    expect(
      await adapter.completeHoldIntent({ intentId: record.intentId, workOrderId: 'wo-1', requestDigest: 'c'.repeat(64) }),
    ).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });
    expect(
      await adapter.completeHoldIntent({ intentId: 'unknown-intent', workOrderId: 'wo-9', requestDigest: record.requestDigest }),
    ).toEqual({ outcome: 'refused', reason: 'intent-not-found' });

    expect(await fs.readFile(filePath(), 'utf8')).toBe(before);
  });

  it('refuses a held work order recorded again with a changed request', async () => {
    const adapter = new HeldWorkOrderRepositoryAdapter({ stateDir });
    const record = intentRecord();
    await adapter.recordHoldIntent(record);
    await adapter.completeHoldIntent({ intentId: record.intentId, workOrderId: 'wo-1', requestDigest: record.requestDigest });
    const mutated = intentRecord({ request: { ...REQUEST, taskId: 'task-2' } });
    expect(await adapter.recordHoldIntent(mutated)).toEqual({ outcome: 'refused', reason: 'held-request-mismatch' });
  });

  it('refuses an invalid or settled record as invalid-record', async () => {
    const adapter = new HeldWorkOrderRepositoryAdapter({ stateDir });
    expect(await adapter.recordHoldIntent({ ...intentRecord(), requestDigest: 'a'.repeat(64) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-record',
    });
    expect(await adapter.recordHoldIntent({ ...intentRecord(), stage: 'held' })).toEqual({
      outcome: 'refused',
      reason: 'invalid-record',
    });
    expect(await adapter.recordHoldIntent(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-record' });
  });

  it('reports a corrupt file, a tampered digest and a duplicate as unreadable, leaving the bytes alone', async () => {
    const adapter = new HeldWorkOrderRepositoryAdapter({ stateDir });
    const record = { ...intentRecord(), stage: 'held' as const };
    const cases: string[] = [
      '{ not json',
      '{}',
      JSON.stringify([{ ...record, schemaVersion: 1, requestDigest: 'f'.repeat(64) }]),
      JSON.stringify([{ ...record, schemaVersion: 1 }, { ...record, schemaVersion: 1 }]),
      JSON.stringify([{ ...record, schemaVersion: 2 }]),
    ];
    for (const bytes of cases) {
      await fs.writeFile(filePath(), bytes, 'utf8');
      expect(await adapter.listHeldWorkOrders()).toEqual({ outcome: 'unreadable' });
      expect(await adapter.findByWorkOrderId('wo-1')).toEqual({ outcome: 'unreadable' });
      expect(await adapter.recordHoldIntent(intentRecord({ workOrderId: 'wo-3' }))).toEqual({
        outcome: 'refused',
        reason: 'store-unavailable',
      });
      expect(await fs.readFile(filePath(), 'utf8')).toBe(bytes);
    }
    await expect(fs.readdir(stateDir)).resolves.not.toContain('quarantine');
  });

  it('refuses store-full at the bound and reports an over-bound file as unreadable', async () => {
    const records = Array.from({ length: 1000 }, (_, index) => {
      const record = intentRecord({ workOrderId: `wo-${index}` });
      return { ...record, stage: 'held' as const };
    });
    expect(duplicateHeldWorkOrderKeyError(records)).toBeNull();
    expect(duplicateHeldWorkOrderKeyError([...records, intentRecord({ workOrderId: 'wo-extra' })])).not.toBeNull();
    await fs.writeFile(filePath(), JSON.stringify(records.map((record) => ({ ...record, schemaVersion: 1 }))), 'utf8');
    const adapter = new HeldWorkOrderRepositoryAdapter({ stateDir });
    expect(await adapter.recordHoldIntent(intentRecord({ workOrderId: 'wo-extra' }))).toEqual({
      outcome: 'refused',
      reason: 'store-full',
    });
    const over = [...records, { ...intentRecord({ workOrderId: 'wo-extra' }), stage: 'held' as const }];
    await fs.writeFile(filePath(), JSON.stringify(over.map((record) => ({ ...record, schemaVersion: 1 }))), 'utf8');
    expect(await adapter.listHeldWorkOrders()).toEqual({ outcome: 'unreadable' });
  });
});
