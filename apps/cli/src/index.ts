/**
 * Fleet CLI driver: the operator-facing application boundary across the four
 * bounded contexts. Subcommands map one JSON payload (or `--kebab-case` flags)
 * onto one application port call and print the typed result to stdout as one
 * JSON document.
 *
 * Exit codes: 0 for completed operations, 1 for refusal-family results and
 * unexpected errors, 2 for usage errors. All I/O goes through the injected
 * `CliIo`, so package code never touches `console`.
 */

import { resolve } from 'node:path';

import { resolveInstallationHostForRole } from '@fleet/work-execution';

import {
  loadInstallation,
  type HostSection,
  type LoadResult,
} from '@fleet/installation';
import type {
  DoctorLine,
  DoctorProbes,
  HostProbeExecutor,
  HostProbeSpec,
} from '@fleet/onboarding';
import {
  boundDoctorDetail,
  createNodeDoctorExecutor,
  createNodeDoctorProbes,
  doctorExitCode,
  probeHost,
  runDoctor,
} from '@fleet/onboarding';

import {
  createFleetCliRuntime,
  resolveRunnerSettings,
  type FleetCliRuntime,
} from './composition.js';
import { hostsCommand, type HostsCliOptions } from './hosts.js';
import { seatsCommand, type SeatsCliOptions } from './seats.js';
import { policyCommand, type PolicyCliOptions } from './policy.js';
import { initCommand, type InitCliOptions } from './init.js';
import { projectsCommand, type ProjectsCliOptions } from './projects.js';
import { stateCommand, stateDoctorLine, type StateCliOptions } from './state.js';
import { conductorCommand, type ConductorCliOptions } from './conductor.js';
import { telemetryCommand, type TelemetryCliOptions } from './telemetry.js';
import {
  CliUsageError,
  NON_ZERO_OUTCOMES,
  QUESTIONS_POSITIONAL_SUBCOMMANDS,
  type Payload,
  type CommandHandler,
} from './commands/payload.js';
import { decisionsCommands } from './commands/decisions.js';
import { workOrderCommands } from './commands/work-order.js';
import { briefCommands } from './commands/brief.js';
import { capacityCommands } from './commands/capacity.js';
import { attemptCommands } from './commands/attempt.js';
import { forgeCommands } from './commands/forge.js';
import { evidenceCommands } from './commands/evidence.js';
import { knowledgeCommands } from './commands/knowledge.js';
import { coordinationCommands } from './commands/coordination.js';
import { questionsCommands } from './commands/questions.js';

export { resolveRunnerSettings };

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Default process-stream I/O; used by `main` and any caller omitting `io`. */
const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};



/**
 * A line-oriented command result: one stdout line per record instead of one
 * JSON document. The `outcome` field keeps the shared exit-code contract.
 */
interface CliPerLineResult {
  readonly outcome?: string;
  readonly lines: readonly unknown[];
}

function isPerLineResult(result: unknown): result is CliPerLineResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { lines?: unknown }).lines)
  );
}

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Options for `parseFlags`; only the `questions` id subcommands opt in today. */
interface ParseFlagsOptions {
  /**
   * Collect bare positional tokens (the question id) under the `positional`
   * key instead of refusing them; handlers that read `positional` validate it.
   */
  readonly allowPositional?: boolean;
}

/**
 * Parse remaining tokens into a payload: flags first, `--json` overlay last.
 * Bare positional tokens are a usage error unless `allowPositional` is set,
 * so a mistyped argument never silently disappears.
 */
function parseFlags(tokens: readonly string[], options?: ParseFlagsOptions): Payload {
  const payload: Payload = {};
  const positionals: string[] = [];
  let jsonPayload: Payload | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      const raw = tokens[index + 1];
      if (raw === undefined) {
        throw new CliUsageError('--json requires a JSON payload argument');
      }
      index += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new CliUsageError(
          `--json payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CliUsageError('--json payload must be a JSON object');
      }
      jsonPayload = parsed as Payload;
      continue;
    }
    if (!token.startsWith('--') || token === '--') {
      if (options?.allowPositional === true) {
        positionals.push(token);
        continue;
      }
      throw new CliUsageError(`Unexpected argument: ${token}`);
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const key = kebabToCamel(separator === -1 ? body : body.slice(0, separator));
    if (separator !== -1) {
      payload[key] = body.slice(separator + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      payload[key] = true;
      continue;
    }
    payload[key] = next;
    index += 1;
  }
  if (jsonPayload !== undefined) {
    Object.assign(payload, jsonPayload);
  }
  if (positionals.length > 0) {
    payload['positional'] = positionals;
  }
  return payload;
}
/**
 * Strip the global `--state-dir <path>` / `--state-dir=<path>` option from any
 * position so it never reaches group dispatch or `parseFlags`, falling back to
 * the `FLEET_STATE_DIR` environment value when the flag is omitted. Valid
 * paths are normalized with `path.resolve`; a missing, empty or malformed
 * value is a usage error.
 */
export function extractStateDirOption(
  argv: readonly string[],
  envStateDir?: string,
): { readonly stateDir?: string; readonly restArgv: readonly string[] } {
  let stateDir: string | undefined;
  const restArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--state-dir') {
      const value = argv[index + 1];
      index += 1;
      if (
        value === undefined ||
        value.trim() === '' ||
        value.startsWith('--') ||
        value.includes('\0')
      ) {
        throw new CliUsageError('Invalid --state-dir value');
      }
      stateDir = resolve(value);
      continue;
    }
    if (token.startsWith('--state-dir=')) {
      const value = token.slice('--state-dir='.length);
      if (value.trim() === '' || value.startsWith('--') || value.includes('\0')) {
        throw new CliUsageError('Invalid --state-dir value');
      }
      stateDir = resolve(value);
      continue;
    }
    restArgv.push(token);
  }
  if (stateDir === undefined) {
    const fromEnv = envStateDir?.trim();
    if (fromEnv !== undefined && fromEnv !== '') {
      stateDir = resolve(fromEnv);
    }
  }
  return { stateDir, restArgv };
}

/**
 * The process exit code for one command result: an outcome in
 * NON_ZERO_OUTCOMES is a refusal-family exit (1), anything else completes
 * (0). Exported for the CLI's exit-code tests, like the helpers around it.
 */
export function exitCodeForResult(result: unknown, group?: string, subcommand?: string): number {
  if (typeof result === 'object' && result !== null && 'outcome' in result) {
    const outcome = (result as { outcome: unknown }).outcome;
    if (typeof outcome === 'string') {
      // `questions wait` reports the settled lifecycle state itself: answered
      // and acknowledged complete the wait, while rejected, expired and
      // timeout are refusal-family exits with the state named in the body.
      if (group === 'questions' && subcommand === 'wait') {
        return outcome === 'answered' || outcome === 'acknowledged' ? 0 : 1;
      }
      if (NON_ZERO_OUTCOMES.has(outcome)) return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Command table. Each handler builds one typed request from the payload; the
// use case owns every behavioural decision.
// ---------------------------------------------------------------------------

const COMMANDS: Readonly<Record<string, Readonly<Record<string, CommandHandler>>>> = {
  decisions: decisionsCommands,
  'work-order': workOrderCommands,
  brief: briefCommands,
  capacity: capacityCommands,
  attempt: attemptCommands,
  forge: forgeCommands,
  evidence: evidenceCommands,
  knowledge: knowledgeCommands,
  coordination: coordinationCommands,
  questions: questionsCommands,
};

// ---------------------------------------------------------------------------
// `doctor`: read-only installation checks with real probes
// ---------------------------------------------------------------------------

export interface DoctorCliOptions {
  /**
   * Pre-loaded installation; the existing loader composes one when omitted.
   * A `missing` or `invalid` result is refused with exit 1, never checked.
   */
  readonly loadResult?: LoadResult;
  /** Probe implementation; the node probes compose one when omitted. */
  readonly probes?: DoctorProbes;
  /**
   * Argv executor for `doctor --host` (the host probe subset and the
   * leftover-forward check); the node doctor executor composes when omitted.
   */
  readonly hostProbeExecutor?: HostProbeExecutor;
  /** The resolved state directory; when set, doctor adds one state-files line. */
  readonly stateDir?: string;
}

const DOCTOR_HELP = `Usage: fleet-v2 doctor [--probe-seats] [--host <name>] [--json]

Read-only checks over the loaded installation: hosts and roles, platform
tools, configured tool versions, credential file modes (never contents), the
bundled ocm-run hash and each configured seat. With a state directory selected
(--state-dir or FLEET_STATE_DIR) it adds one line for the JSON state stores
(see fleet-v2 state check).

  --probe-seats  run each seat's one-step probe (a live model call). Seat
                 probes run from the operator's machine — the host running
                 fleet-v2 doctor — never on a remote host.
  --host <name>  run only that host's probe subset from the installation's
                 hosts entry (reachability, tool versions, worktree root,
                 loopback server, declared capabilities, the auth file),
                 plus one check for a leftover forward on a port no
                 configured host owns; never together with --probe-seats
  --json         print one JSON document per doctor line

Exit codes: 0 all PASS, 1 any FAIL or UNKNOWN — and also a missing or invalid
installation, which doctor refuses to check — 2 usage error. Without
--probe-seats every seat is reported UNKNOWN, so doctor exits 1 whenever the
installation defines seats.`;

/** Parse doctor's own flags; `--json` here selects output shape, not a payload. */
function parseDoctorFlags(tokens: readonly string[]): {
  probeSeats: boolean;
  json: boolean;
  host?: string;
} {
  let probeSeats = false;
  let json = false;
  let host: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--probe-seats') {
      probeSeats = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--host' || token.startsWith('--host=')) {
      const value = token === '--host' ? tokens[index + 1] : token.slice('--host='.length);
      if (value === undefined || value.trim() === '' || value.startsWith('--')) {
        throw new CliUsageError(`--host requires a host name\n${DOCTOR_HELP}`);
      }
      if (token === '--host') {
        index += 1;
      }
      host = value;
      continue;
    }
    throw new CliUsageError(`Unknown doctor option: ${token}\n${DOCTOR_HELP}`);
  }
  if (host !== undefined && probeSeats) {
    throw new CliUsageError(
      `doctor --host runs one host's probes; --probe-seats belongs to the full doctor run\n${DOCTOR_HELP}`,
    );
  }
  return { probeSeats, json, host };
}

export function formatDoctorLine(doctorLine: DoctorLine): string {
  return `${doctorLine.status} ${doctorLine.scope} ${doctorLine.subject} ${doctorLine.check} — ${doctorLine.detail}`;
}

/** Run one probe; a throw becomes `undefined` and reports as unknown. */
async function probeSafely(
  run: () => Promise<{ exitCode: number | null; error?: string }>,
): Promise<{ exitCode: number | null; error?: string } | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

/**
 * One line for a leftover forward on a port no configured host owns: the
 * port next to the named host's runner port that the configuration does not
 * dial (an ssh host dials `port + 1` here, a local host dials `port` there
 * directly), checked on the orchestrator's loopback, where `ocm-run` leaves
 * `ssh -f -N` forwards behind. Nothing is removed; the detail says how to
 * close it by hand.
 */
async function unownedForwardLine(
  name: string,
  hosts: Readonly<Record<string, HostSection>>,
  executor: HostProbeExecutor,
): Promise<DoctorLine | undefined> {
  const runner = hosts[name]?.runner;
  if (runner === undefined) {
    return undefined;
  }
  const owned = new Set<number>();
  for (const host of Object.values(hosts)) {
    if (host.runner !== undefined) {
      owned.add(host.transport === 'local' ? host.runner.port : host.runner.port + 1);
    }
  }
  const port = [runner.port, runner.port + 1].find((candidate) => !owned.has(candidate));
  if (port === undefined) {
    return undefined;
  }
  const result = await probeSafely(() =>
    executor.run(['nc', '-z', '127.0.0.1', String(port)], { timeoutMs: 5_000 }),
  );
  const base = {
    scope: 'host' as const,
    subject: name,
    check: 'unowned-forward',
  };
  if (result === undefined) {
    return {
      ...base,
      status: 'UNKNOWN',
      detail: boundDoctorDetail(`127.0.0.1:${port}: the leftover-forward check could not be run`),
    };
  }
  if (result.error !== undefined) {
    return {
      ...base,
      status: 'UNKNOWN',
      detail: boundDoctorDetail(
        `127.0.0.1:${port}: the leftover-forward check could not be run (${result.error})`,
      ),
    };
  }
  if (result.exitCode === 0) {
    return {
      ...base,
      status: 'FAIL',
      detail: boundDoctorDetail(
        `127.0.0.1:${port} is listening but no configured host owns it; if it is a leftover ssh -f -N forward, close it: pgrep -f 'ssh .*-L 127.0.0.1:${port}' then kill the pid`,
      ),
    };
  }
  return {
    ...base,
    status: 'PASS',
    detail: boundDoctorDetail(
      `nothing is listening on 127.0.0.1:${port}, which no configured host owns`,
    ),
  };
}

/**
 * `doctor --host <name>` (plan section 4): the named host's own probe subset
 * through the engine's probe plan, plus the leftover-forward check. The exit
 * code is doctor's own: 0 only when every line passed.
 */
async function doctorHostCommand(
  hostName: string,
  loadResult: Exclude<LoadResult, { status: 'invalid' }>,
  io: CliIo,
  json: boolean,
  executor: HostProbeExecutor,
): Promise<number> {
  const installation = loadResult.installation;
  if (installation.schemaVersion !== 2 || installation.hosts === undefined) {
    io.stderr('doctor --host needs a schema version 2 installation with named hosts\n');
    return 1;
  }
  const hosts = installation.hosts;
  const hostEntry = Object.hasOwn(hosts, hostName) ? hosts[hostName] : undefined;
  if (hostEntry === undefined) {
    io.stderr(`no host named '${hostName}' is configured in the installation\n`);
    return 1;
  }
  const laneRunnerName = resolveInstallationHostForRole(installation, 'lane-runner');
  const laneRunnerHost = laneRunnerName !== undefined ? hosts[laneRunnerName] : undefined;
  const runner = hostEntry.runner;
  const spec: HostProbeSpec = {
    name: hostName,
    transport: hostEntry.transport,
    ...(hostEntry.sshAlias !== undefined ? { sshAlias: hostEntry.sshAlias } : {}),
    worktreeRoot: hostEntry.worktreeRoot,
    ...(hostEntry.tmpDir !== undefined ? { tmpDir: hostEntry.tmpDir } : {}),
    ...(hostEntry.roles.includes('lane-runner') ? { isLaneRunner: true } : {}),
    ...(runner !== undefined
      ? {
          runner: {
            kind: runner.kind,
            port: runner.port,
            ...(runner.authFile !== undefined ? { authFile: runner.authFile } : {}),
            ...(runner.capabilities !== undefined
              ? { capabilities: runner.capabilities }
              : {}),
            ...(runner.gateSlot !== undefined ? { gateSlot: runner.gateSlot } : {}),
          },
        }
      : {}),
    ...(hostEntry.roles.includes('verifier') &&
    laneRunnerName !== undefined &&
    laneRunnerHost !== undefined
      ? {
          laneRunnerWorktreeRoot: {
            hostName: laneRunnerName,
            worktreeRoot: laneRunnerHost.worktreeRoot,
          },
        }
      : {}),
  };
  const lines = await probeHost(spec, executor);
  const unowned = await unownedForwardLine(hostName, hosts, executor);
  if (unowned !== undefined) {
    lines.push(unowned);
  }
  for (const doctorLine of lines) {
    io.stdout(json ? `${JSON.stringify(doctorLine)}\n` : `${formatDoctorLine(doctorLine)}\n`);
  }
  return doctorExitCode(lines);
}

/**
 * Run the doctor engine over the installation and print one line per check.
 * The exit code follows `doctorExitCode`: 0 only when every line passed. A
 * missing or invalid installation is refused with exit 1, not a usage error.
 */
function isHelpToken(token: string | undefined): boolean {
  return token === 'help' || token === '--help' || token === '-h';
}

export async function doctorCommand(
  argv: readonly string[],
  io: CliIo,
  options: DoctorCliOptions = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${DOCTOR_HELP}\n`);
    return 0;
  }
  const { probeSeats, json, host } = parseDoctorFlags(argv);
  const loadResult = options.loadResult ?? loadInstallation();
  if (loadResult.status === 'invalid') {
    io.stderr(`installation invalid (${loadResult.file}):\n`);
    for (const error of loadResult.errors) {
      io.stderr(`${error}\n`);
    }
    io.stderr('doctor refuses to run checks against an invalid installation\n');
    return 1;
  }
  if (loadResult.status === 'absent') {
    io.stderr('installation missing: doctor has no installation to check\n');
    return 1;
  }
  if (host !== undefined) {
    // One host's own probe subset, never the seat probes: those belong to
    // the full sweep and run from the operator's machine.
    const executor = options.hostProbeExecutor ?? createNodeDoctorExecutor();
    return doctorHostCommand(host, loadResult, io, json, executor);
  }
  const probes = options.probes ?? createNodeDoctorProbes();
  const lines: DoctorLine[] = [];
  for await (const doctorLine of runDoctor(loadResult, probes, {
    probeSeats,
    // H3b: the routing check inspects the operator's environment; the engine
    // itself never reads process.env.
    env: process.env,
  })) {
    lines.push(doctorLine);
    io.stdout(json ? `${JSON.stringify(doctorLine)}\n` : `${formatDoctorLine(doctorLine)}\n`);
  }
  if (options.stateDir !== undefined) {
    const stateLine = await stateDoctorLine(options.stateDir);
    lines.push(stateLine);
    io.stdout(json ? `${JSON.stringify(stateLine)}\n` : `${formatDoctorLine(stateLine)}\n`);
  }
  return doctorExitCode(lines);
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const QUESTIONS_HELP = `Usage: fleet-v2 questions <subcommand> [flags]

Owner questions the orchestrator asks the owner to answer. A two-way question
is answered here; a one-way question is answered only by the owner's signed
decision file for its linked request, which 'questions sync' and 'questions
wait' pick up. An answer records advice and unblocks; it grants nothing,
fires no action and touches no coordination request.

  ask --file <path>              record one new question from a JSON file
                                 carrying questionId, askedBy, title, body,
                                 options, recommendation, and optionally
                                 doorKind ('two-way' is the only door this
                                 CLI can answer), linkedRequestId, blocks
                                 and expiresAt
  list [--state <s>] [--since <iso>]
                                 list questions, optionally only one state
                                 (open, answered, rejected, expired,
                                 acknowledged) and/or asked at or after an
                                 ISO timestamp with an explicit zone
                                 (e.g. 2026-10-16T08:00:00Z or +02:00)
  show <id>                      print one question's full record
  answer <id> --revision <n>     answer a two-way question at the revision
                                 you saw, with exactly one of:
    --accept                       record the recommended option
    --reject [--reason <text>]     reject it, with an optional reason
    --option <id> [--text <text>]  answer with another option and free text
  sync                           re-read every open one-way question's linked
                                 signed decision and settle answered/rejected
  expire                         move open two-way questions past their
                                 expiry to expired; they stay blocking and
                                 are re-asked, never dropped
  acknowledge <id> --by <name>   record that the asker acted on the answer
  wait <id> [--max 30m] [--interval 15s]
                                 poll until the question settles, syncing
                                 one-way questions each round; exits 0
                                 answered/acknowledged, 1 rejected/expired/
                                 timeout (the JSON body says which)

Durations take a unit of ms, s, m or h. Exit codes: 0 completed,
1 refused/rejected/blocked/unknown/not-found, 2 usage error.`;

const HELP_TEXT = `fleet-v2 — Fleet CLI operator driver across the four bounded contexts.

Usage: fleet-v2 [--state-dir <path>] <command> <subcommand> [--json '<payload>'] [--flag value ...]

Global state option: --state-dir <path> (or the FLEET_STATE_DIR environment
variable) selects the directory that backs durable CLI state; it may appear
in any position, and every store is in-memory when neither is given.

Pass the full typed request as one JSON object with --json, or supply fields
as --kebab-case flags (arrays as comma-separated values). The typed result
prints to stdout as one JSON document.

doctor prints one check per line (JSON documents with --json). Without
--probe-seats every seat is UNKNOWN, so doctor exits 1 when seats exist.
doctor --host <name> prints only that host's probe subset.

The hosts group manages the installation file's named hosts: list, add,
edit and remove, each write confirmed and compare-and-swapped.

The seats group lists the installation file's seats, checks them with the
loader and the doctor's seat probes (seats list, seats check), and shows or
changes policy.useFreeSeats: seats free-tier status|on|off, each change
confirmed and compare-and-swapped.

The policy group shows or changes policy.autoMerge: policy auto-merge status|on|off,
each change confirmed and compare-and-swapped.

The projects group lists, shows, probes, registers, adopts, edits and retires
project profiles; every change is confirmed unless --yes is given.

init sets up a fresh installation file non-interactively (every step is a
flag); run 'fleet-v2 init --help' for its flags.

state check reads every JSON state store under the state directory and reports
ok, missing, unreadable or invalid record per file; it never writes. state
restore replaces a missing or unreadable store from a quarantine copy after
confirmation; it is CLI only.

A seat plan lists ordered seats per role (first-pass, fix, review). brief
prepare --seatPlanFromInstallation builds it from the installation's chains;
attempt fix rotates to the next eligible fix seat and skips seats whose
health is unhealthy; attempt next-seat --role fix|review shows the next one.

The conductor group shows lane runs and records a halt, a run stop or a
resume; the driver obeys the records. Run 'fleet-v2 conductor --help'.

The telemetry group exports run telemetry spans (a run, a work order or a
time window) to the collector route, or prints them with a dry run, and shows
the configuration status. Run 'fleet-v2 telemetry --help'.

Commands:
  work-order register|inspect|close|stale|rerun
  doctor [--probe-seats] [--host <name>] [--json]
  hosts list|add|edit|remove
  seats list|check|free-tier [status|on|off] [--yes]
  policy auto-merge [status|on|off] [--allow-high-risk true|false] [--on-blocked ask-owner|hold] [--yes]
  projects list|show|probe|add|adopt|edit|retire
  init [--profile single|multi] [--tools <a,b>] ... [--yes]
  state check|restore
  conductor status|halt|stop|resume|start|run
  telemetry export|status
  brief prepare --acceptanceSpec '<json>' [--allowedPathPrefixes '["packages/x/src"]'] [--seatPlan '<json>' | --seatPlanFromInstallation]
  capacity reserve
  attempt dispatch|reconcile|stop|collect|usage|fix|next-seat|accept|auto-merge|cancel-prepared
  forge execute
  evidence request-verification|record-verification|request-review|record-review|disposition|assess|inspect
  knowledge capture-notes|check-claim|decide|publish|propose-context|select-context|candidates|record-reuse|supersede
  decisions report --consumer knowledge-ranking
  coordination register-profile|capabilities|request-decision|resolve-auth|consume-auth|publish-observation|attention|attention-items|attention-dismiss|send-relay|ack-relay|outstanding
  questions ask|list|show|answer|sync|expire|acknowledge|wait
  help | --help

Exit codes: 0 completed, 1 refused/rejected/blocked/unknown result, 2 usage error.`;

/** UTF-16 code-unit order: identical to the default sort(), stated explicitly (Sonar S2871). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function groupHelp(group: string): string {
  const subcommands = Object.keys(COMMANDS[group] ?? {}).sort(compareCodeUnits);
  return `Usage: fleet-v2 ${group} <subcommand> [--json '<payload>'] [--flag value ...]\nSubcommands: ${subcommands.join(', ')}\nSee: fleet-v2 --help`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
  runtime?: FleetCliRuntime,
  doctorOptions?: DoctorCliOptions,
  hostsOptions?: HostsCliOptions,
  initOptions?: InitCliOptions,
  seatsOptions?: SeatsCliOptions,
  projectsOptions?: ProjectsCliOptions,
  stateOptions?: StateCliOptions,
  conductorOptions?: ConductorCliOptions,
  policyOptions?: PolicyCliOptions,
  telemetryOptions?: TelemetryCliOptions,
): Promise<number> {
  try {
    const { stateDir, restArgv } = extractStateDirOption(argv, process.env.FLEET_STATE_DIR);
    if (restArgv.length === 0) {
      io.stderr(`${HELP_TEXT}\n`);
      return 2;
    }
    // The doctor reads the installation itself and refuses a missing or
    // invalid one with exit 1; it never composes the state-backed runtime.
    const group = restArgv[0];
    if (group === 'doctor') {
      return await doctorCommand(restArgv.slice(1), io, { ...doctorOptions, stateDir: doctorOptions?.stateDir ?? stateDir });
    }
    // The hosts group manages the installation file itself on the shared
    // onboarding engine; it reads the file and composes only the state-backed
    // stores remove's live-work check needs.
    if (group === 'hosts') {
      const hostsStateDir = hostsOptions?.stateDir ?? stateDir;
      return await hostsCommand(restArgv.slice(1), io, { ...hostsOptions, stateDir: hostsStateDir });
    }
    // `init` manages the installation file itself on the shared onboarding
    // engine; it reads the file and composes no state-backed stores.
    if (group === 'init') {
      return await initCommand(restArgv.slice(1), io, initOptions ?? {});
    }
    // The seats group manages the free-tier flag on the shared onboarding engine.
    if (group === 'seats') {
      return await seatsCommand(restArgv.slice(1), io, seatsOptions ?? {});
    }
    // The policy group manages the auto-merge policy on the shared onboarding engine.
    if (group === 'policy') {
      return await policyCommand(restArgv.slice(1), io, policyOptions ?? {});
    }
    // `state` reads the store files directly and never composes the runtime
    // or loads the installation; it is CLI-only (owner decision D4).
    if (group === 'state') {
      return await stateCommand(restArgv.slice(1), io, { ...stateOptions, stateDir: stateOptions?.stateDir ?? stateDir });
    }
    // The questions group carries its own help block; a help request never
    // composes the runtime and never counts as a usage error.
    if (
      group === 'questions' &&
      // Only the help positions count (`questions --help`, `questions answer --help`):
      // a free-text flag value such as `--reason -h` must never be read as help.
      (isHelpToken(restArgv[1]) || (restArgv.length === 3 && isHelpToken(restArgv[2])))
    ) {
      io.stdout(`${QUESTIONS_HELP}\n`);
      return 0;
    }
    // An explicitly injected runtime stays authoritative; only a call without
    // one composes a fresh runtime bound to the resolved state directory.
    let activeRuntime: FleetCliRuntime;
    if (runtime !== undefined) {
      activeRuntime = runtime;
    } else {
      const loadResult = loadInstallation();
      if (loadResult.status === 'invalid') {
        io.stderr(`installation invalid (${loadResult.file}):\n`);
        for (const error of loadResult.errors) {
          io.stderr(`${error}\n`);
        }
        return 2;
      }
      activeRuntime = createFleetCliRuntime({
        stateDir,
        installation: loadResult.installation,
      });
    }
    // The projects group manages its profiles through the composed runtime
    // (the state-backed pattern), not the installation file itself.
    if (group === 'projects') {
      return await projectsCommand(restArgv.slice(1), io, activeRuntime, projectsOptions ?? {});
    }
    if (group === 'conductor') {
      return await conductorCommand(restArgv.slice(1), io, activeRuntime, {
        ...conductorOptions,
        stateDir: conductorOptions?.stateDir ?? stateDir,
      });
    }
    if (group === 'telemetry') {
      return await telemetryCommand(restArgv.slice(1), io, activeRuntime, telemetryOptions ?? {});
    }
    if (group === 'help' || group === '--help' || group === '-h') {
      io.stdout(`${HELP_TEXT}\n`);
      return 0;
    }
    const subcommands = COMMANDS[group];
    if (subcommands === undefined) {
      io.stderr(`Unknown command: ${group}\nRun 'fleet-v2 --help' for the available commands.\n`);
      return 2;
    }
    let subcommand: string | null = null;
    let rest: readonly string[] = [];
    if (restArgv.length > 1 && !restArgv[1].startsWith('--')) {
      subcommand = restArgv[1];
      rest = restArgv.slice(2);
    } else {
      rest = restArgv.slice(1);
    }
    if (subcommand === null) {
      io.stderr(`${groupHelp(group)}\n`);
      return 2;
    }
    const handler = subcommands[subcommand];
    if (handler === undefined) {
      io.stderr(`Unknown ${group} subcommand: ${subcommand}\n${groupHelp(group)}\n`);
      return 2;
    }
    // `questions` id subcommands and `knowledge candidates` take one bare
    // positional id; every other group keeps the strict flags-only shape.
    const allowPositional =
      (group === 'questions' && QUESTIONS_POSITIONAL_SUBCOMMANDS.has(subcommand)) ||
      (group === 'knowledge' && subcommand === 'candidates');
    const payload = parseFlags(rest, { allowPositional });
    const result = await handler(payload, activeRuntime);
    // Line-oriented outputs (`knowledge candidates`, `decisions report`)
    // print one line per record instead of one JSON document; a refusal
    // carries no lines and falls back to the JSON document that names it.
    if (isPerLineResult(result) && result.lines.length > 0) {
      for (const line of result.lines) {
        io.stdout(`${line}\n`);
      }
    } else {
      io.stdout(`${JSON.stringify(result)}\n`);
    }
    return exitCodeForResult(result, group, subcommand);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Process entry point. Runs the CLI against the real argument vector and
 * process streams and carries the exit code through `process.exitCode`.
 */
export function main(): void {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

