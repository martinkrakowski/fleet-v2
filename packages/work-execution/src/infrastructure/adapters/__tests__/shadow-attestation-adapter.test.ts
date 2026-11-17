/**
 * ShadowAttestationAdapter (lane SH16): the file and memory modes of the
 * shadow-attestation ledger store, mirroring the ShadowEvidenceAdapter test
 * shape — missing, saved round trip, unknown-version, unreadable, symlink,
 * size cap, conflict, refusal reasons, read-only, deadline, and the file-lock
 * race where exactly one of two racing writes saves.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShadowAttestationLedger } from '../../../domain/shadow-attestations.js';
import {
  SHADOW_ATTESTATION_FACTS,
  SHADOW_ATTESTATION_SCHEMA_VERSION,
} from '../../../domain/shadow-attestations.js';
import {
  ShadowAttestationAdapter,
  SHADOW_ATTESTATION_MAX_BYTES,
  inspectSingleShadowAttestations,
} from '../ShadowAttestationAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from '../state-files.js';

const DIGEST = 'a'.repeat(64);
const RELEASE_SHA = 'c'.repeat(40);
const DAY = '2026-02-01';
const FORGE = SHADOW_ATTESTATION_FACTS[0];

function attestationLedger(revision = 1, overrides: Partial<ShadowAttestationLedger> = {}): ShadowAttestationLedger {
  return { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision, attestations: [], ...overrides };
}

function attestationLedgerWithOne(revision = 1): ShadowAttestationLedger {
  return attestationLedger(revision, {
    attestations: [
      {
        fact: FORGE,
        observedDay: DAY,
        releaseSha: RELEASE_SHA,
        reason: 'ok',
        digest: DIGEST,
        recordedAtIso: '2026-02-03T00:00:00.000Z',
      },
    ],
  });
}

describe('ShadowAttestationAdapter', () => {
  let tempDir: string;
  let target: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'fleet-shadow-attestation-test-'));
    target = path.join(tempDir, 'cutover-shadow-attestations.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['memory', 'disk'] as const)(
    'reads missing and walks compare-and-set 0 -> 1 -> 2 (%s)',
    async (mode) => {
      const adapter = new ShadowAttestationAdapter({ stateDir: mode === 'disk' ? tempDir : undefined });
      expect(await adapter.read()).toEqual({ status: 'missing' });

      const first = attestationLedger(1);
      expect(await adapter.compareAndSet({ expectedRevision: 0, next: first })).toEqual({
        outcome: 'saved',
        ledger: first,
      });
      expect(await adapter.read()).toEqual({ status: 'ok', ledger: first });

      const second = attestationLedger(2, {
        attestations: [
          {
            fact: FORGE,
            observedDay: DAY,
            releaseSha: RELEASE_SHA,
            reason: 'ok',
            digest: DIGEST,
            recordedAtIso: '2026-02-03T00:00:00.000Z',
          },
        ],
      });
      expect(await adapter.compareAndSet({ expectedRevision: 1, next: second })).toEqual({
        outcome: 'saved',
        ledger: second,
      });
      expect(await adapter.read()).toEqual({ status: 'ok', ledger: second });
      if (mode === 'disk') {
        const stored = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>;
        expect(stored.schemaVersion).toBe(SHADOW_ATTESTATION_SCHEMA_VERSION);
        expect(stored.revision).toBe(2);
      }
    },
  );

  it.each(['memory', 'disk'] as const)('answers a conflict with the current revision (%s)', async (mode) => {
    const adapter = new ShadowAttestationAdapter({ stateDir: mode === 'disk' ? tempDir : undefined });
    expect(await adapter.compareAndSet({ expectedRevision: 3, next: attestationLedger(4) })).toEqual({
      outcome: 'conflict',
      currentRevision: null,
    });
    await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) })).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
    expect(await adapter.compareAndSet({ expectedRevision: 5, next: attestationLedger(6) })).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
  });

  it('reports a conflict before validating a structurally invalid next, never refused', async () => {
    const adapter = new ShadowAttestationAdapter();
    await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
    expect(
      await adapter.compareAndSet({
        expectedRevision: 5,
        next: { ...attestationLedger(2), attestations: 'nope' } as unknown as ShadowAttestationLedger,
      }),
    ).toEqual({ outcome: 'conflict', currentRevision: 1 });
  });

  it('reports a conflict before validating a structurally invalid next on the disk path, never refused', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
    expect(
      await adapter.compareAndSet({
        expectedRevision: 5,
        next: { ...attestationLedger(2), attestations: 'nope' } as unknown as ShadowAttestationLedger,
      }),
    ).toEqual({ outcome: 'conflict', currentRevision: 1 });
    expect(await adapter.read()).toEqual({ status: 'ok', ledger: attestationLedger(1) });
  });

  it('refuses a next ledger whose revision is not expectedRevision + 1 or that is structurally invalid', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    expect(
      await adapter.compareAndSet({
        expectedRevision: 0,
        next: { ...attestationLedger(1), revision: 0 } as unknown as ShadowAttestationLedger,
      }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-ledger' });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(
      await adapter.compareAndSet({
        expectedRevision: 0,
        next: { ...attestationLedger(1), attestations: 'nope' } as unknown as ShadowAttestationLedger,
      }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-ledger' });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('refuses a malformed request shape as invalid-request', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    expect(await adapter.compareAndSet(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await adapter.compareAndSet(undefined as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet(7 as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await adapter.compareAndSet('nope' as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    const request = { expectedRevision: 0, next: attestationLedger(1) } as unknown as Record<string, unknown>;
    expect(await adapter.compareAndSet({ ...request, extra: true } as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet({ expectedRevision: -1, next: attestationLedger(0) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.compareAndSet({ expectedRevision: 1.5, next: attestationLedger(2.5) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(
      await adapter.compareAndSet({ expectedRevision: 0, next: null as unknown as ShadowAttestationLedger }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(
      await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1), deadlineIso: 'not-a-date' }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('never runs a getter on the request while refusing it as invalid-request', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    let getterCalls = 0;
    const hostile = {
      get expectedRevision(): number {
        getterCalls += 1;
        return 0;
      },
      next: attestationLedger(1),
    };
    expect(await adapter.compareAndSet(hostile as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(getterCalls).toBe(0);
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('refuses a request whose own-keys read throws as invalid-request, never unreadable (SH16)', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    const hostileRequest = new Proxy(
      { expectedRevision: 0, next: attestationLedger(1) },
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(await adapter.compareAndSet(hostileRequest)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('refuses a class-instance request as invalid-request with no I/O', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    const validNext = attestationLedger(1);
    class InstanceRequest {
      expectedRevision = 0;
      next = validNext;
    }
    // Every field name and value is one the plain-object path would accept
    // (`expectedRevision: 0` with a valid `next`), so the only reason left for
    // the refusal is that the request is a class instance, not a plain object.
    expect(await adapter.compareAndSet(new InstanceRequest() as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
  });

  it('refuses a deadline already in the past before any store read, even an unreadable one', async () => {
    await fs.writeFile(target, '{ not json');
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir, nowIso: () => '2026-11-16T12:00:00.000Z' });
    // The file on disk is unreadable, so a read would answer 'unreadable'; the
    // deadline refusal must win BEFORE that read, and no fs call may happen.
    const spies = [
      vi.spyOn(fs, 'lstat'),
      vi.spyOn(fs, 'open'),
      vi.spyOn(fs, 'readFile'),
      vi.spyOn(fs, 'mkdir'),
    ];
    try {
      expect(
        await adapter.compareAndSet({
          expectedRevision: 0,
          next: attestationLedger(1),
          deadlineIso: '2026-11-16T11:00:00.000Z',
        }),
      ).toEqual({ outcome: 'refused', reason: 'deadline-exceeded' });
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    expect(await fs.readFile(target, 'utf8')).toBe('{ not json');
  });

  it('writes a successful compare-and-set through a temp file and rename, never the target directly', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
    const writeFileSpy = vi.spyOn(fs, 'writeFile');
    const renameSpy = vi.spyOn(fs, 'rename');
    try {
      expect(await adapter.compareAndSet({ expectedRevision: 1, next: attestationLedger(2) })).toEqual({
        outcome: 'saved',
        ledger: attestationLedger(2),
      });
      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [renamedFrom, renamedTo] = renameSpy.mock.calls[0];
      expect(renamedTo).toBe(target);
      expect(renamedFrom).not.toBe(target);
      // Every direct writeFile call (the lock takes its own file handle) aims
      // at a temp path, never the store itself.
      for (const [writtenPath] of writeFileSpy.mock.calls) {
        expect(writtenPath).not.toBe(target);
      }
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toMatchObject({ revision: 2 });
    } finally {
      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('reports unknown-version and refuses to overwrite it, bytes unchanged', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    const newer = JSON.stringify({ ...attestationLedger(1), schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION + 1 });
    await fs.writeFile(target, newer);
    expect(await adapter.read()).toEqual({ status: 'unknown-version' });
    expect(await adapter.compareAndSet({ expectedRevision: 1, next: attestationLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'unknown-version',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(newer);
  });

  it('reports garbage bytes as unreadable and refuses to overwrite them', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    for (const bytes of [
      '{ not json',
      '[]',
      'null',
      JSON.stringify({ ...attestationLedger(1), extra: true }),
      JSON.stringify({ schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision: 1, attestations: 'nope' }),
    ]) {
      await fs.writeFile(target, bytes);
      expect(await adapter.read()).toEqual({ status: 'unreadable' });
      expect(await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) })).toEqual({
        outcome: 'refused',
        reason: 'unreadable',
      });
      expect(await fs.readFile(target, 'utf8')).toBe(bytes);
    }
    expect(
      (await fs.readdir(tempDir)).filter(
        (name) => name !== 'cutover-shadow-attestations.json' && !name.endsWith('.lock'),
      ),
    ).toEqual([]);
  });

  it('refuses a symlinked store as unreadable, never as missing', async () => {
    const real = path.join(tempDir, 'elsewhere.json');
    await fs.writeFile(real, JSON.stringify(attestationLedger(1)));
    await fs.symlink(real, target);
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    expect(await adapter.read()).toEqual({ status: 'unreadable' });
    expect(await adapter.compareAndSet({ expectedRevision: 1, next: attestationLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
  });

  it('refuses a file over the size cap as unreadable', async () => {
    await fs.writeFile(target, 'x'.repeat(SHADOW_ATTESTATION_MAX_BYTES + 1));
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    expect(await adapter.read()).toEqual({ status: 'unreadable' });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) })).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
    expect((await fs.stat(target)).size).toBe(SHADOW_ATTESTATION_MAX_BYTES + 1);
  });

  it('refuses every write when opened read-only and still reads', async () => {
    const writable = new ShadowAttestationAdapter({ stateDir: tempDir });
    await writable.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
    const before = await fs.readFile(target, 'utf8');
    const readOnly = new ShadowAttestationAdapter({ stateDir: tempDir, readOnly: true });
    expect(await readOnly.read()).toEqual({ status: 'ok', ledger: attestationLedger(1) });
    expect(await readOnly.compareAndSet({ expectedRevision: 1, next: attestationLedger(2) })).toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
    expect(await readOnly.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) })).toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('refuses a deadlineIso already in the past before any file I/O', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir, nowIso: () => '2026-11-16T12:00:00.000Z' });
    expect(
      await adapter.compareAndSet({
        expectedRevision: 0,
        next: attestationLedger(1),
        deadlineIso: '2026-11-16T11:00:00.000Z',
      }),
    ).toEqual({ outcome: 'refused', reason: 'deadline-exceeded' });
    expect(await fs.access(target).then(() => true, () => false)).toBe(false);
    expect(await adapter.read({ deadlineIso: '2026-11-16T11:00:00.000Z' })).toEqual({ status: 'unreadable' });
    await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
    const before = await fs.readFile(target, 'utf8');
    expect(
      await adapter.compareAndSet({
        expectedRevision: 1,
        next: attestationLedger(2),
        deadlineIso: '2026-11-16T11:00:00.000Z',
      }),
    ).toEqual({ outcome: 'refused', reason: 'deadline-exceeded' });
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });

  it('lets exactly one of two racing compare-and-set calls save, the other conflict', async () => {
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    const results = await Promise.all([
      adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) }),
      adapter.compareAndSet({ expectedRevision: 0, next: attestationLedgerWithOne(1) }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['conflict', 'saved']);
    const read = await adapter.read();
    expect(read.status).toBe('ok');
    expect((read as { ledger: ShadowAttestationLedger }).ledger.revision).toBe(1);
  });

  it.each([
    // Every name in ShadowAttestationAdapter's private OTHER_STORE_FILE_NAMES
    // list, spelled out here so dropping any one entry from that list fails
    // this test.
    'work-orders.json',
    'attempts.json',
    'journal.json',
    'reservations.json',
    'lane-runs.json',
    'run-journal.json',
    'conductor-driver-lease.json',
    'conductor-halt.json',
    'killall-halt.json',
    'killall-train-pause.json',
    'cutover.json',
    'cutover-journal.json',
    'merge-queue.json',
    'merge-records.json',
    'cutover-shadow.json',
  ])('refuses a file name that collides with another store (%s)', (fileName) => {
    expect(() => new ShadowAttestationAdapter({ stateDir: tempDir, fileName })).toThrow();
  });

  it.each(['../x.json', 'a/b.json', '', '.', '..'])('refuses an unsafe file name (%s)', (fileName) => {
    expect(() => new ShadowAttestationAdapter({ stateDir: tempDir, fileName })).toThrow();
  });

  it('accepts a safe file name that collides with no other store', () => {
    expect(() =>
      new ShadowAttestationAdapter({ stateDir: tempDir, fileName: 'cutover-shadow-attestations-alt.json' }),
    ).not.toThrow();
  });

  it('is described to `fleet-v2 state` as the single-record store cutover-shadow-attestations.json', async () => {
    const descriptor = WORK_EXECUTION_STATE_FILES.find(
      (entry) => entry.basename === 'cutover-shadow-attestations.json',
    );
    expect(descriptor).toBeDefined();
    expect(descriptor?.inspect(Buffer.from(JSON.stringify(attestationLedgerWithOne(1))))).toEqual({
      status: 'ok',
      recordCount: 1,
    });
    expect(
      descriptor?.inspect(
        Buffer.from(JSON.stringify({ ...attestationLedger(1), schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION + 1 })),
      ).status,
    ).toBe('unknown-version');
    expect(descriptor?.inspect(Buffer.from('{ nope')).status).toBe('unreadable');
    expect(descriptor?.inspect(Buffer.from('[]')).status).toBe('unreadable');
    const adapter = new ShadowAttestationAdapter({ stateDir: tempDir });
    await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedgerWithOne(1) });
    expect((await descriptor?.check(tempDir))?.result).toMatchObject({ status: 'ok', recordCount: 1 });
  });

  it('inspects through the domain reader readShadowAttestations', () => {
    expect(inspectSingleShadowAttestations(JSON.parse(JSON.stringify(attestationLedgerWithOne(1))))).toEqual({
      status: 'ok',
      record: attestationLedgerWithOne(1),
    });
    expect(
      inspectSingleShadowAttestations({
        schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION,
        revision: 1,
        attestations: [{ fact: 'no-such-fact' }],
      }).status,
    ).toBe('unreadable');
    // Not spied: the adapter imports `readShadowAttestations` as a static ESM
    // binding, so `vi.spyOn` on the module export cannot intercept the call.
    // Instead this input is distinctive to the domain reader: the facts are in
    // decreasing fact order (`SHADOW_ATTESTATION_FACTS` index must strictly
    // increase), a rule only `readShadowAttestations` enforces. An inline copy
    // in the adapter — plausibly checking only the fact names and record shape
    // — would accept this ledger and fail the test, so the inspection provably
    // goes through the domain reader.
    expect(
      inspectSingleShadowAttestations({
        schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION,
        revision: 1,
        attestations: [
          {
            fact: SHADOW_ATTESTATION_FACTS[2],
            observedDay: DAY,
            releaseSha: RELEASE_SHA,
            reason: 'ok',
            digest: DIGEST,
            recordedAtIso: '2026-02-03T00:00:00.000Z',
          },
          {
            fact: SHADOW_ATTESTATION_FACTS[0],
            observedDay: DAY,
            releaseSha: RELEASE_SHA,
            reason: 'ok',
            digest: DIGEST,
            recordedAtIso: '2026-02-04T00:00:00.000Z',
          },
        ],
      }).status,
    ).toBe('unreadable');
  });

  it('in-memory mode never touches the filesystem', async () => {
    // Every fs/promises function ShadowAttestationAdapter's code paths can reach:
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
      const adapter = new ShadowAttestationAdapter();
      expect(await adapter.read()).toEqual({ status: 'missing' });
      await adapter.compareAndSet({ expectedRevision: 0, next: attestationLedger(1) });
      expect(await adapter.read()).toEqual({ status: 'ok', ledger: attestationLedger(1) });
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
