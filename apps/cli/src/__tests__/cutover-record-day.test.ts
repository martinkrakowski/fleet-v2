// SH8a: the `cutover shadow record-day` command — wired through the real CLI
// driver against a real temporary state directory (where the ledger lands) and
// a real temporary shell-state fixture directory (synthetic lines only).
// The use case's result is returned unchanged: `recorded` and `unchanged`
// complete (0), every other outcome exits 1, malformed flags are usage (2).
import { mkdtempSync, promises as fs, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { FleetInstallation } from '@fleet/installation';

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
    // Pin the system clock to a fixed instant comfortably clear of any UTC
    // midnight boundary (local use-case composition resolves `nowIso` through
    // `daemon.now`, which defaults to `() => new Date().toISOString()`, so
    // faking `Date` here reaches the use case's own too-early check too).
    // Without this, computing "yesterday" from the REAL wall clock makes the
    // test flaky in the first `EARLY_GRACE_MS` (15 minutes) after a real UTC
    // midnight: "yesterday" is still the right day value, but the use case
    // refuses it as too-early, so the expected `recorded` outcome fails.
    // Pinning the clock removes that real-wall-clock dependency entirely,
    // rather than further narrowing the already-narrow window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    try {
      // Computed once from the pinned clock and passed explicitly to both
      // invocations: without this, a midnight crossing between the two calls
      // would make the second one resolve to a different default day than
      // the first (each computes "yesterday" independently), so it would
      // record a new entry instead of reporting unchanged.
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
    } finally {
      vi.useRealTimers();
    }
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

// SH19c: the composition wiring — the conducted-facts, chains, premerge-carry
// and one-time readers are wired into `record-day`, every one of them
// read-only, and every failure path is a typed unevaluated reason, never a
// throw and never a quarantined file.
describe('cutover shadow record-day wiring (SH19c)', () => {
  /** A minimal valid v2 installation: github forge, a daemon section, no env. */
  function installationFor(forge: FleetInstallation['forge']): FleetInstallation {
    return {
      schemaVersion: 2,
      hosts: {
        'lane-host': {
          transport: 'local',
          worktreeRoot: '/srv/fleet/worktrees',
          roles: ['orchestrator', 'lane-runner'],
          runner: {
            kind: 'opencode',
            port: 46000,
            capabilities: {
              networkEgressRestricted: true,
              cpuAndMemoryLimited: true,
              processTreeTermination: true,
              filesystemScope: 'scoped-worktree',
            },
            maxLanes: 2,
          },
        },
      },
      tools: ['opencode'],
      seats: [
        {
          id: 'implementer',
          tool: 'opencode',
          model: 'example-provider/example-model',
          roles: ['implementer'],
          costClass: 'plan-quota',
        },
      ],
      chains: { implementer: [{ seatId: 'implementer' }] },
      policy: { forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }] },
      shelf: { provider: 'local' },
      verification: { procedures: { gate: { command: 'true', args: [] } } },
      waves: { baseUrl: 'https://waves.example', tokenFile: '/home/operator/.config/fleet/waves-token' },
      decisions: { provider: 'none' },
      daemon: {
        nodePath: '/usr/bin/node',
        cliPath: '/srv/fleet/current/apps/cli/dist/bin.js',
        stateDir: '/srv/fleet/state',
        unitDir: '/srv/fleet/units',
        installationFile: '/srv/fleet/fleet.json',
      },
      ...(forge !== undefined ? { forge } : {}),
    } as FleetInstallation;
  }

  function wiredRuntime(
    stateDir: string,
    forge: FleetInstallation['forge'] = { mode: 'github', owner: 'fleet', repo: 'v2' },
  ): ReturnType<typeof createFleetCliRuntime> {
    return createFleetCliRuntime({
      stateDir,
      daemonSleep: async () => {},
      installation: installationFor(forge),
      // A forge read must never run for an empty day; the stub refuses loudly.
      forgeGhRunner: async () => {
        throw new Error('forge read must not run for an empty day');
      },
      env: {},
    });
  }

  /** A clean shell fixture: the queue, parked, inprogress and events files all exist and hold nothing. */
  async function shellFixture(fixtureDir: string): Promise<void> {
    await fs.writeFile(path.join(fixtureDir, 'queue'), '');
    await fs.writeFile(path.join(fixtureDir, 'parked'), '');
    await fs.writeFile(path.join(fixtureDir, 'inprogress'), '');
    await fs.writeFile(path.join(fixtureDir, 'events.jsonl'), '');
  }

  function reasonsOf(result: { readonly unevaluated: ReadonlyArray<{ criterion: string; reason: string }> }): Record<string, string> {
    return Object.fromEntries(result.unevaluated.map((entry) => [entry.criterion, entry.reason]));
  }

  it('wires every reader and records the day: every wired criterion moves off not-wired, S13 stays not-implemented, S3 not-yet-observed and S2/S10/S11 release-unpinned while cutover-shadow-attestations.json is missing', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const runtime = wiredRuntime(stateDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    try {
      const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await runtime.execution.recordShadowDay!.execute({
        repository: { owner: 'fleet', repo: 'v2' },
        legacyStateDir: fixtureDir,
        day,
      });
      if (result.outcome !== 'recorded') {
        throw new Error(`expected recorded, got ${result.outcome} ${JSON.stringify(result)}`);
      }
      const reasons = reasonsOf(result);
      for (const criterion of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12']) {
        expect(reasons[criterion], criterion).not.toBe('not-wired');
      }
      expect(reasons.S13).toBe('not-implemented');
      // releaseSha is null (SH20 is not landed), so UNPINNED_RANK beats NOT_YET_RANK.
      expect(reasons.S2).toBe('release-unpinned');
      expect(reasons.S10).toBe('release-unpinned');
      expect(reasons.S11).toBe('release-unpinned');
      expect(reasons.S3).toBe('not-yet-observed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the state directory with no entries beyond the ledger it owns after record-day over an empty state dir', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const runtime = wiredRuntime(stateDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    try {
      const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await runtime.execution.recordShadowDay!.execute({
        repository: { owner: 'fleet', repo: 'v2' },
        legacyStateDir: fixtureDir,
        day,
      });
      expect(result.outcome).toBe('recorded');
      // The read-only readers (chains, lane runs, journal, attempts,
      // attestations) must have created no directory, no lock file and no
      // store: the only new entry is the shadow ledger the use case itself
      // compares-and-sets.
      expect(readdirSync(stateDir).sort()).toEqual(['cutover-shadow.json']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports attestations-unreadable for S2, S3, S10 and S11 when cutover-shadow-attestations.json is corrupt or null, without throwing or quarantining', async () => {
    for (const bytes of ['{ not json', 'null', '{"attestations":{}}']) {
      const { stateDir, fixtureDir } = newDirs();
      await shellFixture(fixtureDir);
      await fs.writeFile(path.join(stateDir, 'cutover-shadow-attestations.json'), bytes);
      const runtime = wiredRuntime(stateDir);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
      try {
        const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const result = await runtime.execution.recordShadowDay!.execute({
          repository: { owner: 'fleet', repo: 'v2' },
          legacyStateDir: fixtureDir,
          day,
        });
        if (result.outcome !== 'recorded') {
          throw new Error(`expected recorded, got ${result.outcome} ${JSON.stringify(result)}`);
        }
        const reasons = reasonsOf(result);
        expect(reasons.S2).toBe('attestations-unreadable');
        expect(reasons.S3).toBe('attestations-unreadable');
        expect(reasons.S10).toBe('attestations-unreadable');
        expect(reasons.S11).toBe('attestations-unreadable');
        // Never quarantined: the corrupt bytes are exactly as they were.
        await expect(fs.readFile(path.join(stateDir, 'cutover-shadow-attestations.json'), 'utf8')).resolves.toBe(bytes);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('omits conducted and leaves S4 and S6 not-wired when forge mode is not github', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const runtime = wiredRuntime(stateDir, { mode: 'none' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    try {
      const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await runtime.execution.recordShadowDay!.execute({
        repository: { owner: 'fleet', repo: 'v2' },
        legacyStateDir: fixtureDir,
        day,
      });
      if (result.outcome !== 'recorded') {
        throw new Error(`expected recorded, got ${result.outcome} ${JSON.stringify(result)}`);
      }
      const reasons = reasonsOf(result);
      expect(reasons.S4).toBe('not-wired');
      expect(reasons.S6).toBe('not-wired');
      // The one-time and chains readers are still wired.
      expect(reasons.S3).toBe('not-yet-observed');
      expect(reasons.S7).not.toBe('not-wired');
    } finally {
      vi.useRealTimers();
    }
  });
});
