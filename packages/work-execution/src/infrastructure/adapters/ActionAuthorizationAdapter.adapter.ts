// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * ActionAuthorizationAdapter implements ActionAuthorizationPort by
 * in-process delegation to operator-coordination's authorization
 * contracts, or by enforcing the same rules over a supplied grant map
 * until that wiring lands at the composition root.
 *
 * Head, action-kind and attempt applicability are verified where the
 * request carries those coordinates; consumption then durably binds one
 * grant to exactly one action id — a second unrelated action is refused,
 * while the same action id remains idempotently consumed.
 *
 * Once configured the adapter never throws on runtime input: a malformed
 * request, an unreadable stored grant or a failing delegate is a typed
 * refusal carrying a fixed code, never a caller string, secret or path.
 */

import { LANE_DIFF_SECRET_PATTERNS, readPlainRecord, SECRET_PATTERNS } from '@fleet/shared';

import type {
  ActionAuthorizationPort,
  AuthorizeRelaunchApplyRequest,
  AuthorizeRelaunchApplyResult,
  AuthorizeShadowImportRequest,
  AuthorizeShadowImportResult,
  AuthorizeUnsealedWorktreeRemovalRequest,
  AuthorizeUnsealedWorktreeRemovalResult,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../application/ports/out/ActionAuthorizationPort.out-port.js';
import { readRecordSchemaVersion } from '../../domain/record-schema-version.js';
import { RELEASE_ACTION_KINDS } from '../../domain/coordination-keys.js';

/** The stored grant record version this adapter writes; `1` (or absent) is still read. */
export const ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION = 2 as const;

/** At most this many grants in the local grant map. */
export const MAX_ACTION_AUTHORIZATION_GRANTS = 10_000 as const;

/** Known grant facts the adapter may enforce without the supplier context. */
export interface ActionAuthorizationGrantEntry {
  /** Stored record version; absent reads as `1`, the adapter writes `2`. */
  readonly schemaVersion?: 1 | 2;
  /** Attempt the grant is bound to; absent only on a legacy `1` grant. */
  readonly attemptId?: string;
  /**
   * The release root the grant is bound to (CO14 follow-up); only a release
   * grant carries one. A resolve or consumption naming another root is refused.
   */
  readonly releaseRoot?: string;
  /** Head the grant applies to; a moved head is out of scope. */
  readonly expectedHeadSha: string;
  /** Action kind the grant was issued for. */
  readonly kind: string;
  /** Action id that durably consumed this grant; null while unconsumed. */
  consumedByActionId: string | null;
}

export type ParsedActionAuthorizationGrantRead =
  | {
      readonly ok: true;
      readonly schemaVersion: 1 | 2;
      readonly grant: ActionAuthorizationGrantEntry;
    }
  | { readonly ok: false; readonly reason: 'unknown-schema-version' | 'malformed' };

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface ActionAuthorizationDelegate {
  readonly resolveGrant?: (
    request: ResolveActionAuthorizationRequest,
  ) => Promise<ResolveActionAuthorizationResult>;
  readonly consumeGrant?: (
    request: ConsumeActionAuthorizationRequest,
  ) => Promise<ConsumeActionAuthorizationResult>;
  /** Local grant store; entries are bound in place on consumption. */
  readonly grants?: Map<string, ActionAuthorizationGrantEntry>;
  /**
   * C2': the scoped one-way owner approval for removing one attempt's
   * unsealed worktree. The composition root binds the owner-question and
   * coordination-request use cases behind it.
   */
  readonly authorizeUnsealedWorktreeRemoval?: (
    request: AuthorizeUnsealedWorktreeRemovalRequest,
  ) => Promise<AuthorizeUnsealedWorktreeRemovalResult>;
  /**
   * The standing shadow import grant's head-free resolve, answered by the
   * coordination use case behind the composition root.
   */
  readonly authorizeShadowImport?: (
    request: AuthorizeShadowImportRequest,
  ) => Promise<AuthorizeShadowImportResult>;
  /**
   * The relaunch-apply grant's head-free resolve (AR3a), answered by the
   * coordination use case behind the composition root.
   */
  readonly authorizeRelaunchApply?: (
    request: AuthorizeRelaunchApplyRequest,
  ) => Promise<AuthorizeRelaunchApplyResult>;
}

const FORGE_ACTION_KINDS = ['push-and-open-pr', 'push-to-pr', 'merge-pr', 'post-status'] as const;
/**
 * Every action kind a request at this boundary may name (CO14): the forge
 * kinds and the three release kinds. A release grant is resolved and consumed
 * through the same port as a forge grant; the scope gate that keeps the two
 * apart lives in the release delegate, not here.
 */
const ACTION_KINDS = [...FORGE_ACTION_KINDS, ...RELEASE_ACTION_KINDS] as const;

const MAX_GRANT_ID_LENGTH = 256;
const MAX_ACTION_ID_LENGTH = 512;
const MAX_SCOPE_ID_LENGTH = 256;
const MAX_HEAD_LENGTH = 64;
const MAX_POLICY_REVISION_LENGTH = 256;
const MAX_REASON_LENGTH = 300;
const MAX_ROOT_LENGTH = 4096;
/** Bounded per repository segment, matching the domain's own grant cap. */
const MAX_REPOSITORY_SEGMENT_LENGTH = 100;

const PATH_SHAPE = /(?:^|[\s"'(=])(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\/;
const SAFE_HEAD_TOKEN = /^[A-Za-z0-9._-]+$/;

/** True when `value` carries a secret shape or a filesystem path shape. */
function containsDisallowedOutputText(value: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => pattern.test(value)) ||
    LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(value)) ||
    PATH_SHAPE.test(value)
  );
}

/**
 * True when `value` holds a C0 control, DEL, a C1 control, a Unicode bidi
 * control (U+061C, U+200E/U+200F, U+202A-U+202E, U+2066-U+2069), a line or
 * paragraph separator (U+2028/U+2029) or a byte order mark (U+FEFF). Such
 * characters can disguise an id or text in a log, a diff or a terminal.
 */
function hasControlOrBidiCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A bounded, non-blank id with no backslash, control or bidi character, and
 * no secret or path shape.
 * Grant and action ids may hold `/` (action ids are keys such as
 * `pr-feedback/42@<head12>`); scope ids (attempt, work order, project) may not.
 */
function isSafeId(value: unknown, maxLength: number, allowSlash: boolean): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !hasControlOrBidiCharacter(value) &&
    !value.includes('\\') &&
    (allowSlash ? isKeyShapedSlash(value) : !value.includes('/')) &&
    !containsDisallowedOutputText(value)
  );
}

/**
 * A slash-bearing id is a key such as `pr-feedback/42@<head12>`: at most one `/`,
 * between two alphanumerics. Anything with more slashes, or a slash after a
 * separator (`grant-/var/tmp/x`), could carry a filesystem path past the
 * path-shape check, so it is not an id.
 */
function isKeyShapedSlash(value: string): boolean {
  const first = value.indexOf('/');
  if (first === -1) {
    return true;
  }
  return (
    first === value.lastIndexOf('/') &&
    /[A-Za-z0-9]/.test(value.charAt(first - 1)) &&
    /[A-Za-z0-9]/.test(value.charAt(first + 1))
  );
}

function isCleanText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maxLength &&
    value.trim().length > 0 &&
    !hasControlOrBidiCharacter(value) &&
    !containsDisallowedOutputText(value)
  );
}

/**
 * The delegate's shadow import answer is waited for at most this long; past
 * it the call is a typed `authorization-unavailable`, never a hang.
 */
export const SHADOW_IMPORT_DELEGATE_DEADLINE_MS = 15_000 as const;

/**
 * AR3a: the relaunch-apply delegate call is waited for at most this long; past
 * it the call is a typed `authorization-unavailable`, never a hang.
 */
export const RELAUNCH_APPLY_DELEGATE_DEADLINE_MS = 15_000 as const;

/**
 * The deadline guard, the `withBudget` pattern of `ReapLaneWorktreesUseCase`:
 * the call's own answer, or a rejection once it runs past `deadlineMs`, so a
 * delegate whose promise never settles cannot hang the adapter. The timer is
 * always cleared, and the losing promise's later rejection is handled by the
 * race, so nothing is left dangling.
 */
async function withDelegateDeadline<T>(call: () => Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('delegate call exceeded its deadline')), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function ownDataDescriptor(
  source: object,
  key: string,
): { readonly state: 'absent' } | { readonly state: 'data'; readonly value: unknown } | { readonly state: 'invalid' } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      return { state: 'absent' };
    }
    if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { state: 'invalid' };
    }
    return { state: 'data', value: descriptor.value };
  } catch {
    return { state: 'invalid' };
  }
}

/**
 * Read one stored grant record at the adapter's boundary. Accepts `schemaVersion: 2`
 * (`attemptId` required) and legacy `1`/absent (`attemptId` optional); any other
 * version is `'unknown-schema-version'`. Pure: never throws, never runs an accessor.
 */
export function parseActionAuthorizationGrantEntry(raw: unknown): ParsedActionAuthorizationGrantRead {
  try {
    return parseGrantUnchecked(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

const GRANT_FIELD_KEYS = [
  'schemaVersion',
  'attemptId',
  'releaseRoot',
  'expectedHeadSha',
  'kind',
  'consumedByActionId',
] as const;

/**
 * One snapshot of the stored grant: each field's own descriptor is read exactly
 * once, so a stateful Proxy cannot answer the version check and the field read
 * differently. Returns null for a non-object or a field that is not a plain
 * enumerable data property.
 */
function snapshotGrantRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of GRANT_FIELD_KEYS) {
    const field = ownDataDescriptor(raw, key);
    if (field.state === 'invalid') {
      return null;
    }
    if (field.state === 'data') {
      snapshot[key] = field.value;
    }
  }
  return snapshot;
}

function parseGrantUnchecked(source: unknown): ParsedActionAuthorizationGrantRead {
  const raw = snapshotGrantRecord(source);
  if (raw === null) {
    return { ok: false, reason: 'malformed' };
  }
  const versionCheck = readRecordSchemaVersion(raw, ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION);
  if (!versionCheck.ok) {
    return { ok: false, reason: versionCheck.reason };
  }
  const record = raw as object;
  const schemaVersion = versionCheck.schemaVersion === 2 ? 2 : 1;

  const consumed = ownDataDescriptor(record, 'consumedByActionId');
  if (
    consumed.state !== 'data' ||
    !(consumed.value === null || isSafeId(consumed.value, MAX_ACTION_ID_LENGTH, true))
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const attempt = ownDataDescriptor(record, 'attemptId');
  if (attempt.state === 'invalid') {
    return { ok: false, reason: 'malformed' };
  }
  // CO14 follow-up: a release grant may carry the root it is bound to. A
  // present-but-hostile root is a malformed record, never a root that matches
  // everything.
  const root = ownDataDescriptor(record, 'releaseRoot');
  if (root.state === 'invalid') {
    return { ok: false, reason: 'malformed' };
  }
  let releaseRoot: string | undefined;
  if (root.state === 'data' && root.value !== undefined) {
    if (typeof root.value !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    const value = root.value;
    if (
      value.length === 0 ||
      value.length > MAX_ROOT_LENGTH ||
      !value.startsWith('/') ||
      value.includes('\0') ||
      /[\p{C}]/u.test(value) ||
      value.split('/').includes('..')
    ) {
      return { ok: false, reason: 'malformed' };
    }
    releaseRoot = value;
  }
  const attemptDeclared =
    schemaVersion === 2 || (attempt.state === 'data' && attempt.value !== undefined);

  const read = readPlainRecord(record, {
    schemaVersion: { kind: 'integer', min: 1, max: 2, optional: true },
    kind: { kind: 'literal', values: ACTION_KINDS },
    expectedHeadSha: { kind: 'string', maxLength: MAX_HEAD_LENGTH },
    ...(attemptDeclared ? { attemptId: { kind: 'string' as const, maxLength: MAX_SCOPE_ID_LENGTH } } : {}),
  });
  if (!read.ok) {
    return { ok: false, reason: 'malformed' };
  }
  const { kind, expectedHeadSha, attemptId } = read.value as {
    kind: string;
    expectedHeadSha: string;
    attemptId?: string;
  };
  if (
    !SAFE_HEAD_TOKEN.test(expectedHeadSha) ||
    containsDisallowedOutputText(expectedHeadSha) ||
    (attemptDeclared && !isSafeId(attemptId, MAX_SCOPE_ID_LENGTH, false))
  ) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    schemaVersion,
    grant: {
      schemaVersion,
      ...(attemptDeclared && attemptId !== undefined ? { attemptId } : {}),
      ...(releaseRoot !== undefined ? { releaseRoot } : {}),
      expectedHeadSha,
      kind,
      consumedByActionId: consumed.value,
    },
  };
}

type RequestFailure = 'invalid-request' | 'too-large';

type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RequestFailure };

function failureOf(reason: string): RequestFailure {
  return reason === 'too-long' ? 'too-large' : 'invalid-request';
}

/**
 * A bounded release root coordinate (CO14 follow-up): an absolute path-shaped
 * runtime input, read descriptor-safely. It is validated here so a
 * wrong-typed, oversized or hostile root is a typed refusal, never a thrown
 * error and never an empty root that matches anything. A root is a path by
 * design, so the path-shape output rule does not apply to it; it is never
 * echoed into a result, message or log.
 */
function readOptionalRootPath(source: object, key: string): Validated<string | undefined> {
  const field = ownDataDescriptor(source, key);
  if (field.state === 'absent' || (field.state === 'data' && field.value === undefined)) {
    return { ok: true, value: undefined };
  }
  if (field.state === 'invalid' || typeof field.value !== 'string') {
    return { ok: false, reason: 'invalid-request' };
  }
  const value = field.value;
  if (
    value.length === 0 ||
    value.length > MAX_ROOT_LENGTH ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    /[\p{C}]/u.test(value) ||
    value.split('/').includes('..')
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return { ok: true, value };
}

function readResolveRequest(request: unknown): Validated<ResolveActionAuthorizationRequest> {
  const read = readPlainRecord(request, {
    actionId: { kind: 'string', maxLength: MAX_ACTION_ID_LENGTH },
    projectId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    workOrderId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    attemptId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    actionKind: { kind: 'literal', values: ACTION_KINDS },
    expectedHeadSha: { kind: 'string', maxLength: MAX_HEAD_LENGTH },
    policyRevision: { kind: 'string', maxLength: MAX_POLICY_REVISION_LENGTH },
  });
  if (!read.ok) {
    return { ok: false, reason: failureOf(read.reason) };
  }
  const value = read.value as unknown as ResolveActionAuthorizationRequest;
  if (
    !isSafeId(value.actionId, MAX_ACTION_ID_LENGTH, true) ||
    !isSafeId(value.projectId, MAX_SCOPE_ID_LENGTH, false) ||
    !isSafeId(value.workOrderId, MAX_SCOPE_ID_LENGTH, false) ||
    !isSafeId(value.attemptId, MAX_SCOPE_ID_LENGTH, false) ||
    !isCleanText(value.expectedHeadSha, MAX_HEAD_LENGTH) ||
    !isCleanText(value.policyRevision, MAX_POLICY_REVISION_LENGTH)
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  const releaseRoot = readOptionalRootPath(request as object, 'releaseRoot');
  if (!releaseRoot.ok) {
    return releaseRoot;
  }
  // CO14 follow-up: the resolve carries the deterministic action id it is
  // resuming, so a grant already durably consumed by exactly this action id
  // resolves again and a crash between the consumption and the release's own
  // write is recoverable on the next pass.
  return {
    ok: true,
    value: {
      ...value,
      ...(releaseRoot.value !== undefined ? { releaseRoot: releaseRoot.value } : {}),
      resumeActionId: value.actionId,
    },
  };
}

function readOptionalRequestString(
  source: object,
  key: string,
  maxLength: number,
  allowSlash: boolean,
): Validated<string | undefined> {
  const field = ownDataDescriptor(source, key);
  if (field.state === 'absent' || (field.state === 'data' && field.value === undefined)) {
    return { ok: true, value: undefined };
  }
  if (field.state === 'invalid' || typeof field.value !== 'string') {
    return { ok: false, reason: 'invalid-request' };
  }
  if (field.value.length > maxLength) {
    return { ok: false, reason: 'too-large' };
  }
  if (!(allowSlash ? isCleanText(field.value, maxLength) : isSafeId(field.value, maxLength, false))) {
    return { ok: false, reason: 'invalid-request' };
  }
  return { ok: true, value: field.value };
}

function readConsumeRequest(request: unknown): Validated<ConsumeActionAuthorizationRequest> {
  const read = readPlainRecord(request, {
    authorizationGrantId: { kind: 'string', maxLength: MAX_GRANT_ID_LENGTH },
    actionId: { kind: 'string', maxLength: MAX_ACTION_ID_LENGTH },
    actionKind: { kind: 'literal', values: ACTION_KINDS },
  });
  if (!read.ok) {
    return { ok: false, reason: failureOf(read.reason) };
  }
  const required = read.value as unknown as Pick<
    ConsumeActionAuthorizationRequest,
    'authorizationGrantId' | 'actionId' | 'actionKind'
  >;
  if (
    !isSafeId(required.authorizationGrantId, MAX_GRANT_ID_LENGTH, true) ||
    !isSafeId(required.actionId, MAX_ACTION_ID_LENGTH, true)
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  const source = request as object;
  const expectedHeadSha = readOptionalRequestString(source, 'expectedHeadSha', MAX_HEAD_LENGTH, true);
  if (!expectedHeadSha.ok) {
    return expectedHeadSha;
  }
  const attemptId = readOptionalRequestString(source, 'attemptId', MAX_SCOPE_ID_LENGTH, false);
  if (!attemptId.ok) {
    return attemptId;
  }
  const releaseRoot = readOptionalRootPath(source, 'releaseRoot');
  if (!releaseRoot.ok) {
    return releaseRoot;
  }
  return {
    ok: true,
    value: {
      authorizationGrantId: required.authorizationGrantId,
      actionId: required.actionId,
      actionKind: required.actionKind,
      ...(expectedHeadSha.value !== undefined ? { expectedHeadSha: expectedHeadSha.value } : {}),
      ...(attemptId.value !== undefined ? { attemptId: attemptId.value } : {}),
      ...(releaseRoot.value !== undefined ? { releaseRoot: releaseRoot.value } : {}),
    },
  };
}

/** A delegate's free-text reason, kept only when clean and bounded. */
function cleanReason(
  reason: string,
  fallback: 'delegate-blocked' | 'delegate-refused' | 'delegate-unknown',
): string {
  return containsDisallowedOutputText(reason) ? fallback : reason;
}

/**
 * AR3a: a delegate's free-text reason, additionally scrubbed of the requested
 * grant id so the grant handle is never echoed back out of the adapter. The
 * cost bound is O(1): one bounded pattern check plus one bounded `includes`
 * over a reason already capped at `MAX_REASON_LENGTH` characters.
 */
function cleanRelaunchApplyReason(
  reason: string,
  requestedGrantId: string,
  outcome: 'blocked' | 'unknown',
): string {
  const fallback = outcome === 'blocked' ? 'delegate-blocked' : 'delegate-unknown';
  const cleaned = cleanReason(reason, fallback);
  return cleaned.includes(requestedGrantId) ? fallback : cleaned; // BROKEN: grant-echo scrub removed (prove test sensitivity)
}

/**
 * C2': a bounded, descriptor-safe read of one unsealed-removal request. A
 * non-object or a wrong-typed or oversized field is refused, never thrown.
 */
function readUnsealedRemovalRequest(
  request: unknown,
): Validated<AuthorizeUnsealedWorktreeRemovalRequest> {
  const read = readPlainRecord(request, {
    projectId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    runId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    attemptId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    worktreePath: { kind: 'string', maxLength: 4096 },
    expectedHeadSha: { kind: 'string', maxLength: MAX_HEAD_LENGTH },
    nowIso: { kind: 'string', maxLength: 64 },
  });
  if (!read.ok) {
    return { ok: false, reason: failureOf(read.reason) };
  }
  const value = read.value as unknown as AuthorizeUnsealedWorktreeRemovalRequest;
  if (
    !isSafeId(value.projectId, MAX_SCOPE_ID_LENGTH, false) ||
    !isSafeId(value.runId, MAX_SCOPE_ID_LENGTH, false) ||
    !isSafeId(value.attemptId, MAX_SCOPE_ID_LENGTH, false) ||
    !isCleanText(value.expectedHeadSha, MAX_HEAD_LENGTH) ||
    typeof value.nowIso !== 'string' ||
    value.nowIso.trim().length === 0
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return { ok: true, value: { ...value } };
}

/**
 * C2': the delegate's answer. Only an approved answer with a bounded,
 * path-free, secret-free approval reference is passed on; every other shape
 * is unknown, so an unreadable authorization is never authority.
 */
function readUnsealedRemovalAnswer(answer: unknown): AuthorizeUnsealedWorktreeRemovalResult {
  const head = readPlainRecord(answer, {
    outcome: { kind: 'literal', values: ['approved', 'blocked', 'unknown'] },
  });
  if (!head.ok) {
    return { outcome: 'unknown', reason: 'authorization-unreadable' };
  }
  if (head.value.outcome === 'approved') {
    const approved = readPlainRecord(answer, {
      approvalReference: { kind: 'string', maxLength: 256 },
    });
    if (!approved.ok) {
      return { outcome: 'unknown', reason: 'invalid-approval-reference' };
    }
    const reference = approved.value.approvalReference as string;
    if (
      reference.length === 0 ||
      reference.includes('/') ||
      reference.includes('\\') ||
      /[\s\p{C}]/u.test(reference) ||
      containsDisallowedOutputText(reference)
    ) {
      return { outcome: 'unknown', reason: 'invalid-approval-reference' };
    }
    return { outcome: 'approved', approvalReference: reference };
  }
  const withReason = readPlainRecord(answer, {
    reason: { kind: 'string', maxLength: MAX_REASON_LENGTH },
  });
  if (!withReason.ok) {
    return { outcome: 'unknown', reason: 'authorization-unreadable' };
  }
  return {
    outcome: head.value.outcome as 'blocked' | 'unknown',
    reason: cleanReason(withReason.value.reason as string, 'delegate-blocked'),
  };
}

/**
 * The standing shadow import grant's resolve request: a bounded,
 * descriptor-safe read. A non-object, a wrong-typed or oversized field, or a
 * hostile accessor is refused, never thrown. `grantId` is a non-secret
 * handle, but it is still bounded and screened so nothing path-shaped or
 * secret-shaped can pass for it.
 */
function readShadowImportRequest(request: unknown): Validated<AuthorizeShadowImportRequest> {
  const read = readPlainRecord(request, {
    projectId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    grantId: { kind: 'string', maxLength: MAX_GRANT_ID_LENGTH },
    repository: {
      kind: 'record',
      schema: {
        owner: { kind: 'string', maxLength: MAX_REPOSITORY_SEGMENT_LENGTH },
        repo: { kind: 'string', maxLength: MAX_REPOSITORY_SEGMENT_LENGTH },
      },
    },
    nowIso: { kind: 'string', maxLength: 64 },
  });
  if (!read.ok) {
    return { ok: false, reason: failureOf(read.reason) };
  }
  const value = read.value as unknown as AuthorizeShadowImportRequest;
  if (
    !isSafeId(value.projectId, MAX_SCOPE_ID_LENGTH, false) ||
    !isSafeId(value.grantId, MAX_GRANT_ID_LENGTH, true) ||
    !isSafeId(value.repository.owner, MAX_REPOSITORY_SEGMENT_LENGTH, false) ||
    !isSafeId(value.repository.repo, MAX_REPOSITORY_SEGMENT_LENGTH, false) ||
    typeof value.nowIso !== 'string' ||
    value.nowIso.trim().length === 0
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return { ok: true, value: { ...value } };
}

/**
 * AR3a: the relaunch-apply resolve request: a bounded, descriptor-safe read.
 * Cost bound: O(1) over three bounded strings of at most 256 characters each.
 * A non-object, a wrong-typed or oversized field, or a hostile accessor
 * (getter, setter, throwing Proxy, `__proto__`, non-plain prototype) is
 * refused, never thrown, and no accessor ever runs. The plan digest must be
 * exactly 64 lowercase hex characters; the grant id is a non-secret handle
 * but still bounded and screened.
 */
function readRelaunchApplyRequest(request: unknown): Validated<AuthorizeRelaunchApplyRequest> {
  const read = readPlainRecord(request, {
    planDigest: { kind: 'string', maxLength: 256 },
    grantId: { kind: 'string', maxLength: MAX_GRANT_ID_LENGTH },
    nowIso: { kind: 'string', maxLength: 64 },
  });
  if (!read.ok) {
    return { ok: false, reason: failureOf(read.reason) };
  }
  const value = read.value as unknown as AuthorizeRelaunchApplyRequest;
  if (
    !/^[0-9a-f]{64}$/.test(value.planDigest) ||
    !isSafeId(value.grantId, MAX_GRANT_ID_LENGTH, true) ||
    !isCleanText(value.nowIso, 64)
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return { ok: true, value: { ...value } };
}

/**
 * AR3a: the delegate's relaunch-apply answer. Only an authorized answer with
 * a bounded, secret-free, path-free grant handle that matches the requested
 * grant id is passed on; every other shape is unknown, so an unreadable
 * answer is never authority. An authorized answer naming a different grant is
 * a typed refusal, never a pass-through. A blocked or unknown reason is
 * scrubbed of secret-shaped, path-shaped and grant-id text, so the grant id
 * is never echoed.
 */
function readRelaunchApplyAnswer(
  answer: unknown,
  requestedGrantId: string,
): AuthorizeRelaunchApplyResult {
  const head = readPlainRecord(answer, {
    outcome: { kind: 'literal', values: ['authorized', 'blocked', 'unknown'] },
  });
  if (!head.ok) {
    return { outcome: 'unknown', reason: 'authorization-unavailable' };
  }
  if (head.value.outcome === 'authorized') {
    const granted = readPlainRecord(answer, {
      grantId: { kind: 'string', maxLength: MAX_GRANT_ID_LENGTH },
    });
    if (!granted.ok || !isSafeId(granted.value.grantId, MAX_GRANT_ID_LENGTH, true)) {
      return { outcome: 'unknown', reason: 'authorization-unreadable' };
    }
    if (granted.value.grantId !== requestedGrantId) {
      return { outcome: 'blocked', reason: 'grant-id-mismatch' };
    }
    return { outcome: 'authorized', grantId: granted.value.grantId as string };
  }
  const withReason = readPlainRecord(answer, {
    reason: { kind: 'string', maxLength: MAX_REASON_LENGTH },
  });
  if (!withReason.ok) {
    return { outcome: 'unknown', reason: 'authorization-unavailable' };
  }
  return {
    outcome: head.value.outcome as 'blocked' | 'unknown',
    reason: cleanRelaunchApplyReason(
      withReason.value.reason as string,
      requestedGrantId,
      head.value.outcome as 'blocked' | 'unknown',
    ),
  };
}

/**
 * The delegate's shadow import answer. Only an authorized answer with a
 * bounded, secret-free, path-free grant handle (a non-secret id by design)
 * that matches the requested grant id is passed on; every other shape is
 * unknown, so an unreadable answer is never authority. An authorized answer
 * naming a different grant is a typed refusal, never a pass-through.
 */
function readShadowImportAnswer(
  answer: unknown,
  requestedGrantId: string,
): AuthorizeShadowImportResult {
  const head = readPlainRecord(answer, {
    outcome: { kind: 'literal', values: ['authorized', 'blocked', 'unknown'] },
  });
  if (!head.ok) {
    return { outcome: 'unknown', reason: 'authorization-unavailable' };
  }
  if (head.value.outcome === 'authorized') {
    const granted = readPlainRecord(answer, {
      grantId: { kind: 'string', maxLength: MAX_GRANT_ID_LENGTH },
    });
    if (!granted.ok || !isSafeId(granted.value.grantId, MAX_GRANT_ID_LENGTH, true)) {
      return { outcome: 'unknown', reason: 'authorization-unreadable' };
    }
    if (granted.value.grantId !== requestedGrantId) {
      return { outcome: 'blocked', reason: 'grant-id-mismatch' };
    }
    return { outcome: 'authorized', grantId: granted.value.grantId as string };
  }
  const withReason = readPlainRecord(answer, {
    reason: { kind: 'string', maxLength: MAX_REASON_LENGTH },
  });
  if (!withReason.ok) {
    return { outcome: 'unknown', reason: 'authorization-unavailable' };
  }
  return {
    outcome: head.value.outcome as 'blocked' | 'unknown',
    reason: cleanReason(withReason.value.reason as string, 'delegate-blocked'),
  };
}

function readDelegateResolveResult(
  answer: unknown,
): ResolveActionAuthorizationResult | null {
  const head = readPlainRecord(answer, {
    outcome: { kind: 'literal', values: ['granted', 'blocked', 'unknown'] },
  });
  if (!head.ok) {
    return null;
  }
  if (head.value.outcome === 'granted') {
    const granted = readPlainRecord(answer, {
      authorizationGrantId: { kind: 'string', maxLength: MAX_GRANT_ID_LENGTH },
    });
    if (!granted.ok || !isSafeId(granted.value.authorizationGrantId, MAX_GRANT_ID_LENGTH, true)) {
      return null;
    }
    // A release grant's root binding travels with the granted answer; an
    // invalid one makes the whole answer unreadable.
    const root = readOptionalRootPath(answer as object, 'releaseRoot');
    if (!root.ok) {
      return null;
    }
    return {
      outcome: 'granted',
      authorizationGrantId: granted.value.authorizationGrantId as string,
      ...(root.value !== undefined ? { releaseRoot: root.value } : {}),
    };
  }
  const withReason = readPlainRecord(answer, {
    reason: { kind: 'string', maxLength: MAX_REASON_LENGTH },
  });
  if (!withReason.ok) {
    return null;
  }
  return {
    outcome: head.value.outcome as 'blocked' | 'unknown',
    reason: cleanReason(withReason.value.reason as string, 'delegate-blocked'),
  };
}

function readDelegateConsumeResult(
  answer: unknown,
  requestedActionId: string,
): ConsumeActionAuthorizationResult | null {
  const head = readPlainRecord(answer, {
    outcome: { kind: 'literal', values: ['consumed', 'refused'] },
  });
  if (!head.ok) {
    return null;
  }
  if (head.value.outcome === 'consumed') {
    const consumed = readPlainRecord(answer, {
      actionId: { kind: 'string', maxLength: MAX_ACTION_ID_LENGTH },
    });
    if (
      !consumed.ok ||
      !isSafeId(consumed.value.actionId, MAX_ACTION_ID_LENGTH, true) ||
      consumed.value.actionId !== requestedActionId
    ) {
      return null;
    }
    return { outcome: 'consumed', actionId: consumed.value.actionId as string };
  }
  const refused = readPlainRecord(answer, {
    reason: { kind: 'string', maxLength: MAX_REASON_LENGTH },
  });
  if (!refused.ok) {
    return null;
  }
  return { outcome: 'refused', reason: cleanReason(refused.value.reason as string, 'delegate-refused') };
}

interface ReadDelegate {
  readonly resolveGrant: ActionAuthorizationDelegate['resolveGrant'];
  readonly consumeGrant: ActionAuthorizationDelegate['consumeGrant'];
  readonly grants: Map<string, ActionAuthorizationGrantEntry> | undefined;
  readonly authorizeUnsealedWorktreeRemoval: ActionAuthorizationDelegate['authorizeUnsealedWorktreeRemoval'];
  readonly authorizeShadowImport: ActionAuthorizationDelegate['authorizeShadowImport'];
  readonly authorizeRelaunchApply: ActionAuthorizationDelegate['authorizeRelaunchApply'];
}

/** Adapter construction options; every member is optional. */
export interface ActionAuthorizationAdapterOptions {
  /**
   * The shadow import delegate call's deadline in milliseconds. Overrides
   * `SHADOW_IMPORT_DELEGATE_DEADLINE_MS` only with a positive safe integer;
   * anything else falls back to the default, never to an unbounded wait.
   */
  readonly shadowImportDelegateDeadlineMs?: number;
  /**
   * AR3a: the relaunch-apply delegate call's deadline in milliseconds.
   * Overrides `RELAUNCH_APPLY_DELEGATE_DEADLINE_MS` only with a positive safe
   * integer; anything else falls back to the default, never to an unbounded
   * wait.
   */
  readonly relaunchApplyDelegateDeadlineMs?: number;
}

function shadowImportDelegateDeadlineMs(options: ActionAuthorizationAdapterOptions): number {
  const value = options.shadowImportDelegateDeadlineMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : SHADOW_IMPORT_DELEGATE_DEADLINE_MS;
}

/** AR3a: the relaunch-apply delegate deadline, defaulted the same bounded way. */
function relaunchApplyDelegateDeadlineMs(options: ActionAuthorizationAdapterOptions): number {
  const value = options.relaunchApplyDelegateDeadlineMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : RELAUNCH_APPLY_DELEGATE_DEADLINE_MS;
}

export class ActionAuthorizationAdapter implements ActionAuthorizationPort {
  private readonly delegate?: ActionAuthorizationDelegate;
  private readonly options: ActionAuthorizationAdapterOptions;

  constructor(delegate?: ActionAuthorizationDelegate, options?: ActionAuthorizationAdapterOptions) {
    this.delegate = delegate;
    this.options = { ...options };
  }

  /** The delegate's members read once; null when reading them throws. */
  private readDelegate(): ReadDelegate | null {
    try {
      const grants = this.delegate?.grants;
      return {
        resolveGrant: this.delegate?.resolveGrant,
        consumeGrant: this.delegate?.consumeGrant,
        grants: grants instanceof Map ? grants : undefined,
        authorizeUnsealedWorktreeRemoval: this.delegate?.authorizeUnsealedWorktreeRemoval,
        authorizeShadowImport: this.delegate?.authorizeShadowImport,
        authorizeRelaunchApply: this.delegate?.authorizeRelaunchApply,
      };
    } catch {
      return null;
    }
  }

  async resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    const delegate = this.readDelegate();
    if (delegate !== null && typeof delegate.resolveGrant !== 'function' && delegate.grants === undefined) {
      throw new Error('Not implemented: ActionAuthorizationAdapter.resolveActionAuthorization');
    }
    try {
      if (delegate === null) {
        return { outcome: 'blocked', reason: 'authorization-unavailable' };
      }
      const validated = readResolveRequest(request);
      if (!validated.ok) {
        return { outcome: 'blocked', reason: validated.reason };
      }
      if (typeof delegate.resolveGrant === 'function') {
        return await this.resolveThroughDelegate(delegate.resolveGrant, validated.value);
      }
      return this.resolveLocally(delegate.grants as Map<string, ActionAuthorizationGrantEntry>, validated.value);
    } catch {
      return { outcome: 'blocked', reason: 'authorization-unavailable' };
    }
  }

  async consumeActionAuthorization(
    request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult> {
    const delegate = this.readDelegate();
    if (delegate !== null && typeof delegate.consumeGrant !== 'function' && delegate.grants === undefined) {
      throw new Error('Not implemented: ActionAuthorizationAdapter.consumeActionAuthorization');
    }
    try {
      if (delegate === null) {
        return { outcome: 'refused', reason: 'authorization-unavailable' };
      }
      const validated = readConsumeRequest(request);
      if (!validated.ok) {
        return { outcome: 'refused', reason: validated.reason };
      }
      if (typeof delegate.consumeGrant === 'function') {
        return await this.consumeThroughDelegate(delegate.consumeGrant, validated.value);
      }
      return this.consumeLocally(delegate.grants as Map<string, ActionAuthorizationGrantEntry>, validated.value);
    } catch {
      return { outcome: 'refused', reason: 'authorization-unavailable' };
    }
  }

  /**
   * C2': the scoped one-way owner approval for one unsealed worktree removal.
   * A malformed request is blocked; an absent delegate is `not-configured`; a
   * throwing or unreadable delegate answer is unknown; an approval reference
   * that is not a bounded, path-free, secret-free token is never trusted.
   */
  async authorizeUnsealedWorktreeRemoval(
    request: AuthorizeUnsealedWorktreeRemovalRequest,
  ): Promise<AuthorizeUnsealedWorktreeRemovalResult> {
    const delegate = this.readDelegate();
    if (delegate === null || typeof delegate.authorizeUnsealedWorktreeRemoval !== 'function') {
      return { outcome: 'blocked', reason: 'not-configured' };
    }
    const validated = readUnsealedRemovalRequest(request);
    if (!validated.ok) {
      return { outcome: 'blocked', reason: validated.reason };
    }
    let answer: unknown;
    try {
      answer = await delegate.authorizeUnsealedWorktreeRemoval(validated.value);
    } catch {
      return { outcome: 'unknown', reason: 'authorization-unreadable' };
    }
    return readUnsealedRemovalAnswer(answer);
  }

  /**
   * The standing shadow import grant's head-free resolve. A malformed or
   * hostile request is blocked; an absent delegate or delegate method, a
   * throwing delegate, a delegate whose answer never settles (bounded by
   * `withDelegateDeadline`) or an unreadable answer is unknown — never
   * authority. The grant id echoed in an authorized answer is a non-secret
   * handle.
   */
  async authorizeShadowImport(
    request: AuthorizeShadowImportRequest,
  ): Promise<AuthorizeShadowImportResult> {
    const delegate = this.readDelegate();
    if (delegate === null || typeof delegate.authorizeShadowImport !== 'function') {
      return { outcome: 'unknown', reason: 'authorization-unavailable' };
    }
    const validated = readShadowImportRequest(request);
    if (!validated.ok) {
      return { outcome: 'blocked', reason: validated.reason };
    }
    let answer: unknown;
    const authorize = delegate.authorizeShadowImport;
    try {
      // Bounded: a delegate whose promise never settles is an expired
      // deadline, a typed `authorization-unavailable`, never a hang.
      answer = await withDelegateDeadline(
        () => authorize(validated.value),
        shadowImportDelegateDeadlineMs(this.options),
      );
    } catch {
      return { outcome: 'unknown', reason: 'authorization-unavailable' };
    }
    return readShadowImportAnswer(answer, validated.value.grantId);
  }

  /**
   * AR3a: the relaunch-apply grant's head-free resolve. A malformed or
   * hostile request is blocked; an absent delegate or delegate method, a
   * throwing delegate, a delegate whose answer never settles (bounded by
   * `withDelegateDeadline`) or an unreadable answer is unknown — never
   * authority. The grant id is a non-secret handle, and a blocked or unknown
   * delegate reason is scrubbed of the grant id, secrets and paths, so the
   * grant is never echoed.
   */
  async authorizeRelaunchApply(
    request: AuthorizeRelaunchApplyRequest,
  ): Promise<AuthorizeRelaunchApplyResult> {
    const delegate = this.readDelegate();
    if (delegate === null || typeof delegate.authorizeRelaunchApply !== 'function') {
      return { outcome: 'unknown', reason: 'authorization-unavailable' };
    }
    const validated = readRelaunchApplyRequest(request);
    if (!validated.ok) {
      return { outcome: 'blocked', reason: validated.reason };
    }
    let answer: unknown;
    const authorize = delegate.authorizeRelaunchApply;
    try {
      // Bounded: a delegate whose promise never settles is an expired
      // deadline, a typed `authorization-unavailable`, never a hang.
      answer = await withDelegateDeadline(
        () => authorize(validated.value),
        relaunchApplyDelegateDeadlineMs(this.options),
      );
    } catch {
      return { outcome: 'unknown', reason: 'authorization-unavailable' };
    }
    return readRelaunchApplyAnswer(answer, validated.value.grantId);
  }

  private async resolveThroughDelegate(
    resolveGrant: NonNullable<ActionAuthorizationDelegate['resolveGrant']>,
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    let answer: unknown;
    try {
      answer = await resolveGrant(request);
    } catch {
      return { outcome: 'blocked', reason: 'authorization-unavailable' };
    }
    return readDelegateResolveResult(answer) ?? { outcome: 'blocked', reason: 'authorization-unavailable' };
  }

  private async consumeThroughDelegate(
    consumeGrant: NonNullable<ActionAuthorizationDelegate['consumeGrant']>,
    request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult> {
    let answer: unknown;
    try {
      answer = await consumeGrant(request);
    } catch {
      return { outcome: 'refused', reason: 'authorization-unavailable' };
    }
    return (
      readDelegateConsumeResult(answer, request.actionId) ?? {
        outcome: 'refused',
        reason: 'authorization-unavailable',
      }
    );
  }

  private resolveLocally(
    grants: Map<string, ActionAuthorizationGrantEntry>,
    request: ResolveActionAuthorizationRequest,
  ): ResolveActionAuthorizationResult {
    if (grants.size > MAX_ACTION_AUTHORIZATION_GRANTS) {
      return { outcome: 'blocked', reason: 'too-large' };
    }
    const scan = this.scanGrantsForMatch(grants, request);
    if ('blocked' in scan) {
      return scan.blocked;
    }
    const { match, rootConflict, consumedByOther } = scan;
    if (match === undefined) {
      return {
        outcome: 'blocked',
        reason: !consumedByOther && rootConflict ? 'release-grant-root-mismatch' : 'no-matching-grant',
      };
    }
    this.bindGrantInPlace(grants, match, request);
    return {
      outcome: 'granted',
      authorizationGrantId: match.id,
      ...(match.grant.releaseRoot !== undefined
        ? { releaseRoot: match.grant.releaseRoot }
        : request.releaseRoot !== undefined
          ? { releaseRoot: request.releaseRoot }
          : {}),
    };
  }

  /**
   * Every record is read before any is matched: one unreadable or unknown-version
   * record fails the whole store closed instead of being skipped. The scan is
   * linear in the number of stored grants, capped by the named constant
   * `MAX_ACTION_AUTHORIZATION_GRANTS` (rejected above it before any scan).
   */
  private scanGrantsForMatch(
    grants: Map<string, ActionAuthorizationGrantEntry>,
    request: ResolveActionAuthorizationRequest,
  ):
    | { readonly blocked: ResolveActionAuthorizationResult }
    | {
        readonly match: { readonly id: string; readonly grant: ActionAuthorizationGrantEntry } | undefined;
        readonly rootConflict: boolean;
        readonly consumedByOther: boolean;
      } {
    let match: { readonly id: string; readonly grant: ActionAuthorizationGrantEntry } | undefined;
    // CO14 follow-up (#4g): a resumable release grant (already consumed by
    // exactly this resolve's action id) is preferred over an unrelated
    // unconsumed grant, so a retry after a crash between the consumption and
    // the release's write never spends a second approved grant.
    let resumableMatch: { readonly id: string; readonly grant: ActionAuthorizationGrantEntry } | undefined;
    let rootConflict = false;
    let consumedByOther = false;
    for (const [rawGrantId, rawEntry] of grants) {
      if (!isSafeId(rawGrantId, MAX_GRANT_ID_LENGTH, true)) {
        return { blocked: { outcome: 'blocked', reason: 'invalid-grant-record' } };
      }
      const parsed = parseActionAuthorizationGrantEntry(rawEntry);
      if (!parsed.ok) {
        return {
          blocked: {
            outcome: 'blocked',
            reason: parsed.reason === 'unknown-schema-version' ? 'unknown-grant-schema-version' : 'invalid-grant-record',
          },
        };
      }
      const grant = parsed.grant;
      const structural =
        grant.kind === request.actionKind &&
        grant.expectedHeadSha === request.expectedHeadSha &&
        (grant.attemptId === undefined || grant.attemptId === request.attemptId);
      if (!structural) {
        continue;
      }
      if (grant.releaseRoot !== undefined && grant.releaseRoot !== request.releaseRoot) {
        // CO14 follow-up: a grant bound to one root never resolves for
        // another; the mismatch is a typed refusal, never a silent skip.
        rootConflict = true;
        continue;
      }
      if (isResolvableGrant(grant, request)) {
        const entry = { id: rawGrantId, grant };
        if (grant.consumedByActionId === null) {
          match = entry;
        } else {
          resumableMatch = entry;
        }
        continue;
      }
      consumedByOther = true;
    }
    return { match: resumableMatch ?? match, rootConflict, consumedByOther };
  }

  private bindGrantInPlace(
    grants: Map<string, ActionAuthorizationGrantEntry>,
    match: { readonly id: string; readonly grant: ActionAuthorizationGrantEntry },
    request: ResolveActionAuthorizationRequest,
  ): void {
    if (match.grant.attemptId !== undefined && !(request.releaseRoot !== undefined && match.grant.releaseRoot === undefined)) {
      return;
    }
    // A legacy grant binds to the first attempt that resolves it, and a
    // release grant without a recorded root binds to the first root that
    // resolves it (CO14 follow-up); both bindings persist in place, so a
    // bound grant can never be moved to another attempt or root afterwards.
    const needsAttempt = match.grant.attemptId === undefined;
    grants.set(match.id, {
      schemaVersion: needsAttempt ? ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION : match.grant.schemaVersion,
      attemptId: match.grant.attemptId ?? request.attemptId,
      ...(request.releaseRoot !== undefined ? { releaseRoot: request.releaseRoot } : {}),
      expectedHeadSha: match.grant.expectedHeadSha,
      kind: match.grant.kind,
      consumedByActionId: match.grant.consumedByActionId,
    });
  }

  private consumeLocally(
    grants: Map<string, ActionAuthorizationGrantEntry>,
    request: ConsumeActionAuthorizationRequest,
  ): ConsumeActionAuthorizationResult {
    if (grants.size > MAX_ACTION_AUTHORIZATION_GRANTS) {
      return { outcome: 'refused', reason: 'too-large' };
    }
    if (!grants.has(request.authorizationGrantId)) {
      // Keep the pre-CO24b reason wording the cross-forge coverage pins.
      return {
        outcome: 'refused',
        reason: `Authorization grant not found: ${request.authorizationGrantId}`,
      };
    }
    const parsed = parseActionAuthorizationGrantEntry(grants.get(request.authorizationGrantId));
    if (!parsed.ok) {
      return {
        outcome: 'refused',
        reason: parsed.reason === 'unknown-schema-version' ? 'unknown-grant-schema-version' : 'invalid-grant-record',
      };
    }
    const grant = parsed.grant;
    if (grant.kind !== request.actionKind) {
      return { outcome: 'refused', reason: 'grant-kind-mismatch' };
    }
    if (request.expectedHeadSha === undefined) {
      // The local grant store keeps no resolve-time coordinates beyond the
      // grant's own, so a consume request that omits the head cannot be verified.
      return {
        outcome: 'refused',
        reason: `Authorization grant ${request.authorizationGrantId} requires the expectedHeadSha this local grant store cannot infer`,
      };
    }
    if (grant.expectedHeadSha !== request.expectedHeadSha) {
      return { outcome: 'refused', reason: 'grant-head-mismatch' };
    }
    if (grant.attemptId !== undefined) {
      if (request.attemptId === undefined) {
        return { outcome: 'refused', reason: 'grant-attempt-required' };
      }
      if (grant.attemptId !== request.attemptId) {
        return { outcome: 'refused', reason: 'grant-attempt-mismatch' };
      }
    }
    // CO14 follow-up: the supplied and stored roots must match whenever either
    // is present. A root-bound grant is never consumed for another root, nor by
    // a consumption that omits the root; a root the grant never recorded cannot
    // be verified here either.
    if (
      (request.releaseRoot !== undefined || grant.releaseRoot !== undefined) &&
      grant.releaseRoot !== request.releaseRoot
    ) {
      return { outcome: 'refused', reason: 'release-grant-root-mismatch' };
    }
    if (grant.consumedByActionId === null) {
      const boundAttemptId = grant.attemptId ?? request.attemptId;
      grants.set(request.authorizationGrantId, {
        // A record without an attempt stays a legacy `1` record: `2` requires `attemptId`.
        schemaVersion: boundAttemptId !== undefined ? ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION : 1,
        ...(boundAttemptId !== undefined ? { attemptId: boundAttemptId } : {}),
        ...(grant.releaseRoot !== undefined ? { releaseRoot: grant.releaseRoot } : {}),
        expectedHeadSha: grant.expectedHeadSha,
        kind: grant.kind,
        consumedByActionId: request.actionId,
      });
      return { outcome: 'consumed', actionId: request.actionId };
    }
    if (grant.consumedByActionId === request.actionId) {
      // Idempotent: the same action may observe its own consumption.
      return { outcome: 'consumed', actionId: request.actionId };
    }
    return {
      outcome: 'refused',
      reason: `Authorization grant already consumed by action ${grant.consumedByActionId}`,
    };
  }
}

/**
 * An unconsumed grant resolves. CO14 follow-up: a release grant already consumed
 * by exactly this resolve's deterministic action id resolves again idempotently,
 * so a crash between the consumption and the release's write is recoverable on
 * the next pass. A different action id never resumes a consumed grant.
 */
function isResolvableGrant(grant: ActionAuthorizationGrantEntry, request: ResolveActionAuthorizationRequest): boolean {
  if (grant.consumedByActionId === null) {
    return true;
  }
  return RELEASE_ACTION_KINDS.includes(grant.kind as never) && grant.consumedByActionId === request.actionId;
}
