/**
 * Pure time-bounded operator access decider. An operator reaches one
 * organisation only through a grant that names the actor, the organisation, a
 * reason and an expiry, and no grant lasts longer than four hours: there is
 * never a standing cross-tenant owner. Pure domain code: no Node, filesystem,
 * subprocess, network or vendor imports; no clock and no randomness, because
 * the caller supplies `nowIso`.
 *
 * Hostile-input rule (every public function): untrusted values are read once
 * through the shared plain-data snapshot, so no getter and no Proxy trap runs
 * here. Null, undefined, primitives, arrays, array-likes, holes, non-plain
 * prototypes, accessors, Proxies, symbol keys, prototype-polluting keys,
 * missing or extra keys and oversized strings are each a typed refusal, never
 * a throw and never a pass. A refusal never echoes a rejected value or the
 * grant's reason.
 *
 * Cost bounds: every function is `O(1)`. The snapshots are bounded by their
 * own fixed limits (at most 10 nodes for an envelope), the actor and
 * organisation patterns run after a length check, the reason scan is bounded
 * by `MAX_OPERATOR_REASON_LENGTH`, and the instants are compared a fixed
 * number of times.
 */

import { snapshotPlainData, type IsProxy } from '@fleet/shared';

import {
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  checkSnapshotKeys,
  compareZonedIsoInstants,
  hasControlCharacter,
  isZonedIsoDateTime,
  readRecord,
} from './entities/record-guards.js';
import { ACTOR_PATTERN } from './sign-in-link.js';

/** The longest an operator grant may last: four hours. */
export const OPERATOR_ACCESS_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

/** The longest reason a grant may carry, in characters. */
export const MAX_OPERATOR_REASON_LENGTH = 512;

export type OperatorAccessGrant = {
  readonly actor: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly grantedAtIso: string;
  readonly expiresAtIso: string;
};

/** One audit row per decision; a refusal's `reason` is the refusal code. */
export type OperatorAccessAuditRow = {
  readonly actor: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly atIso: string;
};

export type OperatorAccessRefusalReason =
  | 'invalid-grant'
  | 'wrong-organization'
  | 'not-yet-valid'
  | 'expired'
  | 'invalid-input';

export type ParseOperatorAccessGrantResult =
  | { readonly outcome: 'parsed'; readonly grant: OperatorAccessGrant }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-grant' };

export type OperatorAccessDecisionResult =
  | {
      readonly outcome: 'allowed';
      readonly actor: string;
      readonly organizationId: string;
      readonly audit: OperatorAccessAuditRow;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: OperatorAccessRefusalReason;
      readonly audit: OperatorAccessAuditRow;
    };

const GRANT_KEYS: ReadonlySet<string> = new Set([
  'actor',
  'organizationId',
  'reason',
  'grantedAtIso',
  'expiresAtIso',
]);
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['grant', 'organizationId', 'nowIso']);

const ENVELOPE_LIMITS = {
  maxDepth: 2,
  maxKeys: 8,
  maxArrayLength: 0,
  maxNodes: 16,
  maxStringLength: MAX_STRING_LENGTH,
} as const;

const REFUSED_GRANT: ParseOperatorAccessGrantResult = Object.freeze({
  outcome: 'refused',
  reason: 'invalid-grant',
});

/** Pattern-checked after a length check, so the regex never sees an oversized string. */
function matchesBounded(value: unknown, pattern: RegExp, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength && pattern.test(value);
}

/** The digits of an instant below the millisecond, padded to six. `O(1)`. */
function subMillisecondDigits(iso: string): string {
  const match = /\.(\d{1,9})/.exec(iso);
  return (match === null ? '' : match[1]).padEnd(9, '0').slice(3);
}

/** True when the grant's lifetime is positive and at most four hours, to the nanosecond. */
function hasValidLifetime(grantedAtIso: string, expiresAtIso: string): boolean {
  if (compareZonedIsoInstants(expiresAtIso, grantedAtIso) <= 0) {
    return false;
  }
  const lifetime = Date.parse(expiresAtIso) - Date.parse(grantedAtIso);
  if (lifetime > OPERATOR_ACCESS_MAX_DURATION_MS) {
    return false;
  }
  if (lifetime === OPERATOR_ACCESS_MAX_DURATION_MS) {
    // Whole milliseconds tie at exactly four hours: the sub-millisecond digits decide.
    return subMillisecondDigits(expiresAtIso) <= subMillisecondDigits(grantedAtIso);
  }
  return true;
}

/**
 * Validates one grant. The detector is a required parameter and is never
 * defaulted: a default "nothing is a Proxy" detector would let a hostile
 * Proxy run its traps during the snapshot. A non-function or throwing
 * detector, and every hostile or malformed grant, is `invalid-grant`.
 */
export function parseOperatorAccessGrant(raw: unknown, isProxy: IsProxy): ParseOperatorAccessGrantResult {
  try {
    if (typeof isProxy !== 'function') {
      return REFUSED_GRANT;
    }
    const read = readRecord(raw, isProxy, GRANT_KEYS);
    if (!read.ok) {
      return REFUSED_GRANT;
    }
    const record = read.value;
    for (const key of GRANT_KEYS) {
      if (!Object.hasOwn(record, key)) {
        return REFUSED_GRANT;
      }
    }
    const { actor, organizationId, reason, grantedAtIso, expiresAtIso } = record;
    if (
      !matchesBounded(actor, ACTOR_PATTERN, 128) ||
      !matchesBounded(organizationId, ORGANIZATION_ID_PATTERN, 63) ||
      typeof reason !== 'string' ||
      reason.length < 1 ||
      reason.length > MAX_OPERATOR_REASON_LENGTH ||
      hasControlCharacter(reason) ||
      !isZonedIsoDateTime(grantedAtIso) ||
      !isZonedIsoDateTime(expiresAtIso) ||
      !hasValidLifetime(grantedAtIso, expiresAtIso)
    ) {
      return REFUSED_GRANT;
    }
    return {
      outcome: 'parsed',
      grant: Object.freeze({ actor, organizationId, reason, grantedAtIso, expiresAtIso }),
    };
  } catch {
    return REFUSED_GRANT;
  }
}

/** A refusal with its audit row; the row's `reason` is the refusal code, never the grant's reason. */
function refusal(
  reason: OperatorAccessRefusalReason,
  actor: string,
  organizationId: string,
  atIso: string,
): OperatorAccessDecisionResult {
  return Object.freeze({
    outcome: 'refused',
    reason,
    audit: Object.freeze({ actor, organizationId, reason, atIso }),
  });
}

/**
 * Decides whether an operator grant lets its actor reach `organizationId` at
 * `nowIso`. Allowed from the grant's start up to, but excluding, its expiry.
 * Every decision, allowed or refused, carries one frozen audit row; a refusal
 * row never carries the grant's reason or any rejected value. `isProxy` is a
 * required detector, never defaulted.
 */
export function decideOperatorAccess(input: unknown, isProxy: IsProxy): OperatorAccessDecisionResult {
  try {
    if (typeof isProxy !== 'function') {
      return refusal('invalid-input', 'unknown', 'unknown', 'unknown');
    }
    const snapshot = snapshotPlainData(input, isProxy, ENVELOPE_LIMITS);
    if (!snapshot.ok) {
      const inGrant = snapshot.path === 'grant' || (snapshot.path?.startsWith('grant.') ?? false);
      return refusal(inGrant ? 'invalid-grant' : 'invalid-input', 'unknown', 'unknown', 'unknown');
    }
    const envelope = snapshot.value;
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      return refusal('invalid-input', 'unknown', 'unknown', 'unknown');
    }
    const record = envelope as Record<string, unknown>;
    if (checkSnapshotKeys(record, ENVELOPE_KEYS) !== null) {
      return refusal('invalid-input', 'unknown', 'unknown', 'unknown');
    }
    const organizationId = Object.hasOwn(record, 'organizationId') ? record.organizationId : undefined;
    const nowIso = Object.hasOwn(record, 'nowIso') ? record.nowIso : undefined;
    const validOrganizationId = matchesBounded(organizationId, ORGANIZATION_ID_PATTERN, 63)
      ? organizationId
      : undefined;
    const validNowIso = isZonedIsoDateTime(nowIso) ? nowIso : undefined;
    if (validOrganizationId === undefined || validNowIso === undefined) {
      return refusal('invalid-input', 'unknown', validOrganizationId ?? 'unknown', validNowIso ?? 'unknown');
    }
    const parsed = Object.hasOwn(record, 'grant')
      ? parseOperatorAccessGrant(record.grant, isProxy)
      : REFUSED_GRANT;
    if (parsed.outcome !== 'parsed') {
      return refusal('invalid-grant', 'unknown', validOrganizationId, validNowIso);
    }
    const grant = parsed.grant;
    if (grant.organizationId !== validOrganizationId) {
      return refusal('wrong-organization', grant.actor, validOrganizationId, validNowIso);
    }
    if (compareZonedIsoInstants(validNowIso, grant.grantedAtIso) < 0) {
      return refusal('not-yet-valid', grant.actor, validOrganizationId, validNowIso);
    }
    if (compareZonedIsoInstants(validNowIso, grant.expiresAtIso) >= 0) {
      return refusal('expired', grant.actor, validOrganizationId, validNowIso);
    }
    return Object.freeze({
      outcome: 'allowed',
      actor: grant.actor,
      organizationId: grant.organizationId,
      audit: Object.freeze({
        actor: grant.actor,
        organizationId: grant.organizationId,
        reason: grant.reason,
        atIso: validNowIso,
      }),
    });
  } catch {
    return refusal('invalid-input', 'unknown', 'unknown', 'unknown');
  }
}
