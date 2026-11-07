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
 */

import {
  ActionAuthorizationAdapter,
  ConductorDriverLeaseAdapter,
  LocalExecutor,
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  consumptionId,
  releaseActionScope,
  sha256HexDigest,
  type ActionAuthorizationPort,
  type CommandExecutorPort,
  type ConductorDriverLeasePort,
  type ManageReleaseRequest,
  type ManageReleaseResult,
  type ReleaseAction,
  type ReleaseStorePort,
} from '@fleet/work-execution';

import type { FleetInstallation } from '@fleet/installation';
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
        actionScope: releaseScopeForRoot(actionScope, request.root),
        expectedHeadSha: request.expectedHeadSha,
      });
      return result.outcome === 'authorized'
        ? { outcome: 'granted', authorizationGrantId: result.grantId, root: request.root }
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
        actionScope: releaseScopeForRoot(actionScope, request.root),
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
 * CO14b: the coordination scope of one release action, carrying the root the
 * grant authorizes. The root is bound as a digest (never the path), so a
 * grant recorded for one root can never authorize another, and no path ever
 * reaches coordination state or output.
 */
function releaseScopeForRoot(actionScope: string, root: string | undefined): string {
  return root === undefined ? actionScope : `${actionScope}@${sha256HexDigest(root)}`;
}

/**
 * CO14b: the state directory of the driver that serves a release root. The
 * installation's `daemon.stateDir` is the driver state directory (the release
 * reads the lease of that directory, never the process-wide one). When none
 * is recorded the root's driver state directory cannot be determined and the
 * release refuses `release-root-state-dir-unknown`. Pure: no filesystem or
 * environment access.
 */
export function resolveReleaseRootStateDir(
  root: string,
  installation: FleetInstallation | undefined,
): string | null {
  const stateDir = installation?.daemon?.stateDir;
  return typeof stateDir === 'string' && stateDir.trim() !== '' ? stateDir : null;
}

function releaseHandler(action: ReleaseAction): CommandHandler {
  return async (payload, rt) => {
    if (Object.hasOwn(payload, 'action')) {
      throw new CliUsageError('Unknown release option: --action');
    }
    const request = parseRequest({ ...payload, action });
    const stateDir = resolveReleaseRootStateDir(request.root, rt.installation);
    if (stateDir === null) {
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' };
    }
    return manageReleaseFromPayload(
      { ...payload, action },
      {
        // CO14b: the release reads the lease of the driver that serves this
        // root (its state directory), never the process-wide driver lease.
        lease: new ConductorDriverLeaseAdapter({ stateDir }),
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
