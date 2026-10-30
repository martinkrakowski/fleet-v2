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
import { resolveConductorPolicy } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import type { ConductorDriver } from '../conductor-wiring.js';
import {
  RunnerTunnelAdapter,
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
function makeFakeDriver(passes: readonly RunConductorPassResult[]): {
  readonly driver: ConductorDriver;
  readonly passCalls: number[];
  readonly releaseCalls: number[];
} {
  const passCalls: number[] = [];
  const releaseCalls: number[] = [];
  const driver: ConductorDriver = {
    pass: {
      runPass: async () => {
        passCalls.push(passCalls.length + 1);
        const scripted = passes[passCalls.length - 1];
        if (scripted === undefined) {
          throw new Error('no scripted pass left');
        }
        return scripted;
      },
      releaseLeases: async () => {
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
): RunnerTunnelPort & { readonly ensureCalls: number[]; readonly stopCalls: number[] } {
  const ensureCalls: number[] = [];
  const stopCalls: number[] = [];
  return {
    ensureCalls,
    stopCalls,
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
  return {
    exited,
    stop: () => {
      killCalls.push(1);
      resolveExit({ code: null });
    },
    killCalls,
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
        '-L',
        '127.0.0.1:46001:127.0.0.1:46000',
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
  it('starts the tunnel once before pass 1 and stops it after releaseLeases, also with --once', async () => {
    const dir = tempStateDir();
    const order: string[] = [];
    const fake = makeFakeDriver([completedPass()]);
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
    expect(tunnel.stopCalls).toHaveLength(1);
    expect(order).toEqual(['ensure', 'stop']);
  });

  it('stops the tunnel once in finally after a multi-pass loop ends on the stop signal', async () => {
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
    expect(tunnel.stopCalls).toHaveLength(1);
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

  it('an already-listening dial port still runs the passes; the stop call is a harmless no-op', async () => {
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
    expect(tunnel.stopCalls).toHaveLength(1);
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
