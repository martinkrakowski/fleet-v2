import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CutoverJournalEntry } from '../../../application/ports/out/CutoverJournalPort.out-port.js';
import { CutoverJournalAdapter, prepareCutoverJournalAppend, readCutoverJournalEntry } from '../CutoverJournalAdapter.adapter.js';

const KEY = 'relaunch/abcdef0123456789/lane-1/save';
const NOW = '2026-11-06T10:00:00Z';
let counter = 0;
const ulid = (): string => `01HZ${String((counter += 1)).padStart(22, '0')}`;
const intent = (key = KEY, extra: Partial<CutoverJournalEntry> = {}): CutoverJournalEntry => ({
  key,
  kind: 'intent',
  entryId: ulid(),
  recordedAtIso: NOW,
  ...extra,
});
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
    // The AdoptLane step keys (CO28) are accepted; a third step segment is not.
    expect(await refusal(journal, intent('relaunch/abcdef0123456789/lane-1/adopt/work-order'))).toBe('appended');
    expect(await refusal(journal, intent('relaunch/abcdef0123456789/lane-1/adopt/work-order/x'))).toBe('invalid-key');
    expect(await refusal(journal, intent('relaunch/abcdef0123456789/lane-1/adopt/'))).toBe('invalid-key');
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
    expect(stored.map((record) => record.schemaVersion)).toEqual([2, 2]);
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

  it('persists an intent with a request digest atomically in a temp dir so a reopened pass can inspect the digest and finish', async () => {
    const dir = await stateDir();
    const adoptKey = 'relaunch/abcdef0123456789/lane-1/adopt';
    const first = new CutoverJournalAdapter({ stateDir: dir });
    expect((await first.append(intent(adoptKey, { digest: 'd'.repeat(64) }))).outcome).toBe('appended');
    const reopened = new CutoverJournalAdapter({ stateDir: dir });
    const listed = await reopened.listByKeyPrefix(adoptKey);
    expect(listed.outcome === 'listed' && listed.entries[0]?.digest).toBe('d'.repeat(64));
    const stored = JSON.parse(await readFile(path.join(dir, 'cutover-journal.json'), 'utf8')) as { schemaVersion: number }[];
    expect(stored.map((record) => record.schemaVersion)).toEqual([2]);
    expect(await refusal(reopened, result('completed', adoptKey, { digest: 'd'.repeat(64) }))).toBe('appended');
    // Intents without a digest (absent or null) omit it; the other result-only fields stay refused with nothing written.
    const plain = 'relaunch/abcdef0123456789/lane-2/adopt';
    expect(await refusal(reopened, intent(plain))).toBe('appended');
    const nulled = 'relaunch/abcdef0123456789/lane-3/adopt';
    expect(await refusal(reopened, intent(nulled, { digest: null }))).toBe('appended');
    const all = await new CutoverJournalAdapter({ stateDir: dir }).listByKeyPrefix('relaunch/');
    if (all.outcome !== 'listed') throw new Error('expected a listing');
    expect(all.entries.filter((entry) => entry.kind === 'intent' && entry.key !== adoptKey).map((entry) => 'digest' in entry)).toEqual([false, false]);
    const before = await readFile(path.join(dir, 'cutover-journal.json'), 'utf8');
    const other = 'relaunch/abcdef0123456789/lane-4/adopt';
    for (const extra of [{ outcome: 'completed' }, { reasonCode: 'saved' }, { commitId: 'b'.repeat(40) }, { saveRef: 'refs/fleet/saved/x' }]) {
      expect(await refusal(reopened, intent(other, extra as Partial<CutoverJournalEntry>))).toBe('invalid-entry');
    }
    expect(await readFile(path.join(dir, 'cutover-journal.json'), 'utf8')).toBe(before);
  });

  it('loads schemaVersion 1 and unversioned intents without a digest from disk and refuses corrupt v1 intent digests or unknown versions as unreadable', async () => {
    const dir = await stateDir();
    const file = path.join(dir, 'cutover-journal.json');
    const k1 = 'relaunch/abcdef0123456789/lane-1/save';
    const k2 = 'relaunch/abcdef0123456789/lane-2/save';
    const raw = [
      intent(k1),
      { ...intent(k2), schemaVersion: 1 },
      { ...result('completed', k2, { digest: 'a'.repeat(40) }), schemaVersion: 1 },
    ];
    await writeFile(file, JSON.stringify(raw), 'utf8');
    const journal = new CutoverJournalAdapter({ stateDir: dir });
    const listed = await journal.listByKeyPrefix('relaunch/');
    expect(listed.outcome === 'listed' && listed.entries.map((entry) => entry.kind)).toEqual(['intent', 'intent', 'result']);
    const fresh = 'relaunch/abcdef0123456789/lane-3/adopt';
    expect(await refusal(journal, intent(fresh, { digest: 'e'.repeat(64) }))).toBe('appended');
    const reopened = await new CutoverJournalAdapter({ stateDir: dir }).listByKeyPrefix('relaunch/');
    expect(reopened.outcome === 'listed' && reopened.entries).toHaveLength(4);
    const stored = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number }[];
    expect(stored.map((record) => record.schemaVersion)).toEqual([2, 2, 2, 2]);
    // A v1 record that carries an intent digest is corrupt; version 3 is unknown. Neither is quarantined or read as empty.
    for (const [version, digest] of [[1, 'e'.repeat(64)], [3, undefined]] as const) {
      const other = await stateDir();
      const target = path.join(other, 'cutover-journal.json');
      const bad = JSON.stringify([{ ...intent(k1, digest === undefined ? {} : { digest }), schemaVersion: version }]);
      await writeFile(target, bad, 'utf8');
      const broken = new CutoverJournalAdapter({ stateDir: other });
      expect(await broken.listByKeyPrefix('relaunch/')).toEqual({ outcome: 'unreadable' });
      expect(await refusal(broken, intent(k2))).toBe('store-unreadable');
      if (version === 3) expect(await readFile(target, 'utf8')).toBe(bad);
    }
  });

  it('preserves the first intent digest across duplicate-intent refusal and reopen so a replay caller can detect a request-digest mismatch before any write', async () => {
    const dir = await stateDir();
    const adoptKey = 'relaunch/abcdef0123456789/lane-1/adopt';
    const journal = new CutoverJournalAdapter({ stateDir: dir });
    await journal.append(intent(adoptKey, { digest: '1'.repeat(64) }));
    const before = await readFile(path.join(dir, 'cutover-journal.json'), 'utf8');
    expect(await refusal(journal, intent(adoptKey, { digest: '2'.repeat(64) }))).toBe('duplicate-intent');
    expect(await readFile(path.join(dir, 'cutover-journal.json'), 'utf8')).toBe(before);
    const listed = await new CutoverJournalAdapter({ stateDir: dir }).listByKeyPrefix(adoptKey);
    const stored = listed.outcome === 'listed' ? listed.entries.find((entry) => entry.kind === 'intent') : undefined;
    expect(stored?.digest).toBe('1'.repeat(64));
    expect(stored?.digest).not.toBe('2'.repeat(64));
  });

  it('refuses null, non-plain objects, missing or wrong-typed fields, sparse arrays, unknown enums and throwing or stateful getters without throwing', async () => {
    const journal = new CutoverJournalAdapter();
    for (const bad of [null, undefined, 5, 'x', [], new Date(), { ...intent(), key: 5 }, { ...intent(), recordedAtIso: 5 }, { ...intent(), kind: 'other' }, { key: KEY }]) {
      expect(['invalid-entry', 'invalid-key']).toContain(await refusal(journal, bad));
    }
    expect(await refusal(journal, { ...result('completed'), outcome: 'weird' })).toBe('invalid-entry');
    const throwing = { ...intent() };
    Object.defineProperty(throwing, 'digest', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(await refusal(journal, throwing)).toBe('invalid-entry');
    const throwingKey = { ...intent() };
    Object.defineProperty(throwingKey, 'key', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(await refusal(journal, throwingKey)).toBe('invalid-entry');
    // A stateful getter answers once: the snapshot cannot flip from a valid digest to garbage between check and use.
    let reads = 0;
    const stateful = { ...intent() };
    Object.defineProperty(stateful, 'digest', { enumerable: true, get: () => ((reads += 1) === 1 ? 'a'.repeat(40) : '/etc/passwd') });
    const appended = await journal.append(stateful as CutoverJournalEntry);
    expect(reads).toBe(1);
    expect(appended.outcome === 'appended' && appended.entry.digest).toBe('a'.repeat(40));
    expect(readCutoverJournalEntry(Object.assign(Object.create({ inherited: 1 }) as object, intent())).ok).toBe(false);
    expect(readCutoverJournalEntry({ ...intent(), [Symbol('x')]: 1 }).ok).toBe(false);
    // Sparse and malformed existing lists are refused, never thrown on.
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [, intent('relaunch/abcdef0123456789/lane-9/save')] as unknown as CutoverJournalEntry[];
    expect(prepareCutoverJournalAppend(sparse, intent())).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(prepareCutoverJournalAppend([{ key: 5 }] as unknown as CutoverJournalEntry[], intent())).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(prepareCutoverJournalAppend(null as unknown as CutoverJournalEntry[], intent())).toEqual({ ok: false, reason: 'invalid-entry' });
  });

  it('refuses secret-shaped and path-shaped values on intent digest and echoes neither paths nor secrets in refusals', async () => {
    const dir = await stateDir();
    const journal = new CutoverJournalAdapter({ stateDir: dir });
    const secrets = [`${'ghp'}_${'a'.repeat(30)}`, `${'github_pat'}_${'a'.repeat(24)}`, '/srv/lanes/worktree'];
    for (const value of secrets) {
      const appended = await journal.append(intent(KEY, { digest: value }));
      expect(appended).toEqual({ outcome: 'refused', reason: 'invalid-entry' });
      expect(JSON.stringify(appended)).not.toContain(value);
    }
    expect(await journal.listByKeyPrefix('relaunch/')).toEqual({ outcome: 'listed', entries: [] });
  });

  it('refuses oversized keys, digests, prefixes, entry lists and journal files without throwing', async () => {
    const journal = new CutoverJournalAdapter();
    expect(await refusal(journal, intent(KEY, { digest: 'a'.repeat(65) }))).toBe('invalid-entry');
    expect(await refusal(journal, intent(KEY, { digest: 'a'.repeat(39) }))).toBe('invalid-entry');
    expect(await refusal(journal, intent(`relaunch/abcdef0123456789/${'l'.repeat(100)}/save`))).toBe('invalid-key');
    expect(await journal.listByKeyPrefix('r'.repeat(300))).toEqual({ outcome: 'unreadable' });
    const many = Array.from({ length: 10_001 }, (_, index) => ({ key: KEY, kind: 'intent', entryId: String(index) })) as unknown as CutoverJournalEntry[];
    expect(prepareCutoverJournalAppend(many, intent())).toEqual({ ok: false, reason: 'invalid-entry' });
    const dir = await stateDir();
    const file = path.join(dir, 'cutover-journal.json');
    await writeFile(file, '', 'utf8');
    await truncate(file, 16 * 1024 * 1024 + 1);
    const big = new CutoverJournalAdapter({ stateDir: dir });
    expect(await big.listByKeyPrefix('relaunch/')).toEqual({ outcome: 'unreadable' });
    expect(await refusal(big, intent())).toBe('store-unreadable');
    expect((await stat(file)).size).toBe(16 * 1024 * 1024 + 1);
  });

  it('refuses an append when the journal already holds the limit, writes nothing and keeps the file readable; one below the limit appends', async () => {
    const limit = 10_000;
    const seed = (count: number): string =>
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          key: `relaunch/abcdef0123456789/lane-${index}/save`,
          kind: 'intent',
          entryId: `01HY${String(index + 1).padStart(22, '0')}`,
          recordedAtIso: NOW,
          schemaVersion: 2,
        })),
      );
    const full = await stateDir();
    const fullFile = path.join(full, 'cutover-journal.json');
    await writeFile(fullFile, seed(limit), 'utf8');
    const atLimit = new CutoverJournalAdapter({ stateDir: full });
    expect(await refusal(atLimit, intent('relaunch/abcdef0123456789/lane-extra/save'))).toBe('store-unreadable');
    expect(JSON.parse(await readFile(fullFile, 'utf8'))).toHaveLength(limit);
    const listed = await atLimit.listByKeyPrefix('relaunch/');
    expect(listed.outcome === 'listed' && listed.entries.length).toBe(limit);
    const below = await stateDir();
    const belowFile = path.join(below, 'cutover-journal.json');
    await writeFile(belowFile, seed(limit - 1), 'utf8');
    const nearLimit = new CutoverJournalAdapter({ stateDir: below });
    expect(await refusal(nearLimit, intent('relaunch/abcdef0123456789/lane-extra/save'))).toBe('appended');
    const after = await nearLimit.listByKeyPrefix('relaunch/');
    expect(after.outcome === 'listed' && after.entries.length).toBe(limit);
  });

  it('snapshots each existing entry once: a getter that answers validly then throws cannot escape the decision', () => {
    const flaky = (): CutoverJournalEntry => {
      let reads = 0;
      return {
        get key(): string {
          reads += 1;
          if (reads > 1) throw new Error('boom');
          return KEY;
        },
        kind: 'intent',
        entryId: '01HY0000000000000000000099',
      } as unknown as CutoverJournalEntry;
    };
    expect(prepareCutoverJournalAppend([flaky()], intent('relaunch/abcdef0123456789/lane-9/save')).ok).toBe(true);
    expect(prepareCutoverJournalAppend([flaky()], intent(KEY))).toEqual({ ok: false, reason: 'duplicate-intent' });
    const alwaysThrows = { get key(): string { throw new Error('boom'); }, kind: 'intent', entryId: 'x' } as unknown as CutoverJournalEntry;
    expect(prepareCutoverJournalAppend([alwaysThrows], intent(KEY))).toEqual({ ok: false, reason: 'invalid-entry' });
  });
});
