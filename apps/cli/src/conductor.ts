/**
 * `fleet-v2 conductor` (lane K7-4): the four record-only subcommands
 * `status`, `halt`, `stop` and `resume`, with no driver and no dispatch.
 * Each prints one JSON document on stdout and maps the use case's outcome to
 * an exit code (0 completed, 1 refused/rejected/blocked/unknown, 2 usage):
 * the halt marker is set or lifted, a stop is recorded as a keyed journal
 * intent the driver obeys, a resume is recorded for a parked run. Nothing
 * here takes a run lease or dispatches anything.
 */

import type { FleetCliRuntime } from './composition.js';
import type { CliIo } from './index.js';

export interface ConductorCliOptions {
  /** Clock override for tests; production uses the system clock. */
  readonly now?: () => string;
  /** The resolved state directory (`--state-dir` / `FLEET_STATE_DIR`); undefined = in-memory stores. */
  readonly stateDir?: string;
}

export const CONDUCTOR_HELP = `Usage: fleet-v2 conductor status [<runId>]
       fleet-v2 conductor halt [--lift]
       fleet-v2 conductor stop <runId> [--force] [--revision <n>]
       fleet-v2 conductor resume <runId> [--revision <n>]

Read-only status of one lane run (or every run) with its projected state,
the halt marker and the driver lease; a kill-switch halt the driver checks
before any external action (halt --lift clears it); halt never stops a running
lane; a stop recorded as a keyed run-journal intent — stop is graceful by
default, --force stops the running lane now; a resume recorded for a parked
run. The driver obeys the records; nothing here dispatches, and the CLI
never takes a run lease.

Each subcommand prints one JSON document on stdout.

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
