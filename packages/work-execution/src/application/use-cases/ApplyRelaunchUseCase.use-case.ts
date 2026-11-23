// AR2a2 — ApplyRelaunchUseCase: request validation, trusted-clock budget
// checks, stored-plan digest verification, journal replay derivation and the
// dry-run summary. The live apply (authorization, save, abort, adopt,
// redispatch) belongs to AR2b: an `apply: true` request is refused with
// `grant-missing` or `live-apply-not-implemented`, and
// `ActionAuthorizationPort.authorizeRelaunchApply` is never called here.
//
// `applyRelaunch` takes `unknown` and never throws. Results carry ids, codes,
// digests and statuses only: never a worktree path, a clone path, an
// exception message or a secret value. Untrusted objects are read through
// their own property descriptors, so no getter ever runs.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  readBoundedDenseArray,
  readPlainRecordWithOptionalKeys,
  snapshotPlainDataRecord,
} from '../../domain/plain-record-reads.js';
import {
  MAX_RELAUNCH_APPLY_ENTRIES,
  MAX_RELAUNCH_APPLY_LANES,
  canonicalSaveInputJson,
  deriveAdoptStepStatus,
  relaunchApplyLaneProgress,
  verifySaveIntentDigest,
  type RelaunchApplyStepStatus,
} from '../../domain/relaunch-apply.js';
import { relaunchStepStatus } from '../../domain/relaunch-step-ledger.js';
import { validateStoredRelaunchPlan } from '../../domain/relaunch-plan-validation.js';
import type {
  ApplyRelaunchLaneSummary,
  ApplyRelaunchPort,
  ApplyRelaunchResult,
  ApplyRelaunchSaveInput,
} from '../ports/in/ApplyRelaunchPort.in-port.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
  type RelaunchPlanRepositoryPort,
  type RelaunchStepCode,
} from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';

export interface ApplyRelaunchDependencies {
  readonly planRepo: Pick<RelaunchPlanRepositoryPort, 'findByDigest'>;
  readonly cutoverJournal: Pick<CutoverJournalPort, 'listByKeyPrefix'>;
  readonly computeDigest: (text: string) => string;
  /** Kept for AR2b's live apply; AR2a2 never calls it. */
  readonly authorization?: Pick<ActionAuthorizationPort, 'authorizeRelaunchApply'>;
  /** The trusted clock for the deadline check; never `request.nowIso`. */
  readonly clock?: () => string;
}

/** Every string the request carries is bounded; a longer one is unreadable. */
const MAX_TEXT_LENGTH = 4096;

const PLAN_DIGEST = /^[0-9a-f]{64}$/;

const SAVE_INPUT_REQUIRED_KEYS = [
  'laneId',
  'attemptId',
  'worktreePath',
  'clonePath',
  'recordedHost',
  'baseCommit',
  'allowedPathPrefixes',
] as const;
const SAVE_INPUT_OPTIONAL_KEYS = ['policyProtectedPaths'] as const;

const ABSENT = Symbol('absent');
const BAD = Symbol('bad');

/** An own data property of a plain object: ABSENT when missing, BAD for a getter, a setter or a non-plain object. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return BAD;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return BAD;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return ABSENT;
  if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) return BAD;
  return descriptor.value;
}

function hasSecretShape(value: string): boolean {
  return (
    containsSecretShape(value) ||
    LANE_DIFF_SECRET_PATTERNS.some((entry) => new RegExp(entry.regex.source, entry.regex.flags.replace('g', '')).test(value))
  );
}

/** The bounded secret scan: nodes and depth are capped, so the cost is O(nodes). */
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_NODES = 256;

/**
 * Whether any reachable string value matches a secret shape. Values are read
 * through their own descriptors only; an accessor, a throwing inspection or
 * an over-deep or over-wide graph returns `null` (unreadable), never `false`.
 */
function scanForSecret(value: unknown, depth: number, budget: { nodes: number }): boolean | null {
  if (value === null) return false;
  if (typeof value === 'string') {
    // Cost bound: the length cap refuses an enormous string in O(1) before
    // any pattern scan runs.
    if (value.length > MAX_TEXT_LENGTH) return null;
    return hasSecretShape(value);
  }
  if (typeof value !== 'object') return false;
  if (depth >= MAX_SCAN_DEPTH) return null;
  if (Array.isArray(value)) {
    const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_ENTRIES);
    if (dense === null) return null;
    for (const element of dense.array) {
      budget.nodes -= 1;
      if (budget.nodes < 0) return null;
      const found = scanForSecret(element, depth + 1, budget);
      if (found !== false) return found;
    }
    return false;
  }
  const snapshot = snapshotPlainDataRecord(value);
  if (snapshot === null) return null;
  for (const key of Object.keys(snapshot)) {
    budget.nodes -= 1;
    if (budget.nodes < 0) return null;
    const found = scanForSecret(snapshot[key], depth + 1, budget);
    if (found !== false) return found;
  }
  return false;
}

/**
 * The request's save inputs, keyed by `laneId` in a `Map` (`'__proto__'`,
 * `'.'` and `'..'` are valid lane ids, so a plain object would pollute or
 * collide). Each element is read exactly once through its own descriptors;
 * any hole, accessor, extra key, bad field or duplicate lane id is `null`.
 */
function readSaveInputs(value: unknown): Map<string, ApplyRelaunchSaveInput> | 'secret-detected' | null {
  const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_LANES);
  if (dense === null) return null;
  const map = new Map<string, ApplyRelaunchSaveInput>();
  for (const element of dense.array) {
    const fields = readPlainRecordWithOptionalKeys(element, SAVE_INPUT_REQUIRED_KEYS, SAVE_INPUT_OPTIONAL_KEYS);
    if (fields === null) return null;
    // Secret screening runs over every reachable string before any other
    // field check: a secret is reported as such, never echoed or stored; an
    // unreadable graph (accessor, over-wide, over-deep) is invalid-request.
    const secret = scanForSecret(element, 0, { nodes: MAX_SCAN_NODES });
    if (secret === true) return 'secret-detected';
    if (secret === null) return null;
    const laneId: unknown = fields['laneId'];
    const attemptId: unknown = fields['attemptId'];
    if (typeof laneId !== 'string' || laneId === '') return null;
    // `attemptId` is never `null` and never empty: a lane without an attempt
    // is planned with no save input at all.
    if (typeof attemptId !== 'string' || attemptId === '') return null;
    if (map.has(laneId)) return null;
    map.set(laneId, element as ApplyRelaunchSaveInput);
  }
  return map;
}

/**
 * One journal entry read exactly once through its own data descriptors, so no
 * getter ever runs on `key`, `kind`, `outcome` or `digest`. `null` when the
 * entry is not a plain record with an own enumerable string `key` and `kind`,
 * an optional string-or-null `outcome` and `digest`, and no accessor on any
 * own key.
 */
interface SnapshotEntry {
  readonly key: string;
  readonly kind: string;
  readonly outcome: undefined | string | null;
  readonly digest: undefined | string | null;
}

function snapshotJournalEntry(item: unknown): SnapshotEntry | null {
  if (item === null || typeof item !== 'object') return null;
  try {
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const ownKey of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, ownKey);
      if (descriptor === undefined) return null;
      if (descriptor.enumerable !== true) return null;
      if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) return null;
      descriptors.set(ownKey, descriptor);
    }
    const keyDescriptor = descriptors.get('key');
    if (keyDescriptor === undefined || typeof keyDescriptor.value !== 'string') return null;
    const kindDescriptor = descriptors.get('kind');
    if (kindDescriptor === undefined || typeof kindDescriptor.value !== 'string') return null;
    const outcomeDescriptor = descriptors.get('outcome');
    const digestDescriptor = descriptors.get('digest');
    const outcome = outcomeDescriptor === undefined ? undefined : outcomeDescriptor.value;
    const digest = digestDescriptor === undefined ? undefined : digestDescriptor.value;
    if (outcome !== undefined && outcome !== null && typeof outcome !== 'string') return null;
    if (digest !== undefined && digest !== null && typeof digest !== 'string') return null;
    return { key: keyDescriptor.value, kind: kindDescriptor.value, outcome, digest };
  } catch {
    return null;
  }
}

/** One lane's per-step statuses and next action, derived from the snapshot only. */
interface LaneDerivation {
  readonly stepStatuses: readonly { readonly step: RelaunchStepCode; readonly status: RelaunchApplyStepStatus }[];
  readonly nextAction: ReturnType<typeof relaunchApplyLaneProgress>;
}

function deriveLane(
  snapshot: readonly SnapshotEntry[],
  planDigest: string,
  lane: {
    readonly laneId: string;
    readonly steps: readonly { readonly step: RelaunchStepCode; readonly idempotencyKey: string }[];
  },
): LaneDerivation | null {
  const stepStatuses: { step: RelaunchStepCode; status: RelaunchApplyStepStatus }[] = [];
  for (const step of lane.steps) {
    const status =
      step.step === 'adopt'
        ? deriveAdoptStepStatus(snapshot, planDigest, lane.laneId)
        : relaunchStepStatus(snapshot, step.idempotencyKey);
    stepStatuses.push({ step: step.step, status });
  }
  return { stepStatuses, nextAction: relaunchApplyLaneProgress(stepStatuses) };
}

export class ApplyRelaunchUseCase implements ApplyRelaunchPort {
  constructor(private readonly deps?: ApplyRelaunchDependencies) {}

  async execute(input: unknown): Promise<ApplyRelaunchResult> {
    return this.applyRelaunch(input);
  }

  async applyRelaunch(request: unknown): Promise<ApplyRelaunchResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ApplyRelaunchUseCase');
    }
    const deps = this.deps;

    // ---- Step 2: defensive request parsing (no outbound call yet). ----
    if (own(request, 'planDigest') === BAD) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const planDigestValue = own(request, 'planDigest');
    if (planDigestValue === ABSENT || typeof planDigestValue !== 'string') {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (!PLAN_DIGEST.test(planDigestValue)) {
      return { outcome: 'refused', reason: 'invalid-plan-digest' };
    }
    const planDigest = planDigestValue;

    const applyValue = own(request, 'apply');
    if (applyValue === BAD) return { outcome: 'refused', reason: 'invalid-request' };
    const apply = applyValue === ABSENT ? false : applyValue;
    if (typeof apply !== 'boolean') return { outcome: 'refused', reason: 'invalid-request' };

    const grantValue = own(request, 'grantId');
    if (grantValue === BAD) return { outcome: 'refused', reason: 'invalid-request' };
    const grantId = grantValue === ABSENT || grantValue === null ? null : grantValue;
    if (grantId !== null && typeof grantId !== 'string') {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (grantId !== null && hasSecretShape(grantId)) {
      return { outcome: 'refused', reason: 'secret-detected' };
    }

    const nowValue = own(request, 'nowIso');
    if (nowValue === ABSENT || nowValue === BAD) return { outcome: 'refused', reason: 'invalid-request' };
    if (!isZonedIsoDateTime(nowValue)) return { outcome: 'refused', reason: 'invalid-clock' };

    const deadlineValue = own(request, 'deadlineIso');
    if (deadlineValue === BAD) return { outcome: 'refused', reason: 'invalid-request' };
    const deadlineIso =
      deadlineValue === ABSENT || deadlineValue === null ? null : deadlineValue;
    if (deadlineIso !== null && !isZonedIsoDateTime(deadlineIso)) {
      return { outcome: 'refused', reason: 'invalid-clock' };
    }
    const deadlineMs = deadlineIso === null ? null : Date.parse(deadlineIso);

    const saveInputsValue = own(request, 'saveInputs');
    if (saveInputsValue === BAD) return { outcome: 'refused', reason: 'invalid-request' };
    const saveInputs =
      saveInputsValue === ABSENT ? new Map<string, ApplyRelaunchSaveInput>() : readSaveInputs(saveInputsValue);
    if (saveInputs === 'secret-detected') return { outcome: 'refused', reason: 'secret-detected' };
    if (saveInputs === null) return { outcome: 'refused', reason: 'invalid-request' };

    // ---- Trusted clock & deadline, before any outbound call. ----
    const readNow = (): string | null => {
      try {
        const nowText = deps.clock !== undefined ? deps.clock() : new Date().toISOString();
        if (typeof nowText !== 'string') return null;
        if (!isZonedIsoDateTime(nowText) || Number.isNaN(Date.parse(nowText))) return null;
        return nowText;
      } catch {
        return null;
      }
    };
    const budgetExhausted = (): ApplyRelaunchResult => ({ outcome: 'refused', reason: 'budget-exhausted' });
    const isExpired = (nowText: string): boolean =>
      deadlineMs !== null && Date.parse(nowText) >= deadlineMs;

    const nowText = readNow();
    if (nowText === null || isExpired(nowText)) return budgetExhausted();

    // ---- Step 3: load, validate and digest-verify the stored plan. ----
    let found: unknown;
    try {
      found = await deps.planRepo.findByDigest(planDigest);
    } catch {
      return { outcome: 'refused', reason: 'plan-unreadable' };
    }
    if (found === null || typeof found !== 'object') {
      return { outcome: 'refused', reason: 'plan-unreadable' };
    }
    const record = found as {
      outcome?: unknown;
      reason?: unknown;
      plan?: unknown;
    };
    let plan: unknown;
    if (record.outcome === 'found') {
      plan = record.plan;
    } else if (record.outcome === 'absent') {
      return { outcome: 'refused', reason: 'plan-not-found' };
    } else if (record.outcome === 'unreadable' && record.reason === 'unknown-version') {
      return { outcome: 'refused', reason: 'plan-unknown-version' };
    } else if (record.outcome === 'refused' && record.reason === 'invalid-digest') {
      return { outcome: 'refused', reason: 'invalid-plan-digest' };
    } else {
      return { outcome: 'refused', reason: 'plan-unreadable' };
    }
    const validation = validateStoredRelaunchPlan(plan);
    if (!validation.ok) {
      return { outcome: 'refused', reason: 'invalid-plan' };
    }
    const storedPlan = plan as RelaunchPlanRecord;

    let computedDigest: unknown;
    try {
      computedDigest = deps.computeDigest(canonicalRelaunchPlanBodyJson(storedPlan));
    } catch {
      return { outcome: 'refused', reason: 'plan-unreadable' };
    }
    if (computedDigest !== storedPlan.planDigest || computedDigest !== planDigest) {
      return { outcome: 'refused', reason: 'plan-digest-mismatch' };
    }

    // ---- Step 4: apply-path refusal (authorization is never called here). ----
    if (apply) {
      if (typeof grantId !== 'string' || grantId.trim() === '') {
        return { outcome: 'refused', reason: 'grant-missing' };
      }
      return { outcome: 'refused', reason: 'live-apply-not-implemented' };
    }

    // ---- Step 5: journal read, snapshot and replay derivation. ----
    const nowBeforeJournal = readNow();
    if (nowBeforeJournal === null || isExpired(nowBeforeJournal)) return budgetExhausted();

    let listing: unknown;
    try {
      listing = await deps.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/`);
    } catch {
      return { outcome: 'refused', reason: 'journal-unreadable' };
    }
    if (listing === null || typeof listing !== 'object' || (listing as { outcome?: unknown }).outcome !== 'listed') {
      return { outcome: 'refused', reason: 'journal-unreadable' };
    }
    const denseEntries = readBoundedDenseArray((listing as { entries?: unknown }).entries, MAX_RELAUNCH_APPLY_ENTRIES);
    if (denseEntries === null) return { outcome: 'refused', reason: 'journal-unreadable' };
    const snapshot: SnapshotEntry[] = [];
    for (const item of denseEntries.array) {
      const entry = snapshotJournalEntry(item);
      if (entry === null) return { outcome: 'refused', reason: 'journal-unreadable' };
      snapshot.push(entry);
    }

    const lanes: ApplyRelaunchLaneSummary[] = [];
    for (const lane of storedPlan.lanes) {
      for (const step of lane.steps) {
        if (step.step !== 'save') continue;
        const intent = snapshot.find((entry) => entry.key === step.idempotencyKey && entry.kind === 'intent');
        if (intent === undefined) continue;
        const saveInput = saveInputs.get(lane.laneId);
        if (saveInput === undefined) continue;
        const canonicalJson = canonicalSaveInputJson(planDigest, saveInput);
        if (canonicalJson === null) return { outcome: 'refused', reason: 'invalid-request' };
        let currentDigest: unknown;
        try {
          currentDigest = deps.computeDigest(canonicalJson);
        } catch {
          return { outcome: 'refused', reason: 'journal-unreadable' };
        }
        if (verifySaveIntentDigest(intent.digest, currentDigest) === 'mismatch') {
          return { outcome: 'refused', reason: 'save-input-digest-mismatch', laneId: lane.laneId };
        }
      }
      const derivation = deriveLane(snapshot, planDigest, lane);
      if (derivation === null) {
        return { outcome: 'refused', reason: 'step-inconsistent', laneId: lane.laneId };
      }
      const nextAction = derivation.nextAction;
      if (nextAction.kind === 'stopped') {
        if (nextAction.reason === 'out-of-order') {
          return { outcome: 'refused', reason: 'out-of-order', laneId: lane.laneId };
        }
        if (nextAction.reason === 'inconsistent' || nextAction.reason === 'invalid-steps') {
          return { outcome: 'refused', reason: 'step-inconsistent', laneId: lane.laneId };
        }
      }
      lanes.push({
        laneId: lane.laneId,
        population: lane.population,
        stepStatuses: derivation.stepStatuses,
        nextAction,
      });
    }

    return { outcome: 'dry-run', planDigest, lanes };
  }
}
