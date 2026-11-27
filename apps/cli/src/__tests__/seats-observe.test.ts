// Lane SR6: `fleet-v2 seats observe` — the command layer only. The recorder
// is injected (the composed runtime supplies the real one), so these tests
// assert the flag rules, the exit codes and the JSON output.

import { describe, expect, it } from 'vitest';
import type {
  RecordSeatObservationPort,
  RecordSeatObservationResult,
} from '@fleet/work-execution';

import { runCli, type CliIo } from '../index.js';
import type { SeatsCliOptions } from '../seats.js';

function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

interface RecorderCall {
  readonly input: unknown;
  readonly via: string;
  readonly options?: { readonly dryRun?: boolean };
}

function recorder(result: RecordSeatObservationResult): {
  calls: RecorderCall[];
  options: SeatsCliOptions;
} {
  const calls: RecorderCall[] = [];
  const port: RecordSeatObservationPort = {
    execute: async (input, via, options) => {
      calls.push({ input, via, options });
      return result;
    },
  };
  return { calls, options: { recordSeatObservation: port } };
}

const recorded: RecordSeatObservationResult = {
  outcome: 'recorded',
  observation: {
    version: 1,
    observationId: 'obs-1',
    seatId: 'seat-a',
    outcome: 'rate-limited',
    observedAtIso: '2026-11-27T10:00:00.000Z',
    subject: { attemptId: 'att-1' },
    via: 'cli',
  },
  cooling: false,
};

const refused: RecordSeatObservationResult = {
  outcome: 'refused',
  code: 'seat-mismatch',
  reason: 'the attempt was committed to another seat',
};

const happyArgv = [
  'seats',
  'observe',
  '--seat',
  'seat-a',
  '--outcome',
  'rate-limited',
  '--attempt',
  'att-1',
];

describe('seats observe', () => {
  it('records through the injected recorder and prints the result JSON', async () => {
    const { io, stdout, stderr } = mockIo();
    const fake = recorder(recorded);
    const code = await runCli(happyArgv, io, undefined, undefined, undefined, undefined, fake.options);
    expect(code).toBe(0);
    expect(stderr).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      via: 'cli',
      options: { dryRun: false },
      input: {
        seatId: 'seat-a',
        outcome: 'rate-limited',
        subject: { attemptId: 'att-1' },
      },
    });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(recorded);
  });

  it('passes --dry-run through and writes nothing', async () => {
    const { io, stdout } = mockIo();
    const fake = recorder({
      outcome: 'dry-run',
      observation: recorded.observation,
      wouldCool: true,
      duplicate: false,
    });
    const code = await runCli(
      [...happyArgv, '--dry-run'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      fake.options,
    );
    expect(code).toBe(0);
    expect(fake.calls[0]?.options).toEqual({ dryRun: true });
    expect(JSON.parse(stdout[0])).toMatchObject({ outcome: 'dry-run' });
  });

  it('sends --review-request subjects and extra flags through', async () => {
    const { io } = mockIo();
    const fake = recorder(recorded);
    const code = await runCli(
      [
        'seats',
        'observe',
        '--seat=rev-a',
        '--outcome=timeout',
        '--review-request=req-1',
        '--observation-id=obs-9',
        '--observed-at=2026-11-27T09:00:00.000Z',
      ],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      fake.options,
    );
    expect(code).toBe(0);
    expect(fake.calls[0]).toMatchObject({
      input: {
        seatId: 'rev-a',
        outcome: 'timeout',
        subject: { reviewRequestId: 'req-1' },
        observationId: 'obs-9',
        observedAtIso: '2026-11-27T09:00:00.000Z',
      },
    });
  });

  it('exits 1 for a refused observation', async () => {
    const { io, stdout } = mockIo();
    const fake = recorder(refused);
    const code = await runCli(happyArgv, io, undefined, undefined, undefined, undefined, fake.options);
    expect(code).toBe(1);
    expect(JSON.parse(stdout[0])).toEqual(refused);
  });

  it('answers help without touching the recorder', async () => {
    const { io, stdout } = mockIo();
    const fake = recorder(recorded);
    const code = await runCli(
      ['seats', 'observe', '--help'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      fake.options,
    );
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(stdout.join()).toContain('Usage: fleet-v2 seats observe');
  });

  it('exits 2 for conflicting, missing and unknown flags', async () => {
    for (const argv of [
      ['seats', 'observe', '--seat', 'seat-a', '--outcome', 'rate-limited',
        '--attempt', 'att-1', '--review-request', 'req-1'],
      ['seats', 'observe', '--outcome', 'rate-limited', '--attempt', 'att-1'],
      ['seats', 'observe', '--seat', 'seat-a', '--attempt', 'att-1'],
      ['seats', 'observe', '--seat', 'seat-a', '--outcome', 'rate-limited',
        '--attempt', 'att-1', '--bogus'],
      ['seats', 'observe', '--seat', 'seat-a', '--outcome'],
      ['seats', 'observe'],
    ]) {
      const { io, stdout, stderr } = mockIo();
      const fake = recorder(recorded);
      const code = await runCli(argv, io, undefined, undefined, undefined, undefined, fake.options);
      expect(code).toBe(2);
      expect(stdout).toHaveLength(0);
      expect(stderr.join()).toContain('Usage: fleet-v2 seats observe');
      expect(fake.calls).toHaveLength(0);
    }
  });
});
