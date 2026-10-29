import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock } from './file-store.js';
import { emptyTelemetryDispositionRecord } from '../../domain/run-telemetry-dispositions.js';
import {
  TelemetryDispositionAdapter,
  parseTelemetryDispositionStateRecord,
} from './TelemetryDispositionAdapter.adapter.js';
import type { TelemetryDispositionWriteRequest } from '../../domain/run-telemetry-dispositions.js';

const TRACE_A = 'a'.repeat(32);
const TRACE_B = 'b'.repeat(32);
const SPAN_PREFIX_A = 'a';
const SPAN_PREFIX_B = 'b';
const FINGERPRINT_A = 'abc12345';
const FINGERPRINT_B = 'def67890';
const NOW = '2026-10-27T10:00:00.000Z';

function spanId(prefix: string, index: number): string {
  return (prefix + index.toString(16).padStart(15, '0')).slice(0, 16);
}

function pendingWrite(traceId: string, id: string, fingerprint = FINGERPRINT_A): TelemetryDispositionWriteRequest {
  return {
    saltFingerprint: fingerprint,
    updates: [{ traceId, spanId: id, disposition: { state: 'pending' } }],
    nowIso: NOW,
  };
}

function finalWrite(
  traceId: string,
  ids: readonly string[],
  disposition: { state: 'exported'; route: 'collector' } | { state: 'rejected'; reason: 'http-4xx' },
  fingerprint = FINGERPRINT_A,
): TelemetryDispositionWriteRequest {
  return {
    saltFingerprint: fingerprint,
    updates: ids.map((spanId) => ({ traceId, spanId, disposition })),
    nowIso: NOW,
  };
}

describe.each(['memory', 'file'] as const)('TelemetryDispositionAdapter (%s)', (mode) => {
  const isFile = mode === 'file';
  let tempDir: string;
  let adapter: TelemetryDispositionAdapter;

  beforeEach(async () => {
    if (isFile) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-disposition-test-'));
      adapter = new TelemetryDispositionAdapter({ stateDir: tempDir });
    } else {
      adapter = new TelemetryDispositionAdapter();
    }
  });

  afterEach(async () => {
    if (isFile) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a fresh store reads the empty record', async () => {
    const read = await adapter.read();
    expect(read.outcome).toBe('read');
    if (read.outcome === 'read') {
      expect(read.record).toEqual(emptyTelemetryDispositionRecord());
    }
  });

  it('a pending never replaces a stored exported@collector without reopen; with reopen it does', async () => {
    expect(await adapter.write(finalWrite(TRACE_A, [spanId(SPAN_PREFIX_A, 0)], { state: 'exported', route: 'collector' })))
      .toEqual({ outcome: 'written', applied: 1, kept: 0 });
    expect(await adapter.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 0))))
      .toEqual({ outcome: 'written', applied: 0, kept: 1 });

    let read = await adapter.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(read.record.spans[TRACE_A]![spanId(SPAN_PREFIX_A, 0)]).toBe('exported@collector');

    expect(
      await adapter.write({
        saltFingerprint: FINGERPRINT_A,
        reopen: true,
        updates: [{ traceId: TRACE_A, spanId: spanId(SPAN_PREFIX_A, 0), disposition: { state: 'pending' } }],
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'written', applied: 1, kept: 0 });
    read = await adapter.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(read.record.spans[TRACE_A]![spanId(SPAN_PREFIX_A, 0)]).toBe('pending');
  });

  it('a rejected:http-4xx over a pending replaces, and an exported over a rejected replaces', async () => {
    await adapter.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 0)));
    expect(
      await adapter.write(finalWrite(TRACE_A, [spanId(SPAN_PREFIX_A, 0)], { state: 'rejected', reason: 'http-4xx' })),
    ).toEqual({ outcome: 'written', applied: 1, kept: 0 });
    expect(
      await adapter.write(finalWrite(TRACE_A, [spanId(SPAN_PREFIX_A, 0)], { state: 'exported', route: 'collector' })),
    ).toEqual({ outcome: 'written', applied: 1, kept: 0 });
    const read = await adapter.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(read.record.spans[TRACE_A]![spanId(SPAN_PREFIX_A, 0)]).toBe('exported@collector');
  });

  it('a fingerprint mismatch is refused as salt-mismatch and writes nothing', async () => {
    expect(await adapter.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 0)))).toEqual({
      outcome: 'written',
      applied: 1,
      kept: 0,
    });
    expect(await adapter.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 1), FINGERPRINT_B))).toEqual({
      outcome: 'refused',
      reason: 'salt-mismatch',
    });
    const read = await adapter.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(Object.keys(read.record.spans)).toEqual([TRACE_A]);
    expect(Object.keys(read.record.spans[TRACE_A]!)).toEqual([spanId(SPAN_PREFIX_A, 0)]);
  });

  it('an invalid request is refused as invalid-request and writes nothing', async () => {
    expect(
      await adapter.write({
        saltFingerprint: 'nothex',
        updates: [{ traceId: TRACE_A, spanId: spanId(SPAN_PREFIX_A, 0), disposition: { state: 'pending' } }],
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    const read = await adapter.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(read.record).toEqual(emptyTelemetryDispositionRecord());
  });

  it('counters add up and exportedAt sets lastExportAtIso', async () => {
    expect(
      await adapter.write({
        saltFingerprint: FINGERPRINT_A,
        updates: [],
        counters: { timeout: 2, 'queue-drops': 1 },
        exportedAt: true,
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'written', applied: 0, kept: 0 });
    await adapter.write({ saltFingerprint: FINGERPRINT_A, updates: [], counters: { timeout: 1 }, nowIso: NOW });
    const read = await adapter.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(read.record.counters.timeout).toBe(3);
    expect(read.record.counters['queue-drops']).toBe(1);
    expect(read.record.lastExportAtIso).toBe(NOW);
  });
});

describe('TelemetryDispositionAdapter file mode details', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-disposition-file-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a write round-trips through a new adapter instance and the file is a one-element array', async () => {
    const writer = new TelemetryDispositionAdapter({ stateDir: tempDir });
    await writer.write(finalWrite(TRACE_A, [spanId(SPAN_PREFIX_A, 0)], { state: 'exported', route: 'collector' }));

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'telemetry-dispositions.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(1);
    expect(parseTelemetryDispositionStateRecord(raw[0])).not.toBeUndefined();

    const reader = new TelemetryDispositionAdapter({ stateDir: tempDir });
    const read = await reader.read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    expect(read.record.spans[TRACE_A]![spanId(SPAN_PREFIX_A, 0)]).toBe('exported@collector');
    expect(read.record.saltFingerprint).toBe(FINGERPRINT_A);
  });

  it('an unreadable file reads unreadable, refuses a write as store-unreadable and keeps a quarantine copy', async () => {
    const garbage = '{not json CANARY';
    const file = path.join(tempDir, 'telemetry-dispositions.json');
    await fs.writeFile(file, garbage, 'utf8');
    const adapter = new TelemetryDispositionAdapter({ stateDir: tempDir });

    expect(await adapter.read()).toEqual({ outcome: 'unreadable' });
    expect(await adapter.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 0)))).toEqual({
      outcome: 'refused',
      reason: 'store-unreadable',
    });

    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      const kept = await fs.readFile(path.join(quarantineDir, entry), 'utf8');
      expect(kept).toBe(garbage);
    }
    expect(await fs.readFile(file, 'utf8')).toBe(garbage);
  });

  it('a busy lock skips the write within the timeout and the file bytes are unchanged', async () => {
    const file = path.join(tempDir, 'telemetry-dispositions.json');
    const writer = new TelemetryDispositionAdapter({ stateDir: tempDir });
    await writer.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 0)));
    const before = await fs.readFile(file, 'utf8');

    const release = new Promise<void>((resolve) => {
      void withFileLock(`${file}.lock`, () => new Promise((r) => setTimeout(r, 1500))).then(() => resolve());
    });
    const started = Date.now();
    const busy = new TelemetryDispositionAdapter({ stateDir: tempDir, lockTimeoutMs: 200 });
    expect(await busy.write(pendingWrite(TRACE_A, spanId(SPAN_PREFIX_A, 1)))).toEqual({
      outcome: 'skipped',
      reason: 'lock-busy',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    await release;

    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    const colliding = new TelemetryDispositionAdapter({ stateDir: tempDir, fileName: 'conductor-halt.json' });
    await expect(colliding.read()).rejects.toThrow(/collides with another store/);

    const escaping = new TelemetryDispositionAdapter({ stateDir: tempDir, fileName: '../x' });
    await expect(escaping.read()).rejects.toThrow(/unsafe state file name/);
  });
});

describe('TelemetryDispositionAdapter two writers on one state directory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-disposition-2w-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('40 interleaved writes lose nothing, and every span carries its own writer’s final disposition', async () => {
    const spansA = Array.from({ length: 20 }, (_, index) => spanId(SPAN_PREFIX_A, index));
    const spansB = Array.from({ length: 20 }, (_, index) => spanId(SPAN_PREFIX_B, index));
    const writerA = new TelemetryDispositionAdapter({ stateDir: tempDir });
    const writerB = new TelemetryDispositionAdapter({ stateDir: tempDir });

    // The plan's two-writer test: each writer issues its 20 pending marks and
    // then its 20 final marks as one deliberate sequential loop (no lock is
    // skipped), and the two writers run concurrently.
    async function runWriter(
      adapter: TelemetryDispositionAdapter,
      traceId: string,
      ids: readonly string[],
      finalDisposition: { state: 'exported'; route: 'collector' } | { state: 'rejected'; reason: 'http-4xx' },
    ): Promise<unknown[]> {
      const results: unknown[] = [];
      for (const id of ids) {
        results.push(await adapter.write(pendingWrite(traceId, id)));
      }
      for (const id of ids) {
        results.push(await adapter.write(finalWrite(traceId, [id], finalDisposition)));
      }
      return results;
    }

    const [resultsA, resultsB] = await Promise.all([
      runWriter(writerA, TRACE_A, spansA, { state: 'exported', route: 'collector' }),
      runWriter(writerB, TRACE_B, spansB, { state: 'rejected', reason: 'http-4xx' }),
    ]);
    for (const result of [...resultsA, ...resultsB]) {
      expect((result as { outcome: string }).outcome).not.toBe('skipped');
    }

    const stale = await writerA.write(pendingWrite(TRACE_A, spansA[0]!));
    expect(stale).toEqual({ outcome: 'written', applied: 0, kept: 1 });

    const read = await new TelemetryDispositionAdapter({ stateDir: tempDir }).read();
    if (read.outcome !== 'read') {
      expect.fail('the read must succeed');
    }
    const allSpanIds = Object.values(read.record.spans).flatMap((entry) => Object.keys(entry));
    expect(allSpanIds).toHaveLength(40);

    const exportedByThisWriter = new Set(spansA);
    for (const [traceId, entry] of Object.entries(read.record.spans)) {
      for (const [id, text] of Object.entries(entry)) {
        if (text === 'exported@collector') {
          expect(traceId === TRACE_A && exportedByThisWriter.has(id)).toBe(true);
        }
      }
    }
    for (const id of spansA) {
      expect(read.record.spans[TRACE_A]![id]).toBe('exported@collector');
    }
    for (const id of spansB) {
      expect(read.record.spans[TRACE_B]![id]).toBe('rejected:http-4xx');
    }
  });
});
