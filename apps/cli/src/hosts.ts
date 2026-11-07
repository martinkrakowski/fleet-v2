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
  planHostRename,
  probeHost,
  readHashOf,
  readInstallationFile,
  renderInstallationDiff,
  serialiseInstallationCandidate,
  sha256Of,
  validateHostDraft,
  writeInstallation,
  type HostDraftCandidate,
  type HostDraftInput,
  type HostDescriptor,
  type HostProbeExecutor,
  type HostRunnerDraft,
  type InstallationFileRead,
  type PlanHostRenameReason,
} from "@fleet/onboarding";
import {
  HOST_NAME_SECRET_REFUSAL,
  HOST_NAME_TOO_LONG,
  MAX_HOST_NAME_ARGUMENT_LENGTH,
  hostNameHasSecretShape,
  isSafeSshHost,
  isValidHostName,
  parseInstallation,
  resolveInstallationFile,
  screenErrorLine,
  screenHostKey,
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
  add <name> [--ssh <alias>] [--port <n>] [--worktree-root <path>]
                               [--from-descriptor <file>] [--role <role>]... [--yes]
                               draft a new host; the default role is
                               lane-runner, and without --ssh the host is
                               local. With --from-descriptor the file carries
                               the port, worktree root, tool and capabilities.
  edit <name> [--ssh <alias>] [--port <n>] [--worktree-root <path>]
                               [--role <role>]... [--yes]
                               change an existing host; flags left out keep
                               the entry's current values
  remove <name> [--yes]        remove a host; refuses the orchestrator host,
                               the last lane-runner and a host with live work
  rename <old> <new> [--yes]  renames one host key, prints the screened
                               current key, works when the loader refuses
                               that key, keeps the entry
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
refusal, a secret-shaped host name, a changed or locked file, live work on
remove — 2 usage error. There is no --force.`;

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
  add: new Set(["ssh", "port", "worktree-root", "from-descriptor", "role", "yes"]),
  edit: new Set(["ssh", "port", "worktree-root", "role", "yes"]),
  remove: new Set(["yes"]),
  rename: new Set(["yes"]),
};

interface HostsArgs {
  readonly subcommand: string;
  readonly name?: string;
  readonly newName?: string;
  readonly sshAlias?: string;
  readonly port?: number;
  readonly worktreeRoot?: string;
  readonly fromDescriptor?: string;
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
    newName?: string;
    sshAlias?: string;
    port?: number;
    worktreeRoot?: string;
    fromDescriptor?: string;
    roles: HostRole[];
    yes: boolean;
  } = { subcommand, roles: [], yes: false };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isHelpToken(token)) {
      return { ok: true, help: true, args: emptyArgs };
    }
    if (!token.startsWith("--") || token === "--") {
      if (args.name === undefined) {
        args.name = token;
      } else if (subcommand === "rename" && args.newName === undefined) {
        args.newName = token;
      } else {
        return {
          ok: false,
          error:
            subcommand === "rename"
              ? `hosts rename: unexpected extra argument\n${HOSTS_HELP}`
              : `Unexpected argument: ${token}\n${HOSTS_HELP}`,
        };
      }
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
    } else if (flag === "from-descriptor") {
      args.fromDescriptor = value;
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

export function printErrors(
  out: CliIo,
  errors: readonly string[],
  keys: readonly string[] = [],
): void {
  for (const error of errors) {
    // Every line is screened again here, however its producer built it: a
    // line carrying secret-shaped text is withheld whole, and a known host
    // key — including a long opaque token run — is replaced by its screened
    // code (HN1 fix round 2, finding 1).
    out.stderr(`${screenHostsLine(error, keys)}\n`);
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
export function confirmFromStdin(out: CliIo): (question: string) => Promise<boolean> {
  return (question) =>
    new Promise<boolean>((resolve) => {
      out.stdout(`${question} `);
      const stdin = process.stdin;
      if (stdin.readableEnded) {
        out.stdout("\n");
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

/**
 * Every host key the diff could carry, from both sides: the candidate's hosts
 * and the current file's. The current text is parsed defensively — an invalid
 * or absent file contributes no keys, and its loader errors are screened by
 * `printErrors` instead.
 */
function currentHostKeys(currentText: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(currentText);
    return Object.keys(hostsOf(parsed) ?? {});
  } catch {
    return [];
  }
}

/** Replace every occurrence of a withheld key with its screened code. */
function screenHostKeysIn(
  text: string,
  keys: readonly string[],
): string {
  let screened = text;
  for (const key of keys) {
    const code = screenHostKey(key);
    if (code !== key) {
      screened = screened.split(key).join(code);
    }
  }
  return screened;
}

/**
 * The ONE screen every line the hosts command prints passes, on stdout and
 * stderr alike: every known host key is replaced by its screened code — which
 * withholds a secret-shaped key and a long opaque token run alike — then
 * every residual TOKEN-SHAPE run is put through the same test, and a line
 * still carrying secret-shaped text withholds the whole line (HN1 fix round
 * 2, finding 1). A line carrying no known key is still screened for secrets.
 */
function screenHostsLine(line: string, keys: readonly string[]): string {
  return screenErrorLine(screenTokenRunsIn(screenHostKeysIn(line, keys)));
}

const LONG_TOKEN_RUN = /[A-Za-z0-9]{20,}/g;

/**
 * The line-level TOKEN-SHAPE rule (HN1b fix round 2, finding 1): every
 * alphanumeric run of every printed line — wherever the text came from:
 * file, argv, descriptor, computed — is handed to `screenHostKey` itself, so
 * the replacement decision is the same long-token (or secret-shape) test the
 * host-key screen makes and the two cannot drift. Ordinary values — hostnames
 * like `solstice.lan`, paths, ports, role names, subcommand words — carry no
 * run long enough to be token-shaped and pass through untouched.
 */
function screenTokenRunsIn(line: string): string {
  return line.replace(LONG_TOKEN_RUN, (run) => screenHostKey(run));
}

/**
 * Every text a line must never carry: each key, the value of a `--flag=value`
 * argument, and every long opaque run inside either (a token embedded in a
 * path or an `alias@token` pair). Longest first, so a key that contains a
 * shorter one is replaced whole.
 */
function screenKeyTexts(keys: readonly string[]): readonly string[] {
  const texts = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || key === "") {
      continue;
    }
    const candidates = [key];
    if (key.startsWith("--") && key.includes("=")) {
      candidates.push(key.slice(key.indexOf("=") + 1));
    }
    for (const candidate of candidates) {
      if (candidate === "") {
        continue;
      }
      texts.add(candidate);
      for (const run of candidate.match(LONG_TOKEN_RUN) ?? []) {
        texts.add(run);
      }
    }
  }
  return [...texts].sort((a, b) => b.length - a.length);
}

/** Screen one line body; a withheld line keeps its own terminator. */
function screenHostsText(text: string, keys: readonly string[]): string {
  const terminated = text.endsWith("\n");
  const body = terminated ? text.slice(0, -1) : text;
  return `${screenHostsLine(body, keys)}${terminated ? "\n" : ""}`;
}

/** The hosts command's output: raw streams reach the operator only through it. */
export interface ScreenedHostsIo extends CliIo {
  /** The same screen for text that does not travel through stdout or stderr. */
  readonly screen: (text: string) => string;
  /**
   * Add strings a subcommand read later (a descriptor file's keys and string
   * leaves) to the screen's keys; every line printed afterwards is screened
   * against them too (HN1b fix round 1).
   */
  readonly addKeys: (keys: readonly string[]) => void;
  /**
   * Write one line that carries our own write digest: the text before and
   * after the digest passes the one line screen; the branded digest — and
   * only it — is written through unscreened (HN1b fix round 2, finding 2).
   */
  readonly stdoutDigest: (
    before: string,
    digest: WriteDigest,
    after: string,
  ) => void;
}

declare const writeDigestBrand: unique symbol;

/**
 * A sha256 digest our own code computed for an installation write — the
 * write receipt's digest, or the rename request's digest. It is the ONE kind
 * of value the hosts screen writes through unscreened: it is not operator
 * input, not file content and not a secret, and the frozen hosts-command
 * contract prints both digests in full. Every other 64-hex value — from a
 * config field, argv or the file — is still withheld by the token-shape
 * screen (HN1b fix round 2, finding 2: no general "64-hex is fine" rule).
 */
export type WriteDigest = string & {
  readonly [writeDigestBrand]: "sha256";
};

/**
 * The ONE output wrapper of the hosts command. Every line written through it,
 * on stdout and stderr alike, is split on `\n` (newlines kept) and passes the
 * one hosts line screen with `keys`: every host key of the installation file
 * and every argv token. A known key — a secret-shaped one or a long opaque
 * token run — is replaced by its screened code, and a line still carrying
 * secret-shaped text is withheld whole. `hostsCommand` wraps once; handlers
 * and helpers get only the wrapped io, so no print site can forget the screen.
 */
export function screenedHostsIo(
  io: CliIo,
  keys: readonly string[],
): ScreenedHostsIo {
  const known: string[] = [...keys];
  let texts = screenKeyTexts(known);
  const addKeys = (added: readonly string[]): void => {
    known.push(...added);
    texts = screenKeyTexts(known);
  };
  const screen = (text: string): string =>
    text
      .split(/(?<=\n)/)
      .map((piece) => screenHostsText(piece, texts))
      .join("");
  return {
    screen,
    addKeys,
    stdoutDigest: (before, digest, after) => {
      io.stdout(screenHostsText(before, texts));
      io.stdout(digest);
      io.stdout(screenHostsText(after, texts));
    },
    stdout: (text) => {
      for (const piece of text.split(/(?<=\n)/)) {
        io.stdout(screenHostsText(piece, texts));
      }
    },
    stderr: (text) => {
      for (const piece of text.split(/(?<=\n)/)) {
        io.stderr(screenHostsText(piece, texts));
      }
    },
  };
}

/**
 * Every object key AND every string leaf of the installation file (HN1b fix
 * round 1): host keys and any key under one, plus the string values the file
 * carries — an `sshAlias`, a worktree root, a capability name — so a long
 * opaque token run inside a value is screened like one inside a key. The walk
 * is bounded (depth 8, at most 2000 visited nodes) and never throws: a walk
 * that hits the bound returns what it has collected and continues.
 */
const INSTALLATION_WALK_MAX_DEPTH = 8;
const INSTALLATION_WALK_MAX_NODES = 2000;

function installationKeys(value: unknown): readonly string[] {
  const found: string[] = [];
  let visited = 0;
  const pending: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 0 },
  ];
  while (pending.length > 0 && visited < INSTALLATION_WALK_MAX_NODES) {
    const { node, depth } = pending.pop() as { node: unknown; depth: number };
    visited += 1;
    if (depth > INSTALLATION_WALK_MAX_DEPTH) {
      continue;
    }
    if (typeof node === "string") {
      found.push(node);
      continue;
    }
    if (typeof node !== "object" || node === null) {
      continue;
    }
    let entries: readonly unknown[];
    try {
      entries = Array.isArray(node)
        ? node
        : Object.values(node as Record<string, unknown>);
    } catch {
      // An exotic object that refuses enumeration: keep what we have.
      continue;
    }
    for (const entry of entries) {
      pending.push({ node: entry, depth: depth + 1 });
    }
  }
  return found;
}

/** Diff the file as it sits against the candidate as the write would put it. */
export function printDiff(
  out: CliIo,
  currentText: string,
  candidate: HostDraftCandidate,
): void {
  const diff = renderInstallationDiff(
    diffInstallationText(
      currentText,
      serialiseInstallationCandidate(candidate),
    ),
  );
  if (diff === "") {
    out.stdout("no changes\n");
    return;
  }
  // Every host key on either side is screened the same way, for edit and for
  // remove alike, and each line passes the one hosts screen (HN1 fix round
  // 1, finding 2; round 2, finding 1).
  const keys = [
    ...new Set([...Object.keys(candidate.hosts), ...currentHostKeys(currentText)]),
  ];
  const screened = diff
    .split("\n")
    .map((line) => screenHostsLine(line, keys))
    .join("\n");
  out.stdout(`${screened}\n`);
}

/** Probe, diff, confirm, then the compare-and-swap write. */
export async function confirmAndWrite(
  file: string,
  read: InstallationFileRead,
  candidate: HostDraftCandidate,
  args: { readonly yes: boolean },
  out: CliIo,
  options: { readonly confirm?: (question: string) => Promise<boolean> },
): Promise<number> {
  const currentText = read.status === "read" ? read.text : "";
  printDiff(out, currentText, candidate);
  if (!args.yes) {
    const confirm = options.confirm ?? confirmFromStdin(out);
    if (!(await confirm(`write ${file} with this change? [y/N]`))) {
      out.stderr("not confirmed; nothing was written\n");
      return 1;
    }
  }
  const result = await writeInstallation({
    file,
    candidate,
    expectedHash: readHashOf(read),
  });
  if (result.status === "refused") {
    printErrors(out, result.errors);
    out.stderr("nothing was written\n");
    return 1;
  }
  printWriteReceipt(out, file, result.hash as WriteDigest);
  return 0;
}

/**
 * The write receipt. Through the hosts wrapper the branded digest — and only
 * it — travels unscreened, while the path and the fixed words around it pass
 * the one line screen. A caller whose io has no wrapper (seats, policy) has
 * no screen to bypass and prints the line as before.
 */
function printWriteReceipt(
  out: CliIo,
  file: string,
  digest: WriteDigest,
): void {
  const wrapped = out as Partial<ScreenedHostsIo>;
  if (typeof wrapped.stdoutDigest === "function") {
    wrapped.stdoutDigest(`written ${file} (sha256 `, digest, ")\n");
    return;
  }
  out.stdout(`written ${file} (sha256 ${digest})\n`);
}

async function writeHost(
  mode: "add" | "edit",
  args: HostsArgs,
  file: string,
  out: ScreenedHostsIo,
  options: HostsCliOptions,
): Promise<number> {
  const name = args.name;
  if (name === undefined || name.trim() === "") {
    out.stderr(`hosts ${mode} requires a host name\n${HOSTS_HELP}\n`);
    return 2;
  }
  if (name.length > MAX_HOST_NAME_ARGUMENT_LENGTH) {
    out.stderr(`${HOST_NAME_TOO_LONG}\n`);
    return 1;
  }
  if (hostNameHasSecretShape(name)) {
    out.stderr(`${HOST_NAME_SECRET_REFUSAL}\n`);
    return 1;
  }
  if (!isValidHostName(name)) {
    // The same rule the loader applies to v2 host-map keys, refused at the
    // boundary before anything is drafted.
    out.stderr(
      `hosts ${mode}: '${screenHostKey(name)}' is not a valid host name (identifier-shaped, no '..')\n${HOSTS_HELP}\n`,
    );
    return 2;
  }
  if (args.sshAlias !== undefined && !isSafeSshHost(args.sshAlias)) {
    // The value never appears in the message: an alias is operator input.
    out.stderr(
      `hosts.${screenHostKey(name)}.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option\n${HOSTS_HELP}\n`,
    );
    return 2;
  }
  // The descriptor path: the file carries the port, worktree root, runner
  // and capabilities; the operator still supplies the alias and the roles.
  let descriptor: HostDescriptor | undefined;
  if (args.fromDescriptor !== undefined) {
    if (args.port !== undefined || args.worktreeRoot !== undefined) {
      out.stderr(
        `hosts add --from-descriptor: the descriptor carries the worktree root and the port; --worktree-root and --port cannot be given with it\n${HOSTS_HELP}\n`,
      );
      return 2;
    }
    let text: string;
    try {
      text = await readFile(args.fromDescriptor, "utf8");
    } catch {
      out.stderr(
        // The operator-supplied path can be a credential path; nothing from it appears here.
        "hosts add --from-descriptor: the host descriptor file could not be read\n",
      );
      return 1;
    }
    let descriptorValue: unknown;
    try {
      descriptorValue = JSON.parse(text);
    } catch {
      out.stderr(
        "hosts add --from-descriptor: the descriptor file is not JSON\n",
      );
      return 1;
    }
    // The descriptor's keys and string leaves join the screen before any
    // error or echo can carry one of its values (HN1b fix round 1).
    out.addKeys(installationKeys(descriptorValue));
    const parsed = parseHostDescriptor(descriptorValue);
    if (!parsed.ok) {
      out.stderr("the descriptor is refused:\n");
      printErrors(out, parsed.errors);
      return 1;
    }
    descriptor = parsed.descriptor;
  }
  if (
    mode === "add" &&
    args.worktreeRoot === undefined &&
    descriptor === undefined
  ) {
    out.stderr(
      `hosts add requires --worktree-root <path> or --from-descriptor <file>\n${HOSTS_HELP}\n`,
    );
    return 2;
  }
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    out.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    out.stderr(
      `the installation file is invalid; fix it by hand before changing hosts:\n`,
    );
    printErrors(out, state.errors);
    return 1;
  }
  const converting = state.status === "v1";
  if (converting && mode === "add") {
    out.stdout(
      "converting the schema version 1 file to version 2: the v1 runner, worktree, reviewer and shelf sections do not carry over, and neither do their seats — add seats with init or by hand before the next dispatch\n",
    );
  }
  const existing =
    state.status === "v2" ? state.installation.hosts?.[name] : undefined;
  if (mode === "edit" && existing === undefined) {
    // The engine reports the same fact for a v1 or absent file; name it here.
    out.stderr(
      `hosts.${screenHostKey(name)}: not in the installation file; adding is a separate mode\n`,
    );
    return 1;
  }
  if (
    mode === "edit" &&
    args.sshAlias !== undefined &&
    existing?.transport === "local"
  ) {
    out.stderr(
      `hosts.${screenHostKey(name)}: the entry's transport is local; --ssh changes an ssh host's alias\n`,
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
      : runnerDraftFor(existing, args.port, converting && mode === "add");
  const input: HostDraftInput = {
    name,
    transport:
      existing?.transport ?? (args.sshAlias === undefined ? "local" : "ssh"),
    ...(args.sshAlias !== undefined
      ? { sshAlias: args.sshAlias }
      : existing?.transport === "ssh" && existing.sshAlias !== undefined
        ? { sshAlias: existing.sshAlias }
        : {}),
    worktreeRoot:
      descriptor?.worktreeRoot ?? args.worktreeRoot ?? existing?.worktreeRoot ?? "",
    ...(existing?.tmpDir !== undefined ? { tmpDir: existing.tmpDir } : {}),
    roles: roles ?? [...(existing?.roles ?? ["lane-runner"])],
    ...(runner !== undefined ? { runner } : {}),
  };
  const drafted = draftHost(input);
  if (!drafted.ok) {
    // The draft errors name the host being drafted; its key is screened here
    // too, so a key the screen withholds (secret-shaped or a long opaque
    // token run) never reaches the operator (HN1 fix round 2, finding 1).
    printErrors(out, drafted.errors, [
      name,
      ...currentHostKeys(state.read.status === "read" ? state.read.text : ""),
    ]);
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
    out.stderr("the loader refuses this change:\n");
    printErrors(
      out,
      validated.errors,
      validated.candidate === undefined
        ? [name]
        : [
            ...new Set([
              ...Object.keys(validated.candidate.hosts),
              name,
              ...currentHostKeys(
                state.read.status === "read" ? state.read.text : "",
              ),
            ]),
          ],
    );
    if (validated.candidate !== undefined) {
      printDiff(
        out,
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
    // The probe lines name the host; a key the screen withholds is never
    // echoed (HN1 fix round 1, finding 1).
    out.stdout(`${screenHostsLine(formatDoctorLine(line), [name])}\n`);
  }
  if (hostProbesHaveFailure(lines)) {
    out.stderr("refused: a probe reported FAIL; nothing was written\n");
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
        out.stdout(
          "the descriptor's claimed opencode version could not be measured; the claim is not written\n",
        );
      } else if (versionLine.status === "PASS") {
        const prefix = "opencode: version ";
        if (versionLine.detail.startsWith(prefix)) {
          const measured = versionLine.detail.slice(prefix.length);
          if (measured !== descriptor.tools[0].version) {
            out.stdout(
              "the descriptor's claimed opencode version does not match the measured one; the measured version stands\n",
            );
          }
        }
      }
    }
  }
  if (movedFrom.length > 0) {
    out.stdout(
      `lanes now run on ${screenHostKey(name)} (the lane-runner role moved from ${movedFrom
        .map((key) => screenHostKey(key))
        .join(", ")})\n`,
    );
  }
  return confirmAndWrite(file, state.read, candidate, args, out, options);
}

async function removeHost(
  args: HostsArgs,
  file: string,
  out: CliIo,
  options: HostsCliOptions,
): Promise<number> {
  const name = args.name;
  if (name === undefined || name.trim() === "") {
    out.stderr(`hosts remove requires a host name\n${HOSTS_HELP}\n`);
    return 2;
  }
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    out.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "absent") {
    out.stderr("no installation file; there is no host to remove\n");
    return 1;
  }
  if (state.status === "invalid") {
    out.stderr(
      "the installation file is invalid; fix it by hand before changing hosts:\n",
    );
    printErrors(out, state.errors);
    return 1;
  }
  if (state.status === "v1") {
    out.stderr(
      "the installation file is schema version 1 and has no named hosts; the first hosts add converts it\n",
    );
    return 1;
  }
  const hosts = state.installation.hosts ?? {};
  const host = Object.hasOwn(hosts, name) ? hosts[name] : undefined;
  if (host === undefined) {
    out.stderr(`hosts.${screenHostKey(name)}: not in the installation file\n`);
    return 1;
  }
  if (host.roles.includes("orchestrator")) {
    out.stderr(
      `hosts.${screenHostKey(name)} holds the orchestrator role, and an installation needs exactly one orchestrator host; move the role to another host first (hosts edit)\n`,
    );
    return 1;
  }
  const otherLaneRunner = Object.entries(hosts).find(
    ([hostName, entry]) =>
      hostName !== name && entry.roles.includes("lane-runner"),
  );
  if (host.roles.includes("lane-runner") && otherLaneRunner === undefined) {
    out.stderr(
      `hosts.${screenHostKey(name)} is the last lane-runner host; move the lane-runner role to another host before removing it\n`,
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
      out.stderr(
        `${screenHostsLine(`attempt ${attempt.id} is ${attempt.state} on ${name}`, [name])}\n`,
      );
    }
    out.stderr(
      `${screenHostsLine(`hosts.${name} has live work; nothing was removed`, [name])}\n`,
    );
    return 1;
  }
  const reservations = await journal.listActiveReservations(name);
  if (reservations.length > 0) {
    for (const reservation of reservations) {
      out.stderr(
        `${screenHostsLine(`reservation ${reservation.id} holds a slot for attempt ${reservation.attemptId} on ${name}`, [name])}\n`,
      );
    }
    out.stderr(
      `${screenHostsLine(`hosts.${name} has live work; nothing was removed`, [name])}\n`,
    );
    return 1;
  }

  if (host.runner !== undefined && host.transport === "ssh") {
    out.stdout(
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
    out.stdout(
      "the installation is single-machine again: no host is reached over ssh\n",
    );
  }
  return confirmAndWrite(file, state.read, candidate, args, out, options);
}

/** The one stderr line for a rename refusal reason; never echoes a name. */
function renameRefusalLine(reason: PlanHostRenameReason): string {
  switch (reason) {
    case "name-too-long":
      return HOST_NAME_TOO_LONG;
    case "secret-new-name":
      return HOST_NAME_SECRET_REFUSAL;
    case "invalid-new-name":
      return "hosts rename: the new host name is not a valid host name";
    case "same-name":
      return "hosts rename: the new name is the same as the current name";
    case "missing":
      return "hosts rename: no host has that name";
    case "exists":
      return "hosts rename: the new name is already a host";
    case "not-v2":
      return "installation: not a schema version 2 file";
    case "hosts-not-object":
    case "not-object":
      return "installation: invalid";
    case "unreadable":
      return "installation: unreadable";
  }
}

/**
 * `fleet-v2 hosts rename <old> <new>`: rewrite one host key through the
 * compare-and-swap write, so a key the loader refuses for secret-shaped text
 * can be renamed. It reads the raw file (no parse), plans the rename on the
 * value, confirms, and writes under `<file>.lock`. The old key is never
 * echoed: only `host:<12 hex>` of it appears.
 */
async function renameHost(
  args: HostsArgs,
  file: string,
  out: CliIo,
  options: HostsCliOptions,
): Promise<number> {
  const oldName = args.name;
  const newName = args.newName;
  if (oldName === undefined || newName === undefined) {
    out.stderr(
      `hosts rename requires the current name and the new name\n${HOSTS_HELP}\n`,
    );
    return 2;
  }
  const read = await readInstallationFile(file);
  if (read.status === "unreadable") {
    out.stderr("installation: unreadable\n");
    return 1;
  }
  if (read.status === "absent") {
    out.stderr("installation: absent\n");
    return 1;
  }
  if (read.value === undefined) {
    out.stderr("installation: invalid\n");
    return 1;
  }
  const planned = planHostRename(read.value, oldName, newName);
  if (!planned.ok) {
    out.stderr(
      `${screenHostsLine(renameRefusalLine(planned.reason), [oldName])}\n`,
    );
    return 1;
  }
  const screened = `host:${sha256Of(oldName).slice(0, 12)}`;
  const digest = sha256Of(
    JSON.stringify({ expectedHash: read.hash, newName, oldName }),
  );
  if (!args.yes) {
    const confirm = options.confirm ?? confirmFromStdin(out);
    if (!(await confirm(
        `rename host ${screened} to ${screenHostKey(newName)}? [y/N]`,
      ))) {
      out.stderr("not confirmed; nothing was written\n");
      return 1;
    }
  }
  const result = await writeInstallation({
    file,
    candidate: planned.candidate,
    expectedHash: read.hash,
  });
  if (result.status === "refused") {
    out.stderr(`installation: ${result.reason}\n`);
    return 1;
  }
  // Our own digest of our own rename request — not operator input, not file
  // content — written through the same branded path as the write receipt,
  // which the frozen hosts-command contract prints in full (F96-8).
  const wrapped = out as Partial<ScreenedHostsIo>;
  if (typeof wrapped.stdoutDigest === "function") {
    wrapped.stdoutDigest(
      `renamed host ${screened} to ${screenHostKey(newName)} request:`,
      digest as WriteDigest,
      "\n",
    );
  } else {
    out.stdout(
      `renamed host ${screened} to ${screenHostKey(newName)} request:${digest}\n`,
    );
  }
  return 0;
}

async function listHosts(file: string, out: CliIo): Promise<number> {
  const state = await readInstallationState(file);
  if (state.status === "unreadable") {
    out.stderr(`${file}: could not be read (${state.reason})\n`);
    return 1;
  }
  if (state.status === "invalid") {
    out.stderr("the installation file is invalid; fix it by hand:\n");
    printErrors(out, state.errors);
    return 1;
  }
  if (state.status === "absent") {
    out.stdout("no installation file\n");
    return 0;
  }
  if (state.status === "v1") {
    out.stdout(
      "the installation file is schema version 1; it has no named hosts, and the first hosts add converts it to version 2\n",
    );
    return 0;
  }
  const hosts = state.installation.hosts ?? {};
  const names = [...Object.keys(hosts)].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    out.stdout("no hosts are configured\n");
    return 0;
  }
  for (const name of names) {
    const host = hosts[name];
    const parts = [
      // Every line passes the one hosts screen: the raw key is replaced by
      // its screened code there, so a secret-shaped key or a long opaque
      // token run is never echoed, even from a file that parsed (HN1 fix
      // round 1, finding 1; round 2, finding 1).
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
    out.stdout(`${screenHostsLine(parts.join("  "), names)}\n`);
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
  file: string,
  out: ScreenedHostsIo,
  options: HostsCliOptions,
): Promise<number> {
  const parsed = parseDaemonArgs(argv);
  if (!parsed.ok) {
    out.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    out.stdout(`${HOSTS_HELP}\n`);
    return 0;
  }
  const args = parsed.args;
  const state = await readInstallationState(file);
  if (state.status === "absent") {
    out.stderr("installation: absent\n");
    return 1;
  }
  if (state.status === "unreadable") {
    out.stderr("installation: unreadable\n");
    return 1;
  }
  if (state.status === "invalid") {
    printErrors(out, state.errors);
    return 1;
  }
  if (state.status === "v1") {
    out.stderr("installation.daemon: schema version 1 has no daemon section\n");
    return 1;
  }
  const daemon = state.installation.daemon;
  if (daemon === undefined) {
    out.stderr("installation.daemon: absent\n");
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
    out.stdout(`${unit.key} ${unit.code}\n`);
  }
  if (result.operatorLines !== null) {
    for (const line of result.operatorLines) {
      out.stdout(`${line}\n`);
    }
  }
  return result.units.some((unit) => unit.code === "unreadable") ? 1 : 0;
}

/**
 * The one tag an escaped error is named by: `error.code` when it is an
 * upper-case identifier, else `error.name` when it is an `*Error` name, else
 * `unknown`. A non-Error has no tag at all.
 */
function errorTag(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(code)) {
    return code;
  }
  if (/^[A-Za-z]{1,60}Error$/.test(error.name)) {
    return error.name;
  }
  return "unknown";
}

/**
 * `fleet-v2 hosts <subcommand>`; exit codes: 0 written/listed, 1 refused, 2
 * usage. No thrown error escapes the screened io (HN1b fix a): the file read
 * is guarded before the installation keys are known — it reports a tag-only
 * line — and every later throw is caught and reported as exactly one screened
 * line, never a stack and never a raw non-Error value.
 */
export async function hostsCommand(
  argv: readonly string[],
  rawIo: CliIo,
  hostsOptions: HostsCliOptions = {},
): Promise<number> {
  const file =
    hostsOptions.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());
  const out = screenedHostsIo(rawIo, [...argv]);
  let read: Awaited<ReturnType<typeof readInstallationFile>>;
  try {
    read = await readInstallationFile(file);
  } catch (error: unknown) {
    out.stderr(`error: ${errorTag(error)}\n`);
    return 1;
  }
  if (read.status === "read") {
    out.addKeys(installationKeys(read.value));
  }
  try {
    // The confirmation question reaches an injected gate without passing the
    // wrapped stdout, so it is screened here with the same screen.
    const injectedConfirm = hostsOptions.confirm;
    const options: HostsCliOptions =
      injectedConfirm === undefined
        ? hostsOptions
        : {
            ...hostsOptions,
            confirm: (question) => injectedConfirm(out.screen(question)),
          };
    if (argv[0] === "daemon") {
      return await daemonCommand(argv.slice(1), file, out, options);
    }
    const parsed = parseHostsArgs(argv);
    if (!parsed.ok) {
      out.stderr(`${parsed.error}\n`);
      return 2;
    }
    if (parsed.help) {
      out.stdout(`${HOSTS_HELP}\n`);
      return 0;
    }
    const args = parsed.args;
    if (args.subcommand === "list") {
      return await listHosts(file, out);
    }
    if (args.subcommand === "remove") {
      return await removeHost(args, file, out, options);
    }
    if (args.subcommand === "rename") {
      return await renameHost(args, file, out, options);
    }
    return await writeHost(
      args.subcommand === "edit" ? "edit" : "add",
      args,
      file,
      out,
      options,
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      out.stderr(`error: ${errorTag(error)}: ${error.message.split("\n")[0]}\n`);
    } else {
      out.stderr("error: unknown\n");
    }
    return 1;
  }
}
