import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CutoverJournalEntry } from '../../../application/ports/out/CutoverJournalPort.out-port.js';
import { CutoverJournalAdapter } from '../CutoverJournalAdapter.adapter.js';

const KEY = 'relaunch/abcdef0123456789/lane-1/save';
const NOW = '2026-11-06T10:00:00Z';
let counter = 0;
const ulid = (): string => `01HZ${String((counter += 1)).padStart(22, '0')}`;
const intent = (key = KEY): CutoverJournalEntry => ({ key, kind: 'intent', entryId: ulid(), recordedAtIso: NOW });
const result = (
  outcome: 'completed' | 'refused' | 'ambiguous',
  key = KEY,
  extra: Partial<CutoverJournalEntry> = {},
): CutoverJournalEntry => ({ key, kind: 'result', entryId: ulid(), recordedAtIso: NOW, outcome, reasonCode: 'saved', ...extra });

const dirs: string[] = [];
async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cutover-journal-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function refusal(journal: CutoverJournalAdapter, entry: unknown): Promise<string> {
  const appended = await journal.append(entry as CutoverJournalEntry);
  return appended.outcome === 'refused' ? appended.reason : 'appended';
}

describe('CutoverJournalAdapter', () => {
  it('an intent is appended and listed by key prefix in append order', async () => {
    const journal = new CutoverJournalAdapter();
    const other = 'relaunch/abcdef0123456789/lane-2/save';
    await journal.append(intent());
    await journal.append(intent(other));
    await journal.append(result('completed'));
    const listed = await journal.listByKeyPrefix('relaunch/abcdef0123456789/lane-1/');
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') expect(listed.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    const all = await journal.listByKeyPrefix('relaunch/');
    if (all.outcome === 'listed') expect(all.entries.map((entry) => entry.key)).toEqual([KEY, other, KEY]);
  });

  it('a second intent with the same key is refused', async () => {
    const journal = new CutoverJournalAdapter();
    expect(await refusal(journal, intent())).toBe('appended');
    expect(await refusal(journal, intent())).toBe('duplicate-intent');
    const listed = await journal.listByKeyPrefix(KEY);
    if (listed.outcome === 'listed') expect(listed.entries).toHaveLength(1);
  });

  it('a result without its intent is refused', async () => {
    const journal = new CutoverJournalAdapter();
    expect(await refusal(journal, result('completed'))).toBe('result-without-intent');
  });

  it('a result after the final result is refused', async () => {
    const journal = new CutoverJournalAdapter();
    await journal.append(intent());
    await journal.append(result('refused'));
    expect(await refusal(journal, result('completed'))).toBe('result-after-final-result');
    expect(await refusal(journal, result('ambiguous'))).toBe('result-after-final-result');
  });

  it('an ambiguous result may precede the one final result', async () => {
    const journal = new CutoverJournalAdapter();
    await journal.append(intent());
    expect(await refusal(journal, result('ambiguous'))).toBe('appended');
    expect(await refusal(journal, result('ambiguous'))).toBe('appended');
    expect(await refusal(journal, result('completed'))).toBe('appended');
  });

  it('an intent after a result is refused', async () => {
    const journal = new CutoverJournalAdapter();
    await journal.append(intent());
    await journal.append(result('ambiguous'));
    expect(await refusal(journal, intent())).toBe('intent-after-result');
  });

  it('an invalid key is refused', async () => {
    const journal = new CutoverJournalAdapter();
    for (const key of ['', 'relaunch/xyz/lane/save', 'cutover/move', 'other/abcdef0/lane/save', 'relaunch/abcdef0/a b/save']) {
      expect(await refusal(journal, intent(key))).toBe('invalid-key');
    }
    expect(await refusal(journal, intent('cutover/move-1@rev.2'))).toBe('appended');
    expect(await refusal(journal, null)).toBe('invalid-entry');
    expect(await refusal(journal, { ...intent(), entryId: 'not-a-ulid' })).toBe('invalid-entry');
    expect(await journal.listByKeyPrefix(5 as unknown as string)).toEqual({ outcome: 'unreadable' });
  });

  it('an unreadable journal is reported as unreadable, never empty', async () => {
    const dir = await stateDir();
    const file = path.join(dir, 'cutover-journal.json');
    await writeFile(file, '{ not json', 'utf8');
    const journal = new CutoverJournalAdapter({ stateDir: dir });
    expect(await journal.listByKeyPrefix('relaunch/')).toEqual({ outcome: 'unreadable' });
    expect(await refusal(journal, intent())).toBe('store-unreadable');
    await writeFile(file, JSON.stringify([{ ...intent(), schemaVersion: 99 }]), 'utf8');
    expect(await journal.listByKeyPrefix('relaunch/')).toEqual({ outcome: 'unreadable' });
    expect(await refusal(journal, intent())).toBe('store-unreadable');
  });

  it('a file-backed store writes atomically under the lock and survives a reopen', async () => {
    const dir = await stateDir();
    const first = new CutoverJournalAdapter({ stateDir: dir });
    await first.append(intent());
    await first.append(result('completed', KEY, { digest: 'a'.repeat(40), commitId: 'b'.repeat(40) }));
    const reopened = new CutoverJournalAdapter({ stateDir: dir });
    const listed = await reopened.listByKeyPrefix('relaunch/');
    expect(listed.outcome === 'listed' && listed.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(await refusal(reopened, intent())).toBe('intent-after-result');
    const stored = JSON.parse(await readFile(path.join(dir, 'cutover-journal.json'), 'utf8')) as { schemaVersion: number }[];
    expect(stored.map((record) => record.schemaVersion)).toEqual([1, 1]);
    await expect(readFile(path.join(dir, 'cutover-journal.json.lock'))).rejects.toThrow();
    expect(() => new CutoverJournalAdapter({ stateDir: dir, fileName: 'run-journal.json' })).toThrow();
    expect(() => new CutoverJournalAdapter({ stateDir: dir, fileName: '../x.json' })).toThrow();
  });

  it('a read-only store refuses every append', async () => {
    const dir = await stateDir();
    await new CutoverJournalAdapter({ stateDir: dir }).append(intent());
    const readOnly = new CutoverJournalAdapter({ stateDir: dir, readOnly: true });
    expect(await refusal(readOnly, intent('relaunch/abcdef0123456789/lane-9/save'))).toBe('store-read-only');
    const listed = await readOnly.listByKeyPrefix('relaunch/');
    expect(listed.outcome === 'listed' && listed.entries).toHaveLength(1);
  });

  it('the entries carry ids, codes and digests only', async () => {
    const journal = new CutoverJournalAdapter();
    expect(await refusal(journal, { ...intent(), detail: '/home/x/secret' })).toBe('invalid-entry');
    expect(await refusal(journal, intent())).toBe('appended');
    expect(await refusal(journal, result('completed', KEY, { reasonCode: 'see /home/x' }))).toBe('invalid-entry');
    expect(await refusal(journal, result('completed', KEY, { digest: 'ghp_notadigest' }))).toBe('invalid-entry');
    expect(await refusal(journal, result('completed', KEY, { saveRef: '/etc/passwd' }))).toBe('invalid-entry');
    expect(await refusal(journal, { ...intent(), outcome: 'completed' })).toBe('invalid-entry');
    const appended = await journal.append(
      result('completed', KEY, { digest: 'a'.repeat(40), commitId: 'b'.repeat(40), saveRef: 'refs/fleet/saved/abc-lane' }),
    );
    expect(appended.outcome).toBe('appended');
    const listed = await journal.listByKeyPrefix(KEY);
    if (listed.outcome === 'listed') {
      const names = new Set(listed.entries.flatMap((entry) => Object.keys(entry)));
      expect([...names].sort()).toEqual(
        ['commitId', 'digest', 'entryId', 'key', 'kind', 'outcome', 'reasonCode', 'recordedAtIso', 'saveRef'].sort(),
      );
    }
  });
});
