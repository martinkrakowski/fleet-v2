// VerificationExecutorAdapter: argv construction for allow-listed checks,
// ssh transport quoting, fail-closed mapping of completed outcomes, and
// bounded output summaries. Uses the spawn seam except for one real process.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { VerificationExecutorAdapter } from '../VerificationExecutorAdapter.adapter.js';
import type {
  SpawnedVerificationOutcome,
  SpawnVerificationTransport,
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
