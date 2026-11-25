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
import { isSafeSshHost } from '@fleet/installation';
import type { ToolId } from '@fleet/tooling';

import { renderAutoMergeStatus, summariseAutoMerge } from '../policy/auto-merge.js';

import { checkGhAuthNonInteractive } from './gh-binary.js';
import type { DoctorLine, DoctorStatus } from './types.js';
import type { DoctorProbes, DiskQuotaUsage } from './probes.js';

/** A trimmed, lowercase hex git commit id of 7–40 characters. */
const COMMIT_ID = /^[0-9a-f]{7,40}$/i;

/** A commit id is valid after trimming; comparisons use the lowercase form. */
function normaliseCommit(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return COMMIT_ID.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** Display form of a commit id: at most 8 hex characters. */
function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}

/**
 * At most the final path segment of an install root name, so no directory
 * prefix ever reaches a doctor detail.
 */
function installRootBasename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  return base;
}

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

/** What a detail prints in place of an ssh alias the transport refuses. */
const UNSAFE_ALIAS_SHOWN = '[unsafe ssh alias]';

/** Detail of the reachability FAIL line of a host whose ssh alias is refused. */
const UNSAFE_ALIAS_DETAIL =
  'ssh alias refused: not a safe host string; no command was run on this host';

/** True when the probe host is an ssh alias the transport refuses before any spawn. */
function isRefusedAlias(probeHost: string): boolean {
  return probeHost !== 'local' && !isSafeSshHost(probeHost);
}

/** The probe host as a detail may print it: never a refused alias. */
function shownHost(probeHost: string): string {
  return isRefusedAlias(probeHost) ? UNSAFE_ALIAS_SHOWN : probeHost;
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

/** Marker: the injected probes carry no `ciRunnerSlot` method. */
const NO_SLOT_PROBE = Symbol('no-ci-runner-slot-probe');

/** The inactive-slot detail when the fix line cannot be printed whole. */
const SLOT_FIX_FALLBACK =
  'slot not active; fix: sudo systemctl restart <the unit this slot names under ciRunnerSlots> on this host';

/** Status and detail of one slot line; anything but an exact known answer is UNKNOWN. */
function ciRunnerSlotVerdict(
  state: unknown,
  slot: { readonly name: string; readonly unit: string },
  probeHost: string,
): readonly [DoctorStatus, string] {
  if (state === 'active') {
    return ['PASS', `slot ${slot.name} active`];
  }
  if (state === 'inactive') {
    // Printed whole or not at all: a fix line the boundary would redact or
    // cut is replaced, never shown with a hole in the command.
    const fix = `slot ${slot.name} not active; fix: sudo systemctl restart ${slot.unit} on ${shownHost(probeHost)}`;
    return ['FAIL', boundDoctorDetail(fix) === fix ? fix : SLOT_FIX_FALLBACK];
  }
  if (state === NO_SLOT_PROBE) {
    return ['UNKNOWN', `slot ${slot.name} probe not available`];
  }
  return ['UNKNOWN', `slot ${slot.name} state could not be read`];
}

/**
 * One line per CI runner slot the host declares (OG-28c), in declared
 * order. The port read, the call and the answer all happen inside `safely`,
 * so a throwing getter, a throwing or rejecting probe and a hostile answer
 * are UNKNOWN, never a crash. The answer is only compared with `===`; no
 * property of it is read. Details carry the slot name, the unit name and
 * the probe host only.
 */
async function ciRunnerSlotLines(
  name: string,
  host: HostModel,
  probeHost: string,
  probes: DoctorProbes,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const slot of host.ciRunnerSlots ?? []) {
    const state: unknown = await safely(async () => {
      const probe = probes.ciRunnerSlot;
      return typeof probe === 'function'
        ? await probe.call(probes, probeHost, slot.unit)
        : NO_SLOT_PROBE;
    });
    const [status, detail] = ciRunnerSlotVerdict(state, slot, probeHost);
    lines.push(line('host', name, `ci-runner-${slot.name}`, status, detail));
  }
  return lines;
}

/** Marker: the injected probes carry no `loginShell` method. */
const NO_SHELL_PROBE = Symbol('no-login-shell-probe');

/** The minimum fraction of the disk quota that must remain free. */
export const DISK_QUOTA_MIN_HEADROOM = 0.1;

/** Marker: the injected probes carry no `diskQuotaUsage` method. */
const NO_DISK_QUOTA_PROBE = Symbol('no-disk-quota-probe');

/**
 * Read one probe answer's two numbers. `O(1)`: only the probe result's own
 * data descriptors `'usedBytes'` and `'totalBytes'` are inspected, never a
 * getter (a getter is refused, not invoked), never a prototype property,
 * never anything else on the object. An array-like is refused. Anything else
 * is `undefined`.
 */
export function readDiskQuotaUsage(raw: unknown): DiskQuotaUsage | undefined {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    // An array-like is refused too: any own numeric `length`, safe or not,
    // finite or not, marks an array-like. It is read through the own
    // descriptor so no getter is ever invoked.
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, 'length');
    if (
      lengthDescriptor !== undefined &&
      'value' in lengthDescriptor &&
      typeof lengthDescriptor.value === 'number'
    ) {
      return undefined;
    }
    const readings: [string, number | undefined][] = [];
    for (const key of ['usedBytes', 'totalBytes'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'number' ||
        !Number.isSafeInteger(descriptor.value)
      ) {
        return undefined;
      }
      readings.push([key, descriptor.value]);
    }
    const usedBytes = readings[0][1];
    const totalBytes = readings[1][1];
    if (
      usedBytes === undefined ||
      totalBytes === undefined ||
      totalBytes <= 0 ||
      usedBytes < 0 ||
      usedBytes > totalBytes
    ) {
      return undefined;
    }
    return { usedBytes, totalBytes };
  } catch {
    return undefined;
  }
}

/** Status and detail of the host's disk-quota line; anything hostile is UNKNOWN. */
function diskQuotaVerdict(
  raw: unknown,
  probeHost: string,
): readonly [DoctorStatus, string] {
  if (raw === NO_DISK_QUOTA_PROBE) {
    return ['UNKNOWN', 'disk quota probe not available'];
  }
  const usage = readDiskQuotaUsage(raw);
  if (usage === undefined) {
    return ['UNKNOWN', `disk quota could not be read via ${shownHost(probeHost)}`];
  }
  const headroom = (usage.totalBytes - usage.usedBytes) / usage.totalBytes;
  const pct = (Math.floor(headroom * 1000) / 10).toFixed(1);
  if (headroom >= DISK_QUOTA_MIN_HEADROOM) {
    return ['PASS', `disk quota headroom ${pct}% via ${shownHost(probeHost)}`];
  }
  return [
    'FAIL',
    `disk quota headroom ${pct}% below ${Math.round(DISK_QUOTA_MIN_HEADROOM * 100)}% minimum via ${shownHost(probeHost)}`,
  ];
}

/**
 * One disk-quota line per ssh host that declares a runner. The port read,
 * the call and the answer all happen inside `safely`, so a throwing getter,
 * a throwing or rejecting probe and a hostile answer are UNKNOWN, never a
 * crash. Details carry the probe host only.
 */
async function diskQuotaLine(
  name: string,
  host: HostModel,
  probeHost: string,
  probes: DoctorProbes,
): Promise<DoctorLine | undefined> {
  if (host.transport !== 'ssh' || host.runner === undefined) {
    return undefined;
  }
  const raw: unknown = await safely(async () => {
    // The port is read through its own data descriptor, so a getter on
    // `probes.diskQuotaUsage` is refused without ever being invoked.
    const descriptor = Object.getOwnPropertyDescriptor(probes, 'diskQuotaUsage');
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function'
    ) {
      return NO_DISK_QUOTA_PROBE;
    }
    return await descriptor.value.call(probes, probeHost);
  });
  const [status, detail] = diskQuotaVerdict(raw, probeHost);
  return line('host', name, 'disk-quota', status, detail);
}

/** Detail of every unprobed line of a host whose login shell failed the canary. */
const NOT_PROBED_DETAIL = 'not probed: login shell failed the canary';

/**
 * The login-shell canary answer of every ssh host, keyed by host name; a
 * local host has no entry. The port read, the call and the answer all
 * happen inside `safely`, so a throwing getter and a throwing or rejecting
 * probe store `undefined`, never crash.
 */
async function loginShellStates(
  model: FleetInstallationModel,
  probes: DoctorProbes,
): Promise<ReadonlyMap<string, unknown>> {
  const states = new Map<string, unknown>();
  for (const [name, host] of Object.entries(model.hosts)) {
    if (host.transport !== 'ssh') {
      continue;
    }
    const probeHost = probeHostOf(name, host);
    const state: unknown = await safely(async () => {
      const probe = probes.loginShell;
      return typeof probe === 'function' ? await probe.call(probes, probeHost) : NO_SHELL_PROBE;
    });
    states.set(name, state);
  }
  return states;
}

/** Status and detail of the login-shell line; the answer is only compared with `===`. */
function loginShellVerdict(state: unknown, probeHost: string): readonly [DoctorStatus, string] {
  if (state === 'intact') {
    return ['PASS', `login shell passes sh -c intact via ${shownHost(probeHost)}`];
  }
  if (state === 'mangled') {
    return [
      'FAIL',
      `login shell did not return the canary unchanged via ${shownHost(probeHost)} (it altered sh -c or printed extra output); this host's other lines are not trustworthy`,
    ];
  }
  if (state === NO_SHELL_PROBE) {
    return ['UNKNOWN', 'login shell probe not available'];
  }
  return ['UNKNOWN', `login shell could not be checked via ${shownHost(probeHost)}`];
}

/** The configuration-derived lines of a host's runner; nothing here is probed. */
function runnerConfigLines(name: string, host: HostModel): DoctorLine[] {
  const lines: DoctorLine[] = [];
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
  return lines;
}

/**
 * The lines of a host whose login shell failed the canary, in the order a
 * probed host reports them: every remote check UNKNOWN and unprobed, the
 * runner configuration lines unchanged.
 */
function skippedHostLines(name: string, host: HostModel): DoctorLine[] {
  const skipped = (check: string): DoctorLine =>
    line('host', name, check, 'UNKNOWN', NOT_PROBED_DETAIL);
  const checks: string[] = [
    'reachable',
    ...PLATFORM_TOOLS.map((tool) => `command-${tool}`),
    'command-ssh',
  ];
  if (host.worktreeRoot !== undefined) {
    checks.push('worktree-root-writable');
  }
  const lines = checks.map((check) => skipped(check));
  lines.push(...runnerConfigLines(name, host));
  for (const slot of host.ciRunnerSlots ?? []) {
    lines.push(skipped(`ci-runner-${slot.name}`));
  }
  if (host.transport === 'ssh' && host.runner !== undefined) {
    lines.push(skipped('disk-quota'));
  }
  return lines;
}

/** Detail of the `reachable` line; a refused alias is named as refused, never printed. */
function reachableDetail(
  reachable: boolean | undefined,
  probeHost: string,
  roles: string,
): string {
  if (reachable === undefined) {
    return `reachability probe failed (${shownHost(probeHost)})`;
  }
  if (reachable) {
    return `reachable via ${shownHost(probeHost)} (roles: ${roles})`;
  }
  return isRefusedAlias(probeHost) ? UNSAFE_ALIAS_DETAIL : `not reachable via ${probeHost}`;
}

/** Per-host and role lines: reachability, platform tools, worktree root, runner capabilities. */
async function hostLines(
  model: FleetInstallationModel,
  probes: DoctorProbes,
  shells: ReadonlyMap<string, unknown>,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const [name, host] of Object.entries(model.hosts)) {
    const probeHost = probeHostOf(name, host);
    const roles = host.roles.join(', ');

    if (shells.has(name)) {
      const shell = shells.get(name);
      const [status, detail] = loginShellVerdict(shell, probeHost);
      lines.push(line('host', name, 'login-shell', status, detail));
      if (shell === 'mangled') {
        lines.push(...skippedHostLines(name, host));
        continue;
      }
    }

    const reachable = await safely(() => probes.hostReachable(probeHost));
    lines.push(
      line(
        'host',
        name,
        'reachable',
        reachable === undefined ? 'UNKNOWN' : reachable ? 'PASS' : 'FAIL',
        reachableDetail(reachable, probeHost, roles),
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

    lines.push(...runnerConfigLines(name, host));
    lines.push(...(await ciRunnerSlotLines(name, host, probeHost, probes)));
    const diskQuota = await diskQuotaLine(name, host, probeHost, probes);
    if (diskQuota !== undefined) {
      lines.push(diskQuota);
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
    }
  }
  return lines;
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
    return [
      line('gh-binary', 'gh', 'resolved', 'UNKNOWN', 'gh resolution probe failed'),
      line(
        'gh-binary',
        'gh',
        'auth-non-interactive',
        'UNKNOWN',
        'gh binary not resolved; non-interactive auth not checked',
      ),
    ];
  }
  if (gh.resolved !== undefined) {
    const resolved = line('gh-binary', 'gh', 'resolved', 'PASS', gh.resolved);
    if (probes.ghAuth === undefined) {
      return [
        resolved,
        line('gh-binary', 'gh', 'auth-non-interactive', 'UNKNOWN', 'gh auth probe not configured'),
      ];
    }
    const authLine = await safely(() =>
      checkGhAuthNonInteractive(() => probes.ghAuth!(gh.resolved!)),
    );
    if (authLine === undefined) {
      // checkGhAuthNonInteractive never throws; this guard keeps the sweep
      // alive even if that ever changes.
      return [
        resolved,
        line('gh-binary', 'gh', 'auth-non-interactive', 'UNKNOWN', 'gh non-interactive auth probe failed'),
      ];
    }
    return [
      resolved,
      line(authLine.scope, authLine.subject, authLine.check, authLine.status, authLine.detail),
    ];
  }
  return [
    line(
      'gh-binary',
      'gh',
      'resolved',
      'FAIL',
      `gh not found at ${gh.candidates.join(', ')}; conducted runs open PRs through one of these paths`,
    ),
    line(
      'gh-binary',
      'gh',
      'auth-non-interactive',
      'UNKNOWN',
      'gh binary not resolved; non-interactive auth not checked',
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
 * binary, the reviewed gh binary, the pinned build's freshness, then seats.
 * Each yielded line is one
 * check; the generator awaits probes sequentially so output order is
 * stable. The login-shell canary of every ssh host is probed before
 * anything else. The server answers are computed before the `model-listed` line is
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
  const shells = await loginShellStates(result.model, probes);
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
  for (const doctorLine of await hostLines(result.model, probes, shells)) {
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
  for (const doctorLine of await pinnedBuildLines(probes)) {
    yield doctorLine;
  }
  for (const doctorLine of await seatLines(result.model, probes, options)) {
    yield doctorLine;
  }
}

/** Control, separator and bidi characters that must never reach a doctor line. */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Marker: the probe result could not be read safely. */
const UNREADABLE_RESULT = Symbol('unreadable-pinned-build-result');

interface PinnedBuildSnapshot {
  readonly pinnedCommit: unknown;
  readonly baseTipCommit: unknown;
  readonly behindCount: unknown;
  readonly installRootName: unknown;
}

/**
 * Copy every field of an untrusted pinned-build result once, so no later
 * read can run a hostile accessor. A non-object result, or any accessor that
 * throws, yields `UNREADABLE_RESULT`.
 */
function snapshotPinnedBuild(
  result: unknown,
): PinnedBuildSnapshot | null | typeof UNREADABLE_RESULT {
  if (result === undefined || result === null) {
    return null;
  }
  try {
    if (typeof result !== 'object') {
      return UNREADABLE_RESULT;
    }
    const record = result as Record<string, unknown>;
    return {
      pinnedCommit: record.pinnedCommit,
      baseTipCommit: record.baseTipCommit,
      behindCount: record.behindCount,
      installRootName: record.installRootName,
    };
  } catch {
    return UNREADABLE_RESULT;
  }
}

/**
 * The pinned-build freshness check: the installed build's commit against the
 * base branch tip. Pure: it consumes only the injected probe result — no
 * `git` subprocess, no filesystem access. Any unreadable field or failed
 * probe reports `UNKNOWN`, never `PASS`; a pinned build behind the tip is
 * `FAIL` with the commit distance.
 */
export async function pinnedBuildLines(probes: DoctorProbes): Promise<DoctorLine[]> {
  let probeFn: DoctorProbes['pinnedBuild'];
  try {
    probeFn = probes.pinnedBuild;
  } catch {
    // Even reading the port can throw (a hostile getter); that is a probe
    // failure, never a crash.
    return [
      line('installation', 'build', 'pinned-build', 'UNKNOWN', 'pinned build probe failed'),
    ];
  }
  if (probeFn === undefined || typeof probeFn !== 'function') {
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'UNKNOWN',
        'pinned build probe not available',
      ),
    ];
  }
  // The probe result is untrusted: every field is read inside `safely`, so a
  // throwing accessor (or a hostile `then`) is a probe failure, never a crash.
  const probe = await safely(async () => snapshotPinnedBuild(await probeFn!()));
  if (probe === undefined || probe === null) {
    return [
      line('installation', 'build', 'pinned-build', 'UNKNOWN', 'pinned build probe failed'),
    ];
  }
  if (probe === UNREADABLE_RESULT) {
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'UNKNOWN',
        'pinned build probe result could not be read',
      ),
    ];
  }
  const pinnedCommit = normaliseCommit(probe.pinnedCommit);
  if (pinnedCommit === undefined) {
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'UNKNOWN',
        'pinned build commit could not be read',
      ),
    ];
  }
  const baseTipCommit = normaliseCommit(probe.baseTipCommit);
  if (baseTipCommit === undefined) {
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'UNKNOWN',
        'base branch tip commit could not be read',
      ),
    ];
  }
  let root = '';
  if (probe.installRootName !== undefined) {
    const rootName =
      typeof probe.installRootName === 'string'
        ? installRootBasename(probe.installRootName)
        : undefined;
    if (rootName === undefined || UNPRINTABLE.test(rootName)) {
      return [
        line(
          'installation',
          'build',
          'pinned-build',
          'UNKNOWN',
          'pinned build install root name could not be read',
        ),
      ];
    }
    root = rootName;
  }
  const rootSuffix = root === '' ? '' : ` (install root ${root})`;
  if (pinnedCommit === baseTipCommit) {
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'PASS',
        `pinned build matches base branch tip ${shortCommit(pinnedCommit)}${rootSuffix}`,
      ),
    ];
  }
  const behind = probe.behindCount;
  if (
    typeof behind !== 'number' ||
    !Number.isSafeInteger(behind) ||
    behind < 0
  ) {
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'UNKNOWN',
        'commit distance between pinned build and base tip could not be determined',
      ),
    ];
  }
  if (behind === 0) {
    // Not equal and not behind: the builds have diverged. Never a pass.
    return [
      line(
        'installation',
        'build',
        'pinned-build',
        'UNKNOWN',
        `pinned build ${shortCommit(pinnedCommit)} and base tip ${shortCommit(baseTipCommit)} have diverged${rootSuffix}`,
      ),
    ];
  }
  return [
    line(
      'installation',
      'build',
      'pinned-build',
      'FAIL',
      `pinned build is ${behind} commit${behind === 1 ? '' : 's'} behind base branch tip ${shortCommit(baseTipCommit)}${rootSuffix}`,
    ),
  ];
}

/**
 * The doctor exit code: `0` when every line passed, `1` when any line
 * failed or is unknown (the `AGENTS.md` contract; a usage error is `2` and
 * belongs to the CLI, not the engine).
 */
export function doctorExitCode(lines: readonly DoctorLine[]): 0 | 1 {
  return lines.every((doctorLine) => doctorLine.status === 'PASS') ? 0 : 1;
}
