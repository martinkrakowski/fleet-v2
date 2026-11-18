import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type {
  FleetInstallation,
  FleetInstallationModel,
  HostSection,
  RunnerSection,
} from './types.js';
import { deriveInstallationModel } from './model.js';
import { parseInstallation, parsePrepareArgv } from './parse.js';
import { validateSeatPolicy, v1FamilyWarnings } from './policy.js';

/**
 * The filesystem seam the installation-file trust check reads through. Every
 * member defaults to the real `node:fs` behaviour; a test (or an embedding
 * host) may override any member alone, so a uid-mismatch refusal can be
 * exercised without root. The bytes are read from the handle `open` returned
 * and `fstat` runs on that same handle, so no TOCTOU window exists between
 * the identity check and the parse.
 */
export interface InstallationFileSeam {
  /**
   * Open the file `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; a symlink is
   * `ELOOP`. `O_NONBLOCK` keeps a FIFO with no writer from blocking in
   * `open`: the handle is `fstat`-ed immediately and anything that is not
   * a regular file is refused before a single byte is read.
   */
  open?: (path: string) => number;
  /** `fstat` the open handle: uid, full mode, and regular-file-ness. */
  fstat?: (fd: number) => { uid: number; mode: number; isFile: () => boolean };
  /** Read the whole file from the open handle. */
  readAll?: (fd: number) => string;
  /** Close the open handle. */
  close?: (fd: number) => void;
  /** The process uid the file must be owned by. */
  getuid?: () => number;
  /** The realpath used for the worktree and checkout checks. */
  realpath?: (path: string) => string;
  /** Whether a `.git` entry (directory or worktree file) exists at a path. */
  hasGitEntry?: (path: string) => boolean;
}

export interface LoadOptions {
  file?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Filesystem seam overrides for the `owner.publicKey` trust check. Absent
   * members default to the real `node:fs` behaviour; the checks run only
   * when the parsed installation carries an `owner` section.
   */
  seam?: InstallationFileSeam;
  /**
   * Additional policy rule hook. The loader calls it with the derived model
   * after mapping; every returned string is a load error. Shape validation
   * happens in the parser regardless. The seat and chain policy
   * (`validateSeatPolicy`) is enforced by the loader itself for every v2
   * file, so a hand-edited file cannot bypass it; this hook adds caller
   * policy on top and never replaces the built-in rules.
   */
  validatePolicy?: (installation: FleetInstallationModel) => string[];
}

export type LoadResult =
  | {
      status: 'absent';
      installation: FleetInstallation;
      model: FleetInstallationModel;
      warnings: string[];
    }
  | {
      status: 'loaded';
      file: string;
      installation: FleetInstallation;
      model: FleetInstallationModel;
      warnings: string[];
    }
  | { status: 'invalid'; file: string; errors: string[] };

/** The environment shape the loader and its resolution helpers read. */
export type EnvRecord = Record<string, string | undefined>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/**
 * Read an environment value, treating an empty or whitespace-only string as
 * unset. The returned value is trimmed.
 */
function readEnvironmentValue(env: EnvRecord, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The installation file path the loader reads: an explicit file, then the
 * `FLEET_INSTALLATION_FILE` environment value, then `<cwd>/installation/fleet.json`.
 * Exported so the hosts commands write the file the loader reads; a second
 * copy of the rule in a surface would drift from the loader's resolution.
 */
export function resolveInstallationFile(file: string | undefined, env: EnvRecord, cwd: string): string {
  if (file !== undefined) {
    return resolve(cwd, file);
  }
  const fromEnvironment = readEnvironmentValue(env, 'FLEET_INSTALLATION_FILE');
  if (fromEnvironment !== undefined) {
    return resolve(cwd, fromEnvironment);
  }
  return join(cwd, 'installation', 'fleet.json');
}

/** The remedy named by every `owner-key-installation-untrusted` refusal. */
const OWNER_TRUST_REMEDY =
  'move the installation file out of every checkout to ~/.config/fleet-v2/fleet.json ' +
  '(0600 in a 0700 directory) and set FLEET_INSTALLATION_FILE to that path';

/**
 * The most bytes the installation file may hold. No larger cap exists in the
 * parser, so 1 MiB bounds every read: a device such as `/dev/zero` (or any
 * endless source) can never make `readAll` loop forever.
 */
const MAX_INSTALLATION_FILE_BYTES = 1024 * 1024;

/** Error code thrown when a read passes `MAX_INSTALLATION_FILE_BYTES`. */
const FILE_CAP_ERROR_CODE = 'EFLEETFILECAP';

/** Read the whole file from the open handle, refusing anything over the cap. */
function readCapped(fd: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, null);
    if (read <= 0) {
      break;
    }
    total += read;
    if (total > MAX_INSTALLATION_FILE_BYTES) {
      const error = new Error(
        'installation file exceeds the size cap',
      ) as NodeJS.ErrnoException;
      error.code = FILE_CAP_ERROR_CODE;
      throw error;
    }
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The seam with every member filled in: the given overrides over `node:fs`. */
interface ResolvedSeam {
  open: (path: string) => number;
  fstat: (fd: number) => { uid: number; mode: number; isFile: () => boolean };
  readAll: (fd: number) => string;
  close: (fd: number) => void;
  getuid: () => number;
  realpath: (path: string) => string;
  hasGitEntry: (path: string) => boolean;
}

function resolveSeam(seam: InstallationFileSeam | undefined): ResolvedSeam {
  return {
    open:
      seam?.open ??
      ((path: string) =>
        openSync(
          path,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        )),
    fstat: seam?.fstat ?? ((fd: number) => {
      const stats = fstatSync(fd);
      return { uid: stats.uid, mode: stats.mode, isFile: () => stats.isFile() };
    }),
    readAll:
      seam?.readAll ??
      ((fd: number) => {
        return readCapped(fd);
      }),
    close: seam?.close ?? closeSync,
    getuid: seam?.getuid ?? (() => process.getuid?.() ?? -1),
    realpath: seam?.realpath ?? realpathSync,
    hasGitEntry: seam?.hasGitEntry ?? ((path: string) => existsSync(join(path, '.git'))),
  };
}

/** The outcome of reading the installation file through the seam. */
type FileRead =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | {
      /**
       * The file was refused before any byte was read: it is not a regular
       * file, its handle could not be `fstat`-ed, or it exceeds
       * `MAX_INSTALLATION_FILE_BYTES`.
       */
      kind: 'refused';
      reason: string;
    }
  | {
      kind: 'bytes';
      raw: string;
      /** True when the path is a symlink, read through the fallback. */
      symlinked: boolean;
      /** `fstat` of the open handle, when one could be taken. */
      stats?: { uid: number; mode: number; isFile: () => boolean };
    };

/**
 * `fstat` the open handle, or undefined when the handle cannot be statted.
 */
function statHandle(
  fd: number,
  seam: ResolvedSeam,
): { uid: number; mode: number; isFile: () => boolean } | undefined {
  try {
    return seam.fstat(fd);
  } catch {
    return undefined;
  }
}

/**
 * Read from an already-open handle after its `fstat` proved it a regular
 * file, capped at `MAX_INSTALLATION_FILE_BYTES`. `'refused'` when the cap
 * is exceeded, `'error'` on any other read failure.
 */
function readRegularFile(
  fd: number,
  seam: ResolvedSeam,
): { kind: 'raw'; raw: string } | { kind: 'refused'; reason: string } | { kind: 'error' } {
  try {
    const raw = seam.readAll(fd);
    if (Buffer.byteLength(raw) > MAX_INSTALLATION_FILE_BYTES) {
      return {
        kind: 'refused',
        reason: 'the installation file exceeds the 1 MiB size cap',
      };
    }
    return { kind: 'raw', raw };
  } catch (error) {
    if (readErrorCode(error) === FILE_CAP_ERROR_CODE) {
      return {
        kind: 'refused',
        reason: 'the installation file exceeds the 1 MiB size cap',
      };
    }
    return { kind: 'error' };
  }
}

/**
 * Read the installation file. Every path opens with
 * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and `fstat`s the handle immediately,
 * refusing anything that is not a regular file before any byte is read, so
 * a FIFO with no writer cannot block in `open` and a device such as
 * `/dev/zero` cannot make the read loop forever. The total bytes read are
 * capped at `MAX_INSTALLATION_FILE_BYTES`. A symlinked path is read through
 * the plain fallback — which opens the target without `O_NOFOLLOW` but
 * applies the same immediate `fstat` and size cap before reading anything —
 * and refused later when the file carries an `owner` section.
 */
function readInstallationFile(file: string, seam: ResolvedSeam): FileRead {
  let fd: number;
  try {
    fd = seam.open(file);
  } catch (error) {
    const code = readErrorCode(error);
    if (code === 'ENOENT') {
      return { kind: 'absent' };
    }
    if (code === 'ELOOP') {
      let targetFd: number;
      try {
        targetFd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      } catch {
        return { kind: 'unreadable' };
      }
      try {
        const stats = statHandle(targetFd, seam);
        if (stats === undefined) {
          return { kind: 'refused', reason: 'the file handle could not be fstat-ed' };
        }
        if (!stats.isFile()) {
          return { kind: 'refused', reason: 'not-a-regular-file' };
        }
        const read = readRegularFile(targetFd, seam);
        if (read.kind === 'error') {
          return { kind: 'unreadable' };
        }
        if (read.kind === 'refused') {
          return read;
        }
        return { kind: 'bytes', raw: read.raw, symlinked: true, stats };
      } finally {
        try {
          closeSync(targetFd);
        } catch {
          // The read outcome is already decided; a failed close changes nothing.
        }
      }
    }
    return { kind: 'unreadable' };
  }
  try {
    const stats = statHandle(fd, seam);
    if (stats === undefined) {
      return { kind: 'refused', reason: 'the file handle could not be fstat-ed' };
    }
    if (!stats.isFile()) {
      return { kind: 'refused', reason: 'not-a-regular-file' };
    }
    const read = readRegularFile(fd, seam);
    if (read.kind === 'error') {
      return { kind: 'unreadable' };
    }
    if (read.kind === 'refused') {
      return read;
    }
    return { kind: 'bytes', raw: read.raw, symlinked: false, stats };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    try {
      seam.close(fd);
    } catch {
      // The read outcome is already decided; a failed close changes nothing.
    }
  }
}

/**
 * True when the realpath lies at or below the given worktree root. The root
 * is resolved with `realpath` through the seam before comparing, so a
 * symlinked `hosts.*.worktreeRoot` cannot bypass containment: the comparison
 * sees the same target the file's realpath points at. Returns
 * `'malformed'` when the root exists but cannot be resolved (a non-existent
 * root is skipped: it cannot contain the file). The containment test
 * compares path segments: the file is inside the root when it equals
 * `resolvedRoot` or equals `resolvedRoot + sep` plus a remainder, never by
 * a raw string prefix.
 */
function isInsideRoot(
  realpath: string,
  root: string,
  seam: ResolvedSeam,
): boolean | 'malformed' {
  let resolvedRoot: string;
  try {
    resolvedRoot = seam.realpath(resolve(root));
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') {
      return false;
    }
    return 'malformed';
  }
  return realpath === resolvedRoot || realpath.startsWith(`${resolvedRoot}${sep}`);
}

/**
 * Every configured `hosts.*.worktreeRoot` of the installation, v1 or v2.
 */
function worktreeRoots(installation: FleetInstallation): readonly string[] {
  const hosts = installation.hosts as Readonly<Record<string, HostSection>> | undefined;
  if (hosts === undefined) {
    return [];
  }
  return Object.values(hosts)
    .map((host) => host?.worktreeRoot)
    .filter((root): root is string => typeof root === 'string');
}

/**
 * True when any parent directory of the path carries a `.git` entry: the
 * file lives inside a git checkout or worktree, where local agents write.
 */
function insideGitCheckout(realpath: string, seam: ResolvedSeam): boolean {
  let dir = dirname(realpath);
  for (;;) {
    if (seam.hasGitEntry(dir)) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

/**
 * The reason the installation file cannot be trusted to carry the pinned
 * `owner.publicKey`, or undefined when every check passes. The checks are:
 * a non-symlink regular file, owned by the process uid, with no group or
 * other write bit, outside every `hosts.*.worktreeRoot`, and outside any
 * git checkout or worktree (including the repository checkout the file may
 * sit in — the repo checkout is exactly where local agents work).
 */
function ownerTrustReason(
  file: string,
  installation: FleetInstallation,
  read: Extract<FileRead, { kind: 'bytes' }>,
  seam: ResolvedSeam,
): string | undefined {
  if (read.symlinked) {
    return 'the path is a symlink';
  }
  if (read.stats === undefined) {
    return 'the file handle could not be fstat-ed';
  }
  if (!read.stats.isFile()) {
    return 'it is not a regular file';
  }
  if (read.stats.uid !== seam.getuid()) {
    return 'it is not owned by the process uid';
  }
  if ((read.stats.mode & 0o022) !== 0) {
    return 'the group or other write bit is set';
  }
  let realpath: string;
  try {
    realpath = seam.realpath(resolve(file));
  } catch {
    return 'its realpath could not be resolved';
  }
  for (const root of worktreeRoots(installation)) {
    const inside = isInsideRoot(realpath, root, seam);
    if (inside === 'malformed') {
      return 'a hosts.*.worktreeRoot is malformed';
    }
    if (inside) {
      return 'it lies inside a hosts.*.worktreeRoot';
    }
  }
  if (insideGitCheckout(realpath, seam)) {
    return 'it lies inside a git checkout or worktree';
  }
  return undefined;
}

const REMOTE_PORT_PATTERN = /^\d+$/;

function parseRemotePort(value: string): number | undefined {
  if (!REMOTE_PORT_PATTERN.test(value)) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

interface OverrideOutcome {
  installation: FleetInstallation;
  errors: string[];
}

/**
 * Apply environment overrides after parsing. Only variables that are non-empty
 * after trim override a file value. A `runner` or `worktree` section created by
 * an override may be partial: fields the environment does not name stay absent.
 * The overrides configure the v1 sections, so they apply to v1 files and to an
 * absent file; a v2 file configures its hosts in the file itself.
 */
function applyEnvironmentOverrides(
  installation: FleetInstallation,
  env: EnvRecord,
): OverrideOutcome {
  const errors: string[] = [];

  const runner: Mutable<RunnerSection> =
    installation.runner !== undefined ? { ...installation.runner } : {};
  let runnerTouched = false;

  const agent = readEnvironmentValue(env, 'FLEET_RUNNER_AGENT');
  if (agent !== undefined) {
    runner.agent = agent;
    runnerTouched = true;
  }
  const model = readEnvironmentValue(env, 'FLEET_RUNNER_MODEL');
  if (model !== undefined) {
    runner.model = model;
    runnerTouched = true;
  }
  const variant = readEnvironmentValue(env, 'FLEET_RUNNER_VARIANT');
  if (variant !== undefined) {
    runner.variant = variant;
    runnerTouched = true;
  }
  const host = readEnvironmentValue(env, 'OCM_HOST');
  if (host !== undefined) {
    runner.host = host;
    runnerTouched = true;
  }
  const ocmRunBin = readEnvironmentValue(env, 'FLEET_OCM_RUN_BIN');
  if (ocmRunBin !== undefined) {
    runner.ocmRunBin = ocmRunBin;
    runnerTouched = true;
  }
  const remotePort = readEnvironmentValue(env, 'OCM_REMOTE_PORT');
  if (remotePort !== undefined) {
    runnerTouched = true;
    const port = parseRemotePort(remotePort);
    if (port === undefined) {
      errors.push('runner.remotePort: must be an integer 1..65535');
    } else {
      runner.remotePort = port;
    }
  }

  const worktreeDraft: { sshHost?: string } =
    installation.worktree !== undefined ? { ...installation.worktree } : {};
  const sshHost = readEnvironmentValue(env, 'FLEET_WORKTREE_SSH_HOST');
  if (sshHost !== undefined) {
    worktreeDraft.sshHost = sshHost;
  }

  const merged: Mutable<FleetInstallation> = { ...installation };
  if (installation.runner !== undefined || runnerTouched) {
    merged.runner = runner;
  }
  if (worktreeDraft.sshHost !== undefined) {
    merged.worktree = { sshHost: worktreeDraft.sshHost };
  }
  return { installation: merged, errors };
}

/**
 * Load `installation/fleet.json`, version 1 or 2.
 *
 * A missing file is `absent` with the minimal installation; an unreadable file
 * or invalid JSON is `invalid` with error text that never includes the file
 * content. Environment overrides apply after parsing a v1 file or an absent
 * file, whatever its status. The result carries the parsed file as
 * `installation` and the derived v2 model with its runner capability sources
 * (D4) as `model`; `warnings` lists accepted-and-ignored v1 fields (D1) and
 * the parser's warning-level findings (such as an invalid
 * `policy.daemon.chainRefresh` mode, CO8a). When a `validatePolicy` hook is
 * provided the loader calls it with the model and treats every returned string
 * as a load error.
 *
 * When the parsed file carries an `owner` section, the loader proves the file
 * trusted before returning the pinned `owner.publicKey` (see
 * `ownerTrustReason`): the bytes are read from an `O_NOFOLLOW | O_NONBLOCK`
 * handle that is `fstat`-ed on the spot, and a file that is a symlink, not a
 * regular file, not owned by the process uid, group/other-writable, inside
 * any `hosts.*.worktreeRoot`, or inside a git checkout or worktree is
 * refused with `owner-key-installation-untrusted` and the remedy. Before any
 * byte is read — with or without an `owner` section — a handle that is not a
 * regular file (a FIFO, a device) or a read past `MAX_INSTALLATION_FILE_BYTES`
 * is refused the same way. A file without an `owner` section is otherwise
 * read exactly as before, with no checks.
 */
export function loadInstallation(options: LoadOptions = {}): LoadResult {
  const cwd = options.cwd ?? process.cwd();
  const env: EnvRecord = options.env ?? process.env;
  const file = resolveInstallationFile(options.file, env, cwd);
  const seam = resolveSeam(options.seam);

  let installation: FleetInstallation;
  let source: 'absent' | 'loaded';
  let parseWarnings: string[] = [];
  const read = readInstallationFile(file, seam);
  if (read.kind === 'absent') {
    installation = { schemaVersion: 1 };
    source = 'absent';
  } else if (read.kind === 'unreadable') {
    return { status: 'invalid', file, errors: [`${file}: unreadable`] };
  } else if (read.kind === 'refused') {
    return {
      status: 'invalid',
      file,
      errors: [
        `${file}: owner-key-installation-untrusted (${read.reason}); ${OWNER_TRUST_REMEDY}`,
      ],
    };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.raw);
    } catch {
      return { status: 'invalid', file, errors: [`${file}: invalid JSON`] };
    }
    const result = parseInstallation(parsed);
    if (!result.ok) {
      return { status: 'invalid', file, errors: result.errors };
    }
    installation = result.installation;
    parseWarnings = result.warnings ?? [];
    source = 'loaded';
    if (installation.owner !== undefined) {
      const reason = ownerTrustReason(file, installation, read, seam);
      if (reason !== undefined) {
        return {
          status: 'invalid',
          file,
          errors: [
            `${file}: owner-key-installation-untrusted (${reason}); ${OWNER_TRUST_REMEDY}`,
          ],
        };
      }
    }
  }

  const errors: string[] = [];
  if (installation.schemaVersion === 1) {
    const merged = applyEnvironmentOverrides(installation, env);
    errors.push(...merged.errors);
    installation = merged.installation;
  }
  const checked = checkInstallationModel(installation);
  const { model } = checked;
  const warnings = [...checked.warnings, ...parseWarnings];
  errors.push(...checked.errors);
  if (options.validatePolicy !== undefined) {
    errors.push(...options.validatePolicy(model));
  }
  if (errors.length > 0) {
    return { status: 'invalid', file, errors };
  }
  if (source === 'loaded') {
    return { status: 'loaded', file, installation, model, warnings };
  }
  return { status: 'absent', installation, model, warnings };
}

/** The derived model with every load-time refusal and warning (v2: model errors, then seat policy). */
export interface CheckedInstallationModel {
  readonly model: FleetInstallationModel;
  readonly warnings: string[];
  readonly errors: string[];
}

/**
 * CO22: the prepare-argv half of the model check. Every merge repository
 * entry that carries a `prepare` value is validated as written, so an
 * installation that reaches the model boundary without parsing cannot carry
 * an argv the parser would have refused. Absent `prepare` stays absent.
 */
function mergePrepareModelErrors(policy: unknown): string[] {
  const errors: string[] = [];
  const repos = (policy as { merge?: { repos?: unknown } } | undefined)?.merge?.repos;
  if (repos === undefined || repos === null || typeof repos !== 'object') {
    return errors;
  }
  for (const [key, entry] of Object.entries(repos as Record<string, unknown>)) {
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      continue;
    }
    if (!Object.hasOwn(entry, 'prepare')) {
      continue;
    }
    parsePrepareArgv(
      (entry as { prepare: unknown }).prepare,
      `policy.merge.repos[${JSON.stringify(key)}].prepare`,
      errors,
    );
  }
  return errors;
}

export function checkInstallationModel(installation: FleetInstallation): CheckedInstallationModel {
  const { model, warnings, errors: modelErrors } = deriveInstallationModel(installation);
  const errors: string[] = [];
  errors.push(...(modelErrors ?? []));
  if (installation.schemaVersion === 2) {
    // The file chains go along so the reference rules report file
    // positions when useFreeSeats false reduced the derived chains (FS1).
    errors.push(...validateSeatPolicy(model, installation.chains));
    // CO22: the model boundary re-checks every written prepare argv with the
    // parser's own rules. parseInstallation refuses an invalid argv before
    // this runs, so this only fires for installations constructed without
    // parsing — exactly the path requireValidInstallationModel guards.
    errors.push(...mergePrepareModelErrors(installation.policy));
  } else {
    // v1 files get no new refusals: their single runner/reviewer pair is
    // checked only for the family rule and reported as a warning.
    warnings.push(...v1FamilyWarnings(model));
  }
  return { model, warnings, errors };
}

export class InvalidInstallationError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`installation invalid:\n${errors.join('\n')}`);
    this.name = 'InvalidInstallationError';
    this.errors = [...errors];
  }
}

/** The one composition boundary: the checked model, or a throw naming every error. */
export function requireValidInstallationModel(installation: FleetInstallation): FleetInstallationModel {
  const checked = checkInstallationModel(installation);
  if (checked.errors.length > 0) {
    throw new InvalidInstallationError(checked.errors);
  }
  return checked.model;
}
