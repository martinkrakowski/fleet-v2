/**
 * `fleet-v2 orchestrator` (lane O5): the three subcommands `status`,
 * `pending` and `attach` over the orchestrator session and request stores.
 * `status` lists registered sessions with their derived `attached` and
 * `attentive` flags. `pending` lists queued, non-expired web requests as data;
 * with `--format hook` it prints the one labelled data line an agent hook
 * reads. `attach` is a foreground sidecar: it registers a session, renews its
 * lease, polls the request mailbox, records every successful poll on the
 * session and retires the session on exit.
 *
 * Everything the stores answer is untrusted data: records are read through
 * `readPlainObjectWithOptional` and `readBoundedDenseArray` (own data
 * descriptors only, no getter or Proxy trap runs) and then validated solely by
 * the domain's `.create(...)` factories. Class instances (the runtime, the
 * repositories) are never snapshotted; only their needed methods are checked.
 * Output is JSON lines on the injected `CliIo`, except the two labelled data
 * lines, which never address the agent. Exit codes: 0 completed, 1 refused or
 * unknown, 2 usage.
 */

import { hostname } from 'node:os';

import {
  HeartbeatOrchestratorSessionUseCase,
  isRegisteredByToken,
  ListOrchestratorSessionsUseCase,
  ORCHESTRATOR_CLI_KINDS,
  ORCHESTRATOR_REQUEST_KINDS,
  ORCHESTRATOR_REQUEST_TARGET_KEY,
  OrchestratorRequest,
  OrchestratorSession,
  OrchestratorSessionRevisionConflictError,
  readPlainObjectWithOptional,
  RegisterOrchestratorSessionUseCase,
  RetireOrchestratorSessionUseCase,
} from '@fleet/operator-coordination';
import type {
  OrchestratorCliKind,
  OrchestratorRequestKind,
  OrchestratorRequestRecord,
  OrchestratorRequestRepositoryPort,
  OrchestratorSessionRecord,
  OrchestratorSessionRepositoryPort,
  RegisterOrAdoptSessionResult,
  StoredOrchestratorSession,
} from '@fleet/operator-coordination';
import { readBoundedDenseArray } from '@fleet/work-execution';

import { CliUsageError, parseDurationOption } from './commands/payload.js';
import type { CliIo } from './index.js';
import { newUlid } from './ulid.js';

export interface OrchestratorCliOptions {
  /** Clock override for tests; production uses the system clock. */
  readonly now?: () => string;
  /** Sleep override for tests; the default wakes immediately when the signal aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Stops `attach` as an external `SIGTERM` would. */
  readonly stopSignal?: AbortSignal;
  /** Session id suffix source for tests. */
  readonly newOrchestratorId?: () => string;
  /** Host name recorded on the session when `--host` is absent. */
  readonly hostName?: string;
  /** Retire `attach` when standard input closes. */
  readonly attachStdinClose?: boolean;
}

/** What a runtime must offer: the composed coordination root, read as unknown data. */
export interface OrchestratorRuntimeLike {
  readonly coordination?: unknown;
}

export const ORCHESTRATOR_HELP = `Usage: fleet-v2 orchestrator status [--status active|retired] [--json]
       fleet-v2 orchestrator pending [--project <id>] [--kind <kind>] [--format json|hook] [--limit <1..1000>]
       fleet-v2 orchestrator attach --kind <cli> [--model <m>] [--host <h>] [--project <id>]... [--claim <kind>]... [--interval <dur>] [--max <dur>] [--once]

status lists registered orchestrator sessions with derived attached and
attentive flags. pending lists queued, non-expired web requests; --format hook
prints one labelled data line only when at least one request is queued. attach
runs a foreground sidecar: it registers a session, renews its lease, polls for
queued requests, records each successful poll, prints a labelled data line for
each newly queued request and retires the session on exit.

  --kind <cli>       attach: claude-code, agy, opencode, codex, conductor or other
  --claim <kind>     attach: a request kind to claim, repeatable (default dispatch-attempt)
  --interval <dur>   attach: poll interval with a unit (ms, s, m), at most 60s (default 30s)
  --max <dur>        attach: stop after this long
  --once             attach: one heartbeat and poll cycle, then retire
  --limit <n>        pending: at most n requests (1..1000, default 100)

Exit codes: 0 completed, 1 refused or unknown, 2 usage error.`;

/** The most request ids `attach` remembers as already announced. */
export const MAX_SEEN_REQUEST_IDS = 10_000;

const ATTACH_TOKEN_ID = 'cli-orchestrator';
const ATTACH_SCOPES: readonly string[] = ['orchestrate'];
const DEFAULT_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_PENDING_LIMIT = 100;
const MAX_PENDING_LIMIT = 1000;
const LIST_CAP = 1000;
const SESSION_ARRAY_CAP = 64;
const SESSION_STATUS_FLAG_VALUES: readonly string[] = ['active', 'retired'];
const PENDING_FORMATS: readonly string[] = ['json', 'hook'];

const SESSION_KEYS: readonly string[] = [
  'orchestratorId', 'cliKind', 'model', 'host', 'projects', 'claims', 'scopes', 'registeredByTokenId',
  'startedAtIso', 'lastHeartbeatIso', 'leaseUntilIso', 'lastPolledRequestsAtIso', 'status',
];
const REQUEST_KEYS: readonly string[] = [
  'requestId', 'revision', 'kind', 'projectId', 'target', 'requestedBy', 'createdAtIso', 'expiresAtIso',
  'updatedAtIso', 'state', 'fence', 'claimCount', 'claim', 'deferredUntilIso', 'reason', 'linked',
];
const TARGET_KEYS: readonly string[] = ['attemptId', 'workOrderId', 'runId'];
const LINK_KEYS: readonly string[] = ['attemptId', 'runId', 'journalKey'];

/** The store answered with data this command refuses to trust. */
export class InvalidStoreDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStoreDataError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Hostile-input snapshots. Every read below goes through own data descriptors
// (`readPlainObjectWithOptional`, `readBoundedDenseArray`); a getter, a Proxy
// trap, a symbol key, an extra or reserved key (`__proto__`, `constructor`,
// `prototype` are never in an allowed list) or a hole is a `null`.
// ---------------------------------------------------------------------------

/** A data record with exactly `required` keys plus the `optional` ones; accessors refused. */
function plainRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  return readPlainObjectWithOptional(value, required, [...required, ...optional], {
    refuseOptionalAccessors: true,
  });
}

/** A fresh array copy of a dense array of at most `cap` entries, or null. */
function denseCopy(value: unknown, cap: number): unknown[] | null {
  const read = readBoundedDenseArray(value, cap);
  return read === null ? null : Array.from(read.array);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * One stored session record as fresh plain data, validated by the domain's
 * `OrchestratorSession.create`, or null. Cost: one descriptor walk over the
 * record's 13 keys and three arrays of at most 64 entries.
 */
export function snapshotSessionRecord(value: unknown): OrchestratorSessionRecord | null {
  try {
    const top = plainRecord(value, SESSION_KEYS);
    if (top === null) return null;
    const projects = denseCopy(top.projects, SESSION_ARRAY_CAP);
    const claims = denseCopy(top.claims, SESSION_ARRAY_CAP);
    const scopes = denseCopy(top.scopes, SESSION_ARRAY_CAP);
    if (projects === null || claims === null || scopes === null) return null;
    const created = OrchestratorSession.create({ ...top, projects, claims, scopes });
    return created.success ? created.value.toRecord() : null;
  } catch {
    return null;
  }
}

/** One `{ session, revision }` store entry as fresh plain data; throws on anything untrustworthy. */
function snapshotStoredSession(value: unknown): StoredOrchestratorSession {
  const top = plainRecord(value, ['session', 'revision']);
  if (top === null || !isRevision(top.revision)) {
    throw new InvalidStoreDataError('the orchestrator session store answered with an unreadable entry');
  }
  const session = snapshotSessionRecord(top.session);
  if (session === null) {
    throw new InvalidStoreDataError('the orchestrator session store answered with an invalid session record');
  }
  return { session, revision: top.revision };
}

type RawSessionRepo = Pick<OrchestratorSessionRepositoryPort, 'get' | 'save' | 'list'>;

/**
 * The one session-repository wrapper every use case and `attach` itself read
 * through: each store answer is snapshotted before any use case sees it. Errors
 * the store throws pass through unchanged so the use cases' `instanceof`
 * checks still work. Cost: `get` and `save` are one entry walk; `list` is at
 * most `LIST_CAP` entry walks.
 */
export function createSnapshottingSessionRepo(raw: RawSessionRepo): OrchestratorSessionRepositoryPort {
  return {
    registerOrAdoptSession(): Promise<RegisterOrAdoptSessionResult> {
      return Promise.resolve({
        outcome: 'refused',
        reason: 'registerOrAdoptSession is not available through the CLI',
      });
    },
    async get(orchestratorId) {
      const stored = await raw.get(orchestratorId);
      return stored === null ? null : snapshotStoredSession(stored);
    },
    async list(query) {
      const answered = await raw.list(query);
      const entries = denseCopy(answered, LIST_CAP);
      if (entries === null) {
        throw new InvalidStoreDataError('the orchestrator session store answered with an unreadable list');
      }
      return entries.map(snapshotStoredSession);
    },
    async save(record, expectedRevision) {
      return snapshotStoredSession(await raw.save(record, expectedRevision));
    },
  };
}

/** A nested optional record: null stays null, anything else is a plain record or the whole read fails. */
function nestedOrNull(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): { readonly ok: true; readonly value: Record<string, unknown> | null } | { readonly ok: false } {
  if (value === null) return { ok: true, value: null };
  const read = plainRecord(value, required, optional);
  return read === null ? { ok: false } : { ok: true, value: read };
}

/**
 * One stored request record as fresh plain data, validated solely by the
 * domain's `OrchestratorRequest.create`, or null. Cost: one descriptor walk
 * over the 16 record keys and the five small nested records.
 */
export function snapshotOrchestratorRequest(value: unknown): OrchestratorRequestRecord | null {
  try {
    const top = plainRecord(value, REQUEST_KEYS);
    if (top === null) return null;
    const target = plainRecord(top.target, [], TARGET_KEYS);
    const requestedBy = plainRecord(top.requestedBy, ['via', 'sessionId']);
    const claim = nestedOrNull(top.claim, ['orchestratorId', 'fence', 'leaseUntilIso']);
    const reason = nestedOrNull(top.reason, ['reasonKind', 'detail']);
    const linked = nestedOrNull(top.linked, ['journalKey'], LINK_KEYS);
    if (target === null || requestedBy === null || !claim.ok || !reason.ok || !linked.ok) return null;
    const created = OrchestratorRequest.create({
      ...top,
      target,
      requestedBy,
      claim: claim.value,
      reason: reason.value,
      linked: linked.value,
    });
    return created.success ? created.value.toRecord() : null;
  } catch {
    return null;
  }
}

type RequestListRead =
  | { readonly ok: true; readonly requests: OrchestratorRequestRecord[]; readonly truncated: boolean }
  | { readonly ok: false; readonly outcome: 'refused' | 'unknown'; readonly reason: string };

/** The request store's list answer as data: an `ok` outcome with valid records, or a typed failure. */
function snapshotRequestList(value: unknown): RequestListRead {
  const unreadable: RequestListRead = {
    ok: false,
    outcome: 'unknown',
    reason: 'the orchestrator request store answered with unreadable data',
  };
  const top = plainRecord(value, ['outcome'], ['requests', 'truncated', 'code', 'errorCode']);
  if (top === null) return unreadable;
  if (top.outcome === 'refused' || top.outcome === 'unknown') {
    return { ok: false, outcome: top.outcome, reason: `the orchestrator request store answered ${top.outcome}` };
  }
  if (top.outcome !== 'ok' || typeof top.truncated !== 'boolean') return unreadable;
  const entries = denseCopy(top.requests, LIST_CAP);
  if (entries === null) return unreadable;
  const requests: OrchestratorRequestRecord[] = [];
  for (const entry of entries) {
    const request = snapshotOrchestratorRequest(entry);
    if (request === null) return unreadable;
    requests.push(request);
  }
  return { ok: true, requests, truncated: top.truncated };
}

interface UseCaseOutcome {
  readonly outcome: string;
  readonly reason?: string;
}

/** A use case's outcome object as data: one of `allowed` as `outcome`, a string `reason` and `code` when present. */
export function snapshotOutcome(value: unknown, allowed: readonly string[]): UseCaseOutcome {
  const top = plainRecord(value, ['outcome'], ['reason', 'session', 'revision', 'code']);
  if (top === null || typeof top.outcome !== 'string' || !allowed.includes(top.outcome)) {
    throw new InvalidStoreDataError('an orchestrator use case answered with an unreadable outcome');
  }
  if ('reason' in top && typeof top.reason !== 'string') {
    throw new InvalidStoreDataError('an orchestrator use case answered with an unreadable reason');
  }
  if ('code' in top && typeof top.code !== 'string') {
    throw new InvalidStoreDataError('an orchestrator use case answered with an unreadable code');
  }
  if ('revision' in top && !isRevision(top.revision)) {
    throw new InvalidStoreDataError('an orchestrator use case answered with an unreadable revision');
  }
  if ('session' in top && snapshotSessionRecord(top.session) === null) {
    throw new InvalidStoreDataError('an orchestrator use case answered with an invalid session record');
  }
  return 'reason' in top ? { outcome: top.outcome, reason: top.reason as string } : { outcome: top.outcome };
}

interface SessionListEntry {
  readonly session: OrchestratorSessionRecord;
  readonly revision: number;
  readonly attached: boolean;
  readonly attentive: boolean;
}

/** The list use case's `{ sessions }` answer as data. */
function snapshotSessionList(value: unknown): SessionListEntry[] {
  const unreadable = (): never => {
    throw new InvalidStoreDataError('the orchestrator session list was unreadable');
  };
  const top = plainRecord(value, ['sessions']);
  const entries = top === null ? null : denseCopy(top.sessions, LIST_CAP);
  if (entries === null) return unreadable();
  return entries.map((entry) => {
    const record = plainRecord(entry, ['session', 'revision', 'attached', 'attentive']);
    if (
      record === null
      || !isRevision(record.revision)
      || typeof record.attached !== 'boolean'
      || typeof record.attentive !== 'boolean'
    ) {
      return unreadable();
    }
    const session = snapshotSessionRecord(record.session);
    if (session === null) return unreadable();
    return { session, revision: record.revision, attached: record.attached, attentive: record.attentive };
  });
}

// ---------------------------------------------------------------------------
// Flags and small helpers.
// ---------------------------------------------------------------------------

export function orchestratorHelpRequested(argv: readonly string[]): boolean {
  return argv.length > 0 && (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h'));
}

interface FlagSpec {
  /** Flags that take one value. */
  readonly values: readonly string[];
  /** Value flags that may repeat. */
  readonly repeatable: readonly string[];
  /** Flags that take no value. */
  readonly booleans: readonly string[];
}

/**
 * A closed flag reader: a flag outside the spec, a repeated non-repeatable
 * flag, a missing value or a bare positional is a usage error (one stderr
 * line, null). Cost: one pass over `argv`.
 */
function parseFlags(
  argv: readonly string[],
  spec: FlagSpec,
  io: CliIo,
): Map<string, string[]> | null {
  const out = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      io.stderr(`Unexpected argument: ${token}\n`);
      return null;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const isBoolean = spec.booleans.includes(name);
    if (!isBoolean && !spec.values.includes(name)) {
      io.stderr(`Unknown flag: --${name}\n`);
      return null;
    }
    if (out.has(name) && !spec.repeatable.includes(name)) {
      io.stderr(`Repeated flag: --${name}\n`);
      return null;
    }
    let value = 'true';
    if (!isBoolean) {
      if (equals !== -1) {
        value = token.slice(equals + 1);
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
          io.stderr(`--${name} requires a value\n`);
          return null;
        }
        value = next;
        index += 1;
      }
      if (value === '') {
        io.stderr(`--${name} requires a value\n`);
        return null;
      }
    }
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const holder = value as Record<string, unknown>;
  return names.every((name) => typeof holder[name] === 'function');
}

function coordinationOf(runtime: OrchestratorRuntimeLike | undefined): Record<string, unknown> | null {
  const coordination = runtime?.coordination;
  return typeof coordination === 'object' && coordination !== null ? (coordination as Record<string, unknown>) : null;
}

const STORE_UNAVAILABLE = {
  outcome: 'unknown',
  code: 'store-unavailable',
  reason: 'the orchestrator store is not available in this runtime',
} as const;

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A zoned ISO-8601 instant the clock may answer; looser `Date.parse` strings are refused. */
function isValidIso(value: string): boolean {
  return ISO_INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function describeError(error: unknown): string {
  return error instanceof InvalidStoreDataError ? error.message : 'the orchestrator store could not be read';
}

/** A single timer and a single abort listener, both removed when it settles. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Remember an announced request id; the set never holds more than `MAX_SEEN_REQUEST_IDS`. */
export function rememberRequestId(seen: Set<string>, requestId: string): void {
  if (seen.size >= MAX_SEEN_REQUEST_IDS) {
    seen.clear();
  }
  seen.add(requestId);
}

function parseDuration(key: string, raw: string): number {
  return parseDurationOption({ [key]: raw }, key, 0);
}

function parseLimit(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_PENDING_LIMIT ? limit : null;
}

function single(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

// ---------------------------------------------------------------------------
// Subcommands.
// ---------------------------------------------------------------------------

async function statusCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: OrchestratorRuntimeLike | undefined,
  options: OrchestratorCliOptions,
): Promise<number> {
  const flags = parseFlags(argv, { values: ['status'], repeatable: [], booleans: ['json'] }, io);
  if (flags === null) return 2;
  const status = single(flags, 'status');
  if (status !== undefined && !SESSION_STATUS_FLAG_VALUES.includes(status)) {
    io.stderr(`--status must be one of ${SESSION_STATUS_FLAG_VALUES.join(', ')}\n`);
    return 2;
  }
  const sessionRepo = coordinationOf(runtime)?.orchestratorSessionRepository;
  if (!hasMethods(sessionRepo, ['list'])) {
    printJson(io, STORE_UNAVAILABLE);
    return 1;
  }
  const nowIso = (options.now ?? (() => new Date().toISOString()))();
  if (typeof nowIso !== 'string' || !isValidIso(nowIso)) {
    printJson(io, { outcome: 'unknown', reason: 'the clock could not be read' });
    return 1;
  }
  try {
    const listing = new ListOrchestratorSessionsUseCase({
      sessionRepo: createSnapshottingSessionRepo(sessionRepo as RawSessionRepo),
      clock: { nowIso: () => nowIso },
    });
    const answered = await listing.listOrchestratorSessions(
      status === undefined ? {} : { status: status as 'active' | 'retired' },
    );
    printJson(io, { outcome: 'ok', sessions: snapshotSessionList(answered) });
    return 0;
  } catch (error) {
    printJson(io, { outcome: 'unknown', reason: describeError(error) });
    return 1;
  }
}

async function pendingCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: OrchestratorRuntimeLike | undefined,
  options: OrchestratorCliOptions,
): Promise<number> {
  const flags = parseFlags(
    argv,
    { values: ['project', 'kind', 'format', 'limit'], repeatable: [], booleans: [] },
    io,
  );
  if (flags === null) return 2;
  const projectId = single(flags, 'project');
  const kind = single(flags, 'kind');
  const format = single(flags, 'format') ?? 'json';
  const limitRaw = single(flags, 'limit');
  if (kind !== undefined && !(ORCHESTRATOR_REQUEST_KINDS as readonly string[]).includes(kind)) {
    io.stderr(`--kind must be one of ${ORCHESTRATOR_REQUEST_KINDS.join(', ')}\n`);
    return 2;
  }
  if (!PENDING_FORMATS.includes(format)) {
    io.stderr(`--format must be one of ${PENDING_FORMATS.join(', ')}\n`);
    return 2;
  }
  const limit = limitRaw === undefined ? DEFAULT_PENDING_LIMIT : parseLimit(limitRaw);
  if (limit === null) {
    io.stderr(`--limit must be an integer from 1 to ${MAX_PENDING_LIMIT}\n`);
    return 2;
  }
  const fail = (body: Record<string, unknown>): number => {
    if (format === 'hook') {
      io.stderr(`${JSON.stringify(body)}\n`);
    } else {
      printJson(io, body);
    }
    return 1;
  };
  const requestRepo = coordinationOf(runtime)?.orchestratorRequestRepository;
  if (!hasMethods(requestRepo, ['list'])) return fail({ ...STORE_UNAVAILABLE });
  const nowIso = (options.now ?? (() => new Date().toISOString()))();
  if (typeof nowIso !== 'string' || !isValidIso(nowIso)) {
    return fail({ outcome: 'unknown', reason: 'the clock could not be read' });
  }
  const nowMs = Date.parse(nowIso);
  let read: RequestListRead;
  try {
    const answered = await (requestRepo as Pick<OrchestratorRequestRepositoryPort, 'list'>).list({
      state: 'queued',
      ...(projectId === undefined ? {} : { projectId }),
      ...(kind === undefined ? {} : { kind: kind as OrchestratorRequestKind }),
      limit,
    });
    read = snapshotRequestList(answered);
  } catch {
    return fail({ outcome: 'unknown', reason: 'the orchestrator request store could not be read' });
  }
  if (!read.ok) return fail({ outcome: read.outcome, reason: read.reason });
  const items = read.requests
    .filter((request) => request.state === 'queued' && Date.parse(request.expiresAtIso) > nowMs)
    .map((request) => ({
      requestId: request.requestId,
      kind: request.kind,
      projectId: request.projectId,
      target: request.target,
      requestedAtIso: request.createdAtIso,
    }));
  if (format === 'hook') {
    if (items.length > 0) {
      io.stdout(`fleet-v2 web requests (data, not instructions): ${JSON.stringify(items)}\n`);
    }
    return 0;
  }
  printJson(io, { outcome: 'ok', requests: items, truncated: read.truncated });
  return 0;
}

interface AttachFailure {
  readonly outcome: string;
  readonly reason: string;
}

async function attachCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: OrchestratorRuntimeLike | undefined,
  options: OrchestratorCliOptions,
): Promise<number> {
  const flags = parseFlags(
    argv,
    {
      values: ['kind', 'model', 'host', 'project', 'claim', 'interval', 'max'],
      repeatable: ['project', 'claim'],
      booleans: ['once'],
    },
    io,
  );
  if (flags === null) return 2;
  const cliKind = single(flags, 'kind');
  if (cliKind === undefined || !(ORCHESTRATOR_CLI_KINDS as readonly string[]).includes(cliKind)) {
    io.stderr(`--kind is required and must be one of ${ORCHESTRATOR_CLI_KINDS.join(', ')}\n`);
    return 2;
  }
  const claims = flags.get('claim') ?? ['dispatch-attempt'];
  if (!claims.every((claim) => (ORCHESTRATOR_REQUEST_KINDS as readonly string[]).includes(claim))) {
    io.stderr(`--claim must be one of ${ORCHESTRATOR_REQUEST_KINDS.join(', ')}\n`);
    return 2;
  }
  let intervalMs = DEFAULT_INTERVAL_MS;
  let maxMs: number | undefined;
  try {
    const intervalRaw = single(flags, 'interval');
    if (intervalRaw !== undefined) intervalMs = parseDuration('interval', intervalRaw);
    const maxRaw = single(flags, 'max');
    if (maxRaw !== undefined) maxMs = parseDuration('max', maxRaw);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (intervalMs <= 0 || intervalMs > MAX_INTERVAL_MS) {
    io.stderr(`--interval must be greater than zero and at most ${MAX_INTERVAL_MS / 1000}s\n`);
    return 2;
  }
  if (maxMs !== undefined && maxMs <= 0) {
    io.stderr('--max must be greater than zero\n');
    return 2;
  }

  const coordination = coordinationOf(runtime);
  const sessionRepo = coordination?.orchestratorSessionRepository;
  const requestRepo = coordination?.orchestratorRequestRepository;
  if (!hasMethods(sessionRepo, ['get', 'save', 'list']) || !hasMethods(requestRepo, ['list'])) {
    printJson(io, STORE_UNAVAILABLE);
    return 1;
  }

  const now = options.now ?? (() => new Date().toISOString());
  const clockMs = (): number => Date.parse(now());
  if (!isValidIso(now())) {
    printJson(io, { outcome: 'unknown', reason: 'the clock could not be read' });
    return 1;
  }
  const clock = { nowIso: now };
  const wrapped = createSnapshottingSessionRepo(sessionRepo as RawSessionRepo);
  const requests = requestRepo as Pick<OrchestratorRequestRepositoryPort, 'list'>;
  const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: wrapped, clock });
  const heartbeat = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: wrapped, clock });
  const retire = new RetireOrchestratorSessionUseCase({ sessionRepo: wrapped, clock });
  const orchestratorId = `orch-${(options.newOrchestratorId ?? newUlid)()}`;

  try {
    const registered = snapshotOutcome(
      await register.registerOrchestratorSession(
        {
          orchestratorId,
          cliKind: cliKind as OrchestratorCliKind,
          model: single(flags, 'model') ?? null,
          host: single(flags, 'host') ?? options.hostName ?? hostname(),
          projects: flags.get('project') ?? [],
          claims,
        },
        ATTACH_SCOPES,
        ATTACH_TOKEN_ID,
      ),
      ['registered', 'refused'],
    );
    if (registered.outcome !== 'registered') {
      printJson(io, { outcome: 'refused', reason: registered.reason ?? 'the session was not registered' });
      return 1;
    }
  } catch (error) {
    printJson(io, { outcome: 'unknown', reason: describeError(error) });
    return 1;
  }

  const abort = new AbortController();
  const onStop = (): void => abort.abort();
  const stopSignal = options.stopSignal;
  if (stopSignal?.aborted === true) abort.abort();
  stopSignal?.addEventListener('abort', onStop, { once: true });
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  if (options.attachStdinClose === true) {
    process.stdin.on('end', onStop);
    process.stdin.on('close', onStop);
    process.stdin.resume();
  }

  /** Record one successful poll on the session; one retry after a revision conflict. */
  const recordPoll = async (): Promise<AttachFailure | null> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stored = await wrapped.get(orchestratorId);
      if (stored === null) return { outcome: 'not-found', reason: 'the session is no longer stored' };
      const session = OrchestratorSession.create(stored.session);
      if (!session.success || !isRegisteredByToken(session.value.toRecord(), ATTACH_TOKEN_ID)) {
        return { outcome: 'not-owner', reason: 'the stored session is not owned by this command' };
      }
      const updated = session.value.recordRequestsPoll(now());
      if (!updated.success) return { outcome: 'refused', reason: updated.error.message };
      try {
        await wrapped.save(updated.value.toRecord(), stored.revision);
        return null;
      } catch (error) {
        if (!(error instanceof OrchestratorSessionRevisionConflictError)) throw error;
      }
    }
    return { outcome: 'refused', reason: 'another writer moved this session twice; poll again' };
  };

  const seen = new Set<string>();
  let failure: AttachFailure | null = null;
  // A failed poll is reported at once and retried next round, but the first one is
  // remembered: unknown state is never success, so the run ends with exit 1.
  let pollFailure: AttachFailure | null = null;
  let endReason = 'stopped';
  const sleep = options.sleep ?? abortableSleep;
  const deadline = maxMs === undefined ? Number.POSITIVE_INFINITY : clockMs() + maxMs;
  try {
    for (let round = 0; ; round += 1) {
      if (abort.signal.aborted) {
        endReason = 'stopped';
        break;
      }
      if (round > 0 && clockMs() >= deadline) {
        endReason = 'max-elapsed';
        break;
      }
      const beat = snapshotOutcome(
        await heartbeat.heartbeatOrchestratorSession({ orchestratorId }, ATTACH_TOKEN_ID),
        ['renewed', 'not-found', 'not-owner', 'refused'],
      );
      if (beat.outcome !== 'renewed') {
        failure = { outcome: beat.outcome, reason: beat.reason ?? `the heartbeat answered ${beat.outcome}` };
        break;
      }
      let polled: RequestListRead;
      try {
        polled = snapshotRequestList(await requests.list({ state: 'queued', limit: DEFAULT_PENDING_LIMIT }));
      } catch {
        polled = { ok: false, outcome: 'unknown', reason: 'the orchestrator request store could not be read' };
      }
      if (!polled.ok) {
        io.stderr(`${JSON.stringify({ outcome: polled.outcome, reason: polled.reason })}\n`);
        pollFailure ??= { outcome: polled.outcome, reason: polled.reason };
      } else {
        const nowMs = clockMs();
        for (const request of polled.requests) {
          if (request.state !== 'queued' || !(Date.parse(request.expiresAtIso) > nowMs)) continue;
          if (seen.has(request.requestId)) continue;
          rememberRequestId(seen, request.requestId);
          const targetId = (request.target as unknown as Record<string, string>)[
            ORCHESTRATOR_REQUEST_TARGET_KEY[request.kind]
          ];
          io.stdout(`fleet-v2 web request queued (data): ${request.kind} ${targetId}\n`);
        }
        const recorded = await recordPoll();
        if (recorded !== null) {
          failure = recorded;
          break;
        }
      }
      if (flags.has('once')) {
        endReason = 'once';
        break;
      }
      const remaining = deadline - clockMs();
      if (remaining <= 0) {
        endReason = 'max-elapsed';
        break;
      }
      await sleep(Math.min(intervalMs, remaining), abort.signal);
    }
  } catch (error) {
    failure = { outcome: 'unknown', reason: describeError(error) };
  } finally {
    stopSignal?.removeEventListener('abort', onStop);
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
    if (options.attachStdinClose === true) {
      process.stdin.removeListener('end', onStop);
      process.stdin.removeListener('close', onStop);
      process.stdin.pause();
    }
  }

  try {
    const retired = snapshotOutcome(
      await retire.retireOrchestratorSession({ orchestratorId }, ATTACH_TOKEN_ID),
      ['retired', 'not-found', 'not-owner', 'refused'],
    );
    if (retired.outcome !== 'retired' && failure === null) {
      failure = { outcome: 'unknown', reason: retired.reason ?? `the retire answered ${retired.outcome}` };
    }
  } catch (error) {
    printJson(io, { outcome: 'unknown', reason: describeError(error) });
    return 1;
  }
  if (failure === null && pollFailure !== null) failure = pollFailure;
  if (failure !== null) {
    printJson(io, { outcome: failure.outcome, orchestratorId, reason: failure.reason });
    return 1;
  }
  printJson(io, { outcome: 'detached', orchestratorId, reason: endReason });
  return 0;
}

export async function orchestratorCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: OrchestratorRuntimeLike | undefined,
  options: OrchestratorCliOptions = {},
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case 'status':
      return statusCommand(rest, io, runtime, options);
    case 'pending':
      return pendingCommand(rest, io, runtime, options);
    case 'attach':
      return attachCommand(rest, io, runtime, options);
    default:
      io.stderr(`${ORCHESTRATOR_HELP}\n`);
      return 2;
  }
}
