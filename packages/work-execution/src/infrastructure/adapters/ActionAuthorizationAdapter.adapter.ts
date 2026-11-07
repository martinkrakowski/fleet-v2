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
  AuthorizeUnsealedWorktreeRemovalRequest,
  AuthorizeUnsealedWorktreeRemovalResult,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
  VerifyConsumedActionAuthorizationRequest,
  VerifyConsumedActionAuthorizationResult,
} from '../../application/ports/out/ActionAuthorizationPort.out-port.js';
import { RELEASE_ACTION_KINDS } from '../../domain/coordination-keys.js';
import { readRecordSchemaVersion } from '../../domain/record-schema-version.js';

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
  /** Head the grant applies to; a moved head is out of scope. */
  readonly expectedHeadSha: string;
  /** Action kind the grant was issued for. */
  readonly kind: string;
  /**
   * CO14b: the release root the grant was issued for. Required for a release
   * kind (a release grant authorizes only the root it names); absent for a
   * forge kind, which carries no root.
   */
  readonly root?: string;
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
  /** CO14b: proof that one action id consumed a grant for a root and head. */
  readonly verifyConsumption?: (
    request: VerifyConsumedActionAuthorizationRequest,
  ) => Promise<VerifyConsumedActionAuthorizationResult>;
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
}

const FORGE_ACTION_KINDS = ['push-and-open-pr', 'push-to-pr', 'merge-pr', 'post-status'] as const;

/** Every authorized action kind: forge kinds plus the release kinds (CO14). */
const ALL_ACTION_KINDS = [...FORGE_ACTION_KINDS, ...RELEASE_ACTION_KINDS] as const;

/** True for a release action kind; only release actions are bound to a root. */
function isReleaseActionKind(kind: string): boolean {
  return (RELEASE_ACTION_KINDS as readonly string[]).includes(kind);
}

const MAX_GRANT_ID_LENGTH = 256;
const MAX_ACTION_ID_LENGTH = 512;
const MAX_SCOPE_ID_LENGTH = 256;
const MAX_HEAD_LENGTH = 64;
const MAX_POLICY_REVISION_LENGTH = 256;
const MAX_REASON_LENGTH = 300;
/** The release root coordinate bound to a grant; bounded like the use case's root. */
const MAX_ROOT_LENGTH = 4096;

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
 * A release root coordinate: a bounded, non-blank string with no control or
 * bidi character. It is a runtime input read at the port boundary (never a
 * raw property access); it is never echoed into any result.
 */
function isCleanRoot(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ROOT_LENGTH &&
    value.trim().length > 0 &&
    !hasControlOrBidiCharacter(value)
  );
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

const GRANT_FIELD_KEYS = ['schemaVersion', 'attemptId', 'expectedHeadSha', 'kind', 'root', 'consumedByActionId'] as const;

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
  const attemptDeclared =
    schemaVersion === 2 || (attempt.state === 'data' && attempt.value !== undefined);

  const read = readPlainRecord(record, {
    schemaVersion: { kind: 'integer', min: 1, max: 2, optional: true },
    kind: { kind: 'literal', values: ALL_ACTION_KINDS },
    expectedHeadSha: { kind: 'string', maxLength: MAX_HEAD_LENGTH },
    root: { kind: 'string', maxLength: MAX_ROOT_LENGTH, optional: true },
    ...(attemptDeclared ? { attemptId: { kind: 'string' as const, maxLength: MAX_SCOPE_ID_LENGTH } } : {}),
  });
  if (!read.ok) {
    return { ok: false, reason: 'malformed' };
  }
  const { kind, expectedHeadSha, root, attemptId } = read.value as {
    kind: string;
    expectedHeadSha: string;
    root?: string;
    attemptId?: string;
  };
  if (
    !SAFE_HEAD_TOKEN.test(expectedHeadSha) ||
    containsDisallowedOutputText(expectedHeadSha) ||
    (attemptDeclared && !isSafeId(attemptId, MAX_SCOPE_ID_LENGTH, false))
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // A release grant must name the root it authorizes: a rootless release grant
  // is never readable, so it can never authorize a release ("never an empty
  // root that matches anything"). Forge grants carry no root.
  const releaseGrant = isReleaseActionKind(kind);
  if (root !== undefined && !isCleanRoot(root)) {
    return { ok: false, reason: 'malformed' };
  }
  if (releaseGrant && root === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    schemaVersion,
    grant: {
      schemaVersion,
      ...(attemptDeclared && attemptId !== undefined ? { attemptId } : {}),
      expectedHeadSha,
      kind,
      ...(releaseGrant ? { root: root as string } : {}),
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

function readResolveRequest(request: unknown): Validated<ResolveActionAuthorizationRequest> {
  const read = readPlainRecord(request, {
    actionId: { kind: 'string', maxLength: MAX_ACTION_ID_LENGTH },
    projectId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    workOrderId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    attemptId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
    actionKind: { kind: 'literal', values: ALL_ACTION_KINDS },
    expectedHeadSha: { kind: 'string', maxLength: MAX_HEAD_LENGTH },
    policyRevision: { kind: 'string', maxLength: MAX_POLICY_REVISION_LENGTH },
    root: { kind: 'string', maxLength: MAX_ROOT_LENGTH, optional: true },
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
    !isCleanText(value.policyRevision, MAX_POLICY_REVISION_LENGTH) ||
    (value.root !== undefined && !isCleanRoot(value.root)) ||
    (isReleaseActionKind(value.actionKind) && value.root === undefined)
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return { ok: true, value: { ...value } };
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
    actionKind: { kind: 'literal', values: ALL_ACTION_KINDS },
    root: { kind: 'string', maxLength: MAX_ROOT_LENGTH, optional: true },
  });
  if (!read.ok) {
    return { ok: false, reason: failureOf(read.reason) };
  }
  const required = read.value as unknown as Pick<
    ConsumeActionAuthorizationRequest,
    'authorizationGrantId' | 'actionId' | 'actionKind' | 'root'
  >;
  if (
    !isSafeId(required.authorizationGrantId, MAX_GRANT_ID_LENGTH, true) ||
    !isSafeId(required.actionId, MAX_ACTION_ID_LENGTH, true) ||
    (required.root !== undefined && !isCleanRoot(required.root)) ||
    (isReleaseActionKind(required.actionKind) && required.root === undefined)
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
  return {
    ok: true,
    value: {
      authorizationGrantId: required.authorizationGrantId,
      actionId: required.actionId,
      actionKind: required.actionKind,
      ...(required.root !== undefined ? { root: required.root } : {}),
      ...(expectedHeadSha.value !== undefined ? { expectedHeadSha: expectedHeadSha.value } : {}),
      ...(attemptId.value !== undefined ? { attemptId: attemptId.value } : {}),
    },
  };
}

/** A delegate's free-text reason, kept only when clean and bounded. */
function cleanReason(reason: string, fallback: 'delegate-blocked' | 'delegate-refused'): string {
  return containsDisallowedOutputText(reason) ? fallback : reason;
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
      root: { kind: 'string', maxLength: MAX_ROOT_LENGTH, optional: true },
    });
    if (
      !granted.ok ||
      !isSafeId(granted.value.authorizationGrantId, MAX_GRANT_ID_LENGTH, true) ||
      (granted.value.root !== undefined && !isCleanRoot(granted.value.root))
    ) {
      return null;
    }
    return {
      outcome: 'granted',
      authorizationGrantId: granted.value.authorizationGrantId as string,
      ...(granted.value.root !== undefined ? { root: granted.value.root } : {}),
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
  readonly verifyConsumption: ActionAuthorizationDelegate['verifyConsumption'];
  readonly grants: Map<string, ActionAuthorizationGrantEntry> | undefined;
  readonly authorizeUnsealedWorktreeRemoval: ActionAuthorizationDelegate['authorizeUnsealedWorktreeRemoval'];
}

export class ActionAuthorizationAdapter implements ActionAuthorizationPort {
  private readonly delegate?: ActionAuthorizationDelegate;

  constructor(delegate?: ActionAuthorizationDelegate) {
    this.delegate = delegate;
  }

  /** The delegate's members read once; null when reading them throws. */
  private readDelegate(): ReadDelegate | null {
    try {
      const grants = this.delegate?.grants;
      return {
        resolveGrant: this.delegate?.resolveGrant,
        consumeGrant: this.delegate?.consumeGrant,
        verifyConsumption: this.delegate?.verifyConsumption,
        grants: grants instanceof Map ? grants : undefined,
        authorizeUnsealedWorktreeRemoval: this.delegate?.authorizeUnsealedWorktreeRemoval,
      };
    } catch {
      return null;
    }
  }

  /**
   * CO14b: true proof only. A consumption by the same action id, kind, head
   * and root is `consumed`; anything else readable is `absent`; an unreadable
   * or unconfigured source is `unknown`. Never throws.
   */
  async verifyConsumedActionAuthorization(
    request: VerifyConsumedActionAuthorizationRequest,
  ): Promise<VerifyConsumedActionAuthorizationResult> {
    try {
      const delegate = this.readDelegate();
      if (delegate === null) {
        return { outcome: 'unknown' };
      }
      const read = readPlainRecord(request, {
        actionId: { kind: 'string', maxLength: MAX_ACTION_ID_LENGTH },
        projectId: { kind: 'string', maxLength: MAX_SCOPE_ID_LENGTH },
        actionKind: { kind: 'literal', values: [...ALL_ACTION_KINDS] },
        expectedHeadSha: { kind: 'string', maxLength: MAX_HEAD_LENGTH },
        root: { kind: 'string', maxLength: MAX_ROOT_LENGTH },
      });
      if (!read.ok || !isCleanRoot(read.value.root) || !isSafeId(read.value.actionId, MAX_ACTION_ID_LENGTH, true)) {
        return { outcome: 'unknown' };
      }
      const value = read.value as unknown as VerifyConsumedActionAuthorizationRequest;
      if (typeof delegate.verifyConsumption === 'function') {
        let answer: unknown;
        try {
          answer = await delegate.verifyConsumption(value);
        } catch {
          return { outcome: 'unknown' };
        }
        const head = readPlainRecord(answer, {
          outcome: { kind: 'literal', values: ['consumed', 'absent', 'unknown'] },
        });
        return head.ok ? ({ outcome: head.value.outcome } as VerifyConsumedActionAuthorizationResult) : { outcome: 'unknown' };
      }
      if (delegate.grants === undefined || delegate.grants.size > MAX_ACTION_AUTHORIZATION_GRANTS) {
        return { outcome: 'unknown' };
      }
      for (const rawEntry of delegate.grants.values()) {
        const parsed = parseActionAuthorizationGrantEntry(rawEntry);
        if (!parsed.ok) {
          return { outcome: 'unknown' };
        }
        const grant = parsed.grant;
        if (
          grant.consumedByActionId === value.actionId &&
          grant.kind === value.actionKind &&
          grant.expectedHeadSha === value.expectedHeadSha &&
          grant.root === value.root
        ) {
          return { outcome: 'consumed' };
        }
      }
      return { outcome: 'absent' };
    } catch {
      return { outcome: 'unknown' };
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
    const resolved = readDelegateResolveResult(answer);
    if (resolved === null) {
      return { outcome: 'blocked', reason: 'authorization-unavailable' };
    }
    // CO14b: a granted release must be bound to the root the request names; a
    // grant resolved for another root is a mismatch, never authority.
    if (
      resolved.outcome === 'granted' &&
      request.root !== undefined &&
      resolved.root !== undefined &&
      resolved.root !== request.root
    ) {
      return { outcome: 'blocked', reason: 'release-grant-root-mismatch' };
    }
    return resolved;
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
    // Every record is read before any is matched: one unreadable or unknown-version
    // record fails the whole store closed instead of being skipped.
    let match: { readonly id: string; readonly grant: ActionAuthorizationGrantEntry } | undefined;
    let rootMismatch = false;
    for (const [rawGrantId, rawEntry] of grants) {
      if (!isSafeId(rawGrantId, MAX_GRANT_ID_LENGTH, true)) {
        return { outcome: 'blocked', reason: 'invalid-grant-record' };
      }
      const parsed = parseActionAuthorizationGrantEntry(rawEntry);
      if (!parsed.ok) {
        return {
          outcome: 'blocked',
          reason: parsed.reason === 'unknown-schema-version' ? 'unknown-grant-schema-version' : 'invalid-grant-record',
        };
      }
      const grant = parsed.grant;
      const coordinatesMatch =
        grant.consumedByActionId === null &&
        grant.kind === request.actionKind &&
        grant.expectedHeadSha === request.expectedHeadSha &&
        (grant.attemptId === undefined || grant.attemptId === request.attemptId);
      if (!coordinatesMatch) {
        continue;
      }
      // CO14b: a release grant is bound to the root it names. A grant that
      // matches kind/head/attempt but names another root is a root mismatch,
      // never authority for this root.
      if (grant.root !== undefined && grant.root !== request.root) {
        rootMismatch = true;
        continue;
      }
      if (match === undefined) {
        match = { id: rawGrantId, grant };
      }
    }
    if (rootMismatch && match === undefined) {
      return { outcome: 'blocked', reason: 'release-grant-root-mismatch' };
    }
    if (match === undefined) {
      return { outcome: 'blocked', reason: 'no-matching-grant' };
    }
    if (match.grant.attemptId === undefined) {
      // A legacy grant binds to the first attempt that resolves it.
      grants.set(match.id, {
        schemaVersion: ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION,
        attemptId: request.attemptId,
        expectedHeadSha: match.grant.expectedHeadSha,
        kind: match.grant.kind,
        ...(match.grant.root !== undefined ? { root: match.grant.root } : {}),
        consumedByActionId: null,
      });
    }
    return {
      outcome: 'granted',
      authorizationGrantId: match.id,
      ...(match.grant.root !== undefined ? { root: match.grant.root } : {}),
    };
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
    // CO14b: the consume request carries the root the release runs on and
    // compares it to the root the grant was resolved for, so a grant cannot be
    // moved to another root after it was issued. Nothing is consumed on a
    // mismatch.
    if (grant.root !== undefined && grant.root !== request.root) {
      return { outcome: 'refused', reason: 'release-grant-root-mismatch' };
    }
    if (grant.consumedByActionId === null) {
      const boundAttemptId = grant.attemptId ?? request.attemptId;
      grants.set(request.authorizationGrantId, {
        // A record without an attempt stays a legacy `1` record: `2` requires `attemptId`.
        schemaVersion: boundAttemptId !== undefined ? ACTION_AUTHORIZATION_GRANT_SCHEMA_VERSION : 1,
        ...(boundAttemptId !== undefined ? { attemptId: boundAttemptId } : {}),
        expectedHeadSha: grant.expectedHeadSha,
        kind: grant.kind,
        ...(grant.root !== undefined ? { root: grant.root } : {}),
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
