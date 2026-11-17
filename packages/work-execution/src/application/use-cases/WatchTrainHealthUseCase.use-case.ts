// @generated use-case scaffold — implemented for lane CO-WD2, announcement for CO-WD7.
/**
 * WatchTrainHealthUseCase implements WatchTrainHealthPort: one bounded pass
 * that reads the train state through TrainHealthStateReadPort, evaluates it
 * with the pure CO-WD1 rules, raises one attention item per finding through
 * TrainHealthAttentionPort and clears open items whose condition ended.
 * With or without an alert port, a pass makes the same raise-side calls, in
 * the same order, on the same budgets. An alert adds no port call before or
 * between raises. Its only extra calls are the speak calls after the last
 * raise and, on the evaluated path, after clearing. The decision for every
 * raised target uses that target's `previousRaisedAtIso` from its own raise
 * result — the item's last raised time from before this raise refreshed it —
 * together with a clock reading the no-alert path already took. It does not
 * read the open list again after raising: a raise refreshes the stored
 * timestamp, so a later read would hide the time the respeak rule needs. A
 * success result whose `previousRaisedAtIso` is not null and not a zoned ISO
 * string is not spoken and counts as one announcement failure.
 * `announceSuppressed` is the decision's own suppressed count. Sentences the
 * budget does not let the pass start are `announceUnspoken`. The pass keeps
 * no memory of what it said or of dismissals. Without an alert port it
 * behaves as CO-WD2 and reports zero announcement counters. Unknown is never
 * healthy: an unreadable or unevaluable state raises `watchdog-blind` and
 * clears nothing;
 * a cut finding list and a queue too long to assess fully each raise their
 * own attention item and are never read as "nothing is wrong". The pass keeps
 * no state between calls, never throws and re-reads the clock budget before
 * every port call.
 */

import {
  blindTrainHealthFinding,
  evaluateTrainHealth,
  TRAIN_HEALTH_QUEUE_MAX,
  type TrainHealthEvaluation,
} from '../../domain/train-health-rules.js';
import { decideTrainHealthAnnouncements } from '../../domain/train-health-announcements.js';
import type {
  TrainHealthAnnouncementInput,
  TrainHealthAnnouncementOpenItem,
  TrainHealthAnnouncementTarget,
} from '../../domain/train-health-announcements.js';
import {
  DAEMON_REPO_DIGEST_PATTERN,
  computeCallBudget,
} from '../../domain/daemon-tick.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { TrainHealthStateReadPort } from '../ports/out/TrainHealthStateReadPort.out-port.js';
import type { HostAudibleAlertPort } from '../ports/out/HostAudibleAlertPort.out-port.js';
import {
  TRAIN_HEALTH_ATTENTION_RULES,
  type TrainHealthAttentionPort,
  type TrainHealthAttentionRule,
} from '../ports/out/TrainHealthAttentionPort.out-port.js';
import type {
  WatchTrainHealthPort,
  WatchTrainHealthRefusalReason,
  WatchTrainHealthRequest,
  WatchTrainHealthResult,
} from '../ports/in/WatchTrainHealthPort.in-port.js';

const NORMAL_TIMEOUT_MS = 30_000;

/**
 * A hung `speak` is cut at this cap instead of the 30 s call budget. Speech
 * runs only after raising and clearing, and each speak still stops at this
 * cap so one speaker that never answers cannot hold the rest of the pass.
 */
const SPEAK_TIMEOUT_MS = 10_000;

/** Success outcomes of the raise and clear attention calls. */
const RAISE_OK: readonly (string | null)[] = ['raised', 'refreshed', 'reopened'];
const CLEAR_OK: readonly (string | null)[] = ['cleared', 'unchanged', 'not-found'];
const OPEN_LIST_MAX = 1000;

export interface WatchTrainHealthDependencies {
  readonly state: Pick<TrainHealthStateReadPort, 'readTrainHealthState'>;
  readonly attention: TrainHealthAttentionPort;
  readonly now: () => string;
  readonly alert?: Pick<HostAudibleAlertPort, 'speak'>;
  readonly respeakMinutes?: number;
}

function refuse(reasonCode: WatchTrainHealthRefusalReason): WatchTrainHealthResult {
  return { outcome: 'refused', exitCode: 1, reasonCode };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/** Reads one own data property; never walks the prototype chain or fires a getter twice. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(source, key)?.value;
}

/**
 * The previous raised time on a success raise. `ok: false` means the own data
 * property was neither null nor a zoned ISO string (missing, accessor, number,
 * unzoned). A throwing getter is not invoked.
 */
function readPreviousRaisedAtIso(
  answer: unknown,
): { readonly ok: true; readonly previousRaisedAtIso: string | null } | { readonly ok: false } {
  try {
    const value = ownValue(answer, 'previousRaisedAtIso');
    if (value === null) {
      return { ok: true, previousRaisedAtIso: null };
    }
    if (typeof value === 'string' && isZonedIsoDateTime(value)) {
      return { ok: true, previousRaisedAtIso: value };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validRepoName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

/** The validated request fields, with `thresholds` carried through unvalidated. */
interface ValidatedRequest {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly repoDigest: string;
  readonly deadlineIso: string;
  readonly thresholds: unknown;
}

type ClockBudget =
  | {
      readonly ok: true;
      readonly nowIso: string;
      readonly allowed: boolean;
      readonly timeoutMs: number;
      readonly remainingMs: number;
      readonly reason: 'budget-exhausted' | 'invalid-budget' | null;
    }
  | { readonly ok: false; readonly reason: 'invalid-clock' };

/** One raise or clear target of this pass. */
interface AttentionTarget {
  readonly rule: TrainHealthAttentionRule;
  readonly pullRequest: number | null;
}

function targetKey(rule: unknown, pullRequest: unknown): string {
  return `${String(rule)}:${String(pullRequest)}`;
}

function isValidPullRequest(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Bounds a snapshot's queue to the first (oldest) TRAIN_HEALTH_QUEUE_MAX entries. */
function boundSnapshot(snapshot: unknown): { snapshot: unknown; queueOverflow: boolean } {
  try {
    if (isPlainObject(snapshot) && Array.isArray(ownValue(snapshot, 'queue'))) {
      const queue = ownValue(snapshot, 'queue') as readonly unknown[];
      if (queue.length > TRAIN_HEALTH_QUEUE_MAX) {
        return {
          snapshot: { ...snapshot, queue: queue.slice(0, TRAIN_HEALTH_QUEUE_MAX) },
          queueOverflow: true,
        };
      }
    }
  } catch {
    // The rules refuse whatever is malformed.
  }
  return { snapshot, queueOverflow: false };
}

function isRefusedEvaluation(
  evaluation: TrainHealthEvaluation,
): evaluation is Extract<TrainHealthEvaluation, { outcome: 'refused' }> {
  return evaluation.outcome === 'refused';
}

function isAttentionRule(value: string): value is TrainHealthAttentionRule {
  return (TRAIN_HEALTH_ATTENTION_RULES as readonly string[]).includes(value);
}

/**
 * One open-list read. `nowIso` is the budget read that authorized it (or found
 * it exhausted). Only the evaluated path lists, and it does so before any
 * raise, for clearing. The blind path does not list. Announcements do not
 * read this list; they use each raise result's `previousRaisedAtIso`.
 */
type ListOpenResult =
  | { readonly kind: 'ok'; readonly items: readonly unknown[]; readonly budgetExhausted: boolean; readonly failed: boolean; readonly nowIso: string }
  | { readonly kind: 'exhausted'; readonly nowIso: string }
  | { readonly kind: 'refused' };

/** One raise that was started, with the raw port answer (`undefined` on timeout or throw). */
interface RaiseRecord {
  readonly target: AttentionTarget;
  readonly answer: unknown;
}

/** The result of raising every target of one pass. */
type RaiseAllResult =
  | {
      readonly kind: 'ok';
      readonly raised: number;
      readonly attentionFailures: number;
      readonly budgetExhausted: boolean;
      readonly records: readonly RaiseRecord[];
    }
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

/** The blind path's one raise, including the clock reading that budgeted it. */
type BlindRaiseResult =
  | {
      readonly kind: 'ok';
      readonly raised: number;
      readonly attentionFailures: number;
      readonly budgetExhausted: boolean;
      readonly nowIso: string;
      /** False when the budget stopped the pass before the raise call. */
      readonly called: boolean;
      readonly answer: unknown;
    }
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

/** The result of clearing every resolved open item of one pass. */
type ClearResolvedResult =
  | { readonly kind: 'ok'; readonly cleared: number; readonly attentionFailures: number; readonly budgetExhausted: boolean }
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

/**
 * Announcement counters carried on an evaluated or blind result.
 * `announceSuppressed` is the decision's suppressed count, never a budget gap.
 * `announceUnspoken` is sentences that decision produced but this pass did not
 * start because the budget ran out. `announceFailures` also counts a success
 * raise whose `previousRaisedAtIso` was not usable, which is not spoken.
 */
interface AnnouncedCounts {
  readonly announced: number;
  readonly announceFailures: number;
  readonly announceSuppressed: number;
  readonly announceUnspoken: number;
}

/** The result of the announcement step, including a mid-loop invalid clock. */
type AnnounceCounts =
  | (AnnouncedCounts & { readonly kind: 'ok'; readonly budgetExhausted: boolean })
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

const SILENT_ANNOUNCED: AnnouncedCounts = {
  announced: 0,
  announceFailures: 0,
  announceSuppressed: 0,
  announceUnspoken: 0,
};

function announcedOk(
  announced: number,
  announceFailures: number,
  announceSuppressed: number,
  announceUnspoken: number,
  budgetExhausted: boolean,
): AnnounceCounts {
  return {
    kind: 'ok',
    announced,
    announceFailures,
    announceSuppressed,
    announceUnspoken,
    budgetExhausted,
  };
}

function blindResult(
  reasonCode: string,
  raised: number,
  attentionFailures: number,
  spoken: AnnouncedCounts,
): WatchTrainHealthResult {
  return {
    outcome: 'blind',
    exitCode: 1,
    reasonCode,
    findings: [blindTrainHealthFinding()],
    raised,
    attentionFailures,
    announced: spoken.announced,
    announceFailures: spoken.announceFailures,
    announceSuppressed: spoken.announceSuppressed,
    announceUnspoken: spoken.announceUnspoken,
  };
}

export class WatchTrainHealthUseCase implements WatchTrainHealthPort {
  constructor(private readonly deps: WatchTrainHealthDependencies) {}

  async watchTrainHealth(request: WatchTrainHealthRequest): Promise<WatchTrainHealthResult> {
    try {
      return await this.watch(request);
    } catch {
      return refuse('invalid-request');
    }
  }

  private async watch(request: unknown): Promise<WatchTrainHealthResult> {
    const validated = this.validate(request);
    if (validated === 'invalid-request') {
      return refuse('invalid-request');
    }

    const firstBudget = await this.budget(validated.deadlineIso);
    if (!firstBudget.ok) {
      return refuse(firstBudget.reason);
    }
    if (!firstBudget.allowed) {
      return firstBudget.reason === 'invalid-budget'
        ? refuse('invalid-deadline')
        : { outcome: 'budget-exhausted', exitCode: 1 };
    }

    const read = await this.readState(validated, firstBudget.nowIso);
    if (read.outcome !== 'ok') {
      return this.blindPass(validated, read.reasonCode);
    }

    const bounded = boundSnapshot(read.snapshot);
    const evaluation = evaluateTrainHealth(bounded.snapshot, validated.thresholds, firstBudget.nowIso);
    if (isRefusedEvaluation(evaluation)) {
      return this.blindPass(validated, `evaluation-${evaluation.reasonCode}`);
    }
    return this.evaluatedPass(validated, evaluation, bounded.queueOverflow);
  }

  /** Reads own data properties only; any miss answers `invalid-request` with zero port calls. */
  private validate(request: unknown): ValidatedRequest | 'invalid-request' {
    if (!isPlainObject(request)) {
      return 'invalid-request';
    }
    const repository = ownValue(request, 'repository');
    if (!isPlainObject(repository)) {
      return 'invalid-request';
    }
    const projectId = ownValue(request, 'projectId');
    const owner = ownValue(repository, 'owner');
    const repo = ownValue(repository, 'repo');
    const repoDigest = ownValue(request, 'repoDigest');
    const deadlineIso = ownValue(request, 'deadlineIso');
    if (
      !validId(projectId) ||
      !validRepoName(owner) ||
      !validRepoName(repo) ||
      typeof repoDigest !== 'string' ||
      !DAEMON_REPO_DIGEST_PATTERN.test(repoDigest) ||
      typeof deadlineIso !== 'string'
    ) {
      return 'invalid-request';
    }
    return {
      projectId,
      repository: { owner, repo },
      repoDigest,
      deadlineIso,
      thresholds: ownValue(request, 'thresholds'),
    };
  }

  /**
   * A fresh clock read and one call-budget decision. Re-read before EVERY port
   * call; the clock is allowed to jump past the deadline mid-pass.
   */
  private async budget(deadlineIso: string): Promise<ClockBudget> {
    try {
      const nowIso = this.deps.now();
      if (!isZonedIsoDateTime(nowIso)) {
        return { ok: false, reason: 'invalid-clock' };
      }
      const decision = computeCallBudget({
        nowIso,
        deadlineIso,
        normalTimeoutMs: NORMAL_TIMEOUT_MS,
      });
      return {
        ok: true,
        nowIso,
        allowed: decision.allowed,
        timeoutMs: decision.allowed ? decision.timeoutMs : 0,
        remainingMs: decision.remainingMs,
        reason: decision.allowed ? null : decision.reason,
      };
    } catch {
      return { ok: false, reason: 'invalid-clock' };
    }
  }

  /**
   * The raw snapshot for the evaluated path, or why the watchdog is blind.
   * Bounded by its own call budget, not by the adapter's cooperation: an
   * already-exhausted budget skips the port call entirely, and a port call
   * that outlives its timeout answers `state-read-timed-out` instead of
   * hanging this "bounded pass" on an adapter that never resolves.
   */
  private async readState(
    validated: ValidatedRequest,
    nowIso: string,
  ): Promise<{ outcome: 'ok'; snapshot: unknown } | { outcome: 'blind'; reasonCode: string }> {
    const readBudget = await this.budget(validated.deadlineIso);
    if (!readBudget.ok) {
      return { outcome: 'blind', reasonCode: 'state-unavailable' };
    }
    if (!readBudget.allowed) {
      return { outcome: 'blind', reasonCode: 'state-budget-exhausted' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Fresh per call, never a module-level constant: this is what Promise.race
    // rejects with when the timer fires, and nothing else can produce this
    // exact value, so checking identity against it (never a message or shape)
    // can never mistake a real port rejection for a timeout. A module-level
    // Symbol would also be collision-safe (Symbols are unique even when
    // declared once), but scoping it to the call keeps two concurrent reads
    // from ever being able to share one, which is the stronger guarantee.
    const timeoutSentinel = Symbol('state-read-timeout');
    try {
      const pending = this.deps.state.readTrainHealthState({
        repository: validated.repository,
        repoDigest: validated.repoDigest,
        nowIso,
        deadlineIso: validated.deadlineIso,
      });
      pending.catch(() => {
        // The race consumes the rejection; this keeps a late failure unhandled.
      });
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutSentinel), readBudget.timeoutMs);
      });
      const read: unknown = await Promise.race([pending, bounded]);
      const outcome = isPlainObject(read) ? ownValue(read, 'outcome') : undefined;
      if (outcome === 'budget-exhausted') {
        return { outcome: 'blind', reasonCode: 'state-budget-exhausted' };
      }
      if (outcome === 'ok' && isPlainObject(read)) {
        return { outcome: 'ok', snapshot: ownValue(read, 'snapshot') };
      }
      return { outcome: 'blind', reasonCode: 'state-unavailable' };
    } catch (error) {
      if (error === timeoutSentinel) {
        return { outcome: 'blind', reasonCode: 'state-read-timed-out' };
      }
      return { outcome: 'blind', reasonCode: 'state-unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The blind path: raise exactly `watchdog-blind` and clear nothing. With or
   * without an alert this lists nothing, matching CO-WD2. An alert speaks
   * after that raise, from the raise result's `previousRaisedAtIso` and the
   * raise's own clock reading. Still clears nothing.
   */
  private async blindPass(
    validated: ValidatedRequest,
    reasonCode: string,
  ): Promise<WatchTrainHealthResult> {
    if (!this.alertEnabled()) {
      return this.raiseBlind(validated, reasonCode, SILENT_ANNOUNCED, 0);
    }
    return this.blindPassWithAlert(validated, reasonCode);
  }

  /**
   * Blind path with an alert: the same one `watchdog-blind` raise as the
   * no-alert path, then speak. No open-list read before, during or after the
   * raise. The decision uses the raise's clock and that result's
   * `previousRaisedAtIso`. Still clears nothing.
   */
  private async blindPassWithAlert(
    validated: ValidatedRequest,
    reasonCode: string,
  ): Promise<WatchTrainHealthResult> {
    const raised = await this.attemptBlindRaise(validated);
    if (raised.kind === 'refused') {
      return refuse(raised.reason);
    }
    const spoken = await this.announceAfterRaises(
      validated,
      this.blindRecords(raised),
      raised.nowIso,
      raised.budgetExhausted,
    );
    if (spoken.kind === 'refused') {
      return refuse(spoken.reason);
    }
    return blindResult(reasonCode, raised.raised, raised.attentionFailures, spoken);
  }

  /** The blind raise, when it was started, as the one announcement record. */
  private blindRecords(raised: Extract<BlindRaiseResult, { kind: 'ok' }>): readonly RaiseRecord[] {
    if (!raised.called) {
      return [];
    }
    return [{ target: { rule: 'watchdog-blind', pullRequest: null }, answer: raised.answer }];
  }

  /** One `watchdog-blind` raise. A missed budget raises nothing. Speech is separate and later. */
  private async raiseBlind(
    validated: ValidatedRequest,
    reasonCode: string,
    spoken: AnnouncedCounts,
    attentionFailures: number,
  ): Promise<WatchTrainHealthResult> {
    const raised = await this.attemptBlindRaise(validated);
    if (raised.kind === 'refused') {
      return refuse(raised.reason);
    }
    return blindResult(
      reasonCode,
      raised.raised,
      attentionFailures + raised.attentionFailures,
      spoken,
    );
  }

  /** The blind raise's own budget check and port call. Does not speak or list. */
  private async attemptBlindRaise(validated: ValidatedRequest): Promise<BlindRaiseResult> {
    const raiseBudget = await this.budget(validated.deadlineIso);
    if (!raiseBudget.ok) {
      return { kind: 'refused', reason: raiseBudget.reason };
    }
    if (!raiseBudget.allowed) {
      return {
        kind: 'ok',
        raised: 0,
        attentionFailures: 0,
        budgetExhausted: true,
        nowIso: raiseBudget.nowIso,
        called: false,
        answer: undefined,
      };
    }
    const answer = await this.raiseBlindFinding(validated, raiseBudget.timeoutMs);
    if (RAISE_OK.includes(this.outcomeOf(answer))) {
      return {
        kind: 'ok',
        raised: 1,
        attentionFailures: 0,
        budgetExhausted: false,
        nowIso: raiseBudget.nowIso,
        called: true,
        answer,
      };
    }
    return {
      kind: 'ok',
      raised: 0,
      attentionFailures: 1,
      budgetExhausted: false,
      nowIso: raiseBudget.nowIso,
      called: true,
      answer,
    };
  }

  private async raiseBlindFinding(validated: ValidatedRequest, timeoutMs: number): Promise<unknown> {
    return this.attentionCall(
      () =>
        this.deps.attention.raiseTrainHealthAttention({
          projectId: validated.projectId,
          repository: validated.repository,
          rule: 'watchdog-blind',
          pullRequest: null,
          deadlineIso: validated.deadlineIso,
        }),
      timeoutMs,
    );
  }

  /**
   * One budget-checked open-list read. The evaluated path calls this before
   * any raise; that result is what clearing uses. The blind path does not
   * call it. Announcements do not read it either.
   */
  private async listOpen(validated: ValidatedRequest): Promise<ListOpenResult> {
    const listBudget = await this.budget(validated.deadlineIso);
    if (!listBudget.ok) {
      return { kind: 'refused' };
    }
    if (!listBudget.allowed) {
      return { kind: 'exhausted', nowIso: listBudget.nowIso };
    }
    try {
      const answer: unknown = await this.attentionCall(
        () =>
          this.deps.attention.listOpenTrainHealthAttention({
            projectId: validated.projectId,
            repository: validated.repository,
            deadlineIso: validated.deadlineIso,
          }),
        listBudget.timeoutMs,
      );
      if (this.outcomeOf(answer) === 'found' && Array.isArray(ownValue(answer, 'items'))) {
        return {
          kind: 'ok',
          items: ownValue(answer, 'items') as readonly unknown[],
          budgetExhausted: false,
          failed: false,
          nowIso: listBudget.nowIso,
        };
      }
      return { kind: 'ok', items: [], budgetExhausted: false, failed: true, nowIso: listBudget.nowIso };
    } catch {
      return { kind: 'ok', items: [], budgetExhausted: false, failed: true, nowIso: listBudget.nowIso };
    }
  }

  /** One raise target in evaluation order; the summary targets go first. */
  private static raiseTargets(
    evaluation: Extract<TrainHealthEvaluation, { outcome: 'evaluated' }>,
    queueOverflow: boolean,
  ): readonly AttentionTarget[] {
    const targets: AttentionTarget[] = [];
    if (queueOverflow) {
      targets.push({ rule: 'queue-too-large', pullRequest: null });
    }
    if (evaluation.truncated) {
      targets.push({ rule: 'findings-truncated', pullRequest: null });
    }
    for (const finding of evaluation.findings) {
      targets.push({ rule: finding.rule, pullRequest: finding.pullRequest });
    }
    return targets;
  }

  /**
   * Awaits one attention call inside `try/catch`, bounded by the call budget's
   * `timeoutMs`: a store that never answers answers this helper as `undefined`
   * once the budget runs out, so the pass always returns. Answers the call's
   * raw result object, or `undefined` on a throw, a timeout or a non-object.
   */
  private async attentionCall(call: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = call();
      pending.catch(() => {
        // The race consumes the rejection; this keeps a late failure unhandled.
      });
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('attention-call-timeout')), timeoutMs);
      });
      const answer: unknown = await Promise.race([pending, bounded]);
      return isPlainObject(answer) ? answer : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads an own data property of an object answer as a string, never coercing a non-string value. */
  private outcomeOf(answer: unknown): string | null {
    if (!isPlainObject(answer)) {
      return null;
    }
    const outcome = ownValue(answer, 'outcome');
    return typeof outcome === 'string' ? outcome : null;
  }

  /** True only when an alert dependency can actually be called. A missing `speak` skips announcement. */
  private alertEnabled(): boolean {
    const alert = this.deps.alert;
    if (alert === undefined) {
      return false;
    }
    return typeof alert.speak === 'function';
  }

  /**
   * Decides and speaks only after raising (and, on the evaluated path, after
   * clearing). `nowIso` is a clock reading the no-alert path already took:
   * the clearing list's read on the evaluated path, the raise's read on the
   * blind path. This method adds no clock read of its own before speaking.
   * Each record contributes its own `previousRaisedAtIso`. A success raise
   * whose previous time is unusable is not spoken and counts as one
   * announcement failure. A raise that did not succeed has no previous time,
   * so that target stays due: unknown history is spoken, not silenced.
   * `announceSuppressed` stays the decision's suppressed count. Sentences not
   * started because the budget cannot cover another speak are
   * `announceUnspoken`.
   */
  private async announceAfterRaises(
    validated: ValidatedRequest,
    records: readonly RaiseRecord[],
    nowIso: string,
    budgetExhausted: boolean,
  ): Promise<AnnounceCounts> {
    if (!this.alertEnabled()) {
      return announcedOk(0, 0, 0, 0, budgetExhausted);
    }
    const built = this.announcementFromRaises(records);
    const planned = this.decisionFor(built.targets, built.openItems, nowIso);
    if (budgetExhausted) {
      return announcedOk(0, built.malformed, planned.suppressed, planned.sentences.length, true);
    }
    const spoken = await this.speakSentences(validated, planned.sentences, planned.suppressed);
    if (spoken.kind === 'refused') {
      return spoken;
    }
    return announcedOk(
      spoken.announced,
      spoken.announceFailures + built.malformed,
      spoken.announceSuppressed,
      spoken.announceUnspoken,
      spoken.budgetExhausted,
    );
  }

  /**
   * Targets and open items for the pure rule, taken only from raise results.
   * `malformed` is success raises that are left out of the decision.
   */
  private announcementFromRaises(records: readonly RaiseRecord[]): {
    readonly targets: TrainHealthAnnouncementTarget[];
    readonly openItems: TrainHealthAnnouncementOpenItem[];
    readonly malformed: number;
  } {
    const targets: TrainHealthAnnouncementTarget[] = [];
    const openItems: TrainHealthAnnouncementOpenItem[] = [];
    let malformed = 0;
    for (const record of records) {
      const target = WatchTrainHealthUseCase.announcementTarget(record.target);
      if (!RAISE_OK.includes(this.outcomeOf(record.answer))) {
        targets.push(target);
        continue;
      }
      const previous = readPreviousRaisedAtIso(record.answer);
      if (!previous.ok) {
        malformed += 1;
        continue;
      }
      targets.push(target);
      if (previous.previousRaisedAtIso !== null) {
        openItems.push({ ...target, lastRaisedAtIso: previous.previousRaisedAtIso });
      }
    }
    return { targets, openItems, malformed };
  }

  /** The pure decision: both outcomes speak `sentences`; only `decided` carries `suppressed`. */
  private decisionFor(
    targets: readonly TrainHealthAnnouncementTarget[],
    openItems: readonly TrainHealthAnnouncementOpenItem[],
    nowIso: string,
  ): { readonly sentences: readonly string[]; readonly suppressed: number } {
    const decision = decideTrainHealthAnnouncements(
      this.withRespeak({
        targets,
        openItemsKnown: true,
        openItems,
        nowIso,
      }),
    );
    if (decision.outcome === 'decided') {
      return { sentences: decision.sentences, suppressed: decision.suppressed };
    }
    return { sentences: decision.sentences, suppressed: 0 };
  }

  /** A `null` pull request becomes an absent key; a key holding `undefined` is never sent. */
  private static announcementTarget(target: AttentionTarget): TrainHealthAnnouncementTarget {
    if (target.pullRequest === null) {
      return { rule: target.rule };
    }
    return { rule: target.rule, pullRequest: target.pullRequest };
  }

  /** Omit `respeakMinutes` entirely when it is undefined; a present `undefined` is refused. */
  private withRespeak(input: TrainHealthAnnouncementInput): TrainHealthAnnouncementInput {
    const minutes = this.deps.respeakMinutes;
    if (minutes === undefined) {
      return input;
    }
    return { ...input, respeakMinutes: minutes };
  }

  /**
   * Speaks each precomputed sentence inside the budget that remains after
   * raising and clearing. Anything other than an own data property
   * `outcome === 'spoken'` counts as one failure and the loop continues. An
   * invalid clock refuses the whole pass. When the remaining budget cannot
   * cover another speak, the loop stops. Sentences not started are
   * `announceUnspoken`; `announceSuppressed` is left as the decision set it.
   * Each speak is capped at `SPEAK_TIMEOUT_MS`.
   */
  private async speakSentences(
    validated: ValidatedRequest,
    sentences: readonly string[],
    announceSuppressed: number,
  ): Promise<AnnounceCounts> {
    const alert = this.deps.alert;
    if (alert === undefined || typeof alert.speak !== 'function') {
      return announcedOk(0, 0, 0, 0, false);
    }
    let announced = 0;
    let announceFailures = 0;
    let index = 0;
    for (const sentence of sentences) {
      const budget = await this.budget(validated.deadlineIso);
      if (!budget.ok) {
        return { kind: 'refused', reason: budget.reason };
      }
      if (!budget.allowed) {
        const unspoken = sentences.length - index;
        return announcedOk(announced, announceFailures, announceSuppressed, unspoken, true);
      }
      const timeoutMs = Math.min(SPEAK_TIMEOUT_MS, budget.timeoutMs);
      const spoken = await this.oneSpeak(alert, sentence, timeoutMs);
      if (spoken) {
        announced += 1;
      } else {
        announceFailures += 1;
      }
      index += 1;
    }
    return announcedOk(announced, announceFailures, announceSuppressed, 0, false);
  }

  /** One bounded `speak`. `attentionCall` already drops non-objects, throws and timeouts. */
  private async oneSpeak(
    alert: Pick<HostAudibleAlertPort, 'speak'>,
    sentence: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const answer = await this.attentionCall(() => alert.speak({ sentence }), timeoutMs);
    return this.outcomeOf(answer) === 'spoken';
  }

  /** The evaluated path: list once, raise every target, clear what ended, then speak. */
  private async evaluatedPass(
    validated: ValidatedRequest,
    evaluation: Extract<TrainHealthEvaluation, { outcome: 'evaluated' }>,
    queueOverflow: boolean,
  ): Promise<WatchTrainHealthResult> {
    const listed = await this.listOpen(validated);
    if (listed.kind === 'refused') {
      return refuse('invalid-clock');
    }
    let budgetExhausted = listed.kind === 'exhausted';
    let attentionFailures = listed.kind === 'ok' && listed.failed ? 1 : 0;

    const targets = WatchTrainHealthUseCase.raiseTargets(evaluation, queueOverflow);
    const targetKeys = new Set(
      targets.map((target) => targetKey(target.rule, target.pullRequest)),
    );
    // The list budget's clock. Both paths already took this read. The decision
    // uses it after the raises and does not read `now()` again for itself.
    const decisionNowIso = listed.nowIso;

    const raiseResult = await this.raiseAll(validated, targets, budgetExhausted);
    if (raiseResult.kind === 'refused') {
      return refuse(raiseResult.reason);
    }
    const raised = raiseResult.raised;
    attentionFailures += raiseResult.attentionFailures;
    budgetExhausted = raiseResult.budgetExhausted;

    const clearResult = await this.clearResolved(
      validated,
      evaluation,
      queueOverflow,
      listed,
      targetKeys,
      budgetExhausted,
    );
    if (clearResult.kind === 'refused') {
      return refuse(clearResult.reason);
    }
    const cleared = clearResult.cleared;
    attentionFailures += clearResult.attentionFailures;
    budgetExhausted = clearResult.budgetExhausted;

    // Speech uses each raise's previous timestamp, not a list taken after the
    // refresh. It cannot move a raise or clear budget.
    const spoken = await this.announceAfterRaises(
      validated,
      raiseResult.records,
      decisionNowIso,
      budgetExhausted,
    );
    if (spoken.kind === 'refused') {
      return refuse(spoken.reason);
    }
    budgetExhausted = spoken.budgetExhausted;

    const healthy =
      evaluation.findings.length === 0 &&
      evaluation.unknownForgeStates === 0 &&
      !evaluation.truncated &&
      !queueOverflow &&
      attentionFailures === 0 &&
      !budgetExhausted;
    return {
      outcome: 'evaluated',
      exitCode: healthy ? 0 : 1,
      healthy,
      findings: evaluation.findings,
      unknownForgeStates: evaluation.unknownForgeStates,
      truncated: evaluation.truncated,
      queueOverflow,
      raised,
      cleared,
      attentionFailures,
      budgetExhausted,
      announced: spoken.announced,
      announceFailures: spoken.announceFailures,
      announceSuppressed: spoken.announceSuppressed,
      announceUnspoken: spoken.announceUnspoken,
    };
  }

  /**
   * Raises every target in evaluation order, re-checking the budget before
   * each call. Already-exhausted on entry (the open-list read ran out) raises
   * nothing. Speech does not run before this, and the alert path adds no clock
   * read and no port call before it, so a speaker cannot change which raises
   * start or what budget they see. Each started raise keeps its raw answer so
   * the announcement can read `previousRaisedAtIso` without listing again.
   */
  private async raiseAll(
    validated: ValidatedRequest,
    targets: readonly AttentionTarget[],
    budgetExhausted: boolean,
  ): Promise<RaiseAllResult> {
    if (budgetExhausted) {
      return { kind: 'ok', raised: 0, attentionFailures: 0, budgetExhausted: true, records: [] };
    }
    let raised = 0;
    let attentionFailures = 0;
    const records: RaiseRecord[] = [];
    for (const target of targets) {
      const budget = await this.budget(validated.deadlineIso);
      if (!budget.ok) {
        return { kind: 'refused', reason: budget.reason };
      }
      if (!budget.allowed) {
        return { kind: 'ok', raised, attentionFailures, budgetExhausted: true, records };
      }
      const answer = await this.attentionCall(
        () =>
          this.deps.attention.raiseTrainHealthAttention({
            projectId: validated.projectId,
            repository: validated.repository,
            rule: target.rule,
            pullRequest: target.pullRequest,
            deadlineIso: validated.deadlineIso,
          }),
        budget.timeoutMs,
      );
      records.push({ target, answer });
      if (RAISE_OK.includes(this.outcomeOf(answer))) {
        raised += 1;
      } else {
        attentionFailures += 1;
      }
    }
    return { kind: 'ok', raised, attentionFailures, budgetExhausted: false, records };
  }

  /**
   * Whether the open list may be cleared this pass, and the one extra
   * `attentionFailures` count when it holds more than `OPEN_LIST_MAX` items
   * (counted whatever else also makes the list unclearable).
   */
  private static clearability(
    evaluation: Extract<TrainHealthEvaluation, { outcome: 'evaluated' }>,
    listed: ListOpenResult,
    budgetExhausted: boolean,
  ): { readonly clearable: boolean; readonly extraFailure: number } {
    const openItems = listed.kind === 'ok' ? listed.items : [];
    const clearable =
      !budgetExhausted &&
      listed.kind === 'ok' &&
      !listed.failed &&
      !evaluation.truncated &&
      openItems.length <= OPEN_LIST_MAX;
    const overLimit = listed.kind === 'ok' && !listed.failed && openItems.length > OPEN_LIST_MAX;
    return { clearable, extraFailure: !clearable && overLimit ? 1 : 0 };
  }

  /** True when an open item matches a raise target of this pass, or is not assessed this pass. */
  private static shouldSkipClear(
    parsed: { readonly rule: TrainHealthAttentionRule; readonly pullRequest: number | null },
    targetKeys: ReadonlySet<string>,
    mustKeepUnassessed: boolean,
  ): boolean {
    if (targetKeys.has(targetKey(parsed.rule, parsed.pullRequest))) {
      return true;
    }
    return mustKeepUnassessed && (parsed.rule === 'stale-queue-entry' || parsed.rule === 'repeated-park');
  }

  /**
   * Clears every open item whose condition ended, using the list read before
   * any raise. Clears nothing when the list is unusable (truncated, unknown,
   * too large or the budget already ran out).
   */
  private async clearResolved(
    validated: ValidatedRequest,
    evaluation: Extract<TrainHealthEvaluation, { outcome: 'evaluated' }>,
    queueOverflow: boolean,
    listed: ListOpenResult,
    targetKeys: ReadonlySet<string>,
    budgetExhausted: boolean,
  ): Promise<ClearResolvedResult> {
    const { clearable, extraFailure } = WatchTrainHealthUseCase.clearability(
      evaluation,
      listed,
      budgetExhausted,
    );
    if (!clearable) {
      return { kind: 'ok', cleared: 0, attentionFailures: extraFailure, budgetExhausted };
    }

    const openItems = listed.kind === 'ok' ? listed.items : [];
    const mustKeepUnassessed = evaluation.unknownForgeStates > 0 || queueOverflow;
    let cleared = 0;
    let attentionFailures = 0;
    let exhausted = budgetExhausted;
    for (const item of openItems) {
      const parsed = this.parseOpenItem(item);
      if (parsed === null) {
        attentionFailures += 1;
        continue;
      }
      if (WatchTrainHealthUseCase.shouldSkipClear(parsed, targetKeys, mustKeepUnassessed)) {
        continue;
      }
      const budget = await this.budget(validated.deadlineIso);
      if (!budget.ok) {
        return { kind: 'refused', reason: budget.reason };
      }
      if (!budget.allowed) {
        exhausted = true;
        break;
      }
      const clearAnswer = await this.attentionCall(
        () =>
          this.deps.attention.clearTrainHealthAttention({
            projectId: validated.projectId,
            repository: validated.repository,
            rule: parsed.rule,
            pullRequest: parsed.pullRequest,
            deadlineIso: validated.deadlineIso,
          }),
        budget.timeoutMs,
      );
      if (CLEAR_OK.includes(this.outcomeOf(clearAnswer))) {
        cleared += 1;
      } else {
        attentionFailures += 1;
      }
    }
    return { kind: 'ok', cleared, attentionFailures, budgetExhausted: exhausted };
  }

  /** Identifies an open item from own data properties only; null when unidentifiable. */
  private parseOpenItem(item: unknown): { rule: TrainHealthAttentionRule; pullRequest: number | null } | null {
    if (!isPlainObject(item)) {
      return null;
    }
    const rule = ownValue(item, 'rule');
    const pullRequest = ownValue(item, 'pullRequest');
    if (
      typeof rule !== 'string' ||
      !isAttentionRule(rule)
    ) {
      return null;
    }
    if (pullRequest === null) {
      return { rule, pullRequest: null };
    }
    if (isValidPullRequest(pullRequest)) {
      return { rule, pullRequest };
    }
    return null;
  }
}
