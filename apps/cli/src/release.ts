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
        // CO14 follow-up: the release root travels with the grant coordinates,
        // so a grant for one root never authorizes another; and the
        // deterministic action id travels as the resume key, so a grant
        // consumed by exactly this action id (a crash between the consumption
        // and the release's write) resolves again idempotently.
        releaseRoot: request.releaseRoot,
        resumeActionId: request.actionId,
      });
      return result.outcome === 'authorized'
        ? {
            outcome: 'granted',
            authorizationGrantId: result.grantId,
            ...(result.releaseRoot !== undefined ? { releaseRoot: result.releaseRoot } : {}),
          }
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
        releaseRoot: request.releaseRoot,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed', actionId: request.actionId }
        : { outcome: 'refused', reason: result.reason };
    },
  });
}

function releaseHandler(action: ReleaseAction): CommandHandler {
  return async (payload, rt) => {
    if (Object.hasOwn(payload, 'action')) {
      throw new CliUsageError('Unknown release option: --action');
    }
    // CO14 follow-up: the release reads the lease of the state directory of
    // the driver that serves this root — the one the installation records —
    // never the process-wide one, so a release under another state directory
    // cannot miss a live lease. A root whose driver state directory cannot be
    // determined is refused before anything is read, built or written.
    const root = payload['root'];
    if (typeof root !== 'string') {
      throw new CliUsageError("release requires --root <absolute path without '..'>");
    }
    const stateDir = resolveRootStateDir(root, rt.installation as ReleaseDriverConfiguration | undefined);
    if (stateDir === null) {
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
    }
    // A root bound to another installation's driver is not served by this one:
    // its lease would be read from the wrong directory, so it is refused. A
    // root with no binding yet is bound to this driver after its first applied
    // release (first binding wins). An unreadable binding is unknown.
    const store = new ReleaseStoreAdapter();
    const checkable = root.startsWith('/') && !root.split('/').includes('..') && root.length <= 4096;
    const binding = checkable ? await store.readDriverBinding({ root }) : ({ outcome: 'unbound' } as const);
    if (binding.outcome === 'unreadable' || (binding.outcome === 'bound' && binding.stateDir !== stateDir)) {
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
    }
    // CO14b fix round 3: an unbound root is bound to this driver BEFORE the
    // release is applied, not after. bindDriver's exclusive-create (`wx`) is
    // the mutual-exclusion point: only one racing driver can ever win it for
    // a given unbound root. Gating the apply itself on winning that bind
    // means no two drivers can concurrently apply to the same previously-
    // unbound root — a bind that happens only after applying would let both
    // racers apply before either result is recorded.
    // CO14b fix round 4: that race protection is only ever needed for a call
    // that will actually APPLY. A plan-only call never mutates anything (the
    // file's own doc comment: "Without --apply each prints the plan and
    // writes nothing"), so binding an unbound root here — which itself
    // creates the root directory and writes the `.release-driver` marker —
    // would make a plan-only request a real filesystem write, breaking that
    // contract. Skip the early bind entirely when this call is not an apply;
    // the already-bound refusal path above (a binding that exists and
    // mismatches) is unchanged either way, since it never writes anything.
    // CO14b fix round 5: `checkable` is also the only condition under which
    // `binding` was genuinely read rather than assumed `unbound`. When the
    // root is not checkable (relative, containing `..`, or over 4096 chars),
    // treating that assumed `unbound` as real and binding anyway would call
    // `store.bindDriver`, which does a real `fs.mkdir(root, { recursive: true
    // })` plus writes the `.release-driver` marker, using an unvalidated
    // root, before `manageReleaseFromPayload`'s own `parseRequest` ever gets
    // to refuse it. Gate the early bind on `checkable` too, so an invalid
    // root falls straight through to that existing validation, which refuses
    // it without writing anything, exactly as before this bind-before-apply
    // logic was added.
    if (checkable && binding.outcome === 'unbound' && parseApply(payload['apply'])) {
      const bound = await store.bindDriver({ root, stateDir });
      if (bound.outcome !== 'bound' || bound.stateDir !== stateDir) {
        // Another process's bind won the race first (or the bind itself is
        // unreadable): this driver never served the root, so it never applies.
        return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
      }
    }
    return await manageReleaseFromPayload(
      { ...payload, action },
      {
        lease: new ConductorDriverLeaseAdapter({ stateDir }),
        authorization: releaseAuthorization(rt),
        executor: new LocalExecutor(),
        nowIso: () => new Date().toISOString(),
        env: () => process.env, // the use case passes only a filtered allowlist to the git child
        store,
      },
    );
  };
}

export interface ReleaseDriverConfiguration {
  /** The installation's daemon section, whose `stateDir` names the driver state directory. */
  readonly daemon?: { readonly stateDir?: string };
}

/**
 * CO14 follow-up: the pure binding of a release root to the state directory
 * of the driver that serves it. The state directory comes from the
 * installation configuration the runtime composed with (`daemon.stateDir`);
 * a missing, non-absolute or blank one cannot be determined, and the caller
 * refuses with `release-root-state-dir-unknown`. No filesystem or environment
 * access of its own.
 */
export function resolveRootStateDir(
  root: string,
  configuration: ReleaseDriverConfiguration | undefined,
): string | null {
  if (typeof root !== 'string' || root === '') {
    return null;
  }
  try {
    // CO14b fix round 3: `configuration` itself may be hostile (an accessor or
    // a Proxy `get` trap on the `daemon` key), so it is descriptor-checked the
    // same way `stateDir` already is below; a getter or setter on `daemon` is
    // never invoked.
    const configurationDescriptor =
      typeof configuration === 'object' && configuration !== null
        ? Object.getOwnPropertyDescriptor(configuration, 'daemon')
        : undefined;
    const daemon =
      configurationDescriptor !== undefined && !configurationDescriptor.get && !configurationDescriptor.set
        ? configurationDescriptor.value
        : undefined;
    if (typeof daemon !== 'object' || daemon === null) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(daemon, 'stateDir');
    const value = descriptor !== undefined && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
    return typeof value === 'string' && value.startsWith('/') && value.trim() !== '' ? value : null;
  } catch {
    // A hostile configuration never resolves to a state directory.
    return null;
  }
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
