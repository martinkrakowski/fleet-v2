/**
 * The `release` command group (cutover row CO14): `install`, `swap` and
 * `rollback` of the built fleet-v2 release behind the `current` pointer.
 * Without `--apply` each prints the plan and writes nothing; with `--apply`
 * it needs `--authority` and a conductor driver lease that is not live. The
 * commands only return the typed result; they never print a path, the root,
 * the source or the authority value.
 */

import {
  LocalExecutor,
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  type CommandExecutorPort,
  type ConductorDriverLeasePort,
  type ManageReleaseRequest,
  type ManageReleaseResult,
  type ReleaseAction,
} from '@fleet/work-execution';

import { CliUsageError } from './commands/payload.js';
import type { CommandHandler, Payload } from './commands/payload.js';

const FLAGS: ReadonlySet<string> = new Set(['action', 'root', 'sha', 'source', 'keep', 'apply', 'authority']);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_KEEP = 5;
const MIN_KEEP = 2;
const MAX_KEEP = 64;

export interface ReleaseCommandDependencies {
  readonly lease: ConductorDriverLeasePort;
  readonly executor: CommandExecutorPort;
  readonly nowIso: () => string;
  readonly env?: () => Record<string, string | undefined>;
}

function releaseHandler(action: ReleaseAction): CommandHandler {
  return async (payload, rt) => {
    if (Object.hasOwn(payload, 'action')) {
      throw new CliUsageError('Unknown release option: --action');
    }
    return manageReleaseFromPayload(
      { ...payload, action },
      {
        lease: rt.conductor.driverLease,
        executor: new LocalExecutor(),
        nowIso: () => new Date().toISOString(),
        env: () => process.env,
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
    store: new ReleaseStoreAdapter(),
    lease: deps.lease,
    executor: deps.executor,
    nowIso: deps.nowIso,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });
  return useCase.manageRelease(request);
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
    authority: parseAuthority(payload['authority']),
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

function parseKeep(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_KEEP;
  }
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
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

function parseAuthority(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new CliUsageError('--authority requires a value');
  }
  return value;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..');
}
