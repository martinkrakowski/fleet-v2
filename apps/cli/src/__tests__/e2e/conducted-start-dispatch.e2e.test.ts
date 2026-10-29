// Lane Q1b: scenarios 1-3 of the production-quality plan §4.1, driven for
// real over ssh to localhost. Everything below is skipped unless
// FLEET_E2E_SSH=1; with it, `conductor start` and `conductor run --live
// --once` dispatch a REAL lane through `bin/ocm-run` to the fixture's sshd
// and the fake opencode server. Every scenario is bounded to 120 s and every
// fixture is stopped even on failure.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { LocalExecutor, SshExecutor } from '@fleet/work-execution';

import { startConductedFixture, type ConductedFixture } from './conducted.js';

const TEST_TIMEOUT_MS = 120000;

const liveFixtures = new Set<ConductedFixture>();

async function startFixture(options?: Parameters<typeof startConductedFixture>[0]) {
  const current = await startConductedFixture(options);
  liveFixtures.add(current);
  return current;
}

afterEach(async () => {
  const current = [...liveFixtures];
  liveFixtures.clear();
  for (const instance of current) {
    await instance.stop();
  }
});

/** The fake opencode server's loopback port (the recorded runner port). */
function fakePortOf(current: ConductedFixture): number {
  return Number(new URL(current.fakeOpencodeUrl).port);
}

function findAttemptOf(current: ConductedFixture) {
  return current.runtime.execution.attemptRepository.findAttemptById(current.attemptId);
}

function runRecordOf(current: ConductedFixture) {
  return current.runtime.conductor.laneRunRepository.get(current.runId);
}

function journalOf(current: ConductedFixture) {
  return current.runtime.conductor.laneRunJournal.listForRun(current.runId);
}

/** Parse the first stdout line of a run/start result as a JSON document. */
function firstDocument(result: { stdout: readonly string[] }): Record<string, unknown> {
  const line = result.stdout.find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    throw new Error('the command printed no JSON document');
  }
  return JSON.parse(line) as Record<string, unknown>;
}

/** True when no local run() argv mentions the worktree except ocm-run's own. */
function onlyOcmRunTouchesWorktree(
  calls: readonly string[][],
  worktreeRoot: string,
): boolean {
  for (const argv of calls) {
    if (argv.some((word) => word.includes(worktreeRoot)) && !argv[0].includes('ocm-run')) {
      return false;
    }
  }
  return true;
}

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')('conducted start + dispatch over ssh (Q1b)', () => {
  it('scenario 1a: a matching seat agent starts, and one live pass dispatches over ssh', async () => {
    const current = await startFixture();

    const startResult = await current.start(1);
    expect(startResult.code).toBe(0);
    expect(firstDocument(startResult)).toMatchObject({ outcome: 'started' });

    // The attempt carries the seat selection and the recorded host (KF-8/KF-10).
    const attempt = await findAttemptOf(current);
    expect(attempt).not.toBeNull();
    expect(attempt!.seatSelection!.agent).toBe('lane');
    expect(attempt!.runner).toEqual({
      kind: 'opencode',
      hostName: 'lane-host',
      host: 'fleet-e2e',
      remotePort: fakePortOf(current),
      agent: null,
      model: null,
      variant: null,
    });

    // One live pass dispatches the lane for real.
    const pass = await current.runPass();
    expect(pass.code).toBe(0);

    // The ocm-run wrapper saw the real dispatch argv.
    const ocmLines = (await fs.readFile(current.ocmRunArgvLog, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(ocmLines.length).toBeGreaterThan(0);
    expect(ocmLines.some((line) => line.includes(`--dir ${current.worktreeRoot}`))).toBe(true);
    expect(ocmLines.some((line) => line.includes('--agent lane'))).toBe(true);

    // The fake opencode client saw the lane prompt argv with the agent.
    const fakeLines = (await fs.readFile(current.fakeArgvFile, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(fakeLines.some((line) => line.includes('--agent lane'))).toBe(true);

    // The attempt's runner now carries the dispatch's agent, model and variant.
    const dispatched = await findAttemptOf(current);
    expect(dispatched!.runner!.agent).toBe('lane');
    expect(dispatched!.runner!.model).toBe('example/implementer-model');
    expect(['dispatching', 'running', 'reconciling']).toContain(dispatched!.state);

    // The run journal holds the dispatch-started result for this run.
    const entries = await journalOf(current);
    expect(entries.some((entry) =>
      entry.kind === 'result'
      && entry.key !== null
      && entry.key.includes('/dispatch/')
      && entry.reasonCode === 'dispatch-started',
    )).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('scenario 1b: a mismatched assignment agent is refused before any reservation or worktree', async () => {
    const current = await startFixture({ assignmentAgent: 'other-agent' });

    const startResult = await current.start(1);
    expect(startResult.code).toBe(1);
    expect(firstDocument(startResult)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });

    // KF-7: nothing was written — no reservation, no worktree, no run record.
    const reservations = await current.runtime.execution.executionJournal.listActiveReservations();
    expect(reservations).toEqual([]);
    expect(readdirSync(current.worktreeRoot)).toEqual([]);
    expect(await runRecordOf(current)).toBeNull();
    expect(await findAttemptOf(current)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('scenario 2: the recorded host is ssh fleet-e2e and every worktree git call ran through it', async () => {
    const sshSpy = vi.spyOn(SshExecutor.prototype, 'run');

    const current = await startFixture();
    const startResult = await current.start(1);
    expect(startResult.code).toBe(0);
    const pass = await current.runPass();
    expect(pass.code).toBe(0);

    const sshCalls: Array<{ host: string; argv: string[] }> = sshSpy.mock.calls.map(
      (call, index) => ({
        host: (sshSpy.mock.contexts[index] as SshExecutor).sshHost,
        argv: [...call[0]],
      }),
    );

    // The reservation records the ssh transport facts (KF-8).
    const reservations = await current.runtime.execution.executionJournal.listActiveReservations();
    const reservation = reservations.find((entry) => entry.attemptId === current.attemptId);
    expect(reservation).toBeDefined();
    expect(reservation!.transport).toBe('ssh');
    expect(reservation!.sshAlias).toBe('fleet-e2e');
    expect(reservation!.port).toBe(fakePortOf(current));
    expect(reservation!.hostName).toBe('lane-host');

    // Before dispatch the attempt's runner was the bare recorded host; after
    // dispatch it carries the seat's agent/model/variant.
    const attempt = await findAttemptOf(current);
    expect(attempt!.runner!.hostName).toBe('lane-host');
    expect(attempt!.runner!.host).toBe('fleet-e2e');
    expect(attempt!.runner!.agent).toBe('lane');
    expect(attempt!.runner!.model).toBe('example/implementer-model');
    expect(attempt!.runner!.variant).toBe('default');

    // The ocm-run wrapper recorded the v2 routing env.
    const envLog = await fs.readFile(current.ocmRunEnvLog, 'utf8');
    expect(envLog).toContain('OCM_HOST=fleet-e2e');
    expect(envLog).toContain(`OCM_REMOTE_PORT=${fakePortOf(current)}`);

    // The worktree exists at <worktreeRoot>/<32 hex> on the run's branch at
    // the base commit, with the placed brief files.
    const worktrees = readdirSync(current.worktreeRoot).filter((name) => /^[0-9a-f]{32}$/.test(name));
    expect(worktrees).toHaveLength(1);
    const worktreePath = path.join(current.worktreeRoot, worktrees[0]);
    expect(await fs.readFile(path.join(worktreePath, '.lane', 'brief.md'), 'utf8')).toContain('Example lane brief');
    const manifest = JSON.parse(
      await fs.readFile(path.join(worktreePath, '.lane', 'brief-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest.workOrderId).toBe('wo-example-1');
    const head = String(execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
    expect(head).toBe(current.baseCommit);
    const branch = String(execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })).trim();
    expect(branch).toBe(`fleet/${current.runId}`);

    // Every worktree git command ran on the recorded host fleet-e2e.
    const sawCommand = (tokens: readonly string[]) =>
      sshCalls.some((call) =>
        call.host === 'fleet-e2e'
        && tokens.every((token) => call.argv.includes(token)));
    expect(sawCommand(['worktree', 'add'])).toBe(true);
    expect(sawCommand(['check-ignore'])).toBe(true);
    expect(sawCommand(['mkdir'])).toBe(true);
    expect(sawCommand(['tee'])).toBe(true);
    expect(sawCommand(['rev-parse'])).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('scenario 3: no local fallback — the worktree only appears in the ocm-run argv, and a renamed host parks the dispatch', async () => {
    const localSpy = vi.spyOn(LocalExecutor.prototype, 'run');

    // Part 1: a normal start and dispatch — the only local argv that names
    // the worktree is the ocm-run invocation itself (KF-10/Q2a).
    const dispatched = await startFixture();
    const startResult = await dispatched.start(1);
    expect(startResult.code).toBe(0);
    const pass = await dispatched.runPass();
    expect(pass.code).toBe(0);
    expect(onlyOcmRunTouchesWorktree(
      localSpy.mock.calls.map((call) => [...call[0]]),
      dispatched.worktreeRoot,
    )).toBe(true);

    // Part 2: the recorded host is renamed in the installation file AFTER the
    // start; the next pass refuses the dispatch against the recorded host
    // (never a local run) and parks the run step-refused / dispatch.
    const renamed = await startFixture();
    const renamedStart = await renamed.start(1);
    expect(renamedStart.code).toBe(0);

    const installationPath = path.join(renamed.stateDir, 'installation', 'fleet.json');
    const raw = JSON.parse(await fs.readFile(installationPath, 'utf8')) as Record<string, unknown>;
    const hosts = raw.hosts as Record<string, unknown>;
    hosts['renamed-lane-host'] = hosts['lane-host'];
    delete hosts['lane-host'];
    await fs.writeFile(installationPath, JSON.stringify(raw, null, 2), 'utf8');
    await renamed.rebuildRuntime();

    const secondPass = await renamed.runPass();
    expect(secondPass.code).toBe(0);

    const run = await runRecordOf(renamed);
    expect(run).not.toBeNull();
    expect(run!.parked).not.toBeNull();
    expect(run!.parked!.reason).toBe('step-refused');
    expect(run!.parked!.qualifier).toBe('dispatch');

    const entries = await journalOf(renamed);
    expect(entries.some((entry) =>
      entry.kind === 'result'
      && entry.outcome === 'refused'
      && entry.key !== null
      && entry.key.includes('/dispatch/'),
    )).toBe(true);

    // Still no local fallback after the rename: the worktree path never
    // reached a non-ocm-run local argv.
    expect(onlyOcmRunTouchesWorktree(
      localSpy.mock.calls.map((call) => [...call[0]]),
      renamed.worktreeRoot,
    )).toBe(true);
  }, TEST_TIMEOUT_MS);
});
