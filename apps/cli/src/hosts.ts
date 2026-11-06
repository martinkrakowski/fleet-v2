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

import { readFile } from "node:fs/promises";

import {
  createNodeDoctorExecutor,
  diffInstallationText,
  draftHost,
  hostProbeSpecFromDraft,
  hostProbesHaveFailure,
  parseHostDescriptor,
  probeHost,
  readHashOf,
  readInstallationFile,
  renderInstallationDiff,
  serialiseInstallationCandidate,
  validateHostDraft,
  writeInstallation,
  type HostDraftCandidate,
  type HostDraftInput,
  type HostDescriptor,
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
  ManageDaemonSchedulerUseCase,
  resolveInstallationHostForRole,
  SystemdUserSchedulerAdapter,
  type DaemonSchedulerPort,
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
  /** Daemon scheduler port; the systemd user adapter composes when omitted. */
  readonly scheduler?: DaemonSchedulerPort;
}

const HOSTS_HELP = `Usage: fleet-v2 hosts <subcommand> [flags]

Manage the named hosts of the v2 installation file. Every write runs the
shared onboarding engine: draft, the loader's own validation, the host's
probe plan, a diff, an explicit confirmation and a compare-and-swap write.
A schema version 1 file is converted to v2 on the first write.

  list                         print one line per configured host
  show [<name>] [--role <role>] print the host table for all hosts, one
                               named host, or the host holding a role; a
                               role held by several hosts is refused
  add <name> [--ssh <alias>] [--port <n>] [--worktree-root <path>]
                               [--container <name>] [--tunnel-offset <n>]
                               [--role-alias <role>=<alias>]...
                               [--from-descriptor <file>] [--role <role>]... [--yes]
                               draft a new host; the default role is
                               lane-runner, and without --ssh the host is
                               local. With --from-descriptor the file carries
                               the port, worktree root, tool and capabilities.
  edit <name> [--ssh <alias>] [--port <n>] [--worktree-root <path>]
                               [--container <name>] [--tunnel-offset <n>]
                               [--role-alias <role>=<alias>]...
                               [--role <role>]... [--yes]
                               change an existing host; flags left out keep
                               the entry's current values
  remove <name> [--yes]        remove a host; refuses the orchestrator host,
                               the last lane-runner and a host with live work
  daemon install|show|uninstall --scheduler systemd [--apply]
                               render the daemon tick's user-scope scheduler
                               units (systemd service and timer); install
                               prints the enable and linger commands, and
                               --apply writes or removes the unit files

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
 * The secret shapes a hosts refusal or table must never echo, rebuilt from
 * string fragments so no literal in this file matches the shapes itself
 * (the repo's own diff gate refuses a file whose source text looks like a
 * secret). The set mirrors the shared registry's six legacy shapes and all
 * seventeen canonical lane-diff shapes; the shared package is not a declared
 * dependency of the CLI, so the mirror lives here.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  new RegExp(["-----BEGIN [A-Z ]*PRIVATE KEY-----"].join("")),
  new RegExp(["\\bgh[pousr]_[A-Za-z0-9]{20,}\\b"].join("")),
  new RegExp(["\\bsk-[A-Za-z0-9_-]{20,}\\b"].join("")),
  new RegExp(["\\bAKIA[0-9A-Z]{16}\\b"].join("")),
  new RegExp(["\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b"].join("")),
  new RegExp([
    "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b",
  ].join("")),
  new RegExp(["AKIA[0-9A-Z]{16}"].join("")),
  new RegExp(["gh[pousr]_[A-Za-z0-9]{20,}"].join("")),
  new RegExp(["github_pat_[A-Za-z0-9_]{20,}"].join("")),
  new RegExp(["BEGIN [A-Z ]*PRIVATE KEY"].join("")),
  new RegExp(["ya29\\.[A-Za-z0-9_-]{20,}"].join("")),
  new RegExp(["AIza[0-9A-Za-z_-]{30,}"].join("")),
  new RegExp(["sk-or-v1-[0-9a-f]{20,}"].join("")),
  new RegExp(["xox[abpr]-[A-Za-z0-9-]{10,}"].join("")),
  new RegExp([
    "eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  ].join("")),
  new RegExp(["ssh-(rsa|ed25519|dss|ecdsa) AAAA[A-Za-z0-9+/]{20,}"].join("")),
  new RegExp([
    "OPENCODE_SERVER_PASSWORD[ \\t\\v\\f\\r]*=[ \\t\\v\\f\\r]*[^ \\t\\v\\f\\r]+",
  ].join("")),
  new RegExp(["antigravity", "oauth", "token"].join("-")),
  new RegExp([
    "\\/home\\/[a-z]+\\/.(",
    "ssh|config\\/gh|gemini|aws|docker\\/config\\.json)",
  ].join("")),
  new RegExp([
    "[Pp]assword[ \\t\\v\\f\\r]*[:=][ \\t\\v\\f\\r]*[\"'][^\"']{6,}[\"']",
  ].join("")),
  new RegExp([
    "[Tt]oken[ \\t\\v\\f\\r]*[:=][ \\t\\v\\f\\r]*[\"'][A-Za-z0-9_./+=-]{16,}[\"']",
  ].join("")),
  new RegExp([
    "https?:\\/\\/[^/:@ \\t\\v\\f\\r]+:[^/@ \\t\\v\\f\\r]{6,}@",
  ].join("")),
  /[\\/\\]/,
];

/** True when `text` contains a secret shape or a filesystem separator. */
export function hasSecretShape(text: string): boolean {
  return SECRET_SHAPES.some((pattern) => pattern.test(text));
}

/** Replace every secret-shaped span and separator in `text` with `<redacted>`. */
export function sanitizeToken(text: string): string {
  let out = text;
  for (const pattern of SECRET_SHAPES) {
    out = out.replace(pattern, "<redacted>");
  }
  return out;
}

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
  show: new Set(["role"]),
  add: new Set([
    "ssh",
    "port",
    "worktree-root",
    "container",
    "tunnel-offset",
    "role-alias",
    "from-descriptor",
    "role",
    "yes",
  ]),
  edit: new Set([
    "ssh",
    "port",
    "worktree-root",
    "container",
    "tunnel-offset",
    "role-alias",
    "role",
    "yes",
  ]),
  remove: new Set(["yes"]),
};

interface HostsArgs {
  readonly subcommand: string;
  readonly name?: string;
  readonly sshAlias?: string;
  readonly port?: number;
  readonly worktreeRoot?: string;
  readonly container?: string;
  readonly tunnelOffset?: number;
  /** The `--role-alias role=alias` pairs as parsed, in flag order. */
  readonly roleAliasFlags: readonly (readonly [string, string])[];
  readonly fromDescriptor?: string;
  readonly roles: readonly HostRole[];
  readonly showRole?: HostRole;
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
  const emptyArgs: HostsArgs = {
    subcommand: "",
    roles: [],
    roleAliasFlags: [],
    yes: false,
  };
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
    container?: string;
    tunnelOffset?: number;
    roleAliasFlags: [string, string][];
    fromDescriptor?: string;
    roles: HostRole[];
    showRole?: HostRole;
    yes: boolean;
  } = { subcommand, roles: [], roleAliasFlags: [], yes: false };
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
    } else if (flag === "container") {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.length > 128) {
        return {
          ok: false,
          error: `--container must be 1..128 characters of letters, digits, '.', '_' or '-', starting with a letter or digit\n${HOSTS_HELP}`,
        };
      }
      args.container = value;
    } else if (flag === "tunnel-offset") {
      if (!/^-?\d{1,6}$/.test(value)) {
        return {
          ok: false,
          error: `--tunnel-offset must be an integer\n${HOSTS_HELP}`,
        };
      }
      args.tunnelOffset = Number(value);
    } else if (flag === "role-alias") {
      const separator = value.indexOf("=");
      if (separator === -1) {
        return {
          ok: false,
          error: `--role-alias must be <role>=<alias> with a role from: ${HOST_ROLES.join(", ")}\n${HOSTS_HELP}`,
        };
      }
      const role = value.slice(0, separator).trim();
      const alias = value.slice(separator + 1).trim();
      if (!HOST_ROLES.includes(role as HostRole)) {
        return {
          ok: false,
          error: `--role-alias must name one of: ${HOST_ROLES.join(", ")}\n${HOSTS_HELP}`,
        };
      }
      if (alias === "" || !isSafeSshHost(alias)) {
        return {
          ok: false,
          error: `--role-alias alias must be a safe ssh host: an alias, user@alias or dotted host that cannot start a shell option\n${HOSTS_HELP}`,
        };
      }
      args.roleAliasFlags.push([role as HostRole, alias]);
    } else if (flag === "port") {
      if (!/^\d+$/.test(value)) {
        return {
          ok: false,
          error: `--port must be an integer, not '${value}'\n${HOSTS_HELP}`,
        };
      }
      args.port = Number(value);
    } else if (flag === "from-descriptor") {
      args.fromDescriptor = value;
    } else if (subcommand === "show") {
      if (value.split(",").length > 1) {
        return {
          ok: false,
          error: `hosts show takes one role\n${HOSTS_HELP}`,
        };
      }
      const role = value.trim();
      if (!HOST_ROLES.includes(role as HostRole)) {
        return {
          ok: false,
          error: `hosts show --role must be one of: ${HOST_ROLES.join(", ")}\n${HOSTS_HELP}`,
        };
      }
      if (args.showRole !== undefined) {
        return {
          ok: false,
          error: `hosts show takes one --role\n${HOSTS_HELP}`,
        };
      }
      args.showRole = role as HostRole;
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
  if (subcommand === "show" && args.name !== undefined && args.showRole !== undefined) {
    return {
      ok: false,
      error: `hosts show takes a host name or --role, not both\n${HOSTS_HELP}`,
    };
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
 * A host stripped of the lane-runner role also drops its lane-runner role
 * alias: the loader refuses an alias for a role the host does not hold, so
 * leaving it would turn every role move into a refused write.
 */
function moveLaneRunnerRole(
  current: unknown,
  name: string,
): { readonly value: unknown; readonly movedFrom: readonly string[] } {
  const hosts = hostsOf(current) ?? {};
  const movedFrom: string[] = [];
  let nextHosts: Record<string, HostSection> | undefined;
  for (const [hostName, host] of Object.entries(hosts)) {
    if (
      hostName === name ||
      typeof host !== "object" ||
      host === null ||
      !Array.isArray(host.roles) ||
      !host.roles.includes("lane-runner")
    ) {
      continue;
    }
    movedFrom.push(hostName);
    nextHosts ??= { ...hosts };
    const roles = host.roles.filter((role) => role !== "lane-runner");
    const roleAliases =
      host.roleAliases === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(host.roleAliases).filter(
              ([role]) => role !== "lane-runner",
            ),
          );
    // Drop the host's original alias map and re-add only what survives the
    // role move; when nothing survives, the key is omitted entirely rather
    // than left naming a role the host no longer holds.
    const { roleAliases: _rawAliases, ...hostWithoutAliases } = host;
    void _rawAliases;
    const nextHost: HostSection = {
      ...hostWithoutAliases,
      roles,
      ...(roleAliases !== undefined && Object.keys(roleAliases).length > 0
        ? { roleAliases }
        : {}),
    };
    nextHosts[hostName] = nextHost;
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

/**
 * Role-alias keys the pre-write file held that the candidate no longer holds:
 * `(hostName, role)` pairs present before and absent after, sorted by host
 * name then role. An edit that removes a role (or a host) drops the alias
 * that named it, and the operator must see that without asking.
 */
function droppedRoleAliasesBetween(
  before: Readonly<Record<string, HostSection>> | undefined,
  after: Readonly<Record<string, HostSection>> | undefined,
): { readonly hostName: string; readonly role: HostRole }[] {
  const dropped: { readonly hostName: string; readonly role: HostRole }[] = [];
  if (before === undefined || after === undefined) {
    return dropped;
  }
  for (const [hostName, host] of Object.entries(before)) {
    const aliases = host.roleAliases;
    if (aliases === undefined) {
      continue;
    }
    const afterHost = Object.hasOwn(after, hostName) ? after[hostName] : undefined;
    for (const role of Object.keys(aliases)) {
      if (afterHost?.roleAliases === undefined) {
        dropped.push({ hostName, role: role as HostRole });
      } else if (!Object.hasOwn(afterHost.roleAliases, role)) {
        dropped.push({ hostName, role: role as HostRole });
      }
    }
  }
  return dropped.sort(
    (a, b) =>
      a.hostName.localeCompare(b.hostName) || a.role.localeCompare(b.role),
  );
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
  tunnelOffset: number | undefined,
  converting: boolean,
): HostRunnerDraft | undefined {
  const runner = existing?.runner;
  const offset =
    tunnelOffset !== undefined
      ? tunnelOffset
      : existing?.runner?.tunnelOffset;
  if (runner === undefined) {
    if (port === undefined) {
      return undefined;
    }
    return {
      kind: "opencode",
      port,
      ...(offset !== undefined ? { tunnelOffset: offset } : {}),
      ...(converting ? { capabilities: CONVERSION_ISOLATION_FLOOR } : {}),
    };
  }
  const common = {
    port: port ?? runner.port,
    ...(offset !== undefined ? { tunnelOffset: offset } : {}),
    ...(runner.authFile !== undefined ? { authFile: runner.authFile } : {}),
    ...(runner.capabilities !== undefined
      ? { capabilities: runner.capabilities }
      : {}),
    ...(runner.maxLanes !== undefined ? { maxLanes: runner.maxLanes } : {}),
    ...(runner.gateSlot !== undefined ? { gateSlot: runner.gateSlot } : {}),
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
  // The descriptor path: the file carries the port, worktree root, runner
  // and capabilities; the operator still supplies the alias and the roles.
  let descriptor: HostDescriptor | undefined;
  if (args.fromDescriptor !== undefined) {
    if (args.port !== undefined || args.worktreeRoot !== undefined) {
      io.stderr(
        `hosts add --from-descriptor: the descriptor carries the worktree root and the port; --worktree-root and --port cannot be given with it\n${HOSTS_HELP}\n`,
      );
      return 2;
    }
    let text: string;
    try {
      text = await readFile(args.fromDescriptor, "utf8");
    } catch {
      io.stderr(
        // The operator-supplied path can be a credential path; nothing from it appears here.
        "hosts add --from-descriptor: the host descriptor file could not be read\n",
      );
      return 1;
    }
    let descriptorValue: unknown;
    try {
      descriptorValue = JSON.parse(text);
    } catch {
      io.stderr(
        "hosts add --from-descriptor: the descriptor file is not JSON\n",
      );
      return 1;
    }
    const parsed = parseHostDescriptor(descriptorValue);
    if (!parsed.ok) {
      io.stderr("the descriptor is refused:\n");
      printErrors(io, parsed.errors);
      return 1;
    }
    descriptor = parsed.descriptor;
  }
  if (
    mode === "add" &&
    args.worktreeRoot === undefined &&
    descriptor === undefined
  ) {
    io.stderr(
      `hosts add requires --worktree-root <path> or --from-descriptor <file>\n${HOSTS_HELP}\n`,
    );
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
  const runner: HostRunnerDraft | undefined =
    descriptor !== undefined
      ? {
          kind: "opencode",
          port: descriptor.port,
          ...(descriptor.capabilities !== undefined
            ? { capabilities: descriptor.capabilities }
            : converting && mode === "add"
              ? { capabilities: CONVERSION_ISOLATION_FLOOR }
              : {}),
        }
      : runnerDraftFor(existing, args.port, args.tunnelOffset, converting && mode === "add");
  // With --role-alias flags the supplied aliases merge over the entry's
  // existing aliases filtered to the target roles: a named role updates while
  // untouched aliases on kept roles are preserved. Without the flag the field
  // is left undefined so the engine inherits and prunes the entry's aliases.
  let roleAliases: Record<string, string> | undefined;
  if (args.roleAliasFlags.length > 0) {
    const targetRoles = roles ?? [...(existing?.roles ?? ["lane-runner"])];
    const merged: Record<string, string> = {};
    if (mode === "edit" && existing?.roleAliases !== undefined) {
      for (const [role, alias] of Object.entries(existing.roleAliases)) {
        if (targetRoles.includes(role as HostRole)) {
          merged[role] = alias;
        }
      }
    }
    for (const [role, alias] of args.roleAliasFlags) {
      merged[role] = alias;
    }
    roleAliases = merged;
  }
  const input: HostDraftInput = {
    name,
    transport:
      existing?.transport ?? (args.sshAlias === undefined ? "local" : "ssh"),
    ...(args.sshAlias !== undefined
      ? { sshAlias: args.sshAlias }
      : existing?.transport === "ssh" && existing.sshAlias !== undefined
        ? { sshAlias: existing.sshAlias }
        : {}),
    ...(args.container !== undefined ? { container: args.container } : {}),
    worktreeRoot:
      descriptor?.worktreeRoot ?? args.worktreeRoot ?? existing?.worktreeRoot ?? "",
    ...(existing?.tmpDir !== undefined ? { tmpDir: existing.tmpDir } : {}),
    roles: roles ?? [...(existing?.roles ?? ["lane-runner"])],
    ...(roleAliases !== undefined ? { roleAliases } : {}),
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
  // The probe beats the descriptor's claim: the only claim the probe can
  // measure is the runner tool's version, and the file carries no version
  // field, so the claim is never written. Neither value is printed — the
  // descriptor's value is untrusted file content, the measured one already
  // sits on the probe line above.
  if (descriptor !== undefined) {
    const versionLine = lines.find((line) => line.check === "version-opencode");
    if (versionLine !== undefined) {
      if (versionLine.status === "UNKNOWN") {
        io.stdout(
          "the descriptor's claimed opencode version could not be measured; the claim is not written\n",
        );
      } else if (versionLine.status === "PASS") {
        const prefix = "opencode: version ";
        if (versionLine.detail.startsWith(prefix)) {
          const measured = versionLine.detail.slice(prefix.length);
          if (measured !== descriptor.tools[0].version) {
            io.stdout(
              "the descriptor's claimed opencode version does not match the measured one; the measured version stands\n",
            );
          }
        }
      }
    }
  }
  if (movedFrom.length > 0) {
    io.stdout(
      `lanes now run on ${name} (the lane-runner role moved from ${movedFrom.join(", ")})\n`,
    );
  }
  // An edit that removes a role (or a host) can silently drop the role alias
  // that named it; under --yes there is no diff-confirm step, so the dropped
  // aliases are named here, on stdout, one line, ids only.
  const dropped = droppedRoleAliasesBetween(
    state.status === "v2" ? state.installation.hosts : undefined,
    validated.installation.hosts,
  );
  if (args.yes && dropped.length > 0) {
    io.stdout(
      `dropped role alias: ${dropped
        .map((d) => `hosts.${d.hostName}.roleAliases.${d.role}`)
        .join(", ")}\n`,
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
    const forwardPort =
      host.runner.port + (host.runner.tunnelOffset ?? 1);
    io.stdout(
      `note: a leftover ssh -f -N forward for this host may still listen on 127.0.0.1:${forwardPort}; find it with pgrep -f 'ssh .*-L 127.0.0.1:${forwardPort}' and kill the pid\n`,
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

/**
 * The refusal when a role resolves to more than one host: plain operator text
 * naming the role and telling the operator how to proceed. Host names pass
 * through `sanitizeToken`; the role name is a fixed enum value.
 */
export function formatRoleAmbiguousRefusal(
  role: HostRole,
  hostNames?: readonly string[],
): string {
  const suffix =
    hostNames !== undefined && hostNames.length > 0
      ? ` (${hostNames.map((name) => sanitizeToken(name)).join(", ")})`
      : "";
  return `hosts: role '${role}' is held by more than one host${suffix}; name the host explicitly (fleet-v2 hosts show <name>)`;
}

/**
 * `hosts show [<name>] [--role <role>]`: the host table for every host, one
 * named host, or the host holding a role. Like `list` this reads the file and
 * mutates nothing; a role held by several hosts is refused until the
 * operator names the host explicitly.
 */
async function showHosts(
  args: HostsArgs,
  file: string,
  io: CliIo,
): Promise<number> {
  let state: InstallationState;
  try {
    state = await readInstallationState(file);
  } catch {
    io.stderr("installation: unknown (unreadable)\n");
    return 1;
  }
  if (state.status === "unreadable") {
    io.stderr("installation: unknown (unreadable)\n");
    return 1;
  }
  if (state.status === "absent") {
    io.stderr("installation: absent\n");
    return 1;
  }
  if (state.status === "v1") {
    io.stderr("installation.hosts: schema version 1 has no hosts section\n");
    return 1;
  }
  if (state.status === "invalid") {
    io.stderr("the installation file is invalid; fix it by hand:\n");
    for (const error of state.errors) {
      io.stderr(`${sanitizeToken(error)}\n`);
    }
    return 1;
  }
  const hosts = state.installation.hosts ?? {};
  const names = [...Object.keys(hosts)].sort((a, b) => a.localeCompare(b));
  if (names.length > 256) {
    io.stderr("hosts show: host count exceeds maximum (256)\n");
    return 1;
  }
  if (args.showRole !== undefined) {
    const role = args.showRole;
    const holding = names.filter((name) => {
      const host = hosts[name];
      return Array.isArray(host?.roles) && host.roles.includes(role);
    });
    if (holding.length === 0) {
      io.stderr(`hosts: no host holds the ${role} role\n`);
      return 1;
    }
    if (holding.length > 1) {
      io.stderr(`${formatRoleAmbiguousRefusal(role, holding)}\n`);
      return 1;
    }
    return printHostTable(io, [holding[0] as string], hosts);
  }
  if (args.name !== undefined) {
    if (!isValidHostName(args.name)) {
      // The operator-supplied name never appears in the message.
      io.stderr(
        `hosts show: that name is not a valid host name (identifier-shaped, no '..')\n${HOSTS_HELP}\n`,
      );
      return 2;
    }
    if (!Object.hasOwn(hosts, args.name)) {
      io.stderr(
        `hosts.${sanitizeToken(args.name)}: not in the installation file\n`,
      );
      return 1;
    }
    return printHostTable(io, [args.name], hosts);
  }
  if (names.length === 0) {
    io.stdout("no hosts are configured\n");
    return 0;
  }
  return printHostTable(io, names, hosts);
}

/** The hosts show table: one aligned row per named host, in that order. */
function printHostTable(
  io: CliIo,
  names: readonly string[],
  hosts: Readonly<Record<string, HostSection>>,
): number {
  const rows = names.map((name) => {
    const host = hosts[name];
    const runner = host.runner;
    const tunnelOffset = runner?.tunnelOffset ?? 1;
    const dialPort =
      runner === undefined
        ? "-"
        : host.transport === "ssh"
          ? String(runner.port + tunnelOffset)
          : String(runner.port);
    const alias = sanitizeToken(host.sshAlias ?? "-");
    const container = sanitizeToken(host.container ?? "-");
    const roleAliases = sanitizeToken(
      host.roleAliases === undefined ||
      Object.keys(host.roleAliases).length === 0
        ? "-"
        : Object.entries(host.roleAliases)
            .map(([role, alias]) => `${role}=${alias}`)
            .join(", "),
    );
    return {
      name,
      transport: host.transport,
      alias,
      container,
      roles: host.roles.join(", "),
      roleAliases,
      runner:
        runner === undefined
          ? "-"
          : `${runner.kind}, port ${runner.port}`,
      tunnelOffset:
        runner === undefined ? "-" : String(runner.tunnelOffset ?? 1),
      dialPort,
      auth: runner?.authFile !== undefined ? "configured" : "-",
    };
  });
  const widths = {
    name: Math.max("HOST".length, ...rows.map((r) => r.name.length)),
    transport: Math.max("TRANSPORT".length, ...rows.map((r) => r.transport.length)),
    alias: Math.max("SSH".length, ...rows.map((r) => r.alias.length)),
    container: Math.max("CONTAINER".length, ...rows.map((r) => r.container.length)),
    roles: Math.max("ROLES".length, ...rows.map((r) => r.roles.length)),
    roleAliases: Math.max("ROLE_ALIASES".length, ...rows.map((r) => r.roleAliases.length)),
    runner: Math.max("RUNNER".length, ...rows.map((r) => r.runner.length)),
    tunnelOffset: Math.max("TUNNEL_OFFSET".length, ...rows.map((r) => r.tunnelOffset.length)),
    dialPort: Math.max("DIAL_PORT".length, ...rows.map((r) => r.dialPort.length)),
    auth: Math.max("AUTH".length, ...rows.map((r) => r.auth.length)),
  };
  const header = [
    "HOST".padEnd(widths.name),
    "TRANSPORT".padEnd(widths.transport),
    "SSH".padEnd(widths.alias),
    "CONTAINER".padEnd(widths.container),
    "ROLES".padEnd(widths.roles),
    "ROLE_ALIASES".padEnd(widths.roleAliases),
    "RUNNER".padEnd(widths.runner),
    "TUNNEL_OFFSET".padEnd(widths.tunnelOffset),
    "DIAL_PORT".padEnd(widths.dialPort),
    "AUTH".padEnd(widths.auth),
  ].join("  ");
  io.stdout(`${header}\n`);
  for (const row of rows) {
    io.stdout(
      [
        row.name.padEnd(widths.name),
        row.transport.padEnd(widths.transport),
        row.alias.padEnd(widths.alias),
        row.container.padEnd(widths.container),
        row.roles.padEnd(widths.roles),
        row.roleAliases.padEnd(widths.roleAliases),
        row.runner.padEnd(widths.runner),
        row.tunnelOffset.padEnd(widths.tunnelOffset),
        row.dialPort.padEnd(widths.dialPort),
        row.auth.padEnd(widths.auth),
      ].join("  ") + "\n",
    );
  }
  return 0;
}

type DaemonAction = "install" | "show" | "uninstall";

interface DaemonCommandArgs {
  readonly action: DaemonAction;
  readonly apply: boolean;
}

type ParsedDaemonArgs =
  | { readonly ok: true; readonly help: true }
  | { readonly ok: true; readonly help: false; readonly args: DaemonCommandArgs }
  | { readonly ok: false; readonly error: string };

/**
 * Parse one `hosts daemon` invocation. `--scheduler` is required and must be
 * `systemd`; `--apply` is refused on show. Every problem is a usage message.
 */
function parseDaemonArgs(tokens: readonly string[]): ParsedDaemonArgs {
  if (isHelpToken(tokens[0] ?? "")) {
    return { ok: true, help: true };
  }
  const action = tokens[0];
  if (action !== "install" && action !== "show" && action !== "uninstall") {
    return {
      ok: false,
      error: `Unknown hosts daemon action: ${action === undefined ? "(none)" : action}\n${HOSTS_HELP}`,
    };
  }
  let scheduler: string | undefined;
  let apply = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isHelpToken(token)) {
      return { ok: true, help: true };
    }
    const body = token.startsWith("--") ? token.slice(2) : "";
    const separator = body.indexOf("=");
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : body.slice(separator + 1);
    if (flag === "apply") {
      if (inlineValue !== undefined) {
        return { ok: false, error: `--apply takes no value\n${HOSTS_HELP}` };
      }
      apply = true;
      continue;
    }
    if (flag === "scheduler") {
      let value = inlineValue;
      if (value === undefined) {
        const next = tokens[index + 1];
        if (next === undefined || next.startsWith("--")) {
          return {
            ok: false,
            error: `--scheduler requires a value\n${HOSTS_HELP}`,
          };
        }
        value = next;
        index += 1;
      }
      scheduler = value;
      continue;
    }
    return {
      ok: false,
      error: `Unknown hosts daemon option: --${flag}\n${HOSTS_HELP}`,
    };
  }
  if (scheduler === undefined) {
    return {
      ok: false,
      error: `hosts daemon requires --scheduler <name>\n${HOSTS_HELP}`,
    };
  }
  if (scheduler !== "systemd") {
    return {
      ok: false,
      error: `hosts daemon --scheduler must be systemd\n${HOSTS_HELP}`,
    };
  }
  if (action === "show" && apply) {
    return {
      ok: false,
      error: `hosts daemon show does not take --apply\n${HOSTS_HELP}`,
    };
  }
  return { ok: true, help: false, args: { action, apply } };
}

/**
 * `fleet-v2 hosts daemon <action>`: install/show/uninstall the daemon tick's
 * user-scope scheduler units. The installation file resolves exactly as the
 * other hosts commands; its path is never printed. A missing, unreadable,
 * invalid, v1 or daemon-less file is exit 1; usage problems are exit 2.
 */
async function daemonCommand(
  argv: readonly string[],
  io: CliIo,
  options: HostsCliOptions,
): Promise<number> {
  const parsed = parseDaemonArgs(argv);
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
  const state = await readInstallationState(file);
  if (state.status === "absent") {
    io.stderr("installation: absent\n");
    return 1;
  }
  if (state.status === "unreadable") {
    io.stderr("installation: unreadable\n");
    return 1;
  }
  if (state.status === "invalid") {
    printErrors(io, state.errors);
    return 1;
  }
  if (state.status === "v1") {
    io.stderr("installation.daemon: schema version 1 has no daemon section\n");
    return 1;
  }
  const daemon = state.installation.daemon;
  if (daemon === undefined) {
    io.stderr("installation.daemon: absent\n");
    return 1;
  }
  const scheduler =
    options.scheduler ??
    new SystemdUserSchedulerAdapter({ unitDir: daemon.unitDir });
  const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
  const result = await useCase.execute({
    action: args.action,
    apply: args.apply,
    daemon,
  });
  for (const unit of result.units) {
    io.stdout(`${unit.key} ${unit.code}\n`);
  }
  if (result.operatorLines !== null) {
    for (const line of result.operatorLines) {
      io.stdout(`${line}\n`);
    }
  }
  return result.units.some((unit) => unit.code === "unreadable") ? 1 : 0;
}

/** `fleet-v2 hosts <subcommand>`; exit codes: 0 written/listed, 1 refused, 2 usage. */
export async function hostsCommand(
  argv: readonly string[],
  io: CliIo,
  options: HostsCliOptions = {},
): Promise<number> {
  // Runtime guard: a malformed argv or hostile options object is a typed
  // refusal, never a throw. Tokens and token count are bounded; every token
  // must be a dense string element the array itself owns.
  try {
    if (!Array.isArray(argv) || argv.length > 128) {
      return 2;
    }
    for (let index = 0; index < argv.length; index += 1) {
      if (
        !(index in argv) ||
        typeof argv[index] !== "string" ||
        (argv[index] as string).length > 1024
      ) {
        return 2;
      }
    }
    if (typeof io?.stdout !== "function" || typeof io?.stderr !== "function") {
      return 1;
    }
    if (
      options !== null &&
      typeof options === "object" &&
      Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null
    ) {
      return 1;
    }
    if (argv[0] === "daemon") {
      return await daemonCommand(argv.slice(1), io, options);
    }
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
    if (args.subcommand === "show") {
      return showHosts(args, file, io);
    }
    if (args.subcommand === "remove") {
      return removeHost(args, file, io, options);
    }
    return await writeHost(
      args.subcommand === "edit" ? "edit" : "add",
      args,
      file,
      io,
      options,
    );
  } catch {
    return 1;
  }
}
