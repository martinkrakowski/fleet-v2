/**
 * The `relaunch` command group (cutover plan CO26, CO29a, AR3c2): the
 * read-only `relaunch inventory` and `relaunch plan`, the owner-grant
 * coordinate derivation of `relaunch request-grant`, and the dry-run-default
 * `relaunch apply`. The inventory reports, per lane host, the registered
 * clones' worktree listing, the runner's state per worktree directory, the
 * conductor's status and each lane's population (conducted, attempt-recorded,
 * unrecorded); its risk flags are counts only and the worktree paths are
 * printed here, in the local CLI output. The plan orders the relaunch of those
 * lanes and stores one immutable plan by digest; its output carries ids,
 * counts, digests and fixed codes, never a path. `request-grant` derives the
 * digest-bound `relaunch:apply` grant coordinates from a plan digest; `apply`
 * mutates nothing until `--apply --grant <id>` is given. Both stop, abort,
 * adopt and dispatch nothing and mutate no worktree on a dry run.
 */

import { createHash } from 'node:crypto';

import {
  isStrictIsoInstant,
  relaunchApplyDigestPayload,
  RELAUNCH_APPLY_ACTION_SCOPE,
  RELAUNCH_APPLY_DIGEST_PREFIX,
  RELAUNCH_APPLY_PROJECT_ID,
} from '@fleet/operator-coordination';

import { CliUsageError, optStr, str, type CommandHandler, type Payload } from './commands/payload.js';
import type { FleetCliRuntime } from './composition.js';
import type {
  AttemptRunnerRecord,
  InventoryRelaunchResult,
  PlanRelaunchResult,
  RelaunchCloneRef,
} from '@fleet/work-execution';
import type { HostSection } from '@fleet/installation';

/**
 * The host's recorded runner block, or null when the host is not in the
 * installation. A null block routes no read: the inventory reports that
 * host as unknown instead of inspecting the path on the local executor.
 * Exported for CO30c so the cutover wiring in composition.ts reuses this
 * one derivation instead of copying it.
 */
export function recordedHostOf(
  hostName: string,
  rt: Pick<FleetCliRuntime, 'installation'>,
): AttemptRunnerRecord | null {
  const host: HostSection | undefined = rt.installation?.hosts?.[hostName];
  if (host === undefined) return null;
  const kind = host.runner?.kind ?? 'opencode';
  return {
    kind,
    remotePort: kind === 'agy' ? null : host.runner?.port ?? null,
    host: host.transport === 'ssh' ? host.sshAlias ?? null : null,
    hostName,
    agent: null,
    model: null,
    variant: null,
  };
}

/** The refusal for unreadable profile records (exit 1). */
const UNREADABLE: InventoryRelaunchResult = { outcome: 'refused', reason: 'records-unreadable' };

/** The unknown for unreadable profile records: no clone list, so no plan (exit 1). */
const PROFILES_UNREADABLE: PlanRelaunchResult = { outcome: 'unknown', reasons: ['profile-records-unreadable'] };

/**
 * D18: only the clones of active project profiles are read; never a host-wide
 * scan. An unreadable profile listing is not "no clones": it is null, and the
 * caller refuses rather than reporting zero hosts. CO29a-ro2: the listing
 * reads the read-only profile repository, so a corrupt store file is never
 * quarantined by a relaunch command.
 */
async function activeClones(hostName: string | null, rt: FleetCliRuntime): Promise<RelaunchCloneRef[] | null> {
  let profiles: Awaited<ReturnType<FleetCliRuntime['coordination']['listProjectProfiles']['listProjectProfiles']>>;
  try {
    profiles = await rt.coordination.listProjectProfilesReadOnly.listProjectProfiles({ status: 'active' });
  } catch {
    return null;
  }
  if (profiles.outcome !== 'listed') return null;
  const clones: RelaunchCloneRef[] = [];
  for (const profile of profiles.profiles) {
    if (profile.status !== 'active') continue;
    for (const [cloneHost, clone] of Object.entries(profile.clones)) {
      if (hostName !== null && cloneHost !== hostName) continue;
      clones.push({
        projectId: profile.projectId,
        hostName: cloneHost,
        clonePath: clone.path,
        worktreeRoot: clone.worktreeRoot,
        recordedHost: recordedHostOf(cloneHost, rt),
      });
    }
  }
  return clones;
}

/** An integer string becomes a number; anything else reaches the use case as given and is refused there. */
function coerceInteger(value: unknown): unknown {
  return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
}

/** Whether the operator supplied `key`; an omitted flag keeps the use case's default. */
function supplied(p: Payload, key: string): boolean {
  return Object.hasOwn(p, key) && p[key] !== undefined;
}

// ---------------------------------------------------------------------------
// AR3c2: `relaunch request-grant` and `relaunch apply`. Every untrusted flag
// value is refused with a typed `CliUsageError` (exit 2) — never a pass and
// never an unhandled exception — and no error message ever echoes a flag
// value: a grant id or an inputs document may carry secret-shaped text.
// ---------------------------------------------------------------------------

/** The plan digest a relaunch-apply grant is bound by: 64 lowercase hex. */
const PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A policy revision travels verbatim into a printed command line, so it is
 * bounded and allow-listed: no whitespace, no control character and no shell
 * metacharacter (`; | & $ \` < > \ ! ' " ( ) { } [ ] * ? ~ #`) can ever reach
 * one. Cost bound: O(1) — one length-bounded regex pass over at most 128
 * characters, so hostile bulk never scales the check.
 */
const POLICY_REVISION_PATTERN = /^[A-Za-z0-9._:/@-]{1,128}$/;

/** The JSON text of one `--save-inputs` / `--adopt-inputs` flag, capped before any parse. */
const MAX_INPUT_JSON_BYTES = 2_097_152;
/** One inputs array holds at most 64 lanes. */
const MAX_INPUT_ITEMS = 64;
/** The recursive clone of one inputs array: depth and total node bounds. */
const MAX_INPUT_DEPTH = 10;
const MAX_INPUT_NODES = 4096;

/** Keys that can never be copied through the inputs clone. */
const PROTOTYPE_POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const inputError = (flagName: string): CliUsageError =>
  new CliUsageError(`'--${flagName}' must be one dense JSON array of at most ${MAX_INPUT_ITEMS} plain-data objects`);

/**
 * Read one `--save-inputs` / `--adopt-inputs` value into a dense, deeply
 * cloned, getter-free plain array, or `undefined` when the flag is absent.
 * Cost bounds: the JSON text is length-capped before `JSON.parse`, the array
 * length is capped at 64, and the clone is capped at depth 10 and 4096 nodes,
 * so no hostile input can scale any loop past its bound. A revoked `Proxy` or
 * a throwing trap surfaces as a `CliUsageError`, never an unhandled exception,
 * and no message ever carries the raw value.
 */
function readCliInputsArray(raw: unknown, flagName: string): unknown[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    // The O(1) length test runs before the parse, so hostile bulk is refused
    // without any parse work.
    if (raw.length > MAX_INPUT_JSON_BYTES) {
      throw new CliUsageError(`'--${flagName}' exceeds the ${MAX_INPUT_JSON_BYTES}-character JSON limit`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliUsageError(`'--${flagName}' is not valid JSON`);
    }
    return readBoundedDenseArray(parsed, flagName);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw inputError(flagName);
  }
  return readBoundedDenseArray(raw, flagName);
}

/** One dense array read and cloned with the shared bounds; arrays and objects recurse through the same checks. */
function readBoundedDenseArray(value: unknown, flagName: string): unknown[] {
  try {
    if (!Array.isArray(value)) throw inputError(flagName);
    return cloneDenseArray(value, 0, { nodes: MAX_INPUT_NODES }, flagName);
  } catch (error) {
    throw error instanceof CliUsageError ? error : inputError(flagName);
  }
}

function cloneDenseArray(
  value: readonly unknown[],
  depth: number,
  budget: { nodes: number },
  flagName: string,
): unknown[] {
  if (depth >= MAX_INPUT_DEPTH) throw inputError(flagName);
  // Every descriptor inspection below is reached only through the
  // entry-point try/catch: a revoked Proxy or a throwing trap is a usage
  // error, never an exception, and no getter ever runs.
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_INPUT_ITEMS
  ) {
    throw inputError(flagName);
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(value)) {
    // A symbol key, a prototype-polluting key or any own key that is not one
    // canonical array index or `length` is refused before any element is read.
    if (typeof key !== 'string' || PROTOTYPE_POLLUTING_KEYS.includes(key)) throw inputError(flagName);
    if (key === 'length') continue;
    if (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= length) throw inputError(flagName);
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const elementDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    // A hole (no own index) and an accessor are refused without invoking any getter.
    if (
      elementDescriptor === undefined ||
      elementDescriptor.get !== undefined ||
      elementDescriptor.set !== undefined
    ) {
      throw inputError(flagName);
    }
    out.push(clonePlainData(elementDescriptor.value, depth + 1, budget, flagName));
  }
  return out;
}

/** Recursively clone plain data only; everything else is refused, getters never run. */
function clonePlainData(value: unknown, depth: number, budget: { nodes: number }, flagName: string): unknown {
  // The node budget bounds the whole clone regardless of shape: every
  // primitive, array and object consumes one unit, so the total work is capped.
  if (budget.nodes <= 0) throw inputError(flagName);
  budget.nodes -= 1;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  // `undefined`, `symbol`, `bigint`, `function` and every other kind is refused.
  if (typeof value !== 'object') throw inputError(flagName);
  if (Array.isArray(value)) return cloneDenseArray(value, depth, budget, flagName);
  if (depth >= MAX_INPUT_DEPTH) throw inputError(flagName);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw inputError(flagName);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || PROTOTYPE_POLLUTING_KEYS.includes(key)) throw inputError(flagName);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw inputError(flagName);
    }
    out[key] = clonePlainData(descriptor.value, depth + 1, budget, flagName);
  }
  return out;
}

/** Derives the digest-bound `relaunch:apply` grant coordinates for one stored plan. */
async function requestGrant(p: Payload): Promise<unknown> {
  if (typeof p['planDigest'] !== 'string' || !PLAN_DIGEST_PATTERN.test(p['planDigest'])) {
    throw new CliUsageError("request-grant: '--plan-digest' must be a 64-lowercase-hex plan digest");
  }
  const planDigest = p['planDigest'];
  if (typeof p['policyRevision'] !== 'string' || !POLICY_REVISION_PATTERN.test(p['policyRevision'])) {
    throw new CliUsageError(
      "'--policy-revision' must be 1-128 characters of letters, digits or . _ : / @ - (the value is never echoed)",
    );
  }
  const policyRevision = p['policyRevision'];
  const createdAtIso = supplied(p, 'now') ? p['now'] : new Date().toISOString();
  if (typeof createdAtIso !== 'string' || !isStrictIsoInstant(createdAtIso)) {
    throw new CliUsageError("'--now' must be a strict ISO-8601 UTC instant");
  }
  // Cost bound: one sha256 over a short fixed payload — linear in its length,
  // which the three bounded fields above cap.
  const requestId =
    RELAUNCH_APPLY_DIGEST_PREFIX +
    createHash('sha256')
      .update(
        relaunchApplyDigestPayload({
          projectId: RELAUNCH_APPLY_PROJECT_ID,
          proposalDigest: planDigest,
          createdAtIso,
        }),
      )
      .digest('hex');
  const grantId = `grant-${requestId}`;
  return {
    outcome: 'ready',
    requestId,
    grantId,
    planDigest,
    createdAtIso,
    requestCommand: `fleet-v2 coordination request-decision --request-id ${requestId} --project-id relaunch --kind action-decision --action-scope ${RELAUNCH_APPLY_ACTION_SCOPE} --proposal-digest ${planDigest} --policy-revision ${policyRevision} --now-iso ${createdAtIso}`,
    signCommand: `fleet-v2 coordination sign-decision --request ${requestId} --answer approve --key <path> --yes`,
    resolveCommand: `fleet-v2 coordination resolve-auth --project-id relaunch --action-scope ${RELAUNCH_APPLY_ACTION_SCOPE} --proposal-digest ${planDigest} --authorization-grant-id ${grantId}`,
  };
}

/** Applies (or dry-runs) one stored relaunch plan by digest, under an owner grant when `--apply`. */
async function applyRelaunchCommand(p: Payload, rt: FleetCliRuntime): Promise<unknown> {
  if (supplied(p, 'planDigest') && typeof p['planDigest'] !== 'string') {
    throw new CliUsageError("'--plan-digest' must be a string");
  }
  const planDigest = str(p, 'planDigest');
  const applyRaw = p['apply'];
  let applyFlag = false;
  if (applyRaw !== undefined) {
    if (applyRaw === true || applyRaw === 'true') applyFlag = true;
    else if (applyRaw === false || applyRaw === 'false') applyFlag = false;
    else throw new CliUsageError("'--apply' takes true or false");
  }
  let grantId: string | undefined;
  if (applyFlag) {
    if (supplied(p, 'grant') && typeof p['grant'] !== 'string') {
      // Never echo the value: a mistyped grant may carry secret-shaped text.
      throw new CliUsageError("'--grant' must be a string");
    }
    grantId = optStr(p, 'grant');
  }
  if (supplied(p, 'now') && typeof p['now'] !== 'string') {
    throw new CliUsageError("'--now' must be a string");
  }
  const nowIso = supplied(p, 'now') ? (p['now'] as string) : new Date().toISOString();
  if (supplied(p, 'deadline') && typeof p['deadline'] !== 'string') {
    throw new CliUsageError("'--deadline' must be a string");
  }
  const deadlineIso = supplied(p, 'deadline') ? (p['deadline'] as string) : undefined;
  const saveInputs = readCliInputsArray(p['saveInputs'], 'save-inputs');
  const adoptInputs = readCliInputsArray(p['adoptInputs'], 'adopt-inputs');
  return rt.execution.applyRelaunch.applyRelaunch({
    planDigest,
    apply: applyFlag,
    ...(grantId !== undefined ? { grantId } : {}),
    ...(saveInputs !== undefined ? { saveInputs } : {}),
    ...(adoptInputs !== undefined ? { adoptInputs } : {}),
    nowIso,
    ...(deadlineIso !== undefined ? { deadlineIso } : {}),
  });
}

export const relaunchCommands: Readonly<Record<string, CommandHandler>> = {
  inventory: async (p, rt) => {
    const hostName = optStr(p, 'host') ?? null;
    const clones = await activeClones(hostName, rt);
    if (clones === null) return UNREADABLE;
    return rt.execution.inventoryRelaunch.inventoryRelaunch({
      nowIso: new Date().toISOString(),
      hostName,
      clones,
    });
  },
  plan: async (p, rt) => {
    const hostName = optStr(p, 'host') ?? null;
    const clones = await activeClones(hostName, rt);
    if (clones === null) return PROFILES_UNREADABLE;
    return rt.execution.planRelaunch.planRelaunch({
      nowIso: optStr(p, 'now') ?? new Date().toISOString(),
      hostName,
      clones,
      ...(supplied(p, 'maxActiveRuns') ? { maxActiveRuns: coerceInteger(p.maxActiveRuns) as number } : {}),
      ...(supplied(p, 'dispatchStaggerMs') ? { dispatchStaggerMs: coerceInteger(p.dispatchStaggerMs) as number } : {}),
      ...(supplied(p, 'deadline') ? { deadlineIso: p.deadline as string } : {}),
    });
  },
'request-grant': requestGrant,
  apply: applyRelaunchCommand,
};
