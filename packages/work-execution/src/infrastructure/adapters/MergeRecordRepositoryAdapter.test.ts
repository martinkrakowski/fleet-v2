import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MergeRecordRecord } from '../../domain/entities/MergeRecord.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import {
  MergeRecordRepositoryAdapter,
  mergeRecordListError,
  parseVersionedMergeRecordStateRecord,
} from './MergeRecordRepositoryAdapter.adapter.js';
import {
  FileLockTimeoutError,
  ReadOnlyStateStoreError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  StateFileUnknownVersionError,
} from './file-store.js';

const REFUSED = { outcome: 'refused', code: 'invalid' } as const;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly signals: ChangeSignal[] = [];

  emit(signal: ChangeSignal): void {
    this.signals.push(signal);
  }
}

function mergeRecord(overrides: Partial<MergeRecordRecord> = {}): MergeRecordRecord {
  return {
    schemaVersion: 1,
    repository: 'acme/app',
    number: 7,
    headSha: HEAD_A,
    mergedAtIso: '2026-11-05T10:00:00.000Z',
    firstSeenAtIso: '2026-11-05T10:01:00.000Z',
    source: 'forge-observation',
    merger: 'unknown',
    ...overrides,
  };
}

function fleetRecord(overrides: Partial<MergeRecordRecord> = {}): MergeRecordRecord {
  return mergeRecord({ source: 'fleet-forge-action', merger: 'fleet', actionRef: 'action-7', ...overrides });
}

function asRuntimeInput(value: unknown): MergeRecordRecord {
  return value as MergeRecordRecord;
}

describe('MergeRecordRepositoryAdapter', () => {
  let tempDir: string;
  let target: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-merge-record-test-'));
    target = path.join(tempDir, 'merge-records.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function readBytes(): Promise<string> {
    return fs.readFile(target, 'utf8');
  }

  describe('saves', () => {
    it('creates a record, finds it and lists it through a fresh store instance', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      const result = await store.saveMergeRecord(mergeRecord());
      expect(result).toEqual({ outcome: 'created', record: mergeRecord() });

      const fresh = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect(await fresh.findMergeRecord('acme/app', 7)).toEqual(mergeRecord());
      expect(await fresh.findMergeRecord('acme/app', 8)).toBeNull();
      expect(await fresh.listMergeRecords()).toEqual([mergeRecord()]);
      const onDisk = JSON.parse(await readBytes()) as Array<Record<string, unknown>>;
      expect(onDisk).toEqual([{ ...mergeRecord(), schemaVersion: 1 }]);
    });

    it('keeps one record per (repository, number) key and a second key beside it', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await store.saveMergeRecord(mergeRecord());
      await store.saveMergeRecord(mergeRecord({ number: 8 }));
      await store.saveMergeRecord(mergeRecord({ repository: 'acme/other' }));
      expect((await store.listMergeRecords()).map((r) => `${r.repository}#${r.number}`)).toEqual([
        'acme/app#7',
        'acme/app#8',
        'acme/other#7',
      ]);
    });

    it('accepts PR numbers above the old store cap, up to the domain maximum', async () => {
      const aboveOldCap = mergeRecord({ number: 1_000_001 });
      const domainMax = mergeRecord({ number: 999_999_999 });
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect((await store.saveMergeRecord(aboveOldCap)).outcome).toBe('created');
      expect((await store.saveMergeRecord(domainMax)).outcome).toBe('created');

      const fresh = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect(await fresh.findMergeRecord('acme/app', 1_000_001)).toEqual(aboveOldCap);
      expect(await fresh.findMergeRecord('acme/app', 999_999_999)).toEqual(domainMax);
      expect(await fresh.listMergeRecords()).toEqual([aboveOldCap, domainMax]);

      const memory = new MergeRecordRepositoryAdapter();
      expect((await memory.saveMergeRecord(aboveOldCap)).outcome).toBe('created');
      expect(await memory.findMergeRecord('acme/app', 1_000_001)).toEqual(aboveOldCap);
    });

    it('reports a conflicting sighting as an integrity conflict carrying the stored record and writes nothing', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await store.saveMergeRecord(mergeRecord());
      const before = await readBytes();

      const differentHead = await store.saveMergeRecord(mergeRecord({ headSha: HEAD_B }));
      const differentTime = await store.saveMergeRecord(mergeRecord({ mergedAtIso: '2026-11-05T12:00:00.000Z' }));

      expect(differentHead).toEqual({ outcome: 'integrity-conflict', record: mergeRecord() });
      expect(differentTime).toEqual({ outcome: 'integrity-conflict', record: mergeRecord() });
      expect(await readBytes()).toBe(before);
    });

    it('upgrades merger from unknown to fleet once, keeps every other stored field, and never downgrades', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await store.saveMergeRecord(mergeRecord());

      const upgraded = await store.saveMergeRecord(
        fleetRecord({ firstSeenAtIso: '2026-11-05T13:00:00.000Z' }),
      );
      expect(upgraded).toEqual({ outcome: 'merger-upgraded', record: mergeRecord({ merger: 'fleet' }) });
      expect(await store.findMergeRecord('acme/app', 7)).toEqual(mergeRecord({ merger: 'fleet' }));

      const afterUpgrade = await readBytes();
      const downgrade = await store.saveMergeRecord(mergeRecord());
      const again = await store.saveMergeRecord(fleetRecord());
      expect(downgrade).toEqual({ outcome: 'unchanged', record: mergeRecord({ merger: 'fleet' }) });
      expect(again).toEqual({ outcome: 'unchanged', record: mergeRecord({ merger: 'fleet' }) });
      expect(await readBytes()).toBe(afterUpgrade);
    });

    it('refuses a write that did not come from the decision: a forge-observation/fleet record for a new key', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      const result = await store.saveMergeRecord(mergeRecord({ merger: 'fleet' }));
      expect(result).toEqual(REFUSED);
      await expect(fs.stat(target)).rejects.toThrow();

      const memory = new MergeRecordRepositoryAdapter();
      expect(await memory.saveMergeRecord(mergeRecord({ merger: 'fleet' }))).toEqual(REFUSED);
      expect(await memory.listMergeRecords()).toEqual([]);
    });

    it('refuses a stored fleet-forge-action/unknown record as unreadable and never decides against it', async () => {
      const stored = { ...mergeRecord(), source: 'fleet-forge-action', merger: 'unknown' };
      await fs.writeFile(target, JSON.stringify([stored]));
      const before = await readBytes();
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });

      expect(parseVersionedMergeRecordStateRecord(stored)).toEqual({ status: 'invalid' });
      await expect(store.listMergeRecords()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expect(store.saveMergeRecord(fleetRecord())).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expect(fs.readFile(path.join(tempDir, 'merge-records.json.lock'))).rejects.toThrow();
      expect(JSON.parse(before)).toEqual([stored]);
    });

    it('accepts a stored forge-observation/fleet record: the upgraded shape is a valid stored record', async () => {
      await fs.writeFile(target, JSON.stringify([mergeRecord({ merger: 'fleet' })]));
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect(await store.listMergeRecords()).toEqual([mergeRecord({ merger: 'fleet' })]);
      expect(await store.saveMergeRecord(fleetRecord())).toEqual({
        outcome: 'unchanged',
        record: mergeRecord({ merger: 'fleet' }),
      });
    });

    it('works in memory mode with the same outcomes', async () => {
      const store = new MergeRecordRepositoryAdapter();
      expect((await store.saveMergeRecord(mergeRecord())).outcome).toBe('created');
      expect((await store.saveMergeRecord(mergeRecord())).outcome).toBe('unchanged');
      expect((await store.saveMergeRecord(mergeRecord({ headSha: HEAD_B }))).outcome).toBe('integrity-conflict');
      expect((await store.saveMergeRecord(fleetRecord())).outcome).toBe('merger-upgraded');
      expect(await store.findMergeRecord('acme/app', 7)).toEqual(mergeRecord({ merger: 'fleet' }));
      expect(await store.findMergeRecord('acme/app', 9)).toBeNull();
      expect(await store.listMergeRecords()).toEqual([mergeRecord({ merger: 'fleet' })]);
    });

    it('a read-only store refuses every write and writes nothing', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir, readOnly: true });
      await expect(store.saveMergeRecord(mergeRecord())).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
      await expect(fs.stat(target)).rejects.toThrow();
    });

    it('a read-only store reads an unreadable file without quarantine', async () => {
      await fs.writeFile(target, '{ not json');
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir, readOnly: true });
      await expect(store.listMergeRecords()).rejects.toBeInstanceOf(StateFileUnreadableReadOnlyError);
      await expect(fs.stat(path.join(tempDir, 'quarantine'))).rejects.toThrow();
    });
  });

  describe('change signal', () => {
    it('emits a merge signal after a written save only, with the stats taken inside the lock', async () => {
      const port = new RecordingChangeSignalPort();
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir, changeSignal: port });

      await store.saveMergeRecord(mergeRecord());
      expect(port.signals).toHaveLength(1);
      expect(port.signals[0]).toMatchObject({
        kind: 'merge',
        id: 'acme/app#7',
        stateFile: path.resolve(target),
        before: null,
      });
      expect(port.signals[0]!.written).not.toBeNull();

      await store.saveMergeRecord(mergeRecord());
      await store.saveMergeRecord(mergeRecord({ headSha: HEAD_B }));
      expect(port.signals).toHaveLength(1);

      await store.saveMergeRecord(fleetRecord());
      expect(port.signals).toHaveLength(2);
      expect(port.signals[1]!.before).not.toBeNull();
    });

    it('emits with a null state file in memory mode', async () => {
      const port = new RecordingChangeSignalPort();
      const store = new MergeRecordRepositoryAdapter({ changeSignal: port });
      await store.saveMergeRecord(mergeRecord());
      expect(port.signals).toEqual([
        { kind: 'merge', id: 'acme/app#7', stateFile: null, before: null, written: null },
      ]);
    });

    it('a failing signal never fails the save and is counted', async () => {
      const store = new MergeRecordRepositoryAdapter({
        stateDir: tempDir,
        changeSignal: {
          emit() {
            throw new Error('observer down');
          },
        },
      });
      expect((await store.saveMergeRecord(mergeRecord())).outcome).toBe('created');
      expect(store.signalEmitFailures).toBe(1);
      expect(await store.listMergeRecords()).toEqual([mergeRecord()]);
    });
  });

  describe('runtime input', () => {
    async function expectRefusedWithoutWrite(input: unknown): Promise<void> {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      const result = await store.saveMergeRecord(asRuntimeInput(input));
      expect(result).toEqual(REFUSED);
      await expect(fs.stat(target)).rejects.toThrow();
      const memory = new MergeRecordRepositoryAdapter();
      expect(await memory.saveMergeRecord(asRuntimeInput(input))).toEqual(REFUSED);
      expect(await memory.listMergeRecords()).toEqual([]);
    }

    it('refuses a null or non-object record without throwing', async () => {
      for (const input of [null, undefined, 'record', 7, [mergeRecord()]]) {
        await expectRefusedWithoutWrite(input);
      }
    });

    it('refuses a record with a missing field', async () => {
      for (const field of ['repository', 'number', 'headSha', 'mergedAtIso', 'firstSeenAtIso', 'source', 'merger']) {
        const input: Record<string, unknown> = { ...mergeRecord() };
        delete input[field];
        await expectRefusedWithoutWrite(input);
      }
    });

    it('refuses a record with a wrong-typed field', async () => {
      for (const [field, value] of [
        ['repository', 7],
        ['number', '7'],
        ['number', 7.5],
        ['headSha', null],
        ['mergedAtIso', 1_762_336_800_000],
        ['firstSeenAtIso', {}],
        ['actionRef', 12],
      ] as const) {
        await expectRefusedWithoutWrite({ ...fleetRecord(), [field]: value });
      }
    });

    it('refuses a record whose schemaVersion is not the store version', async () => {
      // The runtime input may carry a `schemaVersion` the port's type cannot
      // express: an unsupported version is refused, never rewritten as 1.
      await expectRefusedWithoutWrite(asRuntimeInput({ ...mergeRecord(), schemaVersion: 2 }));
      await expectRefusedWithoutWrite(asRuntimeInput({ ...mergeRecord(), schemaVersion: 0 }));
    });

    it('refuses an unknown source or merger value', async () => {
      await expectRefusedWithoutWrite({ ...mergeRecord(), source: 'webhook' });
      await expectRefusedWithoutWrite({ ...mergeRecord(), merger: 'human' });
      await expectRefusedWithoutWrite({ ...mergeRecord(), source: 'fleet-forge-action', merger: 'unknown' });
    });

    it('refuses a record that is not a canonical UTC timestamp or a lowercase sha', async () => {
      await expectRefusedWithoutWrite({ ...mergeRecord(), mergedAtIso: '2026-11-05 10:00:00' });
      await expectRefusedWithoutWrite({ ...mergeRecord(), firstSeenAtIso: '2026-02-30T10:00:00.000Z' });
      await expectRefusedWithoutWrite({ ...mergeRecord(), headSha: 'NOT-A-SHA' });
    });

    it('refuses a record whose getter throws without throwing', async () => {
      const input = { ...mergeRecord() } as Record<string, unknown>;
      Object.defineProperty(input, 'headSha', {
        enumerable: true,
        get() {
          throw new Error('hostile getter');
        },
      });
      await expectRefusedWithoutWrite(input);
    });

    it('refuses a record whose fields exceed the schema bounds', async () => {
      await expectRefusedWithoutWrite({ ...mergeRecord(), repository: 'a'.repeat(201) });
      await expectRefusedWithoutWrite({ ...mergeRecord(), headSha: 'a'.repeat(65) });
      await expectRefusedWithoutWrite({ ...fleetRecord(), actionRef: 'x'.repeat(201) });
      await expectRefusedWithoutWrite({ ...mergeRecord(), number: 0 });
      await expectRefusedWithoutWrite({ ...mergeRecord(), number: 1_000_000_000 });
    });

    it('the refusal carries a code only: the rejected value and the store path never appear in the outcome', async () => {
      const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      const result = await store.saveMergeRecord(mergeRecord({ headSha: secret }));
      expect(result).toEqual(REFUSED);
      expect(Object.keys(result).sort()).toEqual(['code', 'outcome']);
      const text = JSON.stringify(result);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(tempDir);

      const secretRef = await store.saveMergeRecord(fleetRecord({ actionRef: secret }));
      expect(secretRef).toEqual(REFUSED);
      expect(JSON.stringify(secretRef)).not.toContain(secret);
    });
  });

  describe('locking, atomicity and idempotence', () => {
    it('a store lock timeout refuses the write and leaves the store unchanged so the next pass completes', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await store.saveMergeRecord(mergeRecord());
      const before = await readBytes();

      const lockPath = path.join(tempDir, 'merge-records.json.lock');
      await fs.writeFile(lockPath, 'other-holder-token');
      const started = Date.now();
      await expect(store.saveMergeRecord(mergeRecord({ number: 8 }))).rejects.toBeInstanceOf(FileLockTimeoutError);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await readBytes()).toBe(before);

      await fs.unlink(lockPath);
      expect((await store.saveMergeRecord(mergeRecord({ number: 8 }))).outcome).toBe('created');
      expect(await store.listMergeRecords()).toHaveLength(2);
    }, 30_000);

    it('a repeated identical sighting is unchanged and writes nothing', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect((await store.saveMergeRecord(mergeRecord())).outcome).toBe('created');
      const before = await readBytes();
      const statBefore = await fs.stat(target);

      const renameSpy = vi.spyOn(fs, 'rename');
      const second = await store.saveMergeRecord(mergeRecord());
      const later = await store.saveMergeRecord(mergeRecord({ firstSeenAtIso: '2026-11-06T00:00:00.000Z' }));

      expect(second).toEqual({ outcome: 'unchanged', record: mergeRecord() });
      expect(later).toEqual({ outcome: 'unchanged', record: mergeRecord() });
      expect(renameSpy).not.toHaveBeenCalled();
      expect(await readBytes()).toBe(before);
      expect((await fs.stat(target)).ino).toBe(statBefore.ino);
    });

    it('a failed write leaves the previous store bytes unchanged and the next save completes', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await store.saveMergeRecord(mergeRecord());
      const before = await readBytes();

      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
      await expect(store.saveMergeRecord(mergeRecord({ number: 8 }))).rejects.toThrow('disk full');

      expect(await readBytes()).toBe(before);
      const fresh = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect(await fresh.listMergeRecords()).toEqual([mergeRecord()]);

      expect((await store.saveMergeRecord(mergeRecord({ number: 8 }))).outcome).toBe('created');
      expect(await fresh.findMergeRecord('acme/app', 8)).toEqual(mergeRecord({ number: 8 }));
    });

    it('the store file is replaced atomically: no temporary file is left behind and the bytes are always a complete record list', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      for (let number = 1; number <= 5; number += 1) {
        await store.saveMergeRecord(mergeRecord({ number }));
        const parsed = JSON.parse(await readBytes()) as unknown[];
        expect(parsed).toHaveLength(number);
      }
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('crash before rename'));
      await expect(store.saveMergeRecord(mergeRecord({ number: 6 }))).rejects.toThrow();
      expect(JSON.parse(await readBytes()) as unknown[]).toHaveLength(5);
      expect(await fs.readdir(tempDir)).toEqual(['merge-records.json']);
    });

    it('concurrent saves of one key keep exactly one record', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      const results = await Promise.all([
        store.saveMergeRecord(mergeRecord()),
        store.saveMergeRecord(mergeRecord()),
        store.saveMergeRecord(mergeRecord()),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'unchanged', 'unchanged']);
      expect(await store.listMergeRecords()).toEqual([mergeRecord()]);
    });
  });

  describe('unknown stays unknown', () => {
    it('an unreadable store is reported as unreadable, never as empty', async () => {
      await fs.writeFile(target, '{ not json');
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await expect(store.listMergeRecords()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expect(store.findMergeRecord('acme/app', 7)).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expect(store.saveMergeRecord(mergeRecord())).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expect(store.listMergeRecords()).rejects.not.toBeUndefined();
    });

    it('a store with two records for one key is unreadable, with the same detail the state check reports', async () => {
      await fs.writeFile(target, JSON.stringify([mergeRecord(), mergeRecord({ headSha: HEAD_B })]));
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      const error = await store.listMergeRecords().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StateFileUnreadableError);
      expect((error as StateFileUnreadableError).detail).toBe('conflicting stored record for acme/app#7');
      expect(mergeRecordListError([mergeRecord(), mergeRecord({ number: 8 })])).toBeUndefined();
      expect(mergeRecordListError([mergeRecord(), mergeRecord({ headSha: HEAD_B })])).toBe(
        'conflicting stored record for acme/app#7',
      );
    });

    it('an unknown schemaVersion is reported without quarantining', async () => {
      await fs.writeFile(target, JSON.stringify([{ ...mergeRecord(), schemaVersion: 2 }]));
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      await expect(store.listMergeRecords()).rejects.toBeInstanceOf(StateFileUnknownVersionError);
      await expect(store.saveMergeRecord(mergeRecord({ number: 9 }))).rejects.toBeInstanceOf(
        StateFileUnknownVersionError,
      );
      await expect(fs.stat(path.join(tempDir, 'quarantine'))).rejects.toThrow();
    });

    it('a missing store reads as known absence', async () => {
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect(await store.findMergeRecord('acme/app', 7)).toBeNull();
      expect(await store.listMergeRecords()).toEqual([]);
    });

    it('reads an absent schemaVersion as 1', async () => {
      const withoutVersion: Record<string, unknown> = { ...mergeRecord() };
      delete withoutVersion.schemaVersion;
      await fs.writeFile(target, JSON.stringify([withoutVersion]));
      const store = new MergeRecordRepositoryAdapter({ stateDir: tempDir });
      expect(await store.listMergeRecords()).toEqual([mergeRecord()]);
    });
  });
});
