// Adapter scaffold — implemented for lane S3.
/**
 * OpencodeDbUsageAdapter implements UsagePort by running one reviewed node
 * script on the attempt's recorded host through its CommandExecutorPort.
 * The script reads opencode's own sqlite database (`$HOME/.local/share/
 * opencode/opencode.db`, unless overridden) read-only: it verifies the
 * `session` schema, reads the session's numeric columns, agent and model id,
 * counts assistant messages, and prints ONE JSON line with the usage
 * numbers. It never prints `directory`, `title` or message content. The
 * adapter maps a clean exit with a parseable line to `read`; anything else —
 * a non-zero exit, an unparseable line, an executor error or a timeout — is
 * `unavailable` with the reason built from the exit code and the parsed
 * `error` field or the first 120 characters of stderr (never stdout beyond
 * the parsed object). It never throws.
 */

import type { AttemptRecord, AttemptUsageRecord } from '../../domain/execution-records.js';
import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  ReadUsageRequest,
  ReadUsageResult,
  UsagePort,
} from '../../application/ports/out/UsagePort.out-port.js';

export interface OpencodeDbUsageAdapterOptions {
  /**
   * Resolves the command executor for the attempt's recorded host. The
   * recorded host is the truth: a host that changed or was removed refuses
   * (throws), which the adapter reports as `unavailable`.
   */
  readonly executorForRecordedHost: (attempt: AttemptRecord) => CommandExecutorPort;
  /** Node binary on the runner host; defaults to `node`. */
  readonly nodeBin?: string;
  /**
   * Absolute path to opencode's database; defaults to
   * `$HOME/.local/share/opencode/opencode.db` on the runner host.
   */
  readonly databasePath?: string;
  /** Wall-clock budget for the read; defaults to 20 000 ms. */
  readonly timeoutMs?: number;
  /** Clock for the read timestamp; defaults to the system clock. */
  readonly now?: () => Date;
}

/** Default wall-clock budget for one usage read. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The reviewed node script run as
 * `node --no-warnings -e <script> -- <sessionId> <databasePath>`.
 * Plain JavaScript only: no caller value is ever interpolated into this
 * constant; the session id and database path arrive as `process.argv`
 * (`process.argv[1]` and `process.argv[2]`). The script writes exactly one
 * JSON line to stdout and exits 0 on success, `{"error":"no-session"}` with
 * exit 1 when the session row is absent, and `{"error":"schema"}` or
 * `{"error":"query"}` with exit 3 on schema or query failures. It never
 * prints `directory`, `title` or message content.
 */
export const OPENCODE_DB_READ_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const sessionId = process.argv[1];
const databasePath = process.argv[2] || process.env.HOME + '/.local/share/opencode/opencode.db';
const COLUMNS = ['id','directory','agent','model','cost','tokens_input','tokens_output','tokens_reasoning','tokens_cache_read','tokens_cache_write','time_created','time_updated'];
let db;
try {
  db = new DatabaseSync(databasePath, { readOnly: true });
} catch (e) {
  console.log(JSON.stringify({ error: 'query' }));
  process.exit(3);
}
try {
  const table = db.prepare('pragma table_info(session)').all();
  const present = new Set(table.map((c) => c.name));
  for (const name of COLUMNS) {
    if (!present.has(name)) {
      console.log(JSON.stringify({ error: 'schema' }));
      process.exit(3);
    }
  }
  const row = db.prepare("select cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, agent, json_extract(model, '$.id') as model_id from session where id = ?").get(sessionId);
  if (!row) {
    console.log(JSON.stringify({ error: 'no-session' }));
    process.exit(1);
  }
  const counted = db.prepare("select count(*) as steps from message where session_id = ? and json_extract(data, '$.role') = 'assistant'").get(sessionId);
  const num = (v) => (v === null || v === undefined ? null : v);
  const created = num(row.time_created);
  const updated = num(row.time_updated);
  const wallSeconds = created === null || updated === null ? null : Math.round(((updated - created) / 1000) * 10) / 10;
  console.log(JSON.stringify({
    steps: counted ? counted.steps : 0,
    wallSeconds: wallSeconds,
    tokensInput: num(row.tokens_input),
    tokensOutput: num(row.tokens_output),
    tokensReasoning: num(row.tokens_reasoning),
    tokensCacheRead: num(row.tokens_cache_read),
    tokensCacheWrite: num(row.tokens_cache_write),
    costUsd: num(row.cost),
    model: num(row.model_id),
    agent: num(row.agent),
  }));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ error: 'query' }));
  process.exit(3);
}
`;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class OpencodeDbUsageAdapter implements UsagePort {
  constructor(private readonly options: OpencodeDbUsageAdapterOptions) {}

  async readUsage(request: ReadUsageRequest): Promise<ReadUsageResult> {
    const attempt = request.attempt;
    // No session id means nothing can be measured; nothing is run.
    if (attempt.sessionId === null) {
      return this.unavailable('no session id', attempt);
    }

    let run: CommandRunResult;
    try {
      const executor = this.options.executorForRecordedHost(attempt);
      run = await executor.run(this.argvFor(attempt.sessionId), {
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch {
      // A thrown executor resolution (e.g. a recorded host that changed or
      // was removed) or a rejected run is reported as unavailable.
      return this.unavailable('executor error', attempt);
    }

    if (run.error !== undefined) {
      return this.unavailable('executor error', attempt);
    }

    if (run.exitCode !== 0) {
      return this.unavailable(this.reasonFor(run), attempt);
    }

    const parsed = this.parseJson(run.stdout);
    if (parsed !== null && typeof parsed === 'object' && !('error' in parsed)) {
      return {
        outcome: 'read',
        usage: this.fromParsed(parsed as Record<string, unknown>, attempt),
      };
    }
    return this.unavailable(this.reasonFor(run), attempt);
  }

  private argvFor(sessionId: string): readonly string[] {
    return [
      this.options.nodeBin ?? 'node',
      '--no-warnings',
      '-e',
      OPENCODE_DB_READ_SCRIPT,
      '--',
      sessionId,
      this.options.databasePath ?? '',
    ];
  }

  private fromParsed(
    parsed: Record<string, unknown>,
    attempt: AttemptRecord,
  ): AttemptUsageRecord {
    return {
      source: 'opencode-db',
      readAtIso: this.now().toISOString(),
      sessionId: attempt.sessionId,
      steps: numberOrNull(parsed.steps),
      wallSeconds: numberOrNull(parsed.wallSeconds),
      tokensInput: numberOrNull(parsed.tokensInput),
      tokensOutput: numberOrNull(parsed.tokensOutput),
      tokensReasoning: numberOrNull(parsed.tokensReasoning),
      tokensCacheRead: numberOrNull(parsed.tokensCacheRead),
      tokensCacheWrite: numberOrNull(parsed.tokensCacheWrite),
      costUsd: numberOrNull(parsed.costUsd),
      model: stringOrNull(parsed.model),
      agent: stringOrNull(parsed.agent),
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

  private reasonFor(run: CommandRunResult): string {
    const parsed = this.parseJson(run.stdout);
    const errorValue =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error?: unknown }).error
        : undefined;
    if (typeof errorValue === 'string' && errorValue.trim() !== '') {
      return `exit ${run.exitCode}: ${errorValue}`;
    }
    const stderr = run.stderr.trim();
    if (stderr.length > 0) {
      return `exit ${run.exitCode}: ${stderr.slice(0, 120)}`;
    }
    return `exit ${run.exitCode}`;
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
