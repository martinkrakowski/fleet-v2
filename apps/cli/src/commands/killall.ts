/**
 * `fleet-v2 killall` (lane KA2): the KILLALL control over the merge train and
 * the lane servers (plan §6). One command writes the killall halt marker by
 * its own record, pauses the merge train by a record beside the verification
 * pause, asks the stop agent (KA3, in another repository; unavailable here) to
 * force-stop every running lane, and prints the validated stop report.
 * `--lift` clears the train pause then the marker, fail closed. All I/O goes
 * through the injected `CliIo`; no value, path or payload is ever echoed, and
 * every adapter call's exceptions are converted to fixed reason codes here
 * rather than reaching the CLI's generic error handler.
 */

import {
  KillallHaltMarkerAdapter,
  KillallStopAgentUnavailableAdapter,
  KillallTrainPauseAdapter,
  killallStopReportConfirmed,
  readKillallStopReportRecord,
  type KillallHaltMarkerPort,
  type KillallStopAgentPort,
  type KillallStopReportRecord,
  type KillallTrainPausePort,
} from '@fleet/work-execution';

import type { CliIo } from '../index.js';

export interface KillallCliOptions {
  /** Clock override for tests; production uses the system clock. */
  readonly now?: () => string;
  /** The resolved state directory (`--state-dir` / `FLEET_STATE_DIR`); undefined = not durable. */
  readonly stateDir?: string;
  /** The stop agent port; tests inject a fake, production gets the unavailable adapter. */
  readonly stopAgent?: KillallStopAgentPort;
}

export const KILLALL_HELP = `Usage: fleet-v2 killall [--lift]

Stop every running lane, pause the merge train and set the killall halt marker
(plan §6): one record marks the killall halt, another pauses the train by its
own record beside the verification pause, and the stop agent (KA3) force-stops
every running lane and reports each confirmed or unconfirmed; the report lists
the train separately. --lift clears the train pause then the marker, fail
closed; it is the only way to lift a killall halt.

Exit codes: 0 completed (halt: marker, train pause and every lane sweep
confirmed; lift: pause and marker cleared), 1 refused/blocked/unknown/
unconfirmed, 2 usage error.`;

/** A fixed refusal document, printed on a failed write; never an echo. */
function refusal(reason: string): { readonly outcome: 'refused'; readonly reason: string } {
  return { outcome: 'refused', reason };
}

/** The current time: the injected clock, or the system clock. */
function nowIso(options: KillallCliOptions): string {
  return options.now !== undefined ? options.now() : new Date().toISOString();
}

/**
 * The halt flow (plan §6: marker first, then the train pause, then the stop
 * agent, then the report). Any earlier failure stops the sequence and exits 1.
 */
async function haltFlow(
  io: CliIo,
  options: KillallCliOptions,
  haltMarker: KillallHaltMarkerPort,
  trainPause: KillallTrainPausePort,
  stopAgent: KillallStopAgentPort,
): Promise<number> {
  // (a) The marker first, with a fresh clock.
  let markerSet: Awaited<ReturnType<KillallHaltMarkerPort['set']>>;
  try {
    markerSet = await haltMarker.set({ halted: true, nowIso: nowIso(options) });
  } catch {
    io.stdout(`${JSON.stringify(refusal('marker-write-failed'))}\n`);
    return 1;
  }
  if (markerSet.outcome === 'refused') {
    io.stdout(`${JSON.stringify(markerSet)}\n`);
    return 1;
  }
  const haltedAtIso = markerSet.record.changedAtIso;

  // (b) The train pause next, with its own fresh clock.
  let pauseSet: Awaited<ReturnType<KillallTrainPausePort['set']>>;
  try {
    pauseSet = await trainPause.set({ paused: true, nowIso: nowIso(options) });
  } catch {
    io.stdout(`${JSON.stringify(refusal('pause-write-failed'))}\n`);
    return 1;
  }
  if (pauseSet.outcome === 'refused') {
    io.stdout(`${JSON.stringify(pauseSet)}\n`);
    return 1;
  }

  // (c) Ask the stop agent with the already-recorded marker time.
  let agent: Awaited<ReturnType<KillallStopAgentPort['stop']>>;
  try {
    agent = await stopAgent.stop({ haltedAtIso });
  } catch {
    agent = { ok: false, reason: 'transport-error' };
  }
  if (!agent.ok) {
    const report: KillallStopReportRecord = {
      version: 1,
      haltedAtIso,
      marker: 'halted',
      cleanSweeps: 0,
      lanes: [],
      train: { paused: true, acknowledged: false, unconfirmedReason: 'sweep-unreachable' },
    };
    io.stdout(`${JSON.stringify(report)}\n`);
    return 1;
  }

  // (d) Validate the agent's raw payload; a malformed payload is fixed text, never the payload.
  const read = readKillallStopReportRecord(agent.payload);
  if (!read.ok) {
    io.stdout(`${JSON.stringify(refusal('stop agent report unreadable'))}\n`);
    return 1;
  }
  const confirmed = killallStopReportConfirmed(read.record);
  io.stdout(
    `${JSON.stringify({
      outcome: 'completed',
      marker: 'halted',
      train: pauseSet.record,
      report: read.record,
      confirmed,
    })}\n`,
  );
  return confirmed ? 0 : 1;
}

/** The lift flow: clear the train pause, then the marker; a refusal leaves it halted. */
async function liftFlow(
  io: CliIo,
  options: KillallCliOptions,
  haltMarker: KillallHaltMarkerPort,
  trainPause: KillallTrainPausePort,
): Promise<number> {
  // (a) Clear the train pause first, with a fresh clock.
  let pauseSet: Awaited<ReturnType<KillallTrainPausePort['set']>>;
  try {
    pauseSet = await trainPause.set({ paused: false, nowIso: nowIso(options) });
  } catch {
    io.stdout(`${JSON.stringify(refusal('pause-write-failed'))}\n`);
    return 1;
  }
  if (pauseSet.outcome === 'refused') {
    io.stdout(`${JSON.stringify(pauseSet)}\n`);
    return 1;
  }

  // (b) Then clear the marker, with its own fresh clock.
  let markerSet: Awaited<ReturnType<KillallHaltMarkerPort['set']>>;
  try {
    markerSet = await haltMarker.set({ halted: false, nowIso: nowIso(options) });
  } catch {
    io.stdout(`${JSON.stringify(refusal('marker-write-failed'))}\n`);
    return 1;
  }
  if (markerSet.outcome === 'refused') {
    io.stdout(`${JSON.stringify(markerSet)}\n`);
    return 1;
  }

  io.stdout(`${JSON.stringify({ outcome: 'completed', marker: 'clear', train: 'clear' })}\n`);
  return 0;
}

/**
 * `fleet-v2 killall` dispatch. `argv` holds everything after the `killall`
 * group word: nothing (halt) or `--lift`; anything else is a usage error.
 */
export async function killallCommand(
  argv: readonly string[],
  io: CliIo,
  options: KillallCliOptions = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${KILLALL_HELP}\n`);
    return 0;
  }
  const lift = argv.length === 1 && argv[0] === '--lift';
  if (argv.length > 0 && !lift) {
    io.stderr(`${KILLALL_HELP}\n`);
    return 2;
  }
  if (options.stateDir === undefined || options.stateDir.trim() === '') {
    io.stderr('killall requires a durable state directory\n');
    return 2;
  }
  const haltMarker = new KillallHaltMarkerAdapter({ stateDir: options.stateDir });
  const trainPause = new KillallTrainPauseAdapter({ stateDir: options.stateDir });
  const stopAgent = options.stopAgent ?? new KillallStopAgentUnavailableAdapter();
  if (lift) {
    return liftFlow(io, options, haltMarker, trainPause);
  }
  return haltFlow(io, options, haltMarker, trainPause, stopAgent);
}
