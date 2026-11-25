// Direct unit tests for the pure state-store line formatter and predicate in
// `apps/cli/src/state.ts`. Both `describeStateFileResult` and
// `isBadStateFileResult` are constant-time O(1) apart from joining
// `schemaVersions`, which is bounded by the store's version count, and both
// perform no I/O; these tests construct `StateFileReadResult` values in
// memory and touch no filesystem.
/**
 * Covers the exact status phrases `fleet-v2 state check` prints per store
 * file, including the schemaVersion suffix rules and the rule that an
 * `unreadable` result's `detail` text never leaks into an
 * `invalid record <n>` line, plus the good/bad classification of every
 * status.
 */

import { describe, expect, it } from 'vitest';

import type { StateFileReadResult } from '@fleet/work-execution';
import { describeStateFileResult, isBadStateFileResult } from '../state.js';

describe('describeStateFileResult for ok results', () => {
  it("states 'ok (1 record)' for one record with no schemaVersions", () => {
    const result: StateFileReadResult = { status: 'ok', recordCount: 1 };
    expect(describeStateFileResult(result)).toBe('ok (1 record)');
  });

  it("states 'ok (0 records)' for zero records with no schemaVersions", () => {
    const result: StateFileReadResult = { status: 'ok', recordCount: 0 };
    expect(describeStateFileResult(result)).toBe('ok (0 records)');
  });

  it("states 'ok (2 records, schemaVersion 1)' for one observed version", () => {
    const result: StateFileReadResult = {
      status: 'ok',
      recordCount: 2,
      schemaVersions: [1],
    };
    expect(describeStateFileResult(result)).toBe('ok (2 records, schemaVersion 1)');
  });

  it("states 'ok (2 records, schemaVersions 1, 2)' for two observed versions", () => {
    const result: StateFileReadResult = {
      status: 'ok',
      recordCount: 2,
      schemaVersions: [1, 2],
    };
    expect(describeStateFileResult(result)).toBe('ok (2 records, schemaVersions 1, 2)');
  });

  it("adds no schemaVersion suffix for an empty schemaVersions array", () => {
    const result: StateFileReadResult = {
      status: 'ok',
      recordCount: 2,
      schemaVersions: [],
    };
    expect(describeStateFileResult(result)).toBe('ok (2 records)');
  });
});

describe('describeStateFileResult for non-ok statuses', () => {
  it("states 'missing' for a missing store", () => {
    const result: StateFileReadResult = { status: 'missing' };
    expect(describeStateFileResult(result)).toBe('missing');
  });

  it("states 'unreadable: cannot read (EACCES)' for a read-error with code EACCES", () => {
    // 'EACCES' built at runtime so no code-shaped literal sits in the file.
    const code = ['E', 'A', 'C', 'C', 'E', 'S'].join('');
    const result: StateFileReadResult = { status: 'read-error', code };
    expect(describeStateFileResult(result)).toBe('unreadable: cannot read (EACCES)');
  });

  it("states 'unsupported schemaVersion at record 2' for an unknown version at record 2", () => {
    const result: StateFileReadResult = {
      status: 'unknown-version',
      detail: 'unknown schemaVersion 9',
      recordIndex: 2,
    };
    expect(describeStateFileResult(result)).toBe('unsupported schemaVersion at record 2');
  });
});

describe('describeStateFileResult for unreadable results', () => {
  it("states 'unreadable: corrupt header' when recordIndex is null", () => {
    const result: StateFileReadResult = {
      status: 'unreadable',
      detail: 'corrupt header',
      recordIndex: null,
    };
    expect(describeStateFileResult(result)).toBe('unreadable: corrupt header');
  });

  it("states 'invalid record 3' and omits the detail text when recordIndex is 3", () => {
    const result: StateFileReadResult = {
      status: 'unreadable',
      detail: 'internal detail',
      recordIndex: 3,
    };
    const line = describeStateFileResult(result);
    expect(line).toBe('invalid record 3');
    expect(line).not.toContain('internal detail');
  });

  it("treats recordIndex 0 as a record index, not null, and states 'invalid record 0'", () => {
    const result: StateFileReadResult = {
      status: 'unreadable',
      detail: 'zero index detail',
      recordIndex: 0,
    };
    const line = describeStateFileResult(result);
    expect(line).toBe('invalid record 0');
    expect(line).not.toContain('zero index detail');
  });
});

describe('isBadStateFileResult over every status', () => {
  // All five statuses, so a constant true or constant false implementation
  // fails at least one row.
  const rows: readonly (readonly [StateFileReadResult, boolean])[] = [
    [{ status: 'ok', recordCount: 1 }, false],
    [{ status: 'missing' }, false],
    [{ status: 'unreadable', detail: 'corrupt header', recordIndex: null }, true],
    [{ status: 'read-error', code: 'EACCES' }, true],
    [{ status: 'unknown-version', detail: 'unknown schemaVersion 9', recordIndex: 2 }, true],
  ];

  it('classifies each of the five statuses exactly as specified', () => {
    for (const [result, expected] of rows) {
      expect(isBadStateFileResult(result)).toBe(expected);
    }
  });
});
