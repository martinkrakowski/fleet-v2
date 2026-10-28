/**
 * The attribute allow-list of run telemetry (plan §3.2): the span kinds, the
 * `RUN_TELEMETRY_ATTRIBUTES` table (55 keys, each with a type and a
 * validator), the never-sent keys and prefixes, and the resource attributes.
 * This is what reaches Phoenix (Tier 2), so every key is named here before it
 * can be sent, and a value that fails its rule drops the attribute, never the
 * span. Pure: no `node:*`, no clock, no salt — ids arrive already digested.
 */

import { containsSecretShape } from '@fleet/shared';
import { readExactPlainRecord } from './plain-record-reads.js';
import { ATTEMPT_OUTCOMES } from './value-objects/AttemptOutcome.vo.js';
import { LANE_RUN_STATES } from './value-objects/LaneRunState.vo.js';
import { SEAT_PLAN_ROLES } from './value-objects/SeatPlan.vo.js';
import { STOP_REASONS } from './value-objects/StopReason.vo.js';
import {
  LANE_RUN_JOURNAL_OUTCOMES,
  LANE_RUN_JOURNAL_REASON_CODE_PATTERN,
} from './lane-run-journal.js';
import {
  LANE_RUN_MAX_SEAT_INDEX,
  LANE_RUN_STOP_KEY_MODES,
} from './lane-run-keys.js';
import {
  LANE_RUN_ID_PATTERN,
  LANE_RUN_KEY_STEPS,
  LANE_RUN_MAX_ATTEMPTS,
  LANE_RUN_MAX_ROUND,
  LANE_RUN_PARK_QUALIFIER,
  LANE_RUN_PARK_REASONS,
  LANE_RUN_TIERS,
  RUN_STOP_REFUSAL_KINDS,
} from './lane-run-records.js';
import { TELEMETRY_DIGEST_PATTERN, TELEMETRY_SCHEMA_VERSION } from './run-telemetry-ids.js';

/** OpenInference span kinds fleet-v2 emits (plan §2.1, §3.1). */
export const TELEMETRY_SPAN_KINDS = ['CHAIN', 'AGENT', 'LLM', 'GUARDRAIL', 'EVALUATOR', 'DECISION', 'TOOL'] as const;
export type TelemetrySpanKind = (typeof TELEMETRY_SPAN_KINDS)[number];

export type TelemetryAttributeType = 'string' | 'int' | 'double' | 'string-array';
export type TelemetryAttributeValue = string | number | readonly string[];

export interface TelemetryAttributeContext {
  readonly spanKind: TelemetrySpanKind;
  /** The candidate attributes as given (own data properties only), for rules that read a sibling key. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface TelemetryAttributeRule {
  readonly type: TelemetryAttributeType;
  readonly check: (value: unknown, context: TelemetryAttributeContext) => boolean;
}

export const TELEMETRY_TAGS = ['conducted', 'hand-run', 'dry-run', 'shadow', 'tier-1', 'tier-2'] as const;
export const TELEMETRY_SEAT_TOOLS = ['opencode', 'agy', 'review-cli'] as const;
export const TELEMETRY_SEAT_BILLINGS = ['metered', 'plan', 'unknown'] as const;
export const TELEMETRY_COST_BASES = ['metered', 'plan-estimate', 'unknown'] as const;
export const TELEMETRY_USAGE_SOURCES = ['opencode-db', 'unavailable'] as const;
/** Gate, review and CI results (the evidence result values, declared here: no cross-context import). */
export const TELEMETRY_RESULTS = ['pass', 'fail', 'pending', 'unknown', 'not-applicable'] as const;
export const TELEMETRY_REVIEW_KINDS = ['brief-check', 'code-review', 'pre-merge'] as const;
export const TELEMETRY_ATTEMPT_KINDS = ['initial', 'fix'] as const;
/** Final journal outcomes (not `ambiguous`), attempt outcomes and the acceptance decision. */
export const TELEMETRY_OUTCOMES: readonly string[] = Object.freeze([
  ...LANE_RUN_JOURNAL_OUTCOMES.filter((outcome) => outcome !== 'ambiguous'),
  ...ATTEMPT_OUTCOMES,
  'accepted',
  'rejected',
]);

/** True when `value` is a member of `allowed`. The one enum check every enum key reuses. */
function oneOf(allowed: readonly (string | number)[]): (value: unknown) => boolean {
  return (value) => (typeof value === 'string' || typeof value === 'number') && allowed.includes(value);
}

/** A safe integer in the inclusive range. The one bounded-integer check every int key reuses. */
function intIn(min: number, max: number): (value: unknown) => boolean {
  return (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

const isCount = intIn(0, Number.MAX_SAFE_INTEGER);

/** A finite number ≥ 0. */
function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** An array of 1–6 entries, each in TELEMETRY_TAGS, no duplicates. */
function isTagList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    return false;
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(TELEMETRY_TAGS as readonly string[]).includes(entry) || seen.has(entry)) {
      return false;
    }
    seen.add(entry);
  }
  return true;
}

function isLlm(context: TelemetryAttributeContext): boolean {
  return context.spanKind === 'LLM';
}

function isMeteredLlm(context: TelemetryAttributeContext): boolean {
  return isLlm(context) && context.attributes['fleet.seat.billing'] === 'metered';
}

// The patterns of plan §3.2. Each validator combines its pattern with a
// secret-shape refusal: a value that reads like a credential never ships.

export const TELEMETRY_PROJECT_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * A model id: up to four `/`-separated segments of `[A-Za-z0-9._-]` and at most
 * one lowercase `:suffix` (such as `:free`). No `@`, `#`, `://` or port, so a
 * URL, an email address, a host:port or a credentialed URL never passes.
 */
export const TELEMETRY_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(?::[a-z][a-z0-9-]{0,15})?$/;
export const TELEMETRY_VARIANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TELEMETRY_SERVICE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.-]{1,32})?$/;
const HEAD12_PATTERN = /^[0-9a-f]{12}$/;

/** Alias pattern and no secret shape. */
export function isTelemetryProjectAlias(value: unknown): boolean {
  try {
    return typeof value === 'string' && TELEMETRY_PROJECT_ALIAS_PATTERN.test(value) && !containsSecretShape(value);
  } catch {
    return false;
  }
}

/** An alias or a 16-hex project digest; never secret-shaped (plan §3.2 "Project"). */
export function isTelemetryProjectValue(value: unknown): boolean {
  try {
    if (typeof value !== 'string' || containsSecretShape(value)) {
      return false;
    }
    return TELEMETRY_PROJECT_ALIAS_PATTERN.test(value) || TELEMETRY_DIGEST_PATTERN.test(value);
  } catch {
    return false;
  }
}

/** Model id pattern and no secret shape. */
export function isTelemetryModelId(value: unknown): boolean {
  try {
    return typeof value === 'string' && value.length <= 128 && TELEMETRY_MODEL_ID_PATTERN.test(value) && !containsSecretShape(value);
  } catch {
    return false;
  }
}

/** Variant pattern and no secret shape. */
export function isTelemetryVariant(value: unknown): boolean {
  try {
    return typeof value === 'string' && TELEMETRY_VARIANT_PATTERN.test(value) && !containsSecretShape(value);
  } catch {
    return false;
  }
}

/** `{"variant":"<variant>"}` (JSON.stringify of exactly that object) or null when the variant fails. */
export function telemetryInvocationParameters(variant: unknown): string | null {
  try {
    if (!isTelemetryVariant(variant)) {
      return null;
    }
    return JSON.stringify({ variant });
  } catch {
    return null;
  }
}

/** True only for the exact string telemetryInvocationParameters would build. */
export function isTelemetryInvocationParameters(value: unknown): boolean {
  try {
    if (typeof value !== 'string') {
      return false;
    }
    const parsed: unknown = JSON.parse(value);
    const record = readExactPlainRecord(parsed, ['variant']);
    if (record === null) {
      return false;
    }
    return telemetryInvocationParameters(record.variant) === value;
  } catch {
    return false;
  }
}

/** At most 64 characters, the version pattern, no secret shape. */
export function isTelemetryServiceVersion(value: unknown): boolean {
  try {
    return (
      typeof value === 'string' &&
      value.length <= 64 &&
      TELEMETRY_SERVICE_VERSION_PATTERN.test(value) &&
      !containsSecretShape(value)
    );
  } catch {
    return false;
  }
}

/**
 * The park qualifier rule (plan §3.2): LANE_RUN_PARK_QUALIFIER[reason] `step`
 * → a LANE_RUN_KEY_STEPS value; `stop-refusal` → a RUN_STOP_REFUSAL_KINDS
 * value; `none` or an unknown reason → false (the attribute is absent).
 */
export function isTelemetryParkQualifier(reason: unknown, qualifier: unknown): boolean {
  try {
    if (typeof reason !== 'string' || typeof qualifier !== 'string') {
      return false;
    }
    const rule = LANE_RUN_PARK_QUALIFIER[reason as keyof typeof LANE_RUN_PARK_QUALIFIER];
    if (rule === 'step') {
      return (LANE_RUN_KEY_STEPS as readonly string[]).includes(qualifier);
    }
    if (rule === 'stop-refusal') {
      return (RUN_STOP_REFUSAL_KINDS as readonly string[]).includes(qualifier);
    }
    return false;
  } catch {
    return false;
  }
}

const digest: TelemetryAttributeRule = { type: 'string', check: (v) => typeof v === 'string' && TELEMETRY_DIGEST_PATTERN.test(v) };
const result: TelemetryAttributeRule = { type: 'string', check: oneOf(TELEMETRY_RESULTS) };
const count: TelemetryAttributeRule = { type: 'int', check: isCount };
const llmCount: TelemetryAttributeRule = { type: 'int', check: (v, c) => isLlm(c) && isCount(v) };
const meteredModel: TelemetryAttributeRule = { type: 'string', check: (v, c) => isMeteredLlm(c) && isTelemetryModelId(v) };

export const RUN_TELEMETRY_ATTRIBUTES: Readonly<Record<string, TelemetryAttributeRule>> = Object.freeze({
  'openinference.span.kind': { type: 'string', check: oneOf(TELEMETRY_SPAN_KINDS) },
  'fleet.telemetry.schema': { type: 'int', check: (v) => v === TELEMETRY_SCHEMA_VERSION },
  'tag.tags': { type: 'string-array', check: isTagList },
  'fleet.run.id': { type: 'string', check: (v) => typeof v === 'string' && LANE_RUN_ID_PATTERN.test(v) },
  'fleet.work_order.digest': digest,
  'session.id': digest,
  'fleet.attempt.digest': digest,
  'fleet.prior_attempt.digest': digest,
  'fleet.project': { type: 'string', check: isTelemetryProjectValue },
  'fleet.step': { type: 'string', check: oneOf(LANE_RUN_KEY_STEPS) },
  'fleet.state': { type: 'string', check: oneOf(LANE_RUN_STATES) },
  'fleet.round': { type: 'int', check: intIn(0, LANE_RUN_MAX_ROUND) },
  'fleet.seat.index': { type: 'int', check: intIn(0, LANE_RUN_MAX_SEAT_INDEX) },
  'fleet.seat.role': { type: 'string', check: oneOf(SEAT_PLAN_ROLES) },
  'fleet.tier': { type: 'int', check: oneOf(LANE_RUN_TIERS) },
  'fleet.attempt.kind': { type: 'string', check: oneOf(TELEMETRY_ATTEMPT_KINDS) },
  'fleet.fix_number': { type: 'int', check: intIn(0, LANE_RUN_MAX_ATTEMPTS) },
  'fleet.outcome': { type: 'string', check: oneOf(TELEMETRY_OUTCOMES) },
  'fleet.reason_code': { type: 'string', check: (v) => typeof v === 'string' && LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(v) },
  'fleet.stop_reason': { type: 'string', check: oneOf(STOP_REASONS) },
  'fleet.park.reason': { type: 'string', check: oneOf(LANE_RUN_PARK_REASONS) },
  'fleet.park.qualifier': { type: 'string', check: (v, c) => isTelemetryParkQualifier(c.attributes['fleet.park.reason'], v) },
  'fleet.gate.result': result,
  'fleet.review.kind': { type: 'string', check: oneOf(TELEMETRY_REVIEW_KINDS) },
  'fleet.review.result': result,
  'fleet.ci.result': result,
  'fleet.stop.mode': { type: 'string', check: oneOf(LANE_RUN_STOP_KEY_MODES) },
  'fleet.review.findings.blocker': count,
  'fleet.review.findings.major': count,
  'fleet.review.findings.minor': count,
  'fleet.review.findings.nit': count,
  'fleet.gate.exit_code': { type: 'int', check: intIn(-1, 255) },
  'fleet.ambiguous_results': count,
  'fleet.usage.steps': count,
  'fleet.seat.model': { type: 'string', check: isTelemetryModelId },
  'fleet.seat.provider': { type: 'string', check: isTelemetryModelId },
  'agent.name': { type: 'string', check: oneOf(SEAT_PLAN_ROLES) },
  'fleet.seat.tool': { type: 'string', check: oneOf(TELEMETRY_SEAT_TOOLS) },
  'fleet.seat.billing': { type: 'string', check: oneOf(TELEMETRY_SEAT_BILLINGS) },
  'llm.invocation_parameters': { type: 'string', check: (v, c) => c.spanKind === 'LLM' && isTelemetryInvocationParameters(v) },
  'llm.model_name': meteredModel,
  'llm.provider': meteredModel,
  'llm.token_count.prompt': llmCount,
  'llm.token_count.completion': llmCount,
  'llm.token_count.total': llmCount,
  'llm.token_count.prompt_details.cache_read': llmCount,
  'llm.token_count.prompt_details.cache_write': llmCount,
  'llm.token_count.completion_details.reasoning': llmCount,
  'fleet.usage.source': { type: 'string', check: oneOf(TELEMETRY_USAGE_SOURCES) },
  'fleet.usage.wall_seconds': { type: 'double', check: isNonNegativeNumber },
  'llm.cost.total': { type: 'double', check: (v, c) => isMeteredLlm(c) && isNonNegativeNumber(v) },
  'fleet.cost.estimate_usd': { type: 'double', check: isNonNegativeNumber },
  'fleet.cost.basis': { type: 'string', check: oneOf(TELEMETRY_COST_BASES) },
  'fleet.pr.number': { type: 'int', check: intIn(1, Number.MAX_SAFE_INTEGER) },
  'fleet.head12': { type: 'string', check: (v) => typeof v === 'string' && HEAD12_PATTERN.test(v) },
});

/** Set only by TelemetrySpan.build (OT1a-3); filterTelemetryAttributes drops them from input. */
export const TELEMETRY_BUILDER_OWNED_KEYS = ['openinference.span.kind', 'fleet.telemetry.schema'] as const;

/** Plan §3.2 "Never sent, by construction", in OpenInference terms: exact keys and key prefixes. */
export const TELEMETRY_NEVER_SENT_KEYS = ['input.value', 'output.value', 'metadata', 'user.id'] as const;
export const TELEMETRY_NEVER_SENT_PREFIXES = [
  'llm.input_messages', 'llm.output_messages', 'llm.prompts', 'llm.prompt_template.', 'tool.', 'message.',
  'exception.', 'http.', 'url.', 'server.', 'host.', 'process.',
] as const;

export function isNeverSentTelemetryKey(key: string): boolean {
  try {
    if ((TELEMETRY_NEVER_SENT_KEYS as readonly string[]).includes(key)) {
      return true;
    }
    return TELEMETRY_NEVER_SENT_PREFIXES.some((prefix) => key.startsWith(prefix));
  } catch {
    return false;
  }
}

export const TELEMETRY_SERVICE_NAME = 'fleet-v2';
export const RUN_TELEMETRY_RESOURCE_KEYS = ['service.name', 'service.version', 'openinference.project.name'] as const;

export interface TelemetryResourceInput {
  /** The CLI package's version, a build-time constant (plan §3.2). */
  readonly serviceVersion: unknown;
  /** policy.telemetry.projectName (alias validator). */
  readonly projectName: unknown;
}

/** `service.name` always; the other two only when valid (an invalid one is dropped). Frozen; never throws. */
export function telemetryResourceAttributes(input: TelemetryResourceInput): Readonly<Record<string, string>> {
  try {
    const attributes: Record<string, string> = { 'service.name': TELEMETRY_SERVICE_NAME };
    // Each field is read once, through its own data descriptor: the value
    // validated is the value emitted, and no getter on the input runs.
    const serviceVersion: unknown = Object.getOwnPropertyDescriptor(input, 'serviceVersion')?.value;
    const projectName: unknown = Object.getOwnPropertyDescriptor(input, 'projectName')?.value;
    if (isTelemetryServiceVersion(serviceVersion)) {
      attributes['service.version'] = serviceVersion as string;
    }
    if (isTelemetryProjectAlias(projectName)) {
      attributes['openinference.project.name'] = projectName as string;
    }
    return Object.freeze(attributes);
  } catch {
    return Object.freeze({ 'service.name': TELEMETRY_SERVICE_NAME });
  }
}

/**
 * One encoding per fact: `-0` becomes `0` (an OTLP double encodes them
 * differently), and a tag list is emitted in TELEMETRY_TAGS order whatever
 * the input order.
 */
function canonicalValue(value: unknown): TelemetryAttributeValue {
  if (Array.isArray(value)) {
    const order = TELEMETRY_TAGS as readonly string[];
    return Object.freeze(value.slice().sort((a, b) => order.indexOf(String(a)) - order.indexOf(String(b)))) as TelemetryAttributeValue;
  }
  if (value === 0) {
    return 0;
  }
  return value as TelemetryAttributeValue;
}

/**
 * A plain copy of an input array read through own data descriptors only, so
 * neither an iterator nor a getter on the input runs; null when any index is
 * not a plain data property. Validation and output both use this copy.
 */
function plainArrayCopyOf(value: readonly unknown[]): unknown[] | null {
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  // The only array rule is the tag list, so nothing longer is ever copied.
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > TELEMETRY_TAGS.length) {
    return null;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    copy.push(descriptor.value);
  }
  return copy;
}

/**
 * Keep only allow-listed keys whose value passes its rule (plan §3.2). Output
 * keys follow the order of RUN_TELEMETRY_ATTRIBUTES whatever the input order,
 * so the same facts always encode to the same bytes. Builder-owned keys are
 * dropped. Values are read through own property descriptors (no getter runs);
 * a non-plain input, or any throw, gives a frozen `{}`. String arrays are
 * copied and frozen.
 */
export function filterTelemetryAttributes(
  input: unknown,
  spanKind: TelemetrySpanKind,
): Readonly<Record<string, TelemetryAttributeValue>> {
  try {
    if (!(TELEMETRY_SPAN_KINDS as readonly string[]).includes(spanKind)) {
      return Object.freeze({});
    }
    if (typeof input !== 'object' || input === null) {
      return Object.freeze({});
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return Object.freeze({});
    }
    // A null-prototype snapshot: an own `__proto__` key stays a plain key and
    // can never supply an inherited sibling (such as a billing class).
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable) {
        snapshot[key] = Array.isArray(descriptor.value) ? plainArrayCopyOf(descriptor.value) : descriptor.value;
      }
    }
    const output: Record<string, TelemetryAttributeValue> = {};
    for (const key of Object.keys(RUN_TELEMETRY_ATTRIBUTES)) {
      if ((TELEMETRY_BUILDER_OWNED_KEYS as readonly string[]).includes(key)) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
        continue;
      }
      const value = snapshot[key];
      const rule = RUN_TELEMETRY_ATTRIBUTES[key];
      if (rule.check(value, { spanKind, attributes: snapshot })) {
        output[key] = canonicalValue(value);
      }
    }
    return Object.freeze(output);
  } catch {
    return Object.freeze({});
  }
}
