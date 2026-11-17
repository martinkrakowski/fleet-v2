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

import { realpath } from 'node:fs/promises';

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
  /**
   * The state directory of the driver this call acts for (CO14b fix round 8).
   * `ManageReleaseUseCase` uses it only to bind a previously-unbound root to
   * this driver, and only after authorization has already granted — see
   * `ManageReleaseUseCase.bindRootIfUnbound`. `releaseHandler` below always
   * supplies the same value it already resolved for the lease adapter.
   */
  readonly stateDir: string;
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
    // CO14c-1: the served root is extracted lexically from the installation's
    // `daemon.cliPath` (`<root>/current/apps/cli/dist/bin.js`); a missing or
    // malformed one leaves the served root unknown. Whether the entry point
    // exists on disk plays no part in the parse itself.
    const configuredRoot = configuredReleaseRoot(rt.installation as ReleaseDriverConfiguration | undefined);
    if (configuredRoot === null) {
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
    }
    const checkable = root.startsWith('/') && !root.split('/').includes('..') && root.length <= 4096;
    // CO14c-1: `--root` must be the root the daemon actually serves. The
    // pre-check runs only when the `checkable` predicate holds, so an
    // uncheckable root (`..` or relative) still falls through to
    // `parseRequest`'s usage error unchanged. Otherwise `--root` and the
    // configured root must both exist on disk (any nonexistent root —
    // including on `install --apply`, since the operator pre-creates the
    // root — refuses here) and resolve to the same real path: a symlinked
    // root is accepted only when it resolves to the configured root. The
    // failure is a typed refusal that never echoes a path.
    if (checkable) {
      try {
        const [realRoot, realConfiguredRoot] = await Promise.all([realpath(root), realpath(configuredRoot)]);
        if (realRoot !== realConfiguredRoot) {
          return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
        }
      } catch {
        return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
      }
    }
    // A root bound to another installation's driver is not served by this one:
    // its lease would be read from the wrong directory, so it is refused
    // here, before anything is read, built or written. A root with no
    // binding yet is bound to this driver after its first applied release
    // (first binding wins) — but NOT here: see the round 8 note below. An
    // unreadable binding is unknown.
    const store = new ReleaseStoreAdapter();
    const binding = checkable ? await store.readDriverBinding({ root }) : ({ outcome: 'unbound' } as const);
    if (binding.outcome === 'unreadable' || (binding.outcome === 'bound' && binding.stateDir !== stateDir)) {
      return { outcome: 'refused', reason: 'release-root-state-dir-unknown' as const };
    }
    // CO14b fix round 8: the actual bind-when-unbound WRITE used to happen
    // right here, gated only on `checkable`, an actual apply and the binding
    // reading `unbound` — entirely BEFORE authorization was ever checked.
    // That let an unauthorized apply request (wrong or missing project, no
    // matching grant) against a fresh unbound root permanently bind it to
    // this driver before being refused for lack of authority, which could
    // make the root unusable for whichever driver should actually have
    // served it. The write is now `ManageReleaseUseCase.bindRootIfUnbound`,
    // called only after its own grant resolution has granted and only before
    // its first mutating write (`beginOperation`) — preserving the original
    // round-3 property (the bind still happens before any mutating action)
    // while closing that gap. `releaseHandler` keeps only the read-only
    // checks above (the unresolvable-state-dir refusal and the already-
    // bound-mismatch refusal), which write nothing either way.
    return await manageReleaseFromPayload(
      { ...payload, action },
      {
        lease: new ConductorDriverLeaseAdapter({ stateDir }),
        authorization: releaseAuthorization(rt),
        executor: new LocalExecutor(),
        nowIso: () => new Date().toISOString(),
        env: () => process.env, // the use case passes only a filtered allowlist to the git child
        store,
        stateDir,
      },
    );
  };
}

export interface ReleaseDriverConfiguration {
  /**
   * The installation's daemon section, whose `stateDir` names the driver state
   * directory and whose `cliPath` is the served CLI entry point, from which
   * the served release root is extracted lexically (CO14c-1).
   */
  readonly daemon?: { readonly stateDir?: string; readonly cliPath?: string };
}

/** The exact entry suffix a served `daemon.cliPath` must end with (ReleaseStoreAdapter's `CLI_ENTRY`). */
const CLI_ENTRY_SUFFIX = '/current/apps/cli/dist/bin.js';

/** The named cap on a configured `daemon.cliPath` length; the parser is linear in this. */
const MAX_CLI_PATH_LENGTH = 4096;

/**
 * CO14c-1: the typed result of the pure `daemon.cliPath` parser. Refusals carry
 * the release's named unknown-state-dir reason; success carries the extracted
 * lexical `<root>` prefix of `<root>/current/apps/cli/dist/bin.js`.
 */
export type ConfiguredCliPath =
  | { readonly outcome: 'ok'; readonly root: string }
  | { readonly outcome: 'refused'; readonly reason: 'release-root-state-dir-unknown' };

const CLI_PATH_REFUSED: ConfiguredCliPath = { outcome: 'refused', reason: 'release-root-state-dir-unknown' };

/**
 * CO14c-1: the pure lexical parse of the configured `daemon.cliPath`. It
 * accepts only a string ending with the exact suffix
 * `/current/apps/cli/dist/bin.js` (matching `ReleaseStoreAdapter`'s
 * `CLI_ENTRY`); the configured root is the prefix before that suffix, so a
 * root that itself contains a `current` segment is unambiguous. The prefix
 * must be non-empty, absolute, and free of `\0`, empty (`//`), `.` and `..`
 * segments. Whether the entry point exists on disk is irrelevant here. The
 * input is taken as `unknown` and never thrown from: anything that is not a
 * plain string value — a wrong primitive, a non-plain object, a getter or a
 * `Proxy` (neither ever invoked nor trapped, since the parse reads no
 * property at all) — refuses. Cost: linear in the capped input, at most
 * `MAX_CLI_PATH_LENGTH` characters inspected once each; the cap is a named
 * constant, and an over-cap input refuses before any traversal.
 */
export function parseConfiguredCliPath(value: unknown): ConfiguredCliPath {
  try {
    if (typeof value !== 'string' || value.length > MAX_CLI_PATH_LENGTH) {
      return CLI_PATH_REFUSED;
    }
    if (!value.endsWith(CLI_ENTRY_SUFFIX)) {
      return CLI_PATH_REFUSED;
    }
    const root = value.slice(0, value.length - CLI_ENTRY_SUFFIX.length);
    if (!root.startsWith('/') || root.includes('\0')) {
      return CLI_PATH_REFUSED;
    }
    // The leading segment is empty by construction (the prefix starts with
    // `/`); any other empty segment is a `//`, and `.` / `..` segments are
    // refused so the lexical prefix is the literal root.
    const segments = root.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === '' || segment === '.' || segment === '..') {
        return CLI_PATH_REFUSED;
      }
    }
    return { outcome: 'ok', root };
  } catch {
    return CLI_PATH_REFUSED;
  }
}

/**
 * CO14c-1: the configured release root, read from the installation's
 * `daemon.cliPath` through own data-property descriptors only (matching
 * `resolveRootStateDir`'s descriptor checks on `configuration` and `daemon`,
 * so a getter or a `Proxy` trap is never invoked). `null` when the
 * configuration is missing or hostile or the `cliPath` fails the lexical
 * parse. No filesystem access of its own.
 */
function configuredReleaseRoot(configuration: ReleaseDriverConfiguration | undefined): string | null {
  try {
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
    const descriptor = Object.getOwnPropertyDescriptor(daemon, 'cliPath');
    const value = descriptor !== undefined && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
    const parsed = parseConfiguredCliPath(value);
    return parsed.outcome === 'ok' ? parsed.root : null;
  } catch {
    return null;
  }
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
    stateDir: deps.stateDir,
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
