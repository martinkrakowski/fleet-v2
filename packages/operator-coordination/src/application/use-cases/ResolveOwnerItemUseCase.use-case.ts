/**
 * ResolveOwnerItemUseCase implements ResolveOwnerItemPort. It applies exactly
 * one typed resolution (plan §3.3) to one owner item and saves it at the
 * revision read: a merge record or forge observation of the item's pull
 * request, the recorded answer read from the owner question store (never the
 * request), the plan's decided or removed row, or the owner marking done or
 * withdrawing a secret, backup or other item. A repeat writes nothing; a lost
 * race is retried once.
 */

import { OwnerItem, ownerItemMergeKey, ownerItemPlanDecisionKey, ownerItemQuestionKey } from '../../domain/entities/OwnerItem.js';
import { readPlainObject, readPlainObjectWithOptional } from '../../domain/record-input.js';
import {
  OwnerItemRevisionConflictError,
  type OwnerItemRepositoryPort,
  type StoredOwnerItem,
} from '../ports/out/OwnerItemRepositoryPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerItemClock } from '../ports/in/RecordOwnerItemPort.in-port.js';
import type {
  ResolveOwnerItemPort,
  ResolveOwnerItemRefusalCode,
  ResolveOwnerItemResult,
} from '../ports/in/ResolveOwnerItemPort.in-port.js';

export interface ResolveOwnerItemDependencies {
  readonly itemRepo: OwnerItemRepositoryPort;
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
  readonly clock: OwnerItemClock;
}

const ACTIONS = ['observe-pr', 'answer', 'plan-decision', 'done', 'withdraw'] as const;
type ActionKind = (typeof ACTIONS)[number];

const ALL_REQUEST_KEYS: readonly string[] = [
  'action',
  'projectId',
  'repository',
  'number',
  'state',
  'source',
  'observedAtIso',
  'questionId',
  'planId',
  'decisionId',
  'outcome',
  'planRevision',
  'itemId',
  'via',
  'reason',
];

const ACTION_KEYS: Record<ActionKind, readonly string[]> = {
  'observe-pr': ['action', 'projectId', 'repository', 'number', 'state', 'source', 'observedAtIso'],
  answer: ['action', 'questionId'],
  'plan-decision': ['action', 'projectId', 'planId', 'decisionId', 'outcome', 'planRevision'],
  done: ['action', 'itemId', 'via'],
  withdraw: ['action', 'itemId', 'reason'],
};

function isActionKind(value: unknown): value is ActionKind {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

type TransitionInputResult =
  | { readonly kind: 'input'; readonly value: Record<string, unknown> }
  | ResolveOwnerItemResult;

export class ResolveOwnerItemUseCase implements ResolveOwnerItemPort {
  constructor(private readonly deps?: ResolveOwnerItemDependencies) {}

  resolveOwnerItem(request: unknown, actor: string): Promise<ResolveOwnerItemResult> {
    return this.execute(request, actor);
  }

  async execute(request: unknown, actor: unknown): Promise<ResolveOwnerItemResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ResolveOwnerItemUseCase');
    }

    // 1. The request is a closed plain object whose keys are all known; the
    //    action must be one of the five. A throw is a request refusal.
    let actionRead: Record<string, unknown> | null;
    try {
      actionRead = readPlainObjectWithOptional(request, ['action'], ALL_REQUEST_KEYS);
    } catch {
      actionRead = null;
    }
    if (actionRead === null) {
      return this.refuse('request', 'ResolveOwnerItem requires exactly the fields of its action');
    }
    const action = actionRead.action;
    if (!isActionKind(action)) {
      return this.refuse(
        'request',
        'ResolveOwnerItem action is not one of observe-pr, answer, plan-decision, done, withdraw',
      );
    }

    // 2. The request must be exactly the fields of its action, with valid
    //    lookup fields; every other field is validated by the domain.
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readPlainObject(request, ACTION_KEYS[action]);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      return this.refuse('request', 'ResolveOwnerItem requires exactly the fields of its action');
    }
    if (this.lookupFieldInvalid(action, parsed)) {
      return this.refuse('request', 'ResolveOwnerItem a lookup field is invalid');
    }

    // 3. The actor is who marks done or withdraws; the clock supplies the
    //    moment for plan decisions and owner closure.
    let actorId: string | undefined;
    if (action === 'done' || action === 'withdraw') {
      if (typeof actor !== 'string') {
        return this.refuse('request', 'ResolveOwnerItem the actor could not be identified');
      }
      actorId = actor;
    }
    let nowIso: string | undefined;
    if (action === 'plan-decision' || action === 'done' || action === 'withdraw') {
      nowIso = this.deps.clock.nowIso();
      if (!Number.isFinite(Date.parse(nowIso))) {
        return this.refuse('clock-read', 'ResolveOwnerItem the clock could not be read');
      }
    }

    // 4. One attempt; a lost race is retried once.
    const first = await this.attemptOnce(action, parsed, actorId, nowIso);
    if (first !== 'conflict') {
      return first;
    }
    const second = await this.attemptOnce(action, parsed, actorId, nowIso);
    if (second !== 'conflict') {
      return second;
    }
    return this.refuse('conflict', 'ResolveOwnerItem another writer moved this item first; resolve again');
  }

  private refuse(code: ResolveOwnerItemRefusalCode, reason: string): ResolveOwnerItemResult {
    return { outcome: 'refused', code, reason };
  }

  private async attemptOnce(
    action: ActionKind,
    parsed: Record<string, unknown>,
    actor: string | undefined,
    nowIso: string | undefined,
  ): Promise<ResolveOwnerItemResult | 'conflict'> {
    // 1. Find the stored item by the table in the Goal.
    const stored = await this.findStored(action, parsed);
    if (stored === null) {
      return { outcome: 'not-found' };
    }

    // 2. Read the aggregate; failure is a refusal with the domain's code.
    const loaded = OwnerItem.create(stored.item);
    if (!loaded.success) {
      return { outcome: 'refused', code: loaded.code, reason: loaded.error.message };
    }

    // 3. Build the transition input (one small function per action); a
    //    refusal or not-found is returned as-is.
    const built = await this.transitionInput(action, parsed, actor, nowIso);
    if (!('kind' in built)) {
      return built;
    }
    const input = built.value;

    // 4. Apply the transition; failure is a refusal with the domain's code.
    const transition = this.applyTransition(action, loaded.value, input);
    if (!transition.success) {
      return { outcome: 'refused', code: transition.code, reason: transition.error.message };
    }

    // 5. A repeated resolution returns the same instance and writes nothing.
    if (transition.value === loaded.value) {
      return { outcome: 'unchanged', item: stored.item, revision: stored.revision };
    }

    // 6. Save at the revision read; a lost race returns 'conflict'.
    try {
      const saved = await this.deps!.itemRepo.save(transition.value.toRecord(), stored.revision);
      return { outcome: 'resolved', item: saved.item, revision: saved.revision };
    } catch (error) {
      if (error instanceof OwnerItemRevisionConflictError) {
        return 'conflict';
      }
      throw error;
    }
  }

  private async findStored(action: ActionKind, parsed: Record<string, unknown>): Promise<StoredOwnerItem | null> {
    switch (action) {
      case 'observe-pr':
        return this.deps!.itemRepo.findByKey(
          ownerItemMergeKey(parsed.projectId as string, parsed.repository as string, parsed.number as number),
        );
      case 'answer':
        return this.deps!.itemRepo.findByKey(ownerItemQuestionKey(parsed.questionId as string));
      case 'plan-decision':
        return this.deps!.itemRepo.findByKey(
          ownerItemPlanDecisionKey(parsed.projectId as string, parsed.planId as string, parsed.decisionId as string),
        );
      case 'done':
      case 'withdraw':
        return this.deps!.itemRepo.get(parsed.itemId as string);
    }
  }

  private async transitionInput(
    action: ActionKind,
    parsed: Record<string, unknown>,
    actor: string | undefined,
    nowIso: string | undefined,
  ): Promise<TransitionInputResult> {
    switch (action) {
      case 'observe-pr':
        return {
          kind: 'input',
          value: {
            repository: parsed.repository,
            number: parsed.number,
            state: parsed.state,
            source: parsed.source,
            observedAtIso: parsed.observedAtIso,
          },
        };
      case 'answer': {
        const question = await this.deps!.ownerQuestionRepo.get(parsed.questionId as string);
        if (question === null) {
          return { outcome: 'not-found' };
        }
        if (question.answer === null) {
          return { outcome: 'refused', code: 'no-choice', reason: 'ResolveOwnerItem the question has no recorded answer' };
        }
        return {
          kind: 'input',
          value: {
            questionId: question.questionId,
            shape: question.answer.shape,
            hasOption: question.answer.optionId !== null,
            hasText: question.answer.text !== null && question.answer.text.trim().length > 0,
            answeredAtIso: question.answer.answeredAt,
          },
        };
      }
      case 'plan-decision':
        return {
          kind: 'input',
          value: {
            planId: parsed.planId,
            decisionId: parsed.decisionId,
            outcome: parsed.outcome,
            planRevision: parsed.planRevision,
            atIso: nowIso,
          },
        };
      case 'done':
        return { kind: 'input', value: { via: parsed.via, by: actor, atIso: nowIso } };
      case 'withdraw':
        return { kind: 'input', value: { reason: parsed.reason, by: actor, atIso: nowIso } };
    }
  }

  private applyTransition(action: ActionKind, item: OwnerItem, input: Record<string, unknown>) {
    switch (action) {
      case 'observe-pr':
        return item.observePullRequest(input);
      case 'answer':
        return item.recordAnswer(input);
      case 'plan-decision':
        return item.recordPlanDecision(input);
      case 'done':
        return item.markDone(input);
      case 'withdraw':
        return item.withdraw(input);
    }
  }

  private lookupFieldInvalid(action: ActionKind, parsed: Record<string, unknown>): boolean {
    switch (action) {
      case 'observe-pr':
        return (
          typeof parsed.projectId !== 'string' ||
          parsed.projectId.length === 0 ||
          typeof parsed.repository !== 'string' ||
          parsed.repository.length === 0 ||
          typeof parsed.number !== 'number' ||
          !Number.isSafeInteger(parsed.number) ||
          parsed.number < 1
        );
      case 'answer':
        return typeof parsed.questionId !== 'string' || parsed.questionId.length === 0;
      case 'plan-decision':
        return (
          typeof parsed.projectId !== 'string' ||
          parsed.projectId.length === 0 ||
          typeof parsed.planId !== 'string' ||
          parsed.planId.length === 0 ||
          typeof parsed.decisionId !== 'string' ||
          parsed.decisionId.length === 0
        );
      case 'done':
      case 'withdraw':
        return typeof parsed.itemId !== 'string' || parsed.itemId.length === 0;
    }
  }
}
