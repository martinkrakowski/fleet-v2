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

  list       print every seat declared in the installation file
  check      run the loader and the doctor's seat probes over each seat
  free-tier  show or change policy.useFreeSeats (see 'fleet-v2 seats free-tier --help')

Exit codes: 0 shown or healthy, 1 refused or failing, 2 usage error.`;

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
