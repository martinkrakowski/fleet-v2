// Conductor runner-tunnel tests — KF-35 (folds in CL-2).
/**
 * The driver's one `ssh -N -L` forward over fakes only: the adapter tests
 * inject a fake spawner and a fake port probe, and the conductor run tests
 * inject a fake tunnel (or the real adapter over a fake spawner) through the
 * `tunnel` seam. No test spawns a real ssh, dials a real port or reaches the
 * network.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunConductorPassResult } from '@fleet/work-execution';
import { resolveConductorPolicy, type FleetInstallation } from '@fleet/installation';

import {
  createFleetCliRuntime,
  resolveRunnerTunnelTarget,
  resolveRunnerTunnelTargets,
  type FleetCliRuntime,
} from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import type { ConductorDriver } from '../conductor-wiring.js';
import {
  RunnerTunnelAdapter,
  RunnerTunnelSetAdapter,
  type RunnerTunnelPort,
  type RunnerTunnelStartOutcome,
  type TunnelChild,
} from '../runner-tunnel.js';

const NOW = '2026-10-27T10:00:00.000Z';

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-tunnel-test-'));
}

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

/** A scripted pass result. */
function completedPass(): RunConductorPassResult {
  return { outcome: 'completed', halted: false, progressed: false, runs: [], attention: [] };
}

/** A fake ConductorDriver with scripted passes and recorded release calls. */
function makeFakeDriver(
  passes: readonly RunConductorPassResult[],
  order?: string[],
): {
  readonly driver: ConductorDriver;
  readonly passCalls: number[];
  readonly releaseCalls: number[];
} {
  const passCalls: number[] = [];
  const releaseCalls: number[] = [];
  const driver: ConductorDriver = {
    pass: {
      runPass: async () => {
        order?.push('runPass');
        passCalls.push(passCalls.length + 1);
        const scripted = passes[passCalls.length - 1];
        if (scripted === undefined) {
          throw new Error('no scripted pass left');
        }
        return scripted;
      },
      releaseLeases: async () => {
        order?.push('releaseLeases');
        releaseCalls.push(1);
        return { released: 0 };
      },
    },
    start: null,
    policy: resolveConductorPolicy({ conductor: { enabled: true } }),
    runPolicyRevision: 'policy:conductor@0123456789ab',
  };
  return { driver, passCalls, releaseCalls };
}

/** A fake tunnel: records ensure/stop calls and their order against a shared log. */
function fakeTunnel(
  outcome: RunnerTunnelStartOutcome,
  order: string[],
): RunnerTunnelPort & {
  readonly ensureCalls: number[];
  readonly stopCalls: number[];
  readonly releaseCalls: number[];
} {
  const ensureCalls: number[] = [];
  const stopCalls: number[] = [];
  const releaseCalls: number[] = [];
  return {
    ensureCalls,
    stopCalls,
    releaseCalls,
    ensureTunnel: async (handlers) => {
      ensureCalls.push(1);
      order.push('ensure');
      void handlers;
      return outcome;
    },
    stop: async () => {
      stopCalls.push(1);
      order.push('stop');
    },
    release: async () => {
      releaseCalls.push(1);
      order.push('release');
    },
  };
}

async function runConductor(
  runtime: FleetCliRuntime,
  args: readonly string[],
  cliOptions: Omit<ConductorCliOptions, 'now'> = {},
): Promise<{ code: number; stdout: readonly string[]; stderr: readonly string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['conductor', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => NOW, ...cliOptions },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function runtimeOf(stateDir?: string): FleetCliRuntime {
  return createFleetCliRuntime({
    ...(stateDir !== undefined ? { stateDir } : {}),
    runSubprocess: () => {
      throw new Error('the conductor must never dispatch a subprocess');
    },
  });
}

// ---------------------------------------------------------------------------
// RunnerTunnelAdapter over fakes
// ---------------------------------------------------------------------------

interface FakeChild extends TunnelChild {
  readonly killCalls: number[];
  readonly releaseCalls: number[];
  /** Simulates the child dying on its own (no kill recorded). */
  crash(value: { code: number | null }): void;
}

function fakeChild(options: { readonly exitAt?: 'immediately' } = {}): FakeChild {
  const killCalls: number[] = [];
  let resolveExit: (value: { code: number | null }) => void = () => undefined;
  const exited = new Promise<{ code: number | null }>((resolve) => {
    resolveExit = resolve;
  });
  if (options.exitAt === 'immediately') {
    resolveExit({ code: 255 });
  }
  const releaseCalls: number[] = [];
  return {
    exited,
    stop: () => {
      killCalls.push(1);
      resolveExit({ code: null });
    },
    release: () => {
      releaseCalls.push(1);
    },
    killCalls,
    releaseCalls,
    crash: (value) => resolveExit(value),
  };
}

/** A probe answering from a scripted list, then repeating the last answer. */
function probeOf(answers: readonly boolean[]): (port: number) => Promise<boolean> {
  let calls = 0;
  return async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    return answer;
  };
}

function tunnelOf(options: {
  readonly sshHost?: string;
  readonly remotePort?: number;
  readonly probe: (port: number) => Promise<boolean>;
  readonly child: FakeChild;
  readonly waitMs?: number;
  readonly pollMs?: number;
}): RunnerTunnelAdapter {
  return new RunnerTunnelAdapter({
    sshHost: options.sshHost,
    remotePort: options.remotePort,
    isPortListening: options.probe,
    spawner: () => options.child,
    sleep: async () => undefined,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  });
}

describe('resolveRunnerTunnelTarget (KF-35, Fable pre-merge)', () => {
  it('a v2 ssh lane-runner host decides alone: its alias and port, never the settings', () => {
    expect(
      resolveRunnerTunnelTarget(
        { hostName: 'lane-host', transport: 'ssh', sshAlias: 'fleet-e2e', remotePort: 46000 },
        { runnerRemoteHost: 'other-host', runnerRemotePort: 47000 },
      ),
    ).toEqual({ sshHost: 'fleet-e2e', remotePort: 46000 });
  });

  it('a v2 local lane-runner host needs no tunnel', () => {
    expect(
      resolveRunnerTunnelTarget(
        { hostName: 'here', transport: 'local', remotePort: 46000 },
        { runnerRemoteHost: 'other-host', runnerRemotePort: 47000 },
      ),
    ).toEqual({});
  });

  it('without a v2 runner host the resolved settings decide', () => {
    expect(resolveRunnerTunnelTarget(undefined, { runnerRemoteHost: 'lane-host', runnerRemotePort: 46000 })).toEqual({
      sshHost: 'lane-host',
      remotePort: 46000,
    });
    expect(resolveRunnerTunnelTarget(undefined, {})).toEqual({});
  });

  it('a port outside 1..65534 opens no tunnel', () => {
    for (const port of [0, 65535, 70000, 1.5, Number.NaN]) {
      expect(resolveRunnerTunnelTarget(undefined, { runnerRemoteHost: 'lane-host', runnerRemotePort: port })).toEqual({
        sshHost: 'lane-host',
      });
    }
  });
});

describe('RunnerTunnelAdapter (KF-35)', () => {
  it('opens one ssh forward when the dial port is closed and stops it on stop', async () => {
    const child = fakeChild();
    const argvs: string[][] = [];
    const early: number[] = [];
    const tunnel = new RunnerTunnelAdapter({
      sshHost: 'lane-host',
      remotePort: 46000,
      isPortListening: probeOf([false, true]),
      spawner: (argv) => {
        argvs.push([...argv]);
        return child;
      },
      sleep: async () => undefined,
    });
    expect(await tunnel.ensureTunnel({ onEarlyExit: () => early.push(1) })).toBe('opened');
    expect(tunnel.owned).toBe(true);
    expect(argvs).toEqual([
      [
        'ssh',
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-L',
        '127.0.0.1:46001:127.0.0.1:46000',
        '--',
        'lane-host',
      ],
    ]);
    await tunnel.stop();
    expect(child.killCalls).toHaveLength(1);
    expect(tunnel.owned).toBe(false);
    expect(early).toHaveLength(0);
  });

  it('never spawns ssh and takes no ownership when the dial port already listens', async () => {
    const child = fakeChild();
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe: probeOf([true]), child });
    expect(await tunnel.ensureTunnel()).toBe('already-listening');
    expect(tunnel.owned).toBe(false);
    await tunnel.stop();
    expect(child.killCalls).toHaveLength(0);
  });

  it('is not applicable without OCM_HOST or without a usable OCM_REMOTE_PORT', async () => {
    const child = fakeChild();
    const noHost = tunnelOf({ remotePort: 46000, probe: probeOf([false]), child });
    expect(await noHost.ensureTunnel()).toBe('not-applicable');
    const noPort = tunnelOf({ sshHost: 'lane-host', probe: probeOf([false]), child });
    expect(await noPort.ensureTunnel()).toBe('not-applicable');
    const badPort = tunnelOf({ sshHost: 'lane-host', remotePort: 65535, probe: probeOf([false]), child });
    expect(await badPort.ensureTunnel()).toBe('not-applicable');
    expect(child.killCalls).toHaveLength(0);
  });

  it('reports a failure when the child exits before the port opens', async () => {
    const child = fakeChild({ exitAt: 'immediately' });
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe: probeOf([false, false]), child });
    const early: number[] = [];
    expect(await tunnel.ensureTunnel({ onEarlyExit: () => early.push(1) })).toBe('failed');
    expect(tunnel.owned).toBe(false);
    expect(early).toHaveLength(0);
    expect(child.killCalls).toHaveLength(0);
  });

  it('uses the forward unowned when the child exits while the successful probe runs (KF-35b)', async () => {
    const child = fakeChild();
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls += 1;
      if (calls === 1) {
        return false;
      }
      child.crash({ code: 255 });
      await Promise.resolve();
      return true;
    };
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe, child });
    const early: number[] = [];
    expect(await tunnel.ensureTunnel({ onEarlyExit: () => early.push(1) })).toBe('already-listening');
    expect(tunnel.owned).toBe(false);
    expect(early).toHaveLength(0);
  });

  it('a throwing probe before any spawn is a start failure and spawns nothing (Fable pre-merge)', async () => {
    const child = fakeChild();
    let spawned = 0;
    const tunnel = new RunnerTunnelAdapter({
      sshHost: 'lane-host',
      remotePort: 46000,
      isPortListening: async () => {
        throw new Error('probe failed');
      },
      spawner: () => {
        spawned += 1;
        return child;
      },
      sleep: async () => undefined,
    });
    expect(await tunnel.ensureTunnel()).toBe('failed');
    expect(spawned).toBe(0);
    expect(tunnel.owned).toBe(false);
  });

  it('release drops ownership without killing the forward; a later exit is not reported (e2e fix)', async () => {
    const child = fakeChild();
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe: probeOf([false, true]), child });
    const early: number[] = [];
    expect(await tunnel.ensureTunnel({ onEarlyExit: () => early.push(1) })).toBe('opened');
    await tunnel.release();
    expect(tunnel.owned).toBe(false);
    expect(child.killCalls).toHaveLength(0);
    expect(child.releaseCalls).toHaveLength(1);
    child.crash({ code: 0 });
    await child.exited;
    expect(early).toHaveLength(0);
    await tunnel.release();
    expect(child.releaseCalls).toHaveLength(1);
  });

  it('a child that loses the bind to a concurrent driver uses the other driver forward, unowned (KF-35b)', async () => {
    // Two drivers start at once: both see the port closed and spawn; the loser's
    // ssh exits (ExitOnForwardFailure) while the winner's forward now answers.
    const child = fakeChild({ exitAt: 'immediately' });
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe: probeOf([false, true]), child });
    const early: number[] = [];
    expect(await tunnel.ensureTunnel({ onEarlyExit: () => early.push(1) })).toBe('already-listening');
    expect(tunnel.owned).toBe(false);
    expect(early).toHaveLength(0);
    expect(child.killCalls).toHaveLength(0);
  });

  it('a child that dies while the successful probe ran fails when the port then stops answering (CodeRabbit)', async () => {
    const child = fakeChild();
    let calls = 0;
    const probe = async (): Promise<boolean> => {
      calls += 1;
      if (calls === 2) {
        child.crash({ code: 255 });
        await Promise.resolve();
        return true;
      }
      return false;
    };
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe, child });
    expect(await tunnel.ensureTunnel()).toBe('failed');
    expect(tunnel.owned).toBe(false);
  });

  it('reports a failure after the bounded wait and stops the child', async () => {
    const child = fakeChild();
    const sleeps: number[] = [];
    const tunnel = new RunnerTunnelAdapter({
      sshHost: 'lane-host',
      remotePort: 46000,
      isPortListening: probeOf([false]),
      spawner: () => child,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      waitMs: 10,
      pollMs: 5,
    });
    expect(await tunnel.ensureTunnel()).toBe('failed');
    expect(child.killCalls).toHaveLength(1);
    expect(tunnel.owned).toBe(false);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('the bounded wait awaits the stopped child exit before reporting the failure', async () => {
    let resolveExit: (value: { readonly code: number | null }) => void = () => undefined;
    const exited = new Promise<{ readonly code: number | null }>((resolve) => {
      resolveExit = resolve;
    });
    let exitResolved = false;
    void exited.then(() => {
      exitResolved = true;
    });
    const killCalls: number[] = [];
    const child: TunnelChild = {
      exited,
      stop: () => {
        killCalls.push(1);
        // The kill takes a tick to take effect, like a real child's exit.
        setTimeout(() => resolveExit({ code: null }), 0);
      },
      release: () => undefined,
    };
    const tunnel = new RunnerTunnelAdapter({
      sshHost: 'lane-host',
      remotePort: 46000,
      isPortListening: probeOf([false]),
      spawner: () => child,
      sleep: async () => undefined,
      waitMs: 5,
      pollMs: 1,
    });
    expect(await tunnel.ensureTunnel()).toBe('failed');
    expect(killCalls).toHaveLength(1);
    expect(exitResolved).toBe(true);
    expect(tunnel.owned).toBe(false);
  });

  it('a throwing port probe stops the child, awaits its exit and reports a failure', async () => {
    const child = fakeChild();
    let probeCalls = 0;
    const tunnel = new RunnerTunnelAdapter({
      sshHost: 'lane-host',
      remotePort: 46000,
      isPortListening: async () => {
        probeCalls += 1;
        if (probeCalls === 2) {
          throw new Error('probe blew up');
        }
        return false;
      },
      spawner: () => child,
      sleep: async () => undefined,
    });
    expect(await tunnel.ensureTunnel()).toBe('failed');
    expect(child.killCalls).toHaveLength(1);
    expect(tunnel.owned).toBe(false);
    await child.exited;
  });

  it.each<[string, string]>([
    ['an option-shaped host', '-oProxyCommand=x'],
    ['a host with whitespace', 'lane host'],
    ['a host with a control character', 'lane\u0000host'],
  ])('refuses %s and never reaches the spawner', async (_label, sshHost) => {
    const spawned: string[][] = [];
    const child = fakeChild();
    const tunnel = new RunnerTunnelAdapter({
      sshHost,
      remotePort: 46000,
      isPortListening: probeOf([false]),
      spawner: (argv) => {
        spawned.push([...argv]);
        return child;
      },
      sleep: async () => undefined,
    });
    expect(await tunnel.ensureTunnel()).toBe('failed');
    expect(spawned).toHaveLength(0);
    expect(tunnel.owned).toBe(false);
    expect(child.killCalls).toHaveLength(0);
  });

  it('reports an owned child that exits mid-run exactly once; stop afterwards is a no-op', async () => {
    const child = fakeChild();
    const tunnel = tunnelOf({ sshHost: 'lane-host', remotePort: 46000, probe: probeOf([false, true]), child });
    const early: number[] = [];
    expect(await tunnel.ensureTunnel({ onEarlyExit: () => early.push(1) })).toBe('opened');
    child.crash({ code: 255 });
    await child.exited;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(early).toEqual([1]);
    expect(tunnel.owned).toBe(false);
    await tunnel.stop();
    expect(child.killCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// conductor run --live holds the tunnel for its lifetime
// ---------------------------------------------------------------------------

describe('conductor run --live holds one runner tunnel (KF-35)', () => {
  it('starts the tunnel once before pass 1 and releases it (never kills it) after releaseLeases, also with --once', async () => {
    const dir = tempStateDir();
    const order: string[] = [];
    const fake = makeFakeDriver([completedPass()], order);
    const tunnel = fakeTunnel('opened', order);
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      tunnel,
    });
    expect(result.code).toBe(0);
    expect(tunnel.ensureCalls).toHaveLength(1);
    expect(fake.passCalls).toHaveLength(1);
    expect(fake.releaseCalls).toHaveLength(1);
    expect(tunnel.releaseCalls).toHaveLength(1);
    expect(tunnel.stopCalls).toHaveLength(0);
    expect(order).toEqual(['ensure', 'runPass', 'releaseLeases', 'release']);
  });

  it('still releases the tunnel when releasing the leases throws (Fable pre-merge)', async () => {
    const dir = tempStateDir();
    const order: string[] = [];
    const fake = makeFakeDriver([completedPass()], order);
    const throwing: ConductorDriver = {
      ...fake.driver,
      pass: {
        ...fake.driver.pass,
        releaseLeases: async () => {
          order.push('releaseLeases');
          throw new Error('state directory unwritable');
        },
      },
    };
    const tunnel = fakeTunnel('opened', order);
    await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => throwing,
      tunnel,
    }).catch(() => undefined);
    expect(order).toEqual(['ensure', 'runPass', 'releaseLeases', 'release']);
    expect(tunnel.releaseCalls).toHaveLength(1);
    expect(tunnel.stopCalls).toHaveLength(0);
  });

  it('releases the tunnel once in finally after a multi-pass loop ends on the stop signal', async () => {
    const dir = tempStateDir();
    const order: string[] = [];
    const fake = makeFakeDriver([completedPass(), completedPass(), completedPass()]);
    const tunnel = fakeTunnel('opened', order);
    const controller = new AbortController();
    let sleeps = 0;
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      tunnel,
      stopSignal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 3) {
          controller.abort();
        }
      },
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(3);
    expect(tunnel.ensureCalls).toHaveLength(1);
    expect(tunnel.releaseCalls).toHaveLength(1);
    expect(tunnel.stopCalls).toHaveLength(0);
  });

  it('never starts a tunnel with --dry-run', async () => {
    const dir = tempStateDir();
    const order: string[] = [];
    const tunnel = fakeTunnel('opened', order);
    const result = await runConductor(runtimeOf(dir), ['run', '--dry-run', '--once'], {
      stateDir: dir,
      tunnel,
    });
    expect(result.code).toBe(0);
    expect(tunnel.ensureCalls).toHaveLength(0);
    expect(tunnel.stopCalls).toHaveLength(0);
    expect(order).toEqual([]);
  });

  it('an already-listening dial port still runs the passes; the release call is a harmless no-op', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver([completedPass()]);
    const tunnel = fakeTunnel('already-listening', []);
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      tunnel,
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(1);
    expect(tunnel.ensureCalls).toHaveLength(1);
    expect(tunnel.releaseCalls).toHaveLength(1);
    expect(tunnel.stopCalls).toHaveLength(0);
  });

  it('a tunnel start failure exits 1 with the fixed message and drives no pass', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver([completedPass()]);
    const tunnel = fakeTunnel('failed', []);
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      tunnel,
    });
    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('the runner tunnel could not be opened');
    expect(result.stderr.join('\n')).toContain('no pass was driven');
    expect(fake.passCalls).toHaveLength(0);
    expect(fake.releaseCalls).toHaveLength(0);
    expect(tunnel.stopCalls).toHaveLength(0);
  });

  it('an owned tunnel child that exits mid-run is logged once through io and the loop continues', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver([completedPass(), completedPass()]);
    const child = fakeChild();
    const tunnel = new RunnerTunnelAdapter({
      sshHost: 'lane-host',
      remotePort: 46000,
      isPortListening: probeOf([false, true, true]),
      spawner: () => child,
      sleep: async () => undefined,
    });
    const controller = new AbortController();
    let sleeps = 0;
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      tunnel,
      stopSignal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          // The owned child dies between pass 1 and pass 2.
          child.crash({ code: 255 });
          await child.exited;
        }
        if (sleeps >= 2) {
          controller.abort();
        }
      },
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(2);
    expect(result.stderr.filter((line) => line.includes('the runner tunnel child exited'))).toHaveLength(1);
    await tunnel.stop();
    expect(child.killCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G2: one tunnel per ssh lane-runner host (RunnerTunnelSetAdapter)
// ---------------------------------------------------------------------------

const RUNNER_CAPABILITIES = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: 'scoped-worktree',
} as const;

/** A sunrise-shaped ssh opencode lane-runner host on its own port. */
function sshHostFixture(alias: string, port: number): Record<string, unknown> {
  return {
    transport: 'ssh',
    sshAlias: alias,
    worktreeRoot: `/tmp/fleet-g2-${alias}-worktrees`,
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port, capabilities: RUNNER_CAPABILITIES, maxLanes: 2 },
  };
}

/** A local host that also runs lanes (opencode runner, as the real files carry). */
function localLaneRunnerFixture(): Record<string, unknown> {
  return {
    transport: 'local',
    worktreeRoot: '/tmp/fleet-g2-local-worktrees',
    roles: ['orchestrator', 'lane-runner'],
    runner: { kind: 'opencode', port: 4166, capabilities: RUNNER_CAPABILITIES, maxLanes: 2 },
  };
}

function installationWithHosts(hosts: Record<string, unknown>): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts,
    forge: { mode: 'none' },
  } as FleetInstallation;
}

/** A member adapter that opens its forward: probe answers closed once, then open. */
function openingMember(
  sshHost: string,
  remotePort: number,
  argvs: string[][],
  probed: number[],
): { readonly adapter: RunnerTunnelAdapter; readonly child: FakeChild } {
  const child = fakeChild();
  let probes = 0;
  const adapter = new RunnerTunnelAdapter({
    sshHost,
    remotePort,
    isPortListening: async (port) => {
      probed.push(port);
      probes += 1;
      return probes > 1;
    },
    spawner: (argv) => {
      argvs.push([...argv]);
      return child;
    },
    sleep: async () => undefined,
  });
  return { adapter, child };
}

describe('RunnerTunnelSetAdapter (G2)', () => {
  it('two ssh opencode lane-runner hosts on ports 4166 and 4266 yield two targets and each forward dials its own alias and port pair', async () => {
    const installation = installationWithHosts({
      'runner-a': sshHostFixture('alias-a', 4166),
      'runner-b': sshHostFixture('alias-b', 4266),
    });
    expect(resolveRunnerTunnelTargets(installation)).toEqual([
      { hostName: 'runner-a', sshHost: 'alias-a', remotePort: 4166 },
      { hostName: 'runner-b', sshHost: 'alias-b', remotePort: 4266 },
    ]);
    const argvs: string[][] = [];
    const probed: number[] = [];
    const set = new RunnerTunnelSetAdapter([
      openingMember('alias-a', 4166, argvs, probed).adapter,
      openingMember('alias-b', 4266, argvs, probed).adapter,
    ]);
    expect(await set.ensureTunnel()).toBe('opened');
    expect(set.owned).toBe(true);
    // The set probed (and opened) exactly the two dial ports 4167 and 4267.
    expect([...new Set(probed)].sort((a, b) => a - b)).toEqual([4167, 4267]);
    expect(argvs).toEqual([
      [
        'ssh',
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-L',
        '127.0.0.1:4167:127.0.0.1:4166',
        '--',
        'alias-a',
      ],
      [
        'ssh',
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-L',
        '127.0.0.1:4267:127.0.0.1:4266',
        '--',
        'alias-b',
      ],
    ]);
    await set.stop();
    expect(set.owned).toBe(false);
  });

  it('failure of the second member makes ensureTunnel answer failed, stops the first, and never spawns a third', async () => {
    const argvs: string[][] = [];
    const probed: number[] = [];
    const first = openingMember('alias-a', 4166, argvs, probed);
    // The second member refuses before spawning (an option-shaped alias), so a
    // spawn on it would itself be a bug; the third must never even be asked.
    const second = new RunnerTunnelAdapter({
      sshHost: '-oProxyCommand=x',
      remotePort: 4266,
      isPortListening: async () => {
        probed.push(4267);
        return false;
      },
      spawner: () => {
        throw new Error('the failing member must never spawn');
      },
      sleep: async () => undefined,
    });
    const third = openingMember('alias-c', 4366, argvs, probed);
    const set = new RunnerTunnelSetAdapter([first.adapter, second, third.adapter]);
    expect(await set.ensureTunnel()).toBe('failed');
    // The first member's owned child was stopped (not orphaned) ...
    expect(first.child.killCalls).toHaveLength(1);
    expect(set.owned).toBe(false);
    // ... and the third member was never asked to spawn anything.
    expect(argvs).toHaveLength(1);
    expect(probed.filter((port) => port === 4367)).toHaveLength(0);
  });

  it('an empty RunnerTunnelSetAdapter answers not-applicable', async () => {
    const set = new RunnerTunnelSetAdapter([]);
    expect(await set.ensureTunnel()).toBe('not-applicable');
    expect(set.owned).toBe(false);
    await expect(set.stop()).resolves.toBeUndefined();
    await expect(set.release()).resolves.toBeUndefined();
  });

  it('refuses two members with the same dial port without spawning', async () => {
    let spawns = 0;
    const memberOf = (): RunnerTunnelAdapter =>
      new RunnerTunnelAdapter({
        sshHost: 'alias-a',
        remotePort: 4166,
        isPortListening: async () => false,
        spawner: () => {
          spawns += 1;
          return fakeChild();
        },
        sleep: async () => undefined,
      });
    const set = new RunnerTunnelSetAdapter([memberOf(), memberOf()]);
    expect(await set.ensureTunnel()).toBe('failed');
    expect(spawns).toBe(0);
    expect(set.owned).toBe(false);
  });

  it('stop and release reach every member even when the first throws', async () => {
    const first = new RunnerTunnelAdapter({});
    const second = new RunnerTunnelAdapter({});
    const calls: string[] = [];
    Object.defineProperty(first, 'stop', {
      value: async () => {
        calls.push('first-stop');
        throw new Error('stop blew up');
      },
    });
    Object.defineProperty(second, 'stop', {
      value: async () => {
        calls.push('second-stop');
      },
    });
    Object.defineProperty(first, 'release', {
      value: async () => {
        calls.push('first-release');
        throw new Error('release blew up');
      },
    });
    Object.defineProperty(second, 'release', {
      value: async () => {
        calls.push('second-release');
      },
    });
    const set = new RunnerTunnelSetAdapter([first, second]);
    await expect(set.stop()).resolves.toBeUndefined();
    await expect(set.release()).resolves.toBeUndefined();
    expect(calls).toEqual(['first-stop', 'second-stop', 'first-release', 'second-release']);
  });

  it('RunnerTunnelSetAdapter refuses non-arrays, array holes, getters, non-adapters, and oversized inputs', () => {
    const adapter = new RunnerTunnelAdapter({});
    const asMembers = (value: unknown): readonly RunnerTunnelAdapter[] => value as readonly RunnerTunnelAdapter[];
    expect(() => new RunnerTunnelSetAdapter(asMembers(null))).toThrow(TypeError);
    expect(() => new RunnerTunnelSetAdapter(asMembers(undefined))).toThrow(TypeError);
    expect(() => new RunnerTunnelSetAdapter(asMembers('ab'))).toThrow(TypeError);
    expect(() => new RunnerTunnelSetAdapter(asMembers({ length: 2 }))).toThrow(TypeError);
    const sparse: RunnerTunnelAdapter[] = new Array(3);
    sparse[0] = adapter;
    sparse[2] = adapter;
    expect(() => new RunnerTunnelSetAdapter(sparse)).toThrow(TypeError);
    const withGetter: RunnerTunnelAdapter[] = [adapter];
    Object.defineProperty(withGetter, 0, {
      enumerable: true,
      get: () => adapter,
    });
    expect(() => new RunnerTunnelSetAdapter(withGetter)).toThrow(TypeError);
    expect(() => new RunnerTunnelSetAdapter(asMembers(['not-an-adapter']))).toThrow(TypeError);
    expect(() => new RunnerTunnelSetAdapter(new Array(1025).fill(adapter))).toThrow(TypeError);
  });
});

describe('resolveRunnerTunnelTargets (G2)', () => {
  it('one ssh host plus one local host yields one target; agy and unusable alias or port yield none', () => {
    const installation = installationWithHosts({
      'runner-a': sshHostFixture('alias-a', 4166),
      here: localLaneRunnerFixture(),
      agyHost: {
        transport: 'ssh',
        sshAlias: 'alias-c',
        worktreeRoot: '/tmp/fleet-g2-agy-worktrees',
        roles: ['lane-runner'],
        runner: { kind: 'agy', port: 4366, agyMode: 'edit-only' },
      },
      badAlias: sshHostFixture('-bad alias', 4466),
      notRunner: {
        transport: 'ssh',
        sshAlias: 'alias-e',
        worktreeRoot: '/tmp/fleet-g2-not-runner-worktrees',
        roles: ['orchestrator', 'verifier'],
        runner: { kind: 'opencode', port: 4566, capabilities: RUNNER_CAPABILITIES, maxLanes: 2 },
      },
    });
    expect(resolveRunnerTunnelTargets(installation)).toEqual([
      { hostName: 'runner-a', sshHost: 'alias-a', remotePort: 4166 },
    ]);
    for (const port of [0, 65535, 1.5, Number.NaN]) {
      expect(resolveRunnerTunnelTargets(installationWithHosts({ badPort: sshHostFixture('alias-d', port) }))).toEqual([]);
    }
  });

  it('one opencode ssh lane-runner host plus one agy ssh lane-runner host yields one target, and the runtime keeps a single adapter', () => {
    const installation = installationWithHosts({
      'runner-a': sshHostFixture('alias-a', 4166),
      agyHost: {
        transport: 'ssh',
        sshAlias: 'alias-b',
        worktreeRoot: '/tmp/fleet-g2-agy-worktrees',
        roles: ['lane-runner'],
        runner: { kind: 'agy', port: 4266, agyMode: 'edit-only' },
      },
    });
    expect(resolveRunnerTunnelTargets(installation)).toEqual([
      { hostName: 'runner-a', sshHost: 'alias-a', remotePort: 4166 },
    ]);
    const runtime = createFleetCliRuntime({
      stateDir: tempStateDir(),
      installation,
      runSubprocess: () => {
        throw new Error('the conductor must never dispatch a subprocess');
      },
    });
    expect(runtime.runnerTunnel).toBeInstanceOf(RunnerTunnelAdapter);
    expect(runtime.runnerTunnel).not.toBeInstanceOf(RunnerTunnelSetAdapter);
  });

  it('v1 and absent installations yield no tunnel targets', () => {
    expect(resolveRunnerTunnelTargets({ schemaVersion: 1 } as FleetInstallation)).toEqual([]);
    expect(resolveRunnerTunnelTargets()).toEqual([]);
  });

  it('resolveRunnerTunnelTargets refuses null, non-objects, prototype-polluting keys, and getters without invoking them', () => {
    const asInstallation = (value: unknown): FleetInstallation | undefined =>
      value as FleetInstallation | undefined;
    expect(resolveRunnerTunnelTargets(asInstallation(null))).toEqual([]);
    expect(resolveRunnerTunnelTargets(asInstallation(42))).toEqual([]);
    expect(resolveRunnerTunnelTargets(asInstallation('nope'))).toEqual([]);
    expect(resolveRunnerTunnelTargets(asInstallation([]))).toEqual([]);
    // A hosts section that is not a plain object (string or array) yields none.
    expect(resolveRunnerTunnelTargets(asInstallation({ schemaVersion: 2, hosts: 'no' }))).toEqual([]);
    expect(resolveRunnerTunnelTargets(asInstallation({ schemaVersion: 2, hosts: [] }))).toEqual([]);
    // Prototype-polluting keys are skipped, never read.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const hosts: Record<string, unknown> = {};
      Object.defineProperty(hosts, key, {
        enumerable: true,
        writable: true,
        configurable: true,
        value: sshHostFixture('alias-a', 4166),
      });
      expect(resolveRunnerTunnelTargets(asInstallation({ schemaVersion: 2, hosts }))).toEqual([]);
    }
    // A getter on a hosts key (and on `hosts` itself) is never invoked.
    const getterHosts: Record<string, unknown> = {};
    Object.defineProperty(getterHosts, 'runner-a', {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error('the hosts getter must never run');
      },
    });
    expect(resolveRunnerTunnelTargets(asInstallation({ schemaVersion: 2, hosts: getterHosts }))).toEqual([]);
    const getterInstallation: Record<string, unknown> = { schemaVersion: 2 };
    Object.defineProperty(getterInstallation, 'hosts', {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error('the installation hosts getter must never run');
      },
    });
    expect(resolveRunnerTunnelTargets(asInstallation(getterInstallation))).toEqual([]);
    // A getter on a host entry's own field skips that entry.
    const hostileHost: Record<string, unknown> = { ...sshHostFixture('alias-a', 4166) };
    Object.defineProperty(hostileHost, 'transport', {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error('the host transport getter must never run');
      },
    });
    expect(resolveRunnerTunnelTargets(asInstallation({ schemaVersion: 2, hosts: { 'runner-a': hostileHost } }))).toEqual(
      [],
    );
  });
});

describe('conductor run tunnel wiring (G2)', () => {
  function runtimeOfInstallation(installation: FleetInstallation): FleetCliRuntime {
    return createFleetCliRuntime({
      stateDir: tempStateDir(),
      installation,
      runSubprocess: () => {
        throw new Error('the conductor must never dispatch a subprocess');
      },
    });
  }

  it('two-host ssh opencode v2 installation gives the set adapter', () => {
    const runtime = runtimeOfInstallation(
      installationWithHosts({
        'runner-a': sshHostFixture('alias-a', 4166),
        'runner-b': sshHostFixture('alias-b', 4266),
      }),
    );
    expect(runtime.runnerTunnel).toBeInstanceOf(RunnerTunnelSetAdapter);
  });

  it('single-host ssh opencode v2 installation gives the single adapter', () => {
    const runtime = runtimeOfInstallation(installationWithHosts({ 'runner-a': sshHostFixture('alias-a', 4166) }));
    expect(runtime.runnerTunnel).toBeInstanceOf(RunnerTunnelAdapter);
    expect(runtime.runnerTunnel).not.toBeInstanceOf(RunnerTunnelSetAdapter);
  });

  it('local-first plus ssh-second opencode v2 installation gives the set adapter', () => {
    const runtime = runtimeOfInstallation(
      installationWithHosts({
        here: localLaneRunnerFixture(),
        'runner-b': sshHostFixture('alias-b', 4266),
      }),
    );
    expect(runtime.runnerTunnel).toBeInstanceOf(RunnerTunnelSetAdapter);
  });
});
