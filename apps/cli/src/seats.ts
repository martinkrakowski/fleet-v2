/**
 * `fleet-v2 seats`: list the installation file's seats, check them with the
 * loader and the doctor's seat probes, and show or change
 * `policy.useFreeSeats` (`seats free-tier`, free-seat plan FS4, F1 and F8).
 * The flag's rules come from the onboarding engine's `draftFreeTier`; this
 * module owns only argument handling and output, and every write goes
 * through the shared compare-and-swap `confirmAndWrite`. There is no
 * `--force`.
 */

import {
  createNodeDoctorProbes,
  doctorExitCode,
  draftFreeTier,
  renderFreeTierImpact,
  renderFreeTierStatus,
  runDoctor,
  summariseFreeTier,
  type DoctorLine,
  type DoctorProbes,
  type FreeTierAction,
} from "@fleet/onboarding";
import {
  loadInstallation,
  resolveInstallationFile,
  type LoadResult,
  type SeatSection,
} from "@fleet/installation";
import {
  confirmAndWrite,
  printDiff,
  printErrors,
  readInstallationState,
} from "./hosts.js";
import { formatDoctorLine, type CliIo } from "./index.js";
import type { RecordSeatObservationPort } from "@fleet/work-execution";

/** Options the driver and tests inject; every default composes the real thing. */
export interface SeatsCliOptions {
  /** Installation file; the loader's own resolution applies when omitted. */
  readonly installationFile?: string;
  /**
   * The confirmation gate for a write. The default reads one line from
   * stdin and accepts only an explicit y/yes; a declined or closed stdin
   * refuses the write.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Probe implementation for `seats check`; the node probes compose when omitted. */
  readonly probes?: DoctorProbes;
  /**
   * SR6: the observation recorder behind `seats observe`; the composed
   * runtime supplies it, and tests inject their own. Help needs none.
   */
  readonly recordSeatObservation?: RecordSeatObservationPort;
}

const SEATS_HELP = `Usage: fleet-v2 seats free-tier [status|on|off] [--yes]

Show or change policy.useFreeSeats in the v2 installation file. Absent means
on. off writes useFreeSeats: false; on removes it. Every change prints which
seats are enabled or disabled and how many seats each role keeps, shows the
file diff, asks y/N (unless --yes) and writes with compare-and-swap. A change
that would leave a role with no seat is refused. Schema version 1 files have
no policy: migrate to v2 first.

  status   print the setting, the free seats and each role's seats in use
  on       use free seats (removes useFreeSeats: false)
  off      do not use free seats (writes useFreeSeats: false)

off then on restores a file byte for byte only when the file was already in
the writer's canonical form (the first write normalises formatting).

The API reads the file once at start: a change takes effect for the API after
it restarts; CLI dispatches use it at once.

Exit codes: 0 shown, written or already so, 1 refused, 2 usage error.
There is no --force.`;

type ParsedSeatsArgs =
  | {
      readonly ok: true;
      readonly help: boolean;
      readonly action: FreeTierAction | "status";
      readonly yes: boolean;
    }
  | { readonly ok: false; readonly error: string };

const SEATS_GROUP_HELP = `Usage: fleet-v2 seats list | check | free-tier [status|on|off] [--yes]
                | observe --seat <seatId> --outcome <outcome>
                          (--attempt <attemptId> | --review-request <reviewRequestId>)
                          [--observation-id <id>] [--observed-at <iso>] [--dry-run]

  list       print every seat declared in the installation file
  check      run the loader and the doctor's seat probes over each seat
  free-tier  show or change policy.useFreeSeats (see 'fleet-v2 seats free-tier --help')
  observe    record one seat observation from outside the runner (SR6; see
             'fleet-v2 seats observe --help')

Exit codes: 0 shown, recorded or healthy, 1 refused or failing, 2 usage error.`;

/** The `observe` flags, with whether each takes a value. */
const OBSERVE_FLAGS: Readonly<Record<string, boolean>> = {
  seat: true,
  outcome: true,
  attempt: true,
  "review-request": true,
  "observation-id": true,
  "observed-at": true,
  "dry-run": false,
};

const OBSERVE_HELP = `Usage: fleet-v2 seats observe --seat <seatId> --outcome <outcome>
                              (--attempt <attemptId> | --review-request <reviewRequestId>)
                              [--observation-id <id>] [--observed-at <iso>] [--dry-run]

Record one observation of a seat refusal seen outside fleet's runner (plan
§3.5.5). Exactly one subject is required: --attempt names a running attempt
whose committed seat is --seat, or --review-request names a brief-check,
code-review or pre-merge review request whose committed seat is --seat.
--outcome is one of: rate-limited, payment, timeout, model-missing, no-route,
empty-response. --observed-at defaults to now; --observation-id defaults to a
fresh id. A subject that already carries a result or receipt, a seat
mismatch or an unknown id is refused; nothing is written and no attempt or
installation health is ever changed. --dry-run validates and writes nothing.

Exit codes: 0 recorded, duplicate or dry run, 1 refused, 2 usage error.`;

type ParsedObserveArgs =
  | { readonly ok: true; readonly help: true }
  | {
      readonly ok: true;
      readonly help: false;
      readonly seatId: string;
      readonly outcome: string;
      readonly attemptId?: string;
      readonly reviewRequestId?: string;
      readonly observationId?: string;
      readonly observedAt?: string;
      readonly dryRun: boolean;
    }
  | { readonly ok: false; readonly error: string };

/** Parse one `seats observe` invocation; every problem is a usage message. */
function parseObserveArgs(tokens: readonly string[]): ParsedObserveArgs {
  const values: {
    seatId?: string;
    outcome?: string;
    attemptId?: string;
    reviewRequestId?: string;
    observationId?: string;
    observedAt?: string;
    dryRun: boolean;
  } = { dryRun: false };
  const set = (flag: string, value: string): string | null => {
    if (flag === "seat") {
      if (values.seatId !== undefined) return "seat";
      values.seatId = value;
      return null;
    }
    if (flag === "outcome") {
      if (values.outcome !== undefined) return "outcome";
      values.outcome = value;
      return null;
    }
    if (flag === "attempt") {
      if (values.attemptId !== undefined) return "attempt";
      values.attemptId = value;
      return null;
    }
    if (flag === "review-request") {
      if (values.reviewRequestId !== undefined) return "review-request";
      values.reviewRequestId = value;
      return null;
    }
    if (flag === "observation-id") {
      if (values.observationId !== undefined) return "observation-id";
      values.observationId = value;
      return null;
    }
    if (values.observedAt !== undefined) return "observed-at";
    values.observedAt = value;
    return null;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isHelpToken(token)) {
      return { ok: true, help: true };
    }
    if (!token.startsWith("--") || token === "--") {
      return { ok: false, error: `Unexpected argument: ${token}\n${OBSERVE_HELP}` };
    }
    const body = token.slice(2);
    const separator = body.indexOf("=");
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
    if (!(flag in OBSERVE_FLAGS)) {
      return { ok: false, error: `Unknown seats observe option: --${flag}\n${OBSERVE_HELP}` };
    }
    if (!OBSERVE_FLAGS[flag]) {
      if (inlineValue !== undefined) {
        return { ok: false, error: `--${flag} takes no value\n${OBSERVE_HELP}` };
      }
      values.dryRun = true;
      continue;
    }
    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      index += 1;
      const next = tokens[index];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, error: `--${flag} requires a value\n${OBSERVE_HELP}` };
      }
      value = next;
    }
    const repeated = set(flag, value);
    if (repeated !== null) {
      return { ok: false, error: `--${repeated} was given twice\n${OBSERVE_HELP}` };
    }
  }
  if (values.seatId === undefined) {
    return { ok: false, error: `--seat is required\n${OBSERVE_HELP}` };
  }
  if (values.outcome === undefined) {
    return { ok: false, error: `--outcome is required\n${OBSERVE_HELP}` };
  }
  if (values.attemptId !== undefined && values.reviewRequestId !== undefined) {
    return {
      ok: false,
      error: `--attempt and --review-request are mutually exclusive\n${OBSERVE_HELP}`,
    };
  }
  if (values.attemptId === undefined && values.reviewRequestId === undefined) {
    return {
      ok: false,
      error: `exactly one of --attempt or --review-request is required\n${OBSERVE_HELP}`,
    };
  }
  return {
    ok: true,
    help: false,
    seatId: values.seatId,
    outcome: values.outcome,
    ...(values.attemptId !== undefined ? { attemptId: values.attemptId } : {}),
    ...(values.reviewRequestId !== undefined ? { reviewRequestId: values.reviewRequestId } : {}),
    ...(values.observationId !== undefined ? { observationId: values.observationId } : {}),
    ...(values.observedAt !== undefined ? { observedAt: values.observedAt } : {}),
    dryRun: values.dryRun,
  };
}

/** `seats observe`: record one observation through the execution stack (SR6). */
async function observeSeat(
  argv: readonly string[],
  io: CliIo,
  options: SeatsCliOptions,
): Promise<number> {
  const parsed = parseObserveArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${OBSERVE_HELP}\n`);
    return 0;
  }
  const recorder = options.recordSeatObservation;
  if (recorder === undefined) {
    io.stderr("seat observation recording is not wired; this build composes no runtime\n");
    return 1;
  }
  const result = await recorder.execute(
    {
      seatId: parsed.seatId,
      outcome: parsed.outcome,
      ...(parsed.attemptId !== undefined
        ? { subject: { attemptId: parsed.attemptId } }
        : { subject: { reviewRequestId: parsed.reviewRequestId as string } }),
      ...(parsed.observationId !== undefined ? { observationId: parsed.observationId } : {}),
      ...(parsed.observedAt !== undefined ? { observedAtIso: parsed.observedAt } : {}),
    },
    "cli",
    { dryRun: parsed.dryRun },
  );
  io.stdout(`${JSON.stringify(result)}\n`);
  return result.outcome === "refused" ? 1 : 0;
}

function isHelpToken(token: string): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

/** Parse one seats invocation; every problem is a usage message, never a guess. */
function parseSeatsArgs(tokens: readonly string[]): ParsedSeatsArgs {
  if (tokens.some(isHelpToken)) {
    return { ok: true, help: true, action: "status", yes: false };
  }
  if (tokens[0] !== "free-tier") {
    return {
      ok: false,
      error: `Unknown seats subcommand: ${tokens[0] ?? "(none)"}\n${SEATS_HELP}`,
    };
  }
  let action: FreeTierAction | "status" = "status";
  let actionGiven = false;
  let yes = false;
  for (const token of tokens.slice(1)) {
    if (!token.startsWith("--") || token === "--") {
      if (actionGiven) {
        return {
          ok: false,
          error: `Unexpected argument: ${token}\n${SEATS_HELP}`,
        };
      }
      if (token !== "status" && token !== "on" && token !== "off") {
        return {
          ok: false,
          error: `Unknown free-tier action: ${token}\n${SEATS_HELP}`,
        };
      }
      action = token;
      actionGiven = true;
      continue;
    }
    const body = token.slice(2);
    const separator = body.indexOf("=");
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : body.slice(separator + 1);
    if (flag !== "yes") {
      return {
        ok: false,
        error: `Unknown seats free-tier option: --${flag}\n${SEATS_HELP}`,
      };
    }
    if (inlineValue !== undefined) {
      return { ok: false, error: `--yes takes no value\n${SEATS_HELP}` };
    }
    yes = true;
  }
  if (yes && action === "status") {
    return {
      ok: false,
      error: `--yes applies to on and off only\n${SEATS_HELP}`,
    };
  }
  return { ok: true, help: false, action, yes };
}

/** `seats free-tier status`: print the setting, free seats and role counts. */
async function showFreeTierStatus(file: string, io: CliIo): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr("the installation file is invalid; fix it by hand:\n");
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "absent") {
    io.stdout("no installation file; free-tier: on (the default)\n");
    return 0;
  }
  if (state.status === "v1") {
    io.stdout(
      "free-tier: on (schema version 1 has no policy section; migrate to v2 to change it)\n",
    );
    return 0;
  }
  for (const line of renderFreeTierStatus(summariseFreeTier(state.installation))) {
    io.stdout(`${line}\n`);
  }
  return 0;
}

/** `seats free-tier on|off`: draft, diff, confirm and compare-and-swap write. */
async function changeFreeTier(
  file: string,
  action: FreeTierAction,
  yes: boolean,
  io: CliIo,
  options: SeatsCliOptions,
): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr(
      "the installation file is invalid; fix it by hand before changing free-tier:\n",
    );
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "absent") {
    if (action === "off") {
      io.stderr("no installation file; run fleet-v2 init first\n");
      return 1;
    }
    io.stdout(
      "free-tier is already on (no installation file); nothing was written\n",
    );
    return 0;
  }
  if (state.status === "v1") {
    if (action === "off") {
      io.stderr(
        "the installation file is schema version 1, which has no policy section; migrate to v2 before turning free seats off\n",
      );
      return 1;
    }
    io.stdout("free-tier is already on (schema version 1); nothing was written\n");
    return 0;
  }

  const draft = draftFreeTier(state.value, action);
  if (draft.status === "invalid") {
    io.stderr(
      "the installation file is invalid; fix it by hand before changing free-tier:\n",
    );
    printErrors(io, draft.errors);
    return 1;
  }
  if (draft.status === "unchanged") {
    io.stdout(`free-tier is already ${action}; nothing was written\n`);
    return 0;
  }

  if (draft.after !== undefined) {
    for (const line of renderFreeTierImpact(draft.before, draft.after)) {
      io.stdout(`${line}\n`);
    }
  }
  if (draft.errors.length > 0) {
    io.stderr("refused: the installation would be invalid with this change:\n");
    printErrors(io, draft.errors);
    printDiff(
      io,
      state.read.status === "read" ? state.read.text : "",
      draft.candidate,
    );
    io.stderr("nothing was written\n");
    return 1;
  }

  const code = await confirmAndWrite(
    file,
    state.read,
    draft.candidate,
    { yes },
    io,
    { confirm: options.confirm },
  );
  if (code === 0) {
    io.stdout(
      "takes effect for the API after it restarts; CLI dispatches use it at once\n",
    );
  }
  return code;
}

/** One line of `seats list`: the seat's identity, routing and health. */
function renderSeatLine(seat: SeatSection): string {
  const model =
    seat.variant === undefined ? seat.model : `${seat.model}#${seat.variant}`;
  const agent = seat.agent === undefined ? "" : ` agent=${seat.agent}`;
  return `${seat.id}  tool=${seat.tool} model=${model}${agent} roles=${seat.roles.join(",")} cost=${seat.costClass} health=${seat.health ?? "healthy"}`;
}

/** `seats list`: one line per seat of the installation file, in file order. */
async function listSeats(file: string, io: CliIo): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr("the installation file is invalid; fix it by hand:\n");
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "absent") {
    io.stderr("no installation file; run fleet-v2 init first\n");
    return 1;
  }
  if (state.status === "v1") {
    io.stdout("schema version 1 has no seats section; migrate to v2\n");
    return 0;
  }
  const seats = state.installation.seats ?? [];
  if (seats.length === 0) {
    io.stdout("no seats declared\n");
    return 0;
  }
  for (const seat of seats) {
    io.stdout(`${renderSeatLine(seat)}\n`);
  }
  return 0;
}

/** `seats check`: the loader's verdict plus the doctor's seat probes. */
async function checkSeats(
  file: string,
  io: CliIo,
  options: SeatsCliOptions,
): Promise<number> {
  const loadResult: LoadResult = loadInstallation({ file });
  if (loadResult.status === "invalid") {
    io.stderr(`installation invalid (${file}):\n`);
    printErrors(io, loadResult.errors);
    return 1;
  }
  if (loadResult.status === "absent") {
    io.stderr("no installation file; run fleet-v2 init first\n");
    return 1;
  }
  const probes = options.probes ?? createNodeDoctorProbes();
  const seatLines: DoctorLine[] = [];
  for await (const doctorLine of runDoctor(loadResult, probes, {
    probeSeats: true,
    probeServers: false,
    env: process.env,
  })) {
    if (doctorLine.scope !== "seat") {
      continue;
    }
    seatLines.push(doctorLine);
    io.stdout(`${formatDoctorLine(doctorLine)}\n`);
  }
  if (seatLines.length === 0) {
    io.stdout("no seats declared\n");
    return 0;
  }
  return doctorExitCode(seatLines);
}

/** `seats free-tier`: the pre-existing subcommand, unchanged. */
async function freeTierCommand(
  argv: readonly string[],
  io: CliIo,
  options: SeatsCliOptions,
): Promise<number> {
  const parsed = parseSeatsArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${SEATS_HELP}\n`);
    return 0;
  }
  const file =
    options.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());
  return parsed.action === "status"
    ? showFreeTierStatus(file, io)
    : changeFreeTier(file, parsed.action, parsed.yes, io, options);
}

/** `fleet-v2 seats <subcommand>`; exit codes: 0 shown/written, 1 refused, 2 usage. */
export async function seatsCommand(
  argv: readonly string[],
  io: CliIo,
  options: SeatsCliOptions = {},
): Promise<number> {
  const [head, ...rest] = argv;
  if (head === undefined) {
    io.stderr(`no seats subcommand\n${SEATS_GROUP_HELP}\n`);
    return 2;
  }
  if (isHelpToken(head)) {
    io.stdout(`${SEATS_GROUP_HELP}\n`);
    return 0;
  }
  if (head === "free-tier") {
    return freeTierCommand(argv, io, options);
  }
  if (head === "observe") {
    return observeSeat(rest, io, options);
  }
  if (head !== "list" && head !== "check") {
    io.stderr(`Unknown seats subcommand: ${head}\n${SEATS_GROUP_HELP}\n`);
    return 2;
  }
  if (rest.some((token) => !isHelpToken(token))) {
    io.stderr(`Unexpected argument for seats ${head}\n${SEATS_GROUP_HELP}\n`);
    return 2;
  }
  if (rest.length > 0) {
    io.stdout(`${SEATS_GROUP_HELP}\n`);
    return 0;
  }
  const file =
    options.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());
  return head === "list" ? listSeats(file, io) : checkSeats(file, io, options);
}
