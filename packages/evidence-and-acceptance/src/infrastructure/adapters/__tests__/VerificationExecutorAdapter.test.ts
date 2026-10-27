// VerificationExecutorAdapter: argv construction for allow-listed checks,
// ssh transport quoting, fail-closed mapping of completed outcomes, and
// bounded output summaries. Uses the spawn seam except for one real process.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { VerificationExecutorAdapter } from '../VerificationExecutorAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';
import type {
  SpawnedVerificationOutcome,
  SpawnVerificationTransport,
  VerificationExecutorOptions,
} from '../VerificationExecutorAdapter.adapter.js';
import type { ExecuteVerificationCheckRequest } from '../../../application/ports/out/VerificationExecutorPort.out-port.js';

const HEAD = '1111111111111111111111111111111111111111';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_SUMMARY_LIMIT = 4000;

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), 'fleet-verification-'));
  temporaryDirectories.push(created);
  return created;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0, temporaryDirectories.length)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function checkRequest(
  overrides: Partial<ExecuteVerificationCheckRequest> = {},
): ExecuteVerificationCheckRequest {
  return { hostId: 'verify-1', candidateHeadSha: HEAD, procedureName: 'ci', ...overrides };
}

interface RecordedSpawn {
  file: string;
  args: readonly string[];
  options: { timeout: number };
}

function recordingTransport(
  calls: RecordedSpawn[],
  outcome: SpawnedVerificationOutcome,
): SpawnVerificationTransport {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return outcome;
  };
}

function completed(status: number, stdout = '', stderr = ''): SpawnedVerificationOutcome {
  return { status, signal: null, stdout, stderr };
}

describe('VerificationExecutorAdapter', () => {
  it('never spawns when the procedure has no allow-listed command', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      spawn: recordingTransport(calls, completed(0)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBeNull();
    expect(result.outputSummary).toContain('no allow-listed verification command');
    expect(calls).toHaveLength(0);
  });

  it('runs a string entry as command with only the candidate sha appended', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport(calls, completed(0, 'all good\n')),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result).toMatchObject({ result: 'pass', exitCode: 0 });
    expect(result.outputSummary).toContain('all good');
    expect(calls).toEqual([
      { file: '/opt/verify-run.sh', args: [HEAD], options: { timeout: DEFAULT_TIMEOUT_MS } },
    ]);
  });

  it('runs an object entry with its fixed args before the candidate sha', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: {
        ci: { command: '/opt/verify-run.sh', args: ['--profile', 'ci'] },
      },
      spawn: recordingTransport(calls, completed(0)),
    });

    await adapter.executeVerificationCheck(checkRequest());

    expect(calls).toEqual([
      {
        file: '/opt/verify-run.sh',
        args: ['--profile', 'ci', HEAD],
        options: { timeout: DEFAULT_TIMEOUT_MS },
      },
    ]);
  });

  it('runs over ssh, quoting every remote word as one POSIX argument', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: {
        ci: { command: '/opt/verify run.sh', args: ["it's a test"] },
      },
      sshHost: 'verify.internal',
      timeoutMs: 5000,
      spawn: recordingTransport(calls, completed(0)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('pass');
    expect(calls).toEqual([
      {
        file: 'ssh',
        args: [
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=15',
          'verify.internal',
          '--',
          "'/opt/verify run.sh'",
          "'it'\\''s a test'",
          `'${HEAD}'`,
        ],
        options: { timeout: 5000 },
      },
    ]);
  });

  it('maps exit code 1 to fail and keeps the check output', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport([], completed(1, 'checks ran\n', 'boom\n')),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('fail');
    expect(result.exitCode).toBe(1);
    expect(result.outputSummary).toContain('checks ran');
    expect(result.outputSummary).toContain('boom');
  });

  it('maps ssh exiting 255 to unknown rather than trusting the check ran', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      sshHost: 'verify.internal',
      spawn: recordingTransport([], completed(255, '', 'ssh: connection refused\n')),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBe(255);
    expect(result.outputSummary).toContain('ssh transport failed with exit code 255');
  });

  it('maps a local check exiting 255 to fail', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport([], completed(255)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('fail');
    expect(result.exitCode).toBe(255);
  });

  it('maps a failed spawn such as ENOENT to unknown and names what failed', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/nonexistent/verify-run.sh' },
      spawn: recordingTransport([], {
        status: null,
        signal: null,
        error: Object.assign(new Error('spawn /nonexistent/verify-run.sh ENOENT'), {
          code: 'ENOENT',
        }),
        stdout: '',
        stderr: '',
      }),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBeNull();
    expect(result.outputSummary).toBe('spawn failed: ENOENT');
  });

  it('maps a process killed by a signal to unknown', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport([], { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBeNull();
    expect(result.outputSummary).toContain('SIGTERM');
  });

  it('maps a missing exit code to unknown', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport([], { status: null, signal: null, stdout: '', stderr: '' }),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBeNull();
    expect(result.outputSummary).toContain('without reporting an exit code');
  });

  it('refuses to spawn for a malformed candidate head sha', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport(calls, completed(0)),
    });

    const notHex = await adapter.executeVerificationCheck(
      checkRequest({ candidateHeadSha: 'not-a-sha' }),
    );
    const uppercase = await adapter.executeVerificationCheck(
      checkRequest({ candidateHeadSha: 'ABCDEF1234' }),
    );
    const tooShort = await adapter.executeVerificationCheck(
      checkRequest({ candidateHeadSha: '123456' }),
    );

    expect(notHex.result).toBe('unknown');
    expect(uppercase.result).toBe('unknown');
    expect(tooShort.result).toBe('unknown');
    expect(notHex.exitCode).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('accepts the shortest well-formed sha', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport(calls, completed(0)),
    });

    const result = await adapter.executeVerificationCheck(
      checkRequest({ candidateHeadSha: '1234567' }),
    );

    expect(result.result).toBe('pass');
    expect(calls).toEqual([
      { file: '/opt/verify-run.sh', args: ['1234567'], options: { timeout: DEFAULT_TIMEOUT_MS } },
    ]);
  });

  it('refuses to spawn for an ssh host that could inject options or split words', async () => {
    const calls: RecordedSpawn[] = [];
    const optionInjection = await new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      sshHost: '-oProxyCommand=x',
      spawn: recordingTransport(calls, completed(0)),
    }).executeVerificationCheck(checkRequest());

    const splitWords = await new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      sshHost: 'verify internal',
      spawn: recordingTransport(calls, completed(0)),
    }).executeVerificationCheck(checkRequest());

    expect(optionInjection.result).toBe('unknown');
    expect(splitWords.result).toBe('unknown');
    expect(optionInjection.exitCode).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps at most the last 4000 characters of the output summary', async () => {
    const truncated = await new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport([], completed(1, 'A'.repeat(4004) + 'END')),
    }).executeVerificationCheck(checkRequest());

    const exactLimit = await new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/opt/verify-run.sh' },
      spawn: recordingTransport([], completed(1, 'B'.repeat(3999) + 'Z')),
    }).executeVerificationCheck(checkRequest());

    expect(truncated.outputSummary).toBe('A'.repeat(3997) + 'END');
    expect(truncated.outputSummary).toHaveLength(OUTPUT_SUMMARY_LIMIT);
    expect(exactLimit.outputSummary).toBe('B'.repeat(3999) + 'Z');
  });

  it('runs a real allow-listed script and records its failing exit code', async () => {
    const directory = temporaryDirectory();
    const script = join(directory, 'verify-exit-3.sh');
    writeFileSync(script, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const adapter = new VerificationExecutorAdapter({ allowListedCommands: { ci: script } });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('fail');
    expect(result.exitCode).toBe(3);
    expect(result.outputSummary).toBe(`'ci' produced no output`);
    expect(result.completedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('VerificationExecutorAdapter with a CommandExecutorPort', () => {
  const allowList = { ci: { command: '/opt/verify-run.sh', args: ['--strict'] } };

  interface RecordedRun {
    argv: readonly string[];
    options?: { timeoutMs?: number };
  }

  function fakeExecutor(outcome: Partial<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    error: string;
  }>): {
    run: (argv: readonly string[], options?: { timeoutMs?: number }) => Promise<{
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      error?: string;
    }>;
    calls: RecordedRun[];
  } {
    const calls: RecordedRun[] = [];
    return {
      calls,
      run: async (argv, options) => {
        calls.push({ argv, options });
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...outcome };
      },
    };
  }

  it('runs the allow-listed command plus the candidate sha through the executor', async () => {
    const fake = fakeExecutor({ stdout: 'ok\n' });
    const adapter = new VerificationExecutorAdapter({
      executor: fake,
      allowListedCommands: allowList,
    });
    const result = await adapter.executeVerificationCheck(checkRequest());
    expect(result.result).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.outputSummary).toBe('ok\n');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].argv).toEqual(['/opt/verify-run.sh', '--strict', HEAD]);
    expect(fake.calls[0].options?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('maps a failing exit code to fail and a signal or spawn error to unknown', async () => {    const failing = new VerificationExecutorAdapter({
      executor: fakeExecutor({ exitCode: 2, stderr: 'boom\n' }),
      allowListedCommands: allowList,
    });
    expect((await failing.executeVerificationCheck(checkRequest())).result).toBe('fail');

    const signalled = new VerificationExecutorAdapter({
      executor: fakeExecutor({ exitCode: null, signal: 'SIGTERM' }),
      allowListedCommands: allowList,
    });
    const signalledResult = await signalled.executeVerificationCheck(checkRequest());
    expect(signalledResult.result).toBe('unknown');
    expect(signalledResult.outputSummary).toContain('SIGTERM');

    const spawnFailed = new VerificationExecutorAdapter({
      executor: fakeExecutor({ exitCode: null, error: 'spawn failed' }),
      allowListedCommands: allowList,
    });
    const failedResult = await spawnFailed.executeVerificationCheck(checkRequest());
    expect(failedResult.result).toBe('unknown');
    expect(failedResult.outputSummary).toContain('spawn failed');
  });

  it('never runs the executor when the procedure is not allow-listed', async () => {
    const fake = fakeExecutor({});
    const adapter = new VerificationExecutorAdapter({ executor: fake });
    const result = await adapter.executeVerificationCheck(checkRequest());
    expect(result.result).toBe('unknown');
    expect(fake.calls).toHaveLength(0);
  });

  it('maps exit code 255 through an ssh executor to unknown, never fail', async () => {
    const fake = fakeExecutor({ exitCode: 255, stderr: 'ssh: connection refused\n' });
    const adapter = new VerificationExecutorAdapter({
      executor: fake,
      allowListedCommands: allowList,
    });
    const result = await adapter.executeVerificationCheck(checkRequest());
    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBe(255);
    expect(result.outputSummary).toContain('255');
  });

  it('maps a real timeout through the executor path to unknown', async () => {
    const directory = temporaryDirectory();
    const script = join(directory, 'verify-sleeps.sh');
    writeFileSync(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const adapter = new VerificationExecutorAdapter({
      executor: new LocalExecutor(),
      allowListedCommands: { ci: script },
      timeoutMs: 400,
    });
    const result = await adapter.executeVerificationCheck(checkRequest());
    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBeNull();
    expect(result.outputSummary).toContain('timeout');
  });

  it('passes a real check through the executor path to pass', async () => {
    const directory = temporaryDirectory();
    const script = join(directory, 'verify-ok.sh');
    writeFileSync(script, '#!/bin/sh\necho verified\n', { mode: 0o755 });
    const adapter = new VerificationExecutorAdapter({
      executor: new LocalExecutor(),
      allowListedCommands: { ci: script },
      timeoutMs: 10_000,
    });
    const result = await adapter.executeVerificationCheck(checkRequest());
    expect(result.result).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.outputSummary).toContain('verified');
  });
});

describe('VerificationExecutorAdapter coverage declarations', () => {
  const declared = {
    ci: {
      command: '/opt/verify-run.sh',
      coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1 },
    },
  } as const;

  const VITEST_NORMAL = [
    ' RUN  v4.1.11 /work/packages/evidence-and-acceptance',
    '',
    ' ✓ src/domain/__tests__/check-coverage.test.ts (14 tests) 6ms',
    ' ✓ src/infrastructure/adapters/__tests__/VerificationExecutorAdapter.test.ts (22 tests) 120ms',
    '',
    ' Test Files  2 passed (2)',
    '      Tests  36 passed (36)',
    '   Start at  10:12:03',
    '   Duration  1.02s (transform 80ms, setup 0ms, import 300ms, tests 126ms, environment 0ms)',
  ].join('\n');
  const VITEST_FAILURES = ' Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 30 passed | 1 expected fail | 3 skipped | 1 todo (37)\n';
  const VITEST_ALL_SKIPPED = ' Test Files  1 skipped (1)\n      Tests  5 skipped (5)\n';
  const VITEST_NO_FILES = 'No test files found, exiting with code 0\n\nfilter: no-such-test\n';
  const VITEST_MISSING_SUMMARY = ' RUN  v4.1.11 /work\n\n ✓ src/a.test.ts (3 tests) 2ms\n';
  const HEXAGEN_NO_FILES = '{"fresh":[],"baselined":[],"stale":[],"expired":[],"introduced":[],"baselineGrowth":[],"filesScanned":0}\n';

  interface RecordedRun {
    argv: readonly string[];
    options?: { timeoutMs?: number };
  }

  function fakeExecutor(outcome: Partial<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    error: string;
  }>): {
    run: (argv: readonly string[], options?: { timeoutMs?: number }) => Promise<{
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      error?: string;
    }>;
    calls: RecordedRun[];
  } {
    const calls: RecordedRun[] = [];
    return {
      calls,
      run: async (argv, options) => {
        calls.push({ argv, options });
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...outcome };
      },
    };
  }

  it('attaches coverage measured from the full output on a passing run', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], completed(0, VITEST_NORMAL)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('pass');
    expect(result.coverage).toEqual({ ran: true, unitKind: 'tests', units: 36 });
    expect(result.outputSummary.endsWith('coverage: 36 tests (at least 1 tests expected)')).toBe(true);
  });

  it('downgrades pass to unknown when every test is skipped', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], completed(0, VITEST_ALL_SKIPPED)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.coverage).toEqual({ ran: true, unitKind: 'tests', units: 0 });
  });

  it('downgrades pass to unknown when no test files exist', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], completed(0, VITEST_NO_FILES)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.coverage).toEqual({ ran: false, reason: 'no count in output' });
  });

  it('downgrades pass to unknown when the summary line is missing', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], completed(0, VITEST_MISSING_SUMMARY)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
  });

  it('counts failures but never upgrades a failing exit code', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], completed(1, VITEST_FAILURES)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('fail');
    expect(result.coverage).toEqual({ ran: true, unitKind: 'tests', units: 33 });
  });

  it('attaches coverage from the full output even when the summary would be truncated', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], completed(0, VITEST_NORMAL, 'w\n'.repeat(3000))),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('pass');
    expect(result.coverage).toEqual({ ran: true, unitKind: 'tests', units: 36 });
    expect(result.outputSummary.length).toBeLessThanOrEqual(4000);
    expect(result.outputSummary).not.toContain('Tests  36 passed');
  });

  it('downgrades pass to unknown for a hexagen declaration with zero files', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: {
        ci: {
          command: 'hexagen-lint',
          args: ['--json'],
          coverage: { reader: 'hexagen-lint-json', unitKind: 'files', minUnits: 1 },
        },
      },
      spawn: recordingTransport([], completed(0, HEXAGEN_NO_FILES)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect(result.coverage).toEqual({ ran: true, unitKind: 'files', units: 0 });
  });

  it('leaves procedures without a coverage declaration unchanged', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: { command: '/opt/verify-run.sh' } },
      spawn: recordingTransport([], completed(0, VITEST_ALL_SKIPPED)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('pass');
    expect('coverage' in result).toBe(false);
  });

  it('treats an explicit undefined coverage declaration as no declaration', async () => {
    const calls: RecordedSpawn[] = [];
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: { command: '/opt/verify-run.sh', coverage: undefined } },
      spawn: recordingTransport(calls, completed(0, VITEST_ALL_SKIPPED)),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('pass');
    expect('coverage' in result).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('never spawns for a malformed coverage declaration', async () => {
    const malformed: readonly unknown[] = [
      null,
      { reader: 'nope', unitKind: 'tests', minUnits: 1 },
      { reader: 'vitest-summary', unitKind: 'files', minUnits: 1 },
      { reader: 'vitest-summary', unitKind: 'tests', minUnits: 0 },
      { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1.5 },
      { reader: 'vitest-summary', unitKind: 'tests', minUnits: '1' },
      { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1, extra: true },
    ];

    const outcomes = await Promise.all(
      malformed.map(async (coverage) => {
        const calls: RecordedSpawn[] = [];
        const adapter = new VerificationExecutorAdapter({
          allowListedCommands: { ci: { command: '/opt/verify-run.sh', coverage } },
          spawn: recordingTransport(calls, completed(0)),
        } as unknown as VerificationExecutorOptions);
        const result = await adapter.executeVerificationCheck(checkRequest());
        return { calls, result };
      }),
    );

    for (const { calls, result } of outcomes) {
      expect(result.result).toBe('unknown');
      expect(result.exitCode).toBeNull();
      expect(result.outputSummary).toContain('coverage declaration');
      expect(calls).toHaveLength(0);
    }
  });

  it('applies coverage on the executor path too', async () => {
    const skipped = new VerificationExecutorAdapter({
      executor: fakeExecutor({ exitCode: 0, stdout: VITEST_ALL_SKIPPED }),
      allowListedCommands: declared,
    });
    const skippedResult = await skipped.executeVerificationCheck(checkRequest());
    expect(skippedResult.result).toBe('unknown');

    const passed = new VerificationExecutorAdapter({
      executor: fakeExecutor({ exitCode: 0, stdout: VITEST_NORMAL }),
      allowListedCommands: declared,
    });
    const passedResult = await passed.executeVerificationCheck(checkRequest());
    expect(passedResult.result).toBe('pass');
    expect(passedResult.coverage).toEqual({ ran: true, unitKind: 'tests', units: 36 });
  });

  it('keeps a signal-terminated run unknown without coverage', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: declared,
      spawn: recordingTransport([], { status: null, signal: 'SIGTERM', stdout: VITEST_NORMAL, stderr: '' }),
    });

    const result = await adapter.executeVerificationCheck(checkRequest());

    expect(result.result).toBe('unknown');
    expect('coverage' in result).toBe(false);
  });
});
