/**
 * The doctor engine (plan section 6): read-only checks over a loaded
 * installation, reported as an ordered stream of `DoctorLine`s. The engine
 * performs no side effect itself — every observation enters through the
 * injected `DoctorProbes` — and a probe that throws becomes an `UNKNOWN`
 * line, never a crash. Details carry paths, modes, versions and reasons
 * only; never file contents, keys or tokens. The sweep also probes the
 * opencode server each host runs (`server-answers`) and reports whether the
 * servers list every opencode seat the installation names (`model-listed`).
 */

import type {
  FleetInstallationModel,
  HostModel,
  LoadResult,
  SeatModel,
} from '@fleet/installation';
import type { ToolId } from '@fleet/tooling';
import {
  CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION,
  claudeCodeSupportsPermissionHookBlock,
} from '@fleet/tooling';

import { renderAutoMergeStatus, summariseAutoMerge } from '../policy/auto-merge.js';

import type { DoctorLine, DoctorStatus } from './types.js';
import type { DoctorProbes } from './probes.js';

/** A load result doctor can check: absent or loaded, never invalid. */
export type DoctorableInstallation = Exclude<LoadResult, { status: 'invalid' }>;

export interface RunDoctorOptions {
  /**
   * Probe each seat with the one-step seat probe. `false` reports one
   * `UNKNOWN` line per seat and calls `seatProbe` zero times.
   */
  readonly probeSeats: boolean;
  /**
   * Probe every opencode server the installation runs and report
   * `server-answers` lines plus `model-listed`. `false` skips server probes
   * and does not emit `model-listed`. Defaults to `true`.
   */
  readonly probeServers?: boolean;
  /**
   * The operator environment the routing check inspects (H3b). The engine
   * itself never reads `process.env`; the CLI root passes it. When omitted,
   * no routing lines are reported.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const PLATFORM_TOOLS = ['sh', 'nc', 'curl'] as const;

/**
 * The routing variables a v2 installation ignores (plan section 3, "Runtime
 * reads the selected host, never the environment"). `FLEET_OCM_RUN_BIN` is
 * deliberately absent: it is a binary path, not a route.
 */
export const ROUTING_ENV_VARS: readonly string[] = [
  'OCM_REMOTE_PORT',
  'OCM_HOST',
  'FLEET_WORKTREE_SSH_HOST',
];

/** Longest detail a probe may contribute to a doctor line. */
const MAX_DETAIL_CHARS = 200;

const REDACTED = '[redacted]';

/**
 * Secret shapes a probe output must never carry into a doctor line. Order
 * matters: the vendor-prefixed and header shapes are named explicitly, then
 * the generic token-like shape catches everything else of standing length.
 * The generic shape does not eat the expected-vs-actual `sha256 <hex>` pair
 * the runner-binary check reports, so it refuses a match directly behind
 * either label.
 */
const SECRET_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/gh[pousr]_[A-Za-z0-9_]{8,}\b/g, REDACTED],
  [/\bBearer\s+\S+/gi, REDACTED],
  [/(?<!sha256 )(?<!expected )\b[A-Za-z0-9_-]{24,}\b/g, REDACTED],
];

/** Replace every secret-shaped substring with `[redacted]`. */
export function redactSecretShapes(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_SHAPES) {
    redacted = redacted.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return redacted;
}

/**
 * Bound a probe-produced detail before it reaches a doctor line: one line
 * (newlines and tabs folded to single spaces), every secret-shaped string
 * replaced by `[redacted]`, and at most 200 characters.
 */
export function boundDoctorDetail(detail: string): string {
  let bounded = detail.replace(/\s*\r?\n\s*/g, ' ').replace(/[\t ]+/g, ' ').trim();
  bounded = redactSecretShapes(bounded);
  return bounded.length > MAX_DETAIL_CHARS
    ? bounded.slice(0, MAX_DETAIL_CHARS)
    : bounded;
}

/** Format a stat mode as the conventional octal literal, e.g. `0644`. */
function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * Run one probe; a throw (or rejection) becomes `undefined` and the caller
 * reports `UNKNOWN` with the given reason. A probe result is never allowed
 * to crash the sweep.
 */
async function safely<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe();
  } catch {
    return undefined;
  }
}

function line(
  scope: DoctorLine['scope'],
  subject: string,
  check: string,
  status: DoctorStatus,
  detail: string,
): DoctorLine {
  // Every detail of every probe implementation passes this boundary: one
  // line, bounded length, no secret-shaped text.
  return { scope, subject, check, status, detail: boundDoctorDetail(detail) };
}

/** The host string probes address: the ssh alias for ssh hosts, `local` otherwise. */
function probeHostOf(name: string, host: HostModel): string {
  return host.transport === 'ssh' ? (host.sshAlias ?? name) : 'local';
}

/**
 * One FAIL line per routing variable set while a v2 installation is loaded
 * (plan section 3): the variable is named, never valued, and the detail says
 * where the setting belongs instead. A blank value counts as unset, the same
 * way the composition roots treat it. A v1 or absent installation keeps
 * today's environment behaviour, so no line is reported for it.
 */
function routingEnvLines(
  result: DoctorableInstallation,
  env: Readonly<Record<string, string | undefined>> | undefined,
): DoctorLine[] {
  if (env === undefined || result.installation.schemaVersion !== 2) {
    return [];
  }
  const lines: DoctorLine[] = [];
  for (const name of ROUTING_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value.trim() === '') continue;
    lines.push(
      line(
        'installation',
        name,
        'routing-env',
        'FAIL',
        `${name} is set but ignored for v2; set it on the host entry`,
      ),
    );
  }
  return lines;
}

/** Installation-level lines: schema version and any accepted-and-ignored v1 fields. */
async function installationLines(
  result: DoctorableInstallation,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const mapped =
    result.installation.schemaVersion === 1
      ? `schema version 1, mapped onto v2`
      : `schema version 2`;
  lines.push(
    line('installation', 'schema', 'schema-version', 'PASS', mapped),
  );
  if (result.installation.schemaVersion === 2) {
    const freeFlag = result.model.policy?.useFreeSeats;
    if (freeFlag === false) {
      const freeCount = (result.model.seats ?? []).filter(
        (seat) => seat.costClass === 'free',
      ).length;
      lines.push(
        line(
          'installation',
          'policy',
          'free-tier',
          'PASS',
          `off (policy.useFreeSeats false); ${freeCount} free seat(s) disabled`,
        ),
      );
    } else if (freeFlag === undefined) {
      lines.push(
        line(
          'installation',
          'policy',
          'free-tier',
          'PASS',
          'on (policy.useFreeSeats absent; absent means on)',
        ),
      );
    } else {
      lines.push(
        line(
          'installation',
          'policy',
          'free-tier',
          'PASS',
          'on (policy.useFreeSeats true)',
        ),
      );
    }
    lines.push(
      line(
        'installation',
        'policy',
        'auto-merge',
        'PASS',
        renderAutoMergeStatus(summariseAutoMerge(result.installation))[0],
      ),
    );
  }
  for (const warning of result.warnings) {
    // The loader's warnings name accepted-and-ignored v1 fields (D1); they
    // are never failures because nothing consumes those fields today.
    lines.push(
      line('installation', 'shelf', 'v1-ignored-fields', 'PASS', warning),
    );
  }
  return lines;
}

/** Per-host and role lines: reachability, platform tools, worktree root, runner capabilities. */
async function hostLines(
  model: FleetInstallationModel,
  probes: DoctorProbes,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const [name, host] of Object.entries(model.hosts)) {
    const probeHost = probeHostOf(name, host);
    const roles = host.roles.join(', ');

    const reachable = await safely(() => probes.hostReachable(probeHost));
    lines.push(
      line(
        'host',
        name,
        'reachable',
        reachable === undefined ? 'UNKNOWN' : reachable ? 'PASS' : 'FAIL',
        reachable === undefined
          ? `reachability probe failed (${probeHost})`
          : reachable
            ? `reachable via ${probeHost} (roles: ${roles})`
            : `not reachable via ${probeHost}`,
      ),
    );

    const toolNames: string[] = [...PLATFORM_TOOLS];
    if (host.transport === 'ssh') {
      toolNames.push('ssh');
    }
    for (const toolName of toolNames) {
      const available = await safely(() =>
        probes.commandAvailable(probeHost, toolName),
      );
      lines.push(
        line(
          'host',
          name,
          `command-${toolName}`,
          available === undefined ? 'UNKNOWN' : available ? 'PASS' : 'FAIL',
          available === undefined
            ? `availability probe for ${toolName} failed`
            : available
              ? `${toolName} available`
              : `${toolName} not available`,
        ),
      );
    }

    if (host.worktreeRoot !== undefined) {
      const writable = await safely(() =>
        probes.worktreeRootWritable(probeHost),
      );
      lines.push(
        line(
          'host',
          name,
          'worktree-root-writable',
          writable === undefined ? 'UNKNOWN' : writable ? 'PASS' : 'FAIL',
          writable === undefined
            ? `writability probe for ${host.worktreeRoot} failed`
            : writable
              ? `${host.worktreeRoot} writable`
              : `${host.worktreeRoot} not writable`,
        ),
      );
    }

    if (host.runner !== undefined) {
      const capabilities = host.runner.capabilities;
      const status: DoctorStatus =
        capabilities.source === 'declared' ? 'PASS' : 'UNKNOWN';
      lines.push(
        line(
          'host',
          name,
          'runner-capabilities',
          status,
          `capability source ${capabilities.source}, filesystemScope ${capabilities.filesystemScope}`,
        ),
      );
      // KF-30b: conducted acceptance gates are throttled only when the host
      // declares `runner.gateSlot`; without it they run unthrottled next to
      // hand-run gates. A missing declaration is a config gap, not a failure,
      // so it reports as a PASS line with a warning detail (the same
      // convention as accepted-and-ignored v1 fields).
      if (host.roles.includes('lane-runner') && host.runner.gateSlot === undefined) {
        lines.push(
          line(
            'host',
            name,
            'gate-slot',
            'PASS',
            'warning: conducted acceptance gates run unthrottled; declare runner.gateSlot to route them through the host-wide gate slot',
          ),
        );
      }
    }
  }
  return lines;
}

/**
 * Per configured tool on every host in the installation: its version, probed
 * through the same host mapping the other host checks use, or UNKNOWN when
 * absent or unparsable. Each line's subject names the host and the tool.
 */
async function toolLines(
  model: FleetInstallationModel,
  probes: DoctorProbes,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const [name, host] of Object.entries(model.hosts)) {
    const probeHost = probeHostOf(name, host);
    for (const toolId of model.tools ?? []) {
      const version = await safely(() =>
        probes.toolVersion(probeHost, toolId as ToolId),
      );
      lines.push(
        line(
          'tool',
          `${name}/${toolId}`,
          'version',
          version === undefined ? 'UNKNOWN' : 'PASS',
          version === undefined
            ? 'version absent or unparsable'
            : `version ${version}`,
        ),
      );
      if (toolId === 'claude-code') {
        lines.push(claudeCodeHookLine(name, version));
      }
    }
  }
  return lines;
}

/**
 * The start-up check of the Claude Code permission-hook recipe (plan section
 * 4.3): the doctor is the operator's gate before any orchestrated session
 * starts, so a host whose `claude --version` output cannot be confirmed at or
 * above the pinned minimum FAILs here — an older client ignores
 * `onFailure: "block"` on a hook and fails open, and the recipe is unsafe
 * there. The refusal is the pinned rule's own: an unreadable version refuses
 * too, never a guess.
 */
function claudeCodeHookLine(hostName: string, version: string | undefined): DoctorLine {
  if (version === undefined) {
    return line(
      'tool',
      `${hostName}/claude-code`,
      'permission-hook-version',
      'FAIL',
      `the claude --version output is absent or unparsable, so the pinned minimum ${CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION} cannot be confirmed and the permission-hook recipe is unsafe on this host`,
    );
  }
  const supported = claudeCodeSupportsPermissionHookBlock(version);
  return line(
    'tool',
    `${hostName}/claude-code`,
    'permission-hook-version',
    supported ? 'PASS' : 'FAIL',
    supported
      ? `version ${version} supports the pinned minimum ${CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION}`
      : `version ${version} is below the pinned minimum ${CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION}; the permission-hook recipe is unsafe on this host`,
  );
}

/** Credential files: mode only, never contents. Group/world-readable or missing is FAIL. */
async function credentialLines(
  model: FleetInstallationModel,
  probes: DoctorProbes,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const credentialPaths: Array<{ host: string; path: string }> = [];
  for (const host of Object.values(model.hosts)) {
    const authFile = host.runner?.authFile;
    if (authFile !== undefined) {
      // KF-14c: ocm-run reads the runner authFile where it runs, on the
      // orchestrator host (dispatch and the review route both spawn it here
      // and tunnel to the lane host), so the file is probed locally for every
      // host; the lane host never holds it.
      credentialPaths.push({ host: 'local', path: authFile });
    }
  }
  const decisions = model.decisions;
  if (decisions !== undefined && decisions.provider === 'jev') {
    credentialPaths.push({ host: 'local', path: decisions.keyFile });
  }
  for (const credential of credentialPaths) {
    let mode: number | undefined;
    let probeFailed = false;
    try {
      mode = await probes.fileMode(credential.host, credential.path);
    } catch {
      probeFailed = true;
    }
    if (probeFailed) {
      lines.push(
        line(
          'credential',
          credential.path,
          'file-mode',
          'UNKNOWN',
          `${credential.path}: mode probe failed`,
        ),
      );
      continue;
    }
    if (mode === undefined) {
      lines.push(
        line(
          'credential',
          credential.path,
          'file-mode',
          'FAIL',
          `${credential.path}: missing`,
        ),
      );
      continue;
    }
    const groupOrWorldReadable = (mode & 0o077) !== 0;
    lines.push(
      line(
        'credential',
        credential.path,
        'file-mode',
        groupOrWorldReadable ? 'FAIL' : 'PASS',
        groupOrWorldReadable
          ? `${credential.path}: mode ${formatMode(mode)} is group- or world-readable`
          : `${credential.path}: mode ${formatMode(mode)}`,
      ),
    );
  }
  return lines;
}

/** The bundled runner binary: resolved path and sha256 against the expected hash. */
async function runnerBinaryLines(probes: DoctorProbes): Promise<DoctorLine[]> {
  const binary = await safely(() => probes.ocmRunBinary());
  if (binary === undefined) {
    return [
      line(
        'runner-binary',
        'ocm-run',
        'hash',
        'UNKNOWN',
        'bundled ocm-run unresolved or unreadable',
      ),
    ];
  }
  const expected = await safely(() => probes.expectedOcmRunHash());
  if (expected === undefined) {
    return [
      line(
        'runner-binary',
        'ocm-run',
        'hash',
        'UNKNOWN',
        `expected hash unavailable (${binary.path})`,
      ),
    ];
  }
  const matches = binary.sha256 === expected;
  return [
    line(
      'runner-binary',
      'ocm-run',
      'hash',
      matches ? 'PASS' : 'FAIL',
      matches
        ? `${binary.path} sha256 ${binary.sha256}`
        : `${binary.path} sha256 ${binary.sha256} does not match expected ${expected}`,
    ),
  ];
}

/** The reviewed `gh` binary: first executable fixed candidate, or FAIL naming all candidates. */
async function ghBinaryLines(probes: DoctorProbes): Promise<DoctorLine[]> {
  const gh = await safely(() => probes.ghBinary());
  if (gh === undefined) {
    return [line('gh-binary', 'gh', 'resolved', 'UNKNOWN', 'gh resolution probe failed')];
  }
  if (gh.resolved !== undefined) {
    return [line('gh-binary', 'gh', 'resolved', 'PASS', gh.resolved)];
  }
  return [
    line(
      'gh-binary',
      'gh',
      'resolved',
      'FAIL',
      `gh not found at ${gh.candidates.join(', ')}; conducted runs open PRs through one of these paths`,
    ),
  ];
}

/**
 * The opencode servers the installation names: one entry per host with an
 * opencode runner that declares its port. A host with no runner, an `agy`
 * runner or no port contributes nothing.
 */
interface DoctorServer {
  readonly name: string;
  readonly probeHost: string;
  readonly port: number;
}

function opencodeServers(model: FleetInstallationModel): DoctorServer[] {
  const servers: DoctorServer[] = [];
  for (const [name, host] of Object.entries(model.hosts)) {
    const runner = host.runner;
    if (runner === undefined || runner.kind !== 'opencode' || runner.port === undefined) {
      continue;
    }
    servers.push({ name, probeHost: probeHostOf(name, host), port: runner.port });
  }
  return servers;
}

/**
 * One `server-answers` line per opencode server, probed on the host that
 * runs it, plus the union of the model ids the servers list.
 */
async function serverLines(
  model: FleetInstallationModel,
  probes: DoctorProbes,
): Promise<{ lines: DoctorLine[]; models: readonly string[] }> {
  const lines: DoctorLine[] = [];
  const models = new Set<string>();
  for (const server of opencodeServers(model)) {
    const outcome = await safely(() =>
      probes.serverProbe(server.probeHost, server.port),
    );
    if (outcome === undefined) {
      lines.push(
        line('host', server.name, 'server-answers', 'UNKNOWN', 'the server probe failed'),
      );
      continue;
    }
    lines.push(
      line(
        'host',
        server.name,
        'server-answers',
        outcome.outcome === 'pass' ? 'PASS' : outcome.outcome === 'fail' ? 'FAIL' : 'UNKNOWN',
        outcome.reason,
      ),
    );
    for (const modelId of outcome.models ?? []) {
      models.add(modelId);
    }
  }
  return { lines, models: [...models] };
}

/**
 * One installation line about the opencode seats the installation names:
 * does some server the installation runs actually list each seat's model?
 * No opencode seat means no line at all.
 */
function seatModelLine(
  model: FleetInstallationModel,
  listedModels: readonly string[],
): DoctorLine | undefined {
  const freeOff = model.policy?.useFreeSeats === false;
  const seats = (model.seats ?? []).filter(
    (seat) => seat.tool === 'opencode' && !(freeOff && seat.costClass === 'free'),
  );
  if (seats.length === 0) {
    return undefined;
  }
  const listed = (seat: SeatModel): boolean =>
    listedModels.includes(seat.model) ||
    (seat.variant !== undefined && listedModels.includes(`${seat.model}#${seat.variant}`));
  const missingModels = seats.filter((seat) => !listed(seat)).map((seat) => seat.model);
  if (listedModels.length === 0) {
    return line(
      'installation',
      'seats',
      'model-listed',
      'UNKNOWN',
      'no opencode server listed its models; the seats could not be checked',
    );
  }
  if (missingModels.length === 0) {
    return line(
      'installation',
      'seats',
      'model-listed',
      'PASS',
      `the opencode server lists all ${seats.length} opencode seat(s)`,
    );
  }
  return line(
    'installation',
    'seats',
    'model-listed',
    'FAIL',
    `the opencode server does not list ${missingModels.join(', ')}`,
  );
}

/** Seat lines: probed, or explicitly not probed. */
async function seatLines(
  model: FleetInstallationModel,
  probes: DoctorProbes,
  options: RunDoctorOptions,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const freeOff = model.policy?.useFreeSeats === false;
  for (const seat of model.seats ?? []) {
    if (
      freeOff &&
      seat.model.toLowerCase().startsWith('nvidia/') &&
      seat.costClass !== 'free'
    ) {
      lines.push(
        line(
          'seat',
          seat.id,
          'nvidia-cost-class',
          'PASS',
          `warning: an nvidia/ model declared ${seat.costClass}; NVIDIA also serves free routes, so confirm this seat is the paid route`,
        ),
      );
    }
    if (freeOff && seat.costClass === 'free') {
      lines.push(
        line(
          'seat',
          seat.id,
          'free-tier',
          'PASS',
          'disabled: costClass free and policy.useFreeSeats is false; not probed',
        ),
      );
      continue;
    }
    if (!options.probeSeats) {
      lines.push(
        line('seat', seat.id, 'probe', 'UNKNOWN', 'not probed (--probe-seats)'),
      );
      continue;
    }
    const outcome = await safely(() => probes.seatProbe(seat as SeatModel));
    if (outcome === undefined) {
      lines.push(
        line('seat', seat.id, 'probe', 'UNKNOWN', 'seat probe failed'),
      );
      continue;
    }
    lines.push(
      line(
        'seat',
        seat.id,
        'probe',
        outcome.outcome === 'pass'
          ? 'PASS'
          : outcome.outcome === 'fail'
            ? 'FAIL'
            : 'UNKNOWN',
        outcome.reason,
      ),
    );
  }
  return lines;
}

/**
 * Run every doctor check over a loaded installation, in the order:
 * installation, routing, the seat model list, hosts and their roles, the
 * servers' answers, configured tools, credential files, the bundled runner
 * binary, the reviewed gh binary, then seats. Each yielded line is one
 * check; the generator awaits probes sequentially so output order is
 * stable. The server answers are computed before the `model-listed` line is
 * yielded (that line needs the union of the servers' model ids), but the
 * host lines are yielded before the server lines so every `host` line stays
 * together. When `options.probeServers` is `false`, server probing and the
 * `model-listed` check are skipped entirely.
 */
export async function* runDoctor(
  result: DoctorableInstallation,
  probes: DoctorProbes,
  options: RunDoctorOptions,
): AsyncGenerator<DoctorLine> {
  const probeServers = options.probeServers ?? true;
  const serverAnswers = probeServers
    ? await serverLines(result.model, probes)
    : undefined;
  const seatModelCheck =
    probeServers && serverAnswers !== undefined
      ? seatModelLine(result.model, serverAnswers.models)
      : undefined;
  for (const doctorLine of await installationLines(result)) {
    yield doctorLine;
  }
  for (const doctorLine of routingEnvLines(result, options.env)) {
    yield doctorLine;
  }
  if (seatModelCheck !== undefined) {
    yield seatModelCheck;
  }
  for (const doctorLine of await hostLines(result.model, probes)) {
    yield doctorLine;
  }
  if (serverAnswers !== undefined) {
    for (const doctorLine of serverAnswers.lines) {
      yield doctorLine;
    }
  }
  for (const doctorLine of await toolLines(result.model, probes)) {
    yield doctorLine;
  }
  for (const doctorLine of await credentialLines(result.model, probes)) {
    yield doctorLine;
  }
  for (const doctorLine of await runnerBinaryLines(probes)) {
    yield doctorLine;
  }
  for (const doctorLine of await ghBinaryLines(probes)) {
    yield doctorLine;
  }
  for (const doctorLine of await seatLines(result.model, probes, options)) {
    yield doctorLine;
  }
}

/**
 * The doctor exit code: `0` when every line passed, `1` when any line
 * failed or is unknown (the `AGENTS.md` contract; a usage error is `2` and
 * belongs to the CLI, not the engine).
 */
export function doctorExitCode(lines: readonly DoctorLine[]): 0 | 1 {
  return lines.every((doctorLine) => doctorLine.status === 'PASS') ? 0 : 1;
}
