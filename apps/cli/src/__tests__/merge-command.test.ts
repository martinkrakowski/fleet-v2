// DT4: the `merge` CLI group — enqueue/list/drop/retry handlers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';
const HEAD_C = '0123456789abcdef0123456789abcdef01234569';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function cli(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

function ulid(n: number): string {
  return '01JB' + String(n).padStart(22, '0');
}

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

describe('merge commands (DT4)', () => {
  it('refuses a short head and an unknown tier as usage errors', async () => {
    const runtime = createFleetCliRuntime({});
    const shortHead = await cli(runtime, [
      'merge',
      'enqueue',
      '--repository',
      'fleet/v2',
      '--pull-request',
      '7',
      '--head',
      'abc',
    ]);
    expect(shortHead.code).toBe(2);
    expect(shortHead.err).toContain('merge enqueue: --head must be 40 lowercase hex characters');

    const badTier = await cli(runtime, [
      'merge',
      'enqueue',
      '--repository',
      'fleet/v2',
      '--pull-request',
      '7',
      '--head',
      HEAD_A,
      '--tier',
      'nonsense',
    ]);
    expect(badTier.code).toBe(2);
    expect(badTier.err).toContain('merge enqueue: --tier must be 0, 1 or 2');
  });

  it('refuses a malformed repository as a usage error without echoing the value', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, [
      'merge',
      'enqueue',
      '--repository',
      'not-a-repo',
      '--pull-request',
      '7',
      '--head',
      HEAD_A,
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('merge commands require --repository as owner/repo');
    expect(result.err).not.toContain('not-a-repo');
  });

  it('surfaces a refused drop as a non-zero outcome', async () => {
    const runtime = createFleetCliRuntime({});
    const result = await cli(runtime, ['merge', 'drop', '--entry-id', ulid(99)]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason: 'unknown-entry' });
  });

  it('lists live entries in queue order with a head per repository', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-merge-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    const queue = runtime.execution.mergeQueueRepository;

    const enqueue = async (
      repository: { owner: string; repo: string },
      pullRequest: number,
      headOid: string,
      enqueuedAtIso: string,
      entryId: string,
    ): Promise<void> => {
      const result = await queue.enqueueMergeEntry({
        repository,
        pullRequest,
        headOid,
        tier: 2,
        enqueuedBy: 'cli',
        runId: null,
        entryId,
        successorEntryId: ulid(9),
        enqueuedAtIso,
        deadlineIso: futureDeadline(),
      });
      expect(result.outcome).toBe('created');
    };

    // A terminal (dropped) entry in repo A at the earliest instant.
    await enqueue({ owner: 'fleet', repo: 'v2' }, 3, HEAD_C, '2026-11-01T08:00:00.000Z', ulid(4));
    const drop = await queue.dropMergeEntry({ entryId: ulid(4), deadlineIso: futureDeadline() });
    expect(drop.outcome).toBe('dropped');

    // Repo B at 09:00, repo A at 10:00 and 11:00.
    await enqueue({ owner: 'acme', repo: 'widget' }, 7, HEAD_C, '2026-11-01T09:00:00.000Z', ulid(1));
    await enqueue({ owner: 'fleet', repo: 'v2' }, 1, HEAD_A, '2026-11-01T10:00:00.000Z', ulid(2));
    await enqueue({ owner: 'fleet', repo: 'v2' }, 2, HEAD_B, '2026-11-01T11:00:00.000Z', ulid(3));

    const result = await cli(runtime, ['merge', 'list']);
    expect(result.code).toBe(0);
    const view = JSON.parse(result.out) as {
      entries: Array<{ entryId: string; state: string }>;
      heads: Array<{ repository: { owner: string; repo: string }; headEntryId: string | null }>;
    };
    expect(view.entries.map((entry) => entry.entryId)).toEqual([ulid(1), ulid(2), ulid(3)]);
    expect(view.entries.some((entry) => entry.state === 'dropped')).toBe(false);
    const repoAHead = view.heads.find(
      (head) => head.repository.owner === 'fleet' && head.repository.repo === 'v2',
    );
    const repoBHead = view.heads.find(
      (head) => head.repository.owner === 'acme' && head.repository.repo === 'widget',
    );
    expect(repoAHead?.headEntryId).toBe(ulid(2));
    expect(repoBHead?.headEntryId).toBe(ulid(1));

    const filtered = await cli(runtime, ['merge', 'list', '--repository', 'fleet/v2']);
    expect(filtered.code).toBe(0);
    const filteredView = JSON.parse(filtered.out) as {
      entries: Array<{ entryId: string }>;
      heads: Array<{ repository: { owner: string; repo: string }; headEntryId: string | null }>;
    };
    expect(filteredView.entries.map((entry) => entry.entryId)).toEqual([ulid(2), ulid(3)]);
    expect(filteredView.heads).toHaveLength(1);
    expect(filteredView.heads[0]?.headEntryId).toBe(ulid(2));
  });
});
