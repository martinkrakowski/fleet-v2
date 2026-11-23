/**
 * ResolveActionAuthorizationUseCase implements ResolveActionAuthorizationPort. It
 * returns an applicable grant from approved policy or from a verified scoped
 * decision, and returns a blocked reason for everything else.
 *
 * Absence of a grant is never an authorization. The recorded request must be
 * approved, carry a grant bound to a decision revision, match the exact action
 * scope and expected commit that is being attempted, and still be unconsumed.
 * When a decision transport is supplied, a request that is still awaiting its
 * decision is refreshed once from that verified answer before the checks run;
 * a pending, declined or ambiguous answer leaves the action blocked. Without a
 * grant id, only an owner request recorded at the requested head may apply; a
 * policy grant is resolved only by its id.
 */

import { isPolicyGrantRecord } from '../../domain/policy-grants.js';
import {
  GRANT_RECORD_VERSION,
  isReleaseActionScope,
  readReleaseRoot,
  readReleaseNonce,
  releaseRootsAgree,
  isShadowImportActionScope,
  isRelaunchApplyActionScope,
  isStrictIsoInstant,
  relaunchApplyDigestPayload,
  RELAUNCH_APPLY_DIGEST_PREFIX,
  isSignedDecisionRequired,
  releaseGrantDigestPayload,
  RELEASE_GRANT_DIGEST_PREFIX,
  RELAUNCH_APPLY_ACTION_SCOPE,
  RELAUNCH_APPLY_GRANT_MAX_TTL_DAYS,
  RELAUNCH_APPLY_PROJECT_ID,
  SHADOW_IMPORT_ACTION_SCOPE,
  SHADOW_IMPORT_DIGEST_PREFIX,
  shadowImportDigestPayload,
  verifySignedDecisionBinding,
} from '../../domain/coordination-records.js';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { readPlainObjectLoose } from '../../domain/record-input.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import type {
  ResolveActionAuthorizationPort,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../ports/in/ResolveActionAuthorizationPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { CoordinationRequestRevisionConflictError } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { AttemptFactsReadPort } from '../ports/out/AttemptFactsReadPort.out-port.js';
import type { DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';

export interface ResolveActionAuthorizationDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly decisionTransport?: DecisionTransportPort;
  /** CO24f: reads the attempt facts a first bind validates against; binding fails closed without it. */
  readonly attemptFactsRead?: AttemptFactsReadPort;
  /**
   * The SHA-256 digest a shadow import grant's request id is bound by.
   * Injected, so the application layer stays free of `node:crypto`; a shadow
   * resolve without it fails closed, never silently skips the digest check.
   */
  readonly computeDigest?: (payload: string) => string;
  /**
   * The trusted clock the shadow import grant's expiry is measured against.
   * Injected by the composition root, never taken from the resolve request:
   * a caller-supplied `nowIso` could backdate the clock past expiry. Ordinary
   * (non-shadow) resolves keep exactly their main behaviour and never
   * consult this clock or the digest.
   */
  readonly shadowImportClock?: { readonly nowIso: () => string };
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Enormous-input bounds for the relaunch-apply resolve. A legitimate request
 * carries a project id of at most a handful of characters and a grant handle
 * well under this cap; anything longer cannot match and is refused with a
 * length test — O(1) — before any unbounded `.trim()` copy or scan runs, so
 * the whole resolve stays O(1) in the input size.
 */
const MAX_RELAUNCH_PROJECT_ID_LENGTH = 64;
const MAX_RELAUNCH_GRANT_ID_LENGTH = 256;

/**
 * Prototype-polluting own keys. A request body carrying any of these as an own
 * property (as `JSON.parse('{"__proto__":{...}}')` produces) is refused with a
 * typed `invalid-request` result — never copied onto any snapshot object, so
 * `Object.prototype` can never be reached, let alone mutated.
 */
const PROTOTYPE_POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

// A plain object that carries an own `length` or own index key is an
// array-like disguised as a record; the relaunch reader refuses it with two
// O(1) descriptor reads (never a key walk).
const ARRAY_LIKE_KEYS: readonly string[] = ['length', '0'];


/**
 * The fixed field names the relaunch-apply resolve reads. The relaunch path
 * never enumerates the request: each field is read by name with exactly one
 * `Object.getOwnPropertyDescriptor` call — O(1) per field, four fields, so the
 * whole read is O(1) regardless of how many other own keys the request body
 * carries, and no key list is ever materialized.
 */
const RELAUNCH_REQUEST_FIELDS: readonly string[] = [
  'actionScope',
  'projectId',
  'authorizationGrantId',
  'proposalDigest',
];

/**
 * Enormous-input bound for the descriptor-safe request snapshot: at most this
 * many own keys are ever copied. Every legitimate request carries a fixed
 * handful of fields, so a body carrying more own keys than this is hostile
 * bulk; refusing it at the cap keeps the snapshot — and every resolve path
 * that reads it, the relaunch-apply one included — O(1) in the input size.
 */
const MAX_SNAPSHOT_OWN_KEYS = 32;

function blocked(reason: string): ResolveActionAuthorizationResult {
  return { outcome: 'blocked', reason };
}

/**
 * A descriptor-safe snapshot of the request's nested `repository`. A nested
 * plain object is copied with own data descriptors only (no getter ever runs,
 * so an accessor on `repository.owner` or `repository.repo` collapses to
 * `undefined` and is refused later as an invalid repository); anything the
 * reader cannot snapshot descriptor-safely becomes `null`, which
 * `resolveTargetRepository` refuses. A string `owner/repo` coordinate is not
 * an object and passes through for the later validation.
 */
function snapshotRepository(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  try {
    return readPlainObjectLoose(value);
  } catch {
    return null;
  }
}

/**
 * BL02g fix round: snapshots the request with EXACTLY ONE own-descriptor read
 * per snapshotted field, so both the accessor refusal and the snapshotted
 * value derive from the same single descriptor and a Proxy cannot report an
 * accessor descriptor on the snapshot read and a data descriptor on a second
 * inspection (TOCTOU). An own accessor (a getter OR a setter) on ANY snapshotted
 * field — required or optional (`resumeActionId`, `releaseRoot`,
 * `repository`, `pullRequestNumber`, `attemptId`, every field) — is refused,
 * because a set-only accessor snapshots to `undefined` exactly like an
 * omitted field and would otherwise silently read as absent (a release retry
 * could skip its resumable grant and fall through to an unrelated approved
 * grant). Absence (no own property at all) stays absent and still resolves as
 * before. Inspecting a descriptor never runs a getter, a setter or a `get`
 * trap. The snapshot shape is `readPlainObjectLoose`'s (unknown keys copied,
 * null-prototype, symbol keys and a non-plain prototype refused as null); an
 * own-key count past `MAX_SNAPSHOT_OWN_KEYS` is refused as null too, so no
 * hostile bulk can make the snapshot loop cost proportional to its size.
 * A trap that throws propagates and the caller turns it into the same typed
 * refusal. Returns the snapshot plus the first accessor-carrying field name,
 * or null when every snapshotted field is plain data.
 */
function readRequestSnapshot(
  input: object,
  preRead?: { readonly key: string; readonly descriptor: PropertyDescriptor | undefined },
): RequestSnapshotRead {
  if (Array.isArray(input)) {
    return refusedSnapshot();
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return refusedSnapshot();
  }
  // Prototype-polluting own keys are refused outright: a request body that
  // carries `__proto__` (or `constructor`/`prototype`) as an own property is
  // hostile bulk, and the hostile-input rules require it to be refused with a
  // typed result — copying it onto a null-prototype snapshot would leave the
  // key readable on the snapshot and one spread away from pollution.
  const polluting = firstOwnKeyAmong(input, PROTOTYPE_POLLUTING_KEYS);
  if (polluting !== null) {
    return refusedSnapshot({ pollutingKey: polluting });
  }
  return copyRequestSnapshotFields(input, preRead);
}

type RequestSnapshotRead = {
  snapshot: Record<string, unknown> | null;
  accessorField: string | null;
  keyBoundExceeded: boolean;
  pollutingKey: string | null;
};

function refusedSnapshot(
  overrides: { readonly keyBoundExceeded?: boolean; readonly pollutingKey?: string } = {},
): RequestSnapshotRead {
  return {
    snapshot: null,
    accessorField: null,
    keyBoundExceeded: overrides.keyBoundExceeded ?? false,
    pollutingKey: overrides.pollutingKey ?? null,
  };
}

/** The first of `keys` that `input` carries as an own property, or null; one descriptor read per key. */
function firstOwnKeyAmong(input: object, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (Object.getOwnPropertyDescriptor(input, key) !== undefined) {
      return key;
    }
  }
  return null;
}

/**
 * EXACTLY ONE descriptor read per snapshotted field: a field whose descriptor
 * was already read once by the O(1) routing read is reused, never consulted a
 * second time.
 */
function readSnapshotDescriptor(
  input: object,
  key: string,
  preRead: { readonly key: string; readonly descriptor: PropertyDescriptor | undefined } | undefined,
): PropertyDescriptor | undefined {
  return preRead !== undefined && key === preRead.key
    ? preRead.descriptor
    : Object.getOwnPropertyDescriptor(input, key);
}

function copyRequestSnapshotFields(
  input: object,
  preRead: { readonly key: string; readonly descriptor: PropertyDescriptor | undefined } | undefined,
): RequestSnapshotRead {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let accessorField: string | null = null;
  // Enormous-input bound: a legitimate request carries a fixed handful of own
  // fields; a body with more own keys than this cap is hostile bulk whose only
  // possible effect is to make the snapshot loop itself cost O(input size).
  // Counting to the cap is O(1), and exceeding it is the same typed refusal
  // every other hostile shape gets, on every path that reads the snapshot.
  let ownKeyCount = 0;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') {
      return refusedSnapshot();
    }
    if (ownKeyCount >= MAX_SNAPSHOT_OWN_KEYS) {
      return refusedSnapshot({ keyBoundExceeded: true });
    }
    ownKeyCount += 1;
    const descriptor = readSnapshotDescriptor(input, key, preRead);
    if (descriptor === undefined || !descriptor.enumerable) {
      return refusedSnapshot();
    }
    if (accessorField === null && (descriptor.get !== undefined || descriptor.set !== undefined)) {
      accessorField = key;
    }
    out[key] = descriptor.value;
  }
  return { snapshot: out, accessorField, keyBoundExceeded: false, pollutingKey: null };
}

/**
 * AR3a fix round 2: reads the relaunch-apply request's fixed fields WITHOUT
 * enumerating the body. Cost bound: O(1) — a fixed handful of named
 * `Object.getOwnPropertyDescriptor` calls (four request fields plus the
 * prototype-polluting key names), each of which is a single hash lookup; no
 * key list is ever materialized and no per-key loop ever runs, so the read
 * cost never scales with the number of own keys the body carries. Extra own
 * keys beyond the fixed fields are simply never read: nothing copies them,
 * nothing spreads the request, so hostile bulk is inert by construction
 * rather than counted.
 *
 * An own accessor (getter or setter) on any relaunch field, or a
 * non-enumerable own field, is refused with null — the same typed
 * `invalid-request` refusal the descriptor-safe snapshot gives the other
 * paths. A prototype-polluting own key (`__proto__`, `constructor`,
 * `prototype`) is refused with null too, so a relaunch-apply request that
 * carries one can never authorize. A trap that throws propagates; the caller
 * turns it into the same typed refusal.
 */
function readRelaunchRequestFields(
  input: object,
): {
  actionScope: unknown;
  projectId: unknown;
  authorizationGrantId: unknown;
  proposalDigest: unknown;
} | null {
  if (firstOwnKeyAmong(input, PROTOTYPE_POLLUTING_KEYS) !== null) {
    return null;
  }
  if (firstOwnKeyAmong(input, ARRAY_LIKE_KEYS) !== null) {
    return null;
  }
  const fields: Record<string, unknown> = {};
  for (const field of RELAUNCH_REQUEST_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (descriptor === undefined) {
      fields[field] = undefined;
      continue;
    }
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    fields[field] = descriptor.value;
  }
  return fields as {
    actionScope: unknown;
    projectId: unknown;
    authorizationGrantId: unknown;
    proposalDigest: unknown;
  };
}

/**
 * Cost bound: O(1) — a fixed count of field reads and one bounded 64-hex
 * pattern test; nothing scales with input size. Every string field is
 * length-checked against its enormous-input bound BEFORE it is trimmed or
 * pattern-tested, so hostile bulk is refused by a constant-time length test,
 * never by work proportional to its size. The grant id and the plan digest
 * are non-secret handles, but neither is ever echoed into a refusal reason.
 */
function checkRelaunchRequestFields(
  request: ResolveActionAuthorizationRequest,
):
  | { readonly ok: true; readonly grantId: string }
  | { readonly ok: false; readonly block: ResolveActionAuthorizationResult } {
  if (
    typeof request.projectId !== 'string' ||
    request.projectId.length > MAX_RELAUNCH_PROJECT_ID_LENGTH ||
    !isFilled(request.projectId) ||
    request.projectId.trim() !== RELAUNCH_APPLY_PROJECT_ID
  ) {
    return { ok: false, block: blocked('grant-wrong-project') };
  }
  if (
    typeof request.authorizationGrantId !== 'string' ||
    request.authorizationGrantId.length > MAX_RELAUNCH_GRANT_ID_LENGTH ||
    !isFilled(request.authorizationGrantId)
  ) {
    return { ok: false, block: blocked('grant-missing') };
  }
  if (
    typeof request.proposalDigest !== 'string' ||
    request.proposalDigest.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(request.proposalDigest)
  ) {
    return { ok: false, block: blocked('invalid-request') };
  }
  return { ok: true, grantId: request.authorizationGrantId.trim() };
}

/** The stored relaunch-apply record must hold the relaunch scope, project and the requested plan digest. */
function checkRelaunchGrantRecord(
  candidate: CoordinationRequest,
  refreshed: CoordinationRequestRecord,
  request: ResolveActionAuthorizationRequest,
): ResolveActionAuthorizationResult | null {
  if (candidate.getActionScope() !== RELAUNCH_APPLY_ACTION_SCOPE || refreshed.expectedHeadSha !== null) {
    return blocked('grant-wrong-scope');
  }
  if (refreshed.projectId !== RELAUNCH_APPLY_PROJECT_ID) {
    return blocked('grant-wrong-project');
  }
  if (refreshed.proposalDigest !== request.proposalDigest) {
    return blocked('grant-digest-mismatch');
  }
  return null;
}

/**
 * The expiry is measured with the trusted clock alone: a request-supplied
 * `nowIso` can never revive an expired grant. The boundary is exclusive —
 * exactly `RELAUNCH_APPLY_GRANT_MAX_TTL_DAYS` days after creation is already
 * expired.
 */
function checkRelaunchExpiry(createdAtIso: string, nowIso: string): ResolveActionAuthorizationResult | null {
  const createdAtMs = Date.parse(createdAtIso);
  const nowMs = Date.parse(nowIso);
  if (!isStrictIsoInstant(createdAtIso)) {
    return blocked('grant-expired');
  }
  if (createdAtMs > nowMs) {
    return blocked('grant-created-in-future');
  }
  if (!Number.isFinite(createdAtMs) || nowMs >= createdAtMs + RELAUNCH_APPLY_GRANT_MAX_TTL_DAYS * 86_400_000) {
    return blocked('grant-expired');
  }
  return null;
}

export class ResolveActionAuthorizationUseCase implements ResolveActionAuthorizationPort {
  constructor(private readonly deps?: ResolveActionAuthorizationDependencies) {}

  async resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<ResolveActionAuthorizationResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ResolveActionAuthorizationUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one: a malformed non-object input (null, undefined, or any
    // primitive where a request object is due) is a typed refusal, never an
    // exception. The exported boundary never throws on hostile input; only
    // the missing required fields of a well-formed object keep main's throw.
    if (typeof input !== 'object' || input === null) {
      return blocked('invalid-request');
    }
    // AR3a fix round 2: the relaunch-apply route is decided and resolved with
    // O(1) named descriptor reads alone — the request body is never
    // enumerated here, so no key list is ever materialized and no per-key
    // work can scale with the body's size. A throwing trap on any descriptor
    // read is a hostile Proxy and a typed refusal, never an exception.
    // The single `actionScope` descriptor read below is REUSED by the
    // snapshot on the non-relaunch paths, so every snapshotted field keeps
    // its exactly-once descriptor consultation.
    let scopeDescriptor: PropertyDescriptor | undefined;
    try {
      if (!Array.isArray(input)) {
        const prototype = Object.getPrototypeOf(input);
        if (prototype === Object.prototype || prototype === null) {
          scopeDescriptor = Object.getOwnPropertyDescriptor(input, 'actionScope');
          if (
            scopeDescriptor !== undefined &&
            (!scopeDescriptor.enumerable ||
              scopeDescriptor.get !== undefined ||
              scopeDescriptor.set !== undefined)
          ) {
            return blocked('invalid-request');
          }
          const scopeValue = scopeDescriptor === undefined ? undefined : scopeDescriptor.value;
          if (typeof scopeValue === 'string' && isRelaunchApplyActionScope(scopeValue.trim())) {
            const relaunchFields = readRelaunchRequestFields(input);
            if (relaunchFields === null) {
              return blocked('invalid-request');
            }
            return this.resolveRelaunchApply(
              relaunchFields as unknown as ResolveActionAuthorizationRequest,
            );
          }
        }
      }
    } catch {
      return blocked('invalid-request');
    }
    // Standing shadow import grant (owner decision 2026-11-18): the resolve
    // is head-free — the grant is bound by its digest-bound request id, its
    // exact repository and its capped expiry, never by a commit. Its clock is
    // the composition root's alone: any `nowIso` on the request is ignored,
    // and an unwired clock or digest fails closed. Every non-shadow path
    // below keeps exactly its main behaviour.
    // The shadow path reads the request through a descriptor-safe snapshot
    // (no getter ever runs, a hostile accessor or proxy is a typed refusal),
    // so a hostile object can never throw out of the shadow branch.
    // The snapshot is taken FIRST, before any field — including `actionScope` —
    // is read, so no getter on any field (not even the one that routes the
    // request) can run before the request is frozen. A throwing trap during
    // the snapshot is a hostile proxy: a typed refusal, never an exception.
    let snapshot: Record<string, unknown> | null = null;
    let accessorField: string | null = null;
    let keyBoundExceeded = false;
    let pollutingKey: string | null = null;
    try {
      ({ snapshot, accessorField, keyBoundExceeded, pollutingKey } = readRequestSnapshot(input, {
        key: 'actionScope',
        descriptor: scopeDescriptor,
      }));
    } catch {
      return blocked('invalid-request');
    }
    // AR3a fix round 2: a request body carrying a prototype-polluting own key
    // is refused with the typed `invalid-request` answer on every path — the
    // key is never copied onto any snapshot object.
    if (pollutingKey !== null) {
      return blocked('invalid-request');
    }
    // Enormous-input refusal: a body carrying more own keys than the snapshot
    // cap is hostile bulk on every resolve path, and its routing field cannot
    // be trusted to name its own refusal, so the typed `invalid-request`
    // answer comes first, before any scope is read.
    if (keyBoundExceeded) {
      return blocked('invalid-request');
    }
    // BL02g fix round: a set-only accessor is an accessor too — its snapshot
    // value is `undefined` exactly like an omitted field, so it must be
    // refused the same way. Every snapshotted field — required or optional —
    // went through the single descriptor read above, so no field can be
    // missed and no field is read twice: ANY own accessor on ANY field the
    // snapshot copied is a typed `invalid-request` refusal, checked before
    // any field — including the routing `actionScope` — is read. A
    // plain-data request — every ordinary request — reads exactly as before
    // from the snapshot.
    if (snapshot !== null && accessorField !== null) {
      return blocked('invalid-request');
    }
    const scope =
      snapshot !== null && typeof snapshot['actionScope'] === 'string'
        ? (snapshot['actionScope'] as string).trim()
        : '';
    if (isShadowImportActionScope(scope)) {
      if (snapshot === null) {
        return blocked('invalid-request');
      }
      // The nested `repository` is snapshotted with own data descriptors too,
      // so a getter on `repository.owner` or `repository.repo` never runs
      // later in `resolveTargetRepository`: the resolve reads only from the
      // snapshots, never from the original request or its nested object.
      const shadowRequest = {
        ...snapshot,
        repository: snapshotRepository(snapshot['repository']),
      };
      return this.resolveShadowImport(shadowRequest as unknown as ResolveActionAuthorizationRequest);
    }
    if (isRelaunchApplyActionScope(scope)) {
      if (snapshot === null) {
        return blocked('invalid-request');
      }
      // AR3a: the relaunch-apply resolve is head-free like the shadow import
      // one. It reads only the descriptor-safe snapshot — never the original
      // request — so no getter or Proxy trap can run after the freeze.
      return this.resolveRelaunchApply(snapshot as unknown as ResolveActionAuthorizationRequest);
    }
    // Fix round 3 (BL02g): the non-shadow validation reads no field off the
    // original request. The emptiness check and the required-field values come
    // from the descriptor-safe snapshot taken above — a null-prototype object
    // this code built itself, so it is known plain data — and the only reads
    // on `input` are `Object.getOwnPropertyDescriptor` calls, which inspect a
    // descriptor without ever running a getter or a Proxy `get` trap. An own
    // accessor on a required field (a getter or a setter — a set-only accessor
    // snapshots to `undefined` exactly like an omitted field, so it is refused
    // for the same reason) is visible through its descriptor and is
    // refused as invalid-request; a trap throwing during that inspection is a
    // hostile proxy, also a typed refusal. A plain-data request keeps main's
    // exact throw on genuinely missing required fields.
    if (snapshot === null || Object.keys(snapshot).length === 0) {
      // The HTTP boundary's empty body object: the resolve is blocked with
      // its missing coordinates named, never reported as an unimplemented
      // station.
      return blocked(
        'an authorization resolve requires a non-empty projectId, actionScope and expectedHeadSha',
      );
    }
    for (const field of ['projectId', 'actionScope', 'expectedHeadSha'] as const) {
      // BL02g fix round: the accessor check for this field already ran through
      // the single descriptor read in `readRequestSnapshot` above, alongside
      // every other snapshotted field. Only the required-field presence check stays.
      if (!isFilled(snapshot[field])) {
        throw new Error('Not implemented: ResolveActionAuthorizationUseCase');
      }
    }
    // Past the validation every request field this use-case reads has been
    // proved a filled string on the snapshot. `request` is built from the
    // descriptor-safe `snapshot` (with `snapshotRepository` re-snapshotting
    // the nested `repository`), so no later read — `findRecordedRequest`
    // included — ever touches `input` or invokes a `get` trap on it.
    const request = {
      ...snapshot,
      repository: snapshotRepository(snapshot['repository']),
    } as unknown as ResolveActionAuthorizationRequest;
    // BL02g fix round: an own accessor on the optional `releaseRoot` (and on
    // every other optional snapshotted field — `resumeActionId` included) is
    // already refused by the single descriptor read in `readRequestSnapshot`
    // above, so the separate releaseRoot-only inspection is gone. No accessor
    // can survive to the recorded-request lookup.
    const recorded = await this.findRecordedRequest(request);
    if (recorded === null) {
      return blocked(
        request.authorizationGrantId === undefined
          ? `no recorded decision authorizes ${request.actionScope} for ${request.projectId}`
          : `no recorded request holds grant ${request.authorizationGrantId}`,
      );
    }
    // CO14 follow-up: read the stored release root descriptor-safely before
    // anything evaluates the record, so a hostile accessor is a typed refusal.
    if (readReleaseRoot(recorded).state === 'invalid') {
      return blocked('release-grant-root-mismatch');
    }
    const refreshedResult = await this.refreshFromVerifiedAnswer(recorded);
    if (refreshedResult.refusalReason !== undefined) {
      // A pinned owner-key refusal blocks before any grant state is checked.
      return blocked(refreshedResult.refusalReason);
    }
    const refreshed = refreshedResult.record;
    const candidate = CoordinationRequest.fromRecord(refreshed);
    // CO14 follow-up: a release grant already durably consumed by exactly the
    // deterministic action id this resolve names resolves again idempotently,
    // so a crash between the consumption and the release's own write leaves
    // the retry able to recover. Any other consumed grant stays blocked, and
    // a completed record that does not resume is refused like any other
    // non-approving state.
    const resumeActionId = isFilled(request.resumeActionId) ? request.resumeActionId.trim() : undefined;
    const consumptions = candidate.getConsumptions();
    const resumable =
      resumeActionId !== undefined &&
      isReleaseActionScope(candidate.getActionScope()) &&
      consumptions.length === 1 &&
      consumptions[0].actionId === resumeActionId;
    if (!candidate.isApproved() && !resumable) {
      return blocked(
        `recorded request ${candidate.getId()} is ${candidate.getState()}, which does not authorize an action`,
      );
    }
    const grantId = candidate.getGrantId();
    if (grantId === null) {
      return blocked(`recorded request ${candidate.getId()} carries no grant`);
    }
    if (candidate.getDecisionRevision() === null) {
      return blocked(`grant ${grantId} carries no recorded decision revision`);
    }
    if (refreshed.projectId !== request.projectId.trim()) {
      return blocked(`grant ${grantId} belongs to project ${refreshed.projectId}`);
    }
    if (
      !resumable &&
      !candidate.canAuthorizeAction(request.actionScope.trim(), request.expectedHeadSha.trim())
    ) {
      return blocked(
        `grant ${grantId} authorizes ${candidate.getActionScope()} at ${
          candidate.getExpectedHeadSha() ?? 'no commit'
        }, not ${request.actionScope.trim()} at ${request.expectedHeadSha.trim()}`,
      );
    }
    if (
      resumable &&
      (candidate.getActionScope() !== request.actionScope.trim() ||
        candidate.getExpectedHeadSha() !== request.expectedHeadSha.trim())
    ) {
      // A resumed release grant still authorizes only its recorded scope at
      // its recorded head; the resume never widens either.
      return blocked(
        `grant ${grantId} authorizes ${candidate.getActionScope()} at ${
          candidate.getExpectedHeadSha() ?? 'no commit'
        }, not ${request.actionScope.trim()} at ${request.expectedHeadSha.trim()}`,
      );
    }
    // CO14 follow-up: a release grant bound to one root authorizes only an
    // operation on that root. An invalid coordinate on either side fails
    // closed as a mismatch, never as a match.
    const recordedRoot = readReleaseRoot(refreshed);
    const requestedRoot = readReleaseRoot(request);
    if (!releaseRootsAgree(recordedRoot, requestedRoot)) {
      return blocked('release-grant-root-mismatch');
    }
    // RR1: a release grant's root is bound into its request id. A record
    // whose id does not carry the prefix carries an unsigned (pre-RR1) root
    // and fails closed; a prefixed record is re-verified against the digest
    // of its recorded coordinates, so a tampered root can never masquerade
    // behind a valid-looking id.
    if (isReleaseActionScope(candidate.getActionScope())) {
      if (
        recordedRoot.state !== 'valid' ||
        !candidate.getId().startsWith(RELEASE_GRANT_DIGEST_PREFIX)
      ) {
        return blocked('release-grant-digest-mismatch');
      }
      if (this.deps?.computeDigest === undefined) {
        return blocked('digest-unavailable');
      }
      const payloadResult = releaseGrantDigestPayload({
        actionScope: candidate.getActionScope(),
        projectId: refreshed.projectId,
        expectedHeadSha: refreshed.expectedHeadSha ?? '',
        releaseRoot: recordedRoot.value,
        nonce: readReleaseNonce(refreshed),
      });
      const expectedRequestId = payloadResult.ok
        ? `${RELEASE_GRANT_DIGEST_PREFIX}${this.deps.computeDigest(payloadResult.value)}`
        : null;
      if (!payloadResult.ok || candidate.getId() !== expectedRequestId) {
        return blocked('release-grant-digest-mismatch');
      }
    }
    const mergeGrant = candidate.getMergeGrant();
    if (mergeGrant !== null) {
      const targetRepo = this.resolveTargetRepository(request);
      const targetPr = this.resolveTargetPullRequest(request);
      if (
        targetRepo === null ||
        targetPr === null ||
        mergeGrant.repository.owner !== targetRepo.owner ||
        mergeGrant.repository.repo !== targetRepo.repo ||
        mergeGrant.pullRequestNumber !== targetPr
      ) {
        return blocked(
          `grant ${grantId} authorizes ${mergeGrant.repository.owner}/${mergeGrant.repository.repo} pull request ${mergeGrant.pullRequestNumber}`,
        );
      }
    }
    if (candidate.getConsumptions().length > 0 && !resumable) {
      return blocked(`grant ${grantId} is already consumed by another action`);
    }
    // KEY0c2 fix round: the owner-decision signature check runs before
    // `bindAttempt`, because binding persists the attempt onto the grant —
    // an invalid approval must never be able to alter the stored record.
    const signatureBlock = await this.verifyOwnerDecisionForRecord(candidate, refreshed);
    if (signatureBlock !== null) {
      return signatureBlock;
    }
    const attemptBlock = await this.bindAttempt(candidate, refreshed, request, grantId);
    if (attemptBlock !== null) {
      return attemptBlock;
    }
    // KEY0c2: every owner-gated approval is re-bound to a verified signed
    // answer when a decision transport is injected, before anything is
    // authorized. The check runs after every stored-coordinate refusal, so
    // origin/main's exact refusal reasons are preserved.
    return {
      outcome: 'authorized',
      grantId,
      requestId: candidate.getId(),
      expectedHeadSha: request.expectedHeadSha.trim(),
      policyRevision: candidate.getPolicyRevision(),
      ...(recordedRoot.state === 'valid' ? { releaseRoot: recordedRoot.value } : {}),
    };
  }

  /**
   * KEY0c2: when a decision transport is injected, an owner-gated record whose
   * scope is not a closed-kind policy or merge grant is re-read through the
   * transport and bound to the signed answer on EVERY path — including a
   * resumable `completed` release record and any other non-approved state
   * reached through resume — so no stored state can authorize without a
   * signature. Anything the transport reports as awaiting or declined, an
   * owner-key refusal, or a mismatching binding blocks; when no transport is
   * injected the origin/main behaviour is kept exactly. Returns the block, or
   * null when the record may authorize.
   */
  private async verifyOwnerDecisionForRecord(
    candidate: CoordinationRequest,
    refreshed: CoordinationRequestRecord,
  ): Promise<ResolveActionAuthorizationResult | null> {
    const decisionTransport = this.deps?.decisionTransport;
    if (!isSignedDecisionRequired(candidate.toRecord())) {
      return null;
    }
    // KEY0c3: the transport is mandatory for every owner-gated scope. A
    // stored approved record with no transport fails closed — the stored
    // state alone is never authority.
    if (decisionTransport === undefined) {
      return blocked('decision-signature-invalid');
    }
    const answer = await decisionTransport.readDecisionAnswer({
      requestId: refreshed.id,
      projectId: refreshed.projectId,
      actionScope: refreshed.actionScope,
      expectedHeadSha: refreshed.expectedHeadSha,
    });
    // Fix round: a refusal is honoured in EVERY answer state — an approved
    // answer that carries a refusalReason must still block, not authorize.
    if (answer.refusalReason !== undefined) {
      return blocked(answer.refusalReason);
    }
    if (!verifySignedDecisionBinding(refreshed, answer).ok) {
      return blocked('decision-signature-invalid');
    }
    return null;
  }

  /**
   * The explicit head-free resolve path for a standing `merge:import-shadow`
   * grant. The grant is re-checked against its stored coordinates on every
   * resolve: the request-id digest is recomputed from
   * `candidate.getShadowImportGrant()` with the injected digest (a mismatch
   * means the stored coordinates no longer match the id the grant was bound
   * by), and the expiry is measured with the injected clock alone — never a
   * request field, so a caller cannot backdate the clock past expiry. An
   * unwired clock or digest fails closed. Nothing is bound and no
   * consumption is checked: a standing grant resolves until it expires or is
   * revoked.
   */
  private async resolveShadowImport(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    if (!isFilled(request.projectId)) {
      return blocked('project-id-required');
    }
    if (!isFilled(request.authorizationGrantId)) {
      return blocked('grant-missing');
    }
    const grantId = request.authorizationGrantId.trim();
    const requestedRepository = this.resolveTargetRepository(request);
    if (requestedRepository === null) {
      return blocked('grant-wrong-repository');
    }
    const trustedNow = this.readTrustedNow();
    if (!trustedNow.ok) {
      return trustedNow.block;
    }
    const { nowIso } = trustedNow;
    const computeDigest = this.deps?.computeDigest;
    if (computeDigest === undefined) {
      return blocked('digest-unavailable');
    }
    const loaded = await this.loadApprovedHeadFreeGrant(grantId);
    if (!loaded.ok) {
      return loaded.block;
    }
    const { refreshed, candidate } = loaded;
    if (
      candidate.getActionScope() !== SHADOW_IMPORT_ACTION_SCOPE ||
      !candidate.canAuthorizeShadowImport(SHADOW_IMPORT_ACTION_SCOPE)
    ) {
      return blocked('grant-wrong-scope');
    }
    const shadowGrant = candidate.getShadowImportGrant();
    if (shadowGrant === null) {
      return blocked('grant-wrong-scope');
    }
    const payloadResult = shadowImportDigestPayload(shadowGrant);
    const expectedRequestId = payloadResult.ok
      ? `${SHADOW_IMPORT_DIGEST_PREFIX}${computeDigest.call(this.deps, payloadResult.value)}`
      : null;
    if (!payloadResult.ok || candidate.getId() !== expectedRequestId) {
      return blocked('grant-digest-mismatch');
    }
    if (refreshed.projectId !== request.projectId.trim()) {
      return blocked('grant-wrong-project');
    }
    if (
      shadowGrant.repository.owner !== requestedRepository.owner ||
      shadowGrant.repository.repo !== requestedRepository.repo
    ) {
      return blocked('grant-wrong-repository');
    }
    // The expiry is measured with the trusted clock alone: a request-supplied
    // `nowIso` can never revive an expired grant.
    if (Date.parse(nowIso) >= Date.parse(shadowGrant.expiresAtIso)) {
      return blocked('grant-expired');
    }
    // KEY0c2: a standing shadow import grant is also re-bound to a verified
    // signed answer when a decision transport is injected.
    const signatureBlock = await this.verifyOwnerDecisionForRecord(candidate, refreshed);
    if (signatureBlock !== null) {
      return signatureBlock;
    }
    return {
      outcome: 'authorized',
      grantId,
      requestId: candidate.getId(),
      expectedHeadSha: '',
      policyRevision: candidate.getPolicyRevision(),
    };
  }

  /**
   * AR3a: the explicit head-free resolve path for a standing
   * `relaunch:apply` grant. The grant is bound to the plan digest it names —
   * never a commit — to the one `relaunch` project id, and to a short capped
   * expiry of `RELAUNCH_APPLY_GRANT_MAX_TTL_DAYS` days measured with the
   * injected clock alone, never a request field, so a caller cannot backdate
   * the clock past expiry. An unwired clock fails closed. Nothing is bound
   * and no consumption is checked: a standing grant resolves until it expires
   * or is revoked. The grant id and the plan digest are non-secret handles,
   * but neither is ever echoed into a refusal reason.
   */
  private async resolveRelaunchApply(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    const fieldCheck = checkRelaunchRequestFields(request);
    if (!fieldCheck.ok) {
      return fieldCheck.block;
    }
    const { grantId } = fieldCheck;
    const trustedNow = this.readTrustedNow();
    if (!trustedNow.ok) {
      return trustedNow.block;
    }
    const loaded = await this.loadApprovedHeadFreeGrant(grantId);
    if (!loaded.ok) {
      return loaded.block;
    }
    const { refreshed, candidate } = loaded;
    const recordBlock = checkRelaunchGrantRecord(candidate, refreshed, request);
    if (recordBlock !== null) {
      return recordBlock;
    }
    const requestIdBlock = this.checkRelaunchRequestId(refreshed);
    if (requestIdBlock !== null) {
      return requestIdBlock;
    }
    const expiryBlock = checkRelaunchExpiry(refreshed.createdAtIso, trustedNow.nowIso);
    if (expiryBlock !== null) {
      return expiryBlock;
    }
    // A signed owner decision is re-verified before anything is authorized:
    // the stored approved state alone is never authority.
    const signatureBlock = await this.verifyOwnerDecisionForRecord(candidate, refreshed);
    if (signatureBlock !== null) {
      return signatureBlock;
    }
    return {
      outcome: 'authorized',
      grantId,
      requestId: candidate.getId(),
      expectedHeadSha: '',
      policyRevision: candidate.getPolicyRevision(),
    };
  }

  /** The injected clock's strict instant, or the typed refusal; a request field is never the clock. */
  private readTrustedNow():
    | { readonly ok: true; readonly nowIso: string }
    | { readonly ok: false; readonly block: ResolveActionAuthorizationResult } {
    const clock = this.deps?.shadowImportClock;
    if (clock === undefined) {
      return { ok: false, block: blocked('clock-unavailable') };
    }
    const nowIso = clock.nowIso();
    if (!isStrictIsoInstant(nowIso)) {
      return { ok: false, block: blocked('invalid-now-iso') };
    }
    return { ok: true, nowIso };
  }

  /**
   * The shared head-free load: the recorded request for the grant id, refreshed
   * from a verified answer, that is approved and parses as a coordination
   * request; otherwise the typed refusal.
   */
  private async loadApprovedHeadFreeGrant(
    grantId: string,
  ): Promise<
    | { readonly ok: true; readonly refreshed: CoordinationRequestRecord; readonly candidate: CoordinationRequest }
    | { readonly ok: false; readonly block: ResolveActionAuthorizationResult }
  > {
    const recorded = (await this.deps?.requestRepo.findRequestByGrantId(grantId)) ?? null;
    if (recorded === null) {
      return { ok: false, block: blocked('grant-missing') };
    }
    const refreshedResult = await this.refreshFromVerifiedAnswer(recorded);
    if (refreshedResult.refusalReason !== undefined) {
      // A pinned owner-key refusal blocks before any grant state is checked.
      return { ok: false, block: blocked(refreshedResult.refusalReason) };
    }
    const refreshed = refreshedResult.record;
    if (refreshed.state === 'cancelled') {
      return { ok: false, block: blocked('grant-revoked') };
    }
    if (refreshed.state !== 'approved' || refreshed.decisionRevision === null) {
      return { ok: false, block: blocked('grant-not-approved') };
    }
    try {
      return { ok: true, refreshed, candidate: CoordinationRequest.fromRecord(refreshed) };
    } catch {
      return { ok: false, block: blocked('grant-wrong-scope') };
    }
  }

  /**
   * The owner's signature covers the request id, not the plan digest or the
   * creation instant: both are bound by the id's digest, recomputed here from
   * the stored fields, so a store edit of either is refused.
   */
  private checkRelaunchRequestId(refreshed: CoordinationRequestRecord): ResolveActionAuthorizationResult | null {
    const computeDigest = this.deps?.computeDigest;
    if (computeDigest === undefined) {
      return blocked('digest-unavailable');
    }
    const payload = relaunchApplyDigestPayload({
      projectId: refreshed.projectId,
      proposalDigest: refreshed.proposalDigest,
      createdAtIso: refreshed.createdAtIso,
    });
    const expectedRequestId = `${RELAUNCH_APPLY_DIGEST_PREFIX}${computeDigest.call(this.deps, payload)}`;
    return refreshed.id === expectedRequestId ? null : blocked('grant-request-digest-mismatch');
  }

  /**
   * A named grant locates its request directly. Without a grant id, only an
   * owner request recorded at the requested head may apply; a policy grant is
   * resolved only by its id. Nothing is invented when nothing is recorded.
   */
  private async findRecordedRequest(
    request: ResolveActionAuthorizationRequest,
  ): Promise<CoordinationRequestRecord | null> {
    if (isFilled(request.authorizationGrantId)) {
      return this.deps?.requestRepo.findRequestByGrantId(request.authorizationGrantId.trim()) ?? null;
    }
    const recorded = await (this.deps?.requestRepo.listRequests(request.projectId.trim()) ?? []);
    const head = request.expectedHeadSha.trim();
    const resumeActionId = isFilled(request.resumeActionId) ? request.resumeActionId.trim() : undefined;
    const matching = recorded.filter(
      (candidate) =>
        candidate.projectId === request.projectId.trim() &&
        candidate.actionScope === request.actionScope.trim() &&
        candidate.expectedHeadSha === head &&
        !isPolicyGrantRecord(candidate) &&
        this.matchesMergeGrantCoordinates(candidate, request),
    );
    // CO14 follow-up (#4g): when the resolve is a release retry naming the
    // resuming action id, the matching resumable grant is preferred BEFORE
    // any unrelated approved/unconsumed grant, so a crash between the
    // consumption and the release's write can never spend a second grant.
    if (resumeActionId !== undefined && isReleaseActionScope(request.actionScope.trim())) {
      const resumable = matching.filter(
        (candidate) =>
          candidate.state === 'completed' &&
          isReleaseActionScope(candidate.actionScope) &&
          candidate.consumptions.length === 1 &&
          candidate.consumptions[0].actionId === resumeActionId,
      );
      if (resumable.length > 0) {
        return resumable[resumable.length - 1];
      }
    }
    const approved = matching.filter((candidate) => candidate.state === 'approved');
    if (approved.length > 0) {
      return approved[approved.length - 1];
    }
    const awaiting = matching.filter((candidate) => candidate.state === 'awaiting-decision');
    return awaiting.length > 0 ? awaiting[awaiting.length - 1] : null;
  }

  /**
   * CO24e: a grant is bound to one attempt. A resolve that names an attempt must name the
   * grant's recorded one; an owner grant that records none is bound to the first attempt
   * that resolves it, durably, so a later consumption by another attempt at the same head
   * is refused. A version-2 record without an attempt, and an unusable attempt id, block.
   * A merge grant is attempt-less by design (DT6b) and is never bound.
   *
   * CO24g: a resolve that names no attempt cannot authorize an owner grant. An unbound one
   * refuses (`attempt-required`) without binding or consuming, and an already-bound one also
   * refuses, because every caller that resolves a bound owner grant passes its attempt and no
   * anonymous path is needed. Policy grants keep their own recorded attempt and are resolved
   * only by their id, so they stay unaffected. Two grant kinds are attempt-less by design and
   * are exempt by kind, never by a missing attemptId: a merge grant (DT6b), anchored by
   * repository, pull request and head, and a release grant (CO14), anchored by its
   * `release:<action>` scope, exact head and one deterministic consumption.
   */
  private async bindAttempt(
    candidate: CoordinationRequest,
    record: CoordinationRequestRecord,
    request: ResolveActionAuthorizationRequest,
    grantId: string,
  ): Promise<ResolveActionAuthorizationResult | null> {
    if (candidate.isMissingRecordedAttempt()) {
      return blocked('grant-attempt-unrecorded');
    }
    // DT6b: a merge grant is anchored by repository, pull request and head, never by an
    // attempt; it resolves unbound and is never bound.
    if (candidate.getMergeGrant() !== null) {
      return null;
    }
    // CO24g: an unbound release grant is attempt-less by design (cutover row CO14). It is
    // anchored by its exact `release:<action>` scope (only `release:install`,
    // `release:swap` or `release:rollback`) and exact head, and consumed once
    // by its deterministic action id, so it resolves with or without an attempt
    // coordinate and is never bound to a work attempt. A bound release grant is held
    // to its attempt and falls through to the normal checks. The gate is the grant's
    // recorded scope — the grant kind — never the absence of an attemptId, and
    // never an arbitrary `release:*` prefix.
    if (isReleaseActionScope(candidate.getActionScope()) && candidate.getBoundAttemptId() === null) {
      return null;
    }
    if (request.attemptId === undefined) {
      // A policy grant carries its own recorded attempt and resolves only by its id, so it
      // is unaffected by the attempt-required default. Every other grant — an owner grant,
      // bound or not — refuses without the attempt coordinate.
      if (candidate.getPolicyGrant() !== null) {
        return null;
      }
      return blocked('attempt-required');
    }
    if (!isFilled(request.attemptId)) {
      return blocked('grant-attempt-invalid');
    }
    const supplied = request.attemptId.trim();
    const bound = candidate.getBoundAttemptId();
    if (bound !== null) {
      return bound === supplied ? null : blocked('grant-attempt-mismatch');
    }
    // CO24f: an unbound owner grant binds only an attempt that exists, belongs
    // to the grant's project and was collected at the requested head, read
    // through the attempt-facts port. Anything else refuses without binding,
    // so a wrong attempt can never attach to — or kill — the grant.
    const facts = await (this.deps?.attemptFactsRead?.findAttemptFactsById(supplied) ?? null);
    if (facts === null) {
      return blocked('grant-attempt-unknown');
    }
    if (facts.projectId === null || facts.projectId !== record.projectId) {
      return blocked('grant-attempt-foreign');
    }
    if (facts.collectedHeadSha === null) {
      return blocked('grant-attempt-uncollected');
    }
    if (facts.collectedHeadSha !== request.expectedHeadSha.trim()) {
      return blocked('grant-attempt-head-mismatch');
    }
    let binding: CoordinationRequestRecord;
    try {
      binding = CoordinationRequest.fromRecord({
        ...record,
        grantRecordVersion: GRANT_RECORD_VERSION,
        grantAttemptId: supplied,
        revision: candidate.nextRevision(),
        updatedAtIso: new Date().toISOString(),
      }).toRecord();
    } catch {
      return blocked('grant-attempt-invalid');
    }
    try {
      await (this.deps?.requestRepo.saveRequest(binding) ?? Promise.resolve());
    } catch (error: unknown) {
      if (error instanceof CoordinationRequestRevisionConflictError) {
        return blocked(`grant ${grantId} moved while it was being bound to an attempt`);
      }
      throw error;
    }
    return null;
  }

  /**
   * A pending request may have an answer recorded since it was last read.
   * Returns the (possibly refreshed) record plus the answer's named
   * owner-key refusal, if any: the caller blocks on it before any grant
   * state is consulted.
   */
  private async refreshFromVerifiedAnswer(
    record: CoordinationRequestRecord,
  ): Promise<{ readonly record: CoordinationRequestRecord; readonly refusalReason?: string }> {
    const decisionTransport = this.deps?.decisionTransport;
    if (decisionTransport === undefined || record.state !== 'awaiting-decision') {
      return { record };
    }
    const answer = await decisionTransport.readDecisionAnswer({
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
    });
    // A refusalReason on the answer (regardless of its state) means the
    // answer must not be persisted: return the refusal and keep the stored
    // record byte-identical so a later read re-verifies afresh.
    if (answer.refusalReason !== undefined) {
      return { record, refusalReason: answer.refusalReason };
    }
    if (answer.state === 'awaiting-decision') {
      return { record };
    }
    if (answer.state === 'declined') {
      return { record };
    }
    if (answer.state === 'approved' && answer.grantId === null) {
      // An approval without a recorded grant authorizes nothing.
      return { record };
    }
    const refreshed: CoordinationRequestRecord = {
      ...record,
      state: answer.state,
      decisionRevision: answer.decisionRevision,
      grantId: answer.grantId,
      revision: record.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    await (this.deps?.requestRepo.saveRequest(refreshed) ?? Promise.resolve());
    return { record: refreshed };
  }

  private resolveTargetRepository(
    request: ResolveActionAuthorizationRequest,
  ): { owner: string; repo: string } | null {
    if (typeof request.repository === 'object' && request.repository !== null) {
      const { owner, repo } = request.repository as { owner?: unknown; repo?: unknown };
      if (typeof owner === 'string' && typeof repo === 'string' && owner.trim() && repo.trim()) {
        return { owner: owner.trim(), repo: repo.trim() };
      }
    } else if (typeof request.repository === 'string') {
      const parts = request.repository.trim().split('/');
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return { owner: parts[0].trim(), repo: parts[1].trim() };
      }
    }
    return null;
  }

  private resolveTargetPullRequest(request: ResolveActionAuthorizationRequest): number | null {
    const pr = request.pullRequestNumber;
    return typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0 ? pr : null;
  }

  private matchesMergeGrantCoordinates(
    record: CoordinationRequestRecord,
    request: ResolveActionAuthorizationRequest,
  ): boolean {
    if (record.mergeGrant === undefined) {
      return true;
    }
    const targetRepo = this.resolveTargetRepository(request);
    const targetPr = this.resolveTargetPullRequest(request);
    if (targetRepo === null || targetPr === null) {
      return false;
    }
    return (
      record.mergeGrant.repository.owner === targetRepo.owner &&
      record.mergeGrant.repository.repo === targetRepo.repo &&
      record.mergeGrant.pullRequestNumber === targetPr
    );
  }
}
