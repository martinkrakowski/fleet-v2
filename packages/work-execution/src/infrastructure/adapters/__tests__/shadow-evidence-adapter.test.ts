/**
 * ShadowEvidenceAdapter (lane SH2): the file and memory modes of the
 * shadow-evidence ledger store, mirroring the CutoverRecordRepositoryAdapter
 * test shape — missing, saved round trip, unknown-version, unreadable,
 * symlink, size cap, conflict, refusal reasons, read-only, deadline, and the
 * file-lock race where exactly one of two racing writes saves.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShadowLedger } from '../../../domain/shadow-evidence-ledger.js';
import { SHADOW_LEDGER_SCHEMA_VERSION } from '../../../domain/shadow-evidence-ledger.js';
import { ShadowEvidenceAdapter, SHADOW_EVIDENCE_MAX_BYTES } from '../ShadowEvidenceAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from '../state-files.js';

function ledger(revision = 1, overrides: Partial<ShadowLedger> = {}): ShadowLedger {
  return { schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION, revision, days: [], ...overrides };
}

function dayLedger(revision = 1, day = '2026-11-16'): ShadowLedger {
  return ledger(revision, {
    days: [
      {
        day,
        releaseSha: 'a'.repeat(40),
        mergesCompared: 25,
        verdicts: {
          S1: { verdict: 'pass', reason: 'merge-parity', digest: 'b'.repeat(64), recordedAtIso: '2026-11-16T10:00:00.000Z' },
        },
      },
    ],
  });
}

describe('ShadowEvidenceAdapter', () => {
  let tempDir: string;
  let target: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-evidence-test-'));
    target = path.join(tempDir, 'cutover-shadow.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['memory', 'disk'] as const)('reads missing and walks compare-and-set 0 -> 1 -> 2 (%s)', async (mode) => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: mode === 'disk' ? tempDir : undefined });
    expect(await adapter.read()).toEqual({ status: 'missing' });

    const first = dayLedger(1);
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: first })).toEqual({ outcome: 'saved', ledger: first });
    expect(await adapter.read()).toEqual({ status: 'ok', ledger: first });

    const second = dayLedger(2, '2026-11-17');
    expect(await adapter.compareAndSet({ expectedRevision: 1, next: second })).toEqual({ outcome: 'saved', ledger: second });
    expect(await adapter.read()).toEqual({ status: 'ok', ledger: second });
    if (mode === 'disk') {
      const stored = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
      expect(stored.schemaVersion).toBe(SHADOW_LEDGER_SCHEMA_VERSION);
      expect(stored.revision).toBe(2);
    }
  });

  it.each(['memory', 'disk'] as const)('answers a conflict with the current revision (%s)', async (mode) => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: mode === 'disk' ? tempDir : undefined });
    expect(await adapter.compareAndSet({ expectedRevision: 3, next: dayLedger(4) })).toEqual({
      outcome: 'conflict',
      currentRevision: null,
    });
    await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) })).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
    expect(await adapter.compareAndSet({ expectedRevision: 5, next: dayLedger(6) })).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
  });

  it('reports a conflict before validating a structurally invalid next, never refused', async () => {
    const adapter = new ShadowEvidenceAdapter();
    await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) });
    expect(
      await adapter.compareAndSet({
        expectedRevision: 5,
        next: { ...dayLedger(2), days: 'nope' } as unknown as ShadowLedger,
      }),
    ).toEqual({ outcome: 'conflict', currentRevision: 1 });
  });

  it('refuses a next ledger whose revision is not expectedRevision + 1 or that is structurally invalid', async () => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    expect(
      await adapter.compareAndSet({ expectedRevision: 0, next: { ...dayLedger(1), revision: 0 } as unknown as ShadowLedger }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-ledger' });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(
      await adapter.compareAndSet({ expectedRevision: 0, next: { ...dayLedger(1), days: 'nope' } as unknown as ShadowLedger }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-ledger' });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('refuses a malformed request shape as invalid-request', async () => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    const request = { expectedRevision: 0, next: dayLedger(1) } as unknown as Record<string, unknown>;
    expect(await adapter.compareAndSet({ ...request, extra: true } as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet({ expectedRevision: -1, next: dayLedger(0) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet({ expectedRevision: 1.5, next: dayLedger(2.5) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: null as unknown as ShadowLedger })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1), deadlineIso: 'not-a-date' })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('reports unknown-version and refuses to overwrite it, bytes unchanged', async () => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    const newer = JSON.stringify({ ...dayLedger(1), schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION + 1 });
    await fs.writeFile(target, newer);
    expect(await adapter.read()).toEqual({ status: 'unknown-version' });
    expect(await adapter.compareAndSet({ expectedRevision: 1, next: dayLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'unknown-version',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(newer);
  });

  it('reports garbage bytes as unreadable and refuses to overwrite them', async () => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    for (const bytes of ['{ not json', '[]', JSON.stringify({ ...dayLedger(1), extra: true })]) {
      await fs.writeFile(target, bytes);
      expect(await adapter.read()).toEqual({ status: 'unreadable' });
      expect(await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) })).toEqual({
        outcome: 'refused',
        reason: 'unreadable',
      });
      expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    }
    expect((await fs.readdir(tempDir)).filter((name) => name !== 'cutover-shadow.json' && !name.endsWith('.lock'))).toEqual([]);
  });

  it('refuses a symlinked store as unreadable, never as missing', async () => {
    const real = path.join(tempDir, 'elsewhere.json');
    await fs.writeFile(real, JSON.stringify(dayLedger(1)));
    await fs.symlink(real, target);
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    expect(await adapter.read()).toEqual({ status: 'unreadable' });
    expect(await adapter.compareAndSet({ expectedRevision: 1, next: dayLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
  });

  it('refuses a file over the size cap as unreadable', async () => {
    await fs.writeFile(target, 'x'.repeat(SHADOW_EVIDENCE_MAX_BYTES + 1));
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    expect(await adapter.read()).toEqual({ status: 'unreadable' });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) })).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
    expect((await fs.stat(target)).size).toBe(SHADOW_EVIDENCE_MAX_BYTES + 1);
  });

  it('refuses every write when opened read-only and still reads', async () => {
    const writable = new ShadowEvidenceAdapter({ stateDir: tempDir });
    await writable.compareAndSet({ expectedRevision: 0, next: dayLedger(1) });
    const before = await fs.readFile(target, 'utf8');
    const readOnly = new ShadowEvidenceAdapter({ stateDir: tempDir, readOnly: true });
    expect(await readOnly.read()).toEqual({ status: 'ok', ledger: dayLedger(1) });
    expect(await readOnly.compareAndSet({ expectedRevision: 1, next: dayLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
    expect(await readOnly.compareAndSet({ expectedRevision: 0, next: dayLedger(1) })).toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('refuses a deadlineIso already in the past before any file I/O', async () => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir, nowIso: () => '2026-11-16T12:00:00.000Z' });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1), deadlineIso: '2026-11-16T11:00:00.000Z' })).toEqual({
      outcome: 'refused',
      reason: 'deadline-exceeded',
    });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
    expect(await adapter.read({ deadlineIso: '2026-11-16T11:00:00.000Z' })).toEqual({ status: 'unreadable' });
    await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) });
    const before = await fs.readFile(target, 'utf8');
    expect(await adapter.compareAndSet({ expectedRevision: 1, next: dayLedger(2), deadlineIso: '2026-11-16T11:00:00.000Z' })).toEqual({
      outcome: 'refused',
      reason: 'deadline-exceeded',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('lets exactly one of two racing compare-and-set calls save, the other conflict', async () => {
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    const results = await Promise.all([
      adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) }),
      adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1, '2026-11-17') }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['conflict', 'saved']);
    const read = await adapter.read();
    expect(read.status).toBe('ok');
    expect((read as { ledger: ShadowLedger }).ledger.revision).toBe(1);
  });

  it('refuses a file name that is unsafe or collides with another store', () => {
    for (const fileName of ['cutover.json', 'cutover-journal.json', 'killall-train-pause.json', '../x.json', 'a/b.json', '']) {
      expect(() => new ShadowEvidenceAdapter({ stateDir: tempDir, fileName })).toThrow();
    }
    expect(() => new ShadowEvidenceAdapter({ stateDir: tempDir, fileName: 'cutover-shadow-alt.json' })).not.toThrow();
  });

  it('is described to `fleet-v2 state` as the single-record store cutover-shadow.json', async () => {
    const descriptor = WORK_EXECUTION_STATE_FILES.find((entry) => entry.basename === 'cutover-shadow.json');
    expect(descriptor).toBeDefined();
    expect(descriptor?.inspect(Buffer.from(JSON.stringify(dayLedger(1))))).toEqual({ status: 'ok', recordCount: 1 });
    expect(
      descriptor?.inspect(Buffer.from(JSON.stringify({ ...dayLedger(1), schemaVersion: SHADOW_LEDGER_SCHEMA_VERSION + 1 })))
        .status,
    ).toBe('unknown-version');
    expect(descriptor?.inspect(Buffer.from('{ nope')).status).toBe('unreadable');
    expect(descriptor?.inspect(Buffer.from('[]')).status).toBe('unreadable');
    const adapter = new ShadowEvidenceAdapter({ stateDir: tempDir });
    await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) });
    expect((await descriptor?.check(tempDir))?.result).toMatchObject({ status: 'ok', recordCount: 1 });
  });

  it('in-memory mode never touches the filesystem', async () => {
    // Every fs/promises function ShadowEvidenceAdapter's code paths can reach:
    // readBoundedStoreBytes (lstat, open), withFileLock including its
    // lock-timeout diagnostics in readLockHolderInfo (mkdir, open, readFile,
    // unlink, stat) and writeJsonAtomically (mkdir, writeFile, rename, rm). A
    // regression that made memory mode fall through to disk I/O on any one of
    // these must fail this test, not just on the three it used to check.
    const spies = [
      vi.spyOn(fs, 'open'),
      vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs, 'lstat'),
      vi.spyOn(fs, 'stat'),
      vi.spyOn(fs, 'mkdir'),
      vi.spyOn(fs, 'writeFile'),
      vi.spyOn(fs, 'rename'),
      vi.spyOn(fs, 'unlink'),
      vi.spyOn(fs, 'rm'),
    ];
    try {
      const adapter = new ShadowEvidenceAdapter();
      expect(await adapter.read()).toEqual({ status: 'missing' });
      await adapter.compareAndSet({ expectedRevision: 0, next: dayLedger(1) });
      expect(await adapter.read()).toEqual({ status: 'ok', ledger: dayLedger(1) });
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
