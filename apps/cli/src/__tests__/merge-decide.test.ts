/**
 * S1U2: `merge decide` end to end through the real composition
 * (`createFleetCliRuntime`) against a temporary state directory: a real
 * file-backed `LaneRunJournalAdapter` journal, a real file-backed
 * `MergeQueueRepositoryAdapter` queue and a stub `gh` runner fake (no network,
 * no git, no real forge). No hostname, address or token in any fixture; every
 * id is minted at runtime.
 */

import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  LaneRunJournalAdapter,
  sha256HexDigest,
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const OWNER = 'example-owner';
const REPO = 'example-repo';
const PROJECT_ID = 'proj-example';
const HEAD = '3dd5d90509461e3d2154b52da28671aeffa84130';
const HEAD12 = HEAD.slice(0, 12);
const SHORT_HEAD = HEAD.slice(0, 39);
const DIGEST = sha256HexDigest(`${OWNER}/${REPO}`).slice(0, 12);
const JOURNAL_KEY = `merge/${DIGEST}/7/${HEAD12}/merge-pr`;
const REPOSITORY_ARG = `${OWNER}/${REPO}`;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-merge-decide-'));
  tempDirs.push(dir);
  return dir;
}

/** Minimal valid v2 installation: one merge repository under a shadow policy. */
function installation(policyRepos: Record<string, unknown>): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-s1u2-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    policy: { merge: { repos: policyRepos } },
    shelf: { provider: 'local' },
    forge: { mode: 'github', owner: OWNER, repo: REPO },
    verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
  } as unknown as FleetInstallation;
}

function shadowRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    shadow: true,
    unattended: true,
    requiredContexts: ['gate'],
    checksGraceMinutes: 5,
    ...overrides,
  };
}

/** A green pull-request GraphQL page: OPEN at HEAD, CLEAN, gate succeeded. */
function greenPage(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          headRefOid: HEAD,
          mergeStateStatus: 'CLEAN',
          baseRefName: 'main',
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
              ],
            },
          },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    },
  });
}

interface RunnerFake {
  readonly calls: Array<{ readonly args: readonly string[]; readonly timeoutMs: number | undefined }>;
  run: (args: readonly string[], timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function greenForgeFake(): RunnerFake {
  const fake: RunnerFake = {
    calls: [],
    run: async (args, timeoutMs) => {
      fake.calls.push({ args: [...args], timeoutMs });
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { exitCode: 0, stdout: greenPage(), stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
    },
  };
  return fake;
}

/** A fresh runtime over one temporary state dir, one policy and one gh fake. */
function runtimeFor(
  policyRepos: Record<string, unknown>,
  forgeGhRunner: (args: readonly string[], timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): { runtime: FleetCliRuntime; stateDir: string } {
  const stateDir = tempDir();
  const runtime = createFleetCliRuntime({ stateDir, installation: installation(policyRepos), forgeGhRunner });
  return { runtime, stateDir };
}

async function runDecide(
  runtime: FleetCliRuntime,
  extraArgv: readonly string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await runCli(['merge', 'decide', ...extraArgv], io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

function decideArgv(pullRequest = 7): string[] {
  return ['--repository', REPOSITORY_ARG, '--pull-request', String(pullRequest), '--head', HEAD, '--timeout', '8s'];
}

async function queueSnapshot(
  runtime: FleetCliRuntime,
): Promise<readonly unknown[]> {
  return runtime.execution.mergeQueueRepository.listMergeEntries({
    repository: { owner: OWNER, repo: REPO },
    deadlineIso: new Date(Date.now() + 60_000).toISOString(),
  });
}

/** Seed one queued entry for the decided pair, like the conductor would. */
async function seedQueueEntry(runtime: FleetCliRuntime, pullRequest = 7): Promise<void> {
  const decision = await runtime.execution.mergeQueueRepository.enqueueMergeEntry({
    repository: { owner: OWNER, repo: REPO },
    pullRequest,
    headOid: HEAD,
    tier: 0,
    enqueuedBy: 'cli',
    runId: null,
    entryId: runtime.conductor.newUlid(),
    successorEntryId: runtime.conductor.newUlid(),
    enqueuedAtIso: new Date().toISOString(),
    deadlineIso: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(decision.outcome).toBe('created');
}

/** Every stored run-journal row, read straight from the store file (a bare entry array). */
async function rawJournalRows(stateDir: string): Promise<readonly LaneRunJournalEntryRecord[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(path.join(stateDir, 'run-journal.json'), 'utf8'));
  return Array.isArray(parsed) ? (parsed as LaneRunJournalEntryRecord[]) : [];
}

async function journalRowsFor(
  stateDir: string,
  key: string | null,
): Promise<readonly LaneRunJournalEntryRecord[]> {
  const journal = new LaneRunJournalAdapter({ stateDir });
  if (key === null) {
    return journal.listForKeyPrefix(`merge/${DIGEST}/`);
  }
  return journal.listForKey(key);
}

describe('merge decide', () => {
  it('exits 0, journals exactly one would-merge result under the merge-pr key and leaves the queue untouched', async () => {
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, greenForgeFake().run);
    await seedQueueEntry(runtime);
    const before = await queueSnapshot(runtime);
    expect(before).toHaveLength(1);

    const result = await runDecide(runtime, decideArgv());

    expect(result.code).toBe(0);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(printed['outcome']).toBe('journalled');
    expect(printed['reasonCode']).toBe('would-merge');
    expect(printed['journalKey']).toBe(JOURNAL_KEY);

    // The real queue is untouched: byte-for-byte the same entry list.
    expect(await queueSnapshot(runtime)).toEqual(before);

    // The journal file holds one intent and one final would-merge result.
    const rows = await journalRowsFor(stateDir, JOURNAL_KEY);
    expect(rows).toHaveLength(2);
    const intents = rows.filter((row) => row.kind === 'intent');
    const results = rows.filter((row) => row.kind === 'result');
    expect(intents).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.reasonCode).toBe('would-merge');
    expect(results[0]?.outcome).toBe('dry-run');
  });

  it('answers not-ready not-queue-head (exit 1) and journals nothing when an earlier live queue entry of the same repository holds the head', async () => {
    const forge = greenForgeFake();
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, forge.run);
    await seedQueueEntry(runtime, 3);
    const before = await queueSnapshot(runtime);

    const result = await runDecide(runtime, decideArgv(7));

    expect(result.code).toBe(1);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(printed['outcome']).toBe('not-ready');
    expect(printed['reasonCode']).toBe('not-queue-head');
    expect(forge.calls).toHaveLength(0);
    expect(await journalRowsFor(stateDir, null)).toHaveLength(0);
    expect(await queueSnapshot(runtime)).toEqual(before);
  });

  it('survives twenty concurrent journal writers: every decide row and every appended conduct row is present, none lost or torn', async () => {
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, greenForgeFake().run);
    await seedQueueEntry(runtime);
    const sideWriter = new LaneRunJournalAdapter({ stateDir });
    const sideRunId = `run-${runtime.conductor.newUlid()}`;

    for (let round = 0; round < 20; round += 1) {
      const conductEntry: LaneRunJournalEntryRecord = {
        version: LANE_RUN_JOURNAL_ENTRY_VERSION,
        entryId: runtime.conductor.newUlid(),
        kind: 'conduct',
        key: null,
        runId: sideRunId,
        recordedAtIso: new Date().toISOString(),
        mode: null,
        expectedRevision: null,
        mintedId: null,
        outcome: null,
        reasonCode: null,
        detail: null,
        grantId: null,
        state: 'merging',
      };
      const [decide] = await Promise.all([
        runDecide(runtime, decideArgv()),
        sideWriter.append(conductEntry),
      ]);
      expect(decide.code).toBe(0);
    }

    const allRows = await rawJournalRows(stateDir);
    const conductRows = allRows.filter((row) => row.kind === 'conduct' && row.runId === sideRunId);
    expect(conductRows).toHaveLength(20);
    // The decide's own rows under its key are intact alongside the racing writer.
    const decideRows = await journalRowsFor(stateDir, JOURNAL_KEY);
    expect(decideRows).toHaveLength(2);
    expect(decideRows.filter((row) => row.kind === 'result')).toHaveLength(1);
    expect(decideRows.filter((row) => row.kind === 'intent')).toHaveLength(1);
  });

  it('honours the deadline without a race: a forge fake that settles at its timeoutMs is called and the result is a refusal-family exit inside 15s', { timeout: 20_000 }, async () => {
    let calls = 0;
    const forgeGhRunner = async (args: readonly string[], timeoutMs?: number) => {
      calls += 1;
      if (args[0] === 'api' && args[1] === 'graphql') {
        // Settle exactly at the budget the caller granted: a timeout answer,
        // never an abandoned read.
        await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? 1));
        return { exitCode: 124, stdout: '', stderr: 'timed out' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
    };
    const { runtime } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, forgeGhRunner);
    await seedQueueEntry(runtime);

    const started = Date.now();
    const result = await runDecide(runtime, decideArgv());
    const elapsedMs = Date.now() - started;

    expect(calls).toBeGreaterThan(0); // the fake WAS called, not skipped
    expect(result.code).toBe(1);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(['budget-exhausted', 'not-ready', 'refused']).toContain(printed['outcome']);
    expect(elapsedMs).toBeLessThan(15_000);
  });

  it('leaves exactly one intent and one would-merge result for the key when two identical decides race', async () => {
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, greenForgeFake().run);
    await seedQueueEntry(runtime);

    const [first, second] = await Promise.all([
      runDecide(runtime, decideArgv()),
      runDecide(runtime, decideArgv()),
    ]);

    expect([first.code, second.code]).toContain(0);
    expect([first.code, second.code].every((code) => code === 0 || code === 1)).toBe(true);

    const rows = await journalRowsFor(stateDir, JOURNAL_KEY);
    expect(rows.filter((row) => row.kind === 'intent')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]?.reasonCode).toBe('would-merge');
  });

  describe('usage errors exit 2 and call nothing', () => {
    it.each([
      ['a missing --head', ['--repository', REPOSITORY_ARG, '--pull-request', '7']],
      ['a 39-character --head', ['--repository', REPOSITORY_ARG, '--pull-request', '7', '--head', SHORT_HEAD]],
      ['a non-numeric --pull-request', ['--repository', REPOSITORY_ARG, '--pull-request', 'seven', '--head', HEAD]],
      ['a 10-minute --timeout', ['--repository', REPOSITORY_ARG, '--pull-request', '7', '--head', HEAD, '--timeout', '10m']],
    ])('%s', async (_label, argv) => {
      const fake = greenForgeFake();
      const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, fake.run);

      const result = await runDecide(runtime, argv);

      expect(result.code).toBe(2);
      expect(result.err).toContain('merge decide');
      expect(fake.calls).toHaveLength(0);
      expect(await journalRowsFor(stateDir, null)).toHaveLength(0);
    });
  });

  it('refuses policy-unavailable (exit 1) on an invalid policy and appends nothing', async () => {
    const fake = greenForgeFake();
    // A policy whose repo entry is malformed fails closed: never known.
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo({ projectId: null }) }, fake.run);

    const result = await runDecide(runtime, decideArgv());

    expect(result.code).toBe(1);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(printed).toEqual({ outcome: 'refused', reasonCode: 'policy-unavailable', journalKey: null });
    expect(fake.calls).toHaveLength(0);
    expect(await journalRowsFor(stateDir, null)).toHaveLength(0);
  });

  it('refuses repository-not-configured (exit 1) when the policy knows other repositories only and appends nothing', async () => {
    const fake = greenForgeFake();
    const { runtime, stateDir } = runtimeFor({ 'other-owner/other-repo': shadowRepo() }, fake.run);

    const result = await runDecide(runtime, decideArgv());

    expect(result.code).toBe(1);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(printed).toEqual({ outcome: 'refused', reasonCode: 'repository-not-configured', journalKey: null });
    expect(fake.calls).toHaveLength(0);
    expect(await journalRowsFor(stateDir, null)).toHaveLength(0);
  });

  it('refuses policy-not-shadow (exit 1) for a live policy and appends nothing', async () => {
    const fake = greenForgeFake();
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo({ shadow: false }) }, fake.run);

    const result = await runDecide(runtime, decideArgv());

    expect(result.code).toBe(1);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(printed).toEqual({ outcome: 'refused', reasonCode: 'policy-not-shadow', journalKey: null });
    expect(fake.calls).toHaveLength(0);
    expect(await journalRowsFor(stateDir, null)).toHaveLength(0);
  });

  it.each([
    ['an array', [] as unknown],
    ['an object without an outcome', { reasonCode: 'would-merge', journalKey: null } as unknown],
    ['an object without a reasonCode', { outcome: 'journalled', journalKey: null } as unknown],
    ['an object without a journalKey', { outcome: 'journalled', reasonCode: 'would-merge' } as unknown],
  ])('refuses decide-failed (exit 1) when the use case returns %s instead of a typed result', async (_label, bogus) => {
    const fake = greenForgeFake();
    const { runtime, stateDir } = runtimeFor({ [REPOSITORY_ARG]: shadowRepo() }, fake.run);
    (runtime.daemon as unknown as { decideShadowMerge: unknown }).decideShadowMerge = {
      decideShadowMerge: async () => bogus,
    };

    const result = await runDecide(runtime, decideArgv());

    expect(result.code).toBe(1);
    const printed = JSON.parse(result.out) as Record<string, unknown>;
    expect(printed).toEqual({ outcome: 'refused', reasonCode: 'decide-failed', journalKey: null });
    expect(fake.calls).toHaveLength(0);
    expect(await journalRowsFor(stateDir, null)).toHaveLength(0);
  });
});
