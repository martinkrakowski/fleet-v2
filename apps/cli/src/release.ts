/**
 * The `release` command group (cutover row CO14): `install`, `swap` and
 * `rollback` of the built fleet-v2 release behind the `current` pointer.
 * Without `--apply` each prints the plan and writes nothing. With `--apply`
 * it needs `--project <id>`, under which a recorded, approved owner grant for
 * `release:<action>` at the target sha must exist (asked for with
 * `coordination request-decision`); the grant is consumed once, through the
 * same ActionAuthorizationPort the forge actions use, and no flag value is
 * authority by itself. The repoint runs only while the release holds the
 * conductor driver lease. Without a durable state directory the coordination
 * store is empty, so an apply is always refused. The commands only return the
 * typed result; they never print a path, the root, the source or a grant id.
 *
 * CO14c: the release runs only on the served root. The served root is read
 * LEXICALLY from the configured `daemon.cliPath` (the `<root>` in
 * `<root>/current/...`), never from the filesystem, and it never depends on
 * whether the entry point exists. `--root` must exist and `realpath(--root)`
 * must equal `realpath(configured root)`; any realpath failure refuses with
 * `release-root-state-dir-unknown`. A missing configured root is refused;
 * the operator creates it once. The check-then-use window is closed by
 * resolving once and using only the resolved path: after verification the
 * command operates on the canonical real path alone, so a later symlink swap
 * of `--root` cannot redirect a write outside the served root.
 */

import { lstat, realpath } from 'node:fs/promises';

import type { FleetInstallation } from '@fleet/installation';
import {
  ActionAuthorizationAdapter,
  LocalExecutor,
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  consumptionId,
  releaseActionScope,
  type ActionAuthorizationPort,
  type CommandExecutorPort,
  type ConductorDriverLeasePort,
  type ManageReleaseRequest,
  type ManageReleaseResult,
  type ReleaseAction,
  type ReleaseStorePort,
} from '@fleet/work-execution';

import { CliUsageError } from './commands/payload.js';
import type { CommandHandler, Payload } from './commands/payload.js';
import type { FleetCliRuntime } from './composition.js';

const FLAGS: ReadonlySet<string> = new Set(['action', 'root', 'sha', 'source', 'keep', 'apply', 'project']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_KEEP = 5;
const MIN_KEEP = 2;
const MAX_KEEP = 64;

export interface ReleaseCommandDependencies {
  readonly lease: ConductorDriverLeasePort;
  readonly authorization: ActionAuthorizationPort;
  readonly executor: CommandExecutorPort;
  readonly nowIso: () => string;
  readonly env: () => Record<string, string | undefined>;
  /** Defaults to the local filesystem store. */
  readonly store?: ReleaseStorePort;
}

/**
 * The release grant path over the runtime's coordination use cases: resolve
 * and consume only under the `release:<action>` scope at the target sha. Any
 * other action kind is blocked here, so a forge grant never authorizes a
 * release and a release grant never authorizes a forge action.
 */
export function releaseAuthorization(rt: FleetCliRuntime): ActionAuthorizationPort {
  return new ActionAuthorizationAdapter({
    resolveGrant: async (request) => {
      const actionScope = releaseActionScope(request.actionKind);
      if (actionScope === null) {
        return { outcome: 'blocked', reason: 'not a release action' };
      }
      const result = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: request.projectId,
        actionScope,
        expectedHeadSha: request.expectedHeadSha,
        // CO24g: the release grant is attempt-less by design — it is anchored by
        // its `release:<action>` scope and exact head and consumed once — so the
        // attempt coordinate is passed through only when the caller carries one.
        attemptId: request.attemptId,
      });
      return result.outcome === 'authorized'
        ? { outcome: 'granted', authorizationGrantId: result.grantId }
        : { outcome: 'blocked', reason: result.reason };
    },
    consumeGrant: async (request) => {
      const actionScope = releaseActionScope(request.actionKind);
      if (actionScope === null || request.expectedHeadSha === undefined) {
        return { outcome: 'refused', reason: 'not a release grant consumption' };
      }
      const result = await rt.coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: consumptionId(request.actionId),
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionScope,
        attemptId: request.attemptId ?? request.actionId,
        expectedHeadSha: request.expectedHeadSha,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed', actionId: request.actionId }
        : { outcome: 'refused', reason: result.reason };
    },
  });
}

/**
 * CO14c: the release root facts of the served root, read LEXICALLY from the
 * installation: the configured root is the `<root>` in `<root>/current/...`
 * of `daemon.cliPath`, and `daemon.stateDir` is the state directory of the
 * driver that serves it. Pure: no filesystem or environment access. Null when
 * the root cannot be determined at all — no daemon section, no entry point
 * path, an entry point that is not an absolute path without `.` or `..`
 * segments, no `current` segment, or no state directory — and the release
 * refuses `release-root-state-dir-unknown`. It never depends on whether the
 * entry point exists.
 */
export function servedRootFacts(installation: FleetInstallation | undefined): {
  readonly configuredRoot: string;
  readonly stateDir: string;
} | null {
  const daemon = installation?.daemon;
  const stateDir = daemon?.stateDir;
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    return null;
  }
  const cliPath = daemon?.cliPath;
  if (typeof cliPath !== 'string') {
    return null;
  }
  const cliSegments = plainAbsoluteSegments(cliPath);
  if (cliSegments === null) {
    return null;
  }
  // The served root is the `<root>` of the LAST `current` segment: the entry
  // point of a nested installation such as `/srv/current/fleet/current/...`
  // still names the innermost served root `/srv/current/fleet`, not `/srv`.
  const currentAt = cliSegments.lastIndexOf('current');
  if (currentAt < 1) {
    return null;
  }
  return { configuredRoot: `/${cliSegments.slice(0, currentAt).join('/')}`, stateDir };
}

/** The segments of an absolute path with no `.`, `..` or empty segment; null otherwise. */
function plainAbsoluteSegments(value: string): string[] | null {
  if (!value.startsWith('/')) {
    return null;
  }
  const segments = value.slice(1).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? segments : null;
}

type RootResolution =
  | { readonly outcome: 'verified'; readonly root: string }
  | { readonly outcome: 'refused'; readonly reason?: 'release-root-missing' };

const ROOT_REFUSED: RootResolution = { outcome: 'refused' };

/**
 * CO14c rules 2–5: resolve `--root` against the served root.
 *
 * Rule 2: any `realpath` failure — on `--root` or on the configured root —
 * refuses, and the configured root's ENOENT is a refusal too: a missing
 * configured root is refused (typed reason `release-root-missing`); the
 * operator creates it once. Rule 3: `--root` must exist and
 * `realpath(--root)` must equal `realpath(configured root)`; a symlinked root
 * is fine only when it resolves to the configured root. Rule 4: a missing
 * configured root is refused; the operator creates it once. Rule 5: the
 * check-then-use window is closed by resolving once and using only the
 * resolved path — the verified canonical real path is the only root the
 * command uses afterwards, so a symlink swapped in after the check cannot
 * redirect a write outside the served root.
 */
export async function resolveVerifiedRoot(
  root: string,
  facts: { readonly configuredRoot: string; readonly stateDir: string },
): Promise<RootResolution> {
  const realConfigured = await realpathOrNull(facts.configuredRoot);
  if (realConfigured === null) {
    const observed = await lstatEntry(facts.configuredRoot);
    if (observed === 'absent') {
      // Genuine absence (ENOENT) is a refusal: a missing configured root is
      // never created here. A dangling link, a permission error or any other
      // realpath/lstat failure stays unknown and refuses as before.
      return { outcome: 'refused', reason: 'release-root-missing' };
    }
    return ROOT_REFUSED;
  }
  return verifiedEqualRoot(root, realConfigured);
}

/** Rule 3: `--root` must exist and resolve to the same real path as the configured root. */
async function verifiedEqualRoot(root: string, realConfigured: string): Promise<RootResolution> {
  const realRoot = await realpathOrNull(root);
  if (realRoot === null || realRoot !== realConfigured) {
    return ROOT_REFUSED;
  }
  return { outcome: 'verified', root: realConfigured };
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * The lstat observation of a path, with error types kept: `'absent'` only for
 * ENOENT — the path does not exist, which refuses with
 * `release-root-missing`. `ENOTDIR` is NOT absence: it means a component is
 * not a directory, so the configured root is invalid and stays `'unknown'`.
 * Every other failure is `'unknown'` too and never treated as absence.
 */
async function lstatEntry(
  target: string,
): Promise<Awaited<ReturnType<typeof lstat>> | 'absent' | 'unknown'> {
  try {
    return await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

function releaseHandler(action: ReleaseAction): CommandHandler {
  return async (payload, rt) => {
    if (Object.hasOwn(payload, 'action')) {
      throw new CliUsageError('Unknown release option: --action');
    }
    const request = parseRequest({ ...payload, action });
    // CO14c: the release runs only on the served root. The root is verified
    // here, at the CLI boundary, before the use case sees any path.
    const facts = servedRootFacts(rt.installation);
    if (facts === null) {
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' };
    }
    const verified = await resolveVerifiedRoot(request.root, facts);
    if (verified.outcome !== 'verified') {
      if (verified.reason === 'release-root-missing') {
        return {
          outcome: 'refused',
          reason: 'release-root-missing',
          message: `the configured release root does not exist; create it once with: mkdir -p ${facts.configuredRoot}`,
        };
      }
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' };
    }
    return manageReleaseFromPayload(
      { ...payload, action, root: verified.root },
      {
        lease: rt.conductor.driverLease,
        authorization: releaseAuthorization(rt),
        executor: new LocalExecutor(),
        nowIso: () => new Date().toISOString(),
        env: () => process.env, // the use case passes only a filtered allowlist to the git child
      },
    );
  };
}

export const releaseCommands: Readonly<Record<string, CommandHandler>> = {
  install: releaseHandler('install'),
  swap: releaseHandler('swap'),
  rollback: releaseHandler('rollback'),
};

export async function manageReleaseFromPayload(
  payload: Payload,
  deps: ReleaseCommandDependencies,
): Promise<ManageReleaseResult> {
  const request = parseRequest(payload);
  const useCase = new ManageReleaseUseCase({
    store: deps.store ?? new ReleaseStoreAdapter(),
    lease: deps.lease,
    authorization: deps.authorization,
    executor: deps.executor,
    nowIso: deps.nowIso,
    env: deps.env,
  });
  return await useCase.manageRelease(request);
}

function parseRequest(payload: Payload): ManageReleaseRequest {
  for (const key of Object.keys(payload)) {
    if (!FLAGS.has(key)) {
      throw new CliUsageError(`Unknown release option: --${key}`);
    }
  }
  const action = payload['action'];
  if (action !== 'install' && action !== 'swap' && action !== 'rollback') {
    throw new CliUsageError('release requires one of: install, swap, rollback');
  }
  const root = payload['root'];
  if (!isAbsolutePath(root)) {
    throw new CliUsageError("release requires --root <absolute path without '..'>");
  }
  const sha = parseSha(action, payload['sha']);
  const source = parseSource(action, payload['source']);
  return {
    action,
    root,
    sha,
    source,
    keep: parseKeep(payload['keep']),
    apply: parseApply(payload['apply']),
    projectId: parseProject(payload['project']),
  };
}

function parseSha(action: ReleaseAction, value: unknown): string | null {
  if (action === 'rollback') {
    if (value !== undefined) {
      throw new CliUsageError('release rollback does not take --sha');
    }
    return null;
  }
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new CliUsageError(`release ${action} requires --sha <40 lowercase hex>`);
  }
  return value;
}

function parseSource(action: ReleaseAction, value: unknown): string | null {
  if (action !== 'install') {
    if (value !== undefined) {
      throw new CliUsageError(`release ${action} does not take --source`);
    }
    return null;
  }
  const source = value === undefined ? process.cwd() : value;
  if (!isAbsolutePath(source)) {
    throw new CliUsageError("--source must be an absolute path without '..'");
  }
  return source;
}

function keepCandidate(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

function parseKeep(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_KEEP;
  }
  const parsed = keepCandidate(value);
  if (!Number.isInteger(parsed) || parsed < MIN_KEEP || parsed > MAX_KEEP) {
    throw new CliUsageError(`--keep must be an integer from ${MIN_KEEP} to ${MAX_KEEP}`);
  }
  return parsed;
}

function parseApply(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') {
    return false;
  }
  if (value === true || value === 'true') {
    return true;
  }
  throw new CliUsageError('--apply takes no value');
}

function parseProject(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliUsageError('--project requires a project id');
  }
  return value;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..');
}
