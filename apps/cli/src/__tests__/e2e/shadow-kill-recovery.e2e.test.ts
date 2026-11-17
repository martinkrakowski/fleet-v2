/**
 * S10 (shadow one-time criterion): three kill-9 mid-pass recovery e2e tests.
 * Cutover plan §3.2 (S10): "Three kill-9 tests mid-pass: lease takeover, no
 * duplicate action", referencing daemon-tick plan §4.3(2).
 *
 * Every test runs end to end through the CLI composition
 * (`createFleetCliRuntime` + `runCli(['daemon', 'tick'], ...)`) with real
 * file-backed stores under a temporary state directory and fakes only at the
 * port boundary (the `gh` runner and the `daemonNow` clock). No network, no
 * real host, no real daemon, and no sleeps on the real clock: the injected
 * `daemonNow` returns a fixed base instant plus a test-controlled offset, so
 * lease expiries advance deterministically.
 *
 * A kill is simulated by snapshotting the state directory (a real `cpSync`)
 * at a named point of a real `daemon tick`, driven by the same fake clock the
 * tick itself reads — never by hand-writing lease or journal rows. Recovery
 * then runs `daemon tick` on a fresh composition over the copied directory.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sha256HexDigest,
  type DaemonStatusRecord,
  type GhInvocationResult,
} from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime, type FleetCliRuntimeOptions } from '../../composition.js';
import { runCli, type CliIo } from '../../index.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD12 = HEAD.slice(0, 12);
const OWNER = 'fleet-org';
const REPO_A = 'alpha';

/** The base instant every clock read in this file answers, fixed once at load. */
const T0 = new Date().toISOString();

let clockOffsetMs = 0;

function clockIso(): string {
  return new Date(Date.parse(T0) + clockOffsetMs).toISOString();
}

/** Advance the injected clock without any real sleep. */
function advance(ms: number): void {
  clockOffsetMs += ms;
}

function clockIsoPlus(ms: number): string {
  return new Date(Date.parse(clockIso()) + ms).toISOString();
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// CO-WD9a: no test in this file may ever start a real speech program, even when
// a developer has FLEET_AUDIBLE_ALERT set in their own shell.
beforeEach(() => {
  clockOffsetMs = 0;
  vi.stubEnv('FLEET_AUDIBLE_ALERT', '');
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-sht2-'));
  tempDirs.push(dir);
  return dir;
}

function digestOf(repo: string): string {
  return sha256HexDigest(`${OWNER}/${repo}`).slice(0, 12);
}

function leaseScope(repo: string): string {
  return `merge/${digestOf(repo)}`;
}

function mergePassJobId(repo: string): string {
  return `merge-pass:${digestOf(repo)}`;
}

function journalKey(repo: string, pullRequest = 1): string {
  return `merge/${digestOf(repo)}/${pullRequest}/${HEAD12}/merge-pr`;
}

/** A minimal valid v2 installation with a github forge and the named merge repositories. */
function installation(repos: readonly string[]): FleetInstallation {
  const merge: Record<string, unknown> = {};
  for (const repo of repos) {
    merge[`${OWNER}/${repo}`] = {
      projectId: `proj-${repo}`,
      shadow: true,
      unattended: true,
      requiredContexts: ['gate'],
      checksGraceMinutes: 5,
    };
  }
  return {
    schemaVersion: 2,
    hosts: {
      'lane-host': {
        transport: 'local',
        worktreeRoot: '/srv/fleet/worktrees',
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
    tools: ['opencode'],
    seats: [
      {
        id: 'implementer',
        tool: 'opencode',
        model: 'example-provider/example-model',
        roles: ['implementer'],
        costClass: 'plan-quota',
      },
    ],
    chains: { implementer: [{ seatId: 'implementer' }] },
    policy: { merge: { repos: merge } },
    shelf: { provider: 'local' },
    forge: { mode: 'github', owner: OWNER, repo: REPO_A },
    verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
  } as unknown as FleetInstallation;
}

function pullRequestAnswer(conclusion = 'SUCCESS'): string {
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
              nodes: [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion }],
            },
          },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    },
  });
}

interface GhStub {
  readonly calls: Array<{ readonly args: readonly string[]; readonly timeoutMs: number | undefined }>;
  run: NonNullable<FleetCliRuntimeOptions['forgeGhRunner']>;
}

function ghStub(conclusion = 'SUCCESS'): GhStub {
  const stub: GhStub = {
    calls: [],
    run: async (args, timeoutMs) => {
      stub.calls.push({ args: [...args], timeoutMs });
      if (args[0] === 'api' && args[1] === 'rate_limit') {
        return { exitCode: 0, stdout: '{"resources":{}}', stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { exitCode: 0, stdout: pullRequestAnswer(conclusion), stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
    },
  };
  return stub;
}

async function run(
  runtime: FleetCliRuntime,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

function lastJson(out: string): Record<string, unknown> {
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

function jobOf(json: Record<string, unknown>, jobId: string): Record<string, unknown> | undefined {
  const jobs = json.jobs as Array<Record<string, unknown>> | undefined;
  return jobs?.find((job) => job.jobId === jobId);
}

/** The enqueue stamps derive from the injected clock, never `new Date()`. */
async function enqueue(runtime: FleetCliRuntime, repo: string, pullRequest = 1): Promise<void> {
  const decision = await runtime.execution.enqueueMerge.enqueue({
    repository: { owner: OWNER, repo },
    pullRequest,
    headOid: HEAD,
    tier: 0,
    enqueuedBy: 'conductor',
    runId: null,
    entryId: runtime.conductor.newUlid(),
    successorEntryId: runtime.conductor.newUlid(),
    enqueuedAtIso: clockIso(),
    deadlineIso: clockIsoPlus(3_600_000),
  });
  expect(decision.outcome).toBe('created');
}

/** A JSON-array state file's records (an absent or non-array file reads as empty). */
function recordsOf(stateDir: string, fileName: string): Array<Record<string, unknown>> {
  if (!existsSync(path.join(stateDir, fileName))) {
    return [];
  }
  const parsed: unknown = JSON.parse(readFileSync(path.join(stateDir, fileName), 'utf8'));
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((record): record is Record<string, unknown> => typeof record === 'object' && record !== null);
}

function journalEntriesFor(stateDir: string, key: string): Array<Record<string, unknown>> {
  return recordsOf(stateDir, 'run-journal.json').filter((entry) => entry.key === key);
}

function readStatus(stateDir: string): DaemonStatusRecord {
  return JSON.parse(readFileSync(path.join(stateDir, 'daemon', 'status.json'), 'utf8')) as DaemonStatusRecord;
}

/** True once the run journal for the key holds entries of exactly these kinds. */
function journalHasKinds(stateDir: string, key: string, kinds: readonly string[]): boolean {
  const observed = journalEntriesFor(stateDir, key).map((entry) => entry.kind);
  return observed.length === kinds.length && kinds.every((kind, index) => observed[index] === kind);
}

/** A fresh composition over an existing (often copied) state directory. */
function runtimeOver(stateDir: string, gh = ghStub()): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation: installation([REPO_A]),
    forgeGhRunner: gh.run,
    daemonNow: () => clockIso(),
  });
}

/**
 * A harness whose clock snapshots the state directory (a real recursive copy)
 * the first time a clock read observes `when()` — the named mid-pass moment of
 * a real `daemon tick`. Recovery runs against the copy on fresh compositions.
 */
function killingHarness(
  when: (stateDir: string) => boolean,
  gh = ghStub(),
): { readonly stateDir: string; readonly killDir: string; readonly runtime: FleetCliRuntime } {
  const stateDir = tempDir();
  const killDir = path.join(tempDir(), 'state');
  let copied = false;
  const runtime = createFleetCliRuntime({
    stateDir,
    installation: installation([REPO_A]),
    forgeGhRunner: gh.run,
    daemonNow: () => {
      if (!copied && when(stateDir)) {
        cpSync(stateDir, killDir, { recursive: true });
        copied = true;
      }
      return clockIso();
    },
  });
  return { stateDir, killDir, runtime };
}

describe('S10: shadow kill-9 mid-pass recovery', () => {
  it('S10 kill-9 #1: lease takeover completes open shadow intent without duplicate intent', async () => {
    // The kill lands between the `intent` append and the `result` append: the
    // copy is taken at the clock read that stamps the result, before the
    // result itself is journalled.
    const h = killingHarness((stateDir) => journalHasKinds(stateDir, journalKey(REPO_A), ['intent']));
    await enqueue(h.runtime, REPO_A);

    const first = await run(h.runtime, ['daemon', 'tick']);
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    expect(existsSync(h.killDir), readFileSync(path.join(h.stateDir, 'run-journal.json'), 'utf8')).toBe(true);
    // typed `lease-held` skip and journals nothing new.
    advance(10_000);
    const whileHeld = runtimeOver(h.killDir);
    const held = await run(whileHeld, ['daemon', 'tick']);
    expect(held.code).toBe(0);
    expect(jobOf(lastJson(held.out), mergePassJobId(REPO_A))).toMatchObject({
      outcome: 'skipped',
      reasonCode: 'lease-held',
    });
    expect((await whileHeld.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).map((e) => e.kind)).toEqual([
      'intent',
    ]);

    // Past the lease expiry the fresh tick takes over the lease (fence 2) and
    // completes the open intent without a second one.
    advance(110_000); // clock now T0 + 120_000 ms, past leaseUntil (T0 + 55 s)
    const recovery = runtimeOver(h.killDir);
    const result = await run(recovery, ['daemon', 'tick']);
    expect(result.code).toBe(0);
    expect(lastJson(result.out)).toMatchObject({ outcome: 'completed', exitCode: 0 });
    expect(jobOf(lastJson(result.out), mergePassJobId(REPO_A))).toMatchObject({ outcome: 'completed' });
    const status = readStatus(h.killDir);
    expect(status.jobs.find((job) => job.jobId === mergePassJobId(REPO_A))).toMatchObject({
      outcome: 'completed',
      leaseFence: 2,
    });
    const journal = await recovery.conductor.laneRunJournal.listForKey(journalKey(REPO_A));
    expect(journal.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge' });
    const lease = await recovery.daemon.lease.read(leaseScope(REPO_A));
    expect(lease === null || Date.parse(lease.leaseUntilIso) <= Date.parse(clockIso())).toBe(true);
    expect(existsSync(path.join(h.killDir, 'daemon', 'status.json'))).toBe(true);
    expect(existsSync(path.join(h.killDir, 'daemon', 'events.jsonl'))).toBe(true);
  });

  it('S10 kill-9 #2: lease takeover after journalled result does not duplicate action', async () => {
    // The kill lands after both `intent` and `result` are journalled but
    // before the lease release and the tick's status write: the copy is taken
    // at the release-lease clock read, with the lease file still on disk.
    const h = killingHarness((stateDir) => journalHasKinds(stateDir, journalKey(REPO_A), ['intent', 'result']));
    await enqueue(h.runtime, REPO_A);

    const first = await run(h.runtime, ['daemon', 'tick']);
    expect(first.code).toBe(0);
    expect(existsSync(h.killDir)).toBe(true);

    // Before the lease expires: refused takeover, no new journal rows.
    advance(10_000);
    const whileHeld = runtimeOver(h.killDir);
    const held = await run(whileHeld, ['daemon', 'tick']);
    expect(held.code).toBe(0);
    expect(jobOf(lastJson(held.out), mergePassJobId(REPO_A))).toMatchObject({
      outcome: 'skipped',
      reasonCode: 'lease-held',
    });
    expect((await whileHeld.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).map((e) => e.kind)).toEqual([
      'intent',
      'result',
    ]);

    // Past the expiry: lease takeover at fence 2, the journalled result is
    // never acted on twice, and the tick reports a clean exit.
    advance(110_000);
    const recovery = runtimeOver(h.killDir);
    const result = await run(recovery, ['daemon', 'tick']);
    expect(result.code).toBe(0);
    expect(lastJson(result.out)).toMatchObject({ outcome: 'completed', exitCode: 0 });
    const status = readStatus(h.killDir);
    expect(status.jobs.find((job) => job.jobId === mergePassJobId(REPO_A))).toMatchObject({
      leaseFence: 2,
    });
    expect(status.exitCode).toBe(0);
    const journal = await recovery.conductor.laneRunJournal.listForKey(journalKey(REPO_A));
    expect(journal.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge' });
    const lease = await recovery.daemon.lease.read(leaseScope(REPO_A));
    expect(lease === null || Date.parse(lease.leaseUntilIso) <= Date.parse(clockIso())).toBe(true);
  });

  it('S10 kill-9 #3: lease takeover preserves park transition without incrementing attempt or revision', async () => {
    // A failing `gate` check decides a `checks` park; the kill lands mid-pass,
    // after the decision and before the lease release: the copy is taken at
    // the first clock read after the forge read, with the lease file still on
    // disk. Today the composed notification transport refuses every park
    // notice, so the park transition itself is not persisted by this tick;
    // the invariant the takeover must keep is the same either way: the queue
    // entry's attempt and revision never move (the `sameMergeEntryContent`
    // guard of `recordPark`).
    const gh = ghStub('FAILURE');
    let sawGraphql = false;
    const base = gh.run;
    gh.run = (args, timeoutMs) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        sawGraphql = true;
      }
      return base(args, timeoutMs);
    };
    const h = killingHarness(() => sawGraphql, gh);
    await enqueue(h.runtime, REPO_A);

    const first = await run(h.runtime, ['daemon', 'tick']);
    expect(first.code).toBe(0);
    expect(existsSync(h.killDir)).toBe(true);

    const query = { repository: { owner: OWNER, repo: REPO_A }, deadlineIso: clockIsoPlus(60_000) };
    const beforeRecovery = await runtimeOver(h.killDir, ghStub('FAILURE')).execution.mergeQueueRepository.listMergeEntries(query);
    expect(beforeRecovery).toHaveLength(1);
    const killedEntry = beforeRecovery[0];

    // Before the lease expires: refused takeover.
    advance(10_000);
    const whileHeld = runtimeOver(h.killDir, ghStub('FAILURE'));
    const held = await run(whileHeld, ['daemon', 'tick']);
    expect(held.code).toBe(0);
    expect(jobOf(lastJson(held.out), mergePassJobId(REPO_A))).toMatchObject({
      outcome: 'skipped',
      reasonCode: 'lease-held',
    });

    // Past the expiry: lease takeover at fence 2, and the entry is preserved:
    // same state, same attempt, same revision.
    advance(110_000);
    const recovery = runtimeOver(h.killDir, ghStub('FAILURE'));
    const result = await run(recovery, ['daemon', 'tick']);
    expect(result.code).toBe(0);
    expect(lastJson(result.out)).toMatchObject({ outcome: 'completed', exitCode: 0 });
    const status = readStatus(h.killDir);
    expect(status.jobs.find((job) => job.jobId === mergePassJobId(REPO_A))).toMatchObject({
      leaseFence: 2,
    });
    const after = await recovery.execution.mergeQueueRepository.listMergeEntries(query);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      state: killedEntry.state,
      attempt: killedEntry.attempt,
      revision: killedEntry.revision,
    });
    const lease = await recovery.daemon.lease.read(leaseScope(REPO_A));
    expect(lease === null || Date.parse(lease.leaseUntilIso) <= Date.parse(clockIso())).toBe(true);
  });
});

describe('S10 refusals', () => {
  it('refuses takeover while lease is still held (lease-held)', async () => {
    // The killed state comes from a real tick: its `gh` fake never answers the
    // graphql read, so the tick holds the lease with nothing journalled.
    const stateDir = tempDir();
    const gh = ghStub();
    let resolveGraphql: (result: GhInvocationResult) => void = () => undefined;
    const graphqlEntered = new Promise<void>((resolveEntered) => {
      const base = gh.run;
      gh.run = (args, timeoutMs) => {
        if (args[0] === 'api' && args[1] === 'graphql') {
          resolveEntered();
          return new Promise<GhInvocationResult>((resolveAnswer) => {
            resolveGraphql = resolveAnswer;
          });
        }
        return base(args, timeoutMs);
      };
    });
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installation([REPO_A]),
      forgeGhRunner: gh.run,
      daemonNow: () => clockIso(),
    });
    await enqueue(runtime, REPO_A);

    const killed = run(runtime, ['daemon', 'tick']);
    await graphqlEntered; // the merge lease is already taken and held here

    // A fresh tick over the same state directory is refused while the lease is
    // live, and the journal is unchanged.
    const whileHeld = runtimeOver(stateDir);
    const held = await run(whileHeld, ['daemon', 'tick']);
    expect(held.code).toBe(0);
    expect(jobOf(lastJson(held.out), mergePassJobId(REPO_A))).toMatchObject({
      outcome: 'skipped',
      reasonCode: 'lease-held',
    });
    expect(await whileHeld.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).toHaveLength(0);

    // Let the killed tick finish its own pass: the recovery tick wrote nothing,
    // so the journal ends with exactly one intent and one result.
    resolveGraphql({ exitCode: 0, stdout: pullRequestAnswer(), stderr: '' });
    const settled = await killed;
    expect(settled.code).toBe(0);
    expect((await whileHeld.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).map((e) => e.kind)).toEqual([
      'intent',
      'result',
    ]);
  });

  it('refuses pass when lease file is unreadable or malformed (lease-unreadable)', async () => {
    const stateDir = tempDir();
    const runtime = runtimeOver(stateDir);
    await enqueue(runtime, REPO_A);
    const leaseFile = path.join(stateDir, 'daemon', 'leases', 'merge', `${digestOf(REPO_A)}.json`);
    const held = await runtime.daemon.lease.acquire({
      scope: leaseScope(REPO_A),
      holderId: `tick-${runtime.conductor.newUlid()}`,
      observedFence: 0,
      leaseUntilIso: clockIsoPlus(60_000),
      nowIso: clockIso(),
    });
    expect(held.outcome, JSON.stringify(held)).toBe('ok');

    const variants: Array<[string, string]> = [
      ['invalid json', '{ not json'],
      ['null', 'null'],
      ['array', '[]'],
      ['malformed record', JSON.stringify({ version: 1, scope: leaseScope(REPO_A), holderId: 'x' })],
    ];
    for (const [label, bytes] of variants) {
      writeFileSync(leaseFile, bytes, 'utf8');
      const result = await run(runtime, ['daemon', 'tick']);
      expect(result.code, label).toBe(1);
      expect(jobOf(lastJson(result.out), mergePassJobId(REPO_A)), label).toMatchObject({
        outcome: 'refused',
        reasonCode: 'lease-unreadable',
      });
      expect(await runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_A)), label).toHaveLength(0);
    }
  });
});
