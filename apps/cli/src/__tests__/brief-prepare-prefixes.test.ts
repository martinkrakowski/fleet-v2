// O14d1: `brief prepare --allowedPathPrefixes` accepts exactly one JSON array
// of strings; a malformed value is a usage error (exit 2), never a silent
// empty list.

import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../index.js';

function capturingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) }, stdout, stderr };
}

function briefArgs(prefixesFlag?: string): string[] {
  const args = [
    'brief',
    'prepare',
    '--workOrderId',
    'wo-prefix',
    '--laneId',
    'lane-prefix',
    '--baseCommit',
    'abc123',
    '--ownedPaths',
    'packages/x/src',
    '--seatTool',
    'opencode',
    '--independentReviewer',
    'reviewer-model',
  ];
  if (prefixesFlag !== undefined) args.push('--allowedPathPrefixes', prefixesFlag);
  return args;
}

describe('brief prepare --allowedPathPrefixes', () => {
  it('a malformed JSON value is a usage error (exit 2)', async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs('not-json'), io);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("brief prepare requires a JSON array of strings in '--allowedPathPrefixes'");
    expect(stdout).toHaveLength(0);
  });

  it('an array with a non-string entry is a usage error (exit 2)', async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs('["packages/x",5]'), io);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("brief prepare requires a JSON array of strings in '--allowedPathPrefixes'");
    expect(stdout).toHaveLength(0);
  });

  it('an empty JSON object value is a usage error (exit 2)', async () => {
    const { io, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs('{"packages":true}'), io);
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('--allowedPathPrefixes');
  });

  it('a valid JSON array is parsed and reaches the use case (exit 1 for the unrelated rejection)', async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs('["packages/x/src","docs/plans"]'), io);
    // The flag parsed; the use case rejects on its own grounds, which is the
    // refusal family (1), never a usage error (2).
    expect(exitCode).toBe(1);
    expect(stderr.join('')).not.toContain('--allowedPathPrefixes');
    expect(stdout.join('')).toContain('rejected');
  });
});
