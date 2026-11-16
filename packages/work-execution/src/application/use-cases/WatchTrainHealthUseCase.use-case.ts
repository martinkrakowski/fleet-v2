// @generated use-case scaffold — implemented for lane CO-WD2.
/**
 * WatchTrainHealthUseCase implements WatchTrainHealthPort: one bounded pass
 * that reads the train state through TrainHealthStateReadPort, evaluates it
 * with the pure CO-WD1 rules, raises one attention item per finding through
 * TrainHealthAttentionPort and clears open items whose condition ended.
 * Unknown is never healthy: an unreadable or unevaluable state raises
 * `watchdog-blind` and clears nothing; a cut finding list and a queue too long
 * to assess fully each raise their own attention item and are never read as
 * "nothing is wrong". The pass keeps no state between calls, never throws and
 * re-reads the clock budget before every port call.
 */

import {
  blindTrainHealthFinding,
  evaluateTrainHealth,
  TRAIN_HEALTH_QUEUE_MAX,
  type TrainHealthEvaluation,
} from '../../domain/train-health-rules.js';
import { DAEMON_REPO_DIGEST_PATTERN, computeCallBudget } from '../../domain/daemon-tick.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { TrainHealthStateReadPort } from '../ports/out/TrainHealthStateReadPort.out-port.js';
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
const OPEN_LIST_MAX = 1000;

export interface WatchTrainHealthDependencies {
  readonly state: Pick<TrainHealthStateReadPort, 'readTrainHealthState'>;
  readonly attention: TrainHealthAttentionPort;
  readonly now: () => string;
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
        reason: decision.allowed ? null : decision.reason,
      };
    } catch {
      return { ok: false, reason: 'invalid-clock' };
    }
  }

  /** The raw snapshot for the evaluated path, or why the watchdog is blind. */
  private async readState(
    validated: ValidatedRequest,
    nowIso: string,
  ): Promise<{ outcome: 'ok'; snapshot: unknown } | { outcome: 'blind'; reasonCode: string }> {
    try {
      const read: unknown = await this.deps.state.readTrainHealthState({
        repository: validated.repository,
        repoDigest: validated.repoDigest,
        nowIso,
        deadlineIso: validated.deadlineIso,
      });
      const outcome = isPlainObject(read) ? ownValue(read, 'outcome') : undefined;
      if (outcome === 'budget-exhausted') {
        return { outcome: 'blind', reasonCode: 'state-budget-exhausted' };
      }
      if (outcome === 'ok' && isPlainObject(read)) {
        return { outcome: 'ok', snapshot: ownValue(read, 'snapshot') };
      }
      return { outcome: 'blind', reasonCode: 'state-unavailable' };
    } catch {
      return { outcome: 'blind', reasonCode: 'state-unavailable' };
    }
  }

  /** The blind path: raise exactly `watchdog-blind`, list nothing, clear nothing. */
  private async blindPass(
    validated: ValidatedRequest,
    reasonCode: string,
  ): Promise<WatchTrainHealthResult> {
    const raiseBudget = await this.budget(validated.deadlineIso);
    if (!raiseBudget.ok) {
      return refuse(raiseBudget.reason);
    }
    let raised = 0;
    let attentionFailures = 0;
    if (!raiseBudget.allowed) {
      return {
        outcome: 'blind',
        exitCode: 1,
        reasonCode,
        findings: [blindTrainHealthFinding()],
        raised,
        attentionFailures,
      };
    }
    const raisedOk = await this.attentionCall(() =>
      this.deps.attention.raiseTrainHealthAttention({
        projectId: validated.projectId,
        repository: validated.repository,
        rule: 'watchdog-blind',
        pullRequest: null,
      }),
    );
    if (raisedOk) {
      raised = 1;
    } else {
      attentionFailures = 1;
    }
    return {
      outcome: 'blind',
      exitCode: 1,
      reasonCode,
      findings: [blindTrainHealthFinding()],
      raised,
      attentionFailures,
    };
  }

  /** Reads the open list once, before any raise, so CO-WD7 sees pre-pass times. */
  private async listOpen(
    validated: ValidatedRequest,
  ): Promise<
    { readonly kind: 'ok'; items: readonly unknown[]; budgetExhausted: boolean; failed: boolean } | {
      readonly kind: 'exhausted';
    } | { readonly kind: 'refused' }
  > {
    const listBudget = await this.budget(validated.deadlineIso);
    if (!listBudget.ok) {
      return { kind: 'refused' };
    }
    if (!listBudget.allowed) {
      return { kind: 'exhausted' };
    }
    try {
      const answer: unknown = await this.deps.attention.listOpenTrainHealthAttention({
        projectId: validated.projectId,
        repository: validated.repository,
      });
      if (
        isPlainObject(answer) &&
        ownValue(answer, 'outcome') === 'found' &&
        Array.isArray(ownValue(answer, 'items'))
      ) {
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

  /** Awaits one attention call and answers whether its outcome is a success. */
  private async attentionCall(call: () => Promise<unknown>, outcomes: readonly string[] = ['raised', 'refreshed', 'reopened', 'cleared', 'unchanged', 'not-found']): Promise<boolean> {
    try {
      const answer: unknown = await call();
      if (!isPlainObject(answer)) {
        return false;
      }
      return outcomes.includes(String(ownValue(answer, 'outcome')));
    } catch {
      return false;
    }
  }

  /** The evaluated path: list once, raise every target, clear what ended. */
  private async evaluatedPass(
    validated: ValidatedRequest,
    evaluation: Extract<TrainHealthEvaluation, { outcome: 'evaluated' }>,
    queueOverflow: boolean,
  ): Promise<WatchTrainHealthResult> {
    let budgetExhausted = false;
    let attentionFailures = 0;

    const listed = await this.listOpen(validated);
    if (listed.kind === 'refused') {
      return refuse('invalid-clock');
    }
    if (listed.kind === 'exhausted') {
      budgetExhausted = true;
    } else if (listed.failed) {
      attentionFailures += 1;
    }
    const openItems = listed.kind === 'ok' ? listed.items : [];

    let raised = 0;
    const targets = WatchTrainHealthUseCase.raiseTargets(evaluation, queueOverflow);
    const targetKeys = new Set(
      targets.map((target) => targetKey(target.rule, target.pullRequest)),
    );
    for (const target of targets) {
      if (budgetExhausted) {
        break;
      }
      const budget = await this.budget(validated.deadlineIso);
      if (!budget.ok) {
        return refuse(budget.reason);
      }
      if (!budget.allowed) {
        budgetExhausted = true;
        break;
      }
      const ok = await this.attentionCall(() =>
        this.deps.attention.raiseTrainHealthAttention({
          projectId: validated.projectId,
          repository: validated.repository,
          rule: target.rule,
          pullRequest: target.pullRequest,
        }),
      );
      if (ok) {
        raised += 1;
      } else {
        attentionFailures += 1;
      }
    }

    let cleared = 0;
    const mustKeepUnassessed = evaluation.unknownForgeStates > 0 || queueOverflow;
    const clearable =
      !budgetExhausted &&
      listed.kind === 'ok' &&
      !listed.failed &&
      !evaluation.truncated &&
      openItems.length <= OPEN_LIST_MAX;
    if (clearable) {
      for (const item of openItems) {
        if (budgetExhausted) {
          break;
        }
        const parsed = this.parseOpenItem(item);
        if (parsed === null) {
          attentionFailures += 1;
          continue;
        }
        if (targetKeys.has(targetKey(parsed.rule, parsed.pullRequest))) {
          continue;
        }
        if (mustKeepUnassessed && (parsed.rule === 'stale-queue-entry' || parsed.rule === 'repeated-park')) {
          continue;
        }
        const budget = await this.budget(validated.deadlineIso);
        if (!budget.ok) {
          return refuse(budget.reason);
        }
        if (!budget.allowed) {
          budgetExhausted = true;
          break;
        }
        const ok = await this.attentionCall(
          () =>
            this.deps.attention.clearTrainHealthAttention({
              projectId: validated.projectId,
              repository: validated.repository,
              rule: parsed.rule,
              pullRequest: parsed.pullRequest,
            }),
          ['cleared', 'unchanged', 'not-found'],
        );
        if (ok) {
          cleared += 1;
        } else {
          attentionFailures += 1;
        }
      }
    }

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
    };
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
