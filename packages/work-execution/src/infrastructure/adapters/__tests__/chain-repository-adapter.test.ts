import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChainRecord } from '../../../domain/chain-records.js';
import type { ChainRecord } from '../../../domain/chain-records.js';
import {
  CHAIN_RECORD_MAX_BYTES,
  CHAIN_RECORD_MAX_COUNT,
  ChainRepositoryAdapter,
} from '../ChainRepositoryAdapter.adapter.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';

function deadline(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function recordOf(chainName = 'example', actionKey = 'chain-start-1', repo = REPO): ChainRecord {
  const created = createChainRecord({ repository: repo, chainName, expectedHeadSha: SHA, actionKey, createdAtIso: NOW });
  if (!created.ok) throw new Error('setup');
  return created.record;
}

function readCmd(chainName = 'example', repo = REPO) {
  return { repository: repo, chainName, deadlineIso: deadline() };
}

function outcomeCmd(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPO, chainName: 'example', actionKey: 'chain-start-1', expectedRevision: 1,
    state: 'started', reason: null, deadlineIso: deadline(), ...overrides,
  } as never;
}

function fileOf(stateDir: string, chainName = 'example', repo = REPO): string {
  const key = createHash('sha256').update(`${repo.owner}/${repo.repo}/${chainName}`).digest('hex');
  return path.join(stateDir, 'chains', `${key}.json`);
}

describe.each([['memory'], ['file']] as const)('ChainRepositoryAdapter (%s)', (mode) => {
  let stateDir: string;
  let adapter: ChainRepositoryAdapter;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-'));
    adapter = mode === 'file' ? new ChainRepositoryAdapter({ stateDir }) : new ChainRepositoryAdapter();
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reads not-found for a chain never recorded', async () => {
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'not-found' });
  });

  it('records an intent, reads it back, and reports a second intent with the same key as already-recorded', async () => {
    const record = recordOf();
    expect(await adapter.recordChainIntent({ record, deadlineIso: deadline() })).toEqual({ outcome: 'recorded' });
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'ok', record });
    expect(await adapter.recordChainIntent({ record, deadlineIso: deadline() })).toEqual({ outcome: 'already-recorded' });
  });

  it('refuses a different key over an existing chain and keeps the first record', async () => {
    const first = recordOf('example', 'key-a');
    await adapter.recordChainIntent({ record: first, deadlineIso: deadline() });
    const decision = await adapter.recordChainIntent({ record: recordOf('example', 'key-b'), deadlineIso: deadline() });
    expect(decision).toEqual({ outcome: 'refused', reason: 'chain-exists' });
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'ok', record: first });
  });

  it('keeps chains of different repositories and names apart', async () => {
    await adapter.recordChainIntent({ record: recordOf('one'), deadlineIso: deadline() });
    await adapter.recordChainIntent({ record: recordOf('one', 'k', { owner: 'fleet', repo: 'other' }), deadlineIso: deadline() });
    expect((await adapter.readChain(readCmd('one'))).status).toBe('ok');
    expect(await adapter.readChain(readCmd('two'))).toEqual({ status: 'not-found' });
    const other = await adapter.readChain(readCmd('one', { owner: 'fleet', repo: 'other' }));
    expect(other.status === 'ok' && other.record.actionKey).toBe('k');
  });

  it('applies an outcome at the expected revision and advances it by one', async () => {
    const record = recordOf();
    await adapter.recordChainIntent({ record, deadlineIso: deadline() });
    expect(await adapter.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'recorded' });
    const read = await adapter.readChain(readCmd());
    expect(read.status === 'ok' && read.record).toMatchObject({ state: 'started', reason: null, revision: 2 });
  });

  it('records a refused outcome with its reason code', async () => {
    await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
    await adapter.recordChainOutcome(outcomeCmd({ state: 'refused', reason: 'forge-refused' }));
    const read = await adapter.readChain(readCmd());
    expect(read.status === 'ok' && read.record).toMatchObject({ state: 'refused', reason: 'forge-refused', revision: 2 });
  });

  it('refuses a stale expectedRevision and leaves the record alone', async () => {
    await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
    await adapter.recordChainOutcome(outcomeCmd());
    const stale = await adapter.recordChainOutcome(outcomeCmd({ state: 'refused', reason: 'forge-refused' }));
    expect(stale).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    const future = await adapter.recordChainOutcome(outcomeCmd({ expectedRevision: 9 }));
    expect(future).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    const read = await adapter.readChain(readCmd());
    expect(read.status === 'ok' && read.record.state).toBe('started');
  });

  it('lets exactly one of many concurrent outcome writers win', async () => {
    await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
    const other = mode === 'file' ? new ChainRepositoryAdapter({ stateDir }) : adapter;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? adapter : other).recordChainOutcome(
          outcomeCmd(i % 3 === 0 ? { state: 'refused', reason: 'forge-refused' } : {}),
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(7);
  });

  it('lets exactly one of many concurrent intents record', async () => {
    const other = mode === 'file' ? new ChainRepositoryAdapter({ stateDir }) : adapter;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? adapter : other).recordChainIntent({ record: recordOf('example', `key-${i}`), deadlineIso: deadline() }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(5);
  });

  it('refuses an outcome for another action key, an unknown chain and a bad request', async () => {
    expect(await adapter.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'chain-not-found' });
    await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
    expect(await adapter.recordChainOutcome(outcomeCmd({ actionKey: 'someone-else' }))).toEqual({
      outcome: 'refused', reason: 'action-key-mismatch',
    });
    for (const bad of [
      { state: 'intent-recorded' }, { state: 'refused', reason: null }, { state: 'refused', reason: 'Has Spaces' },
      { state: 'started', reason: 'forge-refused' }, { expectedRevision: 0 }, { expectedRevision: 1.5 },
      { expectedRevision: '1' }, { chainName: '../x' }, { repository: null }, { actionKey: '' },
    ]) {
      expect(await adapter.recordChainOutcome(outcomeCmd(bad))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
  });

  it('refuses malformed intents and deadlines instead of throwing', async () => {
    const good = recordOf();
    const cases: unknown[] = [
      null, undefined, 7, {}, { record: null, deadlineIso: deadline() },
      { record: { ...good, state: 'started' }, deadlineIso: deadline() },
      { record: { ...good, revision: 2 }, deadlineIso: deadline() },
      { record: { ...good, branchName: 'chain/other' }, deadlineIso: deadline() },
      { record: good, deadlineIso: 'tomorrow' },
      { record: good, deadlineIso: '2020-01-01T00:00:00.000Z' },
      { record: good },
    ];
    for (const c of cases) {
      const decision = await adapter.recordChainIntent(c as never);
      expect(decision.outcome).toBe('refused');
    }
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'not-found' });
  });

  it('never throws on hostile input objects', async () => {
    const trap = new Proxy({}, { get() { throw new Error('trap'); }, getOwnPropertyDescriptor() { throw new Error('trap'); } });
    const getter = { get record(): never { throw new Error('getter'); }, deadlineIso: deadline() };
    for (const hostile of [trap, getter, Object.create(null)]) {
      await expect(adapter.recordChainIntent(hostile as never)).resolves.toMatchObject({ outcome: 'refused' });
      await expect(adapter.recordChainOutcome(hostile as never)).resolves.toMatchObject({ outcome: 'refused' });
      await expect(adapter.readChain(hostile as never)).resolves.toMatchObject({ status: 'unreadable' });
    }
  });

  it('reports a read with a bad or expired deadline or a bad name as unreadable, not absent', async () => {
    expect(await adapter.readChain({ ...readCmd(), deadlineIso: 'x' })).toMatchObject({ status: 'unreadable' });
    expect(await adapter.readChain({ ...readCmd(), deadlineIso: '2020-01-01T00:00:00.000Z' })).toMatchObject({ status: 'unreadable' });
    expect(await adapter.readChain(readCmd('a/b'))).toMatchObject({ status: 'unreadable' });
  });

  it('echoes no input value in any refusal', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const decisions = [
      await adapter.recordChainOutcome(outcomeCmd({ actionKey: secret, chainName: secret })),
      await adapter.recordChainOutcome(outcomeCmd({ reason: secret, state: 'refused' })),
      await adapter.readChain(readCmd(secret)),
    ];
    for (const d of decisions) expect(JSON.stringify(d)).not.toContain(secret);
  });
});

describe('ChainRepositoryAdapter (file store)', () => {
  let stateDir: string;
  let adapter: ChainRepositoryAdapter;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-file-'));
    adapter = new ChainRepositoryAdapter({ stateDir });
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seed(): Promise<string> {
    await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
    return fileOf(stateDir);
  }

  it('persists across adapter instances', async () => {
    await seed();
    const again = new ChainRepositoryAdapter({ stateDir });
    expect((await again.readChain(readCmd())).status).toBe('ok');
  });

  it('reads torn, empty, non-JSON and wrong-shape files as unreadable, never as absent', async () => {
    const file = await seed();
    const good = await fs.readFile(file, 'utf8');
    for (const bytes of [good.slice(0, good.length / 2), '', 'not json', '[]', '{"schemaVersion":1}', 'null']) {
      await fs.writeFile(file, bytes);
      const read = await adapter.readChain(readCmd());
      expect(read.status).toBe('unreadable');
    }
  });

  it('refuses an intent and an outcome over an unreadable record and leaves its bytes untouched', async () => {
    const file = await seed();
    await fs.writeFile(file, '{"torn":');
    expect(await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() })).toEqual({
      outcome: 'refused', reason: 'record-unreadable',
    });
    expect(await adapter.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'record-unreadable' });
    expect(await fs.readFile(file, 'utf8')).toBe('{"torn":');
  });

  it('reads an unknown schemaVersion as unreadable with the fixed code', async () => {
    const file = await seed();
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...parsed, schemaVersion: 2 }));
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'unreadable', reason: 'unknown-schema-version' });
  });

  it('reads a record stored under another chain identity as unreadable', async () => {
    const file = await seed();
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...parsed, chainName: 'elsewhere', branchName: 'chain/elsewhere' }));
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'unreadable', reason: 'identity-mismatch' });
  });

  it('bounds the size of a read', async () => {
    const file = await seed();
    await fs.writeFile(file, ' '.repeat(CHAIN_RECORD_MAX_BYTES + 10));
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'unreadable', reason: 'record-too-large' });
  });

  it('caps the number of records', async () => {
    const dir = path.join(stateDir, 'chains');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < CHAIN_RECORD_MAX_COUNT; i += 1) {
      await fs.writeFile(path.join(dir, `filler-${i}.json`), '{}');
    }
    expect(await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() })).toEqual({
      outcome: 'refused', reason: 'record-limit',
    });
  });

  it('writes atomically: a crash that left a temp file keeps the old record readable and the next write cleans it', async () => {
    const file = await seed();
    const orphan = `${file.replace(/\.json$/, '')}.99999-deadbeef.tmp`;
    await fs.writeFile(orphan, '{"half":');
    expect((await adapter.readChain(readCmd())).status).toBe('ok');
    expect(await adapter.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'recorded' });
    await expect(fs.stat(orphan)).rejects.toThrow();
    const names = await fs.readdir(path.join(stateDir, 'chains'));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves no temp file and the old record bytes when the write fails', async () => {
    const file = await seed();
    const before = await fs.readFile(file, 'utf8');
    // a record of the allowed maximum plus one byte cannot be written; the old record must stay
    const big = new ChainRepositoryAdapter({ stateDir });
    const decision = await big.recordChainOutcome(outcomeCmd({ state: 'refused', reason: 'a'.repeat(CHAIN_RECORD_MAX_BYTES) }));
    expect(decision.outcome).toBe('refused');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const names = await fs.readdir(path.join(stateDir, 'chains'));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves no temp file when the rename itself fails', async () => {
    const file = await seed();
    await fs.rm(file);
    await fs.mkdir(file);
    const decision = await adapter.recordChainOutcome(outcomeCmd());
    expect(decision.outcome).toBe('refused');
    const names = await fs.readdir(path.join(stateDir, 'chains'));
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a record file that is a symlink, even to a valid record', async () => {
    const file = await seed();
    const elsewhere = path.join(stateDir, 'outside.json');
    await fs.copyFile(file, elsewhere);
    await fs.rm(file);
    await fs.symlink(elsewhere, file);
    expect(await adapter.readChain(readCmd())).toEqual({ status: 'unreadable', reason: 'symlink-refused' });
    expect(await adapter.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'record-unreadable' });
  });

  it('refuses a symlinked chains directory and writes nothing through it', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-outside-'));
    try {
      await fs.symlink(outside, path.join(stateDir, 'chains'));
      const linked = new ChainRepositoryAdapter({ stateDir });
      expect(await linked.recordChainIntent({ record: recordOf(), deadlineIso: deadline() })).toEqual({
        outcome: 'refused', reason: 'store-unavailable',
      });
      expect(await linked.readChain(readCmd())).toMatchObject({ status: 'unreadable' });
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('keeps writing inside the real chains directory when it is swapped for a link mid-operation', async () => {
    if (process.platform !== 'linux') return;
    await seed();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-swap-'));
    const chains = path.join(stateDir, 'chains');
    const parked = path.join(stateDir, 'chains-parked');
    try {
      // the swap happens while the record is being written, after the directory check
      const realRename = fs.rename;
      let swapped = false;
      const spy = (async (from: string, to: string) => {
        if (!swapped) {
          swapped = true;
          await realRename(chains, parked);
          await fs.symlink(outside, chains);
        }
        return realRename(from, to);
      }) as typeof fs.rename;
      (fs as { rename: typeof fs.rename }).rename = spy;
      try {
        await adapter.recordChainOutcome(outcomeCmd());
      } finally {
        (fs as { rename: typeof fs.rename }).rename = realRename;
      }
      expect(swapped).toBe(true);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a state directory swapped for another directory or a link after construction', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-root-'));
    const dir = path.join(stateDir, 'root');
    try {
      await fs.mkdir(path.join(outside, 'chains'));
      const pinned = new ChainRepositoryAdapter({ stateDir: dir });
      await pinned.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
      await fs.rename(dir, path.join(stateDir, 'root-moved'));
      await fs.symlink(outside, dir);
      expect(await pinned.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'store-unavailable' });
      expect(await fs.readdir(path.join(outside, 'chains'))).toEqual([]);
      await fs.rm(dir);
      await fs.mkdir(path.join(dir, 'chains'), { recursive: true });
      expect(await pinned.readChain(readCmd())).toMatchObject({ status: 'unreadable' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('never reads or waits on a store lock that is a link to a device', async () => {
    await seed();
    const lock = path.join(stateDir, 'chains', '.store.lock');
    await fs.symlink('/dev/zero', lock);
    expect(await adapter.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'store-busy' });
  });

  it('reads a record with a corrupted UTF-8 byte as unreadable', async () => {
    const file = await seed();
    const bytes = await fs.readFile(file);
    const at = bytes.indexOf('chain-start-1');
    bytes[at + 5] = 0xff;
    await fs.writeFile(file, bytes);
    expect((await adapter.readChain(readCmd())).status).toBe('unreadable');
  });

  it('refuses a persistent store off Linux unless unanchored paths are allowed', async () => {
    if (process.platform === 'linux') return;
    expect(await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() })).toEqual({
      outcome: 'refused', reason: 'store-unavailable',
    });
  });

  it('resolves a symlinked state directory once, at construction', async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-real-'));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-other-'));
    const link = path.join(stateDir, 'link');
    try {
      await fs.symlink(real, link);
      const linked = new ChainRepositoryAdapter({ stateDir: link });
      await fs.rm(link);
      await fs.symlink(other, link);
      await linked.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
      expect((await fs.readdir(path.join(real, 'chains'))).length).toBeGreaterThan(0);
      await expect(fs.stat(path.join(other, 'chains'))).rejects.toThrow();
    } finally {
      await fs.rm(real, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('is unavailable, not empty, when the state directory cannot be used', async () => {
    const blocker = path.join(stateDir, 'a-file');
    await fs.writeFile(blocker, 'x');
    const broken = new ChainRepositoryAdapter({ stateDir: path.join(blocker, 'sub') });
    expect(await broken.readChain(readCmd())).toMatchObject({ status: 'unreadable' });
    expect(await broken.recordChainIntent({ record: recordOf(), deadlineIso: deadline() })).toEqual({
      outcome: 'refused', reason: 'store-unavailable',
    });
    const blank = new ChainRepositoryAdapter({ stateDir: '  ' });
    expect(await blank.readChain(readCmd())).toMatchObject({ status: 'unreadable' });
  });

  it('fails closed as store-busy while another writer holds the lock, then recovers', async () => {
    await seed();
    const lock = path.join(stateDir, 'chains', '.store.lock');
    await fs.writeFile(lock, 'other-holder');
    const impatient = new ChainRepositoryAdapter({ stateDir, lockTimeoutMs: 100 });
    expect(await impatient.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'store-busy' });
    expect((await impatient.readChain(readCmd())).status).toBe('ok');
    await fs.rm(lock);
    expect(await impatient.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'recorded' });
  });

  it('refuses every write when opened read-only but still reads', async () => {
    await seed();
    const ro = new ChainRepositoryAdapter({ stateDir, readOnly: true });
    expect((await ro.readChain(readCmd())).status).toBe('ok');
    expect(await ro.recordChainOutcome(outcomeCmd())).toEqual({ outcome: 'refused', reason: 'read-only' });
    expect(await ro.recordChainIntent({ record: recordOf('x'), deadlineIso: deadline() })).toEqual({
      outcome: 'refused', reason: 'read-only',
    });
  });

  it('shows no state-directory path in any refusal or unreadable reason', async () => {
    const file = await seed();
    await fs.writeFile(file, 'garbage');
    const results = [
      await adapter.readChain(readCmd()),
      await adapter.recordChainOutcome(outcomeCmd()),
      await new ChainRepositoryAdapter({ stateDir: path.join(stateDir, 'a-nope', '\0') }).readChain(readCmd()),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toContain(stateDir);
  });

  it('refuses an expired deadline before touching the disk', async () => {
    const decision = await adapter.recordChainIntent({ record: recordOf(), deadlineIso: '2020-01-01T00:00:00.000Z' });
    expect(decision).toEqual({ outcome: 'refused', reason: 'deadline-expired' });
    await expect(fs.stat(path.join(stateDir, 'chains'))).rejects.toThrow();
  });
});
