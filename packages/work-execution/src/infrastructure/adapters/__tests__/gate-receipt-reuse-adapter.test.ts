// Covers the KS2 part 2 robustness bar: equal-key reuse, per-component misses, typed refusals,
// write-once, torn/oversized/other-version stores as misses, crash leftovers, secret and hostile
// keys, symlinks and bounds. Real temp directories; nothing touches a host.
import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile, utimes, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GateReceiptKey } from '../../../domain/gate-receipt-key.js';
import {
  GATE_RECEIPT_MAX_FILE_BYTES,
  GateReceiptReuseAdapter,
} from '../GateReceiptReuseAdapter.adapter.js';

const TREE = 'a'.repeat(40);
const DIGEST_A = 'b'.repeat(64);
const DIGEST_B = 'c'.repeat(64);

function makeKey(overrides: Partial<GateReceiptKey> = {}): GateReceiptKey {
  return {
    schemaVersion: 1,
    predicateId: 'command-typecheck',
    treeHash: TREE,
    predicateDefinitionDigest: DIGEST_A,
    toolchainVersions: { node: '22.23.3', yarn: '4.12.0', hexagen: '1.0.0', turbo: '2.1.0' },
    declaredEnvironmentDigest: DIGEST_B,
    ...overrides,
  };
}

let dir: string;
let storeDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gate-receipt-reuse-'));
  storeDir = path.join(dir, 'gate-receipts');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = (key: GateReceiptKey, verdict: 'pass' | 'fail' = 'pass', receiptRef = 'receipt:run-1/gate@0') => ({
  key,
  verdict,
  receiptRef,
});

describe.each([
  ['file store', (o: { maxRecords?: number }) => new GateReceiptReuseAdapter({ stateDir: dir, ...o })],
  ['in-memory store', (o: { maxRecords?: number }) => new GateReceiptReuseAdapter({ ...o })],
])('%s', (_name, make) => {
  it('hits only on an equal key and returns the stored verdict and reference', async () => {
    const adapter = make({});
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'no-stored-receipt' });
    expect(await adapter.recordGateReceipt(request(makeKey(), 'fail', 'receipt:r/2'))).toEqual({ outcome: 'recorded' });
    expect(await adapter.findGateReceipt(makeKey())).toEqual({
      outcome: 'hit',
      verdict: 'fail',
      receiptRef: 'receipt:r/2',
    });
  });

  it.each<[string, Partial<GateReceiptKey>]>([
    ['predicate id', { predicateId: 'command-lint' }],
    ['tree hash', { treeHash: 'd'.repeat(40) }],
    ['predicate definition digest', { predicateDefinitionDigest: 'e'.repeat(64) }],
    ['node version', { toolchainVersions: { node: '22.0.0', yarn: '4.12.0', hexagen: '1.0.0', turbo: '2.1.0' } }],
    ['yarn version', { toolchainVersions: { node: '22.23.3', yarn: '4.0.0', hexagen: '1.0.0', turbo: '2.1.0' } }],
    ['hexagen version', { toolchainVersions: { node: '22.23.3', yarn: '4.12.0', hexagen: '2.0.0', turbo: '2.1.0' } }],
    ['turbo version', { toolchainVersions: { node: '22.23.3', yarn: '4.12.0', hexagen: '1.0.0', turbo: '3.0.0' } }],
    ['environment digest', { declaredEnvironmentDigest: 'f'.repeat(64) }],
  ])('misses when the %s changed', async (_label, change) => {
    const adapter = make({});
    await adapter.recordGateReceipt(request(makeKey()));
    expect(await adapter.findGateReceipt(makeKey(change))).toEqual({ outcome: 'miss', reason: 'no-stored-receipt' });
  });

  it('writes a receipt once per key and keeps the first', async () => {
    const adapter = make({});
    expect(await adapter.recordGateReceipt(request(makeKey(), 'pass', 'receipt:first'))).toEqual({ outcome: 'recorded' });
    expect(await adapter.recordGateReceipt(request(makeKey(), 'fail', 'receipt:second'))).toEqual({
      outcome: 'already-recorded',
    });
    expect(await adapter.findGateReceipt(makeKey())).toEqual({
      outcome: 'hit',
      verdict: 'pass',
      receiptRef: 'receipt:first',
    });
  });

  it('writes concurrent records of one key once', async () => {
    const adapter = make({});
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => adapter.recordGateReceipt(request(makeKey(), 'pass', `receipt:w${i}`))),
    );
    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already-recorded')).toHaveLength(7);
  });

  it('refuses a key of another version, an unreadable key and a hostile key without storing', async () => {
    const adapter = make({});
    const other = { ...makeKey(), schemaVersion: 2 } as unknown as GateReceiptKey;
    expect(await adapter.recordGateReceipt(request(other))).toEqual({ outcome: 'refused', reason: 'key-version-unknown' });
    expect(await adapter.findGateReceipt(other)).toEqual({ outcome: 'miss', reason: 'key-version-unknown' });
    const short = makeKey({ treeHash: 'abc' });
    expect(await adapter.recordGateReceipt(request(short))).toEqual({ outcome: 'refused', reason: 'key-unreadable' });
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
      getPrototypeOf() {
        throw new Error('boom');
      },
    }) as unknown as GateReceiptKey;
    expect(await adapter.findGateReceipt(hostile)).toEqual({ outcome: 'miss', reason: 'key-unreadable' });
    const getter = {
      get predicateId(): string {
        throw new Error('getter ran');
      },
    } as unknown as GateReceiptKey;
    expect(await adapter.recordGateReceipt(request(getter))).toEqual({ outcome: 'refused', reason: 'key-unreadable' });
    expect(await adapter.recordGateReceipt(null as never)).toEqual({ outcome: 'refused', reason: 'key-unreadable' });
    expect(await adapter.findGateReceipt(undefined as never)).toEqual({ outcome: 'miss', reason: 'key-unreadable' });
  });

  it('refuses a bad verdict and a bad or secret-shaped receipt reference, never echoing it', async () => {
    const adapter = make({});
    const secret = 'receipt:ghp_' + 'A'.repeat(36);
    expect(await adapter.recordGateReceipt({ key: makeKey(), verdict: 'unknown' as never, receiptRef: 'x' })).toEqual({
      outcome: 'refused',
      reason: 'verdict-unreadable',
    });
    for (const ref of [secret, '', 'has space', 'a\nb', 'x'.repeat(201), 42 as never]) {
      const result = await adapter.recordGateReceipt(request(makeKey(), 'pass', ref));
      expect(result).toEqual({ outcome: 'refused', reason: 'receipt-ref-unreadable' });
      expect(JSON.stringify(result)).not.toContain('ghp_');
    }
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'no-stored-receipt' });
  });

  it('refuses a secret-shaped key component and stores nothing', async () => {
    const adapter = make({});
    const key = makeKey({ predicateId: 'ghp_' + 'B'.repeat(36) });
    expect(await adapter.recordGateReceipt(request(key))).toEqual({ outcome: 'refused', reason: 'key-unreadable' });
    expect(await adapter.findGateReceipt(key)).toEqual({ outcome: 'miss', reason: 'key-unreadable' });
  });

  it('refuses a record past the receipt bound and keeps older receipts reusable', async () => {
    const adapter = make({ maxRecords: 2 });
    expect((await adapter.recordGateReceipt(request(makeKey({ predicateId: 'p1' })))).outcome).toBe('recorded');
    expect((await adapter.recordGateReceipt(request(makeKey({ predicateId: 'p2' })))).outcome).toBe('recorded');
    expect(await adapter.recordGateReceipt(request(makeKey({ predicateId: 'p3' })))).toEqual({
      outcome: 'refused',
      reason: 'store-full',
    });
    expect((await adapter.findGateReceipt(makeKey({ predicateId: 'p1' }))).outcome).toBe('hit');
    expect((await adapter.recordGateReceipt(request(makeKey({ predicateId: 'p1' })))).outcome).toBe('already-recorded');
  });
});

describe('file store faults', () => {
  const receiptPath = async (adapter: GateReceiptReuseAdapter): Promise<string> => {
    await adapter.recordGateReceipt(request(makeKey()));
    const names = (await readdir(storeDir)).filter((n) => n.endsWith('.json'));
    expect(names).toHaveLength(1);
    return path.join(storeDir, names[0]!);
  };

  it('stores the verdict and reference but no secret value', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, verdict: 'pass', receiptRef: 'receipt:run-1/gate@0' });
    expect(text).not.toMatch(/token|secret|password/i);
  });

  it('treats a torn (truncated) receipt as a miss, never a hit, and recovers on record', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.slice(0, text.length - 25));
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unreadable' });
    expect(await adapter.recordGateReceipt(request(makeKey(), 'fail', 'receipt:fixed'))).toEqual({ outcome: 'recorded' });
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'hit', verdict: 'fail', receiptRef: 'receipt:fixed' });
  });

  it('misses on garbage, an array, a mismatched key and a missing verdict', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    const good = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const variants: unknown[] = [
      'not json{',
      JSON.stringify([good]),
      JSON.stringify({ ...good, treeHash: 'd'.repeat(40) }),
      JSON.stringify({ ...good, verdict: 'unknown' }),
      JSON.stringify({ ...good, verdict: undefined }),
      JSON.stringify({ ...good, receiptRef: 'ghp_' + 'C'.repeat(36) }),
    ];
    for (const variant of variants) {
      await writeFile(file, String(variant));
      expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unreadable' });
    }
  });

  it('misses on an unknown record version and refuses to overwrite it', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    const good = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const newer = JSON.stringify({ ...good, schemaVersion: 2 });
    await writeFile(file, newer);
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-version-unknown' });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'refused', reason: 'store-version-unknown' });
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('refuses an oversized receipt file as a miss without reading it all', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    await writeFile(file, 'x'.repeat(GATE_RECEIPT_MAX_FILE_BYTES + 10));
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unreadable' });
  });

  it('ignores a crash leftover temp file, and sweeps a stale one on the next record', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    await mkdir(storeDir, { recursive: true });
    const stale = path.join(storeDir, `${'0'.repeat(64)}.1-1-aa.tmp`);
    const fresh = path.join(storeDir, `${'1'.repeat(64)}.1-2-bb.tmp`);
    await writeFile(stale, '{"half');
    await writeFile(fresh, '{"half');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'no-stored-receipt' });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'recorded' });
    const names = await readdir(storeDir);
    expect(names).not.toContain(path.basename(stale));
    expect(names).toContain(path.basename(fresh));
    expect(names.filter((n) => n.endsWith('.tmp') && n !== path.basename(fresh))).toHaveLength(0);
    expect((await adapter.findGateReceipt(makeKey())).outcome).toBe('hit');
  });

  it('never follows a symlinked receipt file', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    const outside = path.join(dir, 'outside.json');
    await writeFile(outside, await readFile(file, 'utf8'));
    await rm(file);
    await symlink(outside, file);
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unreadable' });
    expect(await adapter.recordGateReceipt(request(makeKey(), 'fail', 'receipt:other'))).toEqual({
      outcome: 'refused',
      reason: 'store-unreadable',
    });
    expect(JSON.parse(await readFile(outside, 'utf8')).receiptRef).toBe('receipt:run-1/gate@0');
  });

  it('never follows a symlinked store directory', async () => {
    const elsewhere = path.join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, storeDir);
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unreadable' });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('is a miss and a refusal, not an exception, when the state directory is a file', async () => {
    const blocker = path.join(dir, 'file');
    await writeFile(blocker, 'x');
    const adapter = new GateReceiptReuseAdapter({ stateDir: blocker });
    expect((await adapter.findGateReceipt(makeKey())).outcome).toBe('miss');
    expect((await adapter.recordGateReceipt(request(makeKey()))).outcome).toBe('refused');
  });

  it('refuses every write when read-only and still serves a stored receipt', async () => {
    await new GateReceiptReuseAdapter({ stateDir: dir }).recordGateReceipt(request(makeKey()));
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, readOnly: true });
    expect((await adapter.findGateReceipt(makeKey())).outcome).toBe('hit');
    expect(await adapter.recordGateReceipt(request(makeKey({ predicateId: 'other' })))).toEqual({
      outcome: 'refused',
      reason: 'store-read-only',
    });
  });

  it('bounds a call by its deadline', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, deadlineMs: 1 });
    // A deadline of 1 ms may or may not be met; either way the result is typed and nothing throws.
    const found = await adapter.findGateReceipt(makeKey());
    expect(found.outcome).toBe('miss');
    const recorded = await adapter.recordGateReceipt(request(makeKey()));
    expect(['recorded', 'refused']).toContain(recorded.outcome);
  });

  it('keeps the receipt count bounded on disk', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, maxRecords: 1 });
    await adapter.recordGateReceipt(request(makeKey({ predicateId: 'a1' })));
    expect(await adapter.recordGateReceipt(request(makeKey({ predicateId: 'a2' })))).toEqual({
      outcome: 'refused',
      reason: 'store-full',
    });
    expect((await readdir(storeDir)).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });
  it('repairs a torn receipt once when several writers race', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir });
    const file = await receiptPath(adapter);
    await writeFile(file, '{"torn');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => adapter.recordGateReceipt(request(makeKey(), 'pass', `receipt:r${i}`))),
    );
    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already-recorded')).toHaveLength(5);
    const winner = results.findIndex((r) => r.outcome === 'recorded');
    expect(await adapter.findGateReceipt(makeKey())).toEqual({
      outcome: 'hit',
      verdict: 'pass',
      receiptRef: `receipt:r${winner}`,
    });
    expect(await adapter.recordGateReceipt(request(makeKey(), 'fail', 'receipt:late'))).toEqual({
      outcome: 'already-recorded',
    });
  });

  it('reports a directory flooded with foreign names as full without reading it whole', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, maxRecords: 1 });
    await mkdir(storeDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 1200 }, (_, i) => writeFile(path.join(storeDir, `foreign-${i}.txt`), '')),
    );
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'refused', reason: 'store-full' });
    expect((await adapter.findGateReceipt(makeKey())).outcome).toBe('miss');
  });

  it('never exceeds the receipt bound when different keys are recorded concurrently', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, maxRecords: 1 });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => adapter.recordGateReceipt(request(makeKey({ predicateId: `k${i}` })))),
    );
    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect((await readdir(storeDir)).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });

  it('resolves a symlinked state directory once at construction and then uses only the resolved root', async () => {
    const elsewhere = path.join(dir, 'elsewhere');
    const other = path.join(dir, 'other');
    await mkdir(elsewhere);
    await mkdir(other);
    const link = path.join(dir, 'state-link');
    await symlink(elsewhere, link);
    const adapter = new GateReceiptReuseAdapter({ stateDir: link });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'recorded' });
    await rm(link);
    await symlink(other, link);
    expect((await adapter.findGateReceipt(makeKey())).outcome).toBe('hit');
    expect(await readdir(other)).toEqual([]);
    expect(await readdir(path.join(elsewhere, 'gate-receipts'))).toHaveLength(1);
  });

  it('clamps an enormous receipt bound', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, maxRecords: Number.MAX_SAFE_INTEGER });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'recorded' });
  });

  it('follows a symlinked ancestor once, at construction, and ignores a later swap', async () => {
    const real = path.join(dir, 'real');
    const evil = path.join(dir, 'evil');
    await mkdir(real);
    await mkdir(evil);
    const link = path.join(dir, 'link');
    await symlink(real, link);
    const adapter = new GateReceiptReuseAdapter({ stateDir: path.join(link, 'state') });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'recorded' });
    await rm(link);
    await symlink(evil, link);
    expect(await adapter.recordGateReceipt(request(makeKey({ predicateId: 'later' })))).toEqual({ outcome: 'recorded' });
    expect(await adapter.findGateReceipt(makeKey())).toMatchObject({ outcome: 'hit' });
    expect(await readdir(evil)).toEqual([]);
    expect((await readdir(path.join(await realpath(real), 'state', 'gate-receipts'))).length).toBe(2);
  });

  it('refuses when the resolved root itself is swapped for a symlink after construction', async () => {
    const parent = path.join(dir, 'parent');
    const evil = path.join(dir, 'evil2');
    await mkdir(parent);
    await mkdir(evil);
    const adapter = new GateReceiptReuseAdapter({ stateDir: path.join(parent, 'state') });
    expect(await adapter.recordGateReceipt(request(makeKey()))).toEqual({ outcome: 'recorded' });
    await rename(parent, path.join(dir, 'parent-moved'));
    await symlink(evil, parent);
    expect(await adapter.findGateReceipt(makeKey())).toEqual({ outcome: 'miss', reason: 'store-unreadable' });
    expect(await adapter.recordGateReceipt(request(makeKey({ predicateId: 'x' })))).toEqual({
      outcome: 'refused',
      reason: 'store-unreadable',
    });
    expect(await readdir(evil)).toEqual([]);
  });

  it('does not let a record that reported a timeout take effect later', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, deadlineMs: 30 });
    // Hold the write queue so the second record waits past its deadline.
    const slow = (adapter as unknown as { serialized: (w: () => Promise<unknown>) => Promise<unknown> }).serialized(
      () => new Promise((resolve) => setTimeout(resolve, 150)),
    );
    const late = await adapter.recordGateReceipt(request(makeKey()));
    expect(late).toEqual({ outcome: 'refused', reason: 'store-timeout' });
    await slow;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await new GateReceiptReuseAdapter({ stateDir: dir }).findGateReceipt(makeKey())).toEqual({
      outcome: 'miss',
      reason: 'no-stored-receipt',
    });
  });

  it('lets a record that is already publishing finish and report its own result', async () => {
    const adapter = new GateReceiptReuseAdapter({ stateDir: dir, deadlineMs: 20 });
    const fsMod = await import('node:fs');
    const original = fsMod.promises.link;
    const spy = vi.spyOn(fsMod.promises, 'link').mockImplementation(async (a, b) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return original(a, b);
    });
    try {
      const result = await adapter.recordGateReceipt(request(makeKey()));
      expect(result).toEqual({ outcome: 'recorded' });
    } finally {
      spy.mockRestore();
    }
    expect((await adapter.findGateReceipt(makeKey())).outcome).toBe('hit');
  });

});
