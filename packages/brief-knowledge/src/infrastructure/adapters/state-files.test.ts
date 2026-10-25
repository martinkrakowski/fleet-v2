import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  type StateFileDescriptor,
  type StateFileInspection,
} from './file-store.js';
import { BRIEF_KNOWLEDGE_STATE_FILES } from './state-files.js';
import { KnowledgeEntryRepositoryAdapter } from './KnowledgeEntryRepositoryAdapter.adapter.js';

const VALID_FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
  'knowledge-entries.json': [{ id: 'ke-1' }, { id: 'ke-2' }],
  'context-selections.json': [{ attemptId: 'a' }, { attemptId: 'b' }],
};

const READS: Readonly<Record<string, (stateDir: string) => Promise<unknown>>> = {
  'knowledge-entries.json': (stateDir) =>
    new KnowledgeEntryRepositoryAdapter({ stateDir }).listEntriesByProject(),
  'context-selections.json': (stateDir) =>
    new KnowledgeEntryRepositoryAdapter({ stateDir }).listContextSelections('a'),
};

type FixtureKind = 'valid' | 'not-json' | 'not-list' | 'bad-record';

function bytesFor(basename: string, kind: FixtureKind): Buffer {
  if (kind === 'not-json') return Buffer.from('{ not json');
  if (kind === 'not-list') return Buffer.from('{}');
  const first = VALID_FIXTURES[basename]![0];
  if (kind === 'bad-record') {
    return Buffer.from(JSON.stringify([first, { bogus: true }]));
  }
  return Buffer.from(JSON.stringify(VALID_FIXTURES[basename]));
}

const CASES: Array<{
  basename: string;
  kind: FixtureKind;
  inspect: (bytes: Buffer) => StateFileInspection;
  read: (stateDir: string) => Promise<unknown>;
  bytes: Buffer;
  expectedOk: boolean;
}> = [];

for (const descriptor of BRIEF_KNOWLEDGE_STATE_FILES) {
  const kinds: readonly FixtureKind[] = ['valid', 'not-json', 'not-list', 'bad-record'];
  for (const kind of kinds) {
    const bytes = bytesFor(descriptor.basename, kind);
    CASES.push({
      basename: descriptor.basename,
      kind,
      inspect: (b: Buffer) => descriptor.inspect(b),
      read: READS[descriptor.basename]!,
      bytes,
      expectedOk: kind === 'valid',
    });
  }
}

describe('brief-knowledge state file descriptors match the store readers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-state-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it.each(CASES)('$basename / $kind', async ({ basename, bytes, inspect, read, expectedOk }) => {
    await fs.writeFile(path.join(tempDir, basename), bytes);
    const inspection = inspect(bytes);
    const outcome = await read(tempDir).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    if (inspection.status === 'ok') {
      expect(outcome).toBe('resolved');
    } else {
      expect(outcome).toBeInstanceOf(StateFileUnreadableError);
      expect((outcome as StateFileUnreadableError).detail).toBe(inspection.detail);
    }
    expect(expectedOk).toBe(inspection.status === 'ok');
  });

  it('lists exactly the owned state files', () => {
    expect(BRIEF_KNOWLEDGE_STATE_FILES.map((descriptor: StateFileDescriptor) => descriptor.basename)).toEqual([
      'knowledge-entries.json',
      'context-selections.json',
    ]);
  });
});
