/**
 * S2 shadow park-reasons e2e (lane SHT1), narrowed per owner decision
 * 2026-11-17: the merge-pass park reasons reachable on `origin/main` are
 * `checks`, `threads`, `forge-error`, `update-refused`, `update-churn` and
 * `owner-merge`; `conflict` drops rather than parks and an unreadable or
 * invalid installation refuses the tick before the pass (as
 * `installation-unreadable` / `policy-invalid`; the reason code
 * `policy-unreadable` itself is unreachable through the CLI). DT9b live
 * intent-without-result
 * reconcile and the deferred park inputs (`premerge`, `macos`,
 * `disjointness`, `veto-hold`) stay deferred past cutover.
 *
 * Every test drives the real CLI composition (`createFleetCliRuntime` +
 * `runCli(['daemon', 'tick'], ...)`) through the real decider and merge pass,
 * with fakes only at the port boundary (`forgeGhRunner`, `daemonNow`,
 * `daemonSleep`, `loadInstallationForMergePolicy`, the notification port, a
 * temporary `stateDir`). The notification port is faked because DT12 delivery
 * is not implemented on `origin/main`: the composed adapter fails closed, and
 * the pass must never write a transition it could not announce. No network,
 * no real host, no real daemon, no sleeps on the real clock.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMergeKey,
  computeMergeBackoffIso,
  decideMergeStep,
  MergeNotificationAdapter,
  MERGE_PARK_REASONS,
  MERGE_QUEUE_UPDATE_HOURLY_CAP,
  RunMergePassUseCase,
  sha256HexDigest,
  type GhInvocationResult,
  type MergeRepoPolicy,
  type MergeStepFacts,
} from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime, type FleetCliRuntimeOptions } from '../../composition.js';
import { runCli, type CliIo } from '../../index.js';

const NOW = '2027-01-01T00:00:00.000Z';
const OWNER = 'fleet-org';
const REPO = 'alpha';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = sha256HexDigest(`${OWNER}/${REPO}`).slice(0, 12);
const MERGE_PASS_JOB = `merge-pass:${DIGEST}`;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.stubEnv('FLEET_AUDIBLE_ALERT', '');
  // DT12 notification delivery is not implemented on origin/main: the adapter
  // refuses, and a refusing notifier must hold the transition. The tests here
  // pin that port boundary to a delivered answer so the pass's own queue
  // write (the behaviour under test) is the real one.
  vi.spyOn(MergeNotificationAdapter.prototype, 'notifyMergeEvent').mockResolvedValue({
    outcome: 'notified',
  });
});

interface RepoConfig {
  readonly projectId?: string;
  readonly shadow?: boolean;
  readonly unattended?: boolean;
  readonly updateBranch?: boolean;
}

function installation(repo: RepoConfig = {}): FleetInstallation {
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
    policy: {
      merge: {
        repos: {
          [`${OWNER}/${REPO}`]: {
            projectId: 'proj-alpha',
            shadow: true,
            unattended: true,
            requiredContexts: ['gate'],
            ...repo,
          },
        },
      },
    },
    shelf: { provider: 'local' },
    forge: { mode: 'github', owner: OWNER, repo: REPO },
    verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
  } as unknown as FleetInstallation;
}

/** One GraphQL answer: the PR meta plus the rollup contexts and review threads. */
function pullRequestPayload(input: {
  headOid?: string;
  mergeStateStatus?: string;
  failingGate?: boolean;
  unresolved?: number;
  withoutPullRequest?: boolean;
  contextsNodesNotArray?: boolean;
  threadsNodesNotArray?: boolean;
}): string {
  if (input.withoutPullRequest === true) {
    return JSON.stringify({ data: { repository: {} } });
  }
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          headRefOid: input.headOid ?? HEAD,
          mergeStateStatus: input.mergeStateStatus ?? 'CLEAN',
          baseRefName: 'main',
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: input.contextsNodesNotArray === true
                ? { count: 1 }
                : [
                    {
                      __typename: 'CheckRun',
                      name: 'gate',
                      status: 'COMPLETED',
                      conclusion: input.failingGate === true ? 'FAILURE' : 'SUCCESS',
                    },
                  ],
            },
          },
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: input.threadsNodesNotArray === true
              ? { count: 0 }
              : Array.from({ length: input.unresolved ?? 0 }, () => ({ isResolved: false })),
          },
        },
      },
    },
  });
}

interface Stub {
  /** The GraphQL answer per pull request number; the probe is always healthy. */
  graphql: (pullRequest: number) => GhInvocationResult | string;
  readonly calls: Array<{ readonly args: readonly string[] }>;
}

function ghStub(): Stub {
  const stub: Stub = { graphql: () => pullRequestPayload({}), calls: [] };
  return stub;
}

function runnerOf(stub: Stub): NonNullable<FleetCliRuntimeOptions['forgeGhRunner']> {
  return async (args) => {
    stub.calls.push({ args: [...args] });
    if (args[0] === 'api' && args[1] === 'rate_limit') {
      return { exitCode: 0, stdout: '{"resources":{}}', stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const flag = args.find((arg) => arg.startsWith('number='));
      const pullRequest = flag === undefined ? Number.NaN : Number(flag.slice('number='.length));
      const answer = stub.graphql(pullRequest);
      return typeof answer === 'string' ? { exitCode: 0, stdout: answer, stderr: '' } : answer;
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
  };
}

interface Harness {
  readonly stateDir: string;
  readonly stub: Stub;
  readonly runtime: FleetCliRuntime;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-s2-parks-'));
  tempDirs.push(dir);
  return dir;
}

function buildRuntime(
  stateDir: string,
  stub: Stub,
  repo: RepoConfig,
  runtimeOptions: Partial<FleetCliRuntimeOptions> = {},
): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation: installation(repo),
    forgeGhRunner: runnerOf(stub),
    daemonNow: () => NOW,
    daemonSleep: async () => {},
    ...runtimeOptions,
  });
}

function harness(repo: RepoConfig = {}, runtimeOptions: Partial<FleetCliRuntimeOptions> = {}): Harness {
  const stateDir = tempDir();
  const stub = ghStub();
  return { stateDir, stub, runtime: buildRuntime(stateDir, stub, repo, runtimeOptions) };
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

function tick(h: Harness, argv: readonly string[] = ['daemon', 'tick']) {
  return run(h.runtime, argv);
}

function lastJson(out: string): Record<string, unknown> {
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

function mergePassJob(json: Record<string, unknown>): Record<string, unknown> {
  const jobs = json.jobs as Array<Record<string, unknown>>;
  return jobs.find((job) => job.jobId === MERGE_PASS_JOB) as Record<string, unknown>;
}

interface StoredEntry {
  readonly pullRequest: number;
  readonly state: string;
  readonly reason: string | null;
  readonly attempt: number;
  readonly notBeforeIso: string | null;
}

function readQueue(stateDir: string): StoredEntry[] {
  return JSON.parse(readFileSync(path.join(stateDir, 'merge-queue.json'), 'utf8')) as StoredEntry[];
}

function entryFor(stateDir: string, pullRequest: number): StoredEntry {
  const records = readQueue(stateDir).filter((entry) => entry.pullRequest === pullRequest);
  // A superseded predecessor shares the pull request number; the assertions
  // here are always about the live record the pass decided on.
  const live = records.filter((entry) => !['merged', 'dropped', 'superseded'].includes(entry.state));
  const found = live.length > 0 ? live[live.length - 1] : records[records.length - 1];
  expect(found, `queue entry for PR ${pullRequest}`).toBeDefined();
  return found as StoredEntry;
}

function rewriteAttempt(stateDir: string, pullRequest: number, attempt: number): void {
  const file = path.join(stateDir, 'merge-queue.json');
  const records = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  for (const record of records) {
    if (record.pullRequest === pullRequest) {
      record.attempt = attempt;
    }
  }
  writeFileSync(file, JSON.stringify(records), 'utf8');
}

async function enqueue(
  runtime: FleetCliRuntime,
  pullRequest: number,
  options: { headOid?: string; enqueuedAtIso?: string } = {},
): Promise<void> {
  const decision = await runtime.execution.enqueueMerge.enqueue({
    repository: { owner: OWNER, repo: REPO },
    pullRequest,
    headOid: options.headOid ?? HEAD,
    tier: 0,
    enqueuedBy: 'conductor',
    runId: null,
    entryId: runtime.conductor.newUlid(),
    successorEntryId: runtime.conductor.newUlid(),
    enqueuedAtIso: options.enqueuedAtIso ?? NOW,
    deadlineIso: new Date(Date.parse(NOW) + 60_000).toISOString(),
  });
  // `created` for a new pull request, `supersedes` when the queue already
  // holds the pull request under an earlier head: both leave a readable record.
  expect(['created', 'supersedes']).toContain(decision.outcome);
}

function journalKey(
  action: 'merge-pr' | 'update-branch' | 'would-drop',
  pullRequest = 1,
  head = HEAD,
): string {
  const built = buildMergeKey({
    repoDigest: DIGEST,
    pullRequest,
    head12: head.slice(0, 12),
    action,
    attemptOrdinal: null,
    retry: null,
  });
  if (!built.ok) {
    throw new Error(`journalKey build failed: ${built.error}`);
  }
  return built.key;
}

async function appendIntent(
  runtime: FleetCliRuntime,
  key: string,
  recordedAtIso: string,
): Promise<void> {
  const appended = await runtime.conductor.laneRunJournal.append({
    version: 1,
    entryId: runtime.conductor.newUlid(),
    kind: 'intent',
    key,
    runId: null,
    recordedAtIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  } as never);
  expect(appended.outcome, `key=${key} ${JSON.stringify(appended)}`).toBe('appended');
}

/** The parked entry one park reason leaves behind: exactly `parked` with that reason. */
function expectParked(
  stateDir: string,
  pullRequest: number,
  reason: string,
  extra: { attempt?: number; notBeforeIso?: string | null } = {},
): void {
  expect(entryFor(stateDir, pullRequest)).toMatchObject({
    state: 'parked',
    reason,
    ...extra,
  });
}

describe('S2 shadow park-reasons e2e (narrowed per owner decision 2026-11-17)', () => {
  it('parks `checks` with backoff when a required context fails', async () => {
    const h = harness();
    await enqueue(h.runtime, 1);
    h.stub.graphql = () => pullRequestPayload({ failingGate: true });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expectParked(h.stateDir, 1, 'checks', {
      attempt: 1,
      notBeforeIso: computeMergeBackoffIso(NOW, 0),
    });
  });

  it('journals would-drop for `checks` after maxAttempts and the entry stays live', async () => {
    // Owner decision A+ (2026-11-18): a shadow drop is never persisted — the
    // attempt-cap drop is journalled as would-drop and the entry stays live.
    const h = harness();
    await enqueue(h.runtime, 1);
    rewriteAttempt(h.stateDir, 1, 9); // the default maxAttempts is 9
    h.stub.graphql = () => pullRequestPayload({ failingGate: true });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expect(entryFor(h.stateDir, 1)).toMatchObject({
      state: 'queued',
      reason: null,
      attempt: 9,
    });
    const wouldDrop = await h.runtime.conductor.laneRunJournal.listForKey(journalKey('would-drop'));
    expect(wouldDrop.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(wouldDrop[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-drop', detail: 'checks' });
  });

  it('parks `threads` without backoff while review threads are unresolved', async () => {
    const h = harness();
    await enqueue(h.runtime, 1);
    h.stub.graphql = () => pullRequestPayload({ unresolved: 2 });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expectParked(h.stateDir, 1, 'threads', { attempt: 0, notBeforeIso: null });
  });

  it('refuses forge-error with backoff when forgeGhRunner fails or returns empty stdout', async () => {
    for (const [label, answer] of [
      ['a gh failure', (): GhInvocationResult => ({ exitCode: 1, stdout: '', stderr: 'gh exploded' })],
      ['empty stdout', (): GhInvocationResult => ({ exitCode: 0, stdout: '', stderr: '' })],
    ] as const) {
      const h = harness();
      await enqueue(h.runtime, 1);
      h.stub.graphql = answer;

      const result = await tick(h);

      expect(result.code, label).toBe(0);
      // The failure is never read as green: the entry parks with backoff and nothing is journalled.
      expectParked(h.stateDir, 1, 'forge-error', {
        attempt: 1,
        notBeforeIso: computeMergeBackoffIso(NOW, 0),
      });
      expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'))).toHaveLength(0);
      expect(h.stub.calls.some((call) => call.args[1] === 'graphql'), label).toBe(true);
    }
  });

  it('parks `update-refused` when the PR is BEHIND and policy.updateBranch is false', async () => {
    const h = harness(); // updateBranch defaults to false
    await enqueue(h.runtime, 1);
    h.stub.graphql = () => pullRequestPayload({ mergeStateStatus: 'BEHIND' });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expectParked(h.stateDir, 1, 'update-refused', { attempt: 0, notBeforeIso: null });
  });

  it('parks `update-churn` when the journal already holds the hourly cap of update-branch intents', async () => {
    const h = harness({ updateBranch: true });
    expect(MERGE_QUEUE_UPDATE_HOURLY_CAP).toBe(3);
    // One update-branch intent per known head of the pull request: each
    // enqueued update supersedes its predecessor, so the queue remembers the
    // earlier heads and the per-head keys are how the journal counts this
    // pull request's updates in the last hour.
    const heads = [
      '0123456789abcdef0123456789abcdef01234567',
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
    ];
    for (const head of heads) {
      await enqueue(h.runtime, 1, { headOid: head });
      await appendIntent(
        h.runtime,
        journalKey('update-branch', 1, head),
        new Date(Date.parse(NOW) - 60_000).toISOString(),
      );
    }
    // The live successor's read must see its own head, or the read supersedes
    // the entry before the update row ever runs.
    h.stub.graphql = () => pullRequestPayload({ headOid: heads[heads.length - 1], mergeStateStatus: 'BEHIND' });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expectParked(h.stateDir, 1, 'update-churn', { attempt: 0, notBeforeIso: null });
  });

  it('parks `owner-merge` when the policy is neither shadow nor unattended on a ready entry', async () => {
    const h = harness({ shadow: false, unattended: false });
    await enqueue(h.runtime, 1);

    const result = await tick(h);

    expect(result.code).toBe(0);
    expectParked(h.stateDir, 1, 'owner-merge', { notBeforeIso: null });
    // The owner gate held: no merge intent was journalled, silently or otherwise.
    expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'))).toHaveLength(0);
  });

  it('drops a DIRTY PR for conflict (decider) and isolates a planted failing PR while a healthy sibling still merges (e2e)', async () => {
    // The decider row itself: a DIRTY merge state drops the entry for `conflict`.
    const dirty = decideMergeStep(deciderEntry(), deciderFacts('DIRTY'), deciderPolicy(), NOW);
    expect(dirty).toMatchObject({ kind: 'drop', reason: 'conflict' });
    const blocked = decideMergeStep(deciderEntry(), deciderFacts('BLOCKED'), deciderPolicy(), NOW);
    expect(blocked).toMatchObject({ kind: 'wait', reason: 'merge-state-blocked' });

    // End to end: the planted failing PR parks, the healthy sibling still completes.
    const siblingHead = 'fedcba9876543210fedcba9876543210fedcba98';
    const h = harness();
    await enqueue(h.runtime, 1);
    await enqueue(h.runtime, 2, { headOid: siblingHead });
    h.stub.graphql = (pullRequest) =>
      pullRequest === 1 ? pullRequestPayload({ failingGate: true }) : pullRequestPayload({ headOid: siblingHead });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expectParked(h.stateDir, 1, 'checks');
    const sibling = await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr', 2, siblingHead));
    expect(sibling.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(sibling[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge' });
  });

  it('holds a DIRTY PR fail-closed end to end while a healthy sibling still merges (e2e)', async () => {
    // The forge read adapter maps GitHub's `DIRTY` to the domain token
    // `blocked` (ForgeReadAdapter.adapter.ts:108-113), so through the CLI a
    // DIRTY merge state never reaches the decider's `DIRTY → drop conflict`
    // row (merge-queue-decider.ts:1071-1073): it fail-closes as a wait and the
    // pass persists nothing. The decider-level drop is proved in the next
    // test; this case proves the e2e isolation: the held PR is never acted
    // on while the healthy sibling completes.
    const siblingHead = '0fedcba9876543210fedcba9876543210fedcba9';
    const h = harness();
    await enqueue(h.runtime, 1);
    await enqueue(h.runtime, 2, { headOid: siblingHead });
    h.stub.graphql = (pullRequest) =>
      pullRequest === 1
        ? pullRequestPayload({ mergeStateStatus: 'DIRTY' })
        : pullRequestPayload({ headOid: siblingHead });

    const result = await tick(h);

    expect(result.code).toBe(0);
    expect(entryFor(h.stateDir, 1)).toMatchObject({ state: 'queued', reason: null });
    expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr', 1))).toHaveLength(0);
    const sibling = await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr', 2, siblingHead));
    expect(sibling.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(sibling[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge' });
  });

  it('completes a shadow open intent left without a result by an earlier pass', async () => {
    const h = harness();
    await enqueue(h.runtime, 1);
    await appendIntent(h.runtime, journalKey('merge-pr'), NOW);

    const result = await tick(h);

    expect(result.code).toBe(0);
    const journal = await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'));
    expect(journal.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge' });
  });

  it('accounts for every MERGE_PARK_REASONS entry as tested here or explicitly deferred', () => {
    const tested: readonly string[] = [
      'checks',
      'threads',
      'forge-error',
      'update-refused',
      'update-churn',
      'owner-merge',
    ];
    // Not reachable as a park on origin/main today: `conflict` drops rather
    // than parks, an unreadable or invalid installation refuses the tick
    // before the pass (as `installation-unreadable` / `policy-invalid`; the
    // reason code `policy-unreadable` itself is unreachable through the CLI),
    // and `premerge`, `macos`, `disjointness` and `veto-hold` are deferred
    // past cutover with DT9b.
    const deferredOrDropping: readonly string[] = [
      'premerge',
      'macos',
      'disjointness',
      'veto-hold',
      'conflict',
      'policy-unreadable',
    ];
    for (const reason of MERGE_PARK_REASONS) {
      expect([...tested, ...deferredOrDropping], reason).toContain(reason);
    }
    for (const reason of tested) {
      expect(MERGE_PARK_REASONS, reason).toContain(reason);
    }
  });
});

describe('S2 refusal paths fail closed', () => {
  it('refuses the tick with installation-unreadable when the installation load throws', async () => {
    const h = harness({}, {
      loadInstallationForMergePolicy: (): never => {
        throw new Error('installation file unreadable');
      },
    });

    const result = await tick(h);

    // The tick refuses before the merge pass: the reason the seam names is
    // the unreadable installation, and nothing was read from the forge.
    expect(result.code).toBe(1);
    expect(lastJson(result.out)).toMatchObject({
      outcome: 'refused',
      exitCode: 1,
      reasonCode: 'installation-unreadable',
    });
    expect(h.stub.calls.some((call) => call.args[1] === 'graphql')).toBe(false);
    expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'))).toHaveLength(0);
  });

  it('refuses the tick on an invalid installation with policy-invalid (policy-unreadable is unreachable through the CLI)', async () => {
    // The brief's `policy-unreadable` reason code is not reachable through
    // `daemon tick`: MergePolicyAdapter.readMergePolicy never rejects
    // (MergePolicyAdapter.adapter.ts:351-363, a rejected readInstallation is
    // caught and returned as an answer), so `runTick`'s `policyAnswer === null`
    // branch that prints `policy-unreadable` (apps/cli/src/daemon.ts:347-350)
    // can never fire. An invalid installation load reaches the decider as
    // `{ outcome: 'invalid', reason: 'installation-invalid' }`
    // (apps/cli/src/composition/daemon.ts:123-128) and answers
    // `policy-invalid` — the real fail-closed refusal for this input.
    const h = harness({}, {
      loadInstallationForMergePolicy: () => ({ status: 'invalid', file: '/private/install.json', errors: ['bad'] }),
    });

    const result = await tick(h);

    expect(result.code).toBe(1);
    expect(lastJson(result.out)).toMatchObject({
      outcome: 'refused',
      exitCode: 1,
      reasonCode: 'policy-invalid',
    });
    // The invalid file's path and errors are never forwarded to the output.
    expect(result.out).not.toContain('/private');
    expect(h.stub.calls.some((call) => call.args[1] === 'graphql')).toBe(false);
    expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'))).toHaveLength(0);
  });

  it('parks forge-error on malformed GraphQL answers and waits on genuinely unknown facts', async () => {
    // Malformed GraphQL is fail-closed BY DESIGN as a forge-error park, not a
    // wait: `readPullRequest` returns undefined for a payload with no
    // pullRequest object (GhForgeMergeReadAdapter.adapter.ts:144-168), so
    // `parseMergePrMeta` answers `unreadable` (:312-316), `runPage` maps that
    // to `unavailable`/`unreadable` (:588-593), and `gatherFacts` maps every
    // non-ok, non-not-found read to `pr: { status: 'forge-error', code:
    // 'gh-error' }` (RunMergePassUseCase.use-case.ts:908-914), which
    // `readPathForgeStep` parks with backoff (merge-queue-decider.ts:608-627).
    // The entry is never treated as green and never acted on.
    const missing = harness();
    await enqueue(missing.runtime, 1);
    missing.stub.graphql = () => pullRequestPayload({ withoutPullRequest: true });
    expect((await tick(missing)).code).toBe(0);
    expectParked(missing.stateDir, 1, 'forge-error', {
      attempt: 1,
      notBeforeIso: computeMergeBackoffIso(NOW, 0),
    });

    // A PR the forge cannot resolve reads as `not-found`: the decider waits pr-unknown.
    const notFound = harness();
    await enqueue(notFound.runtime, 1);
    notFound.stub.graphql = () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: Could not resolve to a PullRequest with the number 1',
    });
    expect((await tick(notFound)).code).toBe(0);
    expect(entryFor(notFound.stateDir, 1)).toMatchObject({ state: 'queued', reason: null, attempt: 0 });
    expect(await notFound.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'))).toHaveLength(0);

    // An unknown mergeStateStatus token waits instead of acting.
    const unknownState = harness();
    await enqueue(unknownState.runtime, 1);
    unknownState.stub.graphql = () => pullRequestPayload({ mergeStateStatus: 'WIBBLE' });
    expect((await tick(unknownState)).code).toBe(0);
    expect(entryFor(unknownState.stateDir, 1)).toMatchObject({ state: 'queued', reason: null, attempt: 0 });
  });

  it('parks forge-error when contexts.nodes is not an array and waits threads-unknown when reviewThreads.nodes is not an array', async () => {
    // A non-array `contexts.nodes` makes the contexts page unreadable
    // (GhForgeMergeReadAdapter.adapter.ts:259-262), so the whole read is
    // `unavailable`/`unreadable` (:594-599) and the entry parks forge-error —
    // the same fail-closed mapping as a missing pullRequest.
    const contexts = harness();
    await enqueue(contexts.runtime, 1);
    contexts.stub.graphql = () => pullRequestPayload({ contextsNodesNotArray: true });
    expect((await tick(contexts)).code).toBe(0);
    expectParked(contexts.stateDir, 1, 'forge-error', {
      attempt: 1,
      notBeforeIso: computeMergeBackoffIso(NOW, 0),
    });

    // A non-array `reviewThreads.nodes` only makes the thread count unknown
    // (GhForgeMergeReadAdapter.adapter.ts:291-294): the page still reads, the
    // use case carries `unresolvedThreads: { status: 'unknown' }`
    // (RunMergePassUseCase.use-case.ts:899-902), and the decider waits
    // `threads-unknown` without acting (merge-queue-decider.ts:779-792).
    const threads = harness();
    await enqueue(threads.runtime, 1);
    threads.stub.graphql = () => pullRequestPayload({ threadsNodesNotArray: true });
    expect((await tick(threads)).code).toBe(0);
    expect(entryFor(threads.stateDir, 1)).toMatchObject({ state: 'queued', reason: null, attempt: 0 });
    expect(await threads.runtime.conductor.laneRunJournal.listForKey(journalKey('merge-pr'))).toHaveLength(0);
  });

  it('refuses merge pass with queue-unreadable when merge queue file is non-array or corrupt', async () => {
    for (const [label, body] of [['invalid json', '{ not json'], ['a json object', '{"records":[]}']] as const) {
      const h = harness();
      await enqueue(h.runtime, 1);
      writeFileSync(path.join(h.stateDir, 'merge-queue.json'), body, 'utf8');

      const result = await tick(h);

      expect(result.code, label).toBe(1);
      expect(mergePassJob(lastJson(result.out)), label).toMatchObject({
        outcome: 'refused',
        reasonCode: 'queue-unreadable',
      });
      // The refused pass left the corrupt file exactly as it found it.
      expect(readFileSync(path.join(h.stateDir, 'merge-queue.json'), 'utf8'), label).toBe(body);
    }
  });

  it('refuses daemon tick with invalid-clock on null or invalid daemonNow', async () => {
    for (const [label, brokenNow] of [
      ['null', (): string => null as unknown as string],
      ['non-ISO', (): string => 'not-a-time'],
    ] as const) {
      const h = harness({}, { daemonNow: brokenNow });

      const result = await tick(h);

      expect(result.code, label).toBe(1);
      expect(lastJson(result.out), label).toEqual({
        outcome: 'refused',
        exitCode: 1,
        reasonCode: 'invalid-clock',
      });
    }
  });

  it('catches a throwing function on daemonNow or forgeGhRunner without uncaught exception', async () => {
    const clockDown = harness({}, {
      daemonNow: (): string => {
        throw new Error('clock down');
      },
    });
    const refused = await tick(clockDown);
    expect(refused.code).toBe(1);
    expect(lastJson(refused.out)).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' });

    // A forge runner that throws mid-pass is a forge-error park, not a crash.
    const forgeDown = harness();
    await enqueue(forgeDown.runtime, 1);
    forgeDown.stub.graphql = (): never => {
      throw new Error('gh exploded');
    };
    const completed = await tick(forgeDown);
    expect(completed.code).toBe(0);
    expectParked(forgeDown.stateDir, 1, 'forge-error', {
      attempt: 1,
      notBeforeIso: computeMergeBackoffIso(NOW, 0),
    });
  });

  it('returns budget-exhausted without outbound forge calls when deadline is within 2 seconds', async () => {
    const stateDir = tempDir();
    const stub = ghStub();
    let skewMs = 0;
    const baseRunner = runnerOf(stub);
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installation(),
      forgeGhRunner: async (args, timeoutMs) => {
        // The probe consumes the budget down to the 2 s safety margin: the
        // clock ends about 1.5 s from the deadline, inside the margin the
        // D-DT9 guard refuses, so removing the margin would make this fail.
        if (args[1] === 'rate_limit' && skewMs === 0) {
          skewMs += 8_500;
        }
        return baseRunner(args, timeoutMs);
      },
      daemonNow: () => new Date(Date.now() + skewMs).toISOString(),
      daemonSleep: async () => {},
    });
    await enqueue(runtime, 1);

    const result = await run(runtime, ['daemon', 'tick', '--budget-seconds', '10']);

    expect(result.code).toBe(0);
    expect(mergePassJob(lastJson(result.out))).toMatchObject({ outcome: 'budget-exhausted' });
    expect(stub.calls.filter((call) => call.args[1] === 'graphql')).toHaveLength(0);
    expect(entryFor(stateDir, 1)).toMatchObject({ state: 'queued', reason: null });
  });

  it('proceeds when about 3 seconds remain above the 2-second margin', async () => {
    const stateDir = tempDir();
    const stub = ghStub();
    let skewMs = 0;
    const baseRunner = runnerOf(stub);
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installation(),
      forgeGhRunner: async (args, timeoutMs) => {
        // Same probe, but the clock ends about 3 s from the deadline: above
        // the margin, so the pass makes its outbound calls as usual.
        if (args[1] === 'rate_limit' && skewMs === 0) {
          skewMs += 7_000;
        }
        return baseRunner(args, timeoutMs);
      },
      daemonNow: () => new Date(Date.now() + skewMs).toISOString(),
      daemonSleep: async () => {},
    });
    await enqueue(runtime, 1);

    const result = await run(runtime, ['daemon', 'tick', '--budget-seconds', '10']);

    expect(result.code).toBe(0);
    expect(mergePassJob(lastJson(result.out)).outcome).not.toBe('budget-exhausted');
    expect(stub.calls.filter((call) => call.args[1] === 'graphql').length).toBeGreaterThan(0);
  });

  it('returns skipped when the queueWriter is absent; a writer persists silently without a notifier', async () => {
    // No queue writer: the pass stays the observer and reports the park as a no-action.
    const skipped = await observerPass({});
    expect(skipped[0]).toMatchObject({ decision: 'no-action', reasonCode: 'checks' });

    // Owner decision A+ (2026-11-18): a shadow park persists as on main, but
    // SHADOW IS SILENT — the notification step is skipped and journalled as
    // would-notify, so a writer without a notifier still records the park.
    let writes = 0;
    const recorded = await observerPass({
      queueWriter: {
        applyMergeTransition: async () => {
          writes += 1;
          return { outcome: 'applied', record: {} };
        },
      },
    });
    expect(recorded[0]).toMatchObject({ decision: 'recorded', reasonCode: 'checks' });
    expect(writes).toBe(1);
  });
});

// --- helpers for the direct pass-level (optional-port) cases ---

interface ObserverReport {
  readonly decision: string;
  readonly reasonCode: string | null;
}

async function observerPass(deps: {
  readonly queueWriter?: {
    readonly applyMergeTransition: (request: unknown) => Promise<unknown>;
  };
}): Promise<readonly ObserverReport[]> {
  const useCase = new RunMergePassUseCase({
    queue: {
      listMergeEntries: async () => [passEntry()],
    },
    ...(deps.queueWriter === undefined ? {} : { queueWriter: deps.queueWriter as never }),
    forgeRead: {
      isConfigured: () => true,
      readForgeMerge: async () => ({
        outcome: 'ok',
        prState: 'open',
        liveHeadSha: HEAD,
        mergeState: 'clean',
        baseRef: 'main',
        contexts: [{ name: 'gate', state: 'FAILURE', isGreen: false, creatorLogin: null }],
        unresolvedThreads: 0,
      }),
    } as never,
    verification: {} as never,
    journal: {
      append: async () => ({ outcome: 'appended' }),
      listForKey: async () => [],
    },
    halt: { read: async () => ({ state: 'clear', record: null }) },
    newUlid: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nowIso: () => NOW,
  } as never);

  const result = await useCase.runMergePass({
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    projectId: 'proj-alpha',
    policy: deciderPolicy(),
    deadlineIso: new Date(Date.parse(NOW) + 60_000).toISOString(),
  });
  expect(result.outcome).toBe('completed');
  expect(result.entries).toHaveLength(1);
  return result.entries;
}

/** A minimal valid queued entry record for the pure decider and pass-level cases. */
function passEntry(): Record<string, unknown> {
  return {
    version: 1,
    entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    pullRequest: 1,
    headOid: HEAD,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: NOW,
    enqueuedBy: 'conductor',
    supersedes: null,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: 0,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
  };
}

const deciderEntry = passEntry;

function deciderPolicy(): MergeRepoPolicy {
  return {
    policyRevision: '0123456789ab',
    shadow: true,
    unattended: true,
    requiredContexts: ['gate'],
    updateBranch: false,
    macosProcedure: null,
    maxAttempts: 9,
    checksGraceMinutes: { gate: 5, premerge: 5 },
    veto: { mode: 'off', holdConfidence: 0.8 },
  };
}

function deciderFacts(mergeStateStatus: string): MergeStepFacts {
  return {
    halted: false,
    paused: false,
    isQueueHead: true,
    pr: { status: 'open', headOid: HEAD, mergeStateStatus },
    reReadHeadOid: HEAD,
    headObservedAtIso: NOW,
    contexts: { gate: { state: 'success', creatorLogin: null } },
    unresolvedThreads: { status: 'known', count: 0 },
    updatesInLastHour: 0,
    pendingUpdateSinceIso: undefined,
    premergeCarry: { status: 'unknown' },
    disjointness: 'not-applicable',
    macosVerification: { status: 'none' },
    veto: undefined,
    lastForgeOutcome: undefined,
    observedBaseBranch: 'main',
  } as MergeStepFacts;
}
