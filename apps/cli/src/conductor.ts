/**
 * `fleet-v2 conductor` (lanes K7-4 and K7-7): the four record-only
 * subcommands `status`, `halt`, `stop` and `resume`, with no driver and no
 * dispatch, plus the two driver-side subcommands `start` and `run` (K7-7).
 * The record-only commands print one JSON document on stdout and map the use
 * case's outcome to an exit code (0 completed, 1
 * refused/rejected/blocked/unknown, 2 usage): the halt marker is set or
 * lifted, a stop is recorded as a keyed journal intent the driver obeys, a
 * resume is recorded for a parked run. Nothing there takes a run lease or
 * dispatches anything.
 *
 * `conductor start` reserves capacity, prepares the run's worktree at the
 * reserved path and places the brief there, then records the first attempt
 * and the run (owner decision K7-D7); it runs no model and dispatches
 * nothing, but it writes host state, so it is guarded by
 * `policy.conductor.enabled`. `conductor run --live` is the driver: it holds
 * the state directory's driver lease, loops over passes with back-off and
 * dispatches real lanes — it refuses unless
 * `policy.conductor.enabled` is on, needs the explicit `--live` flag and a
 * durable state directory, and may be run only with the owner's explicit
 * authority. `conductor run --dry-run` (K7-8) copies the state stores into a
 * scratch directory and drives them with recording fakes, printing what the
 * driver would do; it acts on nothing and never touches the real state. All
 * I/O here goes through the injected `CliIo`.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, copyFile as fsCopyFile, rm as fsRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseLaneRunKey,
  AttemptRepositoryAdapter,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  ExecutionJournalAdapter,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  WorkOrderRepositoryAdapter,
  type LaneRunJournalEntryRecord,
  type RunConductorPassResult,
} from '@fleet/work-execution';

import type { FleetCliRuntime } from './composition.js';
import type { CliIo } from './index.js';
import { buildLiveConductorDriver, buildDryRunConductorDriver, type ConductorDriver, type DryRunStores } from './conductor-wiring.js';

export interface ConductorCliOptions {
  /** Clock override for tests; production uses the system clock. */
  readonly now?: () => string;
  /** The resolved state directory (`--state-dir` / `FLEET_STATE_DIR`); undefined = in-memory stores. */
  readonly stateDir?: string;
  /** Test seams; production uses real timers and process signals. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The signal that ends the polling loop (SIGINT/SIGTERM in production). */
  readonly stopSignal?: AbortSignal;
  /** Replaces the driver builder (tests only); production builds the live driver. */
  readonly buildDriver?: (
    runtime: FleetCliRuntime,
    mode: 'live' | 'dry-run',
    options: { readonly maxActiveRuns: number },
  ) => ConductorDriver;
  /** Test seam for the dry-run's scratch copy (production uses fs.promises.copyFile). */
  readonly copyFile?: (source: string, destination: string) => Promise<void>;
}

export const CONDUCTOR_HELP = `Usage: fleet-v2 conductor status [<runId>]
       fleet-v2 conductor halt [--lift]
       fleet-v2 conductor stop <runId> [--force] [--revision <n>]
       fleet-v2 conductor resume <runId> [--revision <n>]
       fleet-v2 conductor start --brief-request <file.json> --tier 1|2 [--run-id <id> --attempt-id <id>] [--max-active-runs <n>]
       fleet-v2 conductor start --abandon --run-id <id> --attempt-id <id>
       fleet-v2 conductor run --live|--dry-run [--once] [--max-active-runs <n>]

Read-only status of one lane run (or every run) with its projected state,
the halt marker and the driver lease; a kill-switch halt the driver checks
before any external action (halt --lift clears it); halt never stops a running
lane; a stop recorded as a keyed run-journal intent — stop is graceful by
default, --force stops the running lane now; a resume recorded for a parked
run. The driver obeys the records; nothing here dispatches, and the CLI
never takes a run lease. --max-active-runs on conductor start is the
active-run cap the start's admission check uses.

conductor run --live dispatches real lanes. Run it only with the owner's
explicit authority; it also needs policy.conductor.enabled and a state
directory. conductor run --dry-run copies the state stores into a scratch
directory and drives them with recording fakes, printing what the driver
would do; it reaches no host, needs neither --live nor
policy.conductor.enabled, and never writes the real state. conductor start
reserves capacity and prepares a worktree on a lane host; it needs
policy.conductor.enabled and a state directory, and dispatches nothing.
start --abandon works while the conductor is disabled.

Each subcommand prints one JSON document on stdout (conductor run prints one
JSON line per pass).

Exit codes: 0 completed (a stop already recorded still exits 0), 1 refused,
not found or blocked, 2 usage error.`;

/** A positive safe integer or undefined: the revision the requester read. */
function revisionOf(value: string | undefined): number | 'invalid' | 'absent' {
  if (value === undefined) {
    return 'absent';
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 'invalid';
  }
  return parsed;
}

interface ControlOptions {
  readonly force: boolean;
  readonly lift: boolean;
  readonly revision: number | undefined;
  readonly positionals: readonly string[];
}

/**
 * The group's private flag reader: one optional positional run id, `--force`,
 * `--lift` and `--revision <n>`. An unknown flag, a repeated flag, a bad
 * revision or a second positional is a usage error.
 */
function readControlOptions(argv: readonly string[], io: CliIo): ControlOptions | null {
  const positionals: string[] = [];
  let force = false;
  let lift = false;
  let revision: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--force') {
      if (force) {
        io.stderr(`Repeated flag: ${token}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      force = true;
      continue;
    }
    if (token === '--lift') {
      if (lift) {
        io.stderr(`Repeated flag: ${token}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      lift = true;
      continue;
    }
    if (token === '--revision' || token.startsWith('--revision=')) {
      if (revision !== undefined) {
        io.stderr(`Repeated flag: --revision\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      const value = token === '--revision' ? argv[index + 1] : token.slice('--revision='.length);
      if (token === '--revision') {
        index += 1;
      }
      const parsed = revisionOf(value);
      if (parsed === 'absent' || parsed === 'invalid') {
        io.stderr(`--revision requires a positive integer\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      revision = parsed;
      continue;
    }
    if (token.startsWith('--')) {
      io.stderr(`Unknown conductor flag: ${token}\n${CONDUCTOR_HELP}\n`);
      return null;
    }
    positionals.push(token);
  }
  if (positionals.length > 1) {
    io.stderr(`conductor takes at most one run id\n${CONDUCTOR_HELP}\n`);
    return null;
  }
  return { force, lift, revision, positionals };
}

/** What each subcommand accepts; anything else is a usage error, never silently ignored. */
const SUBCOMMAND_SHAPE: Readonly<
  Record<string, { readonly force: boolean; readonly lift: boolean; readonly revision: boolean; readonly runId: 'none' | 'optional' | 'required'; readonly writes: boolean }>
> = {
  status: { force: false, lift: false, revision: false, runId: 'optional', writes: false },
  halt: { force: false, lift: true, revision: false, runId: 'none', writes: true },
  stop: { force: true, lift: false, revision: true, runId: 'required', writes: true },
  resume: { force: false, lift: false, revision: true, runId: 'required', writes: true },
};

/** The exit code of a control result, read from its outcome; text is never parsed. */
function exitFor(result: { readonly outcome: string }): number {
  if (result.outcome === 'refused' || result.outcome === 'not-found') {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// conductor start and conductor run (K7-7)
// ---------------------------------------------------------------------------

/** The run id shape `conductor start --run-id` accepts on a retry. */
const RUN_ID_PATTERN = /^run-[0-9A-HJKMNP-TV-Z]{26}$/;

/** The attempt id shape `conductor start --attempt-id` accepts on a retry. */
const ATTEMPT_ID_PATTERN = /^attempt-[0-9A-HJKMNP-TV-Z]{26}$/;

/** Back-off of plan §3.1: 30 s after a pass that progressed, else doubled up to 2 min. */
const MIN_POLL_MS = 30_000;
const MAX_POLL_MS = 120_000;

/** Back-off of §3.1: 30 s after a pass that progressed, else doubled up to 2 min. */
export function nextPollDelayMs(previousMs: number | null, progressed: boolean): number {
  if (progressed || previousMs === null) {
    return MIN_POLL_MS;
  }
  return Math.min(previousMs * 2, MAX_POLL_MS);
}

/** Real-timer sleep the stop signal cuts short; the default of `options.sleep`. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    // Whichever fires first cleans up the other, so a long poll loop never accumulates abort listeners.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface StartFlags {
  readonly briefRequest?: string;
  readonly tier?: number;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly maxActiveRuns: number;
  readonly abandon: boolean;
  /** Present only to reject them as usage errors. */
  readonly dryRun: boolean;
  readonly live: boolean;
}

/** One positive integer flag value, or null when malformed. */
function positiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * `conductor start`'s private flag reader: `--brief-request <file>`,
 * `--tier <n>`, `--run-id`, `--attempt-id`, `--max-active-runs <n>`,
 * `--abandon`; `--dry-run` and `--live` are read only to be refused. An
 * unknown flag, a repeated flag, a second value or a positional is a usage
 * error.
 */
function readStartFlags(argv: readonly string[], io: CliIo): StartFlags | null {
  const flags: { briefRequest?: string; tier?: number; runId?: string; attemptId?: string; maxActiveRuns?: number } = {};
  let abandon = false;
  let dryRun = false;
  let live = false;
  const seen = new Set<string>();
  const readValue = (token: string, index: number): string | null => {
    if (token.includes('=')) {
      return token.slice(token.indexOf('=') + 1);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      // The cap's missing value reads exactly as the run command's (KF-25 review).
      io.stderr(
        token === '--max-active-runs'
          ? `--max-active-runs requires a positive integer up to ${MAX_ACTIVE_RUNS_LIMIT}\n${CONDUCTOR_HELP}\n`
          : `${token} requires a value\n${CONDUCTOR_HELP}\n`,
      );
      return null;
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const flag =
      token === '--brief-request' || token.startsWith('--brief-request=')
        ? 'brief-request'
        : token === '--tier' || token.startsWith('--tier=')
          ? 'tier'
          : token === '--run-id' || token.startsWith('--run-id=')
            ? 'run-id'
            : token === '--attempt-id' || token.startsWith('--attempt-id=')
              ? 'attempt-id'
              : token === '--max-active-runs' || token.startsWith('--max-active-runs=')
                ? 'max-active-runs'
                : null;
    if (token === '--abandon') {
      if (abandon) {
        io.stderr(`Repeated flag: ${token}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      abandon = true;
      continue;
    }
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--live') {
      live = true;
      continue;
    }
    if (flag === null) {
      io.stderr(`Unknown conductor start flag: ${token}\n${CONDUCTOR_HELP}\n`);
      return null;
    }
    if (seen.has(flag)) {
      io.stderr(`Repeated flag: --${flag}\n${CONDUCTOR_HELP}\n`);
      return null;
    }
    const value = readValue(token, index);
    if (value === null) {
      return null;
    }
    if (!token.includes('=')) {
      index += 1;
    }
    seen.add(flag);
    if (flag === 'brief-request') {
      flags.briefRequest = value;
      continue;
    }
    if (flag === 'tier') {
      const tier = positiveInt(value);
      if (tier === null || (tier !== 1 && tier !== 2)) {
        io.stderr(`--tier must be 1 or 2\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      flags.tier = tier;
      continue;
    }
    if (flag === 'run-id') {
      flags.runId = value;
      continue;
    }
    if (flag === 'max-active-runs') {
      const parsed = positiveInt(value);
      if (parsed === null || parsed > MAX_ACTIVE_RUNS_LIMIT) {
        io.stderr(`--max-active-runs requires a positive integer up to ${MAX_ACTIVE_RUNS_LIMIT}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      flags.maxActiveRuns = parsed;
      continue;
    }
    flags.attemptId = value;
  }
  return { maxActiveRuns: 1, ...flags, abandon, dryRun, live };
}

/**
 * `conductor start` (K7-D7): reserve capacity, prepare the run's worktree at
 * the reserved path, place the brief, record the first attempt and the run.
 * It runs no model and dispatches nothing; it takes no `--live`. Guarded, in
 * order: `--dry-run`/`--live` refused, a durable state directory required,
 * `policy.conductor.enabled` required (not for `--abandon`, which only
 * releases what an earlier start made). The halt marker is not consulted.
 */
async function startCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
): Promise<number> {
  const flags = readStartFlags(argv, io);
  if (flags === null) {
    return 2;
  }
  if (flags.dryRun) {
    io.stderr(`conductor start --dry-run is not supported\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  if (flags.live) {
    io.stderr(`conductor start takes no --live; --live names conductor run\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  // An in-memory start would leave a reservation and a worktree no later
  // command can find, so a durable state directory is required even for
  // --abandon.
  if (options.stateDir === undefined) {
    io.stderr(
      `conductor start needs a durable state directory (--state-dir or FLEET_STATE_DIR)\n${CONDUCTOR_HELP}\n`,
    );
    return 2;
  }
  const driver = buildDriverOf(runtime, options, flags.maxActiveRuns);
  if (flags.abandon) {
    if (!flags.runId || !flags.attemptId) {
      io.stderr(`conductor start --abandon needs both --run-id and --attempt-id\n${CONDUCTOR_HELP}\n`);
      return 2;
    }
    if (driver.start === null) {
      io.stderr(`conductor start --abandon has no start port in this driver\n${CONDUCTOR_HELP}\n`);
      return 2;
    }
    const nowIso = nowIsoOf(options);
    const result = await driver.start.abandonStart({
      runId: flags.runId,
      attemptId: flags.attemptId,
      nowIso,
    });
    io.stdout(`${JSON.stringify(result)}\n`);
    return exitFor(result);
  }
  if (!flags.abandon && driver.policy.enabled !== true) {
    // Checked before the brief file is read and before the start port is
    // called: a disabled conductor must not touch host state.
    io.stdout(`${JSON.stringify({ outcome: 'refused', reason: 'conductor-disabled' })}\n`);
    return 1;
  }
  if ((flags.runId === undefined) !== (flags.attemptId === undefined)) {
    io.stderr(`--run-id and --attempt-id are given together or not at all\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  if (flags.briefRequest === undefined) {
    io.stderr(`conductor start requires --brief-request <file>\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  if (flags.tier === undefined) {
    io.stderr(`conductor start requires --tier 1 or 2\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  const brief = readBriefRequest(flags.briefRequest, io);
  if (brief === null) {
    return 2;
  }
  const runId = flags.runId ?? 'run-' + runtime.conductor.newUlid();
  const attemptId = flags.attemptId ?? 'attempt-' + runtime.conductor.newUlid();
  if (RUN_ID_PATTERN.test(runId) === false || ATTEMPT_ID_PATTERN.test(attemptId) === false) {
    io.stderr(`--run-id and --attempt-id must be 'run-<ULID>' and 'attempt-<ULID>'\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  if (driver.start === null) {
    io.stderr(`conductor start has no start port in this driver\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  const result = await driver.start.startLaneRun({
    runId,
    attemptId,
    tier: flags.tier as 1 | 2,
    runPolicyRevision: driver.runPolicyRevision,
    brief: brief as never,
    nowIso: nowIsoOf(options),
  });
  if (result.outcome === 'incomplete') {
    io.stdout(
      `${JSON.stringify({
        outcome: 'incomplete',
        runId: result.runId,
        attemptId: result.attemptId,
        step: result.step,
        reason: result.reason,
        retry: `conductor start --brief-request ${flags.briefRequest} --tier ${flags.tier} --run-id ${result.runId} --attempt-id ${result.attemptId}${flags.maxActiveRuns !== undefined && flags.maxActiveRuns !== 1 ? ` --max-active-runs ${flags.maxActiveRuns}` : ''}`,
      })}\n`,
    );
    return 1;
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  // start's own outcome table: started completes; refused, no-capacity and
  // incomplete (handled above) exit 1.
  return result.outcome === 'started' ? 0 : 1;
}

/** The injected driver builder, or the live builder over the runtime's ports. */
function buildDriverOf(
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
  maxActiveRuns: number,
): ConductorDriver {
  return options.buildDriver !== undefined
    ? options.buildDriver(runtime, 'live', { maxActiveRuns })
    : buildLiveConductorDriver(runtime, { maxActiveRuns });
}

/** The clock override, or the system clock. */
function nowIsoOf(options: ConductorCliOptions): string {
  return options.now !== undefined ? options.now() : new Date().toISOString();
}

/** The `--brief-request` JSON payload: an object with no `worktreePath` and no `attemptId`. */
function readBriefRequest(filePath: string, io: CliIo): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    io.stderr(`--brief-request must be a readable JSON object file: ${filePath}\n${CONDUCTOR_HELP}\n`);
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    io.stderr(`--brief-request must be a readable JSON object file: ${filePath}\n${CONDUCTOR_HELP}\n`);
    return null;
  }
  const brief = parsed as Record<string, unknown>;
  if ('worktreePath' in brief || 'attemptId' in brief) {
    io.stderr(
      `--brief-request must not carry worktreePath or attemptId; the start use case sets both\n${CONDUCTOR_HELP}\n`,
    );
    return null;
  }
  return brief;
}

interface RunFlags {
  readonly live: boolean;
  readonly dryRun: boolean;
  readonly once: boolean;
  readonly maxActiveRuns: number;
}

/** `--max-active-runs` is a positive integer up to 64, default 1 (K7-D5). */
const MAX_ACTIVE_RUNS_LIMIT = 64;

/**
 * `conductor run`'s private flag reader: exactly one of `--live`/`--dry-run`,
 * `--once`, `--max-active-runs <n>`. An unknown flag, a repeated flag or a
 * positional is a usage error.
 */
function readRunFlags(argv: readonly string[], io: CliIo): RunFlags | null {
  let live = false;
  let dryRun = false;
  let once = false;
  let maxActiveRuns = 1;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const isMaxRuns = token === '--max-active-runs' || token.startsWith('--max-active-runs=');
    if (token === '--live') {
      if (live) {
        io.stderr(`Repeated flag: ${token}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      live = true;
      continue;
    }
    if (token === '--dry-run') {
      if (dryRun) {
        io.stderr(`Repeated flag: ${token}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      dryRun = true;
      continue;
    }
    if (token === '--once') {
      if (once) {
        io.stderr(`Repeated flag: ${token}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      once = true;
      continue;
    }
    if (isMaxRuns) {
      if (seen.has('max-active-runs')) {
        io.stderr(`Repeated flag: --max-active-runs\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      seen.add('max-active-runs');
      const value = token.includes('=')
        ? token.slice(token.indexOf('=') + 1)
        : argv[index + 1];
      if (token === '--max-active-runs') {
        index += 1;
      }
      const parsed = positiveInt(value);
      if (parsed === null || parsed > MAX_ACTIVE_RUNS_LIMIT) {
        io.stderr(`--max-active-runs requires a positive integer up to ${MAX_ACTIVE_RUNS_LIMIT}\n${CONDUCTOR_HELP}\n`);
        return null;
      }
      maxActiveRuns = parsed;
      continue;
    }
    io.stderr(`Unknown conductor run flag: ${token}\n${CONDUCTOR_HELP}\n`);
    return null;
  }
  return { live, dryRun, once, maxActiveRuns };
}

/**
 * `conductor run --live`: the driver. One pass at a time under the state
 * directory's driver lease, polling with back-off from 30 seconds to 2
 * minutes, printing one line per pass and each grace attention item once,
 * releasing its leases on SIGINT or SIGTERM. It refuses unless
 * `policy.conductor.enabled` is on, needs `--live` and a durable state
 * directory, and dispatches real lanes: it runs only with the owner's
 * explicit authority.
 */
async function runCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
): Promise<number> {
  const flags = readRunFlags(argv, io);
  if (flags === null) {
    return 2;
  }
  if (flags.live === flags.dryRun) {
    io.stderr(`conductor run takes exactly one of --live or --dry-run\n${CONDUCTOR_HELP}\n`);
    return 2;
  }
  if (flags.dryRun) {
    return await dryRunCommand(io, runtime, options, flags);
  }
  // An in-memory driver would dispatch with no durable record.
  if (options.stateDir === undefined) {
    io.stderr(
      `conductor run --live needs a durable state directory (--state-dir or FLEET_STATE_DIR)\n${CONDUCTOR_HELP}\n`,
    );
    return 2;
  }
  const driver =
    options.buildDriver !== undefined
      ? options.buildDriver(runtime, 'live', { maxActiveRuns: flags.maxActiveRuns })
      : buildLiveConductorDriver(runtime, { maxActiveRuns: flags.maxActiveRuns });
  if (driver.policy.enabled !== true) {
    io.stdout(`${JSON.stringify({ outcome: 'refused', reason: 'conductor-disabled' })}\n`);
    return 1;
  }
  const holderId = 'driver-' + runtime.conductor.newUlid();
  const seenAttention = new Set<string>();
  return await pollConductorPasses({
    driver,
    holderId,
    nowIso: () => nowIsoOf(options),
    sleep: options.sleep ?? defaultSleep,
    stopSignal: options.stopSignal,
    once: flags.once,
    eachPass: async (pass, result) => {
      io.stdout(`${JSON.stringify({ pass, ...result })}\n`);
      if (result.outcome === 'refused') {
        return { stop: true, exitCode: 1 };
      }
      for (const item of result.attention) {
        const key = `${item.runId}:${item.kind}`;
        if (seenAttention.has(key)) {
          continue;
        }
        seenAttention.add(key);
        io.stdout(`${JSON.stringify({ attention: item.kind, runId: item.runId })}\n`);
      }
      return { stop: false };
    },
  });
}

/** The outcome of one pass in the shared poll loop: stop, and the exit code to carry. */
interface PollPassOutcome {
  readonly stop: boolean;
  readonly exitCode?: number;
}

/**
 * The shared poll loop of `conductor run`: one pass at a time under the
 * driver lease, printing one line per pass through `eachPass`, polling with
 * back-off from 30 seconds to 2 minutes, releasing its leases on SIGINT or
 * SIGTERM. `eachPass` returns whether the loop should stop and an exit code.
 */
async function pollConductorPasses(options: {
  readonly driver: ConductorDriver;
  readonly holderId: string;
  readonly nowIso: () => string;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly stopSignal?: AbortSignal;
  readonly once: boolean;
  readonly eachPass: (pass: number, result: RunConductorPassResult) => Promise<PollPassOutcome>;
}): Promise<number> {
  const controller = new AbortController();
  const signal = options.stopSignal ?? controller.signal;
  const onSignal = (): void => {
    controller.abort();
  };
  let signalHandlersBound = false;
  if (options.stopSignal === undefined) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    signalHandlersBound = true;
  }
  let exitCode = 0;
  let previousDelay: number | null = null;
  try {
    for (let pass = 1; ; pass += 1) {
      const result = await options.driver.pass.runPass({
        holderId: options.holderId,
        nowIso: options.nowIso(),
      });
      const outcome = await options.eachPass(pass, result);
      if (outcome.exitCode !== undefined) {
        exitCode = outcome.exitCode;
      }
      if (outcome.stop) {
        break;
      }
      if (options.once) {
        break;
      }
      if (result.outcome !== 'refused') {
        previousDelay = nextPollDelayMs(previousDelay, result.progressed);
      }
      await options.sleep(previousDelay ?? MIN_POLL_MS, signal);
      if (signal.aborted) {
        break;
      }
    }
  } finally {
    await options.driver.pass.releaseLeases({
      holderId: options.holderId,
      nowIso: options.nowIso(),
    });
    if (signalHandlersBound) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
  return exitCode;
}

/** The state files a dry-run copies into its scratch directory; a missing file is skipped. */
const DRY_RUN_STORE_FILES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'run-journal.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
] as const;

/** True when an error is a missing source file (skipped, never a failure). */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** The scratch adapters of a dry-run: on `scratchDir`, or in-memory without one. */
function storesForScratch(scratchDir: string | null): DryRunStores {
  const stateDir = scratchDir ?? undefined;
  return {
    runRepo: new LaneRunRepositoryAdapter({ stateDir }),
    runJournal: new LaneRunJournalAdapter({ stateDir }),
    attemptRepo: new AttemptRepositoryAdapter({ stateDir }),
    executionJournal: new ExecutionJournalAdapter({ stateDir }),
    workOrderRepo: new WorkOrderRepositoryAdapter({ stateDir }),
    driverLease: new ConductorDriverLeaseAdapter({ stateDir }),
    halt: new ConductorHaltAdapter({ stateDir }),
  };
}

/** Every run-journal entry of the scratch stores, in deterministic order. */
async function scratchJournalEntries(stores: DryRunStores): Promise<readonly LaneRunJournalEntryRecord[]> {
  const runs = await stores.runRepo.list();
  const entries: LaneRunJournalEntryRecord[] = [];
  for (const record of runs) {
    entries.push(...(await stores.runJournal.listForRun(record.runId)));
  }
  return entries.sort(
    (left, right) =>
      left.recordedAtIso.localeCompare(right.recordedAtIso) ||
      left.entryId.localeCompare(right.entryId),
  );
}

/**
 * Print the entries a pass appended: each intent as a `would <action>` line
 * with its result's outcome and reason code, and each conduct entry as an
 * `entered` line. The output never prints a path.
 */
function printDryRunAppendedLines(io: CliIo, appended: readonly LaneRunJournalEntryRecord[]): void {
  const resultsByKey = new Map<string, LaneRunJournalEntryRecord>();
  for (const entry of appended) {
    if (entry.kind === 'result' && entry.key !== null && !resultsByKey.has(entry.key)) {
      resultsByKey.set(entry.key, entry);
    }
  }
  for (const entry of appended) {
    if (entry.kind === 'intent' && entry.key !== null) {
      const parsed = parseLaneRunKey(entry.key);
      const step = parsed !== null && parsed.kind === 'step' ? parsed.step : null;
      const result = resultsByKey.get(entry.key);
      io.stdout(
        `${JSON.stringify({
          would: step,
          key: entry.key,
          result: result?.outcome ?? null,
          reasonCode: result?.reasonCode ?? null,
        })}\n`,
      );
    } else if (entry.kind === 'conduct') {
      io.stdout(`${JSON.stringify({ entered: entry.state, runId: entry.runId })}\n`);
    }
  }
}

/**
 * `conductor run --dry-run` (K7-8): copy the state stores into a fresh scratch
 * directory and drive them with recording fakes, printing what the driver
 * would do. It acts on nothing: no `policy.conductor.enabled` check, no
 * `--live`, and the real state files are never opened for writing. Without a
 * state directory it runs over empty in-memory stores. The scratch directory
 * is removed before returning, and the output never prints a path.
 */
async function dryRunCommand(
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
  flags: RunFlags,
): Promise<number> {
  let scratchDir: string | null = null;
  try {
    if (options.stateDir !== undefined) {
      scratchDir = await mkdtemp(join(tmpdir(), 'fleet-v2-conductor-dry-run-'));
      const copyFile = options.copyFile ?? fsCopyFile;
      for (const file of DRY_RUN_STORE_FILES) {
        const source = join(options.stateDir, file);
        try {
          await copyFile(source, join(scratchDir, file));
        } catch (error) {
          if (isEnoent(error)) {
            continue;
          }
          io.stderr(`conductor run --dry-run could not copy the state stores\n${CONDUCTOR_HELP}\n`);
          return 1;
        }
      }
    }
    const stores = storesForScratch(scratchDir);
    const driver = buildDryRunConductorDriver(stores, {
      maxActiveRuns: flags.maxActiveRuns,
      nowIso: () => nowIsoOf(options),
    });
    const holderId = 'driver-' + runtime.conductor.newUlid();
    let currentEntryIds = new Set<string>();
    const refreshEntryIds = async (): Promise<void> => {
      const entries = await scratchJournalEntries(stores);
      currentEntryIds = new Set(entries.map((entry) => entry.entryId));
    };
    await refreshEntryIds();
    return await pollConductorPasses({
      driver,
      holderId,
      nowIso: () => nowIsoOf(options),
      sleep: options.sleep ?? defaultSleep,
      stopSignal: options.stopSignal,
      once: flags.once,
      eachPass: async (pass, result) => {
        const after = await scratchJournalEntries(stores);
        const appended = after.filter((entry) => !currentEntryIds.has(entry.entryId));
        printDryRunAppendedLines(io, appended);
        currentEntryIds = new Set(after.map((entry) => entry.entryId));
        io.stdout(`${JSON.stringify({ pass, ...result })}\n`);
        return {
          stop: result.outcome === 'refused',
          exitCode: result.outcome === 'refused' ? 1 : undefined,
        };
      },
    });
  } finally {
    if (scratchDir !== null) {
      await fsRm(scratchDir, { recursive: true, force: true });
    }
  }
}

/** `fleet-v2 conductor <subcommand>` dispatch. */
export async function conductorCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || argv[1] === '--help' || argv[1] === '-h') {
    io.stdout(`${CONDUCTOR_HELP}\n`);
    return 0;
  }
  // The two driver-side subcommands read their own flags (K7-7); the four
  // record-only ones share the control reader below.
  if (subcommand === 'start') {
    return await startCommand(argv.slice(1), io, runtime, options);
  }
  if (subcommand === 'run') {
    return await runCommand(argv.slice(1), io, runtime, options);
  }
  const parsed = readControlOptions(argv.slice(1), io);
  if (parsed === null) {
    return 2;
  }
  const { force, lift, revision, positionals } = parsed;
  const shape = SUBCOMMAND_SHAPE[subcommand];
  if (shape !== undefined) {
    const misplaced =
      (force && !shape.force ? '--force' : null) ??
      (lift && !shape.lift ? '--lift' : null) ??
      (revision !== undefined && !shape.revision ? '--revision' : null);
    if (misplaced !== null) {
      io.stderr(`conductor ${subcommand} does not take ${misplaced}\n${CONDUCTOR_HELP}\n`);
      return 2;
    }
    if (shape.runId === 'none' && positionals.length > 0) {
      io.stderr(`conductor ${subcommand} takes no run id\n${CONDUCTOR_HELP}\n`);
      return 2;
    }
    // A halt, stop or resume is a record the driver obeys later: in-memory stores would report success for a
    // record that vanishes when this process exits (a halt that is no kill switch).
    if (shape.writes && options.stateDir === undefined) {
      io.stderr(`conductor ${subcommand} needs a durable state directory (--state-dir or FLEET_STATE_DIR)\n${CONDUCTOR_HELP}\n`);
      return 2;
    }
  }
  const nowIso = options.now !== undefined ? options.now() : new Date().toISOString();
  const conductor = runtime.conductor;
  switch (subcommand) {
    case 'status': {
      const runId = positionals[0];
      const result = await conductor.inspectLaneRuns.inspectLaneRuns({
        nowIso,
        ...(runId !== undefined ? { runId } : {}),
      });
      io.stdout(`${JSON.stringify(result)}\n`);
      return exitFor(result);
    }
    case 'halt': {
      const result = await conductor.halt.set({ halted: !lift, nowIso });
      const printed =
        result.outcome === 'refused'
          ? result
          : {
              outcome: 'recorded',
              halted: result.record.halted,
              changed: result.outcome === 'changed',
            };
      io.stdout(`${JSON.stringify(printed)}\n`);
      return result.outcome === 'refused' ? 1 : 0;
    }
    case 'stop': {
      const runId = positionals[0];
      if (runId === undefined) {
        io.stderr(`conductor stop requires a run id\n${CONDUCTOR_HELP}\n`);
        return 2;
      }
      const result = await conductor.requestLaneRunStop.requestLaneRunStop({
        runId,
        mode: force ? 'force' : 'graceful',
        via: 'cli',
        entryId: conductor.newUlid(),
        nowIso,
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
      });
      io.stdout(`${JSON.stringify(result)}\n`);
      return exitFor(result);
    }
    case 'resume': {
      const runId = positionals[0];
      if (runId === undefined) {
        io.stderr(`conductor resume requires a run id\n${CONDUCTOR_HELP}\n`);
        return 2;
      }
      const result = await conductor.resumeLaneRun.requestResume({
        runId,
        via: 'cli',
        entryId: conductor.newUlid(),
        nowIso,
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
      });
      io.stdout(`${JSON.stringify(result)}\n`);
      return exitFor(result);
    }
    default:
      io.stderr(`Unknown conductor subcommand: ${subcommand === '' ? '(none)' : subcommand}\n${CONDUCTOR_HELP}\n`);
      return 2;
  }
}
