import { describe, expect, it } from 'vitest';

import type {
  FleetInstallationModel,
  HostModel,
  SeatModel,
} from '@fleet/installation';

import type { DoctorProbes, SeatProbeResult } from '../probes.js';
import type { DoctorLine } from '../types.js';
import { doctorExitCode, runDoctor } from '../run-doctor.js';
import type {
  DoctorableInstallation,
  RunDoctorOptions,
} from '../run-doctor.js';
import { createNodeDoctorProbes } from '../probes-node.js';

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
    seatProbe: async (seat) => {
      calls.push(`seatProbe:${seat.id}`);
      return ALL_SEATS_PASS;
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
      'claude',
      '--version',
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
      seatProbe: async () => {
        throw new Error('seat exploded');
      },
    };
    const { probes } = fakeProbes(throwing);
    const lines = await collect(loadedResult(model), probes);

    expect(lines.length).toBeGreaterThan(0);
    // The only lines that do not depend on a throwing probe are the schema
    // line, the runner capability declaration and the free-tier policy line
    // (all derived, not probed).
    const expectedUnknown = lines.filter(
      (line) =>
        line.check !== 'schema-version' &&
        line.check !== 'runner-capabilities' &&
        line.check !== 'free-tier' &&
        line.check !== 'auto-merge',
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
    expect(firstIndex('runner-binary')).toBeLessThan(firstIndex('seat'));
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
