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
import {
  AttemptRepositoryAdapter,
  ChainRepositoryAdapter,
  ForgeReadAdapter,
  ImportTrainStateUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  MergeQueueRepositoryAdapter,
  ReadOnlyStateStoreError,
  ReleaseStoreAdapter,
  SHADOW_ONE_TIME_REQUIREMENTS,
  ShadowAttestationAdapter,
  type RecordShadowDayDependencies,
} from '@fleet/work-execution';

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
  /**
   * Fix round 2: a sentinel meaning "`daemon.cliPath` is deliberately left
   * unset". The previous default parameter turned an explicitly passed
   * `undefined` into the default configured path, so the "unconfigured"
   * integration test actually ran with a configured path whose release root
   * happened to be missing. Now callers omit `cliPath` to get the default
   * served release path, and pass the sentinel alone to preserve a truly
   * unconfigured installation.
   */
  const UNCONFIGURED_CLI_PATH = Symbol('daemon.cliPath unconfigured');
  const DEFAULT_SERVED_CLI_PATH = '/srv/fleet/current/apps/cli/dist/bin.js';

  /**
   * A minimal valid v2 installation: github forge, a daemon section, no env.
   * SH20: `cliPath` defaults to a served release path (`<root>/current/...`)
   * and may be overridden (a custom path, or the `UNCONFIGURED_CLI_PATH`
   * sentinel when unconfigured).
   */
  function installationFor(
    forge: FleetInstallation['forge'],
    cliPath: string | typeof UNCONFIGURED_CLI_PATH = DEFAULT_SERVED_CLI_PATH,
  ): FleetInstallation {
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
        stateDir: '/srv/fleet/state',
        unitDir: '/srv/fleet/units',
        installationFile: '/srv/fleet/fleet.json',
        // SH20: `cliPath` is the configured entry point under a release root,
        // a custom path, or unset (the `UNCONFIGURED_CLI_PATH` sentinel) —
        // the composition's lexical parse decides which release root (if
        // any) the day binds to.
        ...(cliPath !== UNCONFIGURED_CLI_PATH ? { cliPath } : {}),
      },
      ...(forge !== undefined ? { forge } : {}),
    } as FleetInstallation;
  }

  function wiredRuntime(
    stateDir: string,
    forge: FleetInstallation['forge'] = { mode: 'github', owner: 'fleet', repo: 'v2' },
    // SH20: an optional custom `daemon.cliPath` — a custom served-release
    // path, a non-served path, or the `UNCONFIGURED_CLI_PATH` sentinel when
    // unconfigured.
    cliPath: string | typeof UNCONFIGURED_CLI_PATH = DEFAULT_SERVED_CLI_PATH,
  ): ReturnType<typeof createFleetCliRuntime> {
    return createFleetCliRuntime({
      stateDir,
      daemonSleep: async () => {},
      installation: installationFor(forge, cliPath),
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

  /**
   * Every entry under a directory, recursively, mapped to a text snapshot:
   * regular files to their bytes, directories to `<dir>`, symlinks to
   * `link -> <readlink target>` (the target is recorded, never followed), and
   * any other entry kind to `<other>` — so the no-write snapshot notices a
   * created directory, a created or retargeted symlink, or a changed file,
   * not only regular-file writes.
   */
  async function listFileBytes(root: string): Promise<Map<string, string>> {
    const entries = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          entries.set(full, `link -> ${await fs.readlink(full)}`);
        } else if (entry.isDirectory()) {
          entries.set(full, '<dir>');
          await walk(full);
        } else if (entry.isFile()) {
          entries.set(full, await fs.readFile(full, 'utf8'));
        } else {
          entries.set(full, '<other>');
        }
      }
    };
    await walk(root);
    return entries;
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
      // Luna's pre-merge fix: the e2e loop must accept only the exact expected
      // status/reason per criterion for this seeded state — never "anything
      // other than not-wired", which would also accept `not-implemented` or
      // an undefined reason. Pinned exactly:
      // - recorded S1/S5/S6/S7/S9/S12 at their seeded-state verdicts;
      // - unevaluated S4 `no-settled-heads` (owner decision 2026-11-18: the
      //   seeded state has no conducted heads, so S4 is never a pass and
      //   never a fail), S2/S10/S11 `release-unpinned` (releaseSha null, SH20 not
      //   landed: UNPINNED_RANK 2 beats NOT_YET_RANK 6), S3 `not-yet-observed`
      //   (the attestations ledger is missing), S8 `samples-invalid` (no
      //   daemon events to sample), S13 `not-implemented`.
      expect(result.recorded).toEqual({
        S1: 'pass',
        S5: 'pass',
        S6: 'fail',
        S7: 'pass',
        S9: 'pass',
        S12: 'fail',
      });
      expect(reasons).toEqual({
        S2: 'release-unpinned',
        S3: 'not-yet-observed',
        S4: 'no-settled-heads',
        S8: 'samples-invalid',
        S10: 'release-unpinned',
        S11: 'release-unpinned',
        S13: 'not-implemented',
      });
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

  /** The composition's private dependency bag, read back out of the use case. */
  function recordDayDeps(runtime: ReturnType<typeof createFleetCliRuntime>): RecordShadowDayDependencies {
    const useCase = runtime.execution.recordShadowDay;
    if (useCase === undefined) throw new Error('record-day is not wired');
    return (useCase as unknown as { deps: RecordShadowDayDependencies }).deps;
  }

  // Luna's fix round 2: the adapters hold their read-only mode in a private
  // field or constructor-options bag and expose no public getter, so the flag
  // is read safely through a structural cast — never by mutating or writing
  // anything. A reader with no flag anywhere fails the assertion loudly.
  function readOnlyOf(adapter: unknown): boolean {
    const candidate = adapter as {
      readonly options?: { readonly readOnly?: unknown };
      readonly readOnly?: unknown;
      readonly store?: { readonly options?: { readonly readOnly?: unknown } };
    };
    if (candidate.options?.readOnly !== undefined) return candidate.options.readOnly === true;
    if (candidate.store?.options?.readOnly !== undefined) return candidate.store.options.readOnly === true;
    if (candidate.readOnly !== undefined) return candidate.readOnly === true;
    throw new Error('adapter exposes no readable read-only flag');
  }

  // Luna's fix round 2: every reader the record-day composition builds is
  // asserted read-only AND a fresh instance, not the daemon/conductor's
  // writable one. Readers the composition reuses rather than builds (receipts,
  // forge, the shell-train reader) have no read-only mode at all — each says
  // so in a comment and relies on the corrupt-file backstop below.
  it('wires conducted.facts.runs as a fresh read-only LaneRunRepositoryAdapter, not the conductor\'s writable instance', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const facts = recordDayDeps(runtime).conducted?.facts;
    expect(facts?.runs).toBeInstanceOf(LaneRunRepositoryAdapter);
    expect(readOnlyOf(facts?.runs)).toBe(true);
    expect(facts?.runs).not.toBe(runtime.conductor.laneRunRepository);
  });

  it('wires conducted.facts.journal as a fresh read-only LaneRunJournalAdapter, not the conductor\'s writable instance', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const deps = recordDayDeps(runtime);
    const facts = deps.conducted?.facts;
    expect(facts?.journal).toBeInstanceOf(LaneRunJournalAdapter);
    expect(readOnlyOf(facts?.journal)).toBe(true);
    expect(facts?.journal).not.toBe(runtime.conductor.laneRunJournal);
  });

  it('wires the top-level journal reader as a fresh read-only LaneRunJournalAdapter, not the conductor\'s writable instance', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const deps = recordDayDeps(runtime);
    expect(deps.journal).toBeInstanceOf(LaneRunJournalAdapter);
    expect(readOnlyOf(deps.journal)).toBe(true);
    expect(deps.journal).not.toBe(runtime.conductor.laneRunJournal);
  });

  it('wires conducted.facts.attempts as a fresh read-only AttemptRepositoryAdapter, not the conductor\'s writable instance', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const facts = recordDayDeps(runtime).conducted?.facts;
    expect(facts?.attempts).toBeInstanceOf(AttemptRepositoryAdapter);
    expect(readOnlyOf(facts?.attempts)).toBe(true);
    expect(facts?.attempts).not.toBe(runtime.execution.attemptRepository);
  });

  it('wires conducted.facts.chains as a fresh read-only ChainRepositoryAdapter', () => {
    const deps = recordDayDeps(wiredRuntime(newDirs().stateDir));
    expect(deps.chains).toBeInstanceOf(ChainRepositoryAdapter);
    expect(readOnlyOf(deps.chains)).toBe(true);
    // The daemon's own chain store is not exposed on the runtime, so no
    // identity comparison is possible; the read-only flag is the guarantee.
  });

  it('wires conducted.facts.receipts to the same acceptance-receipt reader the telemetry seat exposes', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const facts = recordDayDeps(runtime).conducted?.facts;
    expect(facts?.receipts).toBe(runtime.telemetry.acceptanceReceiptRead);
    // AcceptanceReceiptReadAdapter has no read-only mode at all: it is a pure
    // projection over the evidence context's own inspection seat and holds no
    // flag. The corrupt-file backstop below covers it.
  });

  it('wires conducted.facts.forge as the ForgeReadAdapter', () => {
    const facts = recordDayDeps(wiredRuntime(newDirs().stateDir)).conducted?.facts;
    expect(facts?.forge).toBeInstanceOf(ForgeReadAdapter);
    // ForgeReadAdapter has no read-only mode at all: it is a `gh` read
    // projection with no write path and holds no flag. The corrupt-file
    // backstop below covers it.
  });

  it('wires the legacy shell-train reader the composition reuses, which is read-only by construction', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const deps = recordDayDeps(runtime);
    // LegacyTrainStateReadAdapter has no read-only mode at all: it only ever
    // reads the shell fixture files and never writes or quarantines, so it
    // holds no flag. The corrupt-file backstop below covers it.
    expect(deps.legacy).toBe(runtime.execution.legacyTrainState);
  });

  // SH19d: the queue seat must be a fresh read-only MergeQueueRepositoryAdapter,
  // never the shared writable execution.mergeQueueRepository — a corrupt
  // merge-queue.json is a read error here, never a quarantine.
  it('wires queue as a fresh read-only MergeQueueRepositoryAdapter, not execution.mergeQueueRepository, and refuses writes with ReadOnlyStateStoreError', async () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const deps = recordDayDeps(runtime);
    expect(deps.queue).toBeInstanceOf(MergeQueueRepositoryAdapter);
    expect(readOnlyOf(deps.queue)).toBe(true);
    expect(deps.queue).not.toBe(runtime.execution.mergeQueueRepository);
    await expect(
      (deps.queue as unknown as MergeQueueRepositoryAdapter).enqueueMergeEntry({
        repository: { owner: 'fleet', repo: 'v2' },
        pullRequest: 1,
        headOid: 'a'.repeat(40),
        tier: 1,
        enqueuedBy: 'cli',
        runId: null,
        entryId: '01HW1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q',
        successorEntryId: '01HW1Q1Q1Q1Q1Q1Q1Q1Q1Q1Q1R',
        enqueuedAtIso: new Date().toISOString(),
        deadlineIso: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toThrow(ReadOnlyStateStoreError);
  });

  // SH19d: the dry-run seat is a fresh ImportTrainStateUseCase over the same
  // read-only queue — listMergeEntries runs before the apply check, so the
  // read-only wiring covers S8's dry run too.
  it('wires importDryRun as a fresh ImportTrainStateUseCase over the same read-only queue, not execution.importTrainState', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const deps = recordDayDeps(runtime);
    expect(deps.importDryRun).toBeInstanceOf(ImportTrainStateUseCase);
    expect(deps.importDryRun).not.toBe(runtime.execution.importTrainState);
    const dryRunQueue = (deps.importDryRun as unknown as { deps: { queue: unknown } }).deps.queue;
    expect(dryRunQueue).toBe(deps.queue);
    expect(dryRunQueue).not.toBe(runtime.execution.mergeQueueRepository);
  });

  // Fix round 1: the composition builds ONE `ReleaseStoreAdapter` and reuses
  // it in BOTH seats — the one-time criteria's `oneTime.releaseStore` and the
  // `releaseSha` source. A second adapter for `releaseSha` would let the sha
  // recorded for the day diverge from the tree `inspectReleaseFiles` inspects,
  // so this test spies on the wired instance's `list` and asserts the
  // `releaseSha` source answered through it. It fails if the composition wires
  // a second adapter: the spy stays uncalled while a fresh instance answers.
  it('wires releaseSha through the SAME ReleaseStoreAdapter instance oneTime.releaseStore uses', async () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    const deps = recordDayDeps(runtime);
    const store = deps.oneTime?.releaseStore;
    if (store === undefined) throw new Error('oneTime.releaseStore is not wired');
    expect(store).toBeInstanceOf(ReleaseStoreAdapter);
    const calls: Array<{ root: string }> = [];
    const spied = store as { list(input: { readonly root: string }): Promise<unknown> };
    const original = spied.list.bind(store);
    spied.list = async (input: { readonly root: string }) => {
      calls.push(input);
      return await original(input);
    };
    // The default wired `daemon.cliPath` (`/srv/fleet/current/apps/cli/dist/bin.js`)
    // parses to release root `/srv/fleet`, which does not exist here, so the
    // listing is `read` with `current: null` and the sha is `null` — but the
    // spy call proves WHICH adapter the `releaseSha` source went through.
    const sha = await deps.releaseSha();
    expect(sha).toBeNull();
    expect(calls).toEqual([{ root: '/srv/fleet' }]);
  });

  // 2026-11-18 owner decision: with the composed `premergeCarry` resolver
  // pinned to `unknown`, S5' compares nothing (there is nothing resolvable)
  // and records `pass` (`carry-decisions-equal`) with `compared: 0` — never a
  // refusal. The unresolved decision is surfaced instead in the CLI JSON
  // output's non-digested diagnostics: `unresolvedCount` 1 plus the bounded
  // `unresolvedIds` (`12@` + the 12-hex head prefix). If the composition were
  // mutated to answer `agree` (mirroring the shell's answer), S5' would
  // compare 1 and this test would fail on `compared` and the diagnostics.
  it('records S5 as pass with compared 0 and the unresolved diagnostics when the composed premergeCarry answers unknown', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    // One paired shell carry decision inside the recorded day: an update
    // intent, then the result/updated event carrying detail 'premerge carried
    // (success)' — the pairing S5' replays through the fleet's answer.
    const oldHead = 'a'.repeat(40);
    const newHead = 'b'.repeat(40);
    await fs.writeFile(
      path.join(fixtureDir, 'events.jsonl'),
      `${JSON.stringify({ at: '2026-06-14T09:00:00Z', kind: 'intent', outcome: 'update-branch', pr: 12, headOid: oldHead })}\n` +
        `${JSON.stringify({ at: '2026-06-14T09:05:00Z', kind: 'result', outcome: 'updated', pr: 12, headOid: newHead, detail: 'premerge carried (success)' })}\n`,
    );
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
      // The day records S5 as a pass over an empty resolvable set, with the
      // unresolved decision printed in the `record-day` JSON output.
      expect(result.recorded.S5).toBe('pass');
      expect(reasonsOf(result).S5).toBeUndefined();
      expect(result.premergeCarry).toEqual({
        unresolvedCount: 1,
        unresolvedIds: [`12@${newHead.slice(0, 12)}`],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Fix round 3: the composed `premergeCarry` resolver must answer exactly
  // `unknown` — the owner decision is that it stays `unknown` until a real
  // resolver exists. The exact `unknown` shape on main is the bare string
  // `'unknown'`: the resolver contract is
  // `Promise<'carry' | 'no-carry' | 'unknown'>`
  // (`packages/work-execution/src/application/use-cases/RecordShadowDayUseCase.use-case.ts`
  // lines 147–151, `RecordShadowDayDependencies.premergeCarry`), so there is no
  // `{ status: 'unknown' }` wrapper. This test reaches the composed resolver
  // directly the same way the wiring tests above inspect the composed
  // dependencies, and fails if the composition is mutated to answer `'agree'`
  // (mirroring the shell's answer) — `'agree'` is not even a contract member,
  // and any non-`unknown` answer fails the strict equality below.
  it("the composed premergeCarry resolver answers exactly 'unknown' for a representative carry decision", async () => {
    const deps = recordDayDeps(wiredRuntime(newDirs().stateDir));
    const resolver = deps.premergeCarry;
    if (resolver === undefined) throw new Error('premergeCarry is not wired');
    // A representative paired shell carry decision (S5' input shape), and the
    // deadline the use case passes from its query window.
    const result = await resolver({
      repository: { owner: 'fleet', repo: 'v2' },
      decision: {
        pullRequest: 12,
        oldHeadOid: 'a'.repeat(40),
        newHeadOid: 'b'.repeat(40),
        atIso: '2026-06-14T09:05:00Z',
        shellCarry: 'carried',
      },
      deadlineIso: '2026-06-15T12:00:00.000Z',
    });
    expect(result).toBe('unknown');
  });

  // Luna's pre-merge fix 4: the composed attestation reader must be
  // read-only. A writable `ShadowAttestationAdapter` in the composition would
  // answer a write request with anything but the `read-only` refusal (an
  // invalid request there is refused `invalid-request` only after the
  // writability check), so this test fails if the composition swaps in the
  // writable adapter it also uses for the ledger itself.
  it('wires the one-time attestation reader read-only: the composed ShadowAttestationAdapter refuses a write with read-only', async () => {
    const deps = recordDayDeps(wiredRuntime(newDirs().stateDir));
    expect(deps.oneTime?.attestations).toBeInstanceOf(ShadowAttestationAdapter);
    // Fix round 2: the flag itself is read-only, and the composed reader is a
    // fresh instance (the composition builds exactly one adapter here, so the
    // flag plus the behavioural refusal below is the guarantee).
    expect(readOnlyOf(deps.oneTime?.attestations)).toBe(true);
    const attestations = deps.oneTime!.attestations as unknown as {
      compareAndSet(request: unknown): Promise<{ outcome: string; reason: string }>;
    };
    expect(await attestations.compareAndSet({})).toEqual({ outcome: 'refused', reason: 'read-only' });
  });

  // Luna's fix round 2, behaviour backstop: one corrupt state file per
  // readable store the record-day readers touch. After `record-day` every
  // seeded file must be byte-identical and no quarantine sibling may exist —
  // the composition's read-only wiring is what makes this hold, so reverting
  // any reader to a writable instance that quarantines fails here.
  it('never quarantines: every corrupt readable store is byte-identical after record-day, with no quarantine sibling', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    // One corrupt file per reader store the record-day readers read:
    // runs -> lane-runs.json, journal -> run-journal.json, attempts ->
    // attempts.json, receipts -> evidence-assessments.json, chains ->
    // chains/<sha>.json, attestations -> cutover-shadow-attestations.json,
    // queue -> merge-queue.json; shell events -> the fixture's events.jsonl.
    // The forge reader has no state file. cutover-shadow.json is deliberately
    // NOT seeded: the ledger is the one store the use case owns and writes,
    // not a reader.
    const corruptFiles: ReadonlyArray<readonly [string, string]> = [
      ['lane-runs.json', '{ not json'],
      ['run-journal.json', '{ not json'],
      ['attempts.json', '{ not json'],
      ['evidence-assessments.json', '{ not json'],
      ['cutover-shadow-attestations.json', '{ not json'],
      ['merge-queue.json', '{ not json'],
      [path.join('chains', 'c'.repeat(64) + '.json'), '{ not json'],
    ];
    for (const [name, bytes] of corruptFiles) {
      await fs.mkdir(path.join(stateDir, path.dirname(name)), { recursive: true });
      await fs.writeFile(path.join(stateDir, name), bytes);
    }
    // One corrupt shell-events line in the legacy fixture.
    await fs.writeFile(path.join(fixtureDir, 'events.jsonl'), '{ not json\n');
    const seededStateFiles = await listFileBytes(stateDir);
    const seededFixtureBytes = await fs.readFile(path.join(fixtureDir, 'events.jsonl'), 'utf8');
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
      // Every seeded file is byte-identical; the only new entry in the state
      // dir is the shadow ledger the use case itself compares-and-sets.
      const afterStateFiles = await listFileBytes(stateDir);
      for (const [name, bytes] of corruptFiles) {
        expect(afterStateFiles.get(path.join(stateDir, name))).toBe(bytes);
      }
      await expect(fs.readFile(path.join(fixtureDir, 'events.jsonl'), 'utf8')).resolves.toBe(seededFixtureBytes);
      for (const [name] of corruptFiles) {
        expect(seededStateFiles.has(path.join(stateDir, `${name}.quarantined`))).toBe(false);
        expect(afterStateFiles.has(path.join(stateDir, `${name}.quarantined`))).toBe(false);
      }
      // And no quarantine-shaped sibling anywhere under either directory.
      expect([...afterStateFiles.keys()].filter((file) => file.includes('quarantine'))).toEqual([]);
      // SH19d: no quarantine directory either — the read-only queue reader
      // and the read-only dry-run import never quarantine anything.
      await expect(fs.access(path.join(stateDir, 'quarantine'))).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------- SH20 ---
  // The day's `releaseSha` is derived from the installed `current` verified
  // release under the release root parsed from `daemon.cliPath`. Every
  // refusal case below returns `release-unpinned` for S2/S10/S11, creates
  // nothing under the release root, and leaves the state dir with only the
  // ledger the use case itself owns.

  /** The three required test paths S2/S10/S11 reserve, from the domain. */
  const REQUIRED_TEST_PATHS = [
    ...SHADOW_ONE_TIME_REQUIREMENTS.S2.tests,
    ...SHADOW_ONE_TIME_REQUIREMENTS.S10.tests,
    ...SHADOW_ONE_TIME_REQUIREMENTS.S11.tests,
  ];

  /** One throwaway release root; registered for cleanup like every temp dir. */
  function newReleaseRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'fleet-cli-record-day-release-'));
    tempDirs.push(root);
    return root;
  }

  /** One verified build: a sha-named directory with a valid marker file. */
  async function seedVerifiedBuild(root: string, sha: string): Promise<void> {
    await fs.mkdir(path.join(root, sha), { recursive: true });
    await fs.writeFile(
      path.join(root, sha, '.fleet-release-verified'),
      JSON.stringify({ version: 1, sha, builtAtIso: '2026-06-01T00:00:00.000Z' }),
    );
  }

  /**
   * Every refusal case shares this: the day still records, S2, S10 and S11
   * are all unevaluated `release-unpinned`, nothing was created under the
   * release root (when one exists), and the state dir gained exactly the
   * ledger `record-day` owns.
   */
  async function expectRefusedPinned(options: {
    readonly runtime: ReturnType<typeof createFleetCliRuntime>;
    readonly stateDir: string;
    readonly fixtureDir: string;
    readonly releaseRoot: string | null;
  }): Promise<void> {
    const beforeState = await listFileBytes(options.stateDir);
    const beforeRoot = options.releaseRoot !== null ? await listFileBytes(options.releaseRoot) : null;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    try {
      const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await options.runtime.execution.recordShadowDay!.execute({
        repository: { owner: 'fleet', repo: 'v2' },
        legacyStateDir: options.fixtureDir,
        day,
      });
      if (result.outcome !== 'recorded') {
        throw new Error(`expected recorded, got ${result.outcome} ${JSON.stringify(result)}`);
      }
      const reasons = reasonsOf(result);
      expect(reasons.S2).toBe('release-unpinned');
      expect(reasons.S10).toBe('release-unpinned');
      expect(reasons.S11).toBe('release-unpinned');
      // Nothing was created under the release root.
      if (options.releaseRoot !== null) {
        expect(await listFileBytes(options.releaseRoot)).toEqual(beforeRoot);
      }
      // And the state dir gained exactly the one ledger file.
      const afterState = await listFileBytes(options.stateDir);
      expect(
        [...afterState.keys()].filter((key) => !beforeState.has(key)),
      ).toEqual([path.join(options.stateDir, 'cutover-shadow.json')]);
    } finally {
      vi.useRealTimers();
    }
  }

  /** The SH20 runtime: a state dir, a shell fixture, one `daemon.cliPath`. */
  async function sh20Runtime(releaseRoot: string | null) {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const cliPath =
      releaseRoot !== null ? path.join(releaseRoot, 'current/apps/cli/dist/bin.js') : UNCONFIGURED_CLI_PATH;
    return {
      stateDir,
      fixtureDir,
      runtime: wiredRuntime(stateDir, undefined, cliPath),
    };
  }

  it('refuses when releaseRoot holds only a verified build and no current symlink', async () => {
    const releaseRoot = newReleaseRoot();
    await seedVerifiedBuild(releaseRoot, 'a'.repeat(40));
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot });
  });

  it('refuses when current is a regular file', async () => {
    const releaseRoot = newReleaseRoot();
    await seedVerifiedBuild(releaseRoot, 'a'.repeat(40));
    await fs.writeFile(path.join(releaseRoot, 'current'), 'not a link');
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot });
  });

  it('refuses when current is a directory', async () => {
    const releaseRoot = newReleaseRoot();
    await seedVerifiedBuild(releaseRoot, 'a'.repeat(40));
    await fs.mkdir(path.join(releaseRoot, 'current'));
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot });
  });

  it('refuses when current points outside the release root', async () => {
    const releaseRoot = newReleaseRoot();
    await seedVerifiedBuild(releaseRoot, 'a'.repeat(40));
    await fs.writeFile(path.join(releaseRoot, 'outside'), 'x');
    await fs.symlink('../outside', path.join(releaseRoot, 'current'));
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot });
  });

  it('refuses when current points at a non-sha name inside the release root', async () => {
    const releaseRoot = newReleaseRoot();
    await seedVerifiedBuild(releaseRoot, 'a'.repeat(40));
    await fs.mkdir(path.join(releaseRoot, 'some-dir'));
    await fs.symlink('some-dir', path.join(releaseRoot, 'current'));
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot });
  });

  it('refuses when current points at an unverified directory (no marker)', async () => {
    const releaseRoot = newReleaseRoot();
    await fs.mkdir(path.join(releaseRoot, 'a'.repeat(40)), { recursive: true });
    await fs.symlink('a'.repeat(40), path.join(releaseRoot, 'current'));
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot });
  });

  // Fix round 1: the root must genuinely not exist (not an existing empty
  // directory), the day must still record as `release-unpinned`, and an
  // explicit assertion pins that `record-day` did not create the release
  // root — not an incidental failure of some other step.
  it('refuses when the release root does not exist (ENOENT) and never creates it', async () => {
    const parent = newReleaseRoot();
    const missingRoot = path.join(parent, 'does-not-exist');
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(missingRoot);
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot: null });
    // Explicit: `record-day` did not create the missing release root, and it
    // did not even touch the parent directory that holds it.
    await expect(fs.access(missingRoot)).rejects.toThrow();
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it('refuses when the release root is unreadable (chmod 0o000)', async () => {
    const releaseRoot = newReleaseRoot();
    await seedVerifiedBuild(releaseRoot, 'a'.repeat(40));
    await fs.symlink('a'.repeat(40), path.join(releaseRoot, 'current'));
    const beforeRoot = await listFileBytes(releaseRoot);
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(releaseRoot);
    await fs.chmod(releaseRoot, 0o000);
    try {
      await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot: null });
    } finally {
      await fs.chmod(releaseRoot, 0o755);
    }
    // The unreadable root itself was never touched.
    expect(await listFileBytes(releaseRoot)).toEqual(beforeRoot);
  });

  it('refuses when daemon.cliPath is unconfigured (undefined)', async () => {
    const { stateDir, fixtureDir, runtime } = await sh20Runtime(null);
    // Fix round 2: the installation must TRULY leave `daemon.cliPath` unset —
    // the sentinel (not a swallowed `undefined`) guarantees it.
    const daemon = installationFor({ mode: 'github', owner: 'fleet', repo: 'v2' }, UNCONFIGURED_CLI_PATH).daemon;
    expect(daemon !== undefined && 'cliPath' in daemon ? 'set' : 'unset').toBe('unset');
    // And the release store must never be asked to list anything: no release
    // root is configured, so no `list` call can be legitimate.
    const deps = recordDayDeps(runtime);
    const store = deps.oneTime?.releaseStore;
    if (store === undefined) throw new Error('oneTime.releaseStore is not wired');
    let listCalls = 0;
    const spied = store as { list(input: { readonly root: string }): Promise<unknown> };
    const original = spied.list.bind(store);
    spied.list = async (input: { readonly root: string }) => {
      listCalls += 1;
      return await original(input);
    };
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot: null });
    expect(listCalls).toBe(0);
  });

  it('refuses when daemon.cliPath is not a served release path', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const runtime = wiredRuntime(stateDir, undefined, '/srv/fleet/apps/cli/dist/bin.js');
    await expectRefusedPinned({ runtime, stateDir, fixtureDir, releaseRoot: null });
  });

  it('binds the day to the installed current verified release sha and moves S2 to not-yet-observed and S10/S11 to pass', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const releaseRoot = newReleaseRoot();
    const otherSha = 'c'.repeat(40);
    const currentSha = 'd'.repeat(40);
    await seedVerifiedBuild(releaseRoot, otherSha);
    await seedVerifiedBuild(releaseRoot, currentSha);
    // ONLY current's target tree holds the three required test files.
    for (const relative of REQUIRED_TEST_PATHS) {
      await fs.mkdir(path.join(releaseRoot, currentSha, path.dirname(relative)), { recursive: true });
      await fs.writeFile(path.join(releaseRoot, currentSha, relative), '// required by SHADOW_ONE_TIME_REQUIREMENTS\n');
    }
    await fs.symlink(currentSha, path.join(releaseRoot, 'current'));
    const runtime = wiredRuntime(
      stateDir,
      undefined,
      path.join(releaseRoot, 'current/apps/cli/dist/bin.js'),
    );
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
      // S2 and S3 move off release-unpinned to not-yet-observed (the
      // attestations ledger is absent); S10 and S11 record pass.
      const reasons = reasonsOf(result);
      expect(reasons.S2).toBe('not-yet-observed');
      expect(reasons.S3).toBe('not-yet-observed');
      expect(result.recorded.S10).toBe('pass');
      expect(result.recorded.S11).toBe('pass');
      // And the ledger binds the day to current's verified sha.
      const ledger = JSON.parse(await fs.readFile(path.join(stateDir, 'cutover-shadow.json'), 'utf8')) as {
        readonly days: readonly { readonly day: string; readonly releaseSha: string | null }[];
      };
      expect(ledger.days).toHaveLength(1);
      expect(ledger.days[0].releaseSha).toBe(currentSha);
      expect(ledger.days[0].day).toBe(day);
    } finally {
      vi.useRealTimers();
    }
  });

  // RC1: the early warning — `record-day` prints one warning line to stderr
  // when the lane-run store holds more than 1,500 runs (`SHADOW_FACTS_WARN_RUNS`;
  // the 2,000-run cap is deferred), read through the same SH19c read-only
  // `conducted.facts.runs` reader. The warning never changes the JSON result on
  // stdout, the exit code, or any file.
  /** One valid stored lane-run record, in the exact `lane-runs.json` shape. */
  function laneRunRecord(index: number): Record<string, unknown> {
    return {
      version: 1,
      runId: `run-${String(index).padStart(26, '0')}`,
      workOrderId: `wo-example-${index}`,
      tier: 2,
      seatPlanRef: 'a'.repeat(64),
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: [],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: `policy-example-${index}`,
      schemaVersion: 1,
    };
  }

  async function writeLaneRuns(stateDir: string, count: number): Promise<void> {
    const records: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index += 1) {
      records.push(laneRunRecord(index));
    }
    await fs.writeFile(path.join(stateDir, 'lane-runs.json'), JSON.stringify(records));
  }

  function recordDayWithRuns(count: number) {
    return async () => {
      const { stateDir, fixtureDir } = newDirs();
      await shellFixture(fixtureDir);
      await writeLaneRuns(stateDir, count);
      const runtime = wiredRuntime(stateDir);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
      try {
        const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const result = await cli(runtime, recordDayArgs(fixtureDir, ['--day', day]));
        return { result, stateDir };
      } finally {
        vi.useRealTimers();
      }
    };
  }

  it('prints the warning to stderr above the threshold and leaves the result and exit code unchanged', async () => {
    const { result } = await recordDayWithRuns(1501)();
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as { outcome: string; unevaluated: unknown[] };
    expect(body.outcome).toBe('recorded');
    expect(result.err).toContain('1501');
    expect(result.err).toContain('1500');
    expect(result.err).toMatch(/^warning: lane-run store holds 1501 runs/);
  });

  it('prints no warning at the threshold', async () => {
    const { result } = await recordDayWithRuns(1500)();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).outcome).toBe('recorded');
    expect(result.err).toBe('');
  });

  it('prints no warning, and the outcome is the existing unknown, when the lane-run store is unreadable', async () => {
    const { stateDir, fixtureDir } = newDirs();
    await shellFixture(fixtureDir);
    const bytes = '{ not json';
    await fs.writeFile(path.join(stateDir, 'lane-runs.json'), bytes);
    const runtime = wiredRuntime(stateDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    try {
      const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const result = await cli(runtime, recordDayArgs(fixtureDir, ['--day', day]));
      expect(result.err).toBe('');
      const body = JSON.parse(result.out) as { outcome: string; unevaluated: ReadonlyArray<{ criterion: string; reason: string }> };
      expect(body.outcome).toBe('recorded');
      const reasons = Object.fromEntries(body.unevaluated.map((entry) => [entry.criterion, entry.reason]));
      expect(reasons.S4).toBe('runs-unreadable');
      expect(reasons.S6).toBe('runs-unreadable');
      // Never quarantined: the corrupt bytes are exactly as they were, and the
      // store was never quarantined into a sibling file either.
      await expect(fs.readFile(path.join(stateDir, 'lane-runs.json'), 'utf8')).resolves.toBe(bytes);
      expect(readdirSync(stateDir).filter((entry) => entry !== 'lane-runs.json' && entry !== 'cutover-shadow.json')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });


  it('exposes shadowRunsRead as the same instance conducted.facts.runs uses, and omits it when conducted is not wired', () => {
    const runtime = wiredRuntime(newDirs().stateDir);
    expect(runtime.execution.shadowRunsRead).toBe(recordDayDeps(runtime).conducted?.facts?.runs);
    expect(readOnlyOf(runtime.execution.shadowRunsRead)).toBe(true);
    expect(runtime.execution.shadowRunsRead).not.toBe(runtime.conductor.laneRunRepository);

    const unwired = wiredRuntime(newDirs().stateDir, { mode: 'none' });
    expect(unwired.execution.shadowRunsRead).toBeUndefined();
  });
});
