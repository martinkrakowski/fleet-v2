import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AttentionItem,
  attentionItemKey,
  type AttentionItemResult,
} from '../../../domain/entities/AttentionItem.js';
import type {
  AttentionItemRecord,
  AttentionItemSubjectRecord,
} from '../../../domain/attention-item-records.js';
import {
  AttentionItemKeyConflictError,
  AttentionItemRevisionConflictError,
} from '../../../application/ports/out/AttentionItemRepositoryPort.out-port.js';
import type {
  ChangeSignal,
  ChangeSignalPort,
} from '../../../application/ports/out/ChangeSignalPort.out-port.js';
import { StateFileUnreadableError } from '../file-store.js';
import {
  AttentionItemRepositoryAdapter,
  parseAttentionItemStateRecord,
} from '../AttentionItemRepositoryAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';

/** Narrow the domain result union; a genuine failure is a test bug. */
function mustSucceed(result: AttentionItemResult): AttentionItem {
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

interface RaiseOverrides {
  itemId?: string;
  projectId?: string;
  kind?: string;
  subject?: AttentionItemSubjectRecord;
  workOrderId?: string | null;
  summary?: string;
  raisedBy?: string;
}

/** Build a valid first raise; overrides replace the defaults. */
function raiseItem(overrides: RaiseOverrides = {}): AttentionItemRecord {
  return mustSucceed(
    AttentionItem.raise(
      {
        itemId: overrides.itemId ?? 'att-example-1',
        projectId: overrides.projectId ?? 'example-project',
        kind: overrides.kind ?? 'needs-owner',
        subject: overrides.subject ?? { kind: 'work-order', ref: 'wo-example-1' },
        workOrderId: overrides.workOrderId === undefined ? 'wo-example-1' : overrides.workOrderId,
        summary: overrides.summary ?? 'example notice',
        raisedBy: overrides.raisedBy ?? 'example-orchestrator',
      },
      NOW,
    ),
  ).toRecord();
}

/** A later raise for the same key, as the raise use case will build it. */
function raisedAgain(item: AttentionItemRecord, nowIso: string): AttentionItemRecord {
  return mustSucceed(
    mustSucceed(AttentionItem.create(item)).raiseAgain(
      {
        kind: item.kind,
        subject: item.subject,
        workOrderId: item.workOrderId,
        summary: item.summary,
        raisedBy: item.raisedBy,
      },
      nowIso,
    ),
  ).toRecord();
}

/** A clearance, as the dismiss use case will build it. */
function cleared(item: AttentionItemRecord, nowIso: string): AttentionItemRecord {
  return mustSucceed(
    mustSucceed(AttentionItem.create(item)).clear(
      { reason: 'dismissed', via: 'cli', by: 'example-owner' },
      nowIso,
    ),
  ).toRecord();
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

describe('AttentionItemRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attention-item-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips saves in memory at revision 1 and returns fresh copies', async () => {
    const adapter = new AttentionItemRepositoryAdapter();
    const stored = await adapter.save(raiseItem(), 0);
    expect(stored).toEqual({ revision: 1, item: raiseItem() });
    expect(await adapter.get('att-example-1')).toEqual(stored);
    expect(await adapter.get('missing')).toBeNull();

    const key = attentionItemKey('example-project', { kind: 'work-order', ref: 'wo-example-1' }, 'needs-owner');
    expect(await adapter.findByKey(key)).toEqual(stored);

    const listed = await adapter.list();
    (listed[0]!.item.subject as { ref: string }).ref = 'wo-example-9';
    (listed[0]!.item as { clearance: AttentionItemRecord['clearance'] }).clearance = {
      reason: 'dismissed', via: 'cli', by: 'example-owner', atIso: NOW,
    };
    const after = await adapter.get('att-example-1');
    expect(after?.item.subject).toEqual({ kind: 'work-order', ref: 'wo-example-1' });
    expect(after?.item.clearance).toBeNull();
  });

  it('refuses a stale expected revision and writes nothing', async () => {
    const adapter = new AttentionItemRepositoryAdapter();
    await adapter.save(raiseItem(), 0);
    try {
      await adapter.save(raiseItem(), 0);
      throw new Error('expected a revision conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AttentionItemRevisionConflictError);
      const conflict = error as AttentionItemRevisionConflictError;
      expect(conflict.itemId).toBe('att-example-1');
      expect(conflict.attemptedRevision).toBe(1);
      expect(conflict.message).not.toContain('att-example-1');
    }
    expect((await adapter.get('att-example-1'))?.revision).toBe(1);
  });

  it('keeps one item per key: a second item with the same key is refused, another subject kind or kind is accepted', async () => {
    const adapter = new AttentionItemRepositoryAdapter();
    await adapter.save(raiseItem(), 0);
    try {
      await adapter.save(raiseItem({ itemId: 'att-example-2' }), 0);
      throw new Error('expected a key conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AttentionItemKeyConflictError);
      const conflict = error as AttentionItemKeyConflictError;
      expect(conflict.heldByItemId).toBe('att-example-1');
      expect(conflict.itemId).toBe('att-example-2');
      expect(conflict.message).not.toContain('att-example-2');
    }
    await adapter.save(
      raiseItem({ itemId: 'att-example-3', subject: { kind: 'run', ref: 'run-01JB0000000000000000000000' }, workOrderId: null }),
      0,
    );
    await adapter.save(raiseItem({ itemId: 'att-example-4', kind: 'merge-integrity' }), 0);
    expect((await adapter.list()).map((stored) => stored.item.itemId)).toEqual([
      'att-example-1',
      'att-example-3',
      'att-example-4',
    ]);
  });

  it('refuses to change the key of an existing item and leaves it unchanged', async () => {
    const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(raiseItem(), 0);
    const filePath = path.join(tempDir, 'attention-items.json');
    const before = await fs.readFile(filePath, 'utf8');
    try {
      await adapter.save(raiseItem({ kind: 'merge-integrity' }), 1);
      throw new Error('expected a key change refusal');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('refuses to change the key of an existing item');
    }
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect(await adapter.get('att-example-1')).toEqual({ revision: 1, item: raiseItem() });
  });

  it('persists raise, raise again and clear, and a fresh adapter reads the latest revision', async () => {
    const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(raiseItem({ itemId: 'att-example-2', subject: { kind: 'run', ref: 'run-01JB0000000000000000000000' }, workOrderId: null }), 0);
    await adapter.save(raiseItem(), 0);
    const raised = raisedAgain(raiseItem(), '2026-10-27T11:00:00.000Z');
    await adapter.save(raised, 1);
    const clearedRecord = cleared(raised, '2026-10-27T12:00:00.000Z');
    await adapter.save(clearedRecord, 2);

    const filePath = path.join(tempDir, 'attention-items.json');
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Array<{
      revision: number;
      item: AttentionItemRecord;
    }>;
    expect(parsed.map((entry) => entry.item.itemId)).toEqual(['att-example-1', 'att-example-2']);
    expect(parsed[0]).toEqual({ revision: 3, item: clearedRecord });
    expect(parsed[1]).toEqual({ revision: 1, item: raiseItem({ itemId: 'att-example-2', subject: { kind: 'run', ref: 'run-01JB0000000000000000000000' }, workOrderId: null }) });

    const other = new AttentionItemRepositoryAdapter({ stateDir: tempDir });
    const readBack = await other.get('att-example-1');
    expect(readBack?.revision).toBe(3);
    expect(readBack?.item.state).toBe('cleared');
    expect(readBack?.item.raisedCount).toBe(2);

    const entries = await fs.readdir(tempDir);
    expect(entries.filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('lists sorted by firstRaisedAtIso then id, and all filters combine', async () => {
    const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir });
    // The first raise of att-example-1 is earlier: it sorts before the two items raised at NOW.
    const early = mustSucceed(
      AttentionItem.raise(
        {
          itemId: 'att-example-1',
          projectId: 'example-project',
          kind: 'needs-owner',
          subject: { kind: 'work-order', ref: 'wo-example-1' },
          workOrderId: 'wo-example-1',
          summary: 'example notice',
          raisedBy: 'example-orchestrator',
        },
        '2026-10-27T09:00:00.000Z',
      ),
    ).toRecord();
    await adapter.save(early, 0);
    await adapter.save(raiseItem({ itemId: 'att-example-2', subject: { kind: 'project', ref: 'example-project' }, workOrderId: null }), 0);
    await adapter.save(raiseItem({ itemId: 'att-example-3', subject: { kind: 'work-order', ref: 'wo-example-2' }, workOrderId: 'wo-example-2' }), 0);

    expect((await adapter.list()).map((stored) => stored.item.itemId)).toEqual([
      'att-example-1',
      'att-example-2',
      'att-example-3',
    ]);
    expect((await adapter.list({ projectId: 'example-project' })).length).toBe(3);
    expect((await adapter.list({ state: 'open' })).length).toBe(3);
    expect((await adapter.list({ kind: 'needs-owner' })).length).toBe(3);
    expect((await adapter.list({ workOrderId: 'wo-example-2' })).map((stored) => stored.item.itemId)).toEqual([
      'att-example-3',
    ]);
    expect((await adapter.list({ workOrderId: 'wo-example-1' })).map((stored) => stored.item.itemId)).toEqual([
      'att-example-1',
    ]);
    expect(
      (await adapter.list({ kind: 'needs-owner', workOrderId: 'wo-example-1', state: 'open', projectId: 'example-project' })).map(
        (stored) => stored.item.itemId,
      ),
    ).toEqual(['att-example-1']);
    expect((await adapter.list({ workOrderId: 'wo-example-9' }))).toEqual([]);
  });

  it('quarantines a file holding a malformed entry and never drops it silently', async () => {
    await fs.writeFile(
      path.join(tempDir, 'attention-items.json'),
      JSON.stringify([{ revision: 1 }]),
      'utf8',
    );
    const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
    await expect(adapter.get('att-example-1')).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries).toHaveLength(1);
  });

  it('quarantines a file holding two items with one key and never reads either', async () => {
    const first = raiseItem({ itemId: 'att-example-1' });
    const second = raiseItem({ itemId: 'att-example-2' });
    await fs.writeFile(
      path.join(tempDir, 'attention-items.json'),
      JSON.stringify([
        { revision: 1, item: first },
        { revision: 1, item: second },
      ]),
      'utf8',
    );
    const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
    await expect(adapter.get('att-example-1')).rejects.toBeInstanceOf(StateFileUnreadableError);
    const entries = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(entries).toHaveLength(1);
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    for (const name of ['owner-items.json', '../x']) {
      const unsafe = new AttentionItemRepositoryAdapter({ stateDir: tempDir, fileName: name });
      await expect(unsafe.list()).rejects.toThrow(
        name === '../x' ? /unsafe state file name/ : /collides with another store/,
      );
    }
    for (const fileName of ['.', '..']) {
      const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir, fileName });
      await expect(adapter.get('att-example-1')).rejects.toThrow('AttentionItemRepositoryAdapter refuses unsafe state file name');
    }
  });

  it('emits one attention-item signal per save with the file path on disk and null in memory', async () => {
    const signalPort = new RecordingChangeSignalPort();
    const adapter = new AttentionItemRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });

    await adapter.save(raiseItem(), 0);
    await adapter.save(raisedAgain(raiseItem(), '2026-10-27T11:00:00.000Z'), 1);
    expect(signalPort.emitted).toHaveLength(2);
    expect(signalPort.emitted[0]).toMatchObject({
      kind: 'attention-item',
      id: 'att-example-1',
      stateFile: path.resolve(path.join(tempDir, 'attention-items.json')),
      before: null,
    });
    expect(signalPort.emitted[0]!.written).not.toBeNull();

    const memoryPort = new RecordingChangeSignalPort();
    const memoryAdapter = new AttentionItemRepositoryAdapter({ changeSignal: memoryPort });
    await memoryAdapter.save(raiseItem(), 0);
    expect(memoryPort.emitted).toHaveLength(1);
    expect(memoryPort.emitted[0]).toEqual({
      kind: 'attention-item',
      id: 'att-example-1',
      stateFile: null,
      before: null,
      written: null,
    });

    signalPort.throwOnEmit = true;
    await adapter.save(cleared(raiseItem(), '2026-10-27T12:00:00.000Z'), 2);
    expect(adapter.signalEmitFailures).toBe(1);
    expect((await adapter.get('att-example-1'))?.item.state).toBe('cleared');
  });

  it('parses only plain { revision, item } entries and never throws', () => {
    expect(parseAttentionItemStateRecord(null)).toBeUndefined();
    expect(parseAttentionItemStateRecord([])).toBeUndefined();
    expect(parseAttentionItemStateRecord({ revision: 1 })).toBeUndefined();
    expect(parseAttentionItemStateRecord({ revision: 0, item: raiseItem() })).toBeUndefined();
    expect(parseAttentionItemStateRecord({ revision: 1.5, item: raiseItem() })).toBeUndefined();
    expect(parseAttentionItemStateRecord({ revision: 1, item: raiseItem(), extra: 1 })).toBeUndefined();
    expect(parseAttentionItemStateRecord({ revision: 1, item: { ...raiseItem(), kind: 'Needs Owner' } })).toBeUndefined();
    expect(parseAttentionItemStateRecord({ revision: 1, item: { bogus: true } })).toBeUndefined();

    const withThrowingGetter: Record<string, unknown> = {};
    Object.defineProperty(withThrowingGetter, 'revision', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    Object.defineProperty(withThrowingGetter, 'item', { value: raiseItem(), enumerable: true });
    expect(parseAttentionItemStateRecord(withThrowingGetter)).toBeUndefined();

    expect(parseAttentionItemStateRecord({ revision: 1, item: raiseItem() })).toEqual({
      revision: 1,
      item: raiseItem(),
    });
  });
});
