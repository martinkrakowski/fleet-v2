/**
 * LaneRunParkNoticeAdapter implements LaneRunParkNoticePort by delegating
 * in-process to operator-coordination's RecordAttentionItemPort,
 * AskOwnerQuestionPort and FindOwnerQuestionByKeyPort, bound by the
 * composition root (same delegate pattern as ActionAuthorizationAdapter).
 *
 * The attention body and the owner question's title, body, options and
 * recommendation are fixed text naming the reason code; never lane output,
 * never free text from the caller. Reasons and qualifiers are codes only.
 * Unbound delegates refuse as `not-configured`; a thrown or refused delegate
 * answer is `unreadable`, never a guess.
 */

import type {
  OwnerQuestionBlockRecord,
  OwnerQuestionDoorKind,
  OwnerQuestionOptionRecord,
  OwnerQuestionRecommendationRecord,
} from '@fleet/operator-coordination';

import type {
  LaneRunParkFindResult,
  LaneRunParkNoticePort,
  LaneRunParkNoticeResult,
  LaneRunParkQuestionState,
  LaneRunParkRequest,
} from '../../application/ports/out/LaneRunParkNoticePort.out-port.js';

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface LaneRunParkNoticeDelegate {
  readonly recordAttentionItem?: (body: unknown, actor: string) => Promise<unknown>;
  readonly askOwnerQuestion?: (request: unknown) => Promise<unknown>;
  readonly findOwnerQuestionByKey?: (request: {
    idempotencyKey: string;
  }) => Promise<unknown>;
}

/** The attention kind every conductor park notice carries. */
export const PARK_ATTENTION_KIND = 'conductor-park';

/** The actor the conductor raises park notices as. */
export const PARK_ACTOR = 'conductor';

/** The reasons whose owner question the conductor fixes the text of. */
export const PARK_QUESTION_REASONS: readonly string[] = [
  'one-way-door',
  'owner-merge',
  'blocker-after-round-2',
  'seat-plan-exhausted',
];

/** The reason code that opens a one-way door question; every other reason is two-way. */
const ONE_WAY_REASON = 'one-way-door';

/** Fixed title and body per reason code; the codes decide, never lane output. */
function questionTexts(
  reason: string,
  request: LaneRunParkRequest,
): { readonly title: string; readonly body: string } {
  const coordinates = `run ${request.runId} of work order ${request.workOrderId} in project ${request.projectId}`;
  switch (reason) {
    case 'one-way-door':
      return {
        title: `Lane run parked: one-way door (${reason})`,
        body: `The conductor parked ${coordinates} with reason ${reason}. The run reached a one-way door that the owner must decide before the run may continue. Choose resume or stop.`,
      };
    case 'owner-merge':
      return {
        title: `Lane run parked: owner merge (${reason})`,
        body: `The conductor parked ${coordinates} with reason ${reason}. Automatic merge is off for this run, so the owner merges by hand. Choose resume or stop.`,
      };
    case 'blocker-after-round-2':
      return {
        title: `Lane run parked: blocker after round 2 (${reason})`,
        body: `The conductor parked ${coordinates} with reason ${reason}. The run still carries a blocker after its second fix round. Choose resume or stop.`,
      };
    case 'seat-plan-exhausted':
      return {
        title: `Lane run parked: seat plan exhausted (${reason})`,
        body: `The conductor parked ${coordinates} with reason ${reason}. The seat plan has no remaining seat for the run. Choose resume or stop.`,
      };
    default:
      throw new Error(`unknown park reason code: ${reason}`);
  }
}

const PARK_OPTIONS: readonly OwnerQuestionOptionRecord[] = [
  { id: 'resume', label: 'Resume the run', consequence: 'The lane run continues from its parked state.' },
  { id: 'stop', label: 'Stop the run', consequence: 'The lane run stops and stays parked.' },
];

const PARK_RECOMMENDATION: OwnerQuestionRecommendationRecord = {
  optionId: 'resume',
  because: 'The parked run should continue once the owner has seen the notice.',
};

function doorKindFor(reason: string): OwnerQuestionDoorKind {
  return reason === ONE_WAY_REASON ? 'one-way' : 'two-way';
}

/** Map an owner-question record's state onto the conductor's three read states. */
function parkState(state: unknown): LaneRunParkQuestionState {
  if (state === 'open') {
    return 'open';
  }
  if (state === 'expired') {
    return 'expired';
  }
  return 'answered';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function questionIdOf(answer: unknown): string | undefined {
  if (isPlainObject(answer) && isPlainObject(answer.question) && typeof answer.question.questionId === 'string') {
    return answer.question.questionId;
  }
  return undefined;
}

export class LaneRunParkNoticeAdapter implements LaneRunParkNoticePort {
  constructor(private readonly delegate?: LaneRunParkNoticeDelegate) {}

  async recordParkAttention(request: LaneRunParkRequest): Promise<LaneRunParkNoticeResult> {
    const recordAttentionItem = this.delegate?.recordAttentionItem;
    if (!recordAttentionItem) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    const qualifier = request.qualifier === undefined ? '' : `, qualifier ${request.qualifier}`;
    const body = {
      projectId: request.projectId,
      kind: PARK_ATTENTION_KIND,
      subject: { kind: 'run', ref: request.runId },
      workOrderId: request.workOrderId,
      summary: `The conductor parked ${request.runId} with reason ${request.reason}${qualifier}.`,
    };
    try {
      const answer = await recordAttentionItem(body, PARK_ACTOR);
      if (
        isPlainObject(answer) &&
        (answer.outcome === 'raised' || answer.outcome === 'refreshed' || answer.outcome === 'reopened')
      ) {
        return { outcome: 'recorded' };
      }
      return { outcome: 'refused', reason: 'unreadable' };
    } catch {
      return { outcome: 'refused', reason: 'unreadable' };
    }
  }

  async askParkQuestion(request: LaneRunParkRequest): Promise<LaneRunParkNoticeResult> {
    const askOwnerQuestion = this.delegate?.askOwnerQuestion;
    if (!askOwnerQuestion) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    let texts: { readonly title: string; readonly body: string };
    try {
      texts = questionTexts(request.reason, request);
    } catch {
      return { outcome: 'refused', reason: 'unknown-reason' };
    }
    const blocks: readonly OwnerQuestionBlockRecord[] = [
      { kind: 'lane', ref: request.runId },
    ];
    const ask = {
      questionId: `park-question:${request.key}`,
      askedBy: PARK_ACTOR,
      title: texts.title,
      body: texts.body,
      options: PARK_OPTIONS,
      recommendation: PARK_RECOMMENDATION,
      doorKind: doorKindFor(request.reason),
      linkedRequestId: null,
      blocks,
      expiresAt: null,
      idempotencyKey: request.key,
    };
    try {
      const answer = await askOwnerQuestion(ask);
      if (isPlainObject(answer) && (answer.outcome === 'asked' || answer.outcome === 'exists')) {
        return { outcome: answer.outcome === 'asked' ? 'recorded' : 'exists', questionId: questionIdOf(answer) };
      }
      return { outcome: 'refused', reason: 'unreadable' };
    } catch {
      return { outcome: 'refused', reason: 'unreadable' };
    }
  }

  async findParkQuestion(key: string): Promise<LaneRunParkFindResult> {
    const findOwnerQuestionByKey = this.delegate?.findOwnerQuestionByKey;
    if (!findOwnerQuestionByKey) {
      return { outcome: 'unavailable' };
    }
    try {
      const answer = await findOwnerQuestionByKey({ idempotencyKey: key });
      if (isPlainObject(answer) && answer.outcome === 'found') {
        const question = answer.question;
        if (isPlainObject(question) && typeof question.questionId === 'string') {
          return {
            outcome: 'found',
            questionId: question.questionId,
            state: parkState(question.state),
          };
        }
        return { outcome: 'unavailable' };
      }
      if (isPlainObject(answer) && answer.outcome === 'not-found') {
        return { outcome: 'not-found' };
      }
      return { outcome: 'unavailable' };
    } catch {
      return { outcome: 'unavailable' };
    }
  }
}
