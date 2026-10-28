// Implemented adapter — auto-merge consumer (cross-context step).
/**
 * PolicyMergeGrantAdapter implements PolicyMergeGrantPort by in-process
 * delegation to operator-coordination's IssuePolicyForgeGrantPort, bound by
 * the composition root. Each mapping is owned here; nothing is thrown. An
 * unbound delegate answers refused with 'not-configured'.
 */

import type {
  IssuePolicyForgeGrantPort,
  IssuePolicyForgeGrantResult,
} from '@fleet/operator-coordination';

import type {
  PolicyMergeGrantPort,
  PolicyMergeGrantRequest,
  PolicyMergeGrantResult,
} from '../../application/ports/out/PolicyMergeGrantPort.out-port.js';

export interface PolicyMergeGrantDelegates {
  readonly issuePolicyForgeGrant?: Pick<IssuePolicyForgeGrantPort, 'issuePolicyForgeGrant'>;
}

export class PolicyMergeGrantAdapter implements PolicyMergeGrantPort {
  constructor(private readonly delegate?: PolicyMergeGrantDelegates) {}

  async issuePolicyMergeGrant(
    request: PolicyMergeGrantRequest,
  ): Promise<PolicyMergeGrantResult> {
    const issue = this.delegate?.issuePolicyForgeGrant?.issuePolicyForgeGrant;
    if (!issue) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    let answer: IssuePolicyForgeGrantResult;
    try {
      answer = await issue({ ...request, forgeKind: 'merge-pr', source: 'autoMerge' });
    } catch {
      return { outcome: 'refused', reason: 'policy grant could not be issued' };
    }
    switch (answer.outcome) {
      case 'issued':
        if (
          answer.workOrderId !== request.workOrderId ||
          answer.attemptId !== request.attemptId ||
          answer.expectedHeadSha !== request.expectedHeadSha
        ) {
          return {
            outcome: 'refused',
            reason: 'policy grant coordinates do not match the request',
          };
        }
        return {
          outcome: 'issued',
          grantId: answer.grantId,
          decisionRevision: answer.decisionRevision,
        };
      case 'superseded':
        return { outcome: 'superseded' };
      case 'refused':
        return { outcome: 'refused', reason: answer.reason.slice(0, 300) };
      default:
        return { outcome: 'refused', reason: 'unexpected policy grant answer' };
    }
  }
}
