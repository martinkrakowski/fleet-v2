/**
 * Node adapter for the doctor probes: the concrete `DoctorProbes`
 * implementation used by the CLI and any host process. It is the only place
 * the doctor touches the outside world — subprocesses through injected
 * argument-array executors, the repository's bundled runner binary and the
 * hash pin file. Credential file contents are never read anywhere here:
 * `fileMode` stats only, and the hash pin file is fleet's own checksum
 * record, not a secret.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, types } from 'node:util';

import type { SeatModel } from '@fleet/installation';
import { BUILT_IN_TOOLS, type ToolId } from '@fleet/tooling';

import { GH_BINARY_CANDIDATES, hasGhTokenEnv, type GhAuthObservation } from './gh-binary.js';
import { sshRemoteArgv } from './ssh-remote.js';
import type {
  CiRunnerSlotState,
  DoctorProbes,
  LoginShellState,
  PinnedBuildProbeResult,
  SeatProbeResult,
  ServerProbeResult,
} from './probes.js';

const execFileAsync = promisify(execFileCallback);

/**
 * Structural shape of the command executor (the work-execution context's
 * `CommandExecutorPort` contract) — declared locally so no context package
 * is ever imported here. One argv array per run, never a shell.
 */
export interface DoctorCommandRunOptions {
  /** Working directory for a local run; ignored by remote transports. */
  readonly cwd?: string;
  /** Wall-clock budget; an exceeded run is terminated and reported as an error. */
  readonly timeoutMs?: number;
}

/** Completed outcome of one command run, as far as the probes need it. */
export interface DoctorCommandRunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure description; absent for a command that ran. */
  readonly error?: string;
}

/** Runs one argv array and returns its completed outcome, fail closed. */
export interface DoctorCommandExecutor {
  run(
    argv: readonly string[],
    options?: DoctorCommandRunOptions,
  ): Promise<DoctorCommandRunResult>;
}

/** Default wall-clock budget for a platform probe command. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Default wall-clock budget for the bounded `gh auth status` run. */
const DEFAULT_GH_AUTH_TIMEOUT_MS = 5_000;

/** Default wall-clock budget for the one-step seat probe (a live model call). */
const DEFAULT_SEAT_TIMEOUT_MS = 60_000;

/** Connect budget for an ssh reachability check. */
const SSH_CONNECT_TIMEOUT_S = 10;

/** Prompt of the one-step seat probe: the smallest task that must succeed. */
const SEAT_PROBE_PROMPT = 'Reply with the single word OK and nothing else.';

/** Names accepted for the `command -v` probe; rejects shell metacharacters. */
const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/;

/**
 * The default executor: local `execFile` with an argv array (never a shell)
 * and the caller's timeout. Exported so hosts can compose it with ssh
 * wrappers and tests can substitute it wholesale.
 */
export function createNodeDoctorExecutor(): DoctorCommandExecutor {
  return {
    async run(argv, options = {}) {
      const [file, ...args] = argv;
      try {
        const { stdout, stderr } = await execFileAsync(file, args, {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        return { exitCode: 0, signal: null, stdout, stderr };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & {
          signal?: string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        if (typeof err.code === 'number') {
          return {
            exitCode: err.code,
            signal: err.signal ?? null,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
          };
        }
        return {
          exitCode: null,
          signal: err.signal ?? null,
          stdout: '',
          stderr: '',
          error: err.message ?? String(error),
        };
      }
    },
  };
}

export interface NodeDoctorProbesDeps {
  /**
   * Executor for commands on the local host. Defaults to `execFile` with
   * argv arrays; tests and embedders inject fakes here.
   */
  readonly localExecutor?: DoctorCommandExecutor;
  /**
   * Executor used to reach ssh hosts. It runs on the local host (typically
   * the same `execFile` executor); the ssh transport is expressed in the
   * argv this adapter builds.
   */
  readonly sshExecutor?: DoctorCommandExecutor;
  /**
   * Repository root holding `bin/ocm-run` and `scripts/ocm-run-hash.txt`.
   * Resolved by walking up from this module when omitted.
   */
  readonly repoRoot?: string;
  /** Reads a text file; defaults to `node:fs` readFile. Injectable for tests. */
  readonly readTextFile?: (path: string) => Promise<string>;
  /** Wall-clock budget per platform probe command. */
  readonly timeoutMs?: number;
  /** Wall-clock budget for the one-step seat probe. */
  readonly seatTimeoutMs?: number;
  /** The worktree root `worktreeRootWritable` tests (`.` when omitted). */
  readonly worktreeRoot?: string;
  /**
   * Candidate absolute paths probed for the reviewed `gh` binary. Defaults
   * to `GH_BINARY_CANDIDATES`; injectable for tests and embedders.
   */
  readonly ghBinaryCandidates?: readonly string[];
  /**
   * The service environment the `gh` auth probe inspects for a token
   * variable, given directly or as a reader. Defaults to `process.env`;
   * a reader that throws rejects so the doctor reports `UNKNOWN`.
   */
  readonly serviceEnv?:
    | Readonly<Record<string, string | undefined>>
    | (() => Readonly<Record<string, string | undefined>>);
  /** Wall-clock budget for the `gh auth status` run. */
  readonly ghAuthTimeoutMs?: number;
  /**
   * The base branch the pinned build is compared against, as a `git`
   * revision the local repository resolves (default `origin/main`).
   */
  readonly baseBranch?: string;
  /**
   * Overrides the whole pinned-build observation. Injectable for tests and
   * embedders that know the installed build without a `git` repository.
   */
  readonly readPinnedBuild?: () => Promise<PinnedBuildProbeResult | undefined>;
}

/** Walk up from this module to the repository root that owns `bin/ocm-run`. */
function resolveRepoRoot(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(current, 'bin', 'ocm-run'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** First field of one non-empty line of text (a sha256 record, a mode, …). */
function firstField(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '');
  if (line === undefined) {
    return undefined;
  }
  const field = line.split(/\s+/)[0];
  return field === '' ? undefined : field;
}

/** Own keys an untrusted answer may never carry: they would pollute or masquerade. */
const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype', 'length'];

/** An untrusted answer with more own keys than this is refused unread. */
const MAX_OWN_KEYS = 64;

/** The answer a probe reports for an executor answer it refuses to read. */
const UNTRUSTED_RUN_RESULT: DoctorCommandRunResult = Object.freeze({
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  error: 'untrusted probe result',
});

/**
 * True for a plain data object: not a Proxy, prototype exactly
 * `Object.prototype` or `null`, no polluting own key, at most `MAX_OWN_KEYS`
 * own keys. Cost: O(1) type, proxy and prototype checks, four descriptor
 * lookups and one own-key count bounded by `MAX_OWN_KEYS` + 1. Never runs a
 * getter; a throwing trap is caught.
 */
function isPlainUntrustedObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || types.isProxy(value)) {
    return false;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      return false;
    }
    for (const key of POLLUTING_KEYS) {
      if (Object.getOwnPropertyDescriptor(value, key) !== undefined) {
        return false;
      }
    }
    return Object.getOwnPropertyNames(value).length <= MAX_OWN_KEYS;
  } catch {
    return false;
  }
}

/**
 * One own data property of a plain object: `{ ok: true, value }` (value is
 * `undefined` when the key is absent) or `{ ok: false }` for an accessor.
 * Cost: one `Object.getOwnPropertyDescriptor` call; a getter is never invoked.
 */
function readOwnDataProperty(
  object: object,
  key: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) {
    return { ok: true, value: undefined };
  }
  return 'value' in descriptor ? { ok: true, value: descriptor.value } : { ok: false };
}

/** The data values of the named own properties, or `undefined` when any is an accessor. */
function readOwnDataProperties(object: object, keys: readonly string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const read = readOwnDataProperty(object, key);
    if (!read.ok) {
      return undefined;
    }
    out[key] = read.value;
  }
  return out;
}

/**
 * A fresh, plain `DoctorCommandRunResult` copied from an executor answer, or
 * `undefined` when the answer is not a plain object with only data
 * properties of the right types. Cost: O(1), five fixed fields.
 */
function readUntrustedRunResult(raw: unknown): DoctorCommandRunResult | undefined {
  try {
    if (!isPlainUntrustedObject(raw)) {
      return undefined;
    }
    const fields = readOwnDataProperties(raw, ['exitCode', 'signal', 'stdout', 'stderr', 'error']);
    if (fields === undefined) {
      return undefined;
    }
    const { exitCode, signal, stdout, stderr, error } = fields;
    if (exitCode !== null && !(typeof exitCode === 'number' && Number.isInteger(exitCode))) {
      return undefined;
    }
    if (typeof stdout !== 'string') {
      return undefined;
    }
    if (signal !== undefined && signal !== null && typeof signal !== 'string') {
      return undefined;
    }
    if (stderr !== undefined && typeof stderr !== 'string') {
      return undefined;
    }
    if (error !== undefined && typeof error !== 'string') {
      return undefined;
    }
    return {
      exitCode,
      signal: signal ?? null,
      stdout,
      stderr: stderr ?? '',
      ...(error === undefined ? {} : { error }),
    };
  } catch {
    return undefined;
  }
}

/** Run one argv and return a trusted copy of the answer; a throw or a refused answer is a failed run. */
async function runTrusted(
  executor: DoctorCommandExecutor,
  argv: readonly string[],
  options?: DoctorCommandRunOptions,
): Promise<DoctorCommandRunResult> {
  try {
    return readUntrustedRunResult(await executor.run(argv, options)) ?? UNTRUSTED_RUN_RESULT;
  } catch {
    return UNTRUSTED_RUN_RESULT;
  }
}

/**
 * A fresh `PinnedBuildProbeResult` from an injected reader's answer, or
 * `undefined` for a non-plain object, an accessor or a wrong field type.
 * Cost: O(1), four fixed fields.
 */
function readUntrustedPinnedBuild(raw: unknown): PinnedBuildProbeResult | undefined {
  try {
    if (!isPlainUntrustedObject(raw)) {
      return undefined;
    }
    const fields = readOwnDataProperties(raw, [
      'pinnedCommit',
      'baseTipCommit',
      'behindCount',
      'installRootName',
    ]);
    if (fields === undefined) {
      return undefined;
    }
    const { pinnedCommit, baseTipCommit, behindCount, installRootName } = fields;
    if (
      (pinnedCommit !== undefined && typeof pinnedCommit !== 'string') ||
      (baseTipCommit !== undefined && typeof baseTipCommit !== 'string') ||
      (behindCount !== undefined && !(typeof behindCount === 'number' && Number.isSafeInteger(behindCount))) ||
      (installRootName !== undefined && typeof installRootName !== 'string')
    ) {
      return undefined;
    }
    return {
      pinnedCommit,
      baseTipCommit,
      behindCount,
      ...(installRootName === undefined ? {} : { installRootName }),
    };
  } catch {
    return undefined;
  }
}

/**
 * A fresh array of strings from an untrusted array, or `undefined` for a
 * non-array, a Proxy, a foreign prototype, a hole, an accessor element, a
 * non-string element or a length above `maxLen`. Cost: O(min(length, maxLen)).
 */
function readUntrustedStringArray(raw: unknown, maxLen: number): string[] | undefined {
  try {
    if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
      return undefined;
    }
    const lengthRead = readOwnDataProperty(raw, 'length');
    if (!lengthRead.ok || typeof lengthRead.value !== 'number' || lengthRead.value > maxLen) {
      return undefined;
    }
    const out: string[] = [];
    for (let index = 0; index < lengthRead.value; index += 1) {
      const element = readOwnDataProperty(raw, String(index));
      if (!element.ok || typeof element.value !== 'string' || Object.getOwnPropertyDescriptor(raw, String(index)) === undefined) {
        return undefined;
      }
      out.push(element.value);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The probe-argv cap: a template or candidate list longer than this is refused. */
const MAX_ARGV_LENGTH = 64;

/** True when the run completed with exit code 0. */
function succeeded(
  result: DoctorCommandRunResult,
): boolean {
  return result.error === undefined && result.exitCode === 0;
}

/**
 * The commit from `git rev-parse` stdout: the whole output must be exactly one
 * 40-character lowercase hex id and at most one trailing newline.
 */
function revParseCommit(stdout: string): string | undefined {
  const match = /^([0-9a-f]{40})\n?$/.exec(stdout);
  return match === null ? undefined : match[1];
}

/**
 * The count from `git rev-list --count` stdout: the whole output must be one
 * non-negative safe integer and at most one trailing newline.
 */
function revListCount(stdout: string): number | undefined {
  const match = /^(\d+)\n?$/.exec(stdout);
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Read the pinned-build freshness observation with `git` in the local
 * repository: the installed build's `HEAD`, the base branch tip, and — when
 * they differ — the commit distance between them. Every unreadable field is
 * `undefined`; the check itself stays pure and turns that into `UNKNOWN`.
 */
async function readPinnedBuildWithGit(
  executor: DoctorCommandExecutor,
  repoRoot: string,
  baseBranch: string,
  timeoutMs: number,
): Promise<PinnedBuildProbeResult> {
  let pinnedCommit: string | undefined;
  let baseTipCommit: string | undefined;
  let behindCount: number | undefined;

  const head = await runTrusted(executor, ['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    timeoutMs,
  });
  if (succeeded(head)) {
    pinnedCommit = revParseCommit(head.stdout);
  }

  const base = await runTrusted(executor, ['git', 'rev-parse', baseBranch], {
    cwd: repoRoot,
    timeoutMs,
  });
  if (succeeded(base)) {
    baseTipCommit = revParseCommit(base.stdout);
  }

  if (pinnedCommit !== undefined && baseTipCommit !== undefined) {
    if (pinnedCommit === baseTipCommit) {
      behindCount = 0;
    } else {
      const count = await runTrusted(
        executor,
        ['git', 'rev-list', '--count', `${pinnedCommit}..${baseTipCommit}`],
        { cwd: repoRoot, timeoutMs },
      );
      if (succeeded(count)) {
        behindCount = revListCount(count.stdout);
      }
    }
  }

  return { pinnedCommit, baseTipCommit, behindCount, installRootName: basename(repoRoot) };
}

/**
 * A systemd service unit name as `ciRunnerSlots[].unit` allows it: a local
 * copy of the installation parser's rule, so the probe refuses any other
 * word before it spawns anything.
 */
const CI_RUNNER_UNIT = /^[A-Za-z0-9@._:-]{1,128}\.service$/;

/** `systemctl is-active` stdout: one lowercase word, at most one trailing newline. */
const IS_ACTIVE_STDOUT = /^([a-z]+)\n?$/;

/** The state words that mean systemd answered and the unit is not active. */
const NOT_ACTIVE_STATES: ReadonlySet<string> = new Set([
  'inactive',
  'failed',
  'activating',
  'deactivating',
  'unknown',
]);

/**
 * Map one completed `systemctl is-active` run to a slot state. Only the
 * exit code and one whole-output state word are read; the output itself is
 * never returned.
 */
function ciRunnerSlotState(raw: DoctorCommandRunResult): CiRunnerSlotState {
  const result = readUntrustedRunResult(raw);
  if (result === undefined) {
    return 'unknown';
  }
  if (
    result.error !== undefined ||
    result.signal !== null ||
    typeof result.exitCode !== 'number' ||
    typeof result.stdout !== 'string'
  ) {
    return 'unknown';
  }
  const word = IS_ACTIVE_STDOUT.exec(result.stdout)?.[1];
  if (result.exitCode === 0) {
    return word === 'active' ? 'active' : 'unknown';
  }
  return word !== undefined && NOT_ACTIVE_STATES.has(word) ? 'inactive' : 'unknown';
}

/**
 * The fixed canary text: adjacent spaces, a dollar word, a backslash-n pair
 * that is not a newline, two backslashes, both quote kinds, a glob, a tilde,
 * a semicolon, a double dash, a hash, a bang and one real newline. A login
 * shell that splits, expands or re-reads any of them changes the echo.
 */
export const LOGIN_SHELL_CANARY = [
  'fleet-canary',
  'a  b',
  '$HOME',
  '\\n',
  '\\\\',
  "'q'",
  '"d"',
  '*',
  '~',
  ';',
  '--',
  '#x',
  '!',
  'line\nend',
].join(' ');

/**
 * Map one completed canary run to a login-shell state. The output is only
 * compared, never returned. Exit code 255 is ssh's own failure, so it says
 * nothing about the login shell.
 */
function loginShellState(raw: DoctorCommandRunResult): LoginShellState {
  const result = readUntrustedRunResult(raw);
  if (result === undefined) {
    return 'unknown';
  }
  if (
    result.error !== undefined ||
    result.signal !== null ||
    typeof result.exitCode !== 'number' ||
    result.exitCode === 255 ||
    typeof result.stdout !== 'string'
  ) {
    return 'unknown';
  }
  return result.exitCode === 0 && result.stdout === LOGIN_SHELL_CANARY ? 'intact' : 'mangled';
}

/** Run one argv on the host's transport; a spawn failure reports as a failed run. */
async function runOnHost(
  deps: Required<
    Pick<NodeDoctorProbesDeps, 'localExecutor' | 'sshExecutor' | 'timeoutMs'>
  >,
  host: string,
  argv: readonly string[],
  timeoutMs?: number,
): Promise<DoctorCommandRunResult> {
  const budget = { timeoutMs: timeoutMs ?? deps.timeoutMs };
  if (host === 'local') {
    return runTrusted(deps.localExecutor, argv, budget);
  }
  const remote = sshRemoteArgv(host, argv, SSH_CONNECT_TIMEOUT_S);
  if (!remote.ok) {
    // Refused before any spawn; every probe already treats a result with an
    // `error` as a failed run.
    return { exitCode: null, signal: null, stdout: '', stderr: '', error: remote.reason };
  }
  return runTrusted(deps.sshExecutor, remote.argv, budget);
}

/** The tool descriptor's version argv (`detect`), or undefined for an unknown id. */
function versionArgvOf(toolId: ToolId): readonly string[] | undefined {
  return BUILT_IN_TOOLS.find((tool) => tool.id === toolId)?.detect.argv;
}

/**
 * Substitute a descriptor's invocation template with the seat's model and
 * variant. A `{variant}` slot without a configured variant is dropped
 * together with the flag immediately preceding it, so `--variant` never
 * travels with an empty value; `opencode`'s combined `{model}#{variant}`
 * token degrades to the bare model.
 */
export function seatProbeArgv(seat: SeatModel, template: readonly string[]): string[] {
  // Untrusted input: the seat is read through descriptors (a getter never
  // runs) and the template through a bounded array read; anything else gives
  // no argv at all. Cost: O(1) seat reads + O(min(length, 64)) template read.
  const tokens = readUntrustedStringArray(template, MAX_ARGV_LENGTH);
  const seatFields = isPlainUntrustedObject(seat) ? readOwnDataProperties(seat, ['model', 'variant']) : undefined;
  if (tokens === undefined || seatFields === undefined) {
    return [];
  }
  const model = seatFields.model;
  const variant = seatFields.variant;
  if (typeof model !== 'string' || (variant !== undefined && typeof variant !== 'string')) {
    return [];
  }
  const argv: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '{model}#{variant}') {
      argv.push(variant === undefined ? model : `${model}#${variant}`);
      continue;
    }
    if (token === '{variant}') {
      if (variant !== undefined) {
        argv.push(variant);
      } else if (argv.length > 0 && argv[argv.length - 1].startsWith('-')) {
        argv.pop();
      }
      continue;
    }
    if (token === '{model}') {
      argv.push(model);
    } else if (token === '{prompt}') {
      argv.push(SEAT_PROBE_PROMPT);
    } else {
      argv.push(token);
    }
  }
  return argv;
}

/**
 * The model ids an opencode server lists: `id` for each model and
 * `id#variant` for each of its variants. `undefined` when the answer is not
 * a readable model list.
 */
export function serverModelIds(stdout: string): readonly string[] | undefined {
  if (typeof stdout !== 'string') {
    return undefined;
  }
  const opencode = BUILT_IN_TOOLS.find((tool) => tool.id === 'opencode');
  if (opencode?.models === undefined) {
    return undefined;
  }
  const parsed = opencode.models.parse(stdout);
  if (parsed === 'unknown' || 'source' in parsed) {
    return undefined;
  }
  if (parsed.length === 0) {
    return undefined;
  }
  const ids: string[] = [];
  for (const model of parsed) {
    ids.push(model.id);
    for (const variant of model.variants ?? []) {
      ids.push(`${model.id}#${variant}`);
    }
  }
  return ids;
}

/**
 * The node doctor probes. Local hosts run argv arrays through the local
 * executor; every other host name is an ssh alias and the same argv travels
 * through `ssh <alias> -- sh -c '<one POSIX-single-quoted command line>'`
 * with `BatchMode=yes`, so the remote login shell parses only `sh -c` plus
 * that one string. A refused remote argv (empty, an empty or NUL-bearing
 * argument, or an unsafe alias) spawns nothing and reports a failed run.
 * Nothing here reads a credential file's contents.
 */
export function createNodeDoctorProbes(deps: NodeDoctorProbesDeps = {}): DoctorProbes {
  const localExecutor = deps.localExecutor ?? createNodeDoctorExecutor();
  const sshExecutor = deps.sshExecutor ?? localExecutor;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const seatTimeoutMs = deps.seatTimeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const executors = { localExecutor, sshExecutor, timeoutMs };
  const repoRoot = deps.repoRoot ?? resolveRepoRoot();
  const worktreeRoot = deps.worktreeRoot ?? '.';
  const ghAuthTimeoutMs = deps.ghAuthTimeoutMs ?? DEFAULT_GH_AUTH_TIMEOUT_MS;

  const readServiceEnv = (): Readonly<Record<string, string | undefined>> =>
    typeof deps.serviceEnv === 'function' ? deps.serviceEnv() : deps.serviceEnv ?? process.env;

  return {
    async hostReachable(host) {
      if (host === 'local') {
        return true;
      }
      const result = await runOnHost(
        executors,
        host,
        ['true'],
        SSH_CONNECT_TIMEOUT_S * 1000,
      );
      return succeeded(result);
    },

    async commandAvailable(host, name) {
      if (!COMMAND_NAME.test(name)) {
        return false;
      }
      const result = await runOnHost(executors, host, [
        'sh',
        '-c',
        `command -v ${name}`,
      ]);
      return succeeded(result);
    },

    async toolVersion(host, toolId) {
      const versionArgv = versionArgvOf(toolId);
      if (versionArgv === undefined) {
        return undefined;
      }
      const result = await runOnHost(executors, host, versionArgv);
      if (!succeeded(result)) {
        return undefined;
      }
      const firstLine = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
      return firstLine === '' ? undefined : firstLine;
    },

    async fileMode(host, path) {
      // GNU stat answers `-c %a`; the BSD/macOS stat rejects `-c` and answers
      // `%Lp`, so a failed GNU probe falls back to the BSD form.
      let result = await runOnHost(executors, host, ['stat', '-c', '%a', path]);
      if (!succeeded(result)) {
        result = await runOnHost(executors, host, ['stat', '-f', '%Lp', path]);
      }
      if (!succeeded(result)) {
        return undefined;
      }
      const digits = result.stdout.trim();
      if (!/^[0-7]{1,4}$/.test(digits)) {
        return undefined;
      }
      return parseInt(digits, 8);
    },

    async worktreeRootWritable(host) {
      const result = await runOnHost(executors, host, ['test', '-w', worktreeRoot]);
      return succeeded(result);
    },

    async ocmRunBinary() {
      if (repoRoot === undefined) {
        return undefined;
      }
      const path = join(repoRoot, 'bin', 'ocm-run');
      if (!existsSync(path)) {
        return undefined;
      }
      // GNU coreutils `sha256sum` first; when it is missing (macOS/BSD ships
      // `shasum` instead) the same file is hashed with `shasum -a 256`.
      let result = await runTrusted(localExecutor, ['sha256sum', path], {
        timeoutMs,
      });
      if (!succeeded(result)) {
        result = await runTrusted(localExecutor, ['shasum', '-a', '256', path], {
          timeoutMs,
        });
      }
      if (!succeeded(result)) {
        return undefined;
      }
      const sha256 = firstField(result.stdout);
      if (sha256 === undefined || !/^[0-9a-f]{64}$/.test(sha256)) {
        return undefined;
      }
      return { path, sha256 };
    },

    async expectedOcmRunHash() {
      if (repoRoot === undefined) {
        return undefined;
      }
      let text: string;
      try {
        text = await readTextFile(join(repoRoot, 'scripts', 'ocm-run-hash.txt'));
      } catch {
        return undefined;
      }
      const hash = firstField(text);
      return hash !== undefined && /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
    },

    async ghBinary() {
      const candidates = readUntrustedStringArray(
        deps.ghBinaryCandidates ?? GH_BINARY_CANDIDATES,
        MAX_ARGV_LENGTH,
      );
      if (candidates === undefined) {
        return undefined;
      }
      try {
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            const stats = statSync(candidate);
            if (stats.isFile() && (stats.mode & 0o111) !== 0) {
              return { resolved: candidate, candidates };
            }
          }
        }
        return { resolved: undefined, candidates };
      } catch {
        return undefined;
      }
    },

    async ghAuth(binaryPath): Promise<GhAuthObservation> {
      const env = readServiceEnv();
      const tokenPresent = hasGhTokenEnv(env);
      // Without a token in the service environment `gh` falls back to the
      // desktop keyring, which blocks a non-interactive session; never
      // spawn it in that case.
      if (!tokenPresent) {
        return {
          tokenPresent,
          authCheck: { outcome: 'fail', reason: 'no GH_TOKEN or GITHUB_TOKEN in service environment' },
        };
      }
      if (binaryPath.trim() === '' || ghAuthTimeoutMs <= 0) {
        return {
          tokenPresent,
          authCheck: { outcome: 'unknown', reason: 'gh auth status could not be run' },
        };
      }
      const result = await runTrusted(localExecutor, [binaryPath, 'auth', 'status'], {
        timeoutMs: ghAuthTimeoutMs,
      });
      if (result.error !== undefined || result.signal !== null || result.exitCode === null) {
        return {
          tokenPresent,
          authCheck: { outcome: 'unknown', reason: 'gh auth status timed out or could not be run' },
        };
      }
      if (result.exitCode === 0) {
        return {
          tokenPresent,
          authCheck: { outcome: 'pass', reason: 'gh auth status succeeded' },
        };
      }
      return { tokenPresent, authCheck: { outcome: 'fail', reason: 'gh auth status failed' } };
    },

    async pinnedBuild(): Promise<PinnedBuildProbeResult | undefined> {
      if (deps.readPinnedBuild !== undefined) {
        try {
          return readUntrustedPinnedBuild(await deps.readPinnedBuild());
        } catch {
          return undefined;
        }
      }
      if (repoRoot === undefined) {
        return { pinnedCommit: undefined, baseTipCommit: undefined, behindCount: undefined };
      }
      return readPinnedBuildWithGit(
        localExecutor,
        repoRoot,
        deps.baseBranch ?? 'origin/main',
        timeoutMs,
      );
    },

    async ciRunnerSlot(host, unit): Promise<CiRunnerSlotState> {
      try {
        if (unit.startsWith('-') || !CI_RUNNER_UNIT.test(unit)) {
          return 'unknown';
        }
        return ciRunnerSlotState(
          await runOnHost(executors, host, ['systemctl', 'is-active', unit]),
        );
      } catch {
        return 'unknown';
      }
    },

    async loginShell(host): Promise<LoginShellState> {
      try {
        if (host === 'local' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return 'unknown';
        }
        return loginShellState(
          await runOnHost(executors, host, ['printf', '%s', LOGIN_SHELL_CANARY]),
        );
      } catch {
        return 'unknown';
      }
    },

    async serverProbe(host, port): Promise<ServerProbeResult> {
      const info = await runOnHost(
        executors,
        host,
        [
          'curl',
          '-sS',
          '--max-time',
          '5',
          '--noproxy',
          '127.0.0.1,localhost',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          `http://127.0.0.1:${port}/api/info`,
        ],
      );
      if (info.error !== undefined) {
        return { outcome: 'unknown', reason: 'the server probe could not be run' };
      }
      if (info.exitCode !== 0) {
        return {
          outcome: 'unknown',
          reason: `the opencode server on 127.0.0.1:${port} did not answer`,
        };
      }
      const code = info.stdout.trim();
      if (code === '401' || code === '403') {
        // The doctor never reads a credential; an authenticated server is
        // unknown, never a pass.
        return {
          outcome: 'unknown',
          reason: `the opencode server on 127.0.0.1:${port} requires authentication`,
        };
      }
      if (code !== '200') {
        return {
          outcome: 'fail',
          reason: `the opencode server on 127.0.0.1:${port} answered HTTP ${code}`,
        };
      }
      const listed = await runOnHost(
        executors,
        host,
        [
          'curl',
          '-sS',
          '--max-time',
          '5',
          '--noproxy',
          '127.0.0.1,localhost',
          `http://127.0.0.1:${port}/api/model`,
        ],
      );
      const reason = `the opencode server on 127.0.0.1:${port} answered`;
      if (listed.error !== undefined || listed.exitCode !== 0) {
        return { outcome: 'pass', reason };
      }
      const models = serverModelIds(listed.stdout);
      return models === undefined ? { outcome: 'pass', reason } : { outcome: 'pass', reason, models };
    },

    async seatProbe(seat: SeatModel): Promise<SeatProbeResult> {
      const toolRead = isPlainUntrustedObject(seat) ? readOwnDataProperty(seat, 'tool') : undefined;
      if (toolRead === undefined || !toolRead.ok || typeof toolRead.value !== 'string') {
        return { outcome: 'unknown', reason: 'seat probe received untrusted input' };
      }
      const toolId = toolRead.value;
      const descriptor = BUILT_IN_TOOLS.find((tool) => tool.id === toolId);
      if (descriptor === undefined) {
        return {
          outcome: 'unknown',
          reason: `seat tool ${toolId} has no probe descriptor`,
        };
      }
      const argv = seatProbeArgv(seat, descriptor.invocation.argvTemplate);
      if (argv.length === 0) {
        return { outcome: 'unknown', reason: 'seat probe received untrusted input' };
      }
      const result = await runTrusted(localExecutor, argv, { timeoutMs: seatTimeoutMs });
      if (result.error !== undefined) {
        return { outcome: 'unknown', reason: `seat probe failed to run (${result.error})` };
      }
      if (result.exitCode === 0) {
        return { outcome: 'pass', reason: 'one-step seat probe answered' };
      }
      return {
        outcome: 'fail',
        reason: `one-step seat probe exited ${result.exitCode}`,
      };
    },
  };
}
