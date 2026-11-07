import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChainRecord, conflictMarkOf } from '../../../domain/chain-records.js';
import type { ChainRecord } from '../../../domain/chain-records.js';
import {
  CHAIN_RECORD_MAX_BYTES,
  CHAIN_RECORD_MAX_COUNT,
  ChainRepositoryAdapter,
} from '../ChainRepositoryAdapter.adapter.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';
const KEY = `chain-refresh/example@${MAIN.slice(0, 12)}`;

function deadline(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function recordOf(chainName = 'example', repo = REPO): ChainRecord {
  const created = createChainRecord({ repository: repo, chainName, expectedHeadSha: SHA, actionKey: 'chain-start-1', createdAtIso: NOW });
  if (!created.ok) throw new Error('setup');
  return created.record;
}

function listCmd(repo = REPO) {
  return { repository: repo, deadlineIso: deadline() };
}

function intentCmd(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPO, chainName: 'example', key: KEY, mainSha: MAIN, expectedRevision: 2, atIso: NOW, deadlineIso: deadline(),
    ...overrides,
  } as never;
}

function outcomeCmd(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPO, chainName: 'example', key: KEY, expectedRevision: 3, outcome: 'conflict', atIso: NOW, deadlineIso: deadline(),
    ...overrides,
  } as never;
}

describe.each([['memory'], ['file']] as const)('ChainRepositoryAdapter refresh (%s)', (mode) => {
  let stateDir: string;
  let adapter: ChainRepositoryAdapter;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-'));
    adapter = mode === 'file' ? new ChainRepositoryAdapter({ stateDir }) : new ChainRepositoryAdapter();
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  async function startedChain(): Promise<void> {
    await adapter.recordChainIntent({ record: recordOf(), deadlineIso: deadline() });
    await adapter.recordChainOutcome({
      repository: REPO, chainName: 'example', actionKey: 'chain-start-1', expectedRevision: 1,
      state: 'started', reason: null, deadlineIso: deadline(),
    });
  }

  it('lists the chains of a repository and keeps other repositories apart', async () => {
    await startedChain();
    await adapter.recordChainIntent({ record: recordOf('other', { owner: 'fleet', repo: 'v2-other' }), deadlineIso: deadline() });
    await adapter.recordChainIntent({ record: recordOf('two'), deadlineIso: deadline() });
    const listed = await adapter.listChains(listCmd());
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok') {
      expect(listed.records.map((record) => record.chainName).sort()).toEqual(['example', 'two']);
    }
    const empty = await adapter.listChains(listCmd({ owner: 'fleet', repo: 'v2-empty' }));
    expect(empty).toEqual({ status: 'ok', records: [] });
  });

  it('records the refresh intent once under compare-and-set', async () => {
    await startedChain();
    expect(await adapter.recordChainRefreshIntent(intentCmd())).toEqual({ outcome: 'recorded' });
    const read = await adapter.readChain({ repository: REPO, chainName: 'example', deadlineIso: deadline() });
    expect(read.status === 'ok' && read.record).toMatchObject({ revision: 3, refresh: { key: KEY, mainSha: MAIN, outcome: 'in-flight' } });
    expect(await adapter.recordChainRefreshIntent(intentCmd())).toEqual({ outcome: 'already-recorded' });
    expect(await adapter.recordChainRefreshIntent(intentCmd({ expectedRevision: 9 }))).toEqual({ outcome: 'already-recorded' });
  });

  it('refuses a stale intent revision', async () => {
    await startedChain();
    await adapter.recordChainRefreshIntent(intentCmd());
    expect(await adapter.recordChainRefreshIntent(intentCmd({ expectedRevision: 2 }))).toEqual({ outcome: 'already-recorded' });
    const other = await adapter.recordChainRefreshIntent(intentCmd({ key: `chain-refresh/example@000000000000` }));
    expect(other).toEqual({ outcome: 'refused', reason: 'stale-revision' });
  });

  it('records the refresh result and sets or clears the conflict mark', async () => {
    await startedChain();
    await adapter.recordChainRefreshIntent(intentCmd());
    expect(await adapter.recordChainRefreshOutcome(outcomeCmd())).toEqual({ outcome: 'recorded' });
    const read = await adapter.readChain({ repository: REPO, chainName: 'example', deadlineIso: deadline() });
    expect(read.status === 'ok' && read.record).toMatchObject({
      revision: 4,
      conflictMark: 'chain-refresh-conflict',
      refresh: { key: KEY, outcome: 'conflict' },
    });
    expect(await adapter.recordChainRefreshOutcome(outcomeCmd({ outcome: 'merged', expectedRevision: 4 }))).toEqual({ outcome: 'recorded' });
    const cleared = await adapter.readChain({ repository: REPO, chainName: 'example', deadlineIso: deadline() });
    expect(cleared.status === 'ok' && conflictMarkOf(cleared.record)).toBeNull();
    expect(cleared.status === 'ok' && cleared.record).toMatchObject({ revision: 5, refresh: { outcome: 'merged' } });
  });

  it('leaves the conflict mark unchanged on branch-gone and refuses a stale or mismatched outcome', async () => {
    await startedChain();
    await adapter.recordChainRefreshIntent(intentCmd());
    await adapter.recordChainRefreshOutcome(outcomeCmd());
    expect(await adapter.recordChainRefreshOutcome(outcomeCmd({ outcome: 'branch-gone', expectedRevision: 4 }))).toEqual({ outcome: 'recorded' });
    const read = await adapter.readChain({ repository: REPO, chainName: 'example', deadlineIso: deadline() });
    expect(read.status === 'ok' && read.record.conflictMark).toBe('chain-refresh-conflict');
    expect(await adapter.recordChainRefreshOutcome(outcomeCmd({ expectedRevision: 4 }))).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    expect(await adapter.recordChainRefreshOutcome(outcomeCmd({ key: `chain-refresh/example@000000000000` }))).toEqual({
      outcome: 'refused',
      reason: 'action-key-mismatch',
    });
  });

  it('refuses an unreadable or malformed store and bad input without throwing', async () => {
    expect(await adapter.listChains({ repository: REPO, deadlineIso: '2020-01-01T00:00:00.000Z' })).toMatchObject({ status: 'unreadable' });
    expect(await adapter.listChains({ repository: { owner: '..', repo: 'x' }, deadlineIso: deadline() })).toMatchObject({
      status: 'unreadable',
    });
    if (mode === 'file') {
      const dir = path.join(stateDir, 'chains');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${'a'.repeat(64)}.json`), '{ not json');
      expect(await adapter.listChains(listCmd())).toMatchObject({ status: 'unreadable' });
    }
  });
});

describe('ChainRepositoryAdapter refresh size bounds', () => {
  let stateDir: string;
  let adapter: ChainRepositoryAdapter;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-chains-'));
    adapter = new ChainRepositoryAdapter({ stateDir });
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('an oversized record is refused, not truncated', async () => {
    const key = createHash('sha256').update(`fleet/fleet-v2/gigantic`).digest('hex');
    const dir = path.join(stateDir, 'chains');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${key}.json`), 'x'.repeat(CHAIN_RECORD_MAX_BYTES + 10));
    const listed = await adapter.listChains(listCmd());
    expect(listed.status).toBe('unreadable');
    expect(listed.status === 'unreadable' && listed.reason).toBe('record-too-large');
  });

  it('a store full of other repositories records is refused with record-limit, not unbounded work', async () => {
    const body = JSON.stringify(recordOf('example', { owner: 'fleet', repo: 'other' }));
    const dir = path.join(stateDir, 'chains');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < CHAIN_RECORD_MAX_COUNT + 1; i += 1) {
      await fs.writeFile(path.join(dir, `${String(i).padStart(64, '0')}.json`), body);
    }
    expect(await adapter.listChains(listCmd())).toEqual({ status: 'unreadable', reason: 'record-limit' });
  }, 30_000);

  it('an over-long list is refused, not truncated', async () => {
    const body = JSON.stringify(recordOf());
    const dir = path.join(stateDir, 'chains');
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < CHAIN_RECORD_MAX_COUNT + 1; i += 1) {
      await fs.writeFile(path.join(dir, `${String(i).padStart(64, '0')}.json`), body);
    }
    expect(await adapter.listChains(listCmd())).toEqual({ status: 'unreadable', reason: 'record-limit' });
  }, 30_000);
});
