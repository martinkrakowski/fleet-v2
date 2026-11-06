/**
 * `fleet-v2 daemon tick|status|pause|resume` (lane DT10b, daemon-tick plan
 * §3.1): the operator and scheduler entry points of the merge daemon. `tick`
 * runs one bounded tick, `status` reports the last tick's health read-only,
 * `pause` and `resume` write the pause marker.
 *
 * Output discipline: stdout and stderr carry ids, fixed reason codes, booleans,
 * timestamps and counts only. A usage error prints a fixed message and the help
 * text and never echoes a token, a value, a path or an error string. The
 * command never throws.
 *
 * Exit codes: 0 completed or healthy, 1 refused, unhealthy or unknown, 2 usage.
 */
import {
  DAEMON_MAX_BUDGET_SECONDS,
  computeTickDeadlineIso,
  isDaemonPaused,
  isZonedIsoDateTime,
  parseDaemonJobId,
} from '@fleet/work-execution';

import type { CliIo } from './index.js';
import type { FleetCliRuntime } from './composition.js';
import { toDaemonRepositoryRefs } from './composition/daemon.js';

export const DAEMON_HELP = `Usage: fleet-v2 daemon <subcommand> (state: --state-dir <dir> or FLEET_STATE_DIR)
  daemon tick [--budget-seconds <n>] [--job <id>]...   run one bounded tick
  daemon status [--json]                               report the last tick's health (read-only)
  daemon pause                                         pause the daemon
  daemon resume                                        resume the daemon
Exit codes: 0 completed or healthy, 1 refused, unhealthy or unknown, 2 usage error.`;

export interface DaemonCliOptions {
  readonly stateDir?: string;
  readonly now?: () => string;
}

const MAX_ARGV = 256;
const MAX_JOB_FILTER = 64;
const SUBCOMMANDS: readonly string[] = ['tick', 'status', 'pause', 'resume'];
const HELP_TOKENS: readonly string[] = ['help', '--help', '-h'];
const SAFE_REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A fixed reason code or the fallback: a reason that is not a short lowercase code is never printed. */
function safeReason(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_REASON_PATTERN.test(value) ? value : fallback;
}

/** True when argv asks for help: `help`, `--help`, `-h`, or `<subcommand> --help|-h` and nothing else. Never throws. */
export function daemonHelpRequested(argv: readonly string[]): boolean {
  try {
    if (!Array.isArray(argv) || argv.length === 0) {
      return false;
    }
    const first: unknown = argv[0];
    if (typeof first !== 'string') {
      return false;
    }
    if (HELP_TOKENS.includes(first)) {
      return true;
    }
    return SUBCOMMANDS.includes(first) && argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h');
  } catch {
    return false;
  }
}

/** True when argv is a dense array of at most 256 strings. Never throws. */
function isValidArgv(argv: unknown): argv is readonly string[] {
  try {
    if (!Array.isArray(argv) || argv.length > MAX_ARGV) {
      return false;
    }
    for (let index = 0; index < argv.length; index += 1) {
      if (!Object.hasOwn(argv, index) || typeof argv[index] !== 'string') {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

interface ParsedTickArgs {
  readonly budgetSeconds: number | undefined;
  readonly jobs: readonly string[];
}

/** Strict `tick` flags; null for any usage error. */
function parseTickArgs(args: readonly string[]): ParsedTickArgs | null {
  let budgetSeconds: number | undefined;
  const jobs: string[] = [];
  let seenJobs = 0;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    let name: string;
    let value: string | undefined;
    const equals = token.indexOf('=');
    if (token.startsWith('--') && equals > 0) {
      name = token.slice(0, equals);
      value = token.slice(equals + 1);
    } else {
      name = token;
      value = undefined;
    }
    if (name !== '--budget-seconds' && name !== '--job') {
      return null;
    }
    if (value === undefined) {
      index += 1;
      if (index >= args.length) {
        return null;
      }
      value = args[index];
    }
    if (name === '--budget-seconds') {
      if (budgetSeconds !== undefined || !/^[0-9]{1,5}$/.test(value)) {
        return null;
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > DAEMON_MAX_BUDGET_SECONDS) {
        return null;
      }
      budgetSeconds = parsed;
    } else {
      seenJobs += 1;
      if (seenJobs > MAX_JOB_FILTER || parseDaemonJobId(value) === null) {
        return null;
      }
      if (!jobs.includes(value)) {
        jobs.push(value);
      }
    }
  }
  return { budgetSeconds, jobs };
}

/** `status` accepts `--json` at most once and nothing else; null for a usage error. */
function parseStatusArgs(args: readonly string[]): { readonly json: boolean } | null {
  if (args.length === 0) {
    return { json: false };
  }
  return args.length === 1 && args[0] === '--json' ? { json: true } : null;
}

type ParsedDaemonArgs =
  | { readonly kind: 'tick'; readonly tick: ParsedTickArgs }
  | { readonly kind: 'status'; readonly json: boolean }
  | { readonly kind: 'pause' | 'resume' };

/** Checks that need no parsing: an exit code for invalid, empty, help and unknown-subcommand argv, else null. */
function preflight(argv: readonly string[], io: CliIo): number | null {
  if (!isValidArgv(argv)) {
    io.stderr(`Invalid daemon arguments\n${DAEMON_HELP}\n`);
    return 2;
  }
  if (argv.length === 0) {
    io.stderr(`${DAEMON_HELP}\n`);
    return 2;
  }
  if (daemonHelpRequested(argv)) {
    io.stdout(`${DAEMON_HELP}\n`);
    return 0;
  }
  if (!SUBCOMMANDS.includes(argv[0])) {
    io.stderr(`Unknown daemon subcommand\n${DAEMON_HELP}\n`);
    return 2;
  }
  return null;
}

/** The subcommand's own strict flags; null for a usage error. */
function parseSubcommandArgs(subcommand: string, args: readonly string[]): ParsedDaemonArgs | null {
  if (subcommand === 'tick') {
    const tick = parseTickArgs(args);
    return tick === null ? null : { kind: 'tick', tick };
  }
  if (subcommand === 'status') {
    const status = parseStatusArgs(args);
    return status === null ? null : { kind: 'status', json: status.json };
  }
  return args.length > 0 ? null : { kind: subcommand === 'pause' ? 'pause' : 'resume' };
}

/** Commands that write need a durable state directory, given by option or by the runtime. */
function hasDurableState(runtime: FleetCliRuntime, options?: DaemonCliOptions): boolean {
  return (typeof options?.stateDir === 'string' && options.stateDir.trim().length > 0) || runtime.daemon.durable;
}

interface DaemonClock {
  /** A fresh reading; the last good one when this reading fails; null before any good reading. */
  readonly readNow: () => string | null;
  /** A fresh reading only: null when the clock throws or answers an invalid time. Never a stale value. */
  readonly readFresh: () => string | null;
}

function createClock(runtime: FleetCliRuntime, options?: DaemonCliOptions): DaemonClock {
  let lastGoodNow: string | null = null;
  const readFresh = (): string | null => {
    try {
      const value: unknown = options?.now !== undefined ? options.now() : runtime.daemon.now();
      return typeof value === 'string' && isZonedIsoDateTime(value) ? value : null;
    } catch {
      return null;
    }
  };
  const readNow = (): string | null => {
    lastGoodNow = readFresh() ?? lastGoodNow;
    return lastGoodNow;
  };
  return { readNow, readFresh };
}

async function dispatch(
  parsed: ParsedDaemonArgs,
  io: CliIo,
  runtime: FleetCliRuntime,
  nowIso: string,
  clock: DaemonClock,
): Promise<number> {
  if (parsed.kind === 'tick') {
    return await runTick(io, runtime, parsed.tick, nowIso, clock.readFresh);
  }
  if (parsed.kind === 'status') {
    return await runStatus(io, runtime, parsed.json, nowIso);
  }
  return await runPause(io, runtime, parsed.kind === 'pause', nowIso);
}

export async function daemonCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options?: DaemonCliOptions,
): Promise<number> {
  try {
    const early = preflight(argv, io);
    if (early !== null) {
      return early;
    }
    const subcommand = argv[0];
    // Parse before anything else runs, so a usage error never depends on the stores or the clock.
    const parsed = parseSubcommandArgs(subcommand, argv.slice(1));
    if (parsed === null) {
      io.stderr(`Invalid daemon ${subcommand} arguments\n${DAEMON_HELP}\n`);
      return 2;
    }
    if (parsed.kind !== 'status' && !hasDurableState(runtime, options)) {
      io.stderr(
        `daemon ${subcommand} needs a durable state directory (--state-dir or FLEET_STATE_DIR)\n${DAEMON_HELP}\n`,
      );
      return 2;
    }
    const clock = createClock(runtime, options);
    const nowIso = clock.readNow();
    if (nowIso === null) {
      io.stdout(`${JSON.stringify({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' })}\n`);
      return 1;
    }
    return await dispatch(parsed, io, runtime, nowIso, clock);
  } catch {
    io.stderr('daemon command failed\n');
    return 1;
  }
}

async function runTick(
  io: CliIo,
  runtime: FleetCliRuntime,
  parsed: ParsedTickArgs,
  nowIso: string,
  readFresh: () => string | null,
): Promise<number> {
  const tickId = `tick-${runtime.daemon.newUlid()}`;
  const refuse = (reasonCode: string): number => {
    io.stdout(`${JSON.stringify({ outcome: 'refused', exitCode: 1, tickId, reasonCode })}\n`);
    return 1;
  };

  const policyAnswer = await runtime.daemon.mergePolicy.readMergePolicy().catch(() => null);
  if (policyAnswer === null || policyAnswer.outcome !== 'known') {
    return refuse(safeReason(policyAnswer?.reason, 'policy-unreadable'));
  }

  const budgetSeconds = parsed.budgetSeconds ?? policyAnswer.daemon.budgetSeconds;
  const deadlineIso = computeTickDeadlineIso(nowIso, budgetSeconds);
  if (deadlineIso === null) {
    return refuse('invalid-budget');
  }

  // Pause is checked before the probe: a paused tick never calls the forge. An unreadable marker is paused.
  let paused = true;
  try {
    paused = isDaemonPaused(await runtime.daemon.pause.read());
  } catch {
    paused = true;
  }
  const forgeReachable = paused ? false : await probeWithFreshClock(runtime, readFresh, deadlineIso);

  const result = await runtime.daemon.runDaemonTick
    .runTick({
      tickId,
      repositories: toDaemonRepositoryRefs(policyAnswer),
      budgetSeconds,
      deadlineIso,
      intervalSeconds: policyAnswer.daemon.intervalSeconds,
      settleSeconds: policyAnswer.daemon.settleSeconds,
      ...(parsed.jobs.length > 0 ? { jobFilter: parsed.jobs } : {}),
      forgeReachable,
    })
    .catch(() => null);
  if (result === null) {
    return refuse('tick-failed');
  }
  if (result.outcome === 'refused') {
    io.stdout(
      `${JSON.stringify({
        outcome: 'refused',
        exitCode: 1,
        tickId: result.tickId,
        reasonCode: safeReason(result.reasonCode, 'tick-failed'),
      })}\n`,
    );
    return 1;
  }
  io.stdout(
    `${JSON.stringify({
      outcome: 'completed',
      exitCode: result.exitCode,
      tickId: result.tickId,
      paused: result.status?.paused ?? false,
      halted: result.status?.halted ?? false,
      forgeReachable: result.status?.forgeReachable ?? null,
      jobCount: result.jobs.length,
      repositoryCount: result.status?.repositories.length ?? 0,
      jobs: result.jobs.map((job) => ({
        jobId: job.jobId,
        outcome: job.outcome,
        reasonCode: job.reasonCode,
      })),
    })}\n`,
  );
  return result.exitCode;
}

/**
 * The forge probe measured against a fresh clock reading. Fail closed: when the clock throws or answers an invalid
 * time the budget left is unknown, so the probe is skipped (the forge counts as unreachable), never run from the
 * command's start time.
 */
async function probeWithFreshClock(
  runtime: FleetCliRuntime,
  readFresh: () => string | null,
  deadlineIso: string,
): Promise<boolean> {
  const probeNow = readFresh();
  return probeNow === null ? false : await runtime.daemon.probeForge({ nowIso: probeNow, deadlineIso });
}

async function runStatus(io: CliIo, runtime: FleetCliRuntime, json: boolean, nowIso: string): Promise<number> {
  const result = await runtime.daemon.inspectDaemonStatus.inspectStatus({ nowIso });
  if (json) {
    if (result.outcome === 'ok') {
      io.stdout(
        `${JSON.stringify({
          outcome: 'ok',
          healthy: result.health.healthy,
          exitCode: result.exitCode,
          reasons: result.health.reasons,
          refusedJobIds: result.health.refusedJobIds,
          starvedJobIds: result.health.starvedJobIds,
          status: result.status,
        })}\n`,
      );
      return result.exitCode;
    }
    io.stdout(
      `${JSON.stringify({
        outcome: result.outcome,
        healthy: false,
        exitCode: 1,
        reasonCode: result.reasonCode,
        status: null,
      })}\n`,
    );
    return 1;
  }
  if (result.outcome !== 'ok') {
    io.stdout(`daemon status ${result.outcome} reason=${result.reasonCode}\n`);
    return 1;
  }
  const s = result.status;
  const reasons = result.health.reasons.length > 0 ? ` reasons=${result.health.reasons.join(',')}` : '';
  let text = `daemon ${result.health.healthy ? 'healthy' : 'unhealthy'} tick=${s.tickId} exit=${s.exitCode} paused=${s.paused} halted=${s.halted} forge=${s.forgeReachable ?? 'null'} jobs=${s.jobs.length} repos=${s.repositories.length}${reasons}\n`;
  for (const j of s.jobs) {
    text += `job ${j.jobId} outcome=${j.outcome} reason=${j.reasonCode ?? 'none'} budgetStreak=${j.consecutiveBudgetExhausted}\n`;
  }
  for (const r of s.repositories) {
    text += `repo ${r.repoDigest} queued=${r.queued} ready=${r.ready} parked=${r.parked} head=${r.headEntryId ?? 'none'} merged=${r.lastMergedHead12 ?? 'none'}\n`;
  }
  io.stdout(text);
  return result.exitCode;
}

async function runPause(io: CliIo, runtime: FleetCliRuntime, paused: boolean, nowIso: string): Promise<number> {
  const result = await runtime.daemon.setDaemonPause.setPause({ paused, nowIso });
  if (result.outcome === 'recorded') {
    io.stdout(
      `${JSON.stringify({ outcome: 'recorded', paused: result.record.paused, changedAtIso: result.record.changedAtIso })}\n`,
    );
    return 0;
  }
  io.stdout(`${JSON.stringify({ outcome: 'refused', reasonCode: result.reasonCode })}\n`);
  return 1;
}
