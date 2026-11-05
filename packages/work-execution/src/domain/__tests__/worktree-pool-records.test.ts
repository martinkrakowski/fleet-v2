import { describe, expect, it } from 'vitest';

import {
  WORKTREE_POOL_ENTRY_SCHEMA_VERSION,
  isWorktreePoolBaseCommit,
  isWorktreePoolEntryState,
  readWorktreePoolEntryRecord,
} from '../worktree-pool-records.js';

const BASE = '0123456789abcdef0123456789abcdef01234567';

function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORKTREE_POOL_ENTRY_SCHEMA_VERSION,
    entryId: 'proj-a#1',
    projectId: 'proj-a',
    worktreePath: '/fleet/pool/proj-a/1',
    baseCommit: BASE,
    state: 'warm',
    takenByRunId: null,
    revision: 1,
    ...overrides,
  };
}

describe('worktree pool entry record', () => {
  it('reads a v1 pool entry record', () => {
    const input = makeRecord();
    const result = readWorktreePoolEntryRecord(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual(input);
      expect(result.record.schemaVersion).toBe(1);
      expect(Object.isFrozen(result.record)).toBe(true);
    }
  });

  it('refuses an unknown record version', () => {
    for (const schemaVersion of [2, 99]) {
      const result = readWorktreePoolEntryRecord(makeRecord({ schemaVersion }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown-schema-version');
      }
    }
  });

  it('reads an absent schemaVersion as 1', () => {
    const input = makeRecord();
    delete input.schemaVersion;
    const result = readWorktreePoolEntryRecord(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schemaVersion).toBe(1);
    }
  });

  it('refuses a malformed pool entry record', () => {
    const withMissingKey = makeRecord();
    delete withMissingKey.takenByRunId;
    const withWrongType = makeRecord({ revision: -1 });
    for (const input of [withMissingKey, withWrongType, 'not-an-object', 7]) {
      const result = readWorktreePoolEntryRecord(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('malformed');
      }
    }
  });

  it('refuses a warm entry that names a run', () => {
    const input = makeRecord({ takenByRunId: 'run-1' });
    const result = readWorktreePoolEntryRecord(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('predicate helpers match the record domain', () => {
    expect(isWorktreePoolBaseCommit(BASE)).toBe(true);
    expect(isWorktreePoolBaseCommit(BASE.toUpperCase())).toBe(false);
    expect(isWorktreePoolBaseCommit('abc')).toBe(false);
    expect(isWorktreePoolEntryState('warm')).toBe(true);
    expect(isWorktreePoolEntryState('taken')).toBe(true);
    expect(isWorktreePoolEntryState('free')).toBe(false);
  });
});
