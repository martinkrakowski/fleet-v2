import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OwnerItem,
  ownerItemMergeKey,
  type OwnerItemResult,
} from '../../../domain/entities/OwnerItem.js';
import type {
  OwnerItemBlockRecord,
  OwnerItemHistoryEntryRecord,
  OwnerItemRecord,
  OwnerItemRefRecord,
} from '../../../domain/owner-item-records.js';
import type { OwnerItemKindValue } from '../../../domain/value-objects/OwnerItemKind.vo.js';
import {
  OwnerItemKeyConflictError,
  OwnerItemRevisionConflictError,
} from '../../../application/ports/out/OwnerItemRepositoryPort.out-port.js';
import type {
  ChangeSignal,
  ChangeSignalPort,
} from '../../../application/ports/out/ChangeSignalPort.out-port.js';
import { StateFileUnreadableError } from '../file-store.js';
import {
  OwnerItemRepositoryAdapter,
  parseOwnerItemStateRecord,
} from '../OwnerItemRepositoryAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';

function prRef(number: number): OwnerItemRefRecord {
  return { kind: 'pr', repository: 'example-org/example-repo', number };
}

function questionRef(id: string): OwnerItemRefRecord {
  return { kind: 'question', id };
}

/** Narrow the domain result union; a genuine failure is a test bug. */
function mustSucceed(result: OwnerItemResult): OwnerItem {
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

interface OpenOverrides {
  itemId?: string;
  projectId?: string;
  kind?: OwnerItemKindValue;
  subject?: string | null;
  refs?: OwnerItemRefRecord[];
  blocks?: OwnerItemBlockRecord[];
  createdBy?: string;
  openedAtIso?: string;
}

/** Build a valid open item; overrides are spread onto the opened record. */
function openItem(overrides: OpenOverrides = {}): OwnerItemRecord {
  const result = OwnerItem.open(
    {
      itemId: overrides.itemId ?? 'oi-example-1',
      projectId: overrides.projectId ?? 'example-project',
      kind: overrides.kind ?? 'merge',
      subject: overrides.subject === undefined ? null : overrides.subject,
      refs: overrides.refs ?? [prRef(1)],
      blocks: overrides.blocks ?? [],
      createdBy: overrides.createdBy ?? 'example-orchestrator',
    },
    overrides.openedAtIso ?? NOW,
  );
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value.toRecord();
}

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly emitted: ChangeSignal[] = [];
  throwOnEmit = false;

  emit(signal: ChangeSignal): void {
    if (this.throwOnEmit) {
      throw new Error('signal emit failed on purpose');
    }
    this.emitted.push(signal);
  }
}

describe('OwnerItemRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-owner-item-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips saves in memory with revision arithmetic and conflict errors', async () => {
    const adapter = new OwnerItemRepositoryAdapter();
    const stored = await adapter.save(openItem(), 0);
    expect(stored).toEqual({ revision: 1, item: openItem() });
    expect(await adapter.get('oi-example-1')).toEqual(stored);

    const second = await adapter.save(openItem(), 1);
    expect(second.revision).toBe(2);

    try {
      await adapter.save(openItem(), 0);
      throw new Error('expected a revision conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OwnerItemRevisionConflictError);
      const conflict = error as OwnerItemRevisionConflictError;
      expect(conflict.itemId).toBe('oi-example-1');
      expect(conflict.attemptedRevision).toBe(1);
      expect(conflict.message).not.toContain('oi-example-1');
      expect(conflict.message).not.toContain('example-project');
    }

    expect(await adapter.get('missing')).toBeNull();
  });

  it('returns fresh copies that cannot mutate the store', async () => {
    const adapter = new OwnerItemRepositoryAdapter();
    await adapter.save(openItem(), 0);
    const listed = await adapter.list();
    (listed[0]!.item.refs as OwnerItemRefRecord[]).push(
      { kind: 'pr', repository: 'example-org/example-repo', number: 99 },
    );
    (listed[0]!.item.blocks as OwnerItemBlockRecord[]).push(
      { kind: 'lane', ref: 'lane-99' },
    );
    (listed[0]!.item.history as OwnerItemHistoryEntryRecord[]).push(
      { event: 'closed', atIso: '2026-10-27T12:00:00.000Z', reason: 'merged' },
    );
    const after = await adapter.get('oi-example-1');
    expect(after?.item.refs).toEqual([
      { kind: 'pr', repository: 'example-org/example-repo', number: 1 },
    ]);
    expect(after?.item.blocks).toEqual([]);
    expect(after?.item.history).toEqual([
      { event: 'opened', atIso: NOW, reason: null },
    ]);
  });

  it('persists to owner-items.json and reads it back with a fresh adapter', async () => {
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(openItem(), 0);

    const filePath = path.join(tempDir, 'owner-items.json');
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Array<{
      revision: number;
      item: OwnerItemRecord;
    }>;
    expect(parsed).toEqual([{ revision: 1, item: openItem() }]);

    const other = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    expect(await other.get('oi-example-1')).toEqual({ revision: 1, item: openItem() });

    const entries = await fs.readdir(tempDir);
    expect(entries.filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('refuses . and .. as a state file name', async () => {
    for (const fileName of ['.', '..']) {
      const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir, fileName });
      await expect(adapter.get('oi-example-1')).rejects.toThrow('OwnerItemRepositoryAdapter refuses unsafe state file name');
    }
  });

  it('keeps one item per natural key when two adapters save concurrently', async () => {
    const first = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    const second = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    const results = await Promise.allSettled([
      first.save(openItem({ itemId: 'oi-example-1' }), 0),
      second.save(openItem({ itemId: 'oi-example-2' }), 0),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(OwnerItemKeyConflictError);
    const reader = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    const held = [await reader.get('oi-example-1'), await reader.get('oi-example-2')].filter((item) => item !== null);
    expect(held).toHaveLength(1);
  });

  it('refuses a save whose natural key another item holds and writes nothing', async () => {
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(openItem(), 0);
    const filePath = path.join(tempDir, 'owner-items.json');
    const before = await fs.readFile(filePath, 'utf8');

    try {
      await adapter.save(openItem({ itemId: 'oi-example-2' }), 0);
      throw new Error('expected a key conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OwnerItemKeyConflictError);
      const conflict = error as OwnerItemKeyConflictError;
      expect(conflict.heldByItemId).toBe('oi-example-1');
      expect(conflict.message).not.toContain('oi-example-2');
    }
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);

    const current = (await adapter.get('oi-example-1'))!;
    await expect(adapter.save(openItem(), current.revision)).resolves.toMatchObject({
      revision: 2,
    });

    await adapter.save(openItem({ itemId: 'oi-example-2', refs: [prRef(2)] }), 0);

    await adapter.save(
      openItem({ itemId: 'oi-example-3', kind: 'decision', refs: [questionRef('q-example-1')] }),
      0,
    );
    try {
      await adapter.save(
        openItem({ itemId: 'oi-example-4', kind: 'decision', refs: [questionRef('q-example-1')] }),
        0,
      );
      throw new Error('expected a key conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OwnerItemKeyConflictError);
      expect((error as OwnerItemKeyConflictError).heldByItemId).toBe('oi-example-3');
    }

    const memoryAdapter = new OwnerItemRepositoryAdapter();
    await memoryAdapter.save(
      openItem({ itemId: 'oi-example-1', kind: 'decision', refs: [questionRef('q-example-1')] }),
      0,
    );
    try {
      await memoryAdapter.save(
        openItem({ itemId: 'oi-example-2', kind: 'decision', refs: [questionRef('q-example-1')] }),
        0,
      );
      throw new Error('expected a key conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OwnerItemKeyConflictError);
      expect((error as OwnerItemKeyConflictError).heldByItemId).toBe('oi-example-1');
    }
  });

  it('finds the item holding a natural key', async () => {
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(openItem(), 0);

    const key = ownerItemMergeKey('example-project', 'example-org/example-repo', 1);
    const found = await adapter.findByKey(key);
    expect(found?.item.itemId).toBe('oi-example-1');
    expect(await adapter.findByKey('["unknown"]')).toBeNull();
  });

  it('lists sorted by createdAtIso then id, and filters combine', async () => {
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(
      openItem({ itemId: 'oi-example-1', openedAtIso: '2026-10-27T10:00:00.000Z' }),
      0,
    );
    await adapter.save(
      openItem({ itemId: 'oi-example-2', kind: 'decision', refs: [questionRef('q-example-1')], openedAtIso: '2026-10-27T10:00:00.000Z' }),
      0,
    );
    const backup = mustSucceed(
      OwnerItem.open(
        {
          itemId: 'oi-example-3',
          projectId: 'another-project',
          kind: 'backup',
          subject: null,
          refs: [],
          blocks: [],
          createdBy: 'example-orchestrator',
        },
        '2026-10-27T09:00:00.000Z',
      ),
    );
    const closed = mustSucceed(
      backup.markDone({ via: 'cli', by: 'example-owner', atIso: '2026-10-27T11:00:00.000Z' }),
    ).toRecord();
    await adapter.save(closed, 0);

    const listed = await adapter.list();
    expect(listed.map((stored) => stored.item.itemId)).toEqual([
      'oi-example-3',
      'oi-example-1',
      'oi-example-2',
    ]);

    expect((await adapter.list({ projectId: 'another-project' })).map((stored) => stored.item.itemId)).toEqual([
      'oi-example-3',
    ]);
    expect((await adapter.list({ state: 'closed' })).map((stored) => stored.item.itemId)).toEqual([
      'oi-example-3',
    ]);
    expect((await adapter.list({ kind: 'decision' })).map((stored) => stored.item.itemId)).toEqual([
      'oi-example-2',
    ]);
    expect(
      (await adapter.list({ projectId: 'another-project', state: 'closed', kind: 'backup' })).map(
        (stored) => stored.item.itemId,
      ),
    ).toEqual(['oi-example-3']);
  });

  it('emits owner-item signals with file state for disk saves and nulls in memory', async () => {
    const signalPort = new RecordingChangeSignalPort();
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });

    await adapter.save(openItem(), 0);
    expect(signalPort.emitted).toHaveLength(1);
    expect(signalPort.emitted[0]).toMatchObject({
      kind: 'owner-item',
      id: 'oi-example-1',
      stateFile: path.resolve(path.join(tempDir, 'owner-items.json')),
      before: null,
    });
    expect(signalPort.emitted[0]!.written).not.toBeNull();

    const memoryPort = new RecordingChangeSignalPort();
    const memoryAdapter = new OwnerItemRepositoryAdapter({ changeSignal: memoryPort });
    await memoryAdapter.save(openItem(), 0);
    expect(memoryPort.emitted).toHaveLength(1);
    expect(memoryPort.emitted[0]).toEqual({
      kind: 'owner-item',
      id: 'oi-example-1',
      stateFile: null,
      before: null,
      written: null,
    });
  });

  it('keeps the save successful when a signal port throws', async () => {
    const signalPort = new RecordingChangeSignalPort();
    signalPort.throwOnEmit = true;
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });

    await adapter.save(openItem({ itemId: 'oi-throw' }), 0);
    expect(adapter.signalEmitFailures).toBe(1);
    expect((await adapter.get('oi-throw'))?.revision).toBe(1);
  });

  it('parses only plain { revision, item } entries and never throws', () => {
    expect(parseOwnerItemStateRecord(null)).toBeUndefined();
    expect(parseOwnerItemStateRecord([])).toBeUndefined();
    expect(parseOwnerItemStateRecord({ revision: 1 })).toBeUndefined();
    expect(parseOwnerItemStateRecord({ revision: 0, item: openItem() })).toBeUndefined();
    expect(parseOwnerItemStateRecord({ revision: 1.5, item: openItem() })).toBeUndefined();
    expect(parseOwnerItemStateRecord({ revision: 1, item: openItem(), extra: 1 })).toBeUndefined();
    expect(parseOwnerItemStateRecord({ revision: 1, item: { ...openItem(), kind: 'bogus' } })).toBeUndefined();
    expect(parseOwnerItemStateRecord({ revision: 1, item: { bogus: true } })).toBeUndefined();

    const withThrowingGetter: Record<string, unknown> = {};
    Object.defineProperty(withThrowingGetter, 'revision', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    Object.defineProperty(withThrowingGetter, 'item', { value: openItem(), enumerable: true });
    expect(parseOwnerItemStateRecord(withThrowingGetter)).toBeUndefined();

    expect(parseOwnerItemStateRecord({ revision: 1, item: openItem() })).toEqual({
      revision: 1,
      item: openItem(),
    });
  });

  it('quarantines a file holding one invalid entry', async () => {
    await fs.writeFile(
      path.join(tempDir, 'owner-items.json'),
      JSON.stringify([{ revision: 1 }]),
      'utf8',
    );
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries).toHaveLength(1);
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    for (const name of [
      'project-profiles.json',
      'coordination-requests.json',
      'owner-questions.json',
      'orchestrators.json',
    ]) {
      const colliding = new OwnerItemRepositoryAdapter({ stateDir: tempDir, fileName: name });
      await expect(colliding.list()).rejects.toThrow(/collides with another store/);
    }

    const escaping = new OwnerItemRepositoryAdapter({ stateDir: tempDir, fileName: '../x.json' });
    await expect(escaping.list()).rejects.toThrow(/unsafe state file name/);
  });

  it('refuses an expected revision whose successor would not be a safe integer', async () => {
    const adapter = new OwnerItemRepositoryAdapter();
    await expect(adapter.save(openItem(), Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      /expected revision must be a non-negative integer/,
    );
  });
});
