/**
 * IssueMergeGrantUseCase implements IssueMergeGrantPort. It records one approved
 * attempt-less action-decision for an exact repository pull request at an
 * expected head: `policy:merge@<rev>` authorises the grant, bound to
 * (repository, pullRequestNumber, expectedHeadSha). It cancels every earlier
 * unconsumed merge grant of the same pull request first (strict), saves the new
 * grant, then sweeps: the newest live grant (ordered by createdAtIso then id)
 * stays live — a newer concurrent issuer supersedes this issue, which cancels
 * its own grant. It writes nothing to any forge and never reads an attempt. It
 * never decides eligibility.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import {
  MERGE_GRANT_FORGE_KINDS,
  POLICY_GRANT_HEAD_PATTERN,
  POLICY_SETTING_REVISION_PATTERN,
  mergeGrantActionScope,
  mergeGrantDecisionRevision,
  mergeGrantProposalDigest,
} from '../../domain/policy-grants.js';
import type { MergeGrantForgeKind } from '../../domain/policy-grants.js';
import type {
  IssueMergeGrantPort,
  IssueMergeGrantRequest,
  IssueMergeGrantResult,
  PolicyGrantClock,
  PolicyGrantIdSource,
} from '../ports/in/IssueMergeGrantPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { cancelPolicyGrantOnce } from './policy-grant-cancel.js';

export interface IssueMergeGrantDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly clock: PolicyGrantClock;
  readonly ids: PolicyGrantIdSource;
}

/** strict: a leftover conflict refuses the whole issue; best-effort: the sweep ignores it. */
type CancelMode = 'strict' | 'best-effort';

function refused(reason: string): IssueMergeGrantResult {
  return { outcome: 'refused', reason };
}

export class IssueMergeGrantUseCase implements IssueMergeGrantPort {
  constructor(private readonly deps?: IssueMergeGrantDependencies) {}

  async issueMergeGrant(request: IssueMergeGrantRequest): Promise<IssueMergeGrantResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<IssueMergeGrantResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: IssueMergeGrantUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: IssueMergeGrantUseCase');
    }
    const request = input as IssueMergeGrantRequest;
    const validation = this.validate(request);
    if (validation !== null) {
      return refused(validation);
    }
    const projectId = request.projectId.trim();
    const owner = request.repository.owner.trim();
    const repo = request.repository.repo.trim();
    const pullRequestNumber = request.pullRequestNumber;
    const expectedHeadSha = request.expectedHeadSha.trim();
    const forgeKind = request.forgeKind;
    const settingRevision = request.settingRevision.trim();
    const actionScope = mergeGrantActionScope(forgeKind);

    const requestId = this.deps.ids.newRequestId();
    const grantId = this.deps.ids.newGrantId();
    if (
      typeof requestId !== 'string' ||
      requestId.trim().length === 0 ||
      typeof grantId !== 'string' ||
      grantId.trim().length === 0
    ) {
      return refused('a minted merge grant id is already recorded');
    }
    if (
      (await this.deps.requestRepo.findRequestById(requestId)) !== null ||
      (await this.deps.requestRepo.findRequestByGrantId(grantId)) !== null
    ) {
      return refused('a minted merge grant id is already recorded');
    }
    const now = this.deps.clock.nowIso();

    const earlier = (await this.deps.requestRepo.listRequests(projectId)).filter((record) =>
      this.isLiveMergeGrant(record, actionScope, owner, repo, pullRequestNumber),
    );
    const cancelledEarlier = await this.cancelTargets(earlier, now, 'strict');
    if (cancelledEarlier.conflict) {
      return refused('an earlier merge grant moved while it was being cancelled; nothing was issued');
    }

    const grant = this.buildGrant({
      requestId,
      projectId,
      owner,
      repo,
      pullRequestNumber,
      forgeKind,
      settingRevision,
      expectedHeadSha,
      now,
      grantId,
    });
    let validated: CoordinationRequestRecord;
    try {
      validated = CoordinationRequest.fromRecord(grant).toRecord();
    } catch {
      return refused('merge grant record could not be built');
    }
    await this.deps.requestRepo.saveRequest(validated);

    // After saving the new grant, re-list the pull request's live merge grants
    // and keep only the newest (ordered by createdAtIso then id) live. When a
    // newer live grant exists, this issue's own grant is cancelled and the
    // result is superseded — a fixed outcome, never an error. A crash between
    // the save above and this sweep leaves two live grants; the next issue or
    // cancel for this pull request converges them, because the newest wins.
    const live = (await this.deps.requestRepo.listRequests(projectId)).filter((record) =>
      this.isLiveMergeGrant(record, actionScope, owner, repo, pullRequestNumber),
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
        mine !== null && this.isLiveMergeGrant(mine, actionScope, owner, repo, pullRequestNumber)
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
      decisionRevision: mergeGrantDecisionRevision(settingRevision),
      cancelledGrantIds,
    };
  }

  private validate(request: IssueMergeGrantRequest): string | null {
    if (
      typeof request.projectId !== 'string' ||
      request.projectId.trim().length === 0 ||
      request.projectId.trim().length > 256
    ) {
      return 'a merge grant requires a non-empty projectId of at most 256 characters';
    }
    if (typeof request.repository !== 'object' || request.repository === null) {
      return 'a merge grant repository must be { owner, repo }';
    }
    const owner = request.repository.owner;
    const repo = request.repository.repo;
    if (typeof owner !== 'string' || owner.trim().length === 0 || owner.trim().length > 256) {
      return 'a merge grant repository owner must be a non-empty string of at most 256 characters';
    }
    if (typeof repo !== 'string' || repo.trim().length === 0 || repo.trim().length > 256) {
      return 'a merge grant repository repo must be a non-empty string of at most 256 characters';
    }
    if (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber <= 0) {
      return 'a merge grant pullRequestNumber must be a positive safe integer';
    }
    if (
      typeof request.settingRevision !== 'string' ||
      !POLICY_SETTING_REVISION_PATTERN.test(request.settingRevision.trim())
    ) {
      return 'a merge grant settingRevision must be 12 lower-case hex characters';
    }
    if (
      typeof request.expectedHeadSha !== 'string' ||
      !POLICY_GRANT_HEAD_PATTERN.test(request.expectedHeadSha.trim())
    ) {
      return 'a merge grant expectedHeadSha must be a full lower-case commit id';
    }
    if (!MERGE_GRANT_FORGE_KINDS.includes(request.forgeKind)) {
      return 'a merge grant forgeKind must be one of merge-pr, update-branch, post-status';
    }
    return null;
  }

  private isLiveMergeGrant(
    record: CoordinationRequestRecord,
    actionScope: string,
    owner: string,
    repo: string,
    pullRequestNumber: number,
  ): boolean {
    return (
      record.state === 'approved' &&
      record.consumptions.length === 0 &&
      record.actionScope === actionScope &&
      record.mergeGrant?.repository.owner === owner &&
      record.mergeGrant.repository.repo === repo &&
      record.mergeGrant.pullRequestNumber === pullRequestNumber
    );
  }

  private buildGrant(input: {
    readonly requestId: string;
    readonly projectId: string;
    readonly owner: string;
    readonly repo: string;
    readonly pullRequestNumber: number;
    readonly forgeKind: MergeGrantForgeKind;
    readonly settingRevision: string;
    readonly expectedHeadSha: string;
    readonly now: string;
    readonly grantId: string;
  }): CoordinationRequestRecord {
    return {
      id: input.requestId,
      projectId: input.projectId,
      kind: 'action-decision',
      state: 'approved',
      actionScope: mergeGrantActionScope(input.forgeKind),
      expectedHeadSha: input.expectedHeadSha,
      proposalDigest: mergeGrantProposalDigest(
        { owner: input.owner, repo: input.repo },
        input.pullRequestNumber,
        input.expectedHeadSha,
      ),
      policyRevision: input.settingRevision,
      decisionRevision: mergeGrantDecisionRevision(input.settingRevision),
      grantId: input.grantId,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: input.now,
      updatedAtIso: input.now,
      mergeGrant: {
        repository: { owner: input.owner, repo: input.repo },
        pullRequestNumber: input.pullRequestNumber,
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
