// DT10b: `fleet-v2 daemon tick|status|pause|resume` end to end against temporary
// state directories and a stub `gh` transport (no network, no git, no real forge).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { sha256HexDigest, type GhInvocationResult, type DaemonStatusRecord } from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime, type FleetCliRuntimeOptions } from './composition.js';
import { DAEMON_HELP, daemonCommand, daemonHelpRequested } from './daemon.js';
import { mergePolicySourceFromLoad, toDaemonRepositoryRefs } from './composition/daemon.js';
import { runCli, type CliIo } from './index.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD12 = HEAD.slice(0, 12);
const OWNER = 'fleet-org';
const REPO_A = 'alpha';
const REPO_B = 'beta';
const TICK_OK = /^tick-[0-9A-Z]{26}$/;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-daemon-'));
  tempDirs.push(dir);
  return dir;
}

function digestOf(repo: string): string {
  return sha256HexDigest(`${OWNER}/${repo}`).slice(0, 12);
}

/** A minimal valid v2 installation with a github forge and the named merge repositories. */
function installation(
  repos: readonly string[],
  extra: { readonly forge?: unknown; readonly daemon?: unknown } = {},
): FleetInstallation {
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
    policy: { merge: { repos: merge }, ...(extra.daemon === undefined ? {} : { daemon: extra.daemon }) },
    shelf: { provider: 'local' },
    forge: extra.forge ?? { mode: 'github', owner: OWNER, repo: REPO_A },
    verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
  } as unknown as FleetInstallation;
}

function greenPullRequest(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          headRefOid: HEAD,
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
  probe: (timeoutMs: number | undefined) => Promise<GhInvocationResult>;
  readonly run: NonNullable<FleetCliRuntimeOptions['forgeGhRunner']>;
}

function ghStub(): GhStub {
  const stub: GhStub = {
    calls: [],
    probe: async () => ({ exitCode: 0, stdout: '{"resources":{}}', stderr: '' }),
    run: async (args, timeoutMs) => {
      stub.calls.push({ args: [...args], timeoutMs });
      if (args[0] === 'api' && args[1] === 'rate_limit') {
        return stub.probe(timeoutMs);
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { exitCode: 0, stdout: greenPullRequest(), stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
    },
  };
  return stub;
}

interface Harness {
  readonly stateDir: string;
  readonly gh: GhStub;
  readonly runtime: FleetCliRuntime;
}

function harness(
  repos: readonly string[] = [REPO_A, REPO_B],
  options: Partial<FleetCliRuntimeOptions> = {},
  extra: { readonly forge?: unknown; readonly daemon?: unknown } = {},
): Harness {
  const stateDir = tempDir();
  const gh = ghStub();
  const runtime = createFleetCliRuntime({
    stateDir,
    installation: installation(repos, extra),
    forgeGhRunner: gh.run,
    ...options,
  });
  return { stateDir, gh, runtime };
}

async function run(
  runtime: FleetCliRuntime | undefined,
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
    enqueuedAtIso: new Date().toISOString(),
    deadlineIso: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(decision.outcome).toBe('created');
}

function journalKey(repo: string, pullRequest = 1): string {
  return `merge/${digestOf(repo)}/${pullRequest}/${HEAD12}/merge-pr`;
}

describe('daemon tick (DT10b)', () => {
  it('serves two repositories: two merge-pass jobs, two leases, two status summaries, a shadow would-merge', async () => {
    const h = harness();
    await enqueue(h.runtime, REPO_A);

    const result = await run(h.runtime, ['daemon', 'tick']);

    expect(result.code).toBe(0);
    const json = lastJson(result.out);
    expect(json).toMatchObject({ outcome: 'completed', exitCode: 0, paused: false, forgeReachable: true, jobCount: 2, repositoryCount: 2 });
    expect(String(json.tickId)).toMatch(TICK_OK);
    expect((json.jobs as Array<{ jobId: string }>).map((job) => job.jobId).sort()).toEqual(
      [`merge-pass:${digestOf(REPO_A)}`, `merge-pass:${digestOf(REPO_B)}`].sort(),
    );
    // The leases were taken and released: nothing is held afterwards.
    for (const repo of [REPO_A, REPO_B]) {
      const lease = await h.runtime.daemon.lease.read(`merge/${digestOf(repo)}`);
      expect(lease === null || Date.parse(lease.leaseUntilIso) <= Date.now() + 1_000).toBe(true);
    }
    // checksGraceMinutes mapped: the queued PR reaches the shadow would-merge.
    const journal = await h.runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_A));
    expect(journal.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal[1]).toMatchObject({ outcome: 'dry-run', reasonCode: 'would-merge' });
    const events = readFileSync(path.join(h.stateDir, 'daemon', 'events.jsonl'), 'utf8');
    expect(events).toContain('would-merge');
    const status = JSON.parse(readFileSync(path.join(h.stateDir, 'daemon', 'status.json'), 'utf8')) as DaemonStatusRecord;
    expect(status.repositories).toHaveLength(2);
  });

  it('maps the policy into the decider input with checksGraceMinutes per procedure', async () => {
    const h = harness([REPO_A]);
    const answer = await h.runtime.daemon.mergePolicy.readMergePolicy();
    expect(answer.outcome).toBe('known');
    if (answer.outcome !== 'known') {
      return;
    }
    const [ref] = toDaemonRepositoryRefs(answer);
    expect(ref.repoDigest).toBe(digestOf(REPO_A));
    expect(ref.policy.checksGraceMinutes).toEqual({ gate: 5, premerge: 5 });
    expect(ref.policy.requiredContexts).toEqual(['gate']);
    expect(mergePolicySourceFromLoad({ status: 'invalid', file: '/secret/path.json', errors: ['x'] })).toEqual({
      outcome: 'invalid',
      reason: 'installation-invalid',
    });
  });

  it('skips a job whose lease is held by a live tick, journals shadow merge intents once across ticks, and recovers an open shadow intent on the next tick', async () => {
    const h = harness();
    await enqueue(h.runtime, REPO_A);
    await enqueue(h.runtime, REPO_B);
    const otherHolder = `tick-${h.runtime.daemon.newUlid()}`;
    const held = await h.runtime.daemon.lease.acquire({
      scope: `merge/${digestOf(REPO_A)}`,
      holderId: otherHolder,
      observedFence: 0,
      leaseUntilIso: new Date(Date.now() + 120_000).toISOString(),
      nowIso: new Date().toISOString(),
    });
    expect(held.outcome).toBe('ok');

    const first = lastJson((await run(h.runtime, ['daemon', 'tick'])).out);
    const byJob = Object.fromEntries((first.jobs as Array<{ jobId: string; outcome: string; reasonCode: string | null }>).map((job) => [job.jobId, job]));
    expect(first.exitCode).toBe(0);
    expect(byJob[`merge-pass:${digestOf(REPO_A)}`]).toMatchObject({ outcome: 'skipped', reasonCode: 'lease-held' });
    expect(byJob[`merge-pass:${digestOf(REPO_B)}`].outcome).toBe('completed');
    expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).toHaveLength(0);

    // A second tick journals nothing new for B (one intent and one result per key).
    await run(h.runtime, ['daemon', 'tick']);
    expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_B))).toHaveLength(2);

    // An interrupted pass leaves an open intent; the next tick closes it without a second intent.
    const key = journalKey(REPO_A);
    await h.runtime.conductor.laneRunJournal.append({
      version: 1,
      entryId: h.runtime.conductor.newUlid(),
      kind: 'intent',
      key,
      runId: null,
      recordedAtIso: new Date().toISOString(),
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    } as never);
    // Release the foreign lease so the job can run.
    const lease = await h.runtime.daemon.lease.read(`merge/${digestOf(REPO_A)}`);
    expect(lease).not.toBeNull();
    await h.runtime.daemon.lease.release({
      scope: `merge/${digestOf(REPO_A)}`,
      holderId: otherHolder,
      fence: lease?.fence ?? 0,
      nowIso: new Date().toISOString(),
    });
    await run(h.runtime, ['daemon', 'tick']);
    const after = await h.runtime.conductor.laneRunJournal.listForKey(key);
    expect(after.filter((entry) => entry.kind === 'intent')).toHaveLength(1);
    expect(after.filter((entry) => entry.kind === 'result')).toHaveLength(1);
  });

  it('--job runs only the named repository job; a malformed or unknown --job is a usage error', async () => {
    const h = harness();
    const named = `merge-pass:${digestOf(REPO_B)}`;
    const result = await run(h.runtime, ['daemon', 'tick', '--job', named, `--job=${named}`]);
    expect(result.code).toBe(0);
    const json = lastJson(result.out);
    expect((json.jobs as Array<{ jobId: string }>).map((job) => job.jobId)).toEqual([named]);

    for (const bad of [['--job', 'nope'], ['--job'], ['--job', 'merge-pass:ZZZ'], ['--frobnicate'], ['positional'], ['--job', '']]) {
      const refused = await run(h.runtime, ['daemon', 'tick', ...bad]);
      expect(refused.code, bad.join(' ')).toBe(2);
      expect(refused.err).toContain('Invalid daemon tick arguments');
    }
  });

  it('guards the forge probe with min(10s, remaining budget), skips probing under 2s remaining, and leaves state clean for the next tick', async () => {
    const h = harness();
    await run(h.runtime, ['daemon', 'tick']);
    const wide = h.gh.calls.find((call) => call.args[1] === 'rate_limit');
    expect(wide?.args).toEqual(['api', 'rate_limit']);
    expect(wide?.timeoutMs).toBe(10_000);

    const narrow = harness();
    await run(narrow.runtime, ['daemon', 'tick', '--budget-seconds', '5']);
    const narrowCall = narrow.gh.calls.find((call) => call.args[1] === 'rate_limit');
    expect(narrowCall?.timeoutMs).toBeGreaterThanOrEqual(2_000);
    expect(narrowCall?.timeoutMs).toBeLessThanOrEqual(5_000);

    // Under 2 s remaining the probe is not started; the merge-pass jobs are skipped, never half-run.
    const tight = harness();
    await enqueue(tight.runtime, REPO_A);
    const result = await run(tight.runtime, ['daemon', 'tick', '--budget-seconds', '1']);
    expect(result.code).toBe(0);
    expect(tight.gh.calls.filter((call) => call.args[1] === 'rate_limit')).toHaveLength(0);
    const json = lastJson(result.out);
    expect(json.forgeReachable).toBe(false);
    expect((json.jobs as Array<{ reasonCode: string }>).every((job) => job.reasonCode === 'forge-unreachable')).toBe(true);
    expect(await tight.runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).toHaveLength(0);

    // The next, unhurried tick completes the work the cut-short tick left alone.
    const next = await run(tight.runtime, ['daemon', 'tick']);
    expect(next.code).toBe(0);
    expect(await tight.runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_A))).toHaveLength(2);
  });

  it('skips merge-pass jobs with forge-unreachable when the probe exits 1, times out, returns non-JSON or the forge mode is none', async () => {
    const variants: Array<[string, (stub: GhStub) => void, boolean]> = [
      ['exit 1', (stub) => { stub.probe = async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }); }, true],
      ['timeout rejection', (stub) => { stub.probe = async () => { throw new Error('gh timed out'); }; }, true],
      ['captive portal', (stub) => { stub.probe = async () => ({ exitCode: 0, stdout: '<html>login</html>', stderr: '' }); }, true],
      ['json array', (stub) => { stub.probe = async () => ({ exitCode: 0, stdout: '[]', stderr: '' }); }, true],
      ['no forge', () => undefined, false],
    ];
    for (const [label, configure, probed] of variants) {
      const h = harness(
        [REPO_A, REPO_B],
        {},
        label === 'no forge' ? { forge: { mode: 'none' } } : {},
      );
      configure(h.gh);
      await enqueue(h.runtime, REPO_A);
      const result = await run(h.runtime, ['daemon', 'tick']);
      expect(result.code, label).toBe(0);
      const json = lastJson(result.out);
      expect(json.forgeReachable, label).toBe(false);
      expect(
        (json.jobs as Array<{ reasonCode: string }>).every((job) => job.reasonCode === 'forge-unreachable'),
        label,
      ).toBe(true);
      expect(h.gh.calls.some((call) => call.args[1] === 'rate_limit'), label).toBe(probed);
      expect(h.gh.calls.some((call) => call.args[1] === 'graphql'), label).toBe(false);
      expect(await h.runtime.conductor.laneRunJournal.listForKey(journalKey(REPO_A)), label).toHaveLength(0);
    }
  });

  it('refuses daemon tick when merge policy is unknown, pauses on unreadable paused.json, and skips merge-pass when forge probe fails or returns non-JSON', async () => {
    // Unknown policy: an invalid installation.
    const stateDir = tempDir();
    const gh = ghStub();
    const unknown = createFleetCliRuntime({
      stateDir,
      forgeGhRunner: gh.run,
      loadInstallationForMergePolicy: () => ({ status: 'invalid', file: '/private/install.json', errors: ['bad'] }),
    });
    const refused = await run(unknown, ['daemon', 'tick']);
    expect(refused.code).toBe(1);
    expect(lastJson(refused.out)).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'policy-invalid' });
    expect(refused.out).not.toContain('/private');
    expect(gh.calls).toHaveLength(0);

    // Unreadable pause marker: fail closed, no probe, no jobs.
    const h = harness();
    const pauseDir = path.join(h.stateDir, 'daemon');
    await run(h.runtime, ['daemon', 'pause']);
    writeFileSync(path.join(pauseDir, 'paused.json'), '{ not json');
    const closed = await run(h.runtime, ['daemon', 'tick']);
    expect(closed.code).toBe(0);
    expect(lastJson(closed.out)).toMatchObject({ outcome: 'completed', paused: true, jobCount: 0 });
    expect(h.gh.calls).toHaveLength(0);
  });
});

describe('daemon pause and resume (DT10b)', () => {
  it('writes <stateDir>/daemon/paused.json; a paused tick skips the gh probe, runs zero jobs and exits 0', async () => {
    const h = harness();
    const paused = await run(h.runtime, ['daemon', 'pause']);
    expect(paused.code).toBe(0);
    expect(lastJson(paused.out)).toMatchObject({ outcome: 'recorded', paused: true });
    const file = JSON.parse(readFileSync(path.join(h.stateDir, 'daemon', 'paused.json'), 'utf8')) as { paused: boolean };
    expect(file.paused).toBe(true);

    const tick = await run(h.runtime, ['daemon', 'tick']);
    expect(tick.code).toBe(0);
    expect(lastJson(tick.out)).toMatchObject({ outcome: 'completed', paused: true, jobCount: 0 });
    expect(h.gh.calls).toHaveLength(0);

    const resumed = await run(h.runtime, ['daemon', 'resume']);
    expect(lastJson(resumed.out)).toMatchObject({ outcome: 'recorded', paused: false });
    const again = await run(h.runtime, ['daemon', 'tick']);
    expect(lastJson(again.out)).toMatchObject({ paused: false, jobCount: 2 });
  });

  it('pause and resume still succeed when FLEET_INSTALLATION_FILE is invalid, and nothing echoes the path', async () => {
    const dir = tempDir();
    const bad = path.join(dir, 'secret-install-location.json');
    writeFileSync(bad, '{ definitely not json');
    vi.stubEnv('FLEET_INSTALLATION_FILE', bad);
    const stateDir = tempDir();

    for (const [sub, expected] of [['pause', true], ['resume', false]] as const) {
      const result = await run(undefined, ['--state-dir', stateDir, 'daemon', sub]);
      expect(result.code, sub).toBe(0);
      expect(lastJson(result.out)).toMatchObject({ outcome: 'recorded', paused: expected });
      expect(result.out + result.err).not.toContain('secret-install-location');
    }
    const tick = await run(undefined, ['--state-dir', stateDir, 'daemon', 'tick']);
    expect(tick.code).toBe(1);
    expect(lastJson(tick.out)).toMatchObject({ outcome: 'refused', reasonCode: 'policy-invalid' });
    expect(tick.out + tick.err).not.toContain('secret-install-location');
    expect(existsSync(path.join(stateDir, 'daemon', 'paused.json'))).toBe(true);
  });

  it('exits 2 for tick, pause and resume without a durable state directory', async () => {
    vi.stubEnv('FLEET_STATE_DIR', '');
    const runtime = createFleetCliRuntime({ installation: installation([REPO_A]), forgeGhRunner: ghStub().run });
    for (const sub of ['tick', 'pause', 'resume']) {
      const result = await run(runtime, ['daemon', sub]);
      expect(result.code, sub).toBe(2);
      expect(result.err).toContain(`daemon ${sub} needs a durable state directory`);
    }
    const status = await run(runtime, ['daemon', 'status']);
    expect(status.code).toBe(1);
  });
});

describe('daemon status (DT10b)', () => {
  const FINISHED = '2026-11-01T12:00:00.000Z';

  function statusHarness(nowIso: string, daemon?: unknown): Harness {
    return harness([REPO_A], { daemonNow: () => nowIso }, { daemon });
  }

  async function writeStatus(h: Harness, jobs: Array<Partial<DaemonStatusRecord['jobs'][number]>>): Promise<void> {
    const written = await h.runtime.daemon.status.write({
      tickId: `tick-0${'1'.repeat(25)}`,
      startedAtIso: FINISHED,
      finishedAtIso: FINISHED,
      paused: false,
      halted: false,
      forgeReachable: true,
      jobs: jobs.map((job) => ({
        jobId: `merge-pass:${digestOf(REPO_A)}`,
        outcome: 'completed',
        reasonCode: null,
        leaseFence: 1,
        durationMs: 5,
        nextNotBeforeIso: null,
        consecutiveBudgetExhausted: 0,
        ...job,
      })) as DaemonStatusRecord['jobs'],
      repositories: [
        { repoDigest: digestOf(REPO_A), lastServedAtIso: FINISHED, queued: 1, ready: 1, parked: 0, headEntryId: null, lastMergedHead12: null },
      ],
      notifierCursor: null,
    });
    expect(written.ok).toBe(true);
  }

  it('reports a healthy status with exit 0, text and --json', async () => {
    const h = statusHarness('2026-11-01T12:01:00.000Z');
    await writeStatus(h, [{}]);

    const text = await run(h.runtime, ['daemon', 'status']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('daemon healthy tick=tick-');
    expect(text.out).toContain(`job merge-pass:${digestOf(REPO_A)} outcome=completed reason=none budgetStreak=0`);
    expect(text.out).toContain(`repo ${digestOf(REPO_A)} queued=1 ready=1 parked=0 head=none merged=none`);

    const json = await run(h.runtime, ['daemon', 'status', '--json']);
    expect(json.code).toBe(0);
    expect(lastJson(json.out)).toMatchObject({ outcome: 'ok', healthy: true, exitCode: 0, reasons: [] });
  });

  it('is unhealthy (exit 1) when stale, with the interval from the policy', async () => {
    const stale = statusHarness('2026-11-01T12:10:00.000Z');
    await writeStatus(stale, [{}]);
    const result = await run(stale.runtime, ['daemon', 'status', '--json']);
    expect(result.code).toBe(1);
    expect(lastJson(result.out)).toMatchObject({ outcome: 'ok', healthy: false, exitCode: 1, reasons: ['stale'] });

    const wide = statusHarness('2026-11-01T12:10:00.000Z', { intervalSeconds: 600 });
    await writeStatus(wide, [{}]);
    expect((await run(wide.runtime, ['daemon', 'status'])).code).toBe(0);
  });

  it('refused jobs fail, nine budget-exhausted ticks pass, ten are starved', async () => {
    const refused = statusHarness('2026-11-01T12:01:00.000Z');
    await writeStatus(refused, [{ outcome: 'refused', reasonCode: 'merge-pass-refused' }]);
    const r = await run(refused.runtime, ['daemon', 'status', '--json']);
    expect(r.code).toBe(1);
    expect(lastJson(r.out)).toMatchObject({ reasons: ['job-refused'], refusedJobIds: [`merge-pass:${digestOf(REPO_A)}`] });

    const nine = statusHarness('2026-11-01T12:01:00.000Z');
    await writeStatus(nine, [{ outcome: 'budget-exhausted', consecutiveBudgetExhausted: 9 }]);
    expect((await run(nine.runtime, ['daemon', 'status'])).code).toBe(0);

    const ten = statusHarness('2026-11-01T12:01:00.000Z');
    await writeStatus(ten, [{ outcome: 'budget-exhausted', consecutiveBudgetExhausted: 10 }]);
    const t = await run(ten.runtime, ['daemon', 'status', '--json']);
    expect(t.code).toBe(1);
    expect(lastJson(t.out)).toMatchObject({ reasons: ['starved'], starvedJobIds: [`merge-pass:${digestOf(REPO_A)}`] });
  });

  it('a missing status is exit 1; a corrupt one is exit 1 and stays on disk unquarantined', async () => {
    const missing = statusHarness('2026-11-01T12:01:00.000Z');
    const m = await run(missing.runtime, ['daemon', 'status']);
    expect(m.code).toBe(1);
    expect(m.out).toBe('daemon status missing reason=status-missing\n');

    const corrupt = statusHarness('2026-11-01T12:01:00.000Z');
    const target = path.join(corrupt.stateDir, 'daemon');
    await writeStatus(corrupt, [{}]);
    writeFileSync(path.join(target, 'status.json'), '{ corrupt');
    const c = await run(corrupt.runtime, ['daemon', 'status', '--json']);
    expect(c.code).toBe(1);
    expect(lastJson(c.out)).toMatchObject({ outcome: 'refused', healthy: false, reasonCode: 'status-unreadable', status: null });
    expect(readFileSync(path.join(target, 'status.json'), 'utf8')).toBe('{ corrupt');
    expect(existsSync(path.join(target, 'quarantine'))).toBe(false);
  });

  it('prints help for --help and daemon --help with exit 0', async () => {
    const h = harness();
    for (const argv of [['--help'], ['daemon', '--help'], ['daemon', 'tick', '--help'], ['daemon', 'help']]) {
      const result = await run(h.runtime, argv);
      expect(result.code, argv.join(' ')).toBe(0);
    }
    expect((await run(h.runtime, ['--help'])).out).toContain('daemon tick|status|pause|resume');
    expect((await run(h.runtime, ['daemon', '--help'])).out).toContain(DAEMON_HELP);
    expect(daemonHelpRequested(['status', '-h'])).toBe(true);
    expect(daemonHelpRequested(['status', '--json', '-h'])).toBe(false);
  });
});

describe('daemon robustness (DT10b, F96)', () => {
  it('never throws on malformed runtime inputs, sparse argv or job arrays, unknown flags or throwing getters', async () => {
    const h = harness();
    const io = { out: [] as string[], err: [] as string[] };
    const cliIo: CliIo = { stdout: (t) => io.out.push(t), stderr: (t) => io.err.push(t) };
    const call = (argv: unknown) => daemonCommand(argv as never, cliIo, h.runtime, {});

    expect(await call(null)).toBe(2);
    expect(await call('tick')).toBe(2);
    expect(await call({ length: 1, 0: 'tick' })).toBe(2);
    expect(await call([42])).toBe(2);
    expect(await call([])).toBe(2);
    // eslint-disable-next-line no-sparse-arrays
    expect(await call(['tick', , '--job'])).toBe(2);
    const hostile = ['tick'];
    Object.defineProperty(hostile, 1, {
      enumerable: true,
      get() {
        throw new Error('getter exploded /secret/path');
      },
    });
    expect(await call(hostile)).toBe(2);
    expect(await call(['tick', '--budget-seconds', 'abc'])).toBe(2);
    expect(await call(['status', '--json', '--json'])).toBe(2);
    expect(await call(['pause', 'now'])).toBe(2);
    expect(await call(['explode'])).toBe(2);

    // A runtime whose ports throw still yields a typed exit, never an exception.
    const exploding = { daemon: { durable: true, now: () => { throw new Error('clock exploded'); } } } as unknown as FleetCliRuntime;
    expect(await daemonCommand(['status'], cliIo, exploding, {})).toBe(1);
    const clockless = { daemon: { durable: true, now: () => 'not-a-time' } } as unknown as FleetCliRuntime;
    expect(await daemonCommand(['pause'], cliIo, clockless, {})).toBe(1);

    // setPause refuses malformed requests with typed codes.
    const pause = h.runtime.daemon.setDaemonPause;
    expect(await pause.setPause(null as never)).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(await pause.setPause({ paused: 'yes', nowIso: '2026-11-01T12:00:00.000Z' } as never)).toMatchObject({ reasonCode: 'invalid-request' });
    expect(await pause.setPause({ paused: true, nowIso: 'soon' })).toMatchObject({ reasonCode: 'invalid-clock' });
    expect(
      await pause.setPause({ get paused(): boolean { throw new Error('boom'); }, nowIso: '2026-11-01T12:00:00.000Z' } as never),
    ).toMatchObject({ reasonCode: 'invalid-request' });
    expect(io.out.concat(io.err).join('')).not.toContain('/secret/path');
  });

  it('never echoes paths or secret-shaped text to stdout or stderr across tick, status, pause, resume and usage errors', async () => {
    const secret = 'gh' + 'p_' + 'A'.repeat(30);
    const h = harness([REPO_A], {}, {});
    h.gh.probe = async () => ({ exitCode: 1, stdout: secret, stderr: `${secret} ${h.stateDir}` });
    const outputs: string[] = [];
    for (const argv of [
      ['daemon', 'tick'],
      ['daemon', 'tick', '--job', secret],
      ['daemon', 'tick', `--budget-seconds=${secret}`],
      ['daemon', 'tick', secret],
      ['daemon', 'status'],
      ['daemon', 'status', '--json'],
      ['daemon', 'status', secret],
      ['daemon', 'pause'],
      ['daemon', 'resume'],
      ['daemon', 'resume', secret],
      ['daemon', secret],
    ]) {
      const result = await run(h.runtime, argv);
      outputs.push(result.out, result.err);
    }
    const all = outputs.join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(h.stateDir);
    expect(all).not.toMatch(/\/(tmp|home|var|private)\//);
  });

  it('invokes only the reviewed gh api argv for daemon tick and runs no git subprocess', async () => {
    const h = harness();
    await enqueue(h.runtime, REPO_A);
    await run(h.runtime, ['daemon', 'tick']);
    expect(h.gh.calls.length).toBeGreaterThan(0);
    for (const call of h.gh.calls) {
      expect(call.args[0]).toBe('api');
      expect(['rate_limit', 'graphql']).toContain(call.args[1]);
      expect(call.args).not.toContain('git');
    }
    expect(h.gh.calls[0].args).toEqual(['api', 'rate_limit']);
  });

  it('enforces size bounds on argv, --job filters, --budget-seconds and forge probe stdout', async () => {
    const h = harness();
    const cliIo: CliIo = { stdout: () => undefined, stderr: () => undefined };
    expect(await daemonCommand(['status', ...Array.from({ length: 256 }, () => '--json')], cliIo, h.runtime, {})).toBe(2);
    expect(await daemonCommand(Array.from({ length: 257 }, () => 'tick'), cliIo, h.runtime, {})).toBe(2);

    const job = `merge-pass:${digestOf(REPO_A)}`;
    const many = Array.from({ length: 65 }, () => ['--job', job]).flat();
    expect((await run(h.runtime, ['daemon', 'tick', ...many])).code).toBe(2);
    const sixtyFour = Array.from({ length: 64 }, () => ['--job', job]).flat();
    expect((await run(h.runtime, ['daemon', 'tick', ...sixtyFour])).code).toBe(0);

    for (const bad of ['0', '3601', '-1', '1.5', '', '99999999']) {
      expect((await run(h.runtime, ['daemon', 'tick', '--budget-seconds', bad])).code, bad).toBe(2);
    }
    expect((await run(h.runtime, ['daemon', 'tick', '--budget-seconds', '3600'])).code).toBe(0);
    expect((await run(h.runtime, ['daemon', 'tick', '--budget-seconds', '1', '--budget-seconds', '2'])).code).toBe(2);

    // A probe answer over 65,536 bytes is an unreachable forge, not parsed.
    const big = harness();
    big.gh.probe = async () => ({ exitCode: 0, stdout: JSON.stringify({ pad: 'x'.repeat(70_000) }), stderr: '' });
    const result = await run(big.runtime, ['daemon', 'tick']);
    expect(lastJson(result.out)).toMatchObject({ forgeReachable: false });
    const ok = harness();
    ok.gh.probe = async () => ({ exitCode: 0, stdout: JSON.stringify({ pad: 'x'.repeat(60_000) }), stderr: '' });
    expect(lastJson((await run(ok.runtime, ['daemon', 'tick'])).out)).toMatchObject({ forgeReachable: true });
  });
});
