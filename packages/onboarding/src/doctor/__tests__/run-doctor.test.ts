import { describe, expect, it } from 'vitest';

import type {
  FleetInstallationModel,
  HostModel,
  SeatModel,
} from '@fleet/installation';

import type { DoctorProbes, PinnedBuildProbeResult, SeatProbeResult } from '../probes.js';
import type { DoctorLine } from '../types.js';
import { doctorExitCode, pinnedBuildLines, runDoctor } from '../run-doctor.js';
import type {
  DoctorableInstallation,
  RunDoctorOptions,
} from '../run-doctor.js';
import { createNodeDoctorProbes, LOGIN_SHELL_CANARY } from '../probes-node.js';

/** A v2 model: one local runner host, one ssh verifier, two tools, two seats. */
function sampleModel(overrides?: {
  host?: Partial<HostModel>;
  runnerAuthFile?: string;
  seats?: SeatModel[];
  tools?: string[];
}): FleetInstallationModel {
  const base: HostModel = {
    transport: 'local',
    worktreeRoot: '/work',
    roles: ['orchestrator', 'lane-runner'],
    runner: {
      kind: 'opencode',
      port: 4096,
      ...(overrides?.runnerAuthFile !== undefined
        ? { authFile: overrides.runnerAuthFile }
        : {}),
      capabilities: {
        source: 'declared',
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
      },
    },
  };
  const verifier: HostModel = {
    transport: 'ssh',
    sshAlias: 'verifier-host',
    worktreeRoot: '/verify',
    roles: ['verifier'],
  };
  return {
    schemaVersion: 2,
    hosts: { main: { ...base, ...overrides?.host }, 'verifier-host': verifier },
    ...(overrides?.tools !== undefined ? { tools: overrides.tools } : {}),
    ...(overrides?.seats !== undefined ? { seats: overrides.seats } : {}),
    forge: { mode: 'none' },
  };
}

function loadedResult(
  model: FleetInstallationModel,
  warnings: string[] = [],
): DoctorableInstallation {
  return {
    status: 'loaded',
    file: '/installation/fleet.json',
    installation: { schemaVersion: 2 },
    model,
    warnings,
  };
}

const ALL_SEATS_PASS: SeatProbeResult = {
  outcome: 'pass',
  reason: 'model answered, variant accepted',
};

/**
 * Fake probes: every default passes; individual probes are overridden per
 * test. Every call to every probe is recorded for assertions.
 */
function fakeProbes(
  overrides: Partial<DoctorProbes> = {},
): { probes: DoctorProbes; calls: string[] } {
  const calls: string[] = [];
  const probes: DoctorProbes = {
    hostReachable: async (host) => {
      calls.push(`hostReachable:${host}`);
      return true;
    },
    commandAvailable: async (host, name) => {
      calls.push(`commandAvailable:${host}:${name}`);
      return true;
    },
    toolVersion: async (host, toolId) => {
      calls.push(`toolVersion:${host}:${toolId}`);
      return '1.2.3';
    },
    fileMode: async (host, path) => {
      calls.push(`fileMode:${host}:${path}`);
      return 0o600;
    },
    worktreeRootWritable: async (host) => {
      calls.push(`worktreeRootWritable:${host}`);
      return true;
    },
    ocmRunBinary: async () => {
      calls.push('ocmRunBinary');
      return { path: '/bin/ocm-run', sha256: 'aa'.repeat(32) };
    },
    expectedOcmRunHash: async () => {
      calls.push('expectedOcmRunHash');
      return 'aa'.repeat(32);
    },
    ghBinary: async () => {
      calls.push('ghBinary');
      return {
        resolved: '/usr/bin/gh',
        candidates: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'],
      };
    },
    ghAuth: async (binaryPath) => {
      calls.push(`ghAuth:${binaryPath}`);
      return {
        tokenPresent: true,
        authCheck: { outcome: 'pass', reason: 'gh auth status succeeded' },
      };
    },
    seatProbe: async (seat) => {
      calls.push(`seatProbe:${seat.id}`);
      return ALL_SEATS_PASS;
    },
    serverProbe: async (host, port) => {
      calls.push(`serverProbe:${host}:${port}`);
      return {
        outcome: 'pass',
        reason: `the opencode server on 127.0.0.1:${port} answered`,
        models: [
          'm',
          'm1',
          'm2',
          'acme/alpha-1',
          'acme/alpha-2',
          'nvidia/acme/beta-2',
        ],
      };
    },
    pinnedBuild: async () => {
      calls.push('pinnedBuild');
      return {
        pinnedCommit: 'a'.repeat(40),
        baseTipCommit: 'a'.repeat(40),
        behindCount: 0,
        installRootName: 'fleet-install',
      };
    },
    loginShell: async (host) => {
      calls.push(`loginShell:${host}`);
      return 'intact';
    },
    diskQuotaUsage: async (host) => {
      calls.push(`diskQuotaUsage:${host}`);
      return { usedBytes: 100, totalBytes: 1000 };
    },
    ...overrides,
  };
  return { probes, calls };
}

async function collect(
  result: DoctorableInstallation,
  probes: DoctorProbes,
  options: RunDoctorOptions = { probeSeats: true },
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for await (const line of runDoctor(result, probes, options)) {
    lines.push(line);
  }
  return lines;
}

describe('runDoctor routing environment (H3b)', () => {
  const model = sampleModel();

  it('reports one FAIL line per routing variable set while a v2 installation is loaded', async () => {
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, {
      probeSeats: true,
      env: {
        OCM_REMOTE_PORT: '59999',
        OCM_HOST: 'stale-tunnel-host',
        FLEET_WORKTREE_SSH_HOST: '',
        FLEET_OCM_RUN_BIN: '/opt/fleet/ocm-run',
      },
    });

    const routingLines = lines.filter(
      (doctorLine) => doctorLine.check === 'routing-env',
    );
    expect(routingLines).toHaveLength(2);
    // Each line names the variable and never values it.
    expect(routingLines.map((doctorLine) => doctorLine.subject).sort()).toEqual(
      ['OCM_HOST', 'OCM_REMOTE_PORT'],
    );
    for (const doctorLine of routingLines) {
      expect(doctorLine).toMatchObject({
        scope: 'installation',
        status: 'FAIL',
        detail: `${doctorLine.subject} is set but ignored for v2; set it on the host entry`,
      });
      expect(doctorLine.detail).not.toContain('59999');
      expect(doctorLine.detail).not.toContain('stale-tunnel-host');
    }
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('reports no routing lines for a v1 installation or an unset environment', async () => {
    const { probes } = fakeProbes();
    const v1Result: DoctorableInstallation = {
      status: 'loaded',
      file: '/installation/fleet.json',
      installation: { schemaVersion: 1 },
      model,
      warnings: [],
    };
    const withEnv = await collect(v1Result, probes, {
      probeSeats: true,
      env: { OCM_REMOTE_PORT: '59999', OCM_HOST: 'stale-tunnel-host' },
    });
    expect(
      withEnv.filter((doctorLine) => doctorLine.check === 'routing-env'),
    ).toEqual([]);

    const withoutEnv = await collect(loadedResult(model), probes, {
      probeSeats: true,
    });
    expect(
      withoutEnv.filter((doctorLine) => doctorLine.check === 'routing-env'),
    ).toEqual([]);
  });
});

describe('runDoctor', () => {
  it('reports every check PASS on an all-pass installation', async () => {
    const model = sampleModel({
      runnerAuthFile: '/secrets/auth',
      tools: ['opencode', 'claude-code'],
      seats: [
        { id: 'impl', tool: 'opencode', model: 'm', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);

    expect(lines.every((line) => line.status === 'PASS')).toBe(true);
    expect(lines[0]).toMatchObject({
      scope: 'installation',
      subject: 'schema',
      check: 'schema-version',
      status: 'PASS',
      detail: 'schema version 2',
    });
    // Platform tools: sh, nc, curl everywhere; ssh only on the ssh host.
    const commandChecks = lines
      .filter((line) => line.check.startsWith('command-'))
      .map((line) => `${line.subject}:${line.check}`);
    expect(commandChecks).toContain('main:command-sh');
    expect(commandChecks).toContain('verifier-host:command-ssh');
    expect(commandChecks).not.toContain('main:command-ssh');
    expect(doctorExitCode(lines)).toBe(0);
  });

  it('turns a v1 file into a schema line plus a FAIL-free D1 warning line', async () => {
    const model = sampleModel();
    const result = loadedResult(model, [
      'shelf: v1 shelf fields are accepted and ignored (D1); nothing consumes them today',
    ]);
    const { probes } = fakeProbes();
    const lines = await collect(result, probes);

    const warningLine = lines.find((line) => line.check === 'v1-ignored-fields');
    expect(warningLine).toMatchObject({
      scope: 'installation',
      subject: 'shelf',
      status: 'PASS',
    });
    expect(warningLine?.detail).toContain('D1');
    expect(lines.every((line) => line.status !== 'FAIL')).toBe(true);
  });

  it('reports FAIL for an unreachable host and a missing command', async () => {
    const model = sampleModel();
    const { probes } = fakeProbes({
      hostReachable: async (host) => host !== 'verifier-host',
      commandAvailable: async (_host, name) => name !== 'nc',
    });
    const lines = await collect(loadedResult(model), probes);

    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'host',
        subject: 'verifier-host',
        check: 'reachable',
        status: 'FAIL',
      }),
    );
    const ncLines = lines.filter((line) => line.check === 'command-nc');
    expect(ncLines.length).toBe(2);
    expect(ncLines.every((line) => line.status === 'FAIL')).toBe(true);
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('reports UNKNOWN for an unparsable tool version on every host', async () => {
    const model = sampleModel({ tools: ['opencode'] });
    const { probes } = fakeProbes({ toolVersion: async () => undefined });
    const lines = await collect(loadedResult(model), probes);

    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'tool',
        subject: 'main/opencode',
        check: 'version',
        status: 'UNKNOWN',
        detail: 'version absent or unparsable',
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'tool',
        subject: 'verifier-host/opencode',
        status: 'UNKNOWN',
      }),
    );
  });

  it('probes tool versions on every host, the ssh host through the ssh wrapper argv', async () => {
    const model = sampleModel({ tools: ['claude-code'] });
    const sshArgvs: Array<readonly string[]> = [];
    const probes = createNodeDoctorProbes({
      localExecutor: {
        async run() {
          return { exitCode: 0, signal: null, stdout: 'claude 9.9.9\n', stderr: '' };
        },
      },
      sshExecutor: {
        async run(argv) {
          sshArgvs.push(argv);
          return { exitCode: 0, signal: null, stdout: 'claude 1.2.3\n', stderr: '' };
        },
      },
    });
    const lines = await collect(loadedResult(model), probes);

    // One version line per host; each subject names the host and the tool.
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'tool',
        subject: 'main/claude-code',
        check: 'version',
        status: 'PASS',
        detail: 'version claude 9.9.9',
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'tool',
        subject: 'verifier-host/claude-code',
        check: 'version',
        status: 'PASS',
        detail: 'version claude 1.2.3',
      }),
    );
    // The ssh host's version probe travels through the BatchMode wrapper.
    expect(sshArgvs).toContainEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'verifier-host',
      '--',
      'sh',
      '-c',
      "''\\''claude'\\'' '\\''--version'\\'''",
    ]);
  });

  it('reports PASS for a declared runner and UNKNOWN for legacy-asserted and undeclared', async () => {
    const undeclared: FleetInstallationModel = {
      ...sampleModel(),
      hosts: {
        main: sampleModel().hosts['main'],
        secondary: {
          transport: 'local',
          roles: ['lane-runner'],
          runner: {
            kind: 'opencode',
            capabilities: {
              source: 'undeclared',
              filesystemScope: 'unknown',
              networkEgressRestricted: null,
              cpuAndMemoryLimited: null,
              processTreeTermination: null,
            },
          },
        },
      },
    };
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(undeclared), probes);

    const byHost = new Map(
      lines
        .filter((line) => line.check === 'runner-capabilities')
        .map((line) => [line.subject, line]),
    );
    expect(byHost.get('main')?.status).toBe('PASS');
    expect(byHost.get('secondary')).toMatchObject({
      status: 'UNKNOWN',
      detail: expect.stringContaining('undeclared'),
    });
    expect(byHost.get('secondary')?.detail).toContain('unknown');
  });

  it('warns that conducted gates are unthrottled when the lane-runner host declares no gateSlot', async () => {
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(sampleModel()), probes);
    const gateLines = lines.filter((line) => line.check === 'gate-slot');
    expect(gateLines).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'gate-slot',
        status: 'PASS',
        detail: 'warning: conducted acceptance gates run unthrottled; declare runner.gateSlot to route them through the host-wide gate slot',
      },
    ]);
  });

  it('reports no gate-slot warning when the lane-runner host declares a gateSlot', async () => {
    const model = sampleModel({
      host: {
        runner: {
          kind: 'opencode',
          port: 4096,
          capabilities: {
            source: 'declared',
            filesystemScope: 'scoped-worktree',
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
          },
          gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
        },
      },
    });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    expect(lines.filter((line) => line.check === 'gate-slot')).toEqual([]);
  });

  it('reports a runner-optional line for optional true, false and absent', async () => {
    const withOptional = (optional?: boolean) =>
      sampleModel({
        host: {
          runner: {
            kind: 'opencode',
            port: 4096,
            capabilities: {
              source: 'declared',
              filesystemScope: 'scoped-worktree',
              networkEgressRestricted: true,
              cpuAndMemoryLimited: true,
              processTreeTermination: true,
            },
            ...(optional !== undefined ? { optional } : {}),
          },
        },
      });
    const { probes } = fakeProbes();
    const detail = (model: FleetInstallationModel) => {
      const found = collect(loadedResult(model), probes).then((lines) =>
        lines.find((line) => line.check === 'runner-optional'),
      );
      return found;
    };
    expect((await detail(withOptional(true)))?.detail).toBe(
      'optional (runner.optional true)',
    );
    expect((await detail(withOptional(false)))?.detail).toBe(
      'required (runner.optional false)',
    );
    expect((await detail(withOptional()))?.detail).toBe(
      'required (runner.optional absent; absent means required)',
    );
    for (const optional of [true, false, undefined]) {
      const line = await detail(withOptional(optional));
      expect(line).toMatchObject({
        scope: 'host',
        subject: 'main',
        check: 'runner-optional',
        status: 'PASS',
      });
    }
  });

  it('reports UNKNOWN with the source in detail for a legacy-asserted runner', async () => {
    const legacy: FleetInstallationModel = {
      ...sampleModel(),
      hosts: {
        main: {
          ...sampleModel().hosts['main'],
          runner: {
            kind: 'opencode',
            capabilities: {
              source: 'legacy-asserted',
              filesystemScope: 'scoped-worktree',
              networkEgressRestricted: true,
              cpuAndMemoryLimited: true,
              processTreeTermination: true,
            },
          },
        },
      },
    };
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(legacy), probes);
    const runnerLine = lines.find((line) => line.check === 'runner-capabilities');
    expect(runnerLine).toMatchObject({ status: 'UNKNOWN' });
    expect(runnerLine?.detail).toContain('legacy-asserted');
  });

  it('fails a group- or world-readable credential with path and mode, never contents', async () => {
    const model = sampleModel({ runnerAuthFile: '/home/dev/.opencode/auth.json' });
    const { probes } = fakeProbes({ fileMode: async () => 0o644 });
    const lines = await collect(loadedResult(model), probes);

    const credential = lines.find((line) => line.scope === 'credential');
    expect(credential).toMatchObject({
      subject: '/home/dev/.opencode/auth.json',
      check: 'file-mode',
      status: 'FAIL',
    });
    expect(credential?.detail).toContain('/home/dev/.opencode/auth.json');
    expect(credential?.detail).toContain('0644');
    // The detail is a path and mode only; there is nothing to leak.
    expect(credential?.detail.startsWith('/home/dev/.opencode/auth.json: mode 0644')).toBe(true);
  });

  it('probes a remote lane host\'s runner authFile on the orchestrator, never over ssh (KF-14c)', async () => {
    // The lane host is REMOTE: the old probe went over ssh to 'lane-alias'.
    const model = sampleModel({
      runnerAuthFile: '/home/dev/.opencode/auth.json',
      host: { transport: 'ssh', sshAlias: 'lane-alias' },
    });
    const seen: string[] = [];
    const { probes } = fakeProbes({
      fileMode: async (host, path) => {
        seen.push(`${host}:${path}`);
        return 0o600;
      },
    });
    await collect(loadedResult(model), probes);
    expect(seen.filter((call) => call.endsWith('/home/dev/.opencode/auth.json'))).toEqual(['local:/home/dev/.opencode/auth.json']);
    expect(seen.some((call) => call.startsWith('lane-alias:'))).toBe(false);
  });

  it('fails a missing credential file', async () => {
    const model = sampleModel({ runnerAuthFile: '/gone/auth.json' });
    const { probes } = fakeProbes({ fileMode: async () => undefined });
    const lines = await collect(loadedResult(model), probes);

    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'credential',
        subject: '/gone/auth.json',
        status: 'FAIL',
        detail: '/gone/auth.json: missing',
      }),
    );
  });

  it('passes a 0600 credential file', async () => {
    const model = sampleModel({ runnerAuthFile: '/secrets/auth' });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'credential',
        subject: '/secrets/auth',
        status: 'PASS',
        detail: '/secrets/auth: mode 0600',
      }),
    );
  });

  it('fails a runner binary hash mismatch and stays UNKNOWN when unreadable', async () => {
    const model = sampleModel();

    const mismatched = fakeProbes({
      ocmRunBinary: async () => ({ path: '/bin/ocm-run', sha256: 'bb'.repeat(32) }),
    });
    const mismatchLines = await collect(loadedResult(model), mismatched.probes);
    expect(mismatchLines).toContainEqual(
      expect.objectContaining({
        scope: 'runner-binary',
        subject: 'ocm-run',
        status: 'FAIL',
        detail: expect.stringContaining('does not match expected'),
      }),
    );

    const unreadable = fakeProbes({ ocmRunBinary: async () => undefined });
    const unreadableLines = await collect(loadedResult(model), unreadable.probes);
    expect(unreadableLines).toContainEqual(
      expect.objectContaining({
        scope: 'runner-binary',
        status: 'UNKNOWN',
        detail: 'bundled ocm-run unresolved or unreadable',
      }),
    );

    const noExpectedHash = fakeProbes({ expectedOcmRunHash: async () => undefined });
    const noHashLines = await collect(loadedResult(model), noExpectedHash.probes);
    expect(noHashLines).toContainEqual(
      expect.objectContaining({ scope: 'runner-binary', status: 'UNKNOWN' }),
    );
  });

  it('reports seat probes when enabled and not-probed UNKNOWN lines when disabled', async () => {
    const seats: SeatModel[] = [
      { id: 'impl', tool: 'opencode', model: 'm1', roles: ['implementer'], costClass: 'free' },
      { id: 'rev', tool: 'opencode', model: 'm2', roles: ['reviewer'], costClass: 'paid' },
    ];
    const model = sampleModel({ seats });

    const probed = fakeProbes();
    const probedLines = await collect(loadedResult(model), probed.probes);
    expect(probedLines.filter((line) => line.scope === 'seat')).toHaveLength(2);
    expect(probedLines.filter((line) => line.scope === 'seat').every((line) => line.status === 'PASS'))
      .toBe(true);

    const unprobed = fakeProbes();
    const unprobedLines = await collect(
      loadedResult(model),
      unprobed.probes,
      { probeSeats: false },
    );
    const seatLines = unprobedLines.filter((line) => line.scope === 'seat');
    expect(seatLines).toHaveLength(2);
    expect(seatLines.every((line) => line.status === 'UNKNOWN')).toBe(true);
    expect(seatLines.map((line) => line.detail)).toEqual([
      'not probed (--probe-seats)',
      'not probed (--probe-seats)',
    ]);
    expect(unprobed.calls.filter((call) => call.startsWith('seatProbe'))).toEqual([]);
  });

  it('maps seat probe outcomes fail and unknown onto FAIL and UNKNOWN', async () => {
    const seats: SeatModel[] = [
      { id: 'impl', tool: 'opencode', model: 'm1', roles: ['implementer'], costClass: 'free' },
      { id: 'rev', tool: 'opencode', model: 'm2', roles: ['reviewer'], costClass: 'paid' },
    ];
    const model = sampleModel({ seats });
    const { probes } = fakeProbes({
      seatProbe: async (seat) =>
        seat.id === 'impl'
          ? { outcome: 'fail', reason: 'model refused' }
          : { outcome: 'unknown', reason: 'no answer' },
    });
    const lines = await collect(loadedResult(model), probes);
    const seatLines = lines.filter((line) => line.scope === 'seat');
    expect(seatLines).toContainEqual(
      expect.objectContaining({ subject: 'impl', status: 'FAIL', detail: 'model refused' }),
    );
    expect(seatLines).toContainEqual(
      expect.objectContaining({ subject: 'rev', status: 'UNKNOWN', detail: 'no answer' }),
    );
  });

  it('turns a throwing probe into UNKNOWN, not a crash', async () => {
    const model = sampleModel({
      runnerAuthFile: '/secrets/auth',
      tools: ['opencode'],
      seats: [
        { id: 'impl', tool: 'opencode', model: 'm', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const throwing: Partial<DoctorProbes> = {
      hostReachable: async () => {
        throw new Error('ssh exploded');
      },
      commandAvailable: async () => {
        throw new Error('exec exploded');
      },
      toolVersion: async () => {
        throw new Error('parse exploded');
      },
      fileMode: async () => {
        throw new Error('stat exploded');
      },
      worktreeRootWritable: async () => {
        throw new Error('fs exploded');
      },
      ocmRunBinary: async () => {
        throw new Error('read exploded');
      },
      expectedOcmRunHash: async () => {
        throw new Error('hash exploded');
      },
      ghBinary: async () => {
        throw new Error('gh exploded');
      },
      seatProbe: async () => {
        throw new Error('seat exploded');
      },
      serverProbe: async () => {
        throw new Error('server exploded');
      },
      pinnedBuild: async () => {
        throw new Error('pinned-build exploded');
      },
      loginShell: async () => {
        throw new Error('shell exploded');
      },
    };
    const { probes } = fakeProbes(throwing);
    const lines = await collect(loadedResult(model), probes);

    expect(lines.length).toBeGreaterThan(0);
    // The only lines that do not depend on a throwing probe are the schema
    // line, the runner capability declaration, the free-tier policy line and
    // the gate-slot warning (all derived, not probed; the gate-slot warning
    // is a PASS line like the ignored-v1-fields warnings).
    const expectedUnknown = lines.filter(
      (line) =>
        line.check !== 'schema-version' &&
        line.check !== 'runner-capabilities' &&
        line.check !== 'free-tier' &&
        line.check !== 'auto-merge' &&
        line.check !== 'gate-slot' &&
        line.check !== 'runner-optional',
    );
    const unknownLines = lines.filter((line) => line.status === 'UNKNOWN');
    expect(unknownLines).toHaveLength(expectedUnknown.length);
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('emits lines in the documented order: installation, hosts, tools, credentials, runner binary, seats', async () => {
    const model = sampleModel({
      runnerAuthFile: '/secrets/auth',
      tools: ['opencode'],
      seats: [
        { id: 'impl', tool: 'opencode', model: 'm', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    const scopes = lines.map((line) => line.scope);
    const firstIndex = (scope: DoctorLine['scope']) => scopes.indexOf(scope);
    expect(firstIndex('installation')).toBeLessThan(firstIndex('host'));
    expect(firstIndex('host')).toBeLessThan(firstIndex('tool'));
    expect(firstIndex('tool')).toBeLessThan(firstIndex('credential'));
    expect(firstIndex('credential')).toBeLessThan(firstIndex('runner-binary'));
    expect(firstIndex('runner-binary')).toBeLessThan(firstIndex('gh-binary'));
    expect(firstIndex('gh-binary')).toBeLessThan(firstIndex('seat'));
  });
});

describe('runDoctor gh-binary check', () => {
  const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

  it('reports PASS naming the resolved path when a candidate resolves', async () => {
    const { probes } = fakeProbes({
      ghBinary: async () => ({ resolved: '/usr/bin/gh', candidates: GH_CANDIDATES }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    const ghLines = lines.filter((line) => line.scope === 'gh-binary');
    expect(ghLines[0]).toEqual({
      scope: 'gh-binary',
      subject: 'gh',
      check: 'resolved',
      status: 'PASS',
      detail: '/usr/bin/gh',
    });
    expect(doctorExitCode(lines)).toBe(0);
  });

  it('reports FAIL naming all candidate paths when none resolves', async () => {
    const { probes } = fakeProbes({
      ghBinary: async () => ({ resolved: undefined, candidates: GH_CANDIDATES }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    const ghLine = lines.find((line) => line.scope === 'gh-binary');
    expect(ghLine).toMatchObject({ subject: 'gh', check: 'resolved', status: 'FAIL' });
    for (const candidate of GH_CANDIDATES) {
      expect(ghLine?.detail).toContain(candidate);
    }
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('reports UNKNOWN when the probe fails to run', async () => {
    const { probes } = fakeProbes({ ghBinary: async () => undefined });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'gh-binary',
        subject: 'gh',
        check: 'resolved',
        status: 'UNKNOWN',
        detail: 'gh resolution probe failed',
      }),
    );
    expect(doctorExitCode(lines)).toBe(1);
  });
});

describe('runDoctor gh non-interactive auth check', () => {
  const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

  const resolvedGh = (): Partial<DoctorProbes> => ({
    ghBinary: async () => ({ resolved: '/usr/bin/gh', candidates: GH_CANDIDATES }),
  });

  const authLines = (lines: DoctorLine[]): DoctorLine[] =>
    lines.filter((line) => line.check === 'auth-non-interactive');

  it('reports PASS when gh authenticates with the service environment token', async () => {
    const { probes } = fakeProbes({
      ...resolvedGh(),
      ghAuth: async () => ({
        tokenPresent: true,
        authCheck: { outcome: 'pass', reason: 'gh auth status succeeded' },
      }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'PASS',
        detail: 'gh authenticated non-interactively with service environment token',
      },
    ]);
  });

  it('reports FAIL with remedy when no token variable is present', async () => {
    const { probes } = fakeProbes({
      ...resolvedGh(),
      ghAuth: async () => ({
        tokenPresent: false,
        authCheck: { outcome: 'fail', reason: 'no GH_TOKEN or GITHUB_TOKEN in service environment' },
      }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    const [authLine] = authLines(lines);
    expect(authLine).toMatchObject({ scope: 'gh-binary', subject: 'gh', status: 'FAIL' });
    expect(authLine?.detail).toContain('no GH_TOKEN or GITHUB_TOKEN in service environment');
    expect(authLine?.detail).toContain('provide the token through the service environment file');
  });

  it('reports FAIL when gh auth check fails', async () => {
    const { probes } = fakeProbes({
      ...resolvedGh(),
      ghAuth: async () => ({
        tokenPresent: true,
        authCheck: { outcome: 'fail', reason: 'gh auth status failed' },
      }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'FAIL',
        detail: 'gh non-interactive auth failed; provide the token through the service environment file',
      },
    ]);
  });

  it('reports UNKNOWN when gh auth check returns unknown', async () => {
    const { probes } = fakeProbes({
      ...resolvedGh(),
      ghAuth: async () => ({
        tokenPresent: true,
        authCheck: { outcome: 'unknown', reason: 'gh auth status timed out or could not be run' },
      }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'UNKNOWN',
        detail: 'gh non-interactive auth check timed out or could not be run',
      },
    ]);
  });

  it('reports UNKNOWN auth-non-interactive when gh binary is unresolved', async () => {
    const { probes } = fakeProbes({
      ghBinary: async () => ({ resolved: undefined, candidates: GH_CANDIDATES }),
      ghAuth: async () => ({
        tokenPresent: true,
        authCheck: { outcome: 'pass', reason: 'gh auth status succeeded' },
      }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'UNKNOWN',
        detail: 'gh binary not resolved; non-interactive auth not checked',
      },
    ]);
  });

  it('reports UNKNOWN when the gh resolution probe fails to run', async () => {
    const { probes } = fakeProbes({
      ghBinary: async () => undefined,
      ghAuth: async () => ({
        tokenPresent: true,
        authCheck: { outcome: 'pass', reason: 'gh auth status succeeded' },
      }),
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'UNKNOWN',
        detail: 'gh binary not resolved; non-interactive auth not checked',
      },
    ]);
  });

  it('reports UNKNOWN when optional ghAuth probe is omitted', async () => {
    const { probes } = fakeProbes({ ...resolvedGh(), ghAuth: undefined });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'UNKNOWN',
        detail: 'gh auth probe not configured',
      },
    ]);
  });

  it('reports UNKNOWN when ghAuth probe throws', async () => {
    const { probes } = fakeProbes({
      ...resolvedGh(),
      ghAuth: async () => {
        throw new Error('probe exploded');
      },
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(authLines(lines)).toEqual([
      {
        scope: 'gh-binary',
        subject: 'gh',
        check: 'auth-non-interactive',
        status: 'UNKNOWN',
        detail: 'gh non-interactive auth probe failed',
      },
    ]);
  });

  it('reports UNKNOWN for null, array, or malformed ghAuth observation', async () => {
    for (const observation of [
      null,
      undefined,
      [],
      { tokenPresent: 'yes', authCheck: { outcome: 'pass' } },
      { tokenPresent: true, authCheck: null },
      { tokenPresent: true, authCheck: { outcome: 'perhaps' } },
    ] as unknown[]) {
      const { probes } = fakeProbes({
        ...resolvedGh(),
        ghAuth: async () => observation as never,
      });
      const lines = await collect(loadedResult(sampleModel()), probes);
      expect(authLines(lines)).toEqual([
        {
          scope: 'gh-binary',
          subject: 'gh',
          check: 'auth-non-interactive',
          status: 'UNKNOWN',
          detail: 'gh non-interactive auth probe returned malformed result',
        },
      ]);
    }
  });

  it('never leaks the token, account name or gh output into any DoctorLine (real probe path)', async () => {
    const placeholder = ['sentinel', 'value', '7f3a'].join('-');
    const account = ['account', 'name', 'zq9'].join('-');
    const hostile = `Logged in to github.com account ${account} (${placeholder})\n`;
    const resolvedBinary = async () => ({ resolved: '/usr/bin/gh', candidates: GH_CANDIDATES });
    for (const exitCode of [0, 1]) {
      const serviceEnv: Record<string, string> = {};
      serviceEnv['GH_TOKEN'] = placeholder;
      const real = createNodeDoctorProbes({
        serviceEnv,
        localExecutor: {
          async run(argv) {
            if (argv[0] === '/usr/bin/gh') {
              return { exitCode, signal: null, stdout: hostile, stderr: hostile };
            }
            return { exitCode: 0, signal: null, stdout: '', stderr: '' };
          },
        },
      });
      const probes: DoctorProbes = { ...real, ghBinary: resolvedBinary };
      const lines = await collect(loadedResult(sampleModel()), probes);
      const auth = lines.filter((line) => line.check === 'auth-non-interactive');
      expect(auth.length).toBeGreaterThan(0);
      for (const line of lines) {
        const serialised = JSON.stringify(line);
        expect(serialised).not.toContain(placeholder);
        expect(serialised).not.toContain(account);
      }
    }
  });
});

describe('runDoctor free-tier (FS4)', () => {
  const freeTierSeats: SeatModel[] = [
    {
      id: 'free1',
      tool: 'opencode',
      model: 'acme/alpha-1',
      roles: ['implementer'],
      costClass: 'free',
    },
    {
      id: 'paid1',
      tool: 'opencode',
      model: 'acme/alpha-2',
      roles: ['implementer'],
      costClass: 'paid',
    },
    {
      id: 'nv',
      tool: 'opencode',
      model: 'nvidia/acme/beta-2',
      roles: ['reviewer'],
      costClass: 'paid',
    },
  ];

  it('a: flag false disables free seats, warns on an nvidia paid seat, exit 0', async () => {
    const model: FleetInstallationModel = {
      ...sampleModel({ seats: freeTierSeats }),
      policy: { useFreeSeats: false },
    };
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, {
      probeSeats: true,
    });

    const policyLine = lines.find(
      (line) => line.scope === 'installation' && line.check === 'free-tier',
    );
    expect(policyLine).toMatchObject({
      subject: 'policy',
      status: 'PASS',
      detail: 'off (policy.useFreeSeats false); 1 free seat(s) disabled',
    });

    const free1Lines = lines.filter(
      (line) => line.scope === 'seat' && line.subject === 'free1',
    );
    expect(free1Lines).toHaveLength(1);
    expect(free1Lines[0]).toMatchObject({
      check: 'free-tier',
      status: 'PASS',
    });

    expect(calls).not.toContain('seatProbe:free1');
    expect(calls).toContain('seatProbe:paid1');

    const nvLine = lines.find((line) => line.check === 'nvidia-cost-class');
    expect(nvLine).toMatchObject({
      scope: 'seat',
      subject: 'nv',
      status: 'PASS',
    });
    expect(nvLine?.detail.startsWith('warning:')).toBe(true);

    expect(doctorExitCode(lines)).toBe(0);
  });

  it('b: flag absent shows on and probes free seats', async () => {
    const model = sampleModel({ seats: freeTierSeats });
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, {
      probeSeats: true,
    });

    const policyLine = lines.find(
      (line) => line.scope === 'installation' && line.check === 'free-tier',
    );
    expect(policyLine?.detail).toBe(
      'on (policy.useFreeSeats absent; absent means on)',
    );
    expect(
      lines.filter(
        (line) =>
          line.scope === 'seat' &&
          (line.check === 'free-tier' || line.check === 'nvidia-cost-class'),
      ),
    ).toEqual([]);
    expect(calls).toContain('seatProbe:free1');
  });

  it('c: flag true reports on', async () => {
    const model: FleetInstallationModel = {
      ...sampleModel({ seats: freeTierSeats }),
      policy: { useFreeSeats: true },
    };
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, {
      probeSeats: true,
    });

    const policyLine = lines.find(
      (line) => line.scope === 'installation' && line.check === 'free-tier',
    );
    expect(policyLine?.detail).toBe('on (policy.useFreeSeats true)');
  });
});

describe('runDoctor auto-merge line (AM5-2)', () => {
  /** A loaded result whose raw installation carries the given policy. */
  function autoMergeResult(
    policy: Record<string, unknown> | undefined,
  ): DoctorableInstallation {
    const model = sampleModel();
    return {
      status: 'loaded',
      file: '/installation/fleet.json',
      installation:
        policy === undefined
          ? { schemaVersion: 2 }
          : { schemaVersion: 2, policy: policy as never },
      model,
      warnings: [],
    };
  }

  it('an absent block reports the default policy and says absent means off', async () => {
    const { probes } = fakeProbes();
    const lines = await collect(autoMergeResult(undefined), probes);

    const policyLine = lines.find(
      (line) => line.scope === 'installation' && line.check === 'auto-merge',
    );
    expect(policyLine).toMatchObject({
      subject: 'policy',
      status: 'PASS',
      detail:
        'auto-merge: off, allowHighRisk false, onBlocked ask-owner, revision 0692f17be6e5 (absent; absent means off)',
    });
    expect(doctorExitCode(lines)).toBe(0);
  });

  it('an explicit enabled block reports on with its own revision', async () => {
    const { probes } = fakeProbes();
    const lines = await collect(
      autoMergeResult({
        autoMerge: { enabled: true, allowHighRisk: false, onBlocked: 'hold' },
      }),
      probes,
    );

    const policyLine = lines.find(
      (line) => line.scope === 'installation' && line.check === 'auto-merge',
    );
    expect(policyLine).toMatchObject({
      subject: 'policy',
      status: 'PASS',
      detail:
        'auto-merge: on, allowHighRisk false, onBlocked hold, revision 1cbf028644d3',
    });
  });
});

describe('runDoctor server probes (P1)', () => {
  it('reports one PASS server-answers line per opencode host naming the port; a host without a runner gets none', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'm', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);

    const serverLines = lines.filter((line) => line.check === 'server-answers');
    expect(serverLines).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'server-answers',
        status: 'PASS',
        detail: 'the opencode server on 127.0.0.1:4096 answered',
      },
    ]);
    expect(calls).toContain('serverProbe:local:4096');
    expect(calls.some((call) => call.startsWith('serverProbe:verifier-host'))).toBe(false);
  });

  it('maps probe outcomes fail and a throwing probe onto FAIL and UNKNOWN', async () => {
    const model = sampleModel();
    const failing = fakeProbes({
      serverProbe: async () => ({ outcome: 'fail', reason: 'the opencode server on 127.0.0.1:4096 answered HTTP 500' }),
    });
    const failLines = await collect(loadedResult(model), failing.probes);
    expect(failLines).toContainEqual(
      expect.objectContaining({
        scope: 'host',
        subject: 'main',
        check: 'server-answers',
        status: 'FAIL',
        detail: 'the opencode server on 127.0.0.1:4096 answered HTTP 500',
      }),
    );

    const throwing = fakeProbes({
      serverProbe: async () => {
        throw new Error('server exploded');
      },
    });
    const unknownLines = await collect(loadedResult(model), throwing.probes);
    expect(unknownLines).toContainEqual(
      expect.objectContaining({
        scope: 'host',
        subject: 'main',
        check: 'server-answers',
        status: 'UNKNOWN',
        detail: 'the server probe failed',
      }),
    );
  });

  it('reports PASS model-listed when the servers list every opencode seat', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'acme/alpha-1', roles: ['implementer'], costClass: 'free' },
        {
          id: 'rev',
          tool: 'opencode',
          model: 'nvidia/acme/beta-2',
          variant: 'high',
          roles: ['reviewer'],
          costClass: 'paid',
        },
      ],
    });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'installation',
        subject: 'seats',
        check: 'model-listed',
        status: 'PASS',
        detail: 'the opencode server lists all 2 opencode seat(s)',
      }),
    );
    expect(doctorExitCode(lines)).toBe(0);
  });

  it('reports FAIL naming the seat model the servers do not list', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'acme/alpha-1', roles: ['implementer'], costClass: 'free' },
        { id: 'rev', tool: 'opencode', model: 'acme/gone-9', roles: ['reviewer'], costClass: 'paid' },
      ],
    });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'installation',
        subject: 'seats',
        check: 'model-listed',
        status: 'FAIL',
        detail: 'the opencode server does not list acme/gone-9',
      }),
    );
  });

  it('reports UNKNOWN model-listed when no server listed any model', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'm', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes } = fakeProbes({
      serverProbe: async (_host, port) => ({
        outcome: 'pass',
        reason: `the opencode server on 127.0.0.1:${port} answered`,
      }),
    });
    const lines = await collect(loadedResult(model), probes);
    expect(lines).toContainEqual(
      expect.objectContaining({
        scope: 'installation',
        subject: 'seats',
        check: 'model-listed',
        status: 'UNKNOWN',
        detail: 'no opencode server listed its models; the seats could not be checked',
      }),
    );
  });

  it('emits no model-listed line when the installation names no opencode seat', async () => {
    const model = sampleModel({
      seats: [
        { id: 'agy1', tool: 'agy', model: 'a-model', roles: ['implementer'] },
      ],
    });
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    expect(lines.filter((line) => line.check === 'model-listed')).toEqual([]);
  });

  it('skips server probe and omits model-listed when probeServers is false', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'acme/alpha-1', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, {
      probeSeats: true,
      probeServers: false,
    });

    expect(calls.some((call) => call.startsWith('serverProbe:'))).toBe(false);
    expect(lines.filter((line) => line.check === 'server-answers')).toEqual([]);
    expect(lines.filter((line) => line.check === 'model-listed')).toEqual([]);
  });

  it('probes servers and emits model-listed by default when probeServers is omitted', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'acme/alpha-1', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, {
      probeSeats: true,
    });

    expect(calls).toContain('serverProbe:local:4096');
    expect(lines.filter((line) => line.check === 'server-answers')).toHaveLength(1);
    expect(lines.filter((line) => line.check === 'model-listed')).toHaveLength(1);
  });
});

describe('pinned-build freshness (DB1)', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  function pinnedProbes(
    result: PinnedBuildProbeResult | undefined | null,
    overrides: Record<string, unknown> = {},
  ): DoctorProbes {
    const base = fakeProbes();
    return {
      ...base.probes,
      ...(overrides.pinnedBuild !== undefined
        ? { pinnedBuild: overrides.pinnedBuild }
        : { pinnedBuild: async () => result }),
    } as DoctorProbes;
  }

  function pinnedLine(lines: readonly DoctorLine[]): DoctorLine {
    const found = lines.find((doctorLine) => doctorLine.check === 'pinned-build');
    expect(found).toBeDefined();
    return found!;
  }

  it('reports PASS when pinned build equals base branch tip', async () => {
    const lines = await pinnedBuildLines(
      pinnedProbes({
        pinnedCommit: SHA_A,
        baseTipCommit: SHA_A.toUpperCase(),
        behindCount: 0,
        installRootName: 'fleet-install',
      }),
    );
    expect(pinnedLine(lines)).toMatchObject({
      scope: 'installation',
      subject: 'build',
      check: 'pinned-build',
      status: 'PASS',
    });
    expect(pinnedLine(lines).detail).toContain('aaaaaaaa');
    expect(pinnedLine(lines).detail).not.toContain(SHA_A);
  });

  it('reports FAIL with commit count when pinned build is behind base branch tip', async () => {
    const lines = await pinnedBuildLines(
      pinnedProbes({
        pinnedCommit: SHA_A,
        baseTipCommit: SHA_B,
        behindCount: 8,
        installRootName: 'fleet-install',
      }),
    );
    expect(pinnedLine(lines)).toMatchObject({
      scope: 'installation',
      subject: 'build',
      check: 'pinned-build',
      status: 'FAIL',
    });
    expect(pinnedLine(lines).detail).toContain('8 commits behind');
  });

  it('reports UNKNOWN when optional pinnedBuild probe is absent', async () => {
    const base = fakeProbes();
    const { pinnedBuild: _omitted, ...withoutProbe } = base.probes;
    void _omitted;
    const lines = await pinnedBuildLines(withoutProbe as DoctorProbes);
    expect(pinnedLine(lines)).toMatchObject({
      status: 'UNKNOWN',
      detail: 'pinned build probe not available',
    });
    const notAFunction = pinnedProbes(undefined, { pinnedBuild: 'nope' });
    const notFnLines = await pinnedBuildLines(notAFunction);
    expect(pinnedLine(notFnLines).detail).toBe('pinned build probe not available');
  });

  it('reports UNKNOWN when pinnedBuild probe throws', async () => {
    const throwing = pinnedProbes(undefined, {
      pinnedBuild: () => {
        throw new Error('boom');
      },
    });
    const lines = await pinnedBuildLines(throwing);
    expect(pinnedLine(lines)).toMatchObject({
      status: 'UNKNOWN',
      detail: 'pinned build probe failed',
    });
    // A throwing getter on the returned object is caught the same way.
    const hostile: DoctorProbes = {
      ...fakeProbes().probes,
      get pinnedBuild(): never {
        throw new Error('getter boom');
      },
    } as unknown as DoctorProbes;
    const getterLines = await pinnedBuildLines(hostile);
    expect(pinnedLine(getterLines).detail).toBe('pinned build probe failed');
  });

  it('reports UNKNOWN when pinnedBuild returns null or undefined', async () => {
    for (const value of [undefined, null]) {
      const lines = await pinnedBuildLines(pinnedProbes(value as undefined));
      expect(pinnedLine(lines)).toMatchObject({
        status: 'UNKNOWN',
        detail: 'pinned build probe failed',
      });
    }
  });

  it('reports UNKNOWN when pinned commit cannot be read', async () => {
    for (const pinnedCommit of [undefined, null, '', '   ', 'xyz', 'g'.repeat(40), 7] as unknown[]) {
      const lines = await pinnedBuildLines(
        pinnedProbes({ pinnedCommit, baseTipCommit: SHA_B, behindCount: 3 } as never),
      );
      expect(pinnedLine(lines)).toMatchObject({
        status: 'UNKNOWN',
        detail: 'pinned build commit could not be read',
      });
    }
  });

  it('reports UNKNOWN when base branch tip commit cannot be read', async () => {
    for (const baseTipCommit of [undefined, null, '', '  \n', 'nothex', 'z'.repeat(40)] as unknown[]) {
      const lines = await pinnedBuildLines(
        pinnedProbes({ pinnedCommit: SHA_A, baseTipCommit, behindCount: 3 } as never),
      );
      expect(pinnedLine(lines)).toMatchObject({
        status: 'UNKNOWN',
        detail: 'base branch tip commit could not be read',
      });
    }
  });

  it('reports UNKNOWN when behindCount is missing or invalid for differing commits', async () => {
    for (const behindCount of [undefined, null, NaN, -1, 1.5, '3'] as unknown[]) {
      const lines = await pinnedBuildLines(
        pinnedProbes({ pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount } as never),
      );
      expect(pinnedLine(lines)).toMatchObject({
        status: 'UNKNOWN',
        detail: 'commit distance between pinned build and base tip could not be determined',
      });
    }
  });

  it('reports UNKNOWN when commits differ with zero behindCount', async () => {
    const lines = await pinnedBuildLines(
      pinnedProbes({ pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: 0 }),
    );
    expect(pinnedLine(lines)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('strips directory prefixes from installRootName and redacts secret-shaped text', async () => {
    const lines = await pinnedBuildLines(
      pinnedProbes({
        pinnedCommit: SHA_A,
        baseTipCommit: SHA_B,
        behindCount: 2,
        installRootName: '/srv/fleet/instances/prod-1\\nested',
      }),
    );
    const doctorLine = pinnedLine(lines);
    expect(doctorLine.status).toBe('FAIL');
    expect(doctorLine.detail).toContain('install root nested');
    expect(doctorLine.detail).not.toContain('/srv');
    expect(doctorLine.detail).not.toContain('/');
    expect(doctorLine.detail).not.toContain('\\');
    // Secret-shaped text in the root name is redacted by the detail boundary.
    // The `sk-` shape is the same shape the redaction tests elsewhere use;
    // it exercises redaction without embedding a real vendor token format.
    const secret = await pinnedBuildLines(
      pinnedProbes({
        pinnedCommit: SHA_A,
        baseTipCommit: SHA_B,
        behindCount: 2,
        installRootName: `sk-${'a'.repeat(16)}`,
      }),
    );
    expect(pinnedLine(secret).detail).toContain('[redacted]');
  });

  it('runs after ghBinaryLines and before seatLines so lines[0] stays schema-version', async () => {
    const model = sampleModel({
      seats: [
        { id: 'impl', tool: 'opencode', model: 'm', roles: ['implementer'], costClass: 'free' },
      ],
    });
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes, { probeSeats: true });
    expect(lines[0]).toMatchObject({ check: 'schema-version', status: 'PASS' });
    const ghIndex = lines.findIndex((doctorLine) => doctorLine.scope === 'gh-binary');
    const pinnedIndex = lines.findIndex((doctorLine) => doctorLine.check === 'pinned-build');
    const seatIndex = lines.findIndex((doctorLine) => doctorLine.scope === 'seat');
    expect(ghIndex).toBeGreaterThanOrEqual(0);
    expect(pinnedIndex).toBeGreaterThan(ghIndex);
    expect(pinnedIndex).toBeLessThan(seatIndex);
    expect(calls.indexOf('pinnedBuild')).toBeGreaterThan(calls.indexOf('ghBinary'));
  });

  describe('hostile probe results', () => {
    const FIELDS = ['pinnedCommit', 'baseTipCommit', 'behindCount', 'installRootName'] as const;

    function withThrowingField(field: (typeof FIELDS)[number]): PinnedBuildProbeResult {
      const result = {
        pinnedCommit: SHA_A,
        baseTipCommit: SHA_B,
        behindCount: 2,
        installRootName: 'fleet-install',
      };
      Object.defineProperty(result, field, {
        get(): never {
          throw new Error(`${field} getter boom`);
        },
        enumerable: true,
      });
      return result as PinnedBuildProbeResult;
    }

    async function sweepWith(result: unknown): Promise<DoctorLine[]> {
      const { probes } = fakeProbes({ pinnedBuild: async () => result as never });
      return collect(loadedResult(sampleModel()), probes);
    }

    async function baselineLines(): Promise<DoctorLine[]> {
      return collect(loadedResult(sampleModel()), fakeProbes().probes);
    }

    function expectOnlyPinnedUnknown(
      lines: readonly DoctorLine[],
      baseline: readonly DoctorLine[],
    ): void {
      expect(pinnedLine(lines).status).toBe('UNKNOWN');
      const others = (all: readonly DoctorLine[]): DoctorLine[] =>
        all.filter((doctorLine) => doctorLine.check !== 'pinned-build');
      expect(others(lines)).toEqual(others(baseline));
    }

    for (const field of FIELDS) {
      it(`reports UNKNOWN when ${field} is a throwing getter on the returned result`, async () => {
        const baseline = await baselineLines();
        const lines = await sweepWith(withThrowingField(field));
        expectOnlyPinnedUnknown(lines, baseline);
        expect(pinnedLine(lines).detail).toBe('pinned build probe result could not be read');
      });
    }

    it('reports UNKNOWN for a throwing Proxy result and a throwing then', async () => {
      const baseline = await baselineLines();
      const proxy = new Proxy(
        {},
        {
          get(): never {
            throw new Error('proxy boom');
          },
        },
      );
      expectOnlyPinnedUnknown(await sweepWith(proxy), baseline);
      const thenable = {
        get then(): never {
          throw new Error('then boom');
        },
      };
      expectOnlyPinnedUnknown(await sweepWith(thenable), baseline);
    });

    it('reports UNKNOWN for results that are not objects', async () => {
      const baseline = await baselineLines();
      for (const value of ['a'.repeat(40), 42, true]) {
        expectOnlyPinnedUnknown(await sweepWith(value), baseline);
      }
    });

    it('reports UNKNOWN for wrong-typed and non-finite fields', async () => {
      const baseline = await baselineLines();
      const bad: Record<string, unknown>[] = [
        { pinnedCommit: {}, baseTipCommit: SHA_B, behindCount: 2 },
        { pinnedCommit: [SHA_A], baseTipCommit: SHA_B, behindCount: 2 },
        { pinnedCommit: SHA_A, baseTipCommit: 12345678, behindCount: 2 },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: Infinity },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: -Infinity },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: NaN },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: 1e21 },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: [3] },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: 2, installRootName: 5 },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: 2, installRootName: {} },
        { pinnedCommit: SHA_A, baseTipCommit: SHA_B, behindCount: 2, installRootName: null },
      ];
      for (const result of bad) {
        expectOnlyPinnedUnknown(await sweepWith(result), baseline);
      }
    });

    it('reports UNKNOWN when strings carry control characters, never printing them', async () => {
      const baseline = await baselineLines();
      const controls = ['\u0000', '\u001b[31m', '\u0007', '\u007f', '\u0085', '\u2028', '\u202e'];
      for (const control of controls) {
        const lines = await sweepWith({
          pinnedCommit: SHA_A,
          baseTipCommit: SHA_B,
          behindCount: 2,
          installRootName: `ro${control}ot`,
        });
        expectOnlyPinnedUnknown(lines, baseline);
        expect(pinnedLine(lines).detail).not.toContain(control);
        const commitLines = await sweepWith({
          pinnedCommit: `${SHA_A.slice(0, 20)}${control}${SHA_A.slice(20)}`,
          baseTipCommit: SHA_B,
          behindCount: 2,
        });
        expectOnlyPinnedUnknown(commitLines, baseline);
        expect(pinnedLine(commitLines).detail).not.toContain(control);
      }
    });
  });
});

describe('runDoctor CI runner slots (OG-28c)', () => {
  const SLOTS = [
    { name: 'slot-1', unit: 'fleet-ci@1.service' },
    { name: 'slot-2', unit: 'fleet-ci@2.service' },
  ];
  const localModel = () => sampleModel({ host: { ciRunnerSlots: SLOTS } });
  const sshModel = () =>
    sampleModel({ host: { transport: 'ssh', sshAlias: 'ci-alias', ciRunnerSlots: SLOTS } });
  const slotLines = (lines: readonly DoctorLine[]) =>
    lines.filter((doctorLine) => doctorLine.check.startsWith('ci-runner-'));
  const answering = (value: unknown) =>
    (async () => value) as unknown as NonNullable<DoctorProbes['ciRunnerSlot']>;

  it('reports PASS for each active slot in declared order after the host\'s own lines', async () => {
    const recorded: string[] = [];
    const { probes } = fakeProbes({
      ciRunnerSlot: async (host, unit) => {
        recorded.push(`ciRunnerSlot:${host}:${unit}`);
        return 'active';
      },
    });
    const lines = await collect(loadedResult(localModel()), probes);
    expect(slotLines(lines)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-1',
        status: 'PASS',
        detail: 'slot slot-1 active',
      },
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-2',
        status: 'PASS',
        detail: 'slot slot-2 active',
      },
    ]);
    expect(recorded).toEqual([
      'ciRunnerSlot:local:fleet-ci@1.service',
      'ciRunnerSlot:local:fleet-ci@2.service',
    ]);
    const runnerCapabilities = lines.findIndex(
      (doctorLine) => doctorLine.subject === 'main' && doctorLine.check === 'runner-capabilities',
    );
    const firstSlot = lines.findIndex((doctorLine) => doctorLine.check === 'ci-runner-slot-1');
    const firstVerifier = lines.findIndex((doctorLine) => doctorLine.subject === 'verifier-host');
    expect(firstSlot).toBeGreaterThan(runnerCapabilities);
    expect(firstSlot).toBeLessThan(firstVerifier);
  });

  it('reports FAIL with the slot name and the fix line for an inactive slot and exits 1', async () => {
    const recordedHosts: string[] = [];
    const { probes } = fakeProbes({
      ciRunnerSlot: async (host, unit) => {
        recordedHosts.push(host);
        return unit === 'fleet-ci@2.service' ? 'inactive' : 'active';
      },
    });
    const lines = await collect(loadedResult(sshModel()), probes);
    expect(slotLines(lines)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-1',
        status: 'PASS',
        detail: 'slot slot-1 active',
      },
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-2',
        status: 'FAIL',
        detail: 'slot slot-2 not active; fix: sudo systemctl restart fleet-ci@2.service on ci-alias',
      },
    ]);
    expect(recordedHosts).toEqual(['ci-alias', 'ci-alias']);
    expect(doctorExitCode(slotLines(lines))).toBe(1);
  });

  it('reports UNKNOWN when the slot probe throws, rejects or answers unknown', async () => {
    const throwingSync = () => {
      throw new Error('boom');
    };
    const throwingAsync = async () => {
      throw new Error('boom');
    };
    for (const probe of [
      throwingSync as unknown as NonNullable<DoctorProbes['ciRunnerSlot']>,
      throwingAsync,
      (async () => 'unknown') as NonNullable<DoctorProbes['ciRunnerSlot']>,
    ]) {
      const { probes } = fakeProbes({ ciRunnerSlot: probe });
      const lines = await collect(loadedResult(localModel()), probes);
      expect(slotLines(lines)).toEqual([
        {
          scope: 'host',
          subject: 'main',
          check: 'ci-runner-slot-1',
          status: 'UNKNOWN',
          detail: 'slot slot-1 state could not be read',
        },
        {
          scope: 'host',
          subject: 'main',
          check: 'ci-runner-slot-2',
          status: 'UNKNOWN',
          detail: 'slot slot-2 state could not be read',
        },
      ]);
      expect(doctorExitCode(slotLines(lines))).toBe(1);
    }
  });

  it('reports UNKNOWN for any answer that is not exactly active or inactive', async () => {
    const sentinel = ['sentinel', 'value', '7f3a'].join('-');
    for (const value of [
      undefined,
      null,
      'ACTIVE',
      'active\n',
      ' inactive',
      1,
      true,
      {},
      ['active'],
      sentinel,
      new Proxy({}, { get() { throw new Error('trap'); } }),
      { then() { throw new Error('then'); } },
    ]) {
      const { probes } = fakeProbes({ ciRunnerSlot: answering(value) });
      const lines = await collect(loadedResult(localModel()), probes);
      expect(slotLines(lines)).toEqual([
        {
          scope: 'host',
          subject: 'main',
          check: 'ci-runner-slot-1',
          status: 'UNKNOWN',
          detail: 'slot slot-1 state could not be read',
        },
        {
          scope: 'host',
          subject: 'main',
          check: 'ci-runner-slot-2',
          status: 'UNKNOWN',
          detail: 'slot slot-2 state could not be read',
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(sentinel);
    }
  });

  it('reports UNKNOWN per configured slot when the probes carry no ciRunnerSlot', async () => {
    const missing = await collect(loadedResult(localModel()), fakeProbes().probes);
    expect(slotLines(missing)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-1',
        status: 'UNKNOWN',
        detail: 'slot slot-1 probe not available',
      },
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-2',
        status: 'UNKNOWN',
        detail: 'slot slot-2 probe not available',
      },
    ]);

    const notAFunction = await collect(
      loadedResult(localModel()),
      fakeProbes({ ciRunnerSlot: 'nope' as unknown as DoctorProbes['ciRunnerSlot'] }).probes,
    );
    expect(slotLines(notAFunction)).toEqual(slotLines(missing));

    const hostile = {
      ...fakeProbes().probes,
      get ciRunnerSlot(): never {
        throw new Error('getter boom');
      },
    } as unknown as DoctorProbes;
    const getterLines = await collect(loadedResult(localModel()), hostile);
    expect(slotLines(getterLines)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-1',
        status: 'UNKNOWN',
        detail: 'slot slot-1 state could not be read',
      },
      {
        scope: 'host',
        subject: 'main',
        check: 'ci-runner-slot-2',
        status: 'UNKNOWN',
        detail: 'slot slot-2 state could not be read',
      },
    ]);
  });

  it('emits no ci-runner line and never calls the probe for a host without slots', async () => {
    const recorded: string[] = [];
    const recording = fakeProbes({
      ciRunnerSlot: async (host, unit) => {
        recorded.push(`ciRunnerSlot:${host}:${unit}`);
        return 'active';
      },
    }).probes;
    for (const model of [sampleModel(), sampleModel({ host: { ciRunnerSlots: [] } })]) {
      const lines = await collect(loadedResult(model), recording);
      expect(slotLines(lines)).toHaveLength(0);
      expect(recorded).toEqual([]);
      expect(lines).toEqual(await collect(loadedResult(model), fakeProbes().probes));
    }
  });

  it('never carries systemctl output into a DoctorLine (real probe path)', async () => {
    const sentinel = ['sentinel', 'value', '7f3a'].join('-');
    for (const exitCode of [0, 3]) {
      let systemctlRuns = 0;
      const probes = createNodeDoctorProbes({
        localExecutor: {
          async run(argv) {
            if (argv[0] === 'systemctl') {
              systemctlRuns += 1;
              return { exitCode, signal: null, stdout: `inactive ${sentinel}\n`, stderr: sentinel };
            }
            return { exitCode: 0, signal: null, stdout: '', stderr: '' };
          },
        },
      });
      const lines = await collect(loadedResult(localModel()), probes);
      expect(systemctlRuns).toBe(2);
      expect(slotLines(lines)).toHaveLength(2);
      for (const doctorLine of slotLines(lines)) {
        expect(doctorLine.status).toBe('UNKNOWN');
      }
      for (const doctorLine of lines) {
        expect(JSON.stringify(doctorLine)).not.toContain(sentinel);
      }
    }
  });

  it('prints the fix line whole or falls back, never redacted or cut', async () => {
    const FALLBACK =
      'slot not active; fix: sudo systemctl restart <the unit this slot names under ciRunnerSlots> on this host';
    const longUnit = `${['u', 'v', 'w', 'x', 'y', 'z', 'q', 'r'].map((c) => c.repeat(20)).join('.')}.service`;
    const model = sampleModel({
      host: {
        transport: 'ssh',
        sshAlias: 'ci-alias',
        ciRunnerSlots: [
          { name: 'sk-runner-01', unit: 'fleet-ci@1.service' },
          { name: 'slot-2', unit: 'actions-runner-fleet-v2-01.service' },
          { name: 'slot-3', unit: longUnit },
          { name: 'slot-4', unit: 'fleet-ci@4.service' },
        ],
      },
    });
    const { probes } = fakeProbes({ ciRunnerSlot: answering('inactive') });
    const lines = slotLines(await collect(loadedResult(model), probes));
    expect(lines.map((doctorLine) => doctorLine.status)).toEqual(['FAIL', 'FAIL', 'FAIL', 'FAIL']);
    expect(lines.map((doctorLine) => doctorLine.detail)).toEqual([
      FALLBACK,
      FALLBACK,
      FALLBACK,
      'slot slot-4 not active; fix: sudo systemctl restart fleet-ci@4.service on ci-alias',
    ]);
    for (const doctorLine of lines) {
      expect(doctorLine.detail).not.toContain('[redacted]');
      expect(doctorLine.detail.length).toBeLessThan(200);
    }
  });
});

describe('runDoctor login-shell canary (SHP1)', () => {
  const shellLines = (lines: readonly DoctorLine[]) =>
    lines.filter((doctorLine) => doctorLine.check === 'login-shell');
  const hostChecks = (lines: readonly DoctorLine[], subject: string) =>
    lines
      .filter((doctorLine) => doctorLine.scope === 'host' && doctorLine.subject === subject)
      .map((doctorLine) => `${doctorLine.check}:${doctorLine.status}`);
  const answering = (value: unknown) =>
    (async () => value) as unknown as NonNullable<DoctorProbes['loginShell']>;
  const unknownLine = (detail: string) => ({
    scope: 'host',
    subject: 'verifier-host',
    check: 'login-shell',
    status: 'UNKNOWN',
    detail,
  });

  it('reports PASS first among the ssh host lines and no login-shell line for the local host', async () => {
    const { probes } = fakeProbes();
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(shellLines(lines)).toEqual([
      {
        scope: 'host',
        subject: 'verifier-host',
        check: 'login-shell',
        status: 'PASS',
        detail: 'login shell passes sh -c intact via verifier-host',
      },
    ]);
    expect(hostChecks(lines, 'verifier-host')).toEqual([
      'login-shell:PASS',
      'reachable:PASS',
      'command-sh:PASS',
      'command-nc:PASS',
      'command-curl:PASS',
      'command-ssh:PASS',
      'worktree-root-writable:PASS',
    ]);
    expect(doctorExitCode(lines)).toBe(0);
  });

  it('calls the canary before every other probe, once per ssh host and never for a local host', async () => {
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(calls[0]).toBe('loginShell:verifier-host');
    expect(calls.filter((call) => call.startsWith('loginShell:'))).toEqual([
      'loginShell:verifier-host',
    ]);
    expect(lines.length).toBeGreaterThan(0);
    expect(calls.indexOf('serverProbe:local:4096')).toBeGreaterThan(0);
  });

  it('reports FAIL, leaves the host remote lines UNKNOWN and unprobed, and exits 1', async () => {
    const model = sampleModel({
      host: {
        transport: 'ssh',
        sshAlias: 'ci-alias',
        ciRunnerSlots: [{ name: 'slot-1', unit: 'fleet-ci@1.service' }],
      },
    });

    const intactSlotHosts: string[] = [];
    const intact = fakeProbes({
      loginShell: answering('intact'),
      ciRunnerSlot: async (host) => {
        intactSlotHosts.push(host);
        return 'active';
      },
    });
    const intactLines = await collect(loadedResult(model), intact.probes);
    const intactChecks = hostChecks(intactLines, 'main');

    const mangledSlotHosts: string[] = [];
    const mangled = fakeProbes({
      loginShell: async (host) => (host === 'ci-alias' ? 'mangled' : 'intact'),
      ciRunnerSlot: async (host) => {
        mangledSlotHosts.push(host);
        return 'active';
      },
    });
    const lines = await collect(loadedResult(model), mangled.probes);

    expect(hostChecks(lines, 'main')).toEqual([
      'login-shell:FAIL',
      'reachable:UNKNOWN',
      'command-sh:UNKNOWN',
      'command-nc:UNKNOWN',
      'command-curl:UNKNOWN',
      'command-ssh:UNKNOWN',
      'worktree-root-writable:UNKNOWN',
      'runner-capabilities:PASS',
      'gate-slot:PASS',
      'runner-optional:PASS',
      'ci-runner-slot-1:UNKNOWN',
      'disk-quota:UNKNOWN',
      // The runner host's opencode server answer is not gated by the canary
      // (that is SHP1b); it is a host line for `main` and follows the slots.
      'server-answers:PASS',
    ]);
    const mainShellLine = lines.find(
      (doctorLine) => doctorLine.scope === 'host' && doctorLine.subject === 'main' && doctorLine.check === 'login-shell',
    );
    expect(mainShellLine?.detail).toBe(
      "login shell did not return the canary unchanged via ci-alias (it altered sh -c or printed extra output); this host's other lines are not trustworthy",
    );
    for (const doctorLine of lines) {
      if (
        doctorLine.scope === 'host' &&
        doctorLine.subject === 'main' &&
        doctorLine.status === 'UNKNOWN'
      ) {
        expect(doctorLine.detail).toBe('not probed: login shell failed the canary');
      }
    }
    expect(hostChecks(lines, 'main').map((entry) => entry.slice(0, entry.lastIndexOf(':')))).toEqual(
      intactChecks.map((entry) => entry.slice(0, entry.lastIndexOf(':'))),
    );
    expect(
      mangled.calls.filter((call) => /^(hostReachable|commandAvailable|worktreeRootWritable):ci-alias/.test(call)),
    ).toEqual([]);
    expect(mangledSlotHosts).toEqual([]);
    expect(intactSlotHosts).toEqual(['ci-alias']);
    expect(mangled.calls).toContain('hostReachable:verifier-host');
    expect(hostChecks(lines, 'verifier-host')[0]).toBe('login-shell:PASS');
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('reports UNKNOWN and still probes the host when the canary throws, rejects or answers anything but intact or mangled', async () => {
    const throwingSync = () => {
      throw new Error('boom');
    };
    const throwingAsync = async () => {
      throw new Error('boom');
    };
    for (const loginShell of [
      throwingSync as unknown as NonNullable<DoctorProbes['loginShell']>,
      throwingAsync,
      answering('unknown'),
      answering('bogus'),
      answering(null),
      answering(undefined),
      answering(true),
      answering(['intact']),
      answering({ outcome: 'intact' }),
      answering(new String('intact')),
    ]) {
      const { probes, calls } = fakeProbes({ loginShell });
      const lines = await collect(loadedResult(sampleModel()), probes);
      expect(shellLines(lines)).toEqual([unknownLine('login shell could not be checked via verifier-host')]);
      expect(calls).toContain('hostReachable:verifier-host');
      expect(hostChecks(lines, 'verifier-host')[1]).toBe('reachable:PASS');
      expect(doctorExitCode(lines)).toBe(1);
    }
  });

  it('reports UNKNOWN probe-not-available when the probes carry no loginShell or a non-function', async () => {
    const base = fakeProbes();
    const { loginShell: _omitted, ...withoutProbe } = base.probes;
    void _omitted;
    const missing = await collect(loadedResult(sampleModel()), withoutProbe as DoctorProbes);
    expect(shellLines(missing)).toEqual([unknownLine('login shell probe not available')]);
    expect(base.calls).toContain('hostReachable:verifier-host');
    expect(doctorExitCode(missing)).toBe(1);

    const { probes, calls } = fakeProbes({
      loginShell: 'nope' as unknown as DoctorProbes['loginShell'],
    });
    const notAFunction = await collect(loadedResult(sampleModel()), probes);
    expect(shellLines(notAFunction)).toEqual([unknownLine('login shell probe not available')]);
    expect(calls).toContain('hostReachable:verifier-host');
    expect(doctorExitCode(notAFunction)).toBe(1);
  });

  it('reports UNKNOWN when reading the loginShell port throws', async () => {
    const hostile = {
      ...fakeProbes().probes,
      get loginShell(): never {
        throw new Error('getter boom');
      },
    } as unknown as DoctorProbes;
    const lines = await collect(loadedResult(sampleModel()), hostile);
    expect(shellLines(lines)).toEqual([unknownLine('login shell could not be checked via verifier-host')]);
    expect(hostChecks(lines, 'verifier-host')[1]).toBe('reachable:PASS');
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('never carries remote output into a DoctorLine and reports a polluted echo as FAIL (real probe path)', async () => {
    const sentinel = ['sentinel', 'value', '7f3a'].join('-');
    const probes = createNodeDoctorProbes({
      localExecutor: {
        async run() {
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      },
      sshExecutor: {
        async run() {
          return {
            exitCode: 0,
            signal: null,
            stdout: `${sentinel}\n${LOGIN_SHELL_CANARY}`,
            stderr: sentinel,
          };
        },
      },
    });
    const lines = await collect(loadedResult(sampleModel()), probes);
    expect(shellLines(lines)).toHaveLength(1);
    expect(shellLines(lines)[0]?.status).toBe('FAIL');
    expect(hostChecks(lines, 'verifier-host')[1]).toBe('reachable:UNKNOWN');
    for (const doctorLine of lines) {
      expect(JSON.stringify(doctorLine)).not.toContain(sentinel);
    }
  });
});

describe('runDoctor disk quota headroom (OPQ1)', () => {
  const runnerModel = () =>
    sampleModel({
      host: { transport: 'ssh', sshAlias: 'ci-alias' },
    });
  const diskQuotaLines = (lines: readonly DoctorLine[]) =>
    lines.filter(
      (doctorLine) =>
        doctorLine.scope === 'host' &&
        doctorLine.check === 'disk-quota' &&
        doctorLine.subject === 'main',
    );
  const hostChecks = (lines: readonly DoctorLine[], subject: string) =>
    lines
      .filter((doctorLine) => doctorLine.scope === 'host' && doctorLine.subject === subject)
      .map((doctorLine) => `${doctorLine.check}:${doctorLine.status}`);

  it('reports PASS at or above 10% disk-quota headroom and FAIL below 10% naming percentage and host alias', async () => {
    for (const [usage, status, detail] of [
      [{ usedBytes: 900, totalBytes: 1000 }, 'PASS', 'disk quota headroom 10.0% via ci-alias'],
      [{ usedBytes: 0, totalBytes: 1000 }, 'PASS', 'disk quota headroom 100.0% via ci-alias'],
      [{ usedBytes: 9001, totalBytes: 10000 }, 'FAIL', 'disk quota headroom 9.9% below 10% minimum via ci-alias'],
      [{ usedBytes: 1000, totalBytes: 1000 }, 'FAIL', 'disk quota headroom 0.0% below 10% minimum via ci-alias'],
    ] as const) {
      const { probes } = fakeProbes({ diskQuotaUsage: async () => usage });
      const lines = await collect(loadedResult(runnerModel()), probes);
      expect(diskQuotaLines(lines)).toEqual([
        {
          scope: 'host',
          subject: 'main',
          check: 'disk-quota',
          status,
          detail,
        },
      ]);
    }
  });

  it('emits no disk-quota line for a local host or an ssh host without a runner', async () => {
    const noRunner: HostModel = {
      transport: 'ssh',
      sshAlias: 'ci-alias',
      roles: ['verifier'],
    };
    const models: FleetInstallationModel[] = [
      sampleModel(),
      sampleModel({ host: { transport: 'local' } }),
      sampleModel({ host: { runner: undefined } }),
      { ...runnerModel(), hosts: { main: noRunner } },
    ];
    for (const model of models) {
      const { probes, calls } = fakeProbes();
      const lines = await collect(loadedResult(model), probes);
      expect(lines.some((doctorLine) => doctorLine.check === 'disk-quota')).toBe(false);
      expect(calls.some((call) => call.startsWith('diskQuotaUsage:'))).toBe(false);
    }
  });

  it('reports UNKNOWN for disk-quota when the probe returns undefined', async () => {
    const { probes } = fakeProbes({ diskQuotaUsage: async () => undefined });
    const lines = await collect(loadedResult(runnerModel()), probes);
    expect(diskQuotaLines(lines)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'disk-quota',
        status: 'UNKNOWN',
        detail: 'disk quota could not be read via ci-alias',
      },
    ]);
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('reports UNKNOWN when diskQuotaUsage returns null, undefined, an array, an array-like, or a wrong primitive', async () => {
    for (const answer of [
      null,
      undefined,
      [],
      [100, 1000],
      // An array-like passes typeof 'object' but is refused all the same.
      { 0: 1, 1: 10, length: 2, usedBytes: 1, totalBytes: 10 },
      // An own `length` accessor is refused too, and its getter is never run.
      Object.defineProperty({ usedBytes: 1, totalBytes: 10 }, 'length', {
        get: () => {
          throw new Error('length getter must not run');
        },
        enumerable: true,
      }),
      Object.defineProperty({ usedBytes: 1, totalBytes: 10 }, 'length', { get: () => 2 }),
      { usedBytes: 1, totalBytes: 10, length: '2' },
      '100 1000',
      42,
      true,
      // An inherited (prototype-only) reading is not an own observation.
      Object.assign(Object.create({ usedBytes: 100, totalBytes: 1000 }), {}),
      Object.create({ usedBytes: 1, totalBytes: 10 }),
    ]) {
      const { probes } = fakeProbes({
        diskQuotaUsage: async () => answer as { usedBytes: number; totalBytes: number },
      });
      const lines = await collect(loadedResult(runnerModel()), probes);
      expect(diskQuotaLines(lines)).toEqual([
        {
          scope: 'host',
          subject: 'main',
          check: 'disk-quota',
          status: 'UNKNOWN',
          detail: 'disk quota could not be read via ci-alias',
        },
      ]);
    }
  });

  it('reports UNKNOWN, never PASS or WARN, for a negative, fractional, NaN, infinite, unsafe, zero-total or used-above-total answer', async () => {
    for (const answer of [
      { usedBytes: -100, totalBytes: 1000 },
      { usedBytes: 0.5, totalBytes: 1 },
      { usedBytes: Number.NaN, totalBytes: 1000 },
      { usedBytes: 1, totalBytes: Number.NaN },
      { usedBytes: 1, totalBytes: Number.MAX_SAFE_INTEGER + 2 },
      { usedBytes: 10, totalBytes: 0 },
      { usedBytes: 2000, totalBytes: 1000 },
      { usedBytes: 1, totalBytes: Number.POSITIVE_INFINITY },
      { usedBytes: Number.NEGATIVE_INFINITY, totalBytes: 1000 },
    ]) {
      const { probes } = fakeProbes({ diskQuotaUsage: async () => answer });
      const lines = await collect(loadedResult(runnerModel()), probes);
      expect(diskQuotaLines(lines)).toEqual([
        {
          scope: 'host',
          subject: 'main',
          check: 'disk-quota',
          status: 'UNKNOWN',
          detail: 'disk quota could not be read via ci-alias',
        },
      ]);
    }
  });

  it('reports UNKNOWN without invoking getters when diskQuotaUsage or its result has a throwing or side-effecting getter', async () => {
    const sideEffects: string[] = [];
    const resultWithGetter = {
      get usedBytes(): number {
        sideEffects.push('usedBytes');
        throw new Error('boom');
      },
      totalBytes: 1000,
    };
    const probesWithThrowingResult = fakeProbes({
      diskQuotaUsage: async () => resultWithGetter,
    });
    const lines = await collect(loadedResult(runnerModel()), probesWithThrowingResult.probes);
    expect(sideEffects).toEqual([]);
    expect(diskQuotaLines(lines)[0]?.status).toBe('UNKNOWN');
    expect(doctorExitCode(lines)).toBe(1);

    const probeReads: string[] = [];
    const hostile = {
      ...fakeProbes().probes,
      get diskQuotaUsage(): never {
        probeReads.push('probe');
        throw new Error('boom');
      },
    } as unknown as DoctorProbes;
    const hostileLines = await collect(loadedResult(runnerModel()), hostile);
    // The port property is read through its own descriptor, so the throwing
    // getter is refused without ever being invoked; the result is UNKNOWN.
    expect(probeReads).toEqual([]);
    expect(diskQuotaLines(hostileLines)[0]?.status).toBe('UNKNOWN');
  });

  it('reports UNKNOWN when diskQuotaUsage returns a throwing Proxy', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
        has() {
          throw new Error('boom');
        },
      },
    );
    const { probes } = fakeProbes({
      diskQuotaUsage: async () => hostile as { usedBytes: number; totalBytes: number },
    });
    const lines = await collect(loadedResult(runnerModel()), probes);
    expect(diskQuotaLines(lines)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'disk-quota',
        status: 'UNKNOWN',
        detail: 'disk quota could not be read via ci-alias',
      },
    ]);
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('reports UNKNOWN when diskQuotaUsage probe is absent or not a function', async () => {
    const base = fakeProbes();
    const { diskQuotaUsage: _omitted, ...withoutProbe } = base.probes;
    void _omitted;
    const missing = await collect(loadedResult(runnerModel()), withoutProbe as DoctorProbes);
    expect(diskQuotaLines(missing)).toEqual([
      {
        scope: 'host',
        subject: 'main',
        check: 'disk-quota',
        status: 'UNKNOWN',
        detail: 'disk quota probe not available',
      },
    ]);
    expect(doctorExitCode(missing)).toBe(1);

    const { probes, calls } = fakeProbes({
      diskQuotaUsage: 'nope' as unknown as DoctorProbes['diskQuotaUsage'],
    });
    const notAFunction = await collect(loadedResult(runnerModel()), probes);
    expect(diskQuotaLines(notAFunction)[0]?.detail).toBe('disk quota probe not available');
    expect(calls.some((call) => call.startsWith('diskQuotaUsage:'))).toBe(false);
  });

  it('never echoes raw probe output in disk-quota details', async () => {
    const sentinel = ['sentinel', 'quota', '9f2c'].join('-');
    const { probes } = fakeProbes({
      diskQuotaUsage: async () => sentinel as unknown as { usedBytes: number; totalBytes: number },
    });
    const lines = await collect(loadedResult(runnerModel()), probes);
    expect(diskQuotaLines(lines)[0]?.status).toBe('UNKNOWN');
    for (const doctorLine of lines) {
      expect(JSON.stringify(doctorLine)).not.toContain(sentinel);
    }
  });

  it('masks an unsafe ssh alias on disk-quota lines', async () => {
    const alias = 'bad host';
    const model = sampleModel({ host: { transport: 'ssh', sshAlias: alias } });
    const { probes, calls } = fakeProbes();
    const lines = await collect(loadedResult(model), probes);
    expect(diskQuotaLines(lines)[0]?.detail).toBe(
      'disk quota headroom 90.0% via [unsafe ssh alias]',
    );
    expect(calls).toContain(`diskQuotaUsage:${alias}`);
  });

  it('skips disk-quota with the same check name when the login shell fails the canary', async () => {
    const model = sampleModel({
      host: {
        transport: 'ssh',
        sshAlias: 'ci-alias',
        ciRunnerSlots: [{ name: 'slot-1', unit: 'fleet-ci@1.service' }],
      },
    });
    const mangled = fakeProbes({
      loginShell: async (host) => (host === 'ci-alias' ? 'mangled' : 'intact'),
    });
    const lines = await collect(loadedResult(model), mangled.probes);
    expect(mangled.calls.some((call) => call.startsWith('diskQuotaUsage:'))).toBe(false);
    expect(hostChecks(lines, 'main')).toContain('disk-quota:UNKNOWN');
    expect(hostChecks(lines, 'main').indexOf('disk-quota:UNKNOWN')).toBe(
      hostChecks(lines, 'main').indexOf('ci-runner-slot-1:UNKNOWN') + 1,
    );
    const diskQuota = lines.find(
      (doctorLine) => doctorLine.subject === 'main' && doctorLine.check === 'disk-quota',
    );
    expect(diskQuota?.detail).toBe('not probed: login shell failed the canary');
  });
});

describe('runDoctor refused ssh alias (SD6c3)', () => {
  const ALIAS = 'evil\u001b[31malias';
  const REFUSED = 'ssh alias refused: not a safe host string; no command was run on this host';
  const refusedModel = () =>
    sampleModel({
      host: {
        transport: 'ssh',
        sshAlias: ALIAS,
        ciRunnerSlots: [{ name: 'slot-1', unit: 'fleet-ci@1.service' }],
      },
    });
  const detailOf = (lines: readonly DoctorLine[], subject: string, check: string) =>
    lines.find((doctorLine) => doctorLine.subject === subject && doctorLine.check === check);

  it('says the alias was refused and never prints it', async () => {
    const reached: string[] = [];
    const { probes } = fakeProbes({
      hostReachable: async (host) => {
        reached.push(host);
        return host !== ALIAS;
      },
      loginShell: async (host) => (host === ALIAS ? 'unknown' : 'intact'),
      ciRunnerSlot: async () => 'inactive',
    });
    const lines = await collect(loadedResult(refusedModel()), probes);
    expect(detailOf(lines, 'main', 'login-shell')).toEqual({
      scope: 'host',
      subject: 'main',
      check: 'login-shell',
      status: 'UNKNOWN',
      detail: 'login shell could not be checked via [unsafe ssh alias]',
    });
    expect(detailOf(lines, 'main', 'reachable')).toEqual({
      scope: 'host',
      subject: 'main',
      check: 'reachable',
      status: 'FAIL',
      detail: REFUSED,
    });
    expect(detailOf(lines, 'main', 'ci-runner-slot-1')).toEqual({
      scope: 'host',
      subject: 'main',
      check: 'ci-runner-slot-1',
      status: 'FAIL',
      detail: 'slot slot-1 not active; fix: sudo systemctl restart fleet-ci@1.service on [unsafe ssh alias]',
    });
    expect(detailOf(lines, 'verifier-host', 'reachable')?.detail).toBe(
      'reachable via verifier-host (roles: verifier)',
    );
    expect(JSON.stringify(lines)).not.toContain('evil');
    expect(reached).toContain(ALIAS);
    expect(doctorExitCode(lines)).toBe(1);
  });

  it('hides a refused alias on the reachable, probe-failed, intact and mangled texts too', async () => {
    const run1 = fakeProbes();
    const lines1 = await collect(loadedResult(refusedModel()), run1.probes);
    expect(detailOf(lines1, 'main', 'reachable')?.detail).toBe(
      'reachable via [unsafe ssh alias] (roles: orchestrator, lane-runner)',
    );
    expect(detailOf(lines1, 'main', 'login-shell')?.detail).toBe(
      'login shell passes sh -c intact via [unsafe ssh alias]',
    );
    expect(JSON.stringify(lines1)).not.toContain('evil');

    const run2 = fakeProbes({
      hostReachable: async () => {
        throw new Error('boom');
      },
    });
    const lines2 = await collect(loadedResult(refusedModel()), run2.probes);
    expect(detailOf(lines2, 'main', 'reachable')?.status).toBe('UNKNOWN');
    expect(detailOf(lines2, 'main', 'reachable')?.detail).toBe(
      'reachability probe failed ([unsafe ssh alias])',
    );
    expect(JSON.stringify(lines2)).not.toContain('evil');

    const run3 = fakeProbes({
      loginShell: async (host) => (host === ALIAS ? 'mangled' : 'intact'),
    });
    const lines3 = await collect(loadedResult(refusedModel()), run3.probes);
    expect(detailOf(lines3, 'main', 'login-shell')?.status).toBe('FAIL');
    expect(detailOf(lines3, 'main', 'login-shell')?.detail).toBe(
      "login shell did not return the canary unchanged via [unsafe ssh alias] (it altered sh -c or printed extra output); this host's other lines are not trustworthy",
    );
    expect(detailOf(lines3, 'main', 'reachable')?.status).toBe('UNKNOWN');
    expect(detailOf(lines3, 'main', 'reachable')?.detail).toBe(
      'not probed: login shell failed the canary',
    );
    expect(JSON.stringify(lines3)).not.toContain('evil');
  });

  it('keeps a safe alias and a local host byte-identical', async () => {
    const unreachable = fakeProbes({
      hostReachable: async (host) => host !== 'verifier-host',
    });
    const lines1 = await collect(loadedResult(sampleModel()), unreachable.probes);
    expect(detailOf(lines1, 'verifier-host', 'reachable')?.status).toBe('FAIL');
    expect(detailOf(lines1, 'verifier-host', 'reachable')?.detail).toBe(
      'not reachable via verifier-host',
    );
    expect(detailOf(lines1, 'main', 'reachable')?.detail).toBe(
      'reachable via local (roles: orchestrator, lane-runner)',
    );

    const failing = fakeProbes({
      hostReachable: async () => {
        throw new Error('boom');
      },
    });
    const lines2 = await collect(loadedResult(sampleModel()), failing.probes);
    expect(detailOf(lines2, 'verifier-host', 'reachable')?.detail).toBe(
      'reachability probe failed (verifier-host)',
    );

    const userAlias = fakeProbes();
    const lines3 = await collect(
      loadedResult(sampleModel({ host: { transport: 'ssh', sshAlias: 'user@lane-1.example' } })),
      userAlias.probes,
    );
    expect(detailOf(lines3, 'main', 'reachable')?.detail).toBe(
      'reachable via user@lane-1.example (roles: orchestrator, lane-runner)',
    );
    expect(detailOf(lines3, 'main', 'login-shell')?.detail).toBe(
      'login shell passes sh -c intact via user@lane-1.example',
    );
  });

  it('spawns nothing with a refused alias and reports it refused (real probe path)', async () => {
    const argvs: Array<readonly string[]> = [];
    const probes = createNodeDoctorProbes({
      localExecutor: {
        async run(argv) {
          argvs.push(argv);
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      },
    });
    const lines = await collect(loadedResult(refusedModel()), probes);
    expect(detailOf(lines, 'main', 'reachable')).toEqual({
      scope: 'host',
      subject: 'main',
      check: 'reachable',
      status: 'FAIL',
      detail: REFUSED,
    });
    expect(detailOf(lines, 'main', 'login-shell')?.status).toBe('UNKNOWN');
    expect(argvs.some((argv) => argv.some((word) => word.includes('evil')))).toBe(false);
    expect(JSON.stringify(lines)).not.toContain('evil');
  });
});
