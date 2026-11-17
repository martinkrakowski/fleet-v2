// DT10b: `fleet-v2 daemon tick|status|pause|resume` end to end against temporary
// state directories and a stub `gh` transport (no network, no git, no real forge).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sha256HexDigest,
  SpdSayHostAudibleAlertAdapter,
  type GhInvocationResult,
  type DaemonStatusRecord,
} from '@fleet/work-execution';
import { loadInstallation, type FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime, type FleetCliRuntimeOptions } from './composition.js';
import {
  DAEMON_HELP,
  daemonCommand,
  daemonHelpRequested,
  watchdogRepositoryReport,
} from './daemon.js';
import {
  mergePolicySourceFromLoad,
  resolveAudibleAlertMode,
  toDaemonRepositoryRefs,
} from './composition/daemon.js';
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

// CO-WD9a: no test in this file may ever start a real speech program, even when
// a developer has FLEET_AUDIBLE_ALERT set in their own shell.
beforeEach(() => {
  vi.stubEnv('FLEET_AUDIBLE_ALERT', '');
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
          baseRefName: 'main',
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

describe('daemon tick with a bad policy.daemon.stallAfterMinutes (PT1a)', () => {
  for (const bad of [0, 99999, 2.5, 'soon']) {
    it(`with stallAfterMinutes ${JSON.stringify(bad)} the tick runs, the merge policy resolves with the default 30 and nothing is refused`, async () => {
      const h = harness([REPO_A], {}, { daemon: { stallAfterMinutes: bad } });
      await enqueue(h.runtime, REPO_A);

      const answer = await h.runtime.daemon.mergePolicy.readMergePolicy();
      expect(answer).toMatchObject({ outcome: 'known', daemon: { stallAfterMinutes: 30 } });
      // The conductor reads the same key through the same resolver: its stall threshold is the default.
      expect(h.runtime.conductor.stallAfterMinutes).toBe(30);

      const result = await run(h.runtime, ['daemon', 'tick']);
      expect(result.code).toBe(0);
      const json = lastJson(result.out);
      expect(json).toMatchObject({ outcome: 'completed', exitCode: 0, forgeReachable: true });
      expect((json.jobs as Array<{ jobId: string; outcome: string }>).find((job) => job.jobId === `merge-pass:${digestOf(REPO_A)}`)).toMatchObject({ outcome: 'completed' });
      if (typeof bad === 'string') {
        expect(JSON.stringify(json)).not.toContain(bad);
      }
    });
  }

  it('the installation loader reports the warning for the same file and still loads it', () => {
    const dir = tempDir();
    const file = path.join(dir, 'fleet.json');
    writeFileSync(file, JSON.stringify({ ...(installation([REPO_A], { daemon: { stallAfterMinutes: 0 } }) as object) }), 'utf8');
    const loaded = loadInstallation({ file, env: {} });
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') {
      expect(loaded.warnings).toEqual(['policy.daemon.stallAfterMinutes: stall-after-minutes-invalid']);
      expect(mergePolicySourceFromLoad(loaded)).toMatchObject({ outcome: 'resolved', daemon: { stallAfterMinutes: 30 } });
    }
  });
});

describe('daemon tick with a bad policy.daemon.autoResumeMax (PT1b1)', () => {
  for (const bad of [-1, 33, 2.5, 'soon']) {
    it(`with autoResumeMax ${JSON.stringify(bad)} the tick runs, the merge policy resolves fail-closed to 0 and nothing is refused`, async () => {
      const h = harness([REPO_A], {}, { daemon: { autoResumeMax: bad } });
      await enqueue(h.runtime, REPO_A);

      const answer = await h.runtime.daemon.mergePolicy.readMergePolicy();
      expect(answer).toMatchObject({ outcome: 'known', daemon: { autoResumeMax: 0 } });

      const result = await run(h.runtime, ['daemon', 'tick']);
      expect(result.code).toBe(0);
      const json = lastJson(result.out);
      expect(json).toMatchObject({ outcome: 'completed', exitCode: 0, forgeReachable: true });
      expect((json.jobs as Array<{ jobId: string; outcome: string }>).find((job) => job.jobId === `merge-pass:${digestOf(REPO_A)}`)).toMatchObject({ outcome: 'completed' });
      if (typeof bad === 'string') {
        expect(JSON.stringify(json)).not.toContain(bad);
      }
    });
  }

  it('the installation loader reports the warning for the same file and still loads it', () => {
    const dir = tempDir();
    const file = path.join(dir, 'fleet.json');
    writeFileSync(file, JSON.stringify({ ...(installation([REPO_A], { daemon: { autoResumeMax: 33 } }) as object) }), 'utf8');
    const loaded = loadInstallation({ file, env: {} });
    expect(loaded.status).toBe('loaded');
    if (loaded.status === 'loaded') {
      expect(loaded.warnings).toEqual(['policy.daemon.autoResumeMax: auto-resume-max-invalid']);
      expect(mergePolicySourceFromLoad(loaded)).toMatchObject({ outcome: 'resolved', daemon: { autoResumeMax: 0 } });
    }
  });
});

describe('daemon tick (DT10b)', () => {
  it('serves two repositories: two merge-pass jobs, two leases, two status summaries, a shadow would-merge', async () => {
    const h = harness();
    await enqueue(h.runtime, REPO_A);

    const result = await run(h.runtime, ['daemon', 'tick']);

    expect(result.code).toBe(0);
    const json = lastJson(result.out);
    expect(json).toMatchObject({ outcome: 'completed', exitCode: 0, paused: false, forgeReachable: true, jobCount: 4, repositoryCount: 2 });
    expect(String(json.tickId)).toMatch(TICK_OK);
    // CO8: each repository also gets its shadow chain-refresh job.
    expect((json.jobs as Array<{ jobId: string }>).map((job) => job.jobId).sort()).toEqual(
      [
        `merge-pass:${digestOf(REPO_A)}`,
        `merge-pass:${digestOf(REPO_B)}`,
        `chain-refresh:${digestOf(REPO_A)}`,
        `chain-refresh:${digestOf(REPO_B)}`,
      ].sort(),
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

  it('computes one deadline at command start: a probe that spends the budget leaves the tick no fresh budget', async () => {
    let skewMs = 0;
    const h = harness([REPO_A, REPO_B], { daemonNow: () => new Date(Date.now() + skewMs).toISOString() });
    await enqueue(h.runtime, REPO_A);
    h.gh.probe = async () => {
      skewMs += 11_000; // the probe outlasts the whole 10 s budget
      return { exitCode: 0, stdout: '{"resources":{}}', stderr: '' };
    };
    const result = await run(h.runtime, ['daemon', 'tick', '--budget-seconds', '10']);
    expect(result.code).toBe(0);
    expect(h.gh.calls.filter((call) => call.args[1] === 'rate_limit')).toHaveLength(1);
    expect(h.gh.calls.filter((call) => call.args[1] === 'graphql')).toHaveLength(0);
    const jobs = lastJson(result.out).jobs as Array<{ outcome: string }>;
    expect(jobs.every((job) => job.outcome === 'budget-exhausted')).toBe(true);
  });

  it('fails closed on a stale clock at the probe: a throwing or malformed fresh read skips the forge probe', async () => {
    const failures: Array<[string, () => string]> = [
      ['throws', () => { throw new Error('clock down'); }],
      ['malformed', () => 'not-a-time'],
    ];
    for (const [label, failure] of failures) {
      let calls = 0;
      const h = harness([REPO_A, REPO_B], {
        daemonNow: () => {
          calls += 1;
          return calls === 1 ? new Date().toISOString() : failure();
        },
      });
      await enqueue(h.runtime, REPO_A);
      const result = await run(h.runtime, ['daemon', 'tick']);
      expect(h.gh.calls.some((call) => call.args[1] === 'rate_limit'), label).toBe(false);
      expect(h.gh.calls.some((call) => call.args[1] === 'graphql'), label).toBe(false);
      expect(result.code, label).toBeLessThanOrEqual(1);
    }
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
    expect(lastJson(again.out)).toMatchObject({ paused: false, jobCount: 4 });
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

describe('daemon watchdog composition (CO-WD5a)', () => {
  function watchdogHarness(nowIso: string): Harness {
    return harness([REPO_A], { daemonNow: () => nowIso });
  }

  async function writeTickStatus(h: Harness, finishedAtIso: string): Promise<void> {
    const written = await h.runtime.daemon.status.write({
      tickId: `tick-0${'1'.repeat(25)}`,
      startedAtIso: finishedAtIso,
      finishedAtIso,
      paused: false,
      halted: false,
      forgeReachable: true,
      jobs: [
        {
          jobId: `merge-pass:${digestOf(REPO_A)}`,
          outcome: 'completed',
          reasonCode: null,
          leaseFence: 1,
          durationMs: 5,
          nextNotBeforeIso: null,
          consecutiveBudgetExhausted: 0,
        },
      ] as DaemonStatusRecord['jobs'],
      repositories: [],
      notifierCursor: null,
    });
    expect(written.ok).toBe(true);
  }

  interface WatchdogItem {
    readonly item: { readonly kind: string; readonly subject?: { readonly kind: string; readonly ref?: string } };
  }

  async function openItems(h: Harness): Promise<readonly WatchdogItem[]> {
    const listed = (await h.runtime.coordination.listAttentionItems.listAttentionItems({
      state: 'open',
    })) as { readonly items: readonly WatchdogItem[] };
    return listed.items;
  }

  async function watch(h: Harness, projectId: string): Promise<Record<string, unknown>> {
    return (await h.runtime.daemon.watchTrainHealth.watchTrainHealth({
      projectId,
      repository: { owner: OWNER, repo: REPO_A },
      repoDigest: digestOf(REPO_A),
      deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    })) as Record<string, unknown>;
  }

  it('(a) a fresh tick status with an empty queue evaluates healthy with exit 0 and no findings', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, nowIso);
    const result = await watch(h, 'proj-alpha');
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: true, exitCode: 0, findings: [] });
  });

  it('(b) a tick status finished ten minutes ago is stale: exit 1, one tick-stale finding and one open train-tick-stale item for proj-alpha', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const result = await watch(h, 'proj-alpha');
    expect(result).toMatchObject({
      outcome: 'evaluated',
      healthy: false,
      exitCode: 1,
      findings: [{ rule: 'tick-stale', key: 'train-health:tick-stale' }],
      raised: 1,
    });
    const items = await openItems(h);
    const stale = items.filter((entry) => entry.item.kind === 'train-tick-stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].item.subject).toMatchObject({ kind: 'project', ref: 'proj-alpha' });
  });

  it('(c) a second pass on the same stale status refreshes the item instead of duplicating it', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const first = await watch(h, 'proj-alpha');
    expect(first).toMatchObject({ outcome: 'evaluated', healthy: false, raised: 1 });
    const second = await watch(h, 'proj-alpha');
    expect(second).toMatchObject({ outcome: 'evaluated', healthy: false, raised: 1 });
    const items = await openItems(h);
    expect(items.filter((entry) => entry.item.kind === 'train-tick-stale')).toHaveLength(1);
  });

  it('(d) after the status becomes fresh again the third pass is healthy and the stale item is no longer open', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    await watch(h, 'proj-alpha');
    await writeTickStatus(h, nowIso);
    const third = await watch(h, 'proj-alpha');
    expect(third).toMatchObject({ outcome: 'evaluated', healthy: true, exitCode: 0 });
    const items = await openItems(h);
    expect(items.filter((entry) => entry.item.kind === 'train-tick-stale')).toHaveLength(0);
  });

  it("(e) a corrupt daemon status file is blind: one open train-watchdog-blind item and the file stays on disk byte-for-byte, never quarantined", async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const target = path.join(h.stateDir, 'daemon');
    await writeTickStatus(h, nowIso);
    writeFileSync(path.join(target, 'status.json'), 'not json');
    const result = await watch(h, 'proj-alpha');
    expect(result).toMatchObject({ outcome: 'blind', exitCode: 1, raised: 1 });
    expect(readFileSync(path.join(target, 'status.json'), 'utf8')).toBe('not json');
    expect(existsSync(path.join(target, 'quarantine'))).toBe(false);
    const items = await openItems(h);
    expect(items.filter((entry) => entry.item.kind === 'train-watchdog-blind')).toHaveLength(1);
  });

  it('(f) a missing status with an empty queue evaluates healthy with exit 0', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const result = await watch(h, 'proj-alpha');
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: true, exitCode: 0 });
  });

  it('a live durable queue entry is forge-read: a green forge answer yields no unknown forge states (fix-1 mutation: a forge reader answering ok:false fails here)', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await enqueue(h.runtime, REPO_A, 7);
    await writeTickStatus(h, nowIso);
    const result = await watch(h, 'proj-alpha');
    // The gh stub answers a green open pull request for the graphql read, so a
    // pass that really reaches the forge reports zero unknown forge states.
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: true, exitCode: 0, findings: [], unknownForgeStates: 0 });
  });

  it('a corrupt merge-queue file reads blind on two consecutive runs and its bytes stay on disk with no quarantine directory', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const target = path.join(h.stateDir, 'merge-queue.json');
    writeFileSync(target, 'not json');
    const first = await watch(h, 'proj-alpha');
    expect(first).toMatchObject({ outcome: 'blind', exitCode: 1 });
    const second = await watch(h, 'proj-alpha');
    expect(second).toMatchObject({ outcome: 'blind', exitCode: 1 });
    expect(readFileSync(target, 'utf8')).toBe('not json');
    expect(existsSync(path.join(h.stateDir, 'quarantine'))).toBe(false);
  });

  it('with no alert wired by default an unhealthy pass speaks nothing: all four announce counters are zero', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const result = await watch(h, 'proj-alpha');
    // The fixture is unhealthy, so "speaks nothing" is not vacuous.
    expect(result).toMatchObject({
      healthy: false,
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 0,
      announceUnspoken: 0,
    });
  });

  it('with no state directory the composed watchdog is the documented in-memory one: durable false and a pass evaluates healthy touching no disk (fix-3 mutation: forcing the durable read-only queue fails here)', async () => {
    const nowIso = new Date().toISOString();
    const gh = ghStub();
    const runtime = createFleetCliRuntime({
      installation: installation([REPO_A]),
      forgeGhRunner: gh.run,
      daemonNow: () => nowIso,
    });
    expect(runtime.daemon.durable).toBe(false);
    await writeTickStatus({ stateDir: '', gh, runtime } as Harness, nowIso);
    const result = await (runtime.daemon.watchTrainHealth.watchTrainHealth({
      projectId: 'proj-alpha',
      repository: { owner: OWNER, repo: REPO_A },
      repoDigest: digestOf(REPO_A),
      deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    }) as Promise<Record<string, unknown>>);
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: true, exitCode: 0, findings: [] });
  });
});

describe('daemon watchdog CLI (CO-WD5b)', () => {
  function watchdogHarness(nowIso: string): Harness {
    return harness([REPO_A], { daemonNow: () => nowIso });
  }

  async function writeTickStatus(h: Harness, finishedAtIso: string): Promise<void> {
    const written = await h.runtime.daemon.status.write({
      tickId: `tick-0${'1'.repeat(25)}`,
      startedAtIso: finishedAtIso,
      finishedAtIso,
      paused: false,
      halted: false,
      forgeReachable: true,
      jobs: [
        {
          jobId: `merge-pass:${digestOf(REPO_A)}`,
          outcome: 'completed',
          reasonCode: null,
          leaseFence: 1,
          durationMs: 5,
          nextNotBeforeIso: null,
          consecutiveBudgetExhausted: 0,
        },
      ] as DaemonStatusRecord['jobs'],
      repositories: [],
      notifierCursor: null,
    });
    expect(written.ok).toBe(true);
  }

  /** A runtime whose watchdog port answers the given stubbed pass, keeping every other port real. */
  function withWatch(source: Harness | FleetCliRuntime, impl: () => Promise<unknown>): FleetCliRuntime {
    const runtime: FleetCliRuntime = (source as Harness).runtime ?? (source as FleetCliRuntime);
    return {
      ...runtime,
      daemon: { ...runtime.daemon, watchTrainHealth: { watchTrainHealth: impl } },
    } as unknown as FleetCliRuntime;
  }

  /** A runtime whose merge policy answers the given stubbed answer, keeping every other port real. */
  function withPolicy(source: Harness | FleetCliRuntime, answer: unknown): FleetCliRuntime {
    const runtime: FleetCliRuntime = (source as Harness).runtime ?? (source as FleetCliRuntime);
    return {
      ...runtime,
      daemon: { ...runtime.daemon, mergePolicy: { readMergePolicy: async () => answer } },
    } as unknown as FleetCliRuntime;
  }

  /** The healthy fixture: zero findings, so exit 0 requires nothing else. */
  const VALID_ANSWER = {
    outcome: 'evaluated',
    exitCode: 0,
    healthy: true,
    findings: [] as Array<{ rule: string; key: string; pullRequest: number | null }>,
    unknownForgeStates: 0,
    truncated: false,
    queueOverflow: false,
    raised: 0,
    cleared: 0,
    attentionFailures: 0,
    budgetExhausted: false,
    announced: 0,
    announceFailures: 0,
    announceSuppressed: 0,
    announceUnspoken: 0,
  };

  /** The unhealthy fixture: evaluated but the train is not healthy. */
  const UNHEALTHY_ANSWER = { ...VALID_ANSWER, healthy: false, exitCode: 1 as number };

  const EXPECTED_EVALUATED = {
    repoDigest: 'd0',
    outcome: 'evaluated',
    exitCode: 0,
    healthy: true,
    findings: [],
    raised: 0,
    cleared: 0,
    attentionFailures: 0,
  };

  function refusedLike(report: unknown, digest: string): void {
    expect(report).toMatchObject({
      repoDigest: digest,
      outcome: 'refused',
      exitCode: 1,
      reasonCode: 'watch-failed',
      findings: [],
      raised: 0,
      cleared: 0,
      attentionFailures: 0,
    });
  }

  it('(g) rejects --budget-seconds 0, --budget-seconds 3601, --budget-seconds -1, duplicates, --json --json, --json=true and unknown flags with exit 2, DAEMON_HELP on stderr and no status store written', async () => {
    for (const extra of [
      ['--budget-seconds', '0'],
      ['--budget-seconds', '3601'],
      ['--budget-seconds', '-1'],
      ['--budget-seconds', '60', '--budget-seconds', '60'],
      ['--json', '--json'],
      ['--json=true'],
      ['--explode'],
      ['--budget-seconds'],
    ]) {
      const h = watchdogHarness(new Date().toISOString());
      const answer = await run(h.runtime, ['daemon', 'watchdog', ...extra]);
      expect(answer.code, JSON.stringify(extra)).toBe(2);
      expect(answer.err, JSON.stringify(extra)).toContain('Invalid daemon watchdog arguments');
      expect(answer.err, JSON.stringify(extra)).toContain(DAEMON_HELP);
      expect(answer.out, JSON.stringify(extra)).toBe('');
      expect(existsSync(path.join(h.stateDir, 'daemon', 'status.json')), JSON.stringify(extra)).toBe(false);
    }
  });

  it('(h) without a durable state directory refuses with exit 2 before reading the clock or the policy', async () => {
    let clockCalls = 0;
    let policyCalls = 0;
    const base = createFleetCliRuntime({
      installation: installation([REPO_A]),
      forgeGhRunner: ghStub().run,
      daemonNow: () => new Date().toISOString(),
    });
    const runtime: FleetCliRuntime = {
      ...base,
      daemon: {
        ...base.daemon,
        now: () => {
          clockCalls += 1;
          return base.daemon.now();
        },
        mergePolicy: {
          readMergePolicy: () => {
            policyCalls += 1;
            return base.daemon.mergePolicy.readMergePolicy();
          },
        },
      },
    };
    const answer = await run(runtime, ['daemon', 'watchdog']);
    expect(answer.code).toBe(2);
    expect(answer.err).toContain('daemon watchdog needs a durable state directory');
    expect(answer.err).toContain(DAEMON_HELP);
    expect(clockCalls, 'the clock must not be read').toBe(0);
    expect(policyCalls, 'the policy must not be read').toBe(0);
  });

  it('(i) refuses with policy-invalid and exit 1 when the merge policy is unknown and never echoes the installation path', async () => {
    const stateDir = tempDir();
    const unknown = createFleetCliRuntime({
      stateDir,
      forgeGhRunner: ghStub().run,
      daemonNow: () => new Date().toISOString(),
      loadInstallationForMergePolicy: () => ({ status: 'invalid', file: '/private/install.json', errors: ['bad'] }),
    });
    const answer = await run(unknown, ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out)).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'policy-invalid' });
    expect(answer.out).not.toContain('/private');
  });

  it('(j) in text mode a stale train prints `watchdog <digest> unhealthy findings=1` and the `finding train-health:tick-stale` key', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const answer = await run(h.runtime, ['daemon', 'watchdog']);
    expect(answer.code).toBe(1);
    expect(answer.out).toContain(`watchdog ${digestOf(REPO_A)} unhealthy findings=1`);
    expect(answer.out).toContain('finding train-health:tick-stale');
  });

  it('(k) in json mode across a full stale pass neither stdout nor stderr contains the state directory path', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const answer = await run(h.runtime, ['daemon', 'watchdog', '--json']);
    expect(answer.out).not.toContain(h.stateDir);
    expect(answer.err).not.toContain(h.stateDir);
    expect(answer.out).not.toContain('/tmp');
  });

  it('(l) `daemon --help` lists the daemon watchdog line', async () => {
    const h = watchdogHarness(new Date().toISOString());
    const answer = await run(h.runtime, ['daemon', '--help']);
    expect(answer.out).toContain('daemon watchdog [--budget-seconds <n>] [--json]');
  });

  it('a throwing or invalid clock refuses with invalid-clock and exit 1 before any watch runs', async () => {
    let watched = 0;
    for (const brokenNow of [
      () => 'not-a-time',
      () => {
        throw new Error(`clock exploded at ${new Date().toISOString()}`);
      },
    ]) {
      const h = harness([REPO_A], { daemonNow: brokenNow });
      const answer = await run(withWatch(h, async () => {
        watched += 1;
        return null;
      }), ['daemon', 'watchdog']);
      expect(answer.code, String(brokenNow)).toBe(1);
      expect(lastJson(answer.out), String(brokenNow)).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' });
    }
    expect(watched).toBe(0);
  });

  it('an invalid policy budget refuses with invalid-budget and exit 1 without running any watch', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const real = await h.runtime.daemon.mergePolicy.readMergePolicy();
    if (real.outcome !== 'known') {
      throw new Error('the fixture policy should be known');
    }
    let watched = 0;
    const answer = await run(withWatch(withPolicy(h, { ...real, daemon: { ...real.daemon, budgetSeconds: 0 } }), async () => {
      watched += 1;
      return null;
    }), ['daemon', 'watchdog']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out)).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-budget' });
    expect(watched).toBe(0);
  });

  it('more than 32 configured repositories refuse with too-many-repositories and exit 1 before any watch runs', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const real = await h.runtime.daemon.mergePolicy.readMergePolicy();
    if (real.outcome !== 'known') {
      throw new Error('the fixture policy should be known');
    }
    const repos = Array.from({ length: 33 }, (_, index) => ({
      ...real.repositories[0],
      repo: `${REPO_A}-${index}`,
    }));
    let watched = 0;
    const answer = await run(withWatch(withPolicy(h, { ...real, repositories: repos }), async () => {
      watched += 1;
      return null;
    }), ['daemon', 'watchdog']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out)).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'too-many-repositories' });
    expect(watched).toBe(0);
  });

  it('zero configured repositories complete with exit 0, repositoryCount 0 and an empty repositories list', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const real = await h.runtime.daemon.mergePolicy.readMergePolicy();
    if (real.outcome !== 'known') {
      throw new Error('the fixture policy should be known');
    }
    const answer = await run(withPolicy(h, { ...real, repositories: [] }), ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(0);
    expect(lastJson(answer.out)).toEqual({
      outcome: 'completed',
      exitCode: 0,
      repositoryCount: 0,
      repositories: [],
      audibleAlert: 'off',
    });
  });

  it('a throwing watch and a null watch both fail closed to a watch-failed repo entry with exit 1', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const throwing = await run(withWatch(h, async () => {
      throw new Error(`secret ${h.stateDir}`);
    }), ['daemon', 'watchdog', '--json']);
    expect(throwing.code).toBe(1);
    expect(lastJson(throwing.out).repositories).toEqual([
      {
        repoDigest: digestOf(REPO_A),
        outcome: 'refused',
        exitCode: 1,
        reasonCode: 'watch-failed',
        findings: [],
        raised: 0,
        cleared: 0,
        attentionFailures: 0,
        announced: 0,
        announceFailures: 0,
        announceSuppressed: 0,
        announceUnspoken: 0,
      },
    ]);
    expect(throwing.out).not.toContain(h.stateDir);

    const nulled = await run(withWatch(h, async () => null), ['daemon', 'watchdog', '--json']);
    expect(nulled.code).toBe(1);
    expect(lastJson(nulled.out).repositories).toEqual(lastJson(throwing.out).repositories);
  });

  it('a budget-exhausted pass reports outcome budget-exhausted with exitCode 1 and an empty findings list', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(withWatch(h, async () => ({ outcome: 'budget-exhausted', exitCode: 1 })), [
      'daemon',
      'watchdog',
      '--json',
    ]);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out).repositories).toEqual([
      {
        repoDigest: digestOf(REPO_A),
        outcome: 'budget-exhausted',
        exitCode: 1,
        findings: [],
        raised: 0,
        cleared: 0,
        attentionFailures: 0,
        announced: 0,
        announceFailures: 0,
        announceSuppressed: 0,
        announceUnspoken: 0,
      },
    ]);
  });

  it('a malformed finding key becomes train-health:unknown, a non-integer pullRequest becomes null and a wrong-rule falls back to unknown', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(
      withWatch(h, async () => ({
        ...VALID_ANSWER,
        healthy: false,
        exitCode: 1,
        findings: [{ rule: 'TICK!', key: 'BAD KEY', pullRequest: 'seven' }],
      })),
      ['daemon', 'watchdog', '--json'],
    );
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out).repositories).toEqual([
      {
        repoDigest: digestOf(REPO_A),
        outcome: 'evaluated',
        exitCode: 1,
        healthy: false,
        findings: [{ rule: 'unknown', key: 'train-health:unknown', pullRequest: null }],
        raised: 0,
        cleared: 0,
        attentionFailures: 0,
        announced: 0,
        announceFailures: 0,
        announceSuppressed: 0,
        announceUnspoken: 0,
      },
    ]);
  });

  it('an evaluated answer with exitCode 0 but healthy missing exits 1 and prints the unhealthy verdict', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const withoutHealthy = {
      outcome: 'evaluated',
      exitCode: 0,
      findings: [] as Array<{ rule: string; key: string; pullRequest: number | null }>,
      raised: 0,
      cleared: 0,
      attentionFailures: 0,
    };
    const answer = await run(withWatch(h, async () => withoutHealthy), ['daemon', 'watchdog']);
    expect(answer.code).toBe(1);
    expect(answer.out).toContain(`watchdog ${digestOf(REPO_A)} unhealthy`);
  });

  it('an evaluated answer with exitCode 0 but healthy false exits 1 and prints the unhealthy verdict', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(withWatch(h, async () => UNHEALTHY_ANSWER), ['daemon', 'watchdog']);
    expect(answer.code).toBe(1);
    expect(answer.out).toContain(`watchdog ${digestOf(REPO_A)} unhealthy`);
  });

  it('a healthy evaluated answer with one finding exits 1 and prints the healthy verdict with the finding key', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(
      withWatch(h, async () => ({
        ...VALID_ANSWER,
        findings: [{ rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 7 }],
      })),
      ['daemon', 'watchdog'],
    );
    expect(answer.code).toBe(1);
    expect(answer.out).toContain(`watchdog ${digestOf(REPO_A)} healthy findings=1`);
    expect(answer.out).toContain('finding train-health:tick-stale');
  });

  it('an evaluated answer whose own exitCode is missing or non-zero exits 1 even when healthy with zero findings', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const withoutExitCode = { ...VALID_ANSWER } as Partial<typeof VALID_ANSWER>;
    delete withoutExitCode.exitCode;
    for (const answer of [withoutExitCode, { ...VALID_ANSWER, exitCode: 3 }]) {
      const result = await run(withWatch(h, async () => answer), ['daemon', 'watchdog']);
      expect(result.code, JSON.stringify(answer)).toBe(1);
      expect(result.out, JSON.stringify(answer)).toContain(`watchdog ${digestOf(REPO_A)} healthy findings=0`);
    }
  });

  it('a healthy evaluated answer whose exitCode disagrees (exitCode 1) exits 1', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(withWatch(h, async () => ({ ...VALID_ANSWER, exitCode: 1 })), ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out).repositories).toMatchObject([{ outcome: 'evaluated', exitCode: 1, healthy: true }]);
  });

  it('a refused answer from the watch feeds the exit-code path and exits 1 with its reason code', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(
      withWatch(h, async () => ({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' })),
      ['daemon', 'watchdog', '--json'],
    );
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out).repositories).toEqual([
      {
        repoDigest: digestOf(REPO_A),
        outcome: 'refused',
        exitCode: 1,
        reasonCode: 'invalid-clock',
        findings: [],
        raised: 0,
        cleared: 0,
        attentionFailures: 0,
        announced: 0,
        announceFailures: 0,
        announceSuppressed: 0,
        announceUnspoken: 0,
      },
    ]);
  });

  it('watchdogRepositoryReport(null) refuses with watch-failed and exit 1 without throwing', () => {
    refusedLike(watchdogRepositoryReport('d0', null), 'd0');
  });

  it('watchdogRepositoryReport(undefined) refuses with watch-failed and exit 1 without throwing', () => {
    refusedLike(watchdogRepositoryReport('d0', undefined), 'd0');
  });

  it('wrong primitives are refused: a number where a digest string is due is redacted to unknown and a string where findings are due refuses', () => {
    const wrongDigest = watchdogRepositoryReport(42, VALID_ANSWER);
    expect(wrongDigest.repoDigest).toBe('unknown');
    expect(wrongDigest.outcome).toBe('evaluated');
    expect(wrongDigest.exitCode).toBe(0);
    refusedLike(watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: 'abc' }), 'd0');
  });

  it('a non-iterable object where findings are due refuses with watch-failed', () => {
    refusedLike(watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: {} }), 'd0');
  });

  it('an array hole in findings maps that slot to the unknown finding instead of throwing or echoing the hole', () => {
    const sparse: unknown[] = [{ rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 1 }];
    // eslint-disable-next-line no-sparse-arrays
    sparse[2] = { rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 2 };
    const report = watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: sparse });
    expect(report.outcome).toBe('evaluated');
    expect(report.findings).toEqual([
      { rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 1 },
      { rule: 'unknown', key: 'train-health:unknown', pullRequest: null },
      { rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 2 },
    ]);
  });

  it('an array-like object in place of findings refuses with watch-failed', () => {
    const arrayLike = { length: 1, 0: { rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 1 } };
    refusedLike(watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: arrayLike }), 'd0');
  });

  it('a Proxy reporting its own length descriptor as 2**32 - 1 is refused before any traversal and no element is read', () => {
    const target: unknown[] = [];
    Object.defineProperty(target, 'length', { value: 2 ** 32 - 1, enumerable: false, writable: true });
    Object.defineProperty(target, 0, {
      enumerable: true,
      get() {
        throw new Error('traversal reached a hostile slot');
      },
    });
    let getTraps = 0;
    let elementReads = 0;
    const proxied = new Proxy(target, {
      get(t, key) {
        getTraps += 1;
        return Reflect.get(t, key);
      },
      getOwnPropertyDescriptor(t, key) {
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          elementReads += 1;
        }
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    refusedLike(watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: proxied }), 'd0');
    expect(getTraps, 'no property get may run').toBe(0);
    expect(elementReads, 'no element may be read').toBe(0);
  });

  it('exactly 200 findings are accepted and 201 are refused with watch-failed', () => {
    const finding = (index: number) => ({ rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: index + 1 });
    const atCap = watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: Array.from({ length: 200 }, (_, i) => finding(i)) });
    expect(atCap.outcome).toBe('evaluated');
    expect(atCap.findings.length).toBe(200);
    refusedLike(
      watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: Array.from({ length: 201 }, (_, i) => finding(i)) }),
      'd0',
    );
  });

  it('a Proxy-wrapped findings array has its length read only via ownValue: no get of length runs', () => {
    let lengthGets = 0;
    const findings = [{ rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 1 }];
    const proxied = new Proxy(findings, {
      get(target, key) {
        if (key === 'length') {
          lengthGets += 1;
        }
        return Reflect.get(target, key);
      },
    });
    const report = watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: proxied });
    expect(report.findings).toEqual(findings);
    expect(lengthGets, 'length is read through the own-property descriptor, never a get').toBe(0);
  });

  it('a getter on the answer root and on a finding item never runs: the call counter stays 0 and the report refuses', () => {
    let rootCalls = 0;
    const root: Record<string, unknown> = {};
    Object.defineProperty(root, 'outcome', {
      enumerable: true,
      get() {
        rootCalls += 1;
        return 'evaluated';
      },
    });
    refusedLike(watchdogRepositoryReport('d0', root), 'd0');
    expect(rootCalls).toBe(0);

    let itemCalls = 0;
    const item: Record<string, unknown> = {};
    Object.defineProperty(item, 'key', {
      enumerable: true,
      get() {
        itemCalls += 1;
        return 'train-health:tick-stale';
      },
    });
    const report = watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: [item] });
    expect(report.findings).toEqual([{ rule: 'unknown', key: 'train-health:unknown', pullRequest: null }]);
    expect(itemCalls).toBe(0);
  });

  it('getters on a finding item rule, key and pullRequest never run and the finding is refused with exit 1', () => {
    let calls = 0;
    const item: Record<string, unknown> = {};
    for (const field of ['rule', 'key', 'pullRequest']) {
      Object.defineProperty(item, field, {
        enumerable: true,
        get() {
          calls += 1;
          return field === 'pullRequest' ? 7 : 'train-health:tick-stale';
        },
      });
    }
    const report = watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: [item] });
    expect(calls, 'no finding-item getter may run').toBe(0);
    expect(report.findings).toEqual([{ rule: 'unknown', key: 'train-health:unknown', pullRequest: null }]);
    expect(report.exitCode, 'a finding item that cannot be read is refused').toBe(1);
  });

  it('a Proxy over a valid answer yields exactly the plain-data result and no get trap runs', () => {
    let getTraps = 0;
    const proxied = new Proxy(VALID_ANSWER, {
      get(target, key) {
        getTraps += 1;
        return Reflect.get(target, key);
      },
    });
    const report = watchdogRepositoryReport('d0', proxied);
    expect(report).toMatchObject(EXPECTED_EVALUATED);
    expect(getTraps).toBe(0);
  });

  it('a revoked Proxy as the answer refuses with watch-failed and nothing throws', () => {
    const { proxy, revoke } = Proxy.revocable({ ...VALID_ANSWER }, {});
    revoke();
    refusedLike(watchdogRepositoryReport('d0', proxy), 'd0');
  });

  it('a revoked Proxy in place of findings refuses with watch-failed and nothing throws', () => {
    const findings = [{ rule: 'tick-stale', key: 'train-health:tick-stale', pullRequest: 1 }];
    const { proxy, revoke } = Proxy.revocable(findings, {});
    revoke();
    refusedLike(watchdogRepositoryReport('d0', { ...VALID_ANSWER, findings: proxy }), 'd0');
  });

  it('a prototype-polluting own __proto__ key from JSON.parse neither pollutes Object.prototype nor reaches the verdict', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"outcome":"blind","exitCode":1,"reasonCode":"status-unreadable","raised":0,"cleared":0,"attentionFailures":0}',
    ) as Record<string, unknown>;
    const report = watchdogRepositoryReport('d0', hostile);
    expect(report).toMatchObject({
      repoDigest: 'd0',
      outcome: 'blind',
      exitCode: 1,
      reasonCode: 'status-unreadable',
      findings: [],
      raised: 0,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const keys = JSON.parse(
      '{"constructor":1,"prototype":1,"outcome":"evaluated","exitCode":0,"healthy":true,"findings":[],"raised":0,"cleared":0,"attentionFailures":0}',
    ) as Record<string, unknown>;
    expect(watchdogRepositoryReport('d0', keys)).toMatchObject({ outcome: 'evaluated', exitCode: 0 });
  });

  it('the verdict is not a constant: an evaluated healthy answer and a blind answer produce different outcomes and exit codes', () => {
    const healthy = watchdogRepositoryReport('d0', VALID_ANSWER);
    const blind = watchdogRepositoryReport('d0', {
      outcome: 'blind',
      exitCode: 1,
      reasonCode: 'status-unreadable',
      findings: [],
      raised: 0,
      cleared: 0,
      attentionFailures: 0,
    });
    expect(healthy).toMatchObject(EXPECTED_EVALUATED);
    expect(blind).toMatchObject({ outcome: 'blind', exitCode: 1, reasonCode: 'status-unreadable' });
    expect(healthy.outcome).not.toBe(blind.outcome);
    expect(healthy.exitCode).not.toBe(blind.exitCode);
  });

  it('the report is not an identity echo: a hostile reasonCode, an off-pattern key, a non-integer pullRequest and unknown fields are normalized away', () => {
    const hostile = {
      ...VALID_ANSWER,
      reasonCode: '../../etc/passwd',
      findings: [{ rule: 'tick-stale', key: 'not-a-key', pullRequest: 'seven', evidence: { path: '/tmp/secret' } }],
      extraField: 'echo-me-not',
    };
    const report = watchdogRepositoryReport('d0', hostile);
    expect(report).toMatchObject({
      repoDigest: 'd0',
      outcome: 'evaluated',
      // One finding, so even a healthy answer with exitCode 0 exits 1.
      exitCode: 1,
      findings: [{ rule: 'tick-stale', key: 'train-health:unknown', pullRequest: null }],
    });
    expect(JSON.stringify(report)).not.toContain('echo-me-not');
    expect(JSON.stringify(report)).not.toContain('/tmp/secret');
    expect(JSON.stringify(report)).not.toContain('etc/passwd');
  });

  // --- CO-WD9a: the opt-in audible alert ---------------------------------

  it('(a) with no injected alert and FLEET_AUDIBLE_ALERT empty the JSON reports audibleAlert off, zero speaks and the ordinary exit code', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const answer = await run(h.runtime, ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out)).toMatchObject({ outcome: 'completed', exitCode: 1, audibleAlert: 'off' });
    expect(lastJson(answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: false, announced: 0, announceFailures: 0, announceSuppressed: 0, announceUnspoken: 0 },
    ]);
  });

  // --- CO-WD9b: the deterministic throttle scenario tests -----------------

  /**
   * Builds a harness whose `daemonNow` reads a mutable `clock` and whose
   * audible alert is a fake port recording every speak request, plus a helper
   * that replays one stale-tick watchdog pass at the current `clock` and
   * returns the open `train-tick-stale` item's `lastRaisedAtIso`. The
   * coordination attention store stamps `lastRaisedAtIso` from the real clock
   * rather than `daemonNow`, so the helper reads the stamp back instead of
   * deriving it; epoch buckets (`floor(ms / 600_000)`), never elapsed time,
   * decide whether a target is due.
   */
  function throttleHarness(): {
    readonly setClock: (iso: string) => void;
    readonly spoken: Array<{ readonly sentence: string }>;
    readonly replayStalePass: () => Promise<{
      readonly answer: { readonly code: number; readonly out: string };
      readonly lastRaisedAtIso: string;
    }>;
  } {
    let clock = new Date().toISOString();
    const spoken: Array<{ readonly sentence: string }> = [];
    const h = harness([REPO_A], {
      daemonNow: () => clock,
      daemonAudibleAlert: {
        speak: async (request: { readonly sentence: string }) => {
          spoken.push(request);
          return { outcome: 'spoken' as const };
        },
      },
    });
    const replayStalePass = async (): Promise<{
      readonly answer: { readonly code: number; readonly out: string };
      readonly lastRaisedAtIso: string;
    }> => {
      await writeTickStatus(h, new Date(Date.parse(clock) - 10 * 60_000).toISOString());
      const answer = await run(h.runtime, ['daemon', 'watchdog', '--json']);
      const listed = (await h.runtime.coordination.listAttentionItems.listAttentionItems({ state: 'open' })) as {
        readonly items: ReadonlyArray<{
          readonly item: { readonly kind: string; readonly lastRaisedAtIso: string };
        }>;
      };
      const stale = listed.items.find((entry) => entry.item.kind === 'train-tick-stale');
      expect(stale, 'the stale tick item must still be open').toBeDefined();
      return { answer, lastRaisedAtIso: (stale as { readonly item: { readonly lastRaisedAtIso: string } }).item.lastRaisedAtIso };
    };
    return { setClock: (iso) => { clock = iso; }, spoken, replayStalePass };
  }

  it('(b) the first stale pass speaks the throttled sentence once and reports announced 1 with audibleAlert spd-say', async () => {
    const throttle = throttleHarness();
    const first = await throttle.replayStalePass();

    expect(first.answer.code).toBe(1);
    expect(lastJson(first.answer.out)).toMatchObject({ outcome: 'completed', exitCode: 1, audibleAlert: 'spd-say' });
    expect(lastJson(first.answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: false, announced: 1, announceFailures: 0, announceSuppressed: 0, announceUnspoken: 0 },
    ]);
    expect(throttle.spoken).toEqual([{ sentence: 'The merge train has stopped ticking.' }]);
  });

  it('(c) a second stale pass in the same epoch bucket is not due: nothing further speaks and every announce counter stays 0', async () => {
    const throttle = throttleHarness();
    const first = await throttle.replayStalePass();
    // `lastRaisedAtIso` was stamped during the first pass, so re-reading the
    // clock there keeps `floor(now / 600_000) === floor(last / 600_000)`.
    throttle.setClock(first.lastRaisedAtIso);
    const second = await throttle.replayStalePass();

    expect(second.answer.code).toBe(1);
    expect(lastJson(second.answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: false, announced: 0, announceFailures: 0, announceSuppressed: 0, announceUnspoken: 0 },
    ]);
    expect(throttle.spoken, 'the same-epoch-bucket pass must not speak again').toHaveLength(1);
  });

  it('(d) a stale pass in the next epoch bucket speaks the same sentence again', async () => {
    const throttle = throttleHarness();
    const first = await throttle.replayStalePass();
    // Replay pass (c): same epoch bucket, so nothing further speaks and the
    // item's stamp is refreshed.
    throttle.setClock(first.lastRaisedAtIso);
    const second = await throttle.replayStalePass();
    // +600_000 ms is always the next epoch bucket, so `isDue` returns true.
    throttle.setClock(new Date(Date.parse(second.lastRaisedAtIso) + 600_000).toISOString());
    const third = await throttle.replayStalePass();

    expect(third.answer.code).toBe(1);
    expect(lastJson(third.answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: false, announced: 1, announceFailures: 0, announceSuppressed: 0 },
    ]);
    expect(third.lastRaisedAtIso >= second.lastRaisedAtIso).toBe(true);
    expect(throttle.spoken).toEqual([
      { sentence: 'The merge train has stopped ticking.' },
      { sentence: 'The merge train has stopped ticking.' },
    ]);
  });

  it('(e) a speak that throws on a stale tick keeps the pass, exits 1 with announceFailures 1 and leaves train-tick-stale open', async () => {
    const nowIso = new Date().toISOString();
    let speakCalls = 0;
    const h = harness([REPO_A], {
      daemonNow: () => nowIso,
      daemonAudibleAlert: {
        speak: async () => {
          speakCalls += 1;
          throw new Error('speaker exploded');
        },
      },
    });
    await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
    const answer = await run(h.runtime, ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: false, announced: 0, announceFailures: 1 },
    ]);
    expect(speakCalls).toBeGreaterThanOrEqual(1);
    const listed = (await h.runtime.coordination.listAttentionItems.listAttentionItems({ state: 'open' })) as {
      readonly items: ReadonlyArray<{ readonly item: { readonly kind: string } }>;
    };
    expect(listed.items.filter((entry) => entry.item.kind === 'train-tick-stale')).toHaveLength(1);
  });

  it('(e) an announceUnspoken of 1 on a healthy evaluated pass exits 0 and reports announceUnspoken 1 (unspoken skips are best-effort)', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    const answer = await run(
      withWatch(h, async () => ({ ...VALID_ANSWER, announceUnspoken: 1 })),
      ['daemon', 'watchdog', '--json'],
    );
    expect(answer.code).toBe(0);
    expect(lastJson(answer.out)).toMatchObject({ outcome: 'completed', exitCode: 0, audibleAlert: 'off' });
    expect(lastJson(answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: true, announceUnspoken: 1, exitCode: 0 },
    ]);
  });

  it('(g) with FLEET_AUDIBLE_ALERT=banana a healthy train still exits 1 with reasonCode audible-alert-invalid and never echoes the value', async () => {
    vi.stubEnv('FLEET_AUDIBLE_ALERT', 'banana');
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, nowIso);
    const answer = await run(h.runtime, ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(1);
    expect(lastJson(answer.out)).toMatchObject({
      outcome: 'completed',
      exitCode: 1,
      audibleAlert: 'invalid',
      reasonCode: 'audible-alert-invalid',
    });
    expect(lastJson(answer.out).repositories).toMatchObject([
      { outcome: 'evaluated', healthy: true, announced: 0, announceFailures: 0 },
    ]);
    expect(answer.out).not.toContain('banana');
    expect(answer.err).not.toContain('banana');
  });

  it('(h) in text mode the first line is `watchdog audible-alert=off` and each repository line ends with ` announced=0`', async () => {
    const nowIso = new Date().toISOString();
    const h = watchdogHarness(nowIso);
    await writeTickStatus(h, nowIso);
    const answer = await run(h.runtime, ['daemon', 'watchdog']);
    expect(answer.code).toBe(0);
    const lines = answer.out.trim().split('\n');
    expect(lines[0]).toBe('watchdog audible-alert=off');
    expect(lines[1]).toBe(
      `watchdog ${digestOf(REPO_A)} healthy findings=0 raised=0 cleared=0 announced=0`,
    );
  });

  it('(fix) with an invalid FLEET_AUDIBLE_ALERT value no SpdSay adapter is composed: no speak ever runs even on an unhealthy train, and the reported mode is invalid', async () => {
    // Composition has no injectable seam for observing adapter construction, so
    // the test observes the smallest visible effect: the adapter prototype's
    // `speak`. A composition that builds an adapter for an invalid value and
    // hands it to an unhealthy train must reach this spy; the pass must stay at 0.
    const speakSpy = vi.spyOn(SpdSayHostAudibleAlertAdapter.prototype, 'speak');
    try {
      vi.stubEnv('FLEET_AUDIBLE_ALERT', 'banana');
      // A real (not stubbed) unhealthy pass: a stale tick makes the evaluated
      // train unhealthy, so a wrongly composed adapter would actually speak.
      const nowIso = new Date().toISOString();
      const h = watchdogHarness(nowIso);
      await writeTickStatus(h, new Date(Date.parse(nowIso) - 10 * 60_000).toISOString());
      const answer = await run(h.runtime, ['daemon', 'watchdog', '--json']);
      expect(answer.code).toBe(1);
      expect(lastJson(answer.out)).toMatchObject({
        outcome: 'completed',
        exitCode: 1,
        audibleAlert: 'invalid',
        reasonCode: 'audible-alert-invalid',
      });
      expect(speakSpy, 'an invalid mode must compose no adapter at all').toHaveBeenCalledTimes(0);
    } finally {
      speakSpy.mockRestore();
    }
  });

  it('(fix) an injected fake alert port makes the reported audibleAlert spd-say without any real binary', async () => {
    const recorded: Array<{ readonly sentence: string }> = [];
    const h = harness([REPO_A], {
      daemonNow: () => new Date().toISOString(),
      daemonAudibleAlert: {
        speak: async (request: { readonly sentence: string }) => {
          recorded.push(request);
          return { outcome: 'spoken' as const };
        },
      },
    });
    const answer = await run(withWatch(h, async () => VALID_ANSWER), ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(0);
    expect(lastJson(answer.out)).toMatchObject({ outcome: 'completed', exitCode: 0, audibleAlert: 'spd-say' });
    expect(recorded, 'the fake port records every speak request').toEqual([]);
  });

  it('(fix) the composition reads FLEET_AUDIBLE_ALERT from options.env only: set there it enables spd-say while process.env stays empty', async () => {
    // The file-level beforeEach stubs process.env to '', so process.env cannot
    // supply the value; only the runtime's own `env` option can.
    const h = harness([REPO_A], {
      daemonNow: () => new Date().toISOString(),
      env: { FLEET_AUDIBLE_ALERT: 'spd-say' },
    });
    const answer = await run(withWatch(h, async () => VALID_ANSWER), ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(0);
    expect(lastJson(answer.out)).toMatchObject({ outcome: 'completed', exitCode: 0, audibleAlert: 'spd-say' });
  });

  it('(fix) the composition reads FLEET_AUDIBLE_ALERT from options.env only: an empty options.env keeps the mode off even when process.env carries spd-say', async () => {
    vi.stubEnv('FLEET_AUDIBLE_ALERT', 'spd-say');
    const h = harness([REPO_A], {
      daemonNow: () => new Date().toISOString(),
      env: {},
    });
    const answer = await run(withWatch(h, async () => VALID_ANSWER), ['daemon', 'watchdog', '--json']);
    expect(answer.code).toBe(0);
    expect(lastJson(answer.out)).toMatchObject({ outcome: 'completed', exitCode: 0, audibleAlert: 'off' });
  });

  it('(f) resolveAudibleAlertMode(null) is invalid', () => {
    expect(resolveAudibleAlertMode(null)).toBe('invalid');
  });

  it('(f) resolveAudibleAlertMode(undefined) is invalid', () => {
    expect(resolveAudibleAlertMode(undefined)).toBe('invalid');
  });

  it('(f) resolveAudibleAlertMode refuses wrong primitives: 42, a bare string, on, 1, padded and uppercased values', () => {
    for (const env of [42, 'spd-say', 'on', '1', ' spd-say', 'SPD-SAY']) {
      expect(resolveAudibleAlertMode(env), JSON.stringify(env)).toBe('invalid');
    }
  });

  it('(f) resolveAudibleAlertMode pins exact match: padded, trailing, uppercased, on, 1 and numeric values are invalid', () => {
    for (const value of [' spd-say', 'spd-say ', 'SPD-SAY', 'on', '1', 42]) {
      const env = { FLEET_AUDIBLE_ALERT: value } as Record<string, unknown>;
      expect(resolveAudibleAlertMode(env), String(value)).toBe('invalid');
    }
  });

  it('(f) resolveAudibleAlertMode answers off for a plain empty object and for an array-like object without the own key', () => {
    expect(resolveAudibleAlertMode({})).toBe('off');
    expect(resolveAudibleAlertMode({ length: 1, 0: 'spd-say' })).toBe('off');
  });

  it('(f) resolveAudibleAlertMode refuses a sparse array (an array hole where an env object is due)', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [,];
    expect(resolveAudibleAlertMode(sparse)).toBe('invalid');
  });

  it('(f) resolveAudibleAlertMode refuses an enormous sparse array of length 2**32 - 1 before any traversal', () => {
    const enormous = new Array(2 ** 32 - 1);
    expect(resolveAudibleAlertMode(enormous)).toBe('invalid');
  });

  it('(f) a getter on FLEET_AUDIBLE_ALERT never runs: the call counter stays 0 and the mode is invalid', () => {
    let calls = 0;
    const env: Record<string, unknown> = {};
    Object.defineProperty(env, 'FLEET_AUDIBLE_ALERT', {
      enumerable: true,
      get() {
        calls += 1;
        return 'spd-say';
      },
    });
    expect(resolveAudibleAlertMode(env)).toBe('invalid');
    expect(calls, 'no getter may run').toBe(0);
  });

  it('(f) a Proxy over a valid env yields exactly the plain-data verdict with no get trap, and a revoked Proxy is invalid', () => {
    let getTraps = 0;
    const proxied = new Proxy({ FLEET_AUDIBLE_ALERT: 'spd-say' }, {
      get(target, key) {
        getTraps += 1;
        return Reflect.get(target, key);
      },
    });
    expect(resolveAudibleAlertMode(proxied)).toBe('spd-say');
    expect(getTraps, 'no get trap may run').toBe(0);

    const { proxy, revoke } = Proxy.revocable({ FLEET_AUDIBLE_ALERT: 'spd-say' }, {});
    revoke();
    expect(resolveAudibleAlertMode(proxy)).toBe('invalid');
  });

  it('(f) a prototype-polluting own __proto__ key from JSON.parse answers off without polluting Object.prototype', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":1}',
    ) as Record<string, unknown>;
    expect(resolveAudibleAlertMode(hostile)).toBe('off');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  it('(f) the mode is not a constant: spd-say, off and invalid are three distinct verdicts', () => {
    const spoken = resolveAudibleAlertMode({ FLEET_AUDIBLE_ALERT: 'spd-say' });
    const silent = resolveAudibleAlertMode({});
    const broken = resolveAudibleAlertMode({ FLEET_AUDIBLE_ALERT: 'banana' });
    expect(spoken).toBe('spd-say');
    expect(silent).toBe('off');
    expect(broken).toBe('invalid');
    expect(new Set([spoken, silent, broken]).size).toBe(3);
  });

  it('(f) the mode is not an identity echo: hostile inputs never come back as themselves', () => {
    expect(resolveAudibleAlertMode({ FLEET_AUDIBLE_ALERT: 'banana' })).toBe('invalid');
    expect(resolveAudibleAlertMode(42)).toBe('invalid');
    expect(resolveAudibleAlertMode('spd-say')).toBe('invalid');
    expect(resolveAudibleAlertMode(null)).toBe('invalid');
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
