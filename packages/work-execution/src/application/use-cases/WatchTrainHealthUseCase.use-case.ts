// @generated use-case scaffold — implemented for lane CO-WD2, announcement for CO-WD7.
/**
 * WatchTrainHealthUseCase implements WatchTrainHealthPort: one bounded pass
 * that reads the train state through TrainHealthStateReadPort, evaluates it
 * with the pure CO-WD1 rules, raises one attention item per finding through
 * TrainHealthAttentionPort and clears open items whose condition ended.
 * When an alert port is present, the pass speaks the pure CO-WD6 decision
 * after listing open items and before the first raise, and keeps no memory of
 * what it said or of dismissals. Without an alert port the pass behaves as
 * CO-WD2 and reports zero announcement counters. Unknown is never healthy: an
 * unreadable or unevaluable state raises `watchdog-blind` and clears nothing;
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
import {
  decideTrainHealthAnnouncements,
  TRAIN_HEALTH_OPEN_ITEMS_MAX,
} from '../../domain/train-health-announcements.js';
import type {
  TrainHealthAnnouncementInput,
  TrainHealthAnnouncementOpenItem,
  TrainHealthAnnouncementTarget,
} from '../../domain/train-health-announcements.js';
import { DAEMON_REPO_DIGEST_PATTERN, computeCallBudget } from '../../domain/daemon-tick.js';
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

/** The result of one open-list read, before any raise. */
type ListOpenResult =
  | { readonly kind: 'ok'; readonly items: readonly unknown[]; readonly budgetExhausted: boolean; readonly failed: boolean }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'refused' };

/** The result of raising every target of one pass. */
type RaiseAllResult =
  | { readonly kind: 'ok'; readonly raised: number; readonly attentionFailures: number; readonly budgetExhausted: boolean }
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

/** The result of clearing every resolved open item of one pass. */
type ClearResolvedResult =
  | { readonly kind: 'ok'; readonly cleared: number; readonly attentionFailures: number; readonly budgetExhausted: boolean }
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

/** Announcement counters carried on an evaluated or blind result. */
interface AnnouncedCounts {
  readonly announced: number;
  readonly announceFailures: number;
  readonly announceSuppressed: number;
}

/** The result of the announcement step, including a mid-loop invalid clock. */
type AnnounceCounts =
  | (AnnouncedCounts & { readonly kind: 'ok'; readonly budgetExhausted: boolean })
  | { readonly kind: 'refused'; readonly reason: 'invalid-clock' };

const SILENT_ANNOUNCED: AnnouncedCounts = {
  announced: 0,
  announceFailures: 0,
  announceSuppressed: 0,
};

function announcedOk(
  announced: number,
  announceFailures: number,
  announceSuppressed: number,
  budgetExhausted: boolean,
): AnnounceCounts {
  return { kind: 'ok', announced, announceFailures, announceSuppressed, budgetExhausted };
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
   * The blind path: raise exactly `watchdog-blind` and clear nothing. Without
   * an alert this lists nothing, matching CO-WD2. With an alert it lists open
   * items first (a failed list is not known state and counts one attention
   * failure), announces, then raises.
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

  /** Blind path with an alert: list, announce `watchdog-blind`, then raise. Still clears nothing. */
  private async blindPassWithAlert(
    validated: ValidatedRequest,
    reasonCode: string,
  ): Promise<WatchTrainHealthResult> {
    const listed = await this.listOpen(validated);
    if (listed.kind === 'refused') {
      return refuse('invalid-clock');
    }
    const listFailure = listed.kind === 'ok' && listed.failed ? 1 : 0;
    const spoken = await this.announceIfAlert(
      validated,
      [{ rule: 'watchdog-blind', pullRequest: null }],
      listed,
      listed.kind === 'exhausted',
    );
    if (spoken.kind === 'refused') {
      return refuse(spoken.reason);
    }
    return this.raiseBlind(validated, reasonCode, spoken, listFailure);
  }

  /** One `watchdog-blind` raise, after any announcement. A missed budget raises nothing. */
  private async raiseBlind(
    validated: ValidatedRequest,
    reasonCode: string,
    spoken: AnnouncedCounts,
    attentionFailures: number,
  ): Promise<WatchTrainHealthResult> {
    const raiseBudget = await this.budget(validated.deadlineIso);
    if (!raiseBudget.ok) {
      return refuse(raiseBudget.reason);
    }
    if (!raiseBudget.allowed) {
      return blindResult(reasonCode, 0, attentionFailures, spoken);
    }
    const raisedOk = await this.raiseBlindFinding(validated, raiseBudget.timeoutMs);
    if (raisedOk) {
      return blindResult(reasonCode, 1, attentionFailures, spoken);
    }
    return blindResult(reasonCode, 0, attentionFailures + 1, spoken);
  }

  private async raiseBlindFinding(validated: ValidatedRequest, timeoutMs: number): Promise<boolean> {
    const raiseAnswer = await this.attentionCall(
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
    return RAISE_OK.includes(this.outcomeOf(raiseAnswer));
  }

  /** Reads the open list once, before any raise, so CO-WD7 sees pre-pass times. */
  private async listOpen(validated: ValidatedRequest): Promise<ListOpenResult> {
    const listBudget = await this.budget(validated.deadlineIso);
    if (!listBudget.ok) {
      return { kind: 'refused' };
    }
    if (!listBudget.allowed) {
      return { kind: 'exhausted' };
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
        return { kind: 'ok', items: ownValue(answer, 'items') as readonly unknown[], budgetExhausted: false, failed: false };
      }
      return { kind: 'ok', items: [], budgetExhausted: false, failed: true };
    } catch {
      return { kind: 'ok', items: [], budgetExhausted: false, failed: true };
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
   * Announces after `listOpen` and before the first raise, or reports zeros
   * when no alert is wired. The decision clock is the budget read taken just
   * before `announce`; each `speak` then takes a fresh budget of its own.
   */
  private async announceIfAlert(
    validated: ValidatedRequest,
    targets: readonly AttentionTarget[],
    listed: ListOpenResult,
    budgetExhausted: boolean,
  ): Promise<AnnounceCounts> {
    if (!this.alertEnabled()) {
      return announcedOk(0, 0, 0, budgetExhausted);
    }
    if (budgetExhausted) {
      return announcedOk(0, 0, 0, true);
    }
    const clock = await this.budget(validated.deadlineIso);
    if (!clock.ok) {
      return { kind: 'refused', reason: clock.reason };
    }
    if (!clock.allowed) {
      const planned = this.decisionOf(targets, listed, clock.nowIso);
      return announcedOk(0, 0, planned.suppressed, true);
    }
    return this.announce(targets, listed, validated, clock.nowIso);
  }

  /**
   * Decides the sentences for this pass and speaks them in order. A refusal
   * from the pure rule speaks its fallback sentence and suppresses nothing.
   */
  private async announce(
    targets: readonly AttentionTarget[],
    listed: ListOpenResult,
    validated: ValidatedRequest,
    nowIso: string,
  ): Promise<AnnounceCounts> {
    const planned = this.decisionOf(targets, listed, nowIso);
    return this.speakSentences(validated, planned.sentences, planned.suppressed);
  }

  /** The pure decision: both outcomes speak `sentences`; only `decided` carries `suppressed`. */
  private decisionOf(
    targets: readonly AttentionTarget[],
    listed: ListOpenResult,
    nowIso: string,
  ): { readonly sentences: readonly string[]; readonly suppressed: number } {
    const decision = decideTrainHealthAnnouncements(this.announcementInput(targets, listed, nowIso));
    if (decision.outcome === 'decided') {
      return { sentences: decision.sentences, suppressed: decision.suppressed };
    }
    return { sentences: decision.sentences, suppressed: 0 };
  }

  /** Maps raise targets and the pre-pass open list into the pure rule's input. */
  private announcementInput(
    targets: readonly AttentionTarget[],
    listed: ListOpenResult,
    nowIso: string,
  ): TrainHealthAnnouncementInput {
    const listedItems = listed.kind === 'ok' ? listed.items : [];
    // Over the pure rule's cap the list is unknown: passing it would be a refusal.
    const known =
      listed.kind === 'ok' && !listed.failed && listedItems.length <= TRAIN_HEALTH_OPEN_ITEMS_MAX;
    const openItems = known ? this.openItemsForAnnouncement(listedItems) : [];
    return this.withRespeak({
      targets: targets.map((target) => WatchTrainHealthUseCase.announcementTarget(target)),
      openItemsKnown: known,
      openItems,
      nowIso,
    });
  }

  /** A `null` pull request becomes an absent key; a key holding `undefined` is never sent. */
  private static announcementTarget(target: AttentionTarget): TrainHealthAnnouncementTarget {
    if (target.pullRequest === null) {
      return { rule: target.rule };
    }
    return { rule: target.rule, pullRequest: target.pullRequest };
  }

  private openItemsForAnnouncement(items: readonly unknown[]): TrainHealthAnnouncementOpenItem[] {
    const openItems: TrainHealthAnnouncementOpenItem[] = [];
    for (const item of items) {
      const parsed = this.parseOpenItem(item);
      if (parsed === null) {
        continue;
      }
      openItems.push(this.announcementOpenItem(parsed, ownValue(item, 'lastRaisedAtIso')));
    }
    return openItems;
  }

  private announcementOpenItem(
    parsed: { readonly rule: TrainHealthAttentionRule; readonly pullRequest: number | null },
    lastRaisedAtIso: unknown,
  ): TrainHealthAnnouncementOpenItem {
    const item = WatchTrainHealthUseCase.announcementTarget(parsed);
    if (typeof lastRaisedAtIso !== 'string') {
      return item;
    }
    return { ...item, lastRaisedAtIso };
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
   * Speaks each sentence inside the call budget. Anything other than an own
   * data property `outcome === 'spoken'` counts as one failure and the loop
   * continues. An invalid clock refuses the whole pass; a spent budget stops.
   */
  private async speakSentences(
    validated: ValidatedRequest,
    sentences: readonly string[],
    announceSuppressed: number,
  ): Promise<AnnounceCounts> {
    const alert = this.deps.alert;
    if (alert === undefined || typeof alert.speak !== 'function') {
      return announcedOk(0, 0, 0, false);
    }
    let announced = 0;
    let announceFailures = 0;
    for (const sentence of sentences) {
      const budget = await this.budget(validated.deadlineIso);
      if (!budget.ok) {
        return { kind: 'refused', reason: budget.reason };
      }
      if (!budget.allowed) {
        return announcedOk(announced, announceFailures, announceSuppressed, true);
      }
      const spoken = await this.oneSpeak(alert, sentence, budget.timeoutMs);
      if (spoken) {
        announced += 1;
        continue;
      }
      announceFailures += 1;
    }
    return announcedOk(announced, announceFailures, announceSuppressed, false);
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

  /** The evaluated path: list once, raise every target, clear what ended. */
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

    // Speak before the first raise so a crash between them repeats the speech.
    const spoken = await this.announceIfAlert(validated, targets, listed, budgetExhausted);
    if (spoken.kind === 'refused') {
      return refuse(spoken.reason);
    }
    budgetExhausted = spoken.budgetExhausted;

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
    };
  }

  /**
   * Raises every target in evaluation order, re-checking the budget before
   * each call. Already-exhausted on entry (the open-list read ran out)
   * raises nothing, matching the pre-split behaviour exactly.
   */
  private async raiseAll(
    validated: ValidatedRequest,
    targets: readonly AttentionTarget[],
    budgetExhausted: boolean,
  ): Promise<RaiseAllResult> {
    if (budgetExhausted) {
      return { kind: 'ok', raised: 0, attentionFailures: 0, budgetExhausted: true };
    }
    let raised = 0;
    let attentionFailures = 0;
    for (const target of targets) {
      const budget = await this.budget(validated.deadlineIso);
      if (!budget.ok) {
        return { kind: 'refused', reason: budget.reason };
      }
      if (!budget.allowed) {
        return { kind: 'ok', raised, attentionFailures, budgetExhausted: true };
      }
      const raiseAnswer = await this.attentionCall(
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
      if (RAISE_OK.includes(this.outcomeOf(raiseAnswer))) {
        raised += 1;
      } else {
        attentionFailures += 1;
      }
    }
    return { kind: 'ok', raised, attentionFailures, budgetExhausted: false };
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
