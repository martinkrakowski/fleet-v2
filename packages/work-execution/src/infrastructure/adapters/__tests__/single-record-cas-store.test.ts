import { describe, expect, it } from 'vitest';

import { inspectSingleRecordLedger, SingleRecordCasStore } from '../single-record-cas-store.js';

type Ledger = { readonly revision: number };

const readLedger = (raw: unknown): { ok: true; ledger: Ledger } | { ok: false; reason: string } =>
  typeof raw === 'object' && raw !== null && 'revision' in raw
    ? { ok: true, ledger: raw as Ledger }
    : { ok: false, reason: 'invalid-ledger' };

const config = {
  adapterName: 'TestAdapter',
  ledgerLabel: 'TestLedger',
  defaultFileName: 'test-store.json',
  otherStoreFileNames: ['other-store.json'],
  maxBytes: 1024,
  readLedger,
  schemaVersion: 1,
};

const next = (revision: number): Ledger => ({ revision });

describe('SingleRecordCasStore', () => {
  it('walks compare-and-set 0 -> 1 -> 2 in memory and reports conflicts', async () => {
    const store = new SingleRecordCasStore<Ledger>(config);
    await expect(store.read()).resolves.toEqual({ status: 'missing' });
    await expect(store.compareAndSet({ expectedRevision: 1, next: next(2) })).resolves.toEqual({
      outcome: 'conflict',
      currentRevision: null,
    });
    await expect(store.compareAndSet({ expectedRevision: 0, next: next(1) })).resolves.toEqual({
      outcome: 'saved',
      ledger: next(1),
    });
    await expect(store.compareAndSet({ expectedRevision: 0, next: next(1) })).resolves.toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
    await expect(store.compareAndSet({ expectedRevision: 1, next: next(2) })).resolves.toEqual({
      outcome: 'saved',
      ledger: next(2),
    });
  });

  it('refuses read-only, deadline-exceeded and invalid-request in that order of priority', async () => {
    const store = new SingleRecordCasStore<Ledger>(config);
    await expect(store.compareAndSet({ expectedRevision: 0, next: null })).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    await expect(
      store.compareAndSet({ expectedRevision: 0, next: next(1), deadlineIso: '2000-01-01T00:00:00Z' }),
    ).resolves.toEqual({ outcome: 'refused', reason: 'deadline-exceeded' });
  });

  it('refuses every write when opened read-only and still reads', async () => {
    const store = new SingleRecordCasStore<Ledger>({ ...config }, { readOnly: true });
    await expect(store.read()).resolves.toEqual({ status: 'missing' });
    await expect(store.compareAndSet({ expectedRevision: 0, next: next(1) })).resolves.toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
  });

  it('refuses a file name that is unsafe or collides with another store', () => {
    expect(() => new SingleRecordCasStore<Ledger>(config, { fileName: 'other-store.json' })).toThrow(
      'TestAdapter refuses a fileName that collides with another store',
    );
    expect(() => new SingleRecordCasStore<Ledger>(config, { fileName: '../x.json' })).toThrow(
      'TestAdapter refuses unsafe state file name',
    );
    expect(() => new SingleRecordCasStore<Ledger>(config, { fileName: '.' })).toThrow();
  });

  it('refuses a next ledger that is invalid or whose revision is not expectedRevision + 1', async () => {
    const store = new SingleRecordCasStore<Ledger>(config);
    await expect(store.compareAndSet({ expectedRevision: 0, next: { revision: 2 } })).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    await expect(store.compareAndSet({ expectedRevision: 0, next: 'nope' })).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-ledger',
    });
  });

  it('inspects through the injected ledger reader', () => {
    expect(inspectSingleRecordLedger({ revision: 1 }, readLedger, 'TestLedger')).toEqual({
      status: 'ok',
      record: { revision: 1 },
    });
    expect(inspectSingleRecordLedger('nope', readLedger, 'TestLedger')).toEqual({
      status: 'unreadable',
      detail: 'TestLedger is not a valid ledger',
    });
  });
});
