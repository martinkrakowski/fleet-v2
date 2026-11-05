import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeRecordListStore, describeVersionedRecordListStore } from './file-store.js';
import type { StateFileDescriptor, VersionedRecordParseResult } from './file-store.js';

function trivialParseRecord(raw: unknown): { id: string } | undefined {
  if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
    return { id: (raw as { id: string }).id };
  }
  return undefined;
}

function record(id: string): { id: string } {
  return { id };
}

function storeBytes(records: Array<{ id: string }>): Buffer {
  return Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('state file compaction', () => {
  let tempDir: string;
  let descriptor: StateFileDescriptor;
  const dataPath = 'data.json';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-file-store-compaction-test-'));
    descriptor = describeRecordListStore(dataPath, trivialParseRecord);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seed(records: Array<{ id: string }>): Promise<Buffer> {
    const bytes = storeBytes(records);
    await fs.writeFile(path.join(tempDir, dataPath), bytes);
    return bytes;
  }

  async function quarantineCopies(): Promise<string[]> {
    return (await fs.readdir(path.join(tempDir, 'quarantine'))).filter((name) => name.startsWith(`${dataPath}.`));
  }

  it('keeps the pre-compaction bytes as a quarantine copy and swaps the compacted file in', async () => {
    const original = await seed([record('a'), record('b'), record('c')]);
    const outcome = await descriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a', 'b'],
      expectedCurrentSha256: sha256(original),
    });

    expect(outcome.status).toBe('compacted');
    if (outcome.status === 'compacted') {
      expect(outcome.beforeCount).toBe(3);
      expect(outcome.afterCount).toBe(2);
      expect(outcome.quarantinePath).toBeTruthy();
    }

    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(storeBytes([record('a'), record('b')]));

    const copies = await quarantineCopies();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^data\.json\.\d{8}T\d{6}\.\d{3}Z-\d+\.[0-9a-f]{12}$/);
    const quarantined = await fs.readFile(path.join(tempDir, 'quarantine', copies[0]));
    expect(sha256(quarantined)).toBe(sha256(original));
  });

  it('never writes through a pre-existing <store>.compacted symlink (EX-3b review minor)', async () => {
    const original = await seed([record('a'), record('b'), record('c')]);
    const victim = path.join(tempDir, 'unrelated.txt');
    await fs.writeFile(victim, 'keep me\n');
    await fs.symlink(victim, path.join(tempDir, `${dataPath}.compacted`));
    const outcome = await descriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a', 'b'],
      expectedCurrentSha256: sha256(original),
    });
    expect(outcome.status).toBe('compacted');
    expect(await fs.readFile(victim, 'utf8')).toBe('keep me\n');
    expect(await fs.readFile(path.join(tempDir, dataPath))).toEqual(storeBytes([record('a'), record('b')]));
  });

  it('refuses and writes nothing when the quarantine directory is a symlink (EX-3b pre-merge major)', async () => {
    const original = await seed([record('a'), record('b'), record('c')]);
    const elsewhere = path.join(tempDir, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, path.join(tempDir, 'quarantine'));
    const outcome = await descriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a', 'b'],
      expectedCurrentSha256: sha256(original),
    });
    expect(outcome.status).toBe('refused');
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect(await fs.readFile(path.join(tempDir, dataPath))).toEqual(original);
  });

  it('writes nothing when the store changed since the plan was computed', async () => {
    const original = await seed([record('a'), record('b'), record('c')]);
    const outcome = await descriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a'],
      expectedCurrentSha256: sha256(storeBytes([record('a'), record('b')])),
    });

    expect(outcome.status).toBe('refused');
    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(original);
    await expect(fs.access(path.join(tempDir, 'quarantine'))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, `${dataPath}.compacted`))).rejects.toThrow();
  });

  it('writes nothing when the compacted file does not verify', async () => {
    const strictDescriptor = describeRecordListStore(
      dataPath,
      trivialParseRecord,
      (records) => (records.length < 3 ? 'a valid store holds at least three records' : undefined),
    );
    const original = await seed([record('a'), record('b'), record('c')]);
    const outcome = await strictDescriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a', 'b'],
      expectedCurrentSha256: sha256(original),
    });

    expect(outcome.status).toBe('refused');
    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(original);
    await expect(fs.access(path.join(tempDir, 'quarantine'))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, `${dataPath}.compacted`))).rejects.toThrow();
  });

  it('writes nothing when a record has no id', async () => {
    const raw = Buffer.from(`${JSON.stringify([{ id: 'a' }, { value: 1 }], null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(tempDir, dataPath), raw);
    const outcome = await descriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a'],
      expectedCurrentSha256: sha256(raw),
    });

    expect(outcome.status).toBe('refused');
    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(raw);
  });

  it('leaves a store with nothing to remove untouched', async () => {
    const original = await seed([record('a'), record('b')]);
    const outcome = await descriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a', 'b'],
      expectedCurrentSha256: sha256(original),
    });

    expect(outcome.status).toBe('unchanged');
    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(original);
    await expect(fs.access(path.join(tempDir, 'quarantine'))).rejects.toThrow();
  });

  it('keeps only the last five quarantine copies', async () => {
    for (let i = 0; i < 6; i += 1) {
      const records = [record(`a${i}`), record('b'), record('c')];
      const bytes = storeBytes(records);
      await fs.writeFile(path.join(tempDir, dataPath), bytes);
      const outcome = await descriptor.compact!({
        stateDir: tempDir,
        keepIds: [`a${i}`, 'b'],
        expectedCurrentSha256: sha256(bytes),
      });
      expect(outcome.status).toBe('compacted');
    }

    expect(await quarantineCopies()).toHaveLength(5);
  });

  it('writes nothing when the store has an unsupported schemaVersion', async () => {
    const versionedDescriptor = describeVersionedRecordListStore(
      dataPath,
      (raw): VersionedRecordParseResult<{ id: string }> => {
        if (typeof raw !== 'object' || raw === null) {
          return { status: 'invalid' };
        }
        const obj = raw as { id?: unknown; schemaVersion?: unknown };
        if (obj.schemaVersion !== 1) {
          return { status: 'unknown-version' };
        }
        if (typeof obj.id === 'string' && obj.id.length > 0) {
          return { status: 'ok', record: { id: obj.id }, schemaVersion: 1 };
        }
        return { status: 'invalid' };
      },
    );
    const raw = Buffer.from(
      `${JSON.stringify([{ id: 'a', schemaVersion: 1 }, { id: 'b', schemaVersion: 99 }], null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(path.join(tempDir, dataPath), raw);
    const outcome = await versionedDescriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a'],
      expectedCurrentSha256: sha256(raw),
    });

    expect(outcome.status).toBe('refused');
    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(raw);
    await expect(fs.access(path.join(tempDir, 'quarantine'))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, `${dataPath}.compacted`))).rejects.toThrow();
  });

  it('writes nothing when a record is invalid but still has an id', async () => {
    const strictDescriptor = describeRecordListStore(
      dataPath,
      (raw) =>
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { id?: unknown }).id === 'string' &&
        typeof (raw as { kind?: unknown }).kind === 'string'
          ? { id: (raw as { id: string }).id }
          : undefined,
    );
    const raw = Buffer.from(
      `${JSON.stringify([{ id: 'a', kind: 'x' }, { id: 'b' }], null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(path.join(tempDir, dataPath), raw);
    const outcome = await strictDescriptor.compact!({
      stateDir: tempDir,
      keepIds: ['a'],
      expectedCurrentSha256: sha256(raw),
    });

    expect(outcome.status).toBe('refused');
    const finalBytes = await fs.readFile(path.join(tempDir, dataPath));
    expect(finalBytes).toEqual(raw);
    await expect(fs.access(path.join(tempDir, 'quarantine'))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, `${dataPath}.compacted`))).rejects.toThrow();
  });
});
