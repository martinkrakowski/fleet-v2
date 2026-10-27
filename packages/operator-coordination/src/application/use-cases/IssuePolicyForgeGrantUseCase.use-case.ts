/**
 * IssuePolicyForgeGrantUseCase implements IssuePolicyForgeGrantPort. It records
 * one approved action-decision for an exact forge action at an accepted head:
 * merge-pr named by policy:autoMerge@<rev>, push-and-open-pr and push-to-pr by
 * policy:conductor@<rev>, bound to its work order, attempt and acceptance
 * receipt. It cancels every earlier unconsumed policy grant of the work order
 * first, saves the new grant, then sweeps: the newest live grant (ordered by
 * createdAtIso then id) stays live -- a newer concurrent issuer supersedes
 * this issue, which cancels its own grant. It never decides eligibility.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import {
  POLICY_GRANT_FORGE_KINDS,
  POLICY_GRANT_HEAD_PATTERN,
  POLICY_GRANT_SOURCES,
  POLICY_GRANT_SOURCE_FOR_KIND,
  POLICY_SETTING_REVISION_PATTERN,
  policyDecisionRevision,
  policyGrantActionScope,
  policyGrantProposalDigest,
} from '../../domain/policy-grants.js';
import type { PolicyGrantForgeKind, PolicyGrantSource } from '../../domain/policy-grants.js';
import type {
  IssuePolicyForgeGrantPort,
  IssuePolicyForgeGrantRequest,
  IssuePolicyForgeGrantResult,
  PolicyGrantClock,
  PolicyGrantIdSource,
} from '../ports/in/IssuePolicyForgeGrantPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { cancelPolicyGrantOnce } from './policy-grant-cancel.js';

export interface IssuePolicyForgeGrantDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly clock: PolicyGrantClock;
  readonly ids: PolicyGrantIdSource;
}

const REQUIRED_TEXT_FIELDS = [
  'projectId',
  'workOrderId',
  'attemptId',
  'policyRevision',
  'acceptanceReceiptId',
] as const;

/** strict: a leftover conflict refuses the whole issue; best-effort: the sweep ignores it. */
type CancelMode = 'strict' | 'best-effort';

function refused(reason: string): IssuePolicyForgeGrantResult {
  return { outcome: 'refused', reason };
}

export class IssuePolicyForgeGrantUseCase implements IssuePolicyForgeGrantPort {
  constructor(private readonly deps?: IssuePolicyForgeGrantDependencies) {}

  async issuePolicyForgeGrant(
    request: IssuePolicyForgeGrantRequest,
  ): Promise<IssuePolicyForgeGrantResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<IssuePolicyForgeGrantResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: IssuePolicyForgeGrantUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: IssuePolicyForgeGrantUseCase');
    }
    const request = input as IssuePolicyForgeGrantRequest;
    const validation = this.validate(request);
    if (validation !== null) {
      return refused(validation);
    }
    const projectId = request.projectId.trim();
    const workOrderId = request.workOrderId.trim();
    const attemptId = request.attemptId.trim();
    const policyRevision = request.policyRevision.trim();
    const acceptanceReceiptId = request.acceptanceReceiptId.trim();
    const forgeKind = request.forgeKind;
    const source = request.source;
    const settingRevision = request.settingRevision.trim();
    const expectedHeadSha = request.expectedHeadSha.trim();

    const requestId = this.deps.ids.newRequestId();
    const grantId = this.deps.ids.newGrantId();
    if (
      typeof requestId !== 'string' ||
      requestId.trim().length === 0 ||
      typeof grantId !== 'string' ||
      grantId.trim().length === 0
    ) {
      return refused('a minted policy grant id is already recorded');
    }
    if (
      (await this.deps.requestRepo.findRequestById(requestId)) !== null ||
      (await this.deps.requestRepo.findRequestByGrantId(grantId)) !== null
    ) {
      return refused('a minted policy grant id is already recorded');
    }
    const now = this.deps.clock.nowIso();

    const earlier = (await this.deps.requestRepo.listRequests(projectId)).filter((record) =>
      this.isLiveWorkOrderGrant(record, workOrderId),
    );
    const cancelledEarlier = await this.cancelTargets(earlier, now, 'strict');
    if (cancelledEarlier.conflict) {
      return refused('an earlier policy grant moved while it was being cancelled; nothing was issued');
    }

    const grant = this.buildGrant({
      requestId,
      projectId,
      workOrderId,
      attemptId,
      acceptanceReceiptId,
      forgeKind,
      source,
      settingRevision,
      expectedHeadSha,
      now,
      grantId,
      policyRevision,
    });
    let validated: CoordinationRequestRecord;
    try {
      validated = CoordinationRequest.fromRecord(grant).toRecord();
    } catch {
      return refused('policy grant record could not be built');
    }
    await this.deps.requestRepo.saveRequest(validated);

    // After saving the new grant, re-list the work order's live policy grants
    // and keep only the newest (ordered by createdAtIso then id) live. When a
    // newer live grant exists, this issue's own grant is cancelled and the
    // result is superseded -- a fixed outcome, never an error. A crash between
    // the save above and this sweep leaves two live grants; the next issue or
    // cancel for this work order converges them, because the newest wins. A
    // resolve by grant id still requires an exact head.
    const live = (await this.deps.requestRepo.listRequests(projectId)).filter((record) =>
      this.isLiveWorkOrderGrant(record, workOrderId),
    );
    const ordered = [...live].sort((left, right) => {
      if (left.createdAtIso !== right.createdAtIso) {
        return left.createdAtIso < right.createdAtIso ? -1 : 1;
      }
      return left.id < right.id ? -1 : 1;
    });
    const newest = ordered.at(-1);
    if (newest?.id !== requestId) {
      // A newer live grant exists: this issue's own grant is cancelled and the
      // newer one stays live. Superseded is a fixed outcome, never an error.
      const mine = await this.deps.requestRepo.findRequestById(requestId);
      const own =
        mine !== null && this.isLiveWorkOrderGrant(mine, workOrderId)
          ? await cancelPolicyGrantOnce(this.deps.requestRepo, mine, now)
          : 'skipped';
      // Report only what happened: a confirmed cancel, nothing to cancel, or a cancel that may
      // have left this grant live beside the newer one.
      return {
        outcome: 'superseded',
        requestId,
        grantId,
        cancelledGrantIds: own === 'cancelled' ? [grantId] : [],
        unresolvedGrantIds: own === 'conflict' ? [grantId] : [],
      };
    }
    const cancelledSwept = await this.cancelTargets(ordered.slice(0, -1), now, 'best-effort');

    const cancelledGrantIds = [
      ...cancelledEarlier.cancelledIds,
      ...cancelledSwept.cancelledIds,
    ].sort((left, right) => left.localeCompare(right));

    return {
      outcome: 'issued',
      requestId,
      grantId,
      actionScope: policyGrantActionScope(forgeKind),
      decisionRevision: policyDecisionRevision(source, settingRevision),
      workOrderId,
      attemptId,
      expectedHeadSha,
      cancelledGrantIds,
    };
  }

  private validate(request: IssuePolicyForgeGrantRequest): string | null {
    for (const field of REQUIRED_TEXT_FIELDS) {
      const value = request[field];
      if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 256) {
        return `a policy grant requires a non-empty ${field} of at most 256 characters`;
      }
    }
    if (!POLICY_GRANT_FORGE_KINDS.includes(request.forgeKind)) {
      return 'a policy grant forgeKind must be one of push-and-open-pr, push-to-pr, merge-pr';
    }
    if (!POLICY_GRANT_SOURCES.includes(request.source)) {
      return 'a policy grant source must be autoMerge or conductor';
    }
    if (POLICY_GRANT_SOURCE_FOR_KIND[request.forgeKind] !== request.source) {
      return 'a policy grant for this forge kind must be authorised by its own setting';
    }
    if (
      typeof request.settingRevision !== 'string' ||
      !POLICY_SETTING_REVISION_PATTERN.test(request.settingRevision.trim())
    ) {
      return 'a policy grant settingRevision must be 12 lower-case hex characters';
    }
    if (
      typeof request.expectedHeadSha !== 'string' ||
      !POLICY_GRANT_HEAD_PATTERN.test(request.expectedHeadSha.trim())
    ) {
      return 'a policy grant expectedHeadSha must be a full lower-case commit id';
    }
    return null;
  }

  private isLiveWorkOrderGrant(record: CoordinationRequestRecord, workOrderId: string): boolean {
    return (
      record.state === 'approved' &&
      record.consumptions.length === 0 &&
      record.policyGrant?.workOrderId === workOrderId
    );
  }

  private buildGrant(input: {
    readonly requestId: string;
    readonly projectId: string;
    readonly workOrderId: string;
    readonly attemptId: string;
    readonly acceptanceReceiptId: string;
    readonly forgeKind: PolicyGrantForgeKind;
    readonly source: PolicyGrantSource;
    readonly settingRevision: string;
    readonly expectedHeadSha: string;
    readonly now: string;
    readonly grantId: string;
    readonly policyRevision: string;
  }): CoordinationRequestRecord {
    return {
      id: input.requestId,
      projectId: input.projectId,
      kind: 'action-decision',
      state: 'approved',
      actionScope: policyGrantActionScope(input.forgeKind),
      expectedHeadSha: input.expectedHeadSha,
      proposalDigest: policyGrantProposalDigest(
        input.attemptId,
        input.expectedHeadSha,
        input.acceptanceReceiptId,
      ),
      policyRevision: input.policyRevision,
      decisionRevision: policyDecisionRevision(input.source, input.settingRevision),
      grantId: input.grantId,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: input.now,
      updatedAtIso: input.now,
      policyGrant: {
        workOrderId: input.workOrderId,
        attemptId: input.attemptId,
        acceptanceReceiptId: input.acceptanceReceiptId,
      },
    };
  }

  /** Sequential cancels over a promise chain (never `for … await`). */
  private async cancelTargets(
    targets: readonly CoordinationRequestRecord[],
    now: string,
    mode: CancelMode,
  ): Promise<{ readonly cancelledIds: string[]; readonly conflict: boolean }> {
    const cancelledIds: string[] = [];
    let stopped = false;
    let conflict = false;
    await targets.reduce(
      (chain, record) =>
        chain.then(async () => {
          if (stopped) {
            return;
          }
          const outcome = await cancelPolicyGrantOnce(
            this.deps!.requestRepo,
            record,
            now,
          );
          if (outcome === 'cancelled') {
            if (record.grantId !== null) {
              cancelledIds.push(record.grantId);
            }
          } else if (outcome === 'conflict') {
            conflict = true;
            if (mode === 'strict') {
              stopped = true;
            }
          }
        }),
      Promise.resolve(),
    );
    return { cancelledIds, conflict };
  }
}
