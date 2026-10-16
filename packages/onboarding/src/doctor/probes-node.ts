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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { SeatModel } from '@fleet/installation';
import { BUILT_IN_TOOLS, type ToolId } from '@fleet/tooling';

import type { DoctorProbes, SeatProbeResult } from './probes.js';

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

/** Build the `ssh <alias> --` wrapper argv with BatchMode and a connect budget. */
function sshArgv(alias: string, argv: readonly string[]): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    alias,
    '--',
    ...argv,
  ];
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

/** True when the run completed with exit code 0. */
function succeeded(
  result: DoctorCommandRunResult,
): boolean {
  return result.error === undefined && result.exitCode === 0;
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
    return deps.localExecutor.run(argv, budget);
  }
  return deps.sshExecutor.run(sshArgv(host, argv), budget);
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
  const argv: string[] = [];
  for (let index = 0; index < template.length; index += 1) {
    const token = template[index];
    if (token === '{model}#{variant}') {
      argv.push(
        seat.variant === undefined ? seat.model : `${seat.model}#${seat.variant}`,
      );
      continue;
    }
    if (token === '{variant}') {
      if (seat.variant !== undefined) {
        argv.push(seat.variant);
      } else if (argv.length > 0 && argv[argv.length - 1].startsWith('-')) {
        argv.pop();
      }
      continue;
    }
    if (token === '{model}') {
      argv.push(seat.model);
    } else if (token === '{prompt}') {
      argv.push(SEAT_PROBE_PROMPT);
    } else {
      argv.push(token);
    }
  }
  return argv;
}

/**
 * The node doctor probes. Local hosts run argv arrays through the local
 * executor; every other host name is an ssh alias and the same argv travels
 * through `ssh <alias> --` with `BatchMode=yes`. Nothing here reads a
 * credential file's contents.
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
      let result = await localExecutor.run(['sha256sum', path], {
        timeoutMs,
      });
      if (!succeeded(result)) {
        result = await localExecutor.run(['shasum', '-a', '256', path], {
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

    async seatProbe(seat: SeatModel): Promise<SeatProbeResult> {
      const descriptor = BUILT_IN_TOOLS.find((tool) => tool.id === seat.tool);
      if (descriptor === undefined) {
        return {
          outcome: 'unknown',
          reason: `seat tool ${seat.tool} has no probe descriptor`,
        };
      }
      const result = await localExecutor.run(
        seatProbeArgv(seat, descriptor.invocation.argvTemplate),
        { timeoutMs: seatTimeoutMs },
      );
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
