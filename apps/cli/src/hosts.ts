/**
 * `fleet-v2 hosts` (plan 2026-10-16_add-host.md, section 4): list, add, edit
 * and remove the named hosts of the v2 installation file, on the shared
 * onboarding engine (section 5). This module owns only argument handling and
 * output; every rule about the file comes from the engine and the loader:
 *
 * - drafts are built by `draftHost`, applied by `applyHostDraft` through
 *   `validateHostDraft`, and its errors are the loader's own text;
 * - probes are the engine's probe plan, run through the doctor argv executor;
 * - writes are the engine's compare-and-swap write under `<file>.lock`, with
 *   the hash the file was read at — there is no `--force`.
 *
 * A schema version 1 file is converted on the first write: the sections the
 * v2 form can carry without inventing operator choices map over (forge mode
 * `github`, verification procedures, waves), the v1-only sections (runner,
 * worktree, reviewer, shelf) do not, and the drafted host's runner is written
 * with the isolation floor today's v1 runner already asserts, so a converted
 * runner is never silently undeclared.
 */

import {
  createNodeDoctorExecutor,
  diffInstallationText,
  draftHost,
  hostProbeSpecFromDraft,
  hostProbesHaveFailure,
  probeHost,
  readHashOf,
  readInstallationFile,
  renderInstallationDiff,
  serialiseInstallationCandidate,
  validateHostDraft,
  writeInstallation,
  type HostDraftCandidate,
  type HostDraftInput,
  type HostProbeExecutor,
  type HostRunnerDraft,
  type InstallationFileRead,
} from "@fleet/onboarding";
import {
  isSafeSshHost,
  isValidHostName,
  parseInstallation,
  resolveInstallationFile,
  type FleetInstallation,
  type HostRole,
  type HostSection,
  type RunnerCapabilityDeclaration,
} from "@fleet/installation";
import {
  AttemptRepositoryAdapter,
  CAPACITY_RELEASE_STATES,
  ExecutionJournalAdapter,
  resolveInstallationHostForRole,
} from "@fleet/work-execution";

import { formatDoctorLine, type CliIo } from "./index.js";

/** Options the driver and tests inject; every default composes the real thing. */
export interface HostsCliOptions {
  /**
   * The durable-state directory behind remove's live-work check, injected by
   * the driver from `--state-dir` / `FLEET_STATE_DIR`. Without it every store
   * is in-memory and the process is disposable.
   */
  readonly stateDir?: string;
  /** Installation file; the loader's own resolution applies when omitted. */
  readonly installationFile?: string;
  /** Host probe executor; the node doctor executor composes when omitted. */
  readonly probeExecutor?: HostProbeExecutor;
  /**
   * The confirmation gate for a write. The default reads one line from
   * stdin and accepts only an explicit y/yes; a declined or closed stdin
   * refuses the write.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
}

const HOSTS_HELP = `Usage: fleet-v2 hosts <subcommand> [flags]

Manage the named hosts of the v2 installation file. Every write runs the
shared onboarding engine: draft, the loader's own validation, the host's
probe plan, a diff, an explicit confirmation and a compare-and-swap write.
A schema version 1 file is converted to v2 on the first write.

  list                         print one line per configured host
  add <name> [--ssh <alias>] [--port <n>] [--worktree-root <path>]
                               [--role <role>]... [--yes]
                               draft a new host; the default role is
                               lane-runner, and without --ssh the host is
                               local
  edit <name> [--ssh <alias>] [--port <n>] [--worktree-root <path>]
                               [--role <role>]... [--yes]
                               change an existing host; flags left out keep
                               the entry's current values
  remove <name> [--yes]        remove a host; refuses the orchestrator host,
                               the last lane-runner and a host with live work

Roles: orchestrator, lane-runner, verifier. hosts add/edit keep one
lane-runner role: adding or editing a host with the lane-runner role moves that
role from the host that holds it. Multi-host dispatch lands with H10; until
then exactly one host runs lanes.

Exit codes: 0 written (or listed), 1 refused — a probe FAIL, a loader
refusal, a changed or locked file, live work on remove — 2 usage error.
There is no --force.`;

const HOST_ROLES: readonly HostRole[] = [
  "orchestrator",
  "lane-runner",
  "verifier",
];

/**
 * The isolation floor a converted v1 runner is written with: exactly what
 * today's v1 mapping asserts (`legacy-asserted`), so converting the file
 * keeps the same assertion instead of leaving the runner undeclared.
 */
const CONVERSION_ISOLATION_FLOOR: RunnerCapabilityDeclaration = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: "scoped-worktree",
};

/** Which flags each subcommand accepts; anything else is a usage error. */
const SUBCOMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  list: new Set([]),
  add: new Set(["ssh", "port", "worktree-root", "role", "yes"]),
  edit: new Set(["ssh", "port", "worktree-root", "role", "yes"]),
  remove: new Set(["yes"]),
};

interface HostsArgs {
  readonly subcommand: string;
  readonly name?: string;
  readonly sshAlias?: string;
  readonly port?: number;
  readonly worktreeRoot?: string;
  readonly roles: readonly HostRole[];
  readonly yes: boolean;
}

type ParsedHostsArgs =
  | { readonly ok: true; readonly help: boolean; readonly args: HostsArgs }
  | { readonly ok: false; readonly error: string };

function isHelpToken(token: string): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

/** Parse one hosts invocation; every problem is a usage message, never a guess. */
function parseHostsArgs(tokens: readonly string[]): ParsedHostsArgs {
  const emptyArgs: HostsArgs = { subcommand: "", roles: [], yes: false };
  const subcommand = tokens[0] ?? "";
  if (isHelpToken(subcommand)) {
    return { ok: true, help: true, args: emptyArgs };
  }
  const allowed = SUBCOMMAND_FLAGS[subcommand];
  if (allowed === undefined) {
    return {
      ok: false,
      error: `Unknown hosts subcommand: ${subcommand === "" ? "(none)" : subcommand}\n${HOSTS_HELP}`,
    };
  }
  const args: {
    subcommand: string;
    name?: string;
    sshAlias?: string;
    port?: number;
    worktreeRoot?: string;
    roles: HostRole[];
    yes: boolean;
  } = { subcommand, roles: [], yes: false };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isHelpToken(token)) {
      return { ok: true, help: true, args: emptyArgs };
    }
    if (!token.startsWith("--") || token === "--") {
      if (args.name !== undefined) {
        return {
          ok: false,
          error: `Unexpected argument: ${token}\n${HOSTS_HELP}`,
        };
      }
      args.name = token;
      continue;
    }
    const body = token.slice(2);
    const separator = body.indexOf("=");
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : body.slice(separator + 1);
    if (!allowed.has(flag)) {
      return {
        ok: false,
        error: `Unknown hosts ${subcommand} option: --${flag}\n${HOSTS_HELP}`,
      };
    }
    if (flag === "yes") {
      if (inlineValue !== undefined) {
        return { ok: false, error: "--yes takes no value\n" + HOSTS_HELP };
      }
      args.yes = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return {
          ok: false,
          error: `--${flag} requires a value\n${HOSTS_HELP}`,
        };
      }
      value = next;
      index += 1;
    }
    if (value.trim() === "") {
      return { ok: false, error: `--${flag} requires a value\n${HOSTS_HELP}` };
    }
    if (flag === "ssh") {
      args.sshAlias = value;
    } else if (flag === "worktree-root") {
      args.worktreeRoot = value;
    } else if (flag === "port") {
      if (!/^\d+$/.test(value)) {
        return {
          ok: false,
          error: `--port must be an integer, not '${value}'\n${HOSTS_HELP}`,
        };
      }
      args.port = Number(value);
    } else {
      const segments = value.split(",");
      const roles: HostRole[] = [];
      for (const segment of segments) {
        const role = segment.trim();
        if (role === "") {
          return {
            ok: false,
            error: `--role requires role names, not '${value}'\n${HOSTS_HELP}`,
          };
        }
        if (!HOST_ROLES.includes(role as HostRole)) {
          return {
            ok: false,
            error: `--role must be one of: ${HOST_ROLES.join(", ")}\n${HOSTS_HELP}`,
          };
        }
        roles.push(role as HostRole);
      }
      args.roles.push(...roles);
    }
  }
  return { ok: true, help: false, args };
}

/** The file on disk plus the loader's verdict on it. */
export type InstallationState =
  | { readonly status: "absent"; readonly read: InstallationFileRead }
  | {
      readonly status: "unreadable";
      readonly read: InstallationFileRead;
      readonly reason: string;
    }
  | {
      readonly status: "invalid";
      readonly read: InstallationFileRead;
      readonly errors: readonly string[];
    }
  | {
      readonly status: "v1";
      readonly read: InstallationFileRead;
      readonly installation: FleetInstallation;
    }
  | {
      readonly status: "v2";
      readonly read: InstallationFileRead;
      readonly installation: FleetInstallation;
      /** The decoded file value, verbatim; candidates copy it untouched. */
      readonly value: unknown;
    };

export async function readInstallationState(file: string): Promise<InstallationState> {
  const read = await readInstallationFile(file);
  if (read.status === "unreadable") {
    return { status: "unreadable", read, reason: read.reason };
  }
  if (read.status === "absent") {
    return { status: "absent", read };
  }
  const parsed = parseInstallation(read.value);
  if (!parsed.ok) {
    return { status: "invalid", read, errors: parsed.errors };
  }
  return parsed.installation.schemaVersion === 1
    ? { status: "v1", read, installation: parsed.installation }
    : {
        status: "v2",
        read,
        installation: parsed.installation,
        value: read.value,
      };
}

export function printErrors(io: CliIo, errors: readonly string[]): void {
  for (const error of errors) {
    io.stderr(`${error}\n`);
  }
}

/**
 * The v2 form of a v1 file, before the drafted host is applied: the sections
 * the v2 format can hold without inventing operator choices carry over, the
 * v1-only sections do not (their routing is re-declared as hosts, their
 * seats by `init --migrate` or by hand). An absent v1 forge stays absent: the
 * loader then refuses the candidate with its own "forge: required" instead
 * of the conversion inventing a mode D6 forbids as a fallback.
 */
function convertV1File(installation: FleetInstallation): HostDraftCandidate {
  const forge = installation.forge;
  const verification = installation.verification;
  const waves = installation.waves;
  return {
    schemaVersion: 2 as const,
    hosts: {},
    ...(forge !== undefined && "owner" in forge
      ? { forge: { mode: "github", owner: forge.owner, repo: forge.repo } }
      : {}),
    ...(verification !== undefined
      ? { verification: { procedures: verification.procedures } }
      : {}),
    ...(waves !== undefined ? { waves: { ...waves } } : {}),
  };
}

function hostsOf(value: unknown): Record<string, HostSection> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const hosts = (value as { readonly hosts?: unknown }).hosts;
  return typeof hosts === "object" && hosts !== null && !Array.isArray(hosts)
    ? (hosts as Record<string, HostSection>)
    : undefined;
}

/**
 * Move the lane-runner role off every other host (plan section 1: until the
 * loader allows several, adding one moves the role). The current value is
 * never mutated; a host that keeps no role is left for the loader to refuse.
 */
function moveLaneRunnerRole(
  current: unknown,
  name: string,
): { readonly value: unknown; readonly movedFrom: readonly string[] } {
  const hosts = hostsOf(current) ?? {};
  const movedFrom: string[] = [];
  let nextHosts: Record<string, HostSection> | undefined;
  for (const [hostName, host] of Object.entries(hosts)) {
    if (hostName === name || !host.roles.includes("lane-runner")) {
      continue;
    }
    movedFrom.push(hostName);
    nextHosts ??= { ...hosts };
    nextHosts[hostName] = {
      ...host,
      roles: host.roles.filter((role) => role !== "lane-runner"),
    };
  }
  if (nextHosts === undefined) {
    return { value: current, movedFrom: [] };
  }
  return {
    value: {
      ...(current as Readonly<Record<string, unknown>>),
      hosts: nextHosts,
    },
    movedFrom,
  };
}

/** The default confirmation: one stdin line, only an explicit y/yes writes. */
export function confirmFromStdin(io: CliIo): (question: string) => Promise<boolean> {
  return (question) =>
    new Promise<boolean>((resolve) => {
      io.stdout(`${question} `);
      const stdin = process.stdin;
      if (stdin.readableEnded) {
        io.stdout("\n");
        resolve(false);
        return;
      }
      let settled = false;
      let answer = "";
      const finish = (confirmed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("error", onError);
        stdin.pause();
        resolve(confirmed);
      };
      const decided = (): boolean => {
        const newline = answer.indexOf("\n");
        const line =
          newline === -1 ? answer.trim() : answer.slice(0, newline).trim();
        finish(/^y(?:es)?$/i.test(line));
        return true;
      };
      const onData = (chunk: Buffer | string): void => {
        answer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (answer.includes("\n")) {
          decided();
        }
      };
      const onEnd = (): void => {
        if (answer.trim() !== "") {
          decided();
          return;
        }
        finish(false);
      };
      const onError = (): void => finish(false);
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("error", onError);
      stdin.resume();
    });
}

/** The runner draft flags can express: an opencode runner with a port. */
function runnerDraftFor(
  existing: HostSection | undefined,
  port: number | undefined,
  converting: boolean,
): HostRunnerDraft | undefined {
  const runner = existing?.runner;
  if (runner === undefined) {
    if (port === undefined) {
      return undefined;
    }
    return {
      kind: "opencode",
      port,
      ...(converting ? { capabilities: CONVERSION_ISOLATION_FLOOR } : {}),
    };
  }
  const common = {
    port: port ?? runner.port,
    ...(runner.authFile !== undefined ? { authFile: runner.authFile } : {}),
    ...(runner.capabilities !== undefined
      ? { capabilities: runner.capabilities }
      : {}),
    ...(runner.maxLanes !== undefined ? { maxLanes: runner.maxLanes } : {}),
  };
  if (runner.kind === "agy") {
    return {
      kind: "agy",
      ...common,
      agyMode: runner.agyMode,
      ...(runner.agyAcknowledgement !== undefined
        ? { agyAcknowledgement: runner.agyAcknowledgement }
        : {}),
    };
  }
  return { kind: "opencode", ...common };
}

/** Diff the file as it sits against the candidate as the write would put it. */
export function printDiff(
  io: CliIo,
  currentText: string,
  candidate: HostDraftCandidate,
): void {
  const diff = renderInstallationDiff(
    diffInstallationText(
      currentText,
      serialiseInstallationCandidate(candidate),
    ),
  );
  io.stdout(diff === "" ? "no changes\n" : `${diff}\n`);
}

/** Probe, diff, confirm, then the compare-and-swap write. */
export async function confirmAndWrite(
  file: string,
  read: InstallationFileRead,
  candidate: HostDraftCandidate,
  args: { readonly yes: boolean },
  io: CliIo,
  options: { readonly confirm?: (question: string) => Promise<boolean> },
): Promise<number> {
  const currentText = read.status === "read" ? read.text : "";
  printDiff(io, currentText, candidate);
  if (!args.yes) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`write ${file} with this change? [y/N]`))) {
      io.stderr("not confirmed; nothing was written\n");
      return 1;
    }
  }
  const result = await writeInstallation({
    file,
    candidate,
    expectedHash: readHashOf(read),
  });
  if (result.status === "refused") {
    printErrors(io, result.errors);
    io.stderr("nothing was written\n");
    return 1;
  }
  io.stdout(`written ${file} (sha256 ${result.hash})\n`);
  return 0;
}

async function writeHost(
  mode: "add" | "edit",
  args: HostsArgs,
  file: string,
  io: CliIo,
  options: HostsCliOptions,
): Promise<number> {
  const name = args.name;
  if (name === undefined || name.trim() === "") {
    io.stderr(`hosts ${mode} requires a host name\n${HOSTS_HELP}\n`);
    return 2;
  }
  if (!isValidHostName(name)) {
    // The same rule the loader applies to v2 host-map keys, refused at the
    // boundary before anything is drafted.
    io.stderr(
      `hosts ${mode}: '${name}' is not a valid host name (identifier-shaped, no '..')\n${HOSTS_HELP}\n`,
    );
    return 2;
  }
  if (args.sshAlias !== undefined && !isSafeSshHost(args.sshAlias)) {
    // The value never appears in the message: an alias is operator input.
    io.stderr(
      `hosts.${name}.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option\n${HOSTS_HELP}\n`,
    );
    return 2;
  }
  if (mode === "add" && args.worktreeRoot === undefined) {
    io.stderr(`hosts add requires --worktree-root <path>\n${HOSTS_HELP}\n`);
    return 2;
  }
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr(
      `the installation file is invalid; fix it by hand before changing hosts:\n`,
    );
    printErrors(io, state.errors);
    return 1;
  }
  const converting = state.status === "v1";
  if (converting && mode === "add") {
    io.stdout(
      "converting the schema version 1 file to version 2: the v1 runner, worktree, reviewer and shelf sections do not carry over, and neither do their seats — add seats with init or by hand before the next dispatch\n",
    );
  }
  const existing =
    state.status === "v2" ? state.installation.hosts?.[name] : undefined;
  if (mode === "edit" && existing === undefined) {
    // The engine reports the same fact for a v1 or absent file; name it here.
    io.stderr(
      `hosts.${name}: not in the installation file; adding is a separate mode\n`,
    );
    return 1;
  }
  if (
    mode === "edit" &&
    args.sshAlias !== undefined &&
    existing?.transport === "local"
  ) {
    io.stderr(
      `hosts.${name}: the entry's transport is local; --ssh changes an ssh host's alias\n`,
    );
    return 2;
  }

  const roles = args.roles.length > 0 ? args.roles : undefined;
  const runner = runnerDraftFor(
    existing,
    args.port,
    converting && mode === "add",
  );
  const input: HostDraftInput = {
    name,
    transport:
      existing?.transport ?? (args.sshAlias === undefined ? "local" : "ssh"),
    ...(args.sshAlias !== undefined
      ? { sshAlias: args.sshAlias }
      : existing?.transport === "ssh" && existing.sshAlias !== undefined
        ? { sshAlias: existing.sshAlias }
        : {}),
    worktreeRoot: args.worktreeRoot ?? existing?.worktreeRoot ?? "",
    ...(existing?.tmpDir !== undefined ? { tmpDir: existing.tmpDir } : {}),
    roles: roles ?? [...(existing?.roles ?? ["lane-runner"])],
    ...(runner !== undefined ? { runner } : {}),
  };
  const drafted = draftHost(input);
  if (!drafted.ok) {
    printErrors(io, drafted.errors);
    return 1;
  }
  const draft = drafted.draft;

  let current: unknown;
  if (state.status === "v1") {
    current = mode === "add" ? convertV1File(state.installation) : undefined;
  } else if (state.status === "v2") {
    current = state.value;
  }
  let movedFrom: readonly string[] = [];
  if (draft.host.roles.includes("lane-runner")) {
    const moved = moveLaneRunnerRole(current, name);
    current = moved.value;
    movedFrom = moved.movedFrom;
  }

  const validated = validateHostDraft(current, draft, mode);
  if (!validated.ok) {
    io.stderr("the loader refuses this change:\n");
    printErrors(io, validated.errors);
    if (validated.candidate !== undefined) {
      printDiff(
        io,
        state.read.status === "read" ? state.read.text : "",
        validated.candidate,
      );
    }
    return 1;
  }
  const candidate = validated.candidate;

  // A verifier host must see the lane-runner's worktree root; the candidate
  // is the post-apply file, so a role moved in this same write counts.
  const laneRunnerName = resolveInstallationHostForRole(
    validated.installation,
    "lane-runner",
  );
  const laneRunnerHost =
    laneRunnerName !== undefined
      ? validated.installation.hosts?.[laneRunnerName]
      : undefined;
  const spec = {
    ...hostProbeSpecFromDraft(draft),
    ...(draft.host.roles.includes("verifier") &&
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
  const executor = options.probeExecutor ?? createNodeDoctorExecutor();
  const lines = await probeHost(spec, executor);
  for (const line of lines) {
    io.stdout(`${formatDoctorLine(line)}\n`);
  }
  if (hostProbesHaveFailure(lines)) {
    io.stderr("refused: a probe reported FAIL; nothing was written\n");
    return 1;
  }
  if (movedFrom.length > 0) {
    io.stdout(
      `lanes now run on ${name} (the lane-runner role moved from ${movedFrom.join(", ")})\n`,
    );
  }
  return confirmAndWrite(file, state.read, candidate, args, io, options);
}

async function removeHost(
  args: HostsArgs,
  file: string,
  io: CliIo,
  options: HostsCliOptions,
): Promise<number> {
  const name = args.name;
  if (name === undefined || name.trim() === "") {
    io.stderr(`hosts remove requires a host name\n${HOSTS_HELP}\n`);
    return 2;
  }
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    io.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "absent") {
    io.stderr("no installation file; there is no host to remove\n");
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr(
      "the installation file is invalid; fix it by hand before changing hosts:\n",
    );
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "v1") {
    io.stderr(
      "the installation file is schema version 1 and has no named hosts; the first hosts add converts it\n",
    );
    return 1;
  }
  const hosts = state.installation.hosts ?? {};
  const host = Object.hasOwn(hosts, name) ? hosts[name] : undefined;
  if (host === undefined) {
    io.stderr(`hosts.${name}: not in the installation file\n`);
    return 1;
  }
  if (host.roles.includes("orchestrator")) {
    io.stderr(
      `hosts.${name} holds the orchestrator role, and an installation needs exactly one orchestrator host; move the role to another host first (hosts edit)\n`,
    );
    return 1;
  }
  const otherLaneRunner = Object.entries(hosts).find(
    ([hostName, entry]) =>
      hostName !== name && entry.roles.includes("lane-runner"),
  );
  if (host.roles.includes("lane-runner") && otherLaneRunner === undefined) {
    io.stderr(
      `hosts.${name} is the last lane-runner host; move the lane-runner role to another host before removing it\n`,
    );
    return 1;
  }

  // Live work: an attempt recorded on this host that has not released its
  // capacity, or an active reservation naming it, keeps the host in place.
  const attempts = new AttemptRepositoryAdapter({ stateDir: options.stateDir });
  const journal = new ExecutionJournalAdapter({ stateDir: options.stateDir });
  const liveAttempts = (await attempts.listAllAttempts()).filter(
    (attempt) =>
      attempt.runner?.hostName === name &&
      !CAPACITY_RELEASE_STATES.includes(attempt.state),
  );
  if (liveAttempts.length > 0) {
    for (const attempt of liveAttempts) {
      io.stderr(`attempt ${attempt.id} is ${attempt.state} on ${name}\n`);
    }
    io.stderr(`hosts.${name} has live work; nothing was removed\n`);
    return 1;
  }
  const reservations = await journal.listActiveReservations(name);
  if (reservations.length > 0) {
    for (const reservation of reservations) {
      io.stderr(
        `reservation ${reservation.id} holds a slot for attempt ${reservation.attemptId} on ${name}\n`,
      );
    }
    io.stderr(`hosts.${name} has live work; nothing was removed\n`);
    return 1;
  }

  if (host.runner !== undefined && host.transport === "ssh") {
    io.stdout(
      `note: a leftover ssh -f -N forward for this host may still listen on 127.0.0.1:${host.runner.port + 1}; find it with pgrep -f 'ssh .*-L 127.0.0.1:${host.runner.port + 1}' and kill the pid\n`,
    );
  }

  const remaining: Record<string, HostSection> = { ...hosts };
  delete remaining[name];
  const candidate: HostDraftCandidate = {
    schemaVersion: 2 as const,
    ...(state.value as Readonly<Record<string, unknown>>),
    hosts: remaining,
  };
  if (
    host.transport === "ssh" &&
    Object.values(remaining).every((entry) => entry.transport !== "ssh")
  ) {
    io.stdout(
      "the installation is single-machine again: no host is reached over ssh\n",
    );
  }
  return confirmAndWrite(file, state.read, candidate, args, io, options);
}

async function listHosts(file: string, io: CliIo): Promise<number> {
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
    io.stdout("no installation file\n");
    return 0;
  }
  if (state.status === "v1") {
    io.stdout(
      "the installation file is schema version 1; it has no named hosts, and the first hosts add converts it to version 2\n",
    );
    return 0;
  }
  const hosts = state.installation.hosts ?? {};
  const names = [...Object.keys(hosts)].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    io.stdout("no hosts are configured\n");
    return 0;
  }
  for (const name of names) {
    const host = hosts[name];
    const parts = [
      name,
      host.transport,
      ...(host.sshAlias !== undefined ? [`alias ${host.sshAlias}`] : []),
      `roles: ${host.roles.join(", ")}`,
      `worktree-root: ${host.worktreeRoot}`,
      ...(host.tmpDir !== undefined ? [`tmp-dir: ${host.tmpDir}`] : []),
      ...(host.runner !== undefined
        ? [`runner: ${host.runner.kind}, port ${host.runner.port}`]
        : []),
    ];
    io.stdout(`${parts.join("  ")}\n`);
  }
  return 0;
}

/** `fleet-v2 hosts <subcommand>`; exit codes: 0 written/listed, 1 refused, 2 usage. */
export async function hostsCommand(
  argv: readonly string[],
  io: CliIo,
  options: HostsCliOptions = {},
): Promise<number> {
  const parsed = parseHostsArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${HOSTS_HELP}\n`);
    return 0;
  }
  const args = parsed.args;
  const file =
    options.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());
  if (args.subcommand === "list") {
    return listHosts(file, io);
  }
  if (args.subcommand === "remove") {
    return removeHost(args, file, io, options);
  }
  return writeHost(
    args.subcommand === "edit" ? "edit" : "add",
    args,
    file,
    io,
    options,
  );
}
