/**
 * CutoverRecordRepositoryAdapter (lane SH19c): the file-name collision guard
 * over the shadow stores' files — `cutover-shadow.json` and the shadow
 * attestation ledger's `cutover-shadow-attestations.json` are other stores'
 * files, never this one's — plus the basic missing read the guard sits next
 * to. Mirrors the ShadowEvidenceAdapter test shape.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CutoverRecordRepositoryAdapter } from '../CutoverRecordRepositoryAdapter.adapter.js';

describe('CutoverRecordRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'fleet-cutover-record-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses a file name that is unsafe or collides with another store', () => {
    for (const fileName of [
      'cutover-shadow.json',
      'cutover-shadow-attestations.json',
      'cutover-journal.json',
      'merge-queue.json',
      '../x.json',
      'a/b.json',
      '',
    ]) {
      expect(() => new CutoverRecordRepositoryAdapter({ stateDir: tempDir, fileName })).toThrow();
    }
    expect(() => new CutoverRecordRepositoryAdapter({ stateDir: tempDir, fileName: 'cutover-alt.json' })).not.toThrow();
  });

  it('reads missing in a fresh state directory', async () => {
    const adapter = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });
    expect(await adapter.read()).toEqual({ status: 'missing' });
  });

  it('refuses every write when opened read-only', async () => {
    const adapter = new CutoverRecordRepositoryAdapter({ stateDir: tempDir, readOnly: true });
    expect(await adapter.compareAndSet({ expectedRevision: 0, next: { schemaVersion: 1 } as never })).toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
    expect(await adapter.read()).toEqual({ status: 'missing' });
  });
});
