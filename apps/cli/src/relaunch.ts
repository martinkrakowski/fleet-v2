/**
 * The `relaunch` command group (cutover plan CO26, CO29a): the read-only
 * `relaunch inventory` and `relaunch plan`. The inventory reports, per lane
 * host, the registered clones' worktree listing, the runner's state per
 * worktree directory, the conductor's status and each lane's population
 * (conducted, attempt-recorded, unrecorded); its risk flags are counts only
 * and the worktree paths are printed here, in the local CLI output. The plan
 * orders the relaunch of those lanes and stores one immutable plan by digest;
 * its output carries ids, counts, digests and fixed codes, never a path. Both
 * stop, abort, adopt and dispatch nothing and mutate no worktree.
 *
 * AR3c2 adds the apply side: `relaunch apply` (dry-run by default, one live
 * wave under an owner grant with `--apply --grant`), and `relaunch
 * request-grant`, which derives the digest-bound owner grant request and
 * prints the two coordination commands that record and approve it. Both
 * refuse hostile flag payloads at this boundary as usage errors (exit 2).
 */

import { CliUsageError, optStr, type CommandHandler, type Payload } from './commands/payload.js';
import type { FleetCliRuntime } from './composition.js';
import {
  MAX_RELAUNCH_APPLY_LANES,
  readBoundedDenseArray,
  sha256HexDigest,
} from '@fleet/work-execution';
import {
  isStrictIsoInstant,
  RELAUNCH_APPLY_ACTION_SCOPE,
  RELAUNCH_APPLY_DIGEST_PREFIX,
  RELAUNCH_APPLY_PROJECT_ID,
  relaunchApplyDigestPayload,
} from '@fleet/operator-coordination';
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
// AR3c2: hostile-input gates for `relaunch apply` and `relaunch request-grant`.
// Every read below goes through own property descriptors, so no getter or
// Proxy `get` trap ever runs; each check's cost bound is stated with it.
// ---------------------------------------------------------------------------

/** Own keys whose presence would reach `Object.prototype` or constructors. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The `--save-inputs`/`--adopt-inputs` JSON document cap, before `JSON.parse`. */
const MAX_INPUT_JSON_CHARS = 2 * 1024 * 1024;

/** The `--plan-digest` shape both commands require. */
const PLAN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** `--policy-revision`'s bound: printable ASCII only, never a control character. */
const POLICY_REVISION_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Snapshot one untrusted payload object through its own property descriptors:
 * an `O(1)` prototype pre-gate (a non-plain prototype is refused before any
 * key is read), one `O(K)` `Reflect.ownKeys` walk (the accepted engine bound,
 * BL06a — no count-only primitive exists), and one descriptor read per own
 * key, each refusing an accessor so a getter is never invoked. Prototype-
 * polluting own keys are refused before their values are read.
 */
function plainPayloadSnapshot(p: unknown, label: string): Payload {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    throw new CliUsageError(`${label} requires a plain object payload`);
  }
  let prototype: unknown;
  let ownKeys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(p);
    ownKeys = Reflect.ownKeys(p);
  } catch {
    throw new CliUsageError(`${label} payload is not a plain object`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CliUsageError(`${label} requires a plain object payload`);
  }
  const snapshot: Payload = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || POLLUTING_KEYS.has(key)) {
      throw new CliUsageError(`${label} payload carries a refused own key`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(p, key);
    } catch {
      throw new CliUsageError(`${label} payload is not a plain object`);
    }
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new CliUsageError(`${label} payload carries an accessor, not data`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** One strict string flag read from an already-snapshotted payload: never a coerced non-string. */
function strictStr(p: Payload, key: string): string | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  return value;
}

/**
 * Parse one `--save-inputs`/`--adopt-inputs` value into a dense, bounded
 * array. Absent stays absent. A string is length-capped (`O(1)`), parsed in
 * `try/catch`, and refused when it names a prototype-polluting object key;
 * the parsed value then goes through `readBoundedDenseArray`, whose own cost
 * is the `O(1)` length/prototype/descriptor pre-gate, the accepted `O(K)`
 * `Reflect.ownKeys` engine bound, and one descriptor copy per element bounded
 * by `MAX_RELAUNCH_APPLY_LANES` (512). Never echoes the value.
 */
export function parseInputsArray(
  raw: unknown,
  flagName: '--save-inputs' | '--adopt-inputs',
): readonly unknown[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new CliUsageError(`${flagName} requires one JSON array document`);
  }
  // O(1) length cap before any parse: an enormous document is refused here.
  if (raw.length > MAX_INPUT_JSON_CHARS) {
    throw new CliUsageError(`${flagName} exceeds the JSON document size limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CliUsageError(`${flagName} is not valid JSON`);
  }
  // The raw document is searched, not the parsed value: a polluting object
  // key is refused by name before anything is read from the parse result.
  if (/["'](?:__proto__|constructor|prototype)["']\s*:/.test(raw)) {
    throw new CliUsageError(`${flagName} carries a refused object key`);
  }
  const dense = readBoundedDenseArray(parsed, MAX_RELAUNCH_APPLY_LANES);
  if (dense === null) {
    throw new CliUsageError(
      `${flagName} requires a dense JSON array of at most ${MAX_RELAUNCH_APPLY_LANES} items`,
    );
  }
  return dense.array;
}

/** The optional `--apply` switch: only the boolean spellings pass; anything else supplied is a usage error. */
function parseApplyFlag(p: Payload): boolean {
  if (!Object.hasOwn(p, 'apply') || p.apply === undefined) return false;
  if (p.apply === true || p.apply === 'true') return true;
  if (p.apply === false || p.apply === 'false') return false;
  throw new CliUsageError('relaunch apply: --apply takes no value other than true or false');
}

/** The required `--grant <id>`: present must be a non-empty string; the value is never echoed. */
function parseGrantFlag(p: Payload): string | undefined {
  if (!Object.hasOwn(p, 'grant') || p.grant === undefined) return undefined;
  if (typeof p.grant !== 'string' || p.grant.trim() === '') {
    throw new CliUsageError('relaunch apply: --grant requires a non-empty id');
  }
  return p.grant;
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
  /**
   * AR3c2: the live relaunch apply. The payload is snapshotted through its
   * own descriptors before any field is read, so a getter or a lying Proxy
   * trap is a usage error (exit 2), never an invocation; every flag parse
   * below refuses its hostile shape without echoing `--grant`,
   * `--save-inputs` or `--adopt-inputs` contents.
   */
  apply: async (p, rt) => {
    const snapshot = plainPayloadSnapshot(p, 'relaunch apply');
    const planDigest = strictStr(snapshot, 'planDigest');
    if (planDigest === undefined || !PLAN_DIGEST_PATTERN.test(planDigest)) {
      throw new CliUsageError('relaunch apply requires --plan-digest <64 hex>');
    }
    const apply = parseApplyFlag(snapshot);
    const grantId = parseGrantFlag(snapshot);
    const nowIso = optStr(snapshot, 'now') ?? new Date().toISOString();
    const deadlineIso = optStr(snapshot, 'deadline');
    const saveInputs = parseInputsArray(snapshot.saveInputs, '--save-inputs');
    const adoptInputs = parseInputsArray(snapshot.adoptInputs, '--adopt-inputs');
    return rt.execution.applyRelaunch.applyRelaunch({
      planDigest,
      apply,
      ...(grantId !== undefined ? { grantId } : {}),
      nowIso,
      ...(deadlineIso !== undefined ? { deadlineIso } : {}),
      ...(saveInputs !== undefined ? { saveInputs } : {}),
      ...(adoptInputs !== undefined ? { adoptInputs } : {}),
    });
  },
  /**
   * AR3c2: derive the relaunch-apply owner grant's request and print the two
   * commands that record it and carry the owner's approval. Nothing is
   * recorded here: the request id is the digest of the exact coordinates, so
   * `coordination request-decision` accepts it only when every coordinate
   * agrees.
   */
  'request-grant': async (p) => {
    const snapshot = plainPayloadSnapshot(p, 'relaunch request-grant');
    const planDigest = strictStr(snapshot, 'planDigest');
    if (planDigest === undefined || !PLAN_DIGEST_PATTERN.test(planDigest)) {
      throw new CliUsageError('relaunch request-grant requires --plan-digest <64 hex>');
    }
    const createdAtIso = optStr(snapshot, 'now') ?? new Date().toISOString();
    if (!isStrictIsoInstant(createdAtIso)) {
      throw new CliUsageError('relaunch request-grant: --now requires a strict ISO-8601 UTC instant');
    }
    const policyRevision = optStr(snapshot, 'policyRevision') ?? 'pol-1';
    if (!POLICY_REVISION_PATTERN.test(policyRevision)) {
      throw new CliUsageError('relaunch request-grant: --policy-revision requires 1-128 printable characters');
    }
    const requestId = `${RELAUNCH_APPLY_DIGEST_PREFIX}${sha256HexDigest(
      relaunchApplyDigestPayload({
        projectId: RELAUNCH_APPLY_PROJECT_ID,
        proposalDigest: planDigest,
        createdAtIso,
      }),
    )}`;
    const requestCommand =
      `fleet-v2 coordination request-decision --request-id ${requestId}` +
      ` --project-id ${RELAUNCH_APPLY_PROJECT_ID} --kind action-decision` +
      ` --action-scope ${RELAUNCH_APPLY_ACTION_SCOPE} --proposal-digest ${planDigest}` +
      ` --policy-revision ${policyRevision} --now-iso ${createdAtIso}`;
    // Literal shape: `--answer approved` is refused by `parseSignDecisionInput`,
    // so the operator is never handed an answer the signer would decline.
    const signCommand =
      `fleet-v2 coordination sign-decision --request ${requestId}` +
      ` --answer approve --key <path> --yes`;
    return {
      outcome: 'prepared',
      requestId,
      projectId: RELAUNCH_APPLY_PROJECT_ID,
      kind: 'action-decision',
      actionScope: RELAUNCH_APPLY_ACTION_SCOPE,
      proposalDigest: planDigest,
      policyRevision,
      createdAtIso,
      requestCommand,
      signCommand,
    };
  },
};
