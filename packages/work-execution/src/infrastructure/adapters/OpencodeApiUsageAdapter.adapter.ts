// Adapter scaffold — implemented for lane KF-15b.
/**
 * OpencodeApiUsageAdapter implements UsagePort by running the reviewed
 * `ocm-run --usage <session-id>` subprocess, which reaches the opencode
 * server's HTTP API the way a dispatch reaches it (the dial port, the ssh
 * forward and the auth file `bin/ocm-run` already handles) and prints the
 * session body and the message list as one JSON line each. The adapter maps
 * a clean exit with a parseable first line to `read`; anything else — a
 * non-zero exit, an unparseable line, a subprocess error or a timeout — is
 * `unavailable` with the reason built from the exit code and the first
 * stderr line. It never throws.
 */

import type { AttemptRecord, AttemptUsageRecord } from '../../domain/execution-records.js';
import type {
  ReadUsageRequest,
  ReadUsageResult,
  UsagePort,
} from '../../application/ports/out/UsagePort.out-port.js';
import {
  RunnerSubprocessError,
  buildRunnerEnv,
  defaultOcmRunPath,
  runViaExecFile,
  type RunnerEnvOptions,
  type SubprocessResult,
} from './ExecutionRunnerAdapter.adapter.js';

/** The ocm-run route for one attempt's recorded session, resolved before anything runs. */
export interface UsageRoute {
  readonly ok: true;
  /** The recorded runner's dial port, passed as `OCM_REMOTE_PORT`. */
  readonly remotePort: number;
  /** The ssh alias to dial; `null` for a local route (no `OCM_HOST`). */
  readonly sshHost: string | null;
  /** The auth file `ocm-run` sources as shell; `null` when there is none. */
  readonly authFile: string | null;
  readonly transport: 'local' | 'ssh';
}

/** A refused route: nothing runs and the read is `unavailable` with the route's reason. */
export interface UsageRouteRefusal {
  readonly ok: false;
  readonly reason: string;
}

export interface OpencodeApiUsageAdapterOptions {
  /**
   * Resolves the ocm-run route for the attempt's recorded session. The route
   * is the collected truth: a route that cannot be built refuses, which the
   * adapter reports as `unavailable` without running anything.
   */
  readonly routeForAttempt: (attempt: AttemptRecord) => UsageRoute | UsageRouteRefusal;
  /** Path of the ocm-run binary; the bundled `bin/ocm-run` when omitted. */
  readonly ocmRunBin?: string;
  /** Deterministic subprocess execution for unit tests. */
  readonly run?: typeof runViaExecFile;
  /** Wall-clock budget for the read; defaults to 20 000 ms. */
  readonly timeoutMs?: number;
  /** Clock for the read timestamp; defaults to the system clock. */
  readonly now?: () => Date;
}

/** Default wall-clock budget for one usage read. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Session ids are `ses_` followed by id characters only (a malformed id is refused before anything runs). */
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_]+$/;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The model id of a parsed session body: `data.model.id` when it is a string,
 * else `data.model` when it is a string, else null.
 */
function modelOf(data: Record<string, unknown>): string | null {
  const model = data.model;
  if (isPlainRecord(model) && typeof model.id === 'string') {
    return model.id;
  }
  return stringOrNull(model);
}

/**
 * The first non-empty stdout line's `data` object: either a plain `data`
 * object or a bare object carrying an `id` string; null when the line is
 * missing, not JSON, or neither shape.
 */
function parseSessionLine(stdout: string): Record<string, unknown> | null {
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPlainRecord(parsed) && isPlainRecord(parsed.data)) {
        return parsed.data;
      }
      if (isPlainRecord(parsed) && typeof parsed.id === 'string') {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }
  return null;
}

/** The count of assistant messages in the second stdout line, when it is readable; null otherwise. */
function stepsFrom(stdout: string): number | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length < 2) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(lines[1]);
    if (isPlainRecord(parsed) && Array.isArray(parsed.data)) {
      return parsed.data.filter((entry) => isPlainRecord(entry) && entry.type === 'assistant').length;
    }
  } catch {
    // An unparseable line 2 leaves steps null; the read is still a read.
  }
  return null;
}

export class OpencodeApiUsageAdapter implements UsagePort {
  constructor(private readonly options: OpencodeApiUsageAdapterOptions) {}

  async readUsage(request: ReadUsageRequest): Promise<ReadUsageResult> {
    const attempt = request.attempt;
    // No session id means nothing can be measured; nothing is run.
    if (attempt.sessionId === null) {
      return this.unavailable('no session id', attempt);
    }

    const route = this.options.routeForAttempt(attempt);
    if (!route.ok) {
      return this.unavailable(route.reason, attempt);
    }

    if (!SESSION_ID_PATTERN.test(attempt.sessionId)) {
      return this.unavailable('invalid session id', attempt);
    }

    const overrides: Record<string, string> = {
      OCM_REMOTE_PORT: String(route.remotePort),
    };
    if (route.sshHost !== null) {
      overrides.OCM_HOST = route.sshHost;
    }
    if (route.authFile !== null) {
      overrides.OPENCODE_AUTH_FILE = route.authFile;
    }
    const envOptions: RunnerEnvOptions = { transport: route.transport };
    // buildRunnerEnv returns a ProcessEnv whose values are typed `string | undefined`;
    // the sanitized environment only ever holds strings, narrowed here for the runner call.
    const env = buildRunnerEnv(overrides, envOptions) as Readonly<Record<string, string>>;

    let result: SubprocessResult;
    try {
      result = await (this.options.run ?? runViaExecFile)(
        this.options.ocmRunBin ?? defaultOcmRunPath(),
        ['--usage', attempt.sessionId],
        env,
        envOptions,
        { timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      // A subprocess killed by its timeout is reported as timeout; any other
      // throw (a spawn failure, for example) is an executor error.
      if (error instanceof RunnerSubprocessError) {
        return this.unavailable('timeout', attempt);
      }
      return this.unavailable('executor error', attempt);
    }

    // ocm-run reserves exit 1 of --usage for an unknown session, but its shared
    // preamble (the tunnel, the /api/info probe) exits 1 too, so the session's
    // absence is read from ocm-run's own message, never from the code alone.
    if (result.exitCode === 1 && /\bno session \S+ on the server\b/.test(result.stderr)) {
      return this.unavailable('no-session', attempt);
    }
    if (result.exitCode !== 0) {
      return this.unavailable(this.reasonFor(result), attempt);
    }

    const data = parseSessionLine(result.stdout);
    if (data === null) {
      return this.unavailable('unparseable', attempt);
    }

    return {
      outcome: 'read',
      usage: this.fromParsed(data, attempt, result.stdout),
    };
  }

  private fromParsed(
    data: Record<string, unknown>,
    attempt: AttemptRecord,
    stdout: string,
  ): AttemptUsageRecord {
    const time = isPlainRecord(data.time) ? data.time : {};
    const created = numberOrNull(time.created);
    const updated = numberOrNull(time.updated);
    let wallSeconds: number | null = null;
    if (created !== null && updated !== null) {
      const seconds = Math.round(((updated - created) / 1000) * 10) / 10;
      // Two finite instants can still subtract to an overflow (Luna pass).
      wallSeconds = Number.isFinite(seconds) ? seconds : null;
    }
    const tokens = isPlainRecord(data.tokens) ? data.tokens : {};
    const cache = isPlainRecord(tokens.cache) ? tokens.cache : {};
    return {
      source: 'opencode-api',
      readAtIso: this.now().toISOString(),
      sessionId: attempt.sessionId,
      steps: stepsFrom(stdout),
      wallSeconds,
      tokensInput: numberOrNull(tokens.input),
      tokensOutput: numberOrNull(tokens.output),
      tokensReasoning: numberOrNull(tokens.reasoning),
      tokensCacheRead: numberOrNull(cache.read),
      tokensCacheWrite: numberOrNull(cache.write),
      costUsd: numberOrNull(data.cost),
      model: modelOf(data),
      agent: stringOrNull(data.agent),
      reason: null,
    };
  }

  private unavailable(reason: string, attempt: AttemptRecord): ReadUsageResult {
    return {
      outcome: 'unavailable',
      usage: {
        source: 'unavailable',
        readAtIso: this.now().toISOString(),
        sessionId: attempt.sessionId,
        steps: null,
        wallSeconds: null,
        tokensInput: null,
        tokensOutput: null,
        tokensReasoning: null,
        tokensCacheRead: null,
        tokensCacheWrite: null,
        costUsd: null,
        model: null,
        agent: null,
        reason,
      },
    };
  }

  private reasonFor(result: SubprocessResult): string {
    const firstLine = result.stderr.split('\n').map((line) => line.trim()).find((line) => line !== '');
    return firstLine === undefined ? `exit ${result.exitCode}` : `exit ${result.exitCode}: ${firstLine}`;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
