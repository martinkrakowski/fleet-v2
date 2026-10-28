// Implemented adapter — auto-merge consumer (cross-context step).
/**
 * AutoMergeOwnerRoutingAdapter implements AutoMergeOwnerRoutingPort by
 * in-process delegation to operator-coordination's AskOwnerQuestionPort and
 * RecordAttentionItemPort, bound by the composition root. Each mapping is
 * owned here; nothing is thrown. An unbound delegate answers refused with
 * 'not-configured'.
 */

import type {
  AskOwnerQuestionPort,
  AskOwnerQuestionRequest,
  AskOwnerQuestionResult,
  RecordAttentionItemBody,
  RecordAttentionItemPort,
  RecordAttentionItemResult,
} from '@fleet/operator-coordination';

import type {
  AutoMergeNotice,
  AutoMergeNoticeResult,
  AutoMergeOwnerRoutingPort,
} from '../../application/ports/out/AutoMergeOwnerRoutingPort.out-port.js';

export interface AutoMergeOwnerRoutingDelegates {
  readonly askOwnerQuestion?: Pick<AskOwnerQuestionPort, 'askOwnerQuestion'>;
  readonly recordAttentionItem?: Pick<RecordAttentionItemPort, 'recordAttentionItem'>;
  /** Mints owner-question ids; injected by the composition root. */
  readonly newQuestionId?: () => string;
}

/** `reason`, then each line after `' | '`, cut to 1000 characters. */
function summaryOf(notice: AutoMergeNotice): string {
  let summary = notice.reason;
  for (const line of notice.lines) {
    summary = summary + ' | ' + line;
  }
  return summary.slice(0, 1000);
}

/** The owner-question body: a title line, reason, head and each notice line, joined with newlines, cut to 8000 characters. */
function bodyOf(notice: AutoMergeNotice): string {
  const lines: string[] = [
    'Auto-merge did not merge attempt ' + notice.attemptId + ' (work order ' + notice.workOrderId + ').',
    'Reason: ' + notice.reason,
    'Head: ' + (notice.headSha ?? 'none'),
  ];
  for (const line of notice.lines) {
    lines.push('- ' + line);
  }
  return lines.join('\n').slice(0, 8000);
}

export class AutoMergeOwnerRoutingAdapter implements AutoMergeOwnerRoutingPort {
  constructor(private readonly delegate?: AutoMergeOwnerRoutingDelegates) {}

  async recordAttention(notice: AutoMergeNotice): Promise<AutoMergeNoticeResult> {
    const recordAttentionItem = this.delegate?.recordAttentionItem?.recordAttentionItem;
    if (!recordAttentionItem) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    const body: RecordAttentionItemBody = {
      projectId: notice.projectId,
      kind: 'auto-merge',
      subject: { kind: 'attempt', ref: notice.attemptId },
      workOrderId: notice.workOrderId,
      summary: summaryOf(notice),
    };
    let answer: RecordAttentionItemResult;
    try {
      answer = await recordAttentionItem(body, 'auto-merge');
    } catch {
      return { outcome: 'refused', reason: 'attention item could not be recorded' };
    }
    switch (answer.outcome) {
      case 'raised':
      case 'reopened':
        return { outcome: 'recorded' };
      case 'refreshed':
        return { outcome: 'exists' };
      case 'refused':
        return { outcome: 'refused', reason: 'attention item refused: ' + answer.code };
    }
  }

  async askOwner(notice: AutoMergeNotice): Promise<AutoMergeNoticeResult> {
    const askOwnerQuestion = this.delegate?.askOwnerQuestion?.askOwnerQuestion;
    const newQuestionId = this.delegate?.newQuestionId;
    if (!askOwnerQuestion || !newQuestionId) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    const title = (
      'Auto-merge held attempt ' + notice.attemptId + ': ' + notice.reason
    ).slice(0, 200);
    const request: AskOwnerQuestionRequest = {
      questionId: newQuestionId(),
      askedBy: 'auto-merge',
      title,
      body: bodyOf(notice),
      doorKind: 'two-way',
      blocks: [{ kind: 'work-order', ref: notice.workOrderId }],
      idempotencyKey: notice.key,
      options: [
        {
          id: 'merge-by-hand',
          label: 'Merge it by hand',
          consequence:
            'You review and merge the pull request yourself; auto-merge does nothing more for this head.',
        },
        {
          id: 'hold',
          label: 'Leave it held',
          consequence:
            'Nothing merges; run fleet-v2 attempt auto-merge for this attempt after the cause is fixed.',
        },
      ],
      recommendation: {
        optionId: 'hold',
        because: 'Auto-merge stopped for a reason it could not resolve itself.',
      },
    };
    let answer: AskOwnerQuestionResult;
    try {
      answer = await askOwnerQuestion(request);
    } catch {
      return { outcome: 'refused', reason: 'owner question could not be asked' };
    }
    switch (answer.outcome) {
      case 'asked':
        return { outcome: 'recorded' };
      case 'exists':
        return { outcome: 'exists' };
      case 'refused':
        return { outcome: 'refused', reason: 'owner question refused' };
    }
  }
}
