// CO32: the `cutover shadow report` command — reads the shell train's queue
// through the LegacyTrainStateReadAdapter and compares it to the fleet merge
// queue for one repository, printing one JSON document of ids and codes.
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
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

let seedSecond = 0;
async function enqueue(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  repository: { owner: string; repo: string },
  pullRequest: number,
  headOid: string,
  entryId: string,
): Promise<void> {
  seedSecond += 1;
  const result = await runtime.execution.mergeQueueRepository.enqueueMergeEntry({
    repository,
    pullRequest,
    headOid,
    tier: 2,
    enqueuedBy: 'cli',
    runId: null,
    entryId,
    successorEntryId: ulid(9),
    enqueuedAtIso: new Date(Date.UTC(2026, 10, 1, 10, 0, seedSecond)).toISOString(),
    deadlineIso: futureDeadline(),
  });
  expect(result.outcome).toBe('created');
}

function shadowReportArgs(stateDir: string): string[] {
  return [
    'cutover',
    'shadow',
    'report',
    '--repository',
    'fleet/v2',
    '--legacy-state-dir',
    stateDir,
  ];
}

describe('cutover shadow report (CO32)', () => {
  it('reports equal enqueue sets as completed', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      outcome: string;
      kind: string;
      fleetBase: string;
      equal: boolean;
      complete: boolean;
      compared: number;
      fleetCount: number;
      shellCount: number;
      truncated: boolean;
      divergences: unknown[];
      shell: { queue: string; parkedLines: number; chainFiles: number | null; batchLines: number | null };
    };
    expect(body.outcome).toBe('completed');
    expect(body.kind).toBe('enqueue-set');
    expect(body.fleetBase).toBe('main');
    expect(body.equal).toBe(true);
    expect(body.complete).toBe(true);
    expect(body.compared).toBe(1);
    expect(body.fleetCount).toBe(1);
    expect(body.shellCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.divergences).toEqual([]);
    expect(body.shell.queue).toBe('read');
    expect(body.shell.parkedLines).toBe(0);
    expect(body.shell.chainFiles).toBe(0);
    expect(body.shell.batchLines).toBe(0);
  });

  it('lists missing-in-fleet and missing-in-shell divergences by key', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    // The fleet has 7@HEAD_A and 5@HEAD_C; the shell queue has 7@HEAD_A and
    // 8@HEAD_B: one shared key plus one one-sided entry on each side.
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 5, HEAD_C, ulid(2));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n8 ${HEAD_B} main\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      equal: boolean;
      compared: number;
      divergences: Array<{ key: string; code: string }>;
    };
    expect(body.equal).toBe(false);
    const codes = body.divergences.map((d) => d.code).sort();
    expect(codes).toEqual(['missing-in-fleet', 'missing-in-shell']);
    const keys = body.divergences.map((d) => d.key).sort();
    expect(keys).toEqual([`5@${HEAD_C}@main`, `8@${HEAD_B}@main`]);
    expect(body.compared).toBe(1);
    // Ids and codes only: no path, no file content.
    expect(result.out).not.toContain(stateDir);
    expect(result.out).not.toContain(`7 ${HEAD_A} main`);
    expect(result.out).not.toContain(`8 ${HEAD_B} main`);
  });

  it('reports unknown shell queue lines by number without echoing them', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    const badLine = 'this is not a queue line';
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n${badLine}\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    const body = JSON.parse(result.out) as { outcome: string; equal: boolean; complete: boolean; shell: { unknownLines: number[] } };
    expect(body.outcome).toBe('unknown');
    expect(body.equal).toBe(false);
    expect(body.outcome).toBe('unknown');
    expect(body.complete).toBe(false);
    expect(body.shell.unknownLines).toEqual([2]);
    expect(result.out).not.toContain(badLine);
  });

  it('refuses when the shell queue file is absent without echoing the path', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      outcome: 'refused',
      reason: 'shell-queue-absent',
      kind: 'enqueue-set',
    });
    expect(result.out).not.toContain(stateDir);
  });

  it('refuses a secret-shaped shell queue without echoing the secret', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    // Assembled from fragments so the pattern literal never appears here.
    const secret = ['sk', '-', 'aB3cD5eF7gH9iJ1kL2mN3'].join('');
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n${secret}\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      outcome: 'refused',
      reason: 'secret-shaped',
      kind: 'enqueue-set',
    });
    expect(result.out).not.toContain(secret);
  });

  it('refuses missing flags and a missing report subcommand as usage errors', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const noRepo = await cli(runtime, [
      'cutover',
      'shadow',
      'report',
      '--legacy-state-dir',
      stateDir,
    ]);
    expect(noRepo.code).toBe(2);
    expect(noRepo.err).toContain('cutover shadow report requires --repository as owner/repo');

    const noDir = await cli(runtime, ['cutover', 'shadow', 'report', '--repository', 'fleet/v2']);
    expect(noDir.code).toBe(2);
    expect(noDir.err).toContain('cutover shadow report requires --legacy-state-dir');

    const noSub = await cli(runtime, ['cutover', 'shadow']);
    expect(noSub.code).toBe(2);
    expect(noSub.err).toContain('cutover shadow requires the report subcommand');
  });

  it('counts only the live entries of the named repository', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    const queue = runtime.execution.mergeQueueRepository;

    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 6, HEAD_C, ulid(2));
    const drop = await queue.dropMergeEntry({ entryId: ulid(2), deadlineIso: futureDeadline() });
    expect(drop.outcome).toBe('dropped');
    await enqueue(runtime, { owner: 'acme', repo: 'widget' }, 9, HEAD_B, ulid(3));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      fleetCount: number;
      shellCount: number;
      equal: boolean;
      compared: number;
    };
    expect(body.fleetCount).toBe(1);
    expect(body.shellCount).toBe(1);
    expect(body.compared).toBe(1);
    expect(body.equal).toBe(true);
  });

  it('counts a shell parked PR as present on the shell side, matching a live fleet parked entry', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    // The fleet parked 7@HEAD_A (still live, so it is included); the shell
    // parked it too, so it left the shell queue and sits in the parked list.
    // The port has no park operation, so the parked record is seeded directly
    // into the store the adapter reloads on first use.
    const parkedEntry = {
      version: 1,
      entryId: ulid(1),
      repository: { owner: 'fleet', repo: 'v2' },
      repoDigest: 'a'.repeat(12),
      pullRequest: 7,
      headOid: HEAD_A,
      state: 'parked',
      reason: 'conflict',
      attempt: 0,
      notBeforeIso: null,
      enqueuedAtIso: '2026-11-01T10:00:00.000Z',
      enqueuedBy: 'cli',
      supersedes: null,
      runId: null,
      attemptId: null,
      workOrderId: null,
      tier: 2,
      verifiedHeadOid: null,
      verifiedBy: null,
      policyRevision: null,
      premergeReceiptHeadOid: null,
      veto: null,
      mergeCommitOid: null,
      mergedAtIso: null,
      revision: 1,
    };
    await fs.writeFile(path.join(stateDir, 'merge-queue.json'), JSON.stringify([parkedEntry]));
    await fs.writeFile(path.join(stateDir, 'queue'), '');
    await fs.writeFile(path.join(stateDir, 'parked'), `7 ${HEAD_A} main\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      equal: boolean;
      compared: number;
      fleetCount: number;
      shellCount: number;
      divergences: unknown[];
      shell: { parkedLines: number };
    };
    expect(body.equal).toBe(true);
    expect(body.divergences).toEqual([]);
    expect(body.fleetCount).toBe(1);
    expect(body.shellCount).toBe(1);
    expect(body.compared).toBe(1);
    expect(body.shell.parkedLines).toBe(1);
  });

  it('refuses when the shell parked list is unreadable or secret-shaped', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);
    // A directory at the parked path makes readFile fail with EISDIR, which
    // the legacy reader adapter reports as `unreadable`.
    await fs.mkdir(path.join(stateDir, 'parked'));

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      outcome: 'refused',
      reason: 'shell-queue-unreadable',
      kind: 'enqueue-set',
    });
    expect(result.out).not.toContain(stateDir);
  });

  it('refuses a secret-shaped shell parked list without echoing the secret', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);
    const secret = ['sk', '-', 'aB3cD5eF7gH9iJ1kL2mN3'].join('');
    await fs.writeFile(path.join(stateDir, 'parked'), `7 ${HEAD_A} main\n${secret}\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      outcome: 'refused',
      reason: 'secret-shaped',
      kind: 'enqueue-set',
    });
    expect(result.out).not.toContain(secret);
  });

  it('reports unknown shell parked lines by number without echoing them', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);
    const badLine = 'not a parked line';
    await fs.writeFile(path.join(stateDir, 'parked'), `7 ${HEAD_A} main\n${badLine}\n`);

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    const body = JSON.parse(result.out) as { outcome: string; equal: boolean; complete: boolean; shell: { unknownLines: number[] } };
    expect(body.outcome).toBe('unknown');
    expect(body.equal).toBe(false);
    expect(body.outcome).toBe('unknown');
    expect(body.complete).toBe(false);
    expect(body.shell.unknownLines).toEqual([2]);
    expect(result.out).not.toContain(badLine);
  });

  it('reports an unreadable chains directory as null and incomplete, never as zero', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);
    // A regular file where the chains directory is expected makes readdir fail
    // with ENOTDIR, which the legacy reader adapter reports as `unreadable`.
    await fs.writeFile(path.join(stateDir, 'chains'), 'not a directory');

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    const body = JSON.parse(result.out) as {
      outcome: string;
      complete: boolean;
      shell: { chainFiles: number | null };
    };
    expect(body.outcome).toBe('unknown');
    expect(body.complete).toBe(false);
    expect(body.shell.chainFiles).toBeNull();
    expect(result.out).not.toContain(stateDir);
  });

  it('reports an unreadable batch file as null and incomplete, never as zero', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cutover-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await enqueue(runtime, { owner: 'fleet', repo: 'v2' }, 7, HEAD_A, ulid(1));
    await fs.writeFile(path.join(stateDir, 'queue'), `7 ${HEAD_A} main\n`);
    // A directory at the batch path makes readFile fail with EISDIR, which
    // the legacy reader adapter reports as `unreadable`.
    await fs.mkdir(path.join(stateDir, 'batch'));

    const result = await cli(runtime, shadowReportArgs(stateDir));
    expect(result.code).toBe(1);
    const body = JSON.parse(result.out) as {
      outcome: string;
      complete: boolean;
      shell: { batchLines: number | null };
    };
    expect(body.outcome).toBe('unknown');
    expect(body.complete).toBe(false);
    expect(body.shell.batchLines).toBeNull();
    expect(result.out).not.toContain(stateDir);
  });
});
