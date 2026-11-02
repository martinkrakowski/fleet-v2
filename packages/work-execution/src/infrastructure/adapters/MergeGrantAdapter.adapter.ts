// Implemented adapter — merge-pass consumer (cross-context step).
/**
 * MergeGrantAdapter implements MergeGrantPort by in-process delegation: the
 * attempt-bound variant maps exactly as PolicyMergeGrantAdapter does today to
 * operator-coordination's IssuePolicyForgeGrantPort; the attempt-less variant
 * delegates to operator-coordination's IssueMergeGrantPort. Each mapping is
 * owned here; nothing is thrown. A missing delegate for the request's kind
 * answers refused with 'not-configured'.
 */

import type {
  IssueMergeGrantPort,
  IssueMergeGrantResult,
  IssuePolicyForgeGrantPort,
  IssuePolicyForgeGrantResult,
  MergeGrantForgeKind as SupplierMergeGrantForgeKind,
} from '@fleet/operator-coordination';

import type {
  MergeGrantForgeKind,
  MergeGrantPort,
  MergeGrantRequest,
  MergeGrantResult,
} from '../../application/ports/out/MergeGrantPort.out-port.js';
import type { PolicyMergeGrantRequest } from '../../application/ports/out/PolicyMergeGrantPort.out-port.js';

export interface MergeGrantDelegates {
  readonly issuePolicyForgeGrant?: Pick<IssuePolicyForgeGrantPort, 'issuePolicyForgeGrant'>;
  readonly issueMergeGrant?: Pick<IssueMergeGrantPort, 'issueMergeGrant'>;
}

type AttemptBoundRequest = Extract<MergeGrantRequest, { kind: 'attempt-bound' }>;
type AttemptLessRequest = Extract<MergeGrantRequest, { kind: 'attempt-less' }>;

function mapMergeGrantForgeKind(kind: MergeGrantForgeKind): SupplierMergeGrantForgeKind {
  switch (kind) {
    case 'merge-pr':
      return 'merge-pr';
    case 'update-branch':
      return 'update-branch';
    case 'post-status':
      return 'post-status';
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported forge kind: ${exhaustive}`);
    }
  }
}

export class MergeGrantAdapter implements MergeGrantPort {
  constructor(private readonly delegate?: MergeGrantDelegates) {}

  async issueMergeGrant(request: MergeGrantRequest): Promise<MergeGrantResult> {
    if (request.kind === 'attempt-bound') {
      return this.issueAttemptBound(request);
    }
    return this.issueAttemptLess(request);
  }

  private async issueAttemptBound(request: AttemptBoundRequest): Promise<MergeGrantResult> {
    // The delegate is called through its object, so a class-based port keeps its receiver.
    const port = this.delegate?.issuePolicyForgeGrant;
    if (!port) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    const policyRequest: PolicyMergeGrantRequest = {
      projectId: request.projectId,
      workOrderId: request.workOrderId,
      attemptId: request.attemptId,
      expectedHeadSha: request.expectedHeadSha,
      policyRevision: request.policyRevision,
      acceptanceReceiptId: request.acceptanceReceiptId,
      settingRevision: request.settingRevision,
    };
    let answer: IssuePolicyForgeGrantResult;
    try {
      answer = await port.issuePolicyForgeGrant({
        ...policyRequest,
        forgeKind: 'merge-pr',
        source: 'autoMerge',
      });
    } catch {
      return { outcome: 'refused', reason: 'policy grant could not be issued' };
    }
    switch (answer.outcome) {
      case 'issued':
        if (
          answer.workOrderId !== policyRequest.workOrderId ||
          answer.attemptId !== policyRequest.attemptId ||
          answer.expectedHeadSha !== policyRequest.expectedHeadSha
        ) {
          return {
            outcome: 'refused',
            reason: 'policy grant coordinates do not match the request',
          };
        }
        return {
          outcome: 'issued',
          requestId: answer.requestId,
          grantId: answer.grantId,
          decisionRevision: answer.decisionRevision,
          cancelledGrantIds: answer.cancelledGrantIds,
        };
      case 'superseded':
        return {
          outcome: 'superseded',
          requestId: answer.requestId,
          grantId: answer.grantId,
          cancelledGrantIds: answer.cancelledGrantIds,
          unresolvedGrantIds: answer.unresolvedGrantIds,
        };
      case 'refused':
        return { outcome: 'refused', reason: answer.reason.slice(0, 300) };
      default:
        return { outcome: 'refused', reason: 'unexpected policy grant answer' };
    }
  }

  private async issueAttemptLess(request: AttemptLessRequest): Promise<MergeGrantResult> {
    // The delegate is called through its object, so a class-based port keeps its receiver.
    const port = this.delegate?.issueMergeGrant;
    if (!port) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    let answer: IssueMergeGrantResult;
    try {
      answer = await port.issueMergeGrant({
        projectId: request.projectId,
        repository: request.repository,
        pullRequestNumber: request.pullRequestNumber,
        expectedHeadSha: request.expectedHeadSha,
        forgeKind: mapMergeGrantForgeKind(request.forgeKind),
        settingRevision: request.settingRevision,
        deadlineIso: request.deadlineIso,
      });
    } catch {
      return { outcome: 'refused', reason: 'merge grant could not be issued' };
    }
    switch (answer.outcome) {
      case 'issued':
        return {
          outcome: 'issued',
          requestId: answer.requestId,
          grantId: answer.grantId,
          decisionRevision: answer.decisionRevision,
          cancelledGrantIds: answer.cancelledGrantIds,
        };
      case 'superseded':
        return {
          outcome: 'superseded',
          requestId: answer.requestId,
          grantId: answer.grantId,
          cancelledGrantIds: answer.cancelledGrantIds,
          unresolvedGrantIds: answer.unresolvedGrantIds,
        };
      case 'refused':
        return { outcome: 'refused', reason: answer.reason.slice(0, 300) };
      default:
        return { outcome: 'refused', reason: 'unexpected merge grant answer' };
    }
  }
}
