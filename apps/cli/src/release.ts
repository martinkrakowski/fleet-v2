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
 * `release-root-state-dir-unknown`. Only a first `release install --apply`
 * may create the (absent) configured root, as a real directory with no
 * symlink anywhere in the created path, under the driver lease of the served
 * state directory, and it re-verifies the equality inside that same lock.
 * The check-then-use window is closed by resolving once and using only the
 * resolved path: after verification the command operates on the canonical
 * real path alone, so a later symlink swap of `--root` cannot redirect a
 * write outside the served root.
 */

import { lstat, mkdir, realpath } from 'node:fs/promises';

import type { FleetInstallation } from '@fleet/installation';
import {
  ActionAuthorizationAdapter,
  ConductorDriverLeaseAdapter,
  LocalExecutor,
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  consumptionId,
  releaseActionScope,
  type ActionAuthorizationPort,
  type CommandExecutorPort,
  type ConductorDriverLeasePort,
  type ConductorDriverLeaseRecord,
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

/** How long the first-install creation holds the served driver lease; well inside a lease maximum. */
const INSTALL_LOCK_MS = 60_000;
const INSTALL_LOCK_HOLDER = 'release-install';

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
  | { readonly outcome: 'refused' };

const ROOT_REFUSED: RootResolution = { outcome: 'refused' };

/**
 * CO14c rules 2–5: resolve `--root` against the served root.
 *
 * Rule 2: any `realpath` failure — on `--root` or on the configured root —
 * refuses, except the configured root's ENOENT, which is the first-install
 * state, not an unknown one. Rule 3: `--root` must exist and
 * `realpath(--root)` must equal `realpath(configured root)`; a symlinked root
 * is fine only when it resolves to the configured root. Rule 4: when the
 * configured root does not exist yet, only `release install --apply` may
 * create it — a real directory, `mkdir -p` with no symlink anywhere in the
 * created path, under the driver lease of the served state directory (the
 * install lock), and it re-verifies rule 3 inside that same lock before the
 * root is used. Rule 5: the check-then-use window is closed by resolving
 * once and using only the resolved path — the verified canonical real path is
 * the only root the command uses afterwards, so a symlink swapped in after
 * the check cannot redirect a write outside the served root.
 */
export async function resolveVerifiedRoot(
  root: string,
  facts: { readonly configuredRoot: string; readonly stateDir: string },
  options: {
    /** True only for `install --apply`: the configured root may be created. */
    readonly createIfAbsent: boolean;
    /** The driver lease of the served state directory; the install lock. */
    readonly lease: ConductorDriverLeasePort;
    readonly nowIso: () => string;
  },
): Promise<RootResolution> {
  const realConfigured = await realpathOrNull(facts.configuredRoot);
  if (realConfigured === null) {
    const observed = await lstatEntry(facts.configuredRoot);
    if (observed !== 'absent' || !options.createIfAbsent) {
      // Only genuine absence (ENOENT) is the first-install state. A dangling
      // link, a permission error or any other realpath/lstat failure stays
      // unknown and refuses — it never enters the creation path.
      return ROOT_REFUSED;
    }
    return createServedRoot(root, facts, options);
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

/**
 * Rule 4: create the absent configured root as a real directory under the
 * install lock, then re-verify rule 3 inside that same lock. The lock is the
 * driver lease of the served state directory: acquire is by CAS on the fence,
 * so a concurrent install (or a live driver) cannot hold it twice, and the
 * creation and the re-verification both happen between acquire and release.
 */
async function createServedRoot(
  root: string,
  facts: { readonly configuredRoot: string },
  options: { readonly lease: ConductorDriverLeasePort; readonly nowIso: () => string },
): Promise<RootResolution> {
  let observed: ConductorDriverLeaseRecord | null = null;
  try {
    observed = await options.lease.read();
  } catch {
    return ROOT_REFUSED;
  }
  const nowIso = options.nowIso();
  let acquired: { readonly fence: number };
  try {
    const taken = await options.lease.acquire({
      holderId: INSTALL_LOCK_HOLDER,
      observedFence: observed?.fence ?? 0,
      leaseUntilIso: new Date(Date.parse(nowIso) + INSTALL_LOCK_MS).toISOString(),
      nowIso,
    });
    if (taken.outcome !== 'ok') {
      // The lock is refused: another holder owns the creation window. Rule 4
      // requires the rule-3 re-verification to happen INSIDE that same lock
      // before the root is used, so without the lock the root is refused —
      // even if it appears to exist meanwhile. The holder that does hold the
      // lock performs the creation and the re-verification.
      return ROOT_REFUSED;
    }
    acquired = { fence: taken.lease.fence };
  } catch {
    return ROOT_REFUSED;
  }
  try {
    if (!(await mkdirRealDirectory(facts.configuredRoot))) {
      return ROOT_REFUSED;
    }
    // Rule 4: the equality is re-verified inside the same lock, before use.
    const realConfigured = await realpathOrNull(facts.configuredRoot);
    if (realConfigured === null) {
      return ROOT_REFUSED;
    }
    return await verifiedEqualRoot(root, realConfigured);
  } finally {
    // Best effort: the lease lapses on its own within the lock window.
    await options.lease
      .release({ holderId: INSTALL_LOCK_HOLDER, fence: acquired.fence, nowIso: options.nowIso() })
      .catch(() => undefined);
  }
}

/**
 * `mkdir -p` that never follows or creates a symlink: each missing component
 * is created with a non-recursive mkdir, and an existing component must be a
 * real directory (an lstat, so a symlink component refuses even when its
 * target is a directory).
 */
async function mkdirRealDirectory(directory: string): Promise<boolean> {
  const segments = plainAbsoluteSegments(directory);
  if (segments === null) {
    return false;
  }
  let current = '';
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const observed = await lstatEntry(current);
    if (observed !== 'absent') {
      if (observed === 'unknown' || !observed.isDirectory()) {
        return false;
      }
      continue;
    }
    try {
      await mkdir(current);
    } catch {
      return false;
    }
  }
  return true;
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
 * ENOENT — the path does not exist and its parent chain is all real
 * directories, so it could be created. `ENOTDIR` is NOT absence: it means a
 * component is not a directory, so the configured root is invalid and stays
 * `'unknown'` — it never enters the first-install creation path. Every other
 * failure is `'unknown'` too and never treated as absence.
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
    const verified = await resolveVerifiedRoot(request.root, facts, {
      createIfAbsent: request.action === 'install' && request.apply,
      lease: new ConductorDriverLeaseAdapter({ stateDir: facts.stateDir }),
      nowIso: () => new Date().toISOString(),
    });
    if (verified.outcome !== 'verified') {
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
