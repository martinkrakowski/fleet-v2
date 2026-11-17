// SH8a: the `cutover shadow record-day` command — wired through the real CLI
// driver against a real temporary state directory (where the ledger lands) and
// a real temporary shell-state fixture directory (synthetic lines only).
// The use case's result is returned unchanged: `recorded` and `unchanged`
// complete (0), every other outcome exits 1, malformed flags are usage (2).
import { mkdtempSync, promises as fs, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function cli(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCli(argv, io, runtime);
  return { code, out: out.join(''), err: err.join('') };
}

/** One durable state directory plus one clean shell-state fixture directory. */
function newDirs(): { stateDir: string; fixtureDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-record-day-'));
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-record-day-shell-'));
  tempDirs.push(stateDir, fixtureDir);
  return { stateDir, fixtureDir };
}

/** The composed runtime: the S8 wall-clock gap is the injected no-op sleep. */
function runtimeFor(stateDir?: string): ReturnType<typeof createFleetCliRuntime> {
  return createFleetCliRuntime({ ...(stateDir !== undefined ? { stateDir } : {}), daemonSleep: async () => {} });
}

function recordDayArgs(fixtureDir: string, extra: readonly string[] = []): string[] {
  return [
    'cutover',
    'shadow',
    'record-day',
    '--repository',
    'fleet/v2',
    '--legacy-state-dir',
    fixtureDir,
    ...extra,
  ];
}

describe('cutover shadow record-day (SH8a)', () => {
  it('records a clean day into cutover-shadow.json in the state directory and then reports the same day as unchanged', async () => {
    const { stateDir, fixtureDir } = newDirs();
    // A clean fixture: the shell queue exists and holds nothing (synthetic).
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    const runtime = runtimeFor(stateDir);
    // Pinned once and passed explicitly to both invocations: without this, a
    // real UTC-midnight crossing between the two calls would make the second
    // one resolve to a different default day than the first (each computes
    // "yesterday" from the real wall clock independently), so it would record
    // a new entry instead of reporting unchanged. See the too-early test
    // below for the same real-Date.now() style used in this file.
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const first = await cli(runtime, recordDayArgs(fixtureDir, ['--day', day]));
    expect(first.code).toBe(0);
    const firstBody = JSON.parse(first.out) as {
      outcome: string;
      day: string;
      revision: number;
      recorded: Record<string, string>;
      unevaluated: ReadonlyArray<{ criterion: string; reason: string }>;
    };
    expect(firstBody.outcome).toBe('recorded');
    expect(firstBody.revision).toBe(1);
    await expect(fs.access(path.join(stateDir, 'cutover-shadow.json'))).resolves.toBeUndefined();

    const second = await cli(runtime, recordDayArgs(fixtureDir, ['--day', day]));
    expect(second.code).toBe(0);
    const secondBody = JSON.parse(second.out) as { outcome: string; revision: number };
    expect(secondBody.outcome).toBe('unchanged');
    expect(secondBody.revision).toBe(1);
  });

  it('refuses with state-dir-required when no durable state directory is configured', async () => {
    const { fixtureDir } = newDirs();
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    const runtime = runtimeFor();

    const result = await cli(runtime, recordDayArgs(fixtureDir));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason: 'state-dir-required' });
    expect(result.out).not.toContain(fixtureDir);
  });

  it('is a usage error for an unrecognized flag', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    const runtime = runtimeFor(stateDir);

    const result = await cli(runtime, recordDayArgs(fixtureDir, ['--now-iso', '2026-11-17T00:00:00.000Z']));
    expect(result.code).toBe(2);
    expect(result.err).toContain('does not accept an unknown flag');
  });

  it('is a usage error when --legacy-state-dir is missing', async () => {
    const { stateDir, fixtureDir } = newDirs();
    const runtime = runtimeFor(stateDir);

    const result = await cli(runtime, [
      'cutover',
      'shadow',
      'record-day',
      '--repository',
      'fleet/v2',
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('cutover shadow record-day requires --legacy-state-dir');
    expect(readdirSync(fixtureDir).length).toBe(0);
  });

  it('refuses with too-early when --day names today, exercising the use case day validation through the wiring', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    const runtime = runtimeFor(stateDir);
    const today = new Date().toISOString().slice(0, 10);

    const result = await cli(runtime, recordDayArgs(fixtureDir, ['--day', today]));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason: 'too-early' });
    // Nothing is ever written on a refusal.
    await expect(fs.access(path.join(stateDir, 'cutover-shadow.json'))).rejects.toThrow();
  });
});
