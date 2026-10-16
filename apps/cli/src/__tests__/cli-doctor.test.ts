/**
 * `fleet-v2 doctor` against a fake installation and fake probes: output
 * shape (one line per doctor check, JSON documents with --json) and the
 * doctor exit-code contract (0 all PASS, 1 any FAIL/UNKNOWN and also a
 * missing or invalid installation, 2 usage).
 */

import { describe, expect, it } from 'vitest';

import type { FleetInstallationModel } from '@fleet/installation';
import type { DoctorLine, DoctorProbes } from '@fleet/onboarding';

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
