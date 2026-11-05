// GateReceiptReuseAdapter tests — KS3 over KS2's key: reuse only on an equal key, a miss otherwise.
import { describe, expect, it } from 'vitest';

import {
  GateReceiptReuseAdapter,
  InMemoryGateReceiptRecordStore,
  gateReceiptKeyId,
} from '../GateReceiptReuseAdapter.adapter.js';
import type { GateReceiptRecordStore } from '../GateReceiptReuseAdapter.adapter.js';
import { buildGateReceiptKey } from '../../../domain/gate-receipt-key.js';
import type { GateReceiptKey } from '../../../domain/gate-receipt-key.js';
import type { StoredGatePassResult } from '../../../application/ports/out/GateReceiptReusePort.out-port.js';

function makeKey(overrides: Record<string, unknown> = {}): GateReceiptKey {
  const built = buildGateReceiptKey({
    predicateId: 'command 1: corepack yarn build',
    treeHash: 'a'.repeat(40),
    predicateDefinitionDigest: 'd'.repeat(64),
    toolchainVersions: { node: '22.23.3', yarn: '4.12.0', hexagen: '1.2.3', turbo: '2.11.7' },
    declaredEnvironmentDigest: 'e'.repeat(64),
    ...overrides,
  });
  if (!built.ok) {
    throw new Error('test key unreadable');
  }
  return built.key;
}

const PASS: StoredGatePassResult = { verdict: 'pass', exitCode: 0, durationMs: 12, detail: 'exit 0' };

describe('GateReceiptReuseAdapter', () => {
  it('hits on an equal key and returns the recorded pass', async () => {
    const adapter = new GateReceiptReuseAdapter();
    expect(await adapter.recordGateReceipt({ key: makeKey(), result: PASS })).toEqual({ outcome: 'recorded' });
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'hit', result: PASS });
  });

  it('keeps coverage with the receipt', async () => {
    const adapter = new GateReceiptReuseAdapter();
    const coverage = { ran: true as const, unitKind: 'tests' as const, units: 40 };
    await adapter.recordGateReceipt({ key: makeKey(), result: { ...PASS, coverage } });
    const found = await adapter.findGateReceipt(makeKey());
    expect(found).toMatchObject({ outcome: 'hit', result: { coverage } });
  });

  it('is a miss when any one key component changed', async () => {
    const adapter = new GateReceiptReuseAdapter();
    await adapter.recordGateReceipt({ key: makeKey(), result: PASS });
    const changed: Array<Record<string, unknown>> = [
      { predicateId: 'command 2: other' },
      { treeHash: 'b'.repeat(40) },
      { predicateDefinitionDigest: 'f'.repeat(64) },
      { toolchainVersions: { node: '22.0.0', yarn: '4.12.0', hexagen: '1.2.3', turbo: '2.11.7' } },
      { declaredEnvironmentDigest: '1'.repeat(64) },
    ];
    for (const override of changed) {
      expect(await adapter.findGateReceipt(makeKey(override))).toMatchObject({ outcome: 'miss' });
    }
  });

  it('records idempotently: the first receipt under a key stays', async () => {
    const store = new InMemoryGateReceiptRecordStore();
    const adapter = new GateReceiptReuseAdapter(store);
    expect(await adapter.recordGateReceipt({ key: makeKey(), result: PASS })).toEqual({ outcome: 'recorded' });
    expect(
      await adapter.recordGateReceipt({ key: makeKey(), result: { ...PASS, durationMs: 999, detail: 'second' } }),
    ).toEqual({ outcome: 'already-recorded' });
    expect(store.size).toBe(1);
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'hit', result: PASS });
  });

  it('refuses to store anything but a bounded, secret-free pass', async () => {
    const adapter = new GateReceiptReuseAdapter();
    const secretShaped = ['ghp', '_', 'a'.repeat(24)].join('');
    const refusals = [
      { ...PASS, verdict: 'fail' },
      { ...PASS, verdict: 'unknown' },
      { ...PASS, detail: 'x'.repeat(301) },
      { ...PASS, detail: 'leaked ' + secretShaped },
      { ...PASS, exitCode: 1.5 },
      { ...PASS, durationMs: -1 },
      { ...PASS, coverage: { ran: 'yes' } },
      null,
      'pass',
    ];
    for (const result of refusals) {
      expect(await adapter.recordGateReceipt({ key: makeKey(), result: result as never })).toEqual({
        outcome: 'refused',
        reason: 'result-not-storable',
      });
    }
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'no-stored-receipt' });
  });

  it('never throws on a hostile or unreadable key', async () => {
    const adapter = new GateReceiptReuseAdapter();
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    for (const key of [hostile, null, undefined, 'key', 42, {}, makeKey({ treeHash: 'a'.repeat(40) }) && { schemaVersion: 1 }]) {
      const found = await adapter.findGateReceipt(key as never);
      expect(found.outcome).toBe('miss');
      const recorded = await adapter.recordGateReceipt({ key: key as never, result: PASS });
      expect(recorded).toEqual({ outcome: 'refused', reason: 'key-unreadable' });
    }
    expect(await adapter.recordGateReceipt(null as never)).toEqual({ outcome: 'unavailable' });
  });

  it('treats a throwing store as a miss on lookup and unavailable on record', async () => {
    const broken: GateReceiptRecordStore = {
      get: async () => {
        throw new Error('disk gone');
      },
      putIfAbsent: async () => {
        throw new Error('disk gone');
      },
    };
    const adapter = new GateReceiptReuseAdapter(broken);
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unavailable' });
    expect(await adapter.recordGateReceipt({ key: makeKey(), result: PASS })).toEqual({ outcome: 'unavailable' });
  });

  it('is a miss for a stored record that is unreadable, of an unknown version, or has no result', async () => {
    const key = makeKey();
    const id = gateReceiptKeyId(key);
    const cases: Array<[unknown, string]> = [
      ['garbage', 'stored-key-unreadable'],
      [{ ...key, schemaVersion: 99, result: PASS }, 'stored-key-version-unknown'],
      [{ ...key }, 'stored-result-unreadable'],
      [{ ...key, result: { ...PASS, verdict: 'fail' } }, 'stored-result-unreadable'],
      [{ ...key, treeHash: 'b'.repeat(40), result: PASS }, 'key-changed'],
    ];
    for (const [stored, reason] of cases) {
      const adapter = new GateReceiptReuseAdapter({
        get: async (requested) => (requested === id ? stored : undefined),
        putIfAbsent: async () => 'exists',
      });
      expect(await adapter.findGateReceipt(key)).toEqual({ outcome: 'miss', reason });
    }
  });

  it('bounds the default in-memory store', async () => {
    const store = new InMemoryGateReceiptRecordStore(3);
    for (let index = 0; index < 10; index += 1) {
      await store.putIfAbsent('id' + String(index), { index });
    }
    expect(store.size).toBe(3);
  });
});
