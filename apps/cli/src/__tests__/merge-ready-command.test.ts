/**
 * CLI-boundary tests for CO25: `merge ready` and `merge wait` (read-only
 * merge readiness). The forge is a recording stub injected through the
 * runtime's `forgeGhRunner` test option, so no test spawns a process or
 * touches the network; the GraphQL page shape matches the adapter's own
 * fixtures (gh-forge-merge-read-adapter.test.ts).
 */

import { describe, expect, it } from 'vitest';

import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import { runMergeWait, type MergeWaitClock } from '../merge.js';

const VALID_SHA = '3dd5d90509461e3d2154b52da28671aeffa84130';
const GITHUB_FORGE: ForgeSectionV2 = {
  mode: 'github',
  owner: 'example-owner',
  repo: 'example-repo',
};

/** Minimal v2 installation: one local host with a declared container runner. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-o8-worktrees',
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
    forge,
  };
}

interface PageOverrides {
  state?: string;
  headRefOid?: string;
  mergeStateStatus?: string | null;
  contextsNodes?: unknown[];
  threadsNodes?: unknown[];
}

function makePage(overrides: PageOverrides = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: overrides.state ?? 'OPEN',
          headRefOid: overrides.headRefOid ?? VALID_SHA,
          mergeStateStatus: 'mergeStateStatus' in overrides ? overrides.mergeStateStatus : 'CLEAN',
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: overrides.contextsNodes ?? [],
            },
          },
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: overrides.threadsNodes ?? [],
          },
        },
      },
    },
  });
}

function greenCheckRun(name: string): Record<string, unknown> {
  return { __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', creator: null };
}

function pendingCheckRun(name: string): Record<string, unknown> {
  return { __typename: 'CheckRun', name, status: 'IN_PROGRESS' };
}

function collectIo(): {
  out: string[];
  err: string[];
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  };
}

describe('merge ready', () => {
  it('exits 0 and prints ready on a green page', async () => {
    const { io, out } = collectIo();
    const forgeGhRunner = async () => ({
      exitCode: 0,
      stdout: makePage({ contextsNodes: [greenCheckRun('gate')] }),
      stderr: '',
    });
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });

    const code = await runCli(
      ['merge', 'ready', '--repository', 'example-owner/example-repo', '--pull-request', '202'],
      io,
      runtime,
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ready', headOid: VALID_SHA });
  });

  it('exits 1 with still-waiting checks-pending when the gate context is in progress', async () => {
    const { io, out } = collectIo();
    const forgeGhRunner = async () => ({
      exitCode: 0,
      stdout: makePage({ contextsNodes: [pendingCheckRun('gate')] }),
      stderr: '',
    });
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });

    const code = await runCli(
      ['merge', 'ready', '--repository', 'example-owner/example-repo', '--pull-request', '202'],
      io,
      runtime,
    );

    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'still-waiting', reason: 'checks-pending' });
  });

  it('exits 2 when --pull-request is missing', async () => {
    const { io, err } = collectIo();
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE) });

    const code = await runCli(['merge', 'ready', '--repository', 'example-owner/example-repo'], io, runtime);

    expect(code).toBe(2);
    expect(err.join('')).toContain('merge ready: --pull-request must be a positive integer');
  });

  it('exits 2 for a malformed repository without echoing the value', async () => {
    const { io, err } = collectIo();
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE) });

    const code = await runCli(['merge', 'ready', '--repository', 'not-a-repo'], io, runtime);

    expect(code).toBe(2);
    expect(err.join('')).toContain('merge commands require --repository as owner/repo');
    expect(err.join('')).not.toContain('not-a-repo');
  });

  it('answers forge-not-configured without an installation and never calls the gh stub', async () => {
    const { io, out } = collectIo();
    let ghCalls = 0;
    const forgeGhRunner = async () => {
      ghCalls += 1;
      return { exitCode: 0, stdout: makePage(), stderr: '' };
    };
    const runtime = createFleetCliRuntime({ forgeGhRunner });

    const code = await runCli(
      ['merge', 'ready', '--repository', 'example-owner/example-repo', '--pull-request', '202'],
      io,
      runtime,
    );

    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unknown', reason: 'forge-not-configured' });
    expect(ghCalls).toBe(0);
  });
});

describe('merge wait', () => {
  it('polls until ready and exits 0 when the second read is green', async () => {
    const { io, out } = collectIo();
    const pages = [
      makePage({ contextsNodes: [pendingCheckRun('gate')] }),
      makePage({ contextsNodes: [greenCheckRun('gate')] }),
    ];
    let calls = 0;
    const forgeGhRunner = async () => {
      const page = pages[Math.min(calls, pages.length - 1)];
      calls += 1;
      return { exitCode: 0, stdout: page, stderr: '' };
    };
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });

    const code = await runCli(
      [
        'merge',
        'wait',
        '--repository',
        'example-owner/example-repo',
        '--pull-request',
        '202',
        '--max',
        '3s',
        '--interval',
        '10ms',
      ],
      io,
      runtime,
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ready', headOid: VALID_SHA });
  });

  it('exits 1 bounded by a tiny --max: the read is capped at the budget, never the 30 s timeout', async () => {
    const { io, out } = collectIo();
    const forgeGhRunner = async () => ({
      exitCode: 0,
      stdout: makePage({ contextsNodes: [pendingCheckRun('gate')] }),
      stderr: '',
    });
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });

    const code = await runCli(
      [
        'merge',
        'wait',
        '--repository',
        'example-owner/example-repo',
        '--pull-request',
        '202',
        '--max',
        '20ms',
        '--interval',
        '10ms',
      ],
      io,
      runtime,
    );

    expect(code).toBe(1);
    // A read deadline under the forge adapter's 2 s budget floor answers
    // budget-exhausted; a spent --max reports the typed wait-timeout with it.
    expect(JSON.parse(out.join(''))).toEqual({
      outcome: 'still-waiting',
      reason: 'wait-timeout',
      lastReason: 'budget-exhausted',
    });
  });

  describe('with an injected clock (CO25: --max bounds an in-flight read)', () => {
    /** A fake clock: `sleep` advances it, so no test waits on real time. */
    function makeClock(): { readonly clock: MergeWaitClock; readonly nowMs: () => number } {
      let nowMs = 0;
      return {
        clock: {
          now: () => nowMs,
          sleep: async (ms) => {
            nowMs += ms;
          },
        },
        nowMs: () => nowMs,
      };
    }

    function fakeRuntime(
      read: (request: { readonly deadlineIso: string }) => Promise<unknown>,
    ): FleetCliRuntime {
      return {
        execution: { inspectMergeReadiness: { inspectMergeReadiness: read } },
      } as unknown as FleetCliRuntime;
    }

    const payload = {
      repository: 'example-owner/example-repo',
      pullRequest: 202,
      max: '20ms',
      interval: '10ms',
    };

    it('ends still-waiting / wait-timeout within --max when one read outlasts the budget and never starts another read', async () => {
      const { clock, nowMs } = makeClock();
      const deadlines: string[] = [];
      const read = async (request: { readonly deadlineIso: string }) => {
        deadlines.push(request.deadlineIso);
        await clock.sleep(50); // one forge read slower than the whole --max budget
        return { outcome: 'still-waiting', reason: 'checks-pending' };
      };
      const runtime = fakeRuntime(read);

      const answer = await runMergeWait(payload, runtime, clock);

      expect(answer).toEqual({
        outcome: 'still-waiting',
        reason: 'wait-timeout',
        lastReason: 'checks-pending',
      });
      expect(deadlines).toEqual([new Date(20).toISOString()]); // first read capped at the budget end
      expect(deadlines).toHaveLength(1); // the spent budget never starts a second read
      expect(nowMs()).toBe(50); // the wait ended within about --max (one read past it, no extra polling)
    });

    it('caps every read deadline at the remaining budget across fast polls', async () => {
      const { clock } = makeClock();
      const deadlines: string[] = [];
      const read = async (request: { readonly deadlineIso: string }) => {
        deadlines.push(request.deadlineIso);
        return { outcome: 'still-waiting', reason: 'checks-pending' };
      };
      const runtime = fakeRuntime(read);

      const answer = await runMergeWait(payload, runtime, clock);

      expect(answer).toEqual({
        outcome: 'still-waiting',
        reason: 'wait-timeout',
        lastReason: 'checks-pending',
      });
      expect(deadlines).toEqual([
        new Date(20).toISOString(), // first read: min(30 s, 20 ms of budget)
        new Date(20).toISOString(), // the second read: never past the budget end
      ]);
    });
  });
});
