/**
 * The pure stall rule set over a conductor snapshot (SN1). Lanes and work
 * stall silently: runs park with nobody told, the driver stops adopting runs,
 * reviews keep failing. This module answers the deterministic findings for
 * one snapshot: no I/O, no clock reads (`nowIso` is passed in), no
 * randomness, never an exception. SN2 feeds it real data and turns findings
 * into attention items.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS, readPlainRecord } from '@fleet/shared';
import { isCanonicalIso } from './lane-activity-records.js';
import { REAPER_SUBJECT_ID_PATTERN } from './lane-run-keys.js';

/** The severities a stall finding may carry. */
export type StallSeverity = 'page' | 'digest';

/** The fixed rule codes. */
export type StallRule =
  | 'unowned-park'
  | 'driver-absent'
  | 'driver-not-adopting'
  | 'review-failing'
  | 'admission-loop'
  | 'provider-limit'
  | 'snapshot-invalid'
  | 'truncated';

/** The run states the snapshot carries; the terminal ones end every rule. */
export type StallRunState =
  | 'queued'
  | 'ready'
  | 'dispatching'
  | 'running'
  | 'parked'
  | 'review'
  | 'fixing'
  | 'watching-ci'
  | 'merging'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'merged';

const NON_TERMINAL_RUN_STATES: readonly string[] = [
  'queued',
  'ready',
  'dispatching',
  'running',
  'parked',
  'review',
  'fixing',
  'watching-ci',
  'merging',
];

/** One run in the snapshot. Ids and codes only; no free text. */
export interface StallRun {
  readonly id: string;
  readonly state: StallRunState | string;
  readonly parkedAtIso?: string;
  readonly parkReason?: string;
  readonly prNumber?: number;
  readonly handOwned: boolean;
  readonly lastAdvancedAtIso?: string;
  readonly recentReviewCodes?: readonly string[];
}

/** The driver lease fact of the snapshot. */
export interface StallDriverLease {
  readonly present: boolean;
  readonly lapsed?: boolean;
}

/** One admission refusal series for one lane. */
export interface StallAdmissionRefusal {
  readonly laneId: string;
  readonly count: number;
  readonly firstAtIso: string;
}

/** One provider error. */
export interface StallProviderError {
  readonly provider: string;
  readonly class: 'payment-required' | 'rate-limited' | 'usage-limit' | string;
  readonly atIso: string;
}

/** The plain, readonly snapshot the rules read. */
export interface StallSnapshot {
  readonly runs: readonly StallRun[];
  readonly driverLease: StallDriverLease;
  readonly admissionRefusals?: readonly StallAdmissionRefusal[];
  readonly providerErrors?: readonly StallProviderError[];
}

/** The thresholds, each read from its default when missing or not a non-negative finite number. */
export interface StallThresholds {
  readonly parkedMinutes: number;
  readonly unadvancedMinutes: number;
  readonly reviewFailures: number;
  readonly admissionRefusals: number;
  readonly admissionHours: number;
}

/** The defaults of the brief. */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = Object.freeze({
  parkedMinutes: 30,
  unadvancedMinutes: 15,
  reviewFailures: 2,
  admissionRefusals: 6,
  admissionHours: 2,
});

/** One finding: fixed rule code, severity, stable key, ids only, bounded evidence. */
export interface StallFinding {
  readonly rule: StallRule;
  readonly severity: StallSeverity;
  readonly key: string;
  readonly subjectIds: readonly string[];
  readonly evidence: Readonly<Record<string, string | number | null>>;
}

/** At most this many findings before one `truncated` finding is added. */
export const STALL_FINDINGS_MAX = 200;

/** The review journal codes that count as a failing review. */
const FAILING_REVIEW_CODES: readonly string[] = [
  'review-no-receipt',
  'seat-busy',
  'review-unknown',
  'unparseable-verdict',
];

/** The provider error classes that count as a provider limit. */
const LIMITING_PROVIDER_CLASSES: readonly string[] = ['payment-required', 'rate-limited', 'usage-limit'];

/** Milliseconds of one minute and of one hour. */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * A subject that is not an identifier but a credential-shaped string (a token
 * pasted where an id belongs). The broad printable-ASCII id pattern cannot
 * tell them apart, so these shapes are rejected explicitly: a secret never
 * reaches a finding.
 */
const SECRET_SHAPED_ID_PATTERN =
  /^(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|sk-(?:ant-)?[A-Za-z0-9_-]+|xox[bpas]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]+)$/;

/** True when `text` matches any repository secret detector. Pure, no I/O. */
function isSecretShaped(text: string): boolean {
  if (containsSecretShape(text) || containsSecretShape(text.replace(/ /g, ''))) {
    return true;
  }
  for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      return true;
    }
  }
  return SECRET_SHAPED_ID_PATTERN.test(text);
}

/**
 * The safe-id rule: only ids that pass the existing bounded identifier shape
 * and no secret detector appear; anything else reads as `<redacted>`, so a
 * run id or PR shaped like a secret is never copied into a finding.
 */
function safeId(value: unknown): string {
  if (typeof value !== 'string' || !REAPER_SUBJECT_ID_PATTERN.test(value) || isSecretShaped(value)) {
    return '<redacted>';
  }
  return value;
}

/** A threshold number: missing, non-finite or negative reads as the default. */
function thresholdOf(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** `Date.parse` that never throws: an unparsable or non-string time reads as null. */
function msOf(iso: unknown): number | null {
  if (typeof iso !== 'string') {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The bytewise comparator, written with `if` statements: less when the first
 * differing code unit is smaller, then shorter when one is a prefix.
 */
function bytewiseLess(a: string, b: string): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (i >= b.length) {
      return false;
    }
    const aCode = a.charCodeAt(i);
    const bCode = b.charCodeAt(i);
    if (aCode !== bCode) {
      if (aCode < bCode) {
        return true;
      }
      return false;
    }
  }
  if (a.length < b.length) {
    return true;
  }
  return false;
}

/** The deterministic order: `page` first, then rule, then key, all bytewise. */
function compareFindings(a: StallFinding, b: StallFinding): number {
  const aRank = a.severity === 'page' ? 0 : 1;
  const bRank = b.severity === 'page' ? 0 : 1;
  if (aRank !== bRank) {
    if (aRank < bRank) {
      return -1;
    }
    return 1;
  }
  if (a.rule !== b.rule) {
    if (bytewiseLess(a.rule, b.rule)) {
      return -1;
    }
    return 1;
  }
  if (a.key !== b.key) {
    if (bytewiseLess(a.key, b.key)) {
      return -1;
    }
    return 1;
  }
  return 0;
}

/** Builds a frozen finding with its stable key (rule plus safe ids only). */
function finding(
  rule: StallRule,
  severity: StallSeverity,
  subjectIds: readonly string[],
  evidence: Readonly<Record<string, string | number | null>>,
): StallFinding {
  const ids = subjectIds.map((id) => safeId(id));
  const key = ids.length === 0 ? `${rule}:snapshot` : `${rule}:${ids.join(':')}`;
  return Object.freeze({
    rule,
    severity,
    key,
    subjectIds: Object.freeze(ids),
    evidence: Object.freeze({ ...evidence }),
  });
}

/** The `snapshot-invalid` finding for one named field; the field path is its stable key. */
function invalidFinding(field: string, reason: string): StallFinding {
  return Object.freeze({
    rule: 'snapshot-invalid' as const,
    severity: 'digest' as const,
    key: `snapshot-invalid:${field}`,
    subjectIds: Object.freeze([] as string[]),
    evidence: Object.freeze({ field, reason }),
  });
}

/** Whether a run's state is a known non-terminal state. Unknown stays unknown. */
function isNonTerminal(state: unknown): boolean {
  return typeof state === 'string' && NON_TERMINAL_RUN_STATES.includes(state);
}

/** The runtime schema of one run entry. */
const RUN_SCHEMA = {
  id: { kind: 'string', maxLength: 128 },
  state: { kind: 'string', maxLength: 32 },
  parkedAtIso: { kind: 'string', maxLength: 40, optional: true },
  parkReason: { kind: 'string', maxLength: 64, optional: true },
  prNumber: { kind: 'integer', min: 0, optional: true },
  handOwned: { kind: 'boolean' },
  lastAdvancedAtIso: { kind: 'string', maxLength: 40, optional: true },
  recentReviewCodes: {
    kind: 'array',
    items: { kind: 'string', maxLength: 64 },
    maxLength: 64,
    optional: true,
  },
} as const;

/** The runtime schema of the whole snapshot (depth 2, within MAX_DEPTH). */
const SNAPSHOT_SCHEMA = {
  runs: { kind: 'array', items: { kind: 'record', schema: RUN_SCHEMA }, maxLength: 500 },
  driverLease: {
    kind: 'record',
    schema: {
      present: { kind: 'boolean' },
      lapsed: { kind: 'boolean', optional: true },
    },
  },
  admissionRefusals: {
    kind: 'array',
    items: {
      kind: 'record',
      schema: {
        laneId: { kind: 'string', maxLength: 128 },
        count: { kind: 'integer', min: 0 },
        firstAtIso: { kind: 'string', maxLength: 40 },
      },
    },
    maxLength: 500,
    optional: true,
  },
  providerErrors: {
    kind: 'array',
    items: {
      kind: 'record',
      schema: {
        provider: { kind: 'string', maxLength: 128 },
        class: { kind: 'string', maxLength: 64 },
        atIso: { kind: 'string', maxLength: 40 },
      },
    },
    maxLength: 500,
    optional: true,
  },
} as const;

/**
 * The one entry point: the deterministic, total findings for one snapshot.
 * Never throws: a malformed snapshot (null, a missing array, a throwing
 * getter, a wrong-typed field) answers one `snapshot-invalid` finding naming
 * the field, never an exception. An unparseable ISO time is treated as
 * unknown: it fires no time-based rule and yields one `snapshot-invalid`
 * finding naming its field. A run that needs a timestamp for its time-based
 * rule (a parked run its `parkedAtIso`, any other non-terminal run its
 * `lastAdvancedAtIso`) must carry it; a missing one is one
 * `snapshot-invalid` finding naming the field, never a silent skip.
 * The output is sorted (`page` first, then rule, then key, bytewise),
 * capped at `STALL_FINDINGS_MAX` plus one `truncated` finding, and frozen.
 */
export function detectStalls(
  snapshot: StallSnapshot,
  thresholds: StallThresholds,
  nowIso: string,
): readonly StallFinding[] {
  try {
    return detectStallsInner(snapshot, thresholds, nowIso);
  } catch {
    return Object.freeze([invalidFinding('snapshot', 'hostile')]);
  }
}

function detectStallsInner(
  snapshot: unknown,
  thresholds: StallThresholds,
  nowIso: unknown,
): readonly StallFinding[] {
  const read = readPlainRecord(snapshot, SNAPSHOT_SCHEMA);
  if (!read.ok) {
    return [invalidFinding(read.field ?? 'snapshot', read.reason)];
  }
  const validated = read.value;

  const parkedMinutes = thresholdOf(thresholds?.parkedMinutes, DEFAULT_STALL_THRESHOLDS.parkedMinutes);
  const unadvancedMinutes = thresholdOf(
    thresholds?.unadvancedMinutes,
    DEFAULT_STALL_THRESHOLDS.unadvancedMinutes,
  );
  const reviewFailures = thresholdOf(thresholds?.reviewFailures, DEFAULT_STALL_THRESHOLDS.reviewFailures);
  const admissionRefusalLimit = thresholdOf(
    thresholds?.admissionRefusals,
    DEFAULT_STALL_THRESHOLDS.admissionRefusals,
  );
  const admissionHours = thresholdOf(thresholds?.admissionHours, DEFAULT_STALL_THRESHOLDS.admissionHours);

  const nowValid = isCanonicalIso(nowIso);
  const nowMs = nowValid ? msOf(nowIso) : null;

  const findings: StallFinding[] = [];

  const runs = validated.runs as readonly Record<string, unknown>[];
  const lease = validated.driverLease as Record<string, unknown>;
  const refusals = (validated.admissionRefusals ?? []) as readonly Record<string, unknown>[];
  const providerErrors = (validated.providerErrors ?? []) as readonly Record<string, unknown>[];

  // The driver-absent rule: no live lease while non-terminal runs exist.
  // Not time-based, so an invalid `nowIso` does not silence it.
  if (!lease.present || lease.lapsed === true) {
    let nonTerminalRuns = 0;
    for (const run of runs) {
      if (isNonTerminal(run.state)) {
        nonTerminalRuns += 1;
      }
    }
    if (nonTerminalRuns > 0) {
      findings.push(finding('driver-absent', 'page', [], {
        nonTerminalRuns,
        lease: lease.present ? 'lapsed' : 'missing',
      }));
    }
  }

  // The review-failing rule: not time-based either.
  for (const run of runs) {
    const codes = Array.isArray(run.recentReviewCodes) ? run.recentReviewCodes : [];
    let failures = 0;
    for (const code of codes) {
      if (typeof code === 'string' && FAILING_REVIEW_CODES.includes(code)) {
        failures += 1;
      }
    }
    if (failures >= reviewFailures) {
      findings.push(finding('review-failing', 'digest', [String(run.id)], {
        runId: safeId(run.id),
        failures,
      }));
    }
  }

  // The provider-limit rule: one finding per provider; not time-based.
  const limitedProviders = new Map<string, Record<string, unknown>>();
  for (const error of providerErrors) {
    if (typeof error.class === 'string' && LIMITING_PROVIDER_CLASSES.includes(error.class)) {
      const provider = String(error.provider);
      if (!limitedProviders.has(provider)) {
        limitedProviders.set(provider, error);
      }
    }
  }
  const providerKeys = Array.from(limitedProviders.keys()).sort();
  for (const provider of providerKeys) {
    const error = limitedProviders.get(provider) as Record<string, unknown>;
    findings.push(finding('provider-limit', 'page', [provider], {
      provider: safeId(provider),
      errorClass: String(error.class),
      atIso: isCanonicalIso(error.atIso) ? error.atIso : null,
    }));
  }

  // The time-based run rules; each is skipped for a run whose time field is
  // missing or not a canonical ISO time, and one `snapshot-invalid` finding
  // names it: a parked run must carry `parkedAtIso`, and any other
  // non-terminal run must carry `lastAdvancedAtIso`, so a missing timestamp
  // never silences a time-based rule.
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const runId = String(run.id);
    const nonTerminal = isNonTerminal(run.state);
    const parked = run.state === 'parked';
    const parkedMissing = parked && run.parkedAtIso === undefined;
    const advancedMissing = nonTerminal && !parked && run.lastAdvancedAtIso === undefined;
    if (parkedMissing) {
      findings.push(invalidFinding(`runs[${i}].parkedAtIso`, 'missing-time'));
    }
    if (advancedMissing) {
      findings.push(invalidFinding(`runs[${i}].lastAdvancedAtIso`, 'missing-time'));
    }
    let parkedValid = !parkedMissing;
    let advancedValid = !advancedMissing;
    if (run.parkedAtIso !== undefined && !isCanonicalIso(run.parkedAtIso)) {
      parkedValid = false;
      findings.push(invalidFinding(`runs[${i}].parkedAtIso`, 'invalid-time'));
    }
    if (run.lastAdvancedAtIso !== undefined && !isCanonicalIso(run.lastAdvancedAtIso)) {
      advancedValid = false;
      findings.push(invalidFinding(`runs[${i}].lastAdvancedAtIso`, 'invalid-time'));
    }
    if (parked && parkedValid && nowValid
      && run.prNumber === undefined && run.handOwned === false) {
      const parkedMs = msOf(run.parkedAtIso);
      if (parkedMs !== null && nowMs !== null) {
        const minutes = Math.floor((nowMs - parkedMs) / MINUTE_MS);
        if (minutes > parkedMinutes) {
          findings.push(finding('unowned-park', 'digest', [runId], {
            runId: safeId(runId),
            parkedAtIso: String(run.parkedAtIso),
            minutes,
          }));
        }
      }
    }
    if (nonTerminal && !parked && advancedValid && nowValid) {
      const advancedMs = msOf(run.lastAdvancedAtIso);
      if (advancedMs !== null && nowMs !== null) {
        const minutes = Math.floor((nowMs - advancedMs) / MINUTE_MS);
        if (minutes > unadvancedMinutes) {
          findings.push(finding('driver-not-adopting', 'page', [runId], {
            runId: safeId(runId),
            lastAdvancedAtIso: String(run.lastAdvancedAtIso),
            minutes,
          }));
        }
      }
    }
  }

  // The admission-loop rule: the count branch is not time-based; the age
  // branch is, and needs a canonical `nowIso` and `firstAtIso`.
  for (let i = 0; i < refusals.length; i += 1) {
    const refusal = refusals[i];
    const count = refusal.count;
    const laneId = String(refusal.laneId);
    let firstAtIso: string | null = null;
    if (!isCanonicalIso(refusal.firstAtIso)) {
      findings.push(invalidFinding(`admissionRefusals[${i}].firstAtIso`, 'invalid-time'));
    } else {
      firstAtIso = refusal.firstAtIso;
    }
    const countBranch = typeof count === 'number' && count > admissionRefusalLimit;
    const ageBranch = firstAtIso !== null && nowValid && nowMs !== null
      && msOf(firstAtIso) !== null
      && nowMs - (msOf(firstAtIso) as number) > admissionHours * HOUR_MS;
    if (countBranch || ageBranch) {
      findings.push(finding('admission-loop', 'digest', [laneId], {
        laneId: safeId(laneId),
        refusals: typeof count === 'number' ? count : 0,
        firstAtIso,
      }));
    }
  }

  // An invalid clock value names its field; the time-based rules above were
  // already silenced.
  if (!nowValid) {
    findings.push(invalidFinding('nowIso', 'invalid-time'));
  }

  findings.sort(compareFindings);

  if (findings.length > STALL_FINDINGS_MAX) {
    const dropped = findings.length - STALL_FINDINGS_MAX;
    const capped = findings.slice(0, STALL_FINDINGS_MAX);
    capped.push(finding('truncated', 'digest', [], { dropped }));
    capped.sort(compareFindings);
    return Object.freeze(capped);
  }
  return Object.freeze(findings);
}
