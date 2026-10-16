/**
 * The bounding boundary of the doctor engine: every detail a probe
 * implementation returns reaches a doctor line as a single line of at most
 * 200 characters with secret-shaped strings replaced by `[redacted]`. The
 * boundary lives in `runDoctor`'s line construction, so it applies to every
 * probe implementation, not just the node probes.
 */

import { describe, expect, it } from 'vitest';

import type { FleetInstallationModel } from '@fleet/installation';

import type { DoctorProbes, SeatProbeResult } from '../probes.js';
import type { DoctorLine } from '../types.js';
import { boundDoctorDetail, doctorExitCode, runDoctor } from '../run-doctor.js';
import { redactSecretShapes } from '../run-doctor.js';

const ABSENT_MODEL = {
  schemaVersion: 2 as const,
  hosts: {},
};

const ABSENT_RESULT = {
  status: 'absent' as const,
  installation: { schemaVersion: 2 as const },
  model: ABSENT_MODEL,
  warnings: [],
};

/** A model with one seat whose probe returns the given (poisoned) reason. */
function seatModel(reason: string): DoctorProbes {
  const result: SeatProbeResult = { outcome: 'pass', reason };
  return {
    hostReachable: async () => true,
    commandAvailable: async () => true,
    toolVersion: async () => undefined,
    fileMode: async () => 0o600,
    worktreeRootWritable: async () => true,
    ocmRunBinary: async () => ({
      path: '/repo/bin/ocm-run',
      sha256: 'c'.repeat(64),
    }),
    expectedOcmRunHash: async () => 'c'.repeat(64),
    seatProbe: async () => result,
  };
}

async function collect(
  model: FleetInstallationModel,
  probes: DoctorProbes,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for await (const line of runDoctor(
    { ...ABSENT_RESULT, model, warnings: [] },
    probes,
    { probeSeats: true },
  )) {
    lines.push(line);
  }
  return lines;
}

describe('boundDoctorDetail', () => {
  it('folds newlines and tabs into a single line', () => {
    expect(boundDoctorDetail('first\r\nsecond\n\nthird\tvalue')).toBe(
      'first second third value',
    );
  });

  it('redacts vendor token shapes and Bearer headers', () => {
    expect(redactSecretShapes('key sk-abcdefghijklmnop1234 done')).toBe(
      'key [redacted] done',
    );
    expect(redactSecretShapes('ghp_0123456789abcdefghij rest')).toBe(
      '[redacted] rest',
    );
    expect(redactSecretShapes('ghs_zzzzzzzzzz tail')).toBe('[redacted] tail');
    expect(redactSecretShapes('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: [redacted]',
    );
  });

  it('redacts generic token-like strings of standing length', () => {
    expect(redactSecretShapes('id abcdefghijklmnopqrstuvwxyz ok')).toBe(
      'id [redacted] ok',
    );
  });

  it('keeps the sha256 pair the runner-binary check reports', () => {
    const hash = '5'.repeat(64);
    const expected = 'a'.repeat(64);
    const detail = `/repo/bin/ocm-run sha256 ${hash} does not match expected ${expected}`;
    expect(boundDoctorDetail(detail)).toBe(detail);
  });

  it('still redacts a standing token not behind the sha256 labels', () => {
    const hash = '5'.repeat(64);
    expect(redactSecretShapes(`token ${hash} end`)).toBe('token [redacted] end');
  });

  it('truncates to at most 200 characters after folding and redaction', () => {
    const detail = 'word '.repeat(50);
    expect(boundDoctorDetail(detail)).toHaveLength(200);
  });

  it('leaves ordinary bounded details unchanged', () => {
    expect(boundDoctorDetail('/repo/bin/ocm-run writable')).toBe(
      '/repo/bin/ocm-run writable',
    );
  });
});

describe('runDoctor bounding', () => {
  it('bounds the seat probe reason before it reaches a line', async () => {
    const hash = 'b'.repeat(64);
    const reason = `leak sk-abcdefghijklmnop1234\nsecond line ${hash}`;
    const probes = seatModel(reason);
    const lines = await collect(
      {
        ...ABSENT_MODEL,
        seats: [
          {
            id: 'seat-1',
            tool: 'claude-code',
            model: 'glm-5.3',
            roles: ['implementer'],
          },
        ],
      },
      probes,
    );
    const seatLine = lines.find((entry) => entry.scope === 'seat');
    expect(seatLine).toBeDefined();
    expect(seatLine?.status).toBe('PASS');
    expect(seatLine?.detail).not.toMatch(/sk-/);
    expect(seatLine?.detail).not.toContain('\n');
    expect(seatLine?.detail.length).toBeLessThanOrEqual(200);
    // The bounded detail must not carry the probe's secret shape text.
    expect(seatLine?.detail).toContain('[redacted]');
  });

  it('keeps every seat line within the bound for a long poisoned reason', async () => {
    const probes = seatModel('z'.repeat(500));
    const lines = await collect(
      {
        ...ABSENT_MODEL,
        seats: [
          {
            id: 'seat-1',
            tool: 'claude-code',
            model: 'glm-5.3',
            roles: ['implementer'],
          },
        ],
      },
      probes,
    );
    const seatLine = lines.find((entry) => entry.scope === 'seat');
    expect(seatLine?.detail.length).toBeLessThanOrEqual(200);
    expect(doctorExitCode(lines)).toBe(0);
  });
});
