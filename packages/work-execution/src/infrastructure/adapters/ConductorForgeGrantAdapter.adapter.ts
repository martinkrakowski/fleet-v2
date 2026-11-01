/**
 * ConductorForgeGrantAdapter implements ConductorForgeGrantPort by delegating
 * in-process to operator-coordination's IssuePolicyForgeGrantPort with
 * `source: 'conductor'` and the current conductor revision; it never decides
 * eligibility and never issues a merge grant. An unbound delegate refuses
 * `not-configured`; a throwing or malformed delegate refuses `unreadable`;
 * an issued grant whose `decisionRevision` is not `policy:conductor@<rev>`
 * refuses `mismatch`.
 */

import type {
  ConductorForgeGrantPort,
  ConductorForgeGrantRequest,
  ConductorForgeGrantResult,
} from '../../application/ports/out/ConductorForgeGrantPort.out-port.js';

/** The supplier-side request shape (IssuePolicyForgeGrantPort subset). */
export interface ConductorForgeGrantIssueRequest {
  readonly projectId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly forgeKind: 'push-and-open-pr' | 'push-to-pr' | 'post-status';
  readonly expectedHeadSha: string;
  readonly policyRevision: string;
  readonly acceptanceReceiptId: string;
  readonly source: 'conductor';
  readonly settingRevision: string;
}

/** The supplier-side result shape (IssuePolicyForgeGrantPort subset). */
export type ConductorForgeGrantIssueResult =
  | {
      readonly outcome: 'issued';
      readonly grantId: string;
      readonly decisionRevision: string;
    }
  | {
      readonly outcome: 'superseded';
      readonly grantId: string;
      readonly cancelledGrantIds: readonly string[];
      readonly unresolvedGrantIds: readonly string[];
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ConductorForgeGrantDelegate {
  /** IssuePolicyForgeGrantPort.issuePolicyForgeGrant bound by the composition root. */
  readonly issue?: (
    request: ConductorForgeGrantIssueRequest,
  ) => Promise<ConductorForgeGrantIssueResult>;
  /** Current conductor revision (12 lower-case hex) or null when no conductor policy is configured. */
  readonly conductorRevision?: () => string | null;
}

const CONDUCTOR_FORGE_KINDS = ['push-and-open-pr', 'push-to-pr', 'post-status'] as const;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SETTING_REVISION_PATTERN = /^[0-9a-f]{12}$/;
const POLICY_DECISION_REVISION_PREFIX = 'policy:conductor@';
const REQUIRED_TEXT_FIELDS = [
  'projectId',
  'workOrderId',
  'attemptId',
  'policyRevision',
  'acceptanceReceiptId',
] as const;

function validate(request: ConductorForgeGrantRequest): string | null {
  for (const field of REQUIRED_TEXT_FIELDS) {
    const value = request[field];
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 256) {
      return `a conductor grant requires a non-empty ${field} of at most 256 characters`;
    }
  }
  if (!CONDUCTOR_FORGE_KINDS.includes(request.forgeKind)) {
    return 'a conductor grant forgeKind must be push-and-open-pr, push-to-pr or post-status';
  }
  if (
    typeof request.expectedHeadSha !== 'string' ||
    !FULL_COMMIT_PATTERN.test(request.expectedHeadSha.trim())
  ) {
    return 'a conductor grant expectedHeadSha must be a full lower-case commit id';
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ConductorForgeGrantAdapter implements ConductorForgeGrantPort {
  constructor(private readonly delegate?: ConductorForgeGrantDelegate) {}

  async issueConductorForgeGrant(
    request: ConductorForgeGrantRequest,
  ): Promise<ConductorForgeGrantResult> {
    const issue = this.delegate?.issue;
    const conductorRevision = this.delegate?.conductorRevision;
    if (!issue || !conductorRevision) {
      return { outcome: 'refused', reason: 'not-configured' };
    }

    const validation = validate(request);
    if (validation !== null) {
      return { outcome: 'refused', reason: validation };
    }

    let revision: string | null;
    try {
      revision = conductorRevision();
    } catch {
      return { outcome: 'refused', reason: 'unreadable' };
    }
    if (revision === null) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    if (!SETTING_REVISION_PATTERN.test(revision)) {
      return { outcome: 'refused', reason: 'unreadable' };
    }

    let answer: ConductorForgeGrantIssueResult;
    try {
      answer = await issue({
        projectId: request.projectId,
        workOrderId: request.workOrderId,
        attemptId: request.attemptId,
        forgeKind: request.forgeKind,
        expectedHeadSha: request.expectedHeadSha,
        policyRevision: request.policyRevision,
        acceptanceReceiptId: request.acceptanceReceiptId,
        source: 'conductor',
        settingRevision: revision,
      });
    } catch {
      return { outcome: 'refused', reason: 'unreadable' };
    }

    if (!isPlainObject(answer)) {
      return { outcome: 'refused', reason: 'unreadable' };
    }
    if (answer.outcome === 'issued') {
      if (typeof answer.grantId !== 'string' || answer.grantId.length === 0) {
        return { outcome: 'refused', reason: 'unreadable' };
      }
      if (typeof answer.decisionRevision !== 'string') {
        return { outcome: 'refused', reason: 'unreadable' };
      }
      const expectedDecisionRevision = `${POLICY_DECISION_REVISION_PREFIX}${revision}`;
      if (answer.decisionRevision !== expectedDecisionRevision) {
        return { outcome: 'refused', reason: 'mismatch' };
      }
      return {
        outcome: 'issued',
        grantId: answer.grantId,
        decisionRevision: answer.decisionRevision,
      };
    }
    if (answer.outcome === 'refused') {
      if (typeof answer.reason !== 'string' || answer.reason.length === 0) {
        return { outcome: 'refused', reason: 'unreadable' };
      }
      return { outcome: 'refused', reason: answer.reason };
    }
    if (answer.outcome === 'superseded') {
      return { outcome: 'refused', reason: 'superseded' };
    }
    return { outcome: 'refused', reason: 'unreadable' };
  }
}
