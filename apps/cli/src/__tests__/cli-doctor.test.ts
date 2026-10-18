/**
 * `fleet-v2 doctor` against a fake installation and fake probes: output
 * shape (one line per doctor check, JSON documents with --json) and the
 * doctor exit-code contract (0 all PASS, 1 any FAIL/UNKNOWN and also a
 * missing or invalid installation, 2 usage).
 */

import { describe, expect, it } from 'vitest';

import type { FleetInstallationModel } from '@fleet/installation';
import type { DoctorLine, DoctorProbes, HostProbeExecutor } from '@fleet/onboarding';

import { runCli, type CliIo, type DoctorCliOptions } from '../index.js';

const MODEL = {
  schemaVersion: 2,
  hosts: {
    local: {
      transport: 'local',
      worktreeRoot: '/worktrees',
      roles: ['orchestrator', 'lane-runner'],
    },
  },
  tools: ['claude-code'],
  seats: [
    {
      id: 'seat-1',
      tool: 'claude-code',
      model: 'glm-5.3',
      roles: ['implementer'],
    },
  ],
} as FleetInstallationModel;

const LOAD_RESULT = {
  status: 'loaded',
  file: '/installation/fleet.json',
  installation: { schemaVersion: 2 },
  model: MODEL,
  warnings: [],
} as NonNullable<DoctorCliOptions['loadResult']>;

/** Full-accepting probes: every check passes. */
function passingProbes(calls?: string[]): DoctorProbes {
  return {
    hostReachable: async () => {
      calls?.push('hostReachable');
      return true;
    },
    commandAvailable: async () => true,
    toolVersion: async () => '1.0.0',
    fileMode: async () => 0o600,
    worktreeRootWritable: async () => true,
    ocmRunBinary: async () => ({ path: '/repo/bin/ocm-run', sha256: 'c'.repeat(64) }),
    expectedOcmRunHash: async () => 'c'.repeat(64),
    seatProbe: async () => {
      calls?.push('seatProbe');
      return { outcome: 'pass', reason: 'answered' };
    },
  };
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

const doctorOptions = (probes: DoctorProbes) => ({ loadResult: LOAD_RESULT, probes });

/** A missing installation: the loader's `absent` status with its minimal model. */
const ABSENT_LOAD_RESULT = {
  status: 'absent',
  installation: { schemaVersion: 1 },
  model: MODEL,
  warnings: [],
} as NonNullable<DoctorCliOptions['loadResult']>;

describe('fleet-v2 doctor', () => {
  it('exits 0 and prints one line per check when everything passes', async () => {
    const calls: string[] = [];
    const { io, stdout } = captureIo();
    const code = await runCli(
      ['doctor', '--probe-seats'],
      io,
      undefined,
      doctorOptions(passingProbes(calls)),
    );
    expect(code).toBe(0);
    expect(calls).toContain('seatProbe');
    expect(stdout.length).toBeGreaterThan(0);
    for (const text of stdout) {
      expect(text).toMatch(/^(PASS|FAIL|UNKNOWN) (installation|host|tool|seat|credential|runner-binary) \S+ \S+ — /);
    }
    expect(stdout.some((text) => text.startsWith('PASS seat seat-1 probe — '))).toBe(true);
  });

  it('never probes seats without --probe-seats and exits 1', async () => {
    const calls: string[] = [];
    const { io, stdout } = captureIo();
    const code = await runCli(
      ['doctor'],
      io,
      undefined,
      doctorOptions(passingProbes(calls)),
    );
    expect(code).toBe(1);
    expect(calls).not.toContain('seatProbe');
    expect(
      stdout.some((text) => text.startsWith('UNKNOWN seat seat-1 probe — not probed')),
    ).toBe(true);
  });

  it('exits 1 when any check fails', async () => {
    const probes = passingProbes();
    probes.commandAvailable = async () => false;
    const { io } = captureIo();
    const code = await runCli(
      ['doctor', '--probe-seats'],
      io,
      undefined,
      doctorOptions(probes),
    );
    expect(code).toBe(1);
  });

  it('prints one JSON document per line with --json', async () => {
    const { io, stdout } = captureIo();
    const code = await runCli(
      ['doctor', '--probe-seats', '--json'],
      io,
      undefined,
      doctorOptions(passingProbes()),
    );
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    for (const text of stdout) {
      const parsed = JSON.parse(text) as DoctorLine;
      expect(parsed.scope).toBeDefined();
      expect(parsed.status).toBeDefined();
    }
  });

  it('prints help and exits 0 on --help', async () => {
    const { io, stdout } = captureIo();
    const code = await runCli(['doctor', '--help'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('--probe-seats');
  });

  it('rejects unknown options as a usage error (2)', async () => {
    const { io, stderr } = captureIo();
    const code = await runCli(
      ['doctor', '--wat'],
      io,
      undefined,
      doctorOptions(passingProbes()),
    );
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--wat');
  });

  it('refuses a missing installation with exit 1, not 2', async () => {
    const { io, stderr } = captureIo();
    const code = await runCli(['doctor'], io, undefined, {
      loadResult: ABSENT_LOAD_RESULT,
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('missing');
  });

  it('refuses an invalid installation with exit 1, not 2', async () => {
    const { io, stderr } = captureIo();
    const code = await runCli(['doctor'], io, undefined, {
      loadResult: {
        status: 'invalid',
        file: '/installation/fleet.json',
        errors: ['/installation/fleet.json: invalid JSON'],
      },
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('invalid');
  });

  it('documents that seat probes run from the operator machine', async () => {
    const { io, stdout } = captureIo();
    const code = await runCli(['doctor', '--help'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain("operator's machine");
  });
});

// ---------------------------------------------------------------------------
// doctor --host (lane H4): one host's probe subset through the engine's plan,
// plus the leftover-forward check, with the argv executor faked.
// ---------------------------------------------------------------------------

/** A two-host v2 installation load result for the host subset. */
const HOST_LOAD_RESULT = {
  status: 'loaded',
  file: '/installation/fleet.json',
  installation: {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      mac: {
        transport: 'local',
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['orchestrator', 'verifier'],
      },
      lanehost: {
        transport: 'ssh',
        sshAlias: 'm',
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['lane-runner'],
        runner: {
          kind: 'opencode',
          port: 4166,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
        },
      },
    },
  },
  model: MODEL,
  warnings: [],
} as unknown as NonNullable<DoctorCliOptions['loadResult']>;

/**
 * The faked host-probe argv executor: `mktemp` answers with a path inside
 * the root it was given; `nc -z` answers `listening` when asked to.
 */
function hostProbeExecutor(listening: (port: number) => boolean): {
  executor: HostProbeExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    executor: {
      async run(argv) {
        calls.push([...argv]);
        const template = argv.find((token) => token.includes('.fleet-probe.XXXXXX'));
        if (template !== undefined) {
          return { exitCode: 0, signal: null, stdout: template.replace('XXXXXX', 'probe1'), stderr: '' };
        }
        const ncIndex = argv.indexOf('nc');
        if (ncIndex !== -1) {
          const port = Number(argv[ncIndex + 3]);
          return {
            exitCode: listening(port) ? 0 : 1,
            signal: null,
            stdout: '',
            stderr: '',
          };
        }
        return { exitCode: 0, signal: null, stdout: 'tool 1.0.0', stderr: '' };
      },
    },
  };
}

describe('fleet-v2 doctor --host', () => {
  it("runs the host's probe subset and the leftover-forward check, exiting 0 when all pass", async () => {
    const { io, stdout } = captureIo();
    const { executor, calls } = hostProbeExecutor(() => false);
    const code = await runCli(['doctor', '--host', 'lanehost'], io, undefined, {
      loadResult: HOST_LOAD_RESULT,
      hostProbeExecutor: executor,
    });
    expect(code).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('PASS host lanehost reachable — reachable via m');
    expect(text).toContain('version-sh');
    expect(text).toContain('tool lanehost/opencode version-opencode');
    expect(text).toContain('worktree-root-writable');
    expect(text).toContain('server-loopback');
    // The forward port of an ssh host is owned by it; the adjacent port is
    // checked and reported when nothing else listens there.
    expect(text).toContain('PASS host lanehost unowned-forward — nothing is listening on 127.0.0.1:4166');
    expect(calls.some((argv) => argv.includes('nc') && argv.includes('4166'))).toBe(true);
    // The seat probes never run for a single host's subset.
    expect(text).not.toContain('seat');
  });

  it('reports a listening forward on a port no configured host owns as FAIL', async () => {
    const { io, stdout } = captureIo();
    const { executor } = hostProbeExecutor(() => true);
    const code = await runCli(['doctor', '--host', 'lanehost'], io, undefined, {
      loadResult: HOST_LOAD_RESULT,
      hostProbeExecutor: executor,
    });
    expect(code).toBe(1);
    const text = stdout.join('');
    expect(text).toContain(
      'FAIL host lanehost unowned-forward — 127.0.0.1:4166 is listening but no configured host owns it',
    );
    expect(text).toContain("pgrep -f 'ssh .*-L 127.0.0.1:4166'");
  });

  it('checks a verifier host can see the lane-runner worktree root, and no runner port means no forward line', async () => {
    const { io, stdout } = captureIo();
    const { executor } = hostProbeExecutor(() => false);
    const code = await runCli(['doctor', '--host', 'mac'], io, undefined, {
      loadResult: HOST_LOAD_RESULT,
      hostProbeExecutor: executor,
    });
    expect(code).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('PASS host mac lane-runner-worktree-visible — lane-runner worktree root /srv/fleet/worktrees on lanehost is visible');
    expect(text).not.toContain('unowned-forward');
  });

  it('refuses an unknown host name with exit 1', async () => {
    const { io, stderr } = captureIo();
    const { executor } = hostProbeExecutor(() => false);
    const code = await runCli(['doctor', '--host', 'nosuch'], io, undefined, {
      loadResult: HOST_LOAD_RESULT,
      hostProbeExecutor: executor,
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain("no host named 'nosuch' is configured in the installation");
  });

  it('refuses --host together with --probe-seats as a usage error', async () => {
    const { io, stderr } = captureIo();
    const code = await runCli(['doctor', '--host', 'lanehost', '--probe-seats'], io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--probe-seats belongs to the full doctor run');
  });

  it('refuses --host on an installation with no named hosts', async () => {
    const { io, stderr } = captureIo();
    const code = await runCli(['doctor', '--host', 'lanehost'], io, undefined, {
      loadResult: {
        status: 'loaded',
        file: '/installation/fleet.json',
        installation: { schemaVersion: 1 },
        model: MODEL,
        warnings: [],
      } as NonNullable<DoctorCliOptions['loadResult']>,
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('needs a schema version 2 installation with named hosts');
  });
});
