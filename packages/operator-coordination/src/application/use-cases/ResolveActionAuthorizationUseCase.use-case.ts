/**
 * ResolveActionAuthorizationUseCase implements ResolveActionAuthorizationPort. It
 * returns an applicable grant from approved policy or from a verified scoped
 * decision, and returns a blocked reason for everything else.
 *
 * Absence of a grant is never an authorization. The recorded request must be
 * approved, carry a grant bound to a decision revision, match the exact action
 * scope and expected commit that is being attempted, and still be unconsumed.
 * When a decision transport is supplied, a request that is still awaiting its
 * decision is refreshed once from that verified answer before the checks run;
 * a pending, declined or ambiguous answer leaves the action blocked. Without a
 * grant id, only an owner request recorded at the requested head may apply; a
 * policy grant is resolved only by its id.
 */

import { isPolicyGrantRecord } from '../../domain/policy-grants.js';
import { GRANT_RECORD_VERSION } from '../../domain/coordination-records.js';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import type {
  ResolveActionAuthorizationPort,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../ports/in/ResolveActionAuthorizationPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { CoordinationRequestRevisionConflictError } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { AttemptFactsReadPort } from '../ports/out/AttemptFactsReadPort.out-port.js';
import type { DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';

export interface ResolveActionAuthorizationDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly decisionTransport?: DecisionTransportPort;
  /** CO24f: reads the attempt facts a first bind validates against; binding fails closed without it. */
  readonly attemptFactsRead?: AttemptFactsReadPort;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function blocked(reason: string): ResolveActionAuthorizationResult {
  return { outcome: 'blocked', reason };
}

export class ResolveActionAuthorizationUseCase implements ResolveActionAuthorizationPort {
  constructor(private readonly deps?: ResolveActionAuthorizationDependencies) {}

  async resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<ResolveActionAuthorizationResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ResolveActionAuthorizationUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: ResolveActionAuthorizationUseCase');
    }
    const request = input as ResolveActionAuthorizationRequest;
    if (Object.keys(request).length === 0) {
      // The HTTP boundary's empty body object: the resolve is blocked with
      // its missing coordinates named, never reported as an unimplemented
      // station.
      return blocked(
        'an authorization resolve requires a non-empty projectId, actionScope and expectedHeadSha',
      );
    }
    for (const field of ['projectId', 'actionScope', 'expectedHeadSha'] as const) {
      if (!isFilled(request[field])) {
        throw new Error('Not implemented: ResolveActionAuthorizationUseCase');
      }
    }
    const recorded = await this.findRecordedRequest(request);
    if (recorded === null) {
      return blocked(
        request.authorizationGrantId === undefined
          ? `no recorded decision authorizes ${request.actionScope} for ${request.projectId}`
          : `no recorded request holds grant ${request.authorizationGrantId}`,
      );
    }
    const refreshed = await this.refreshFromVerifiedAnswer(recorded);
    const candidate = CoordinationRequest.fromRecord(refreshed);
    if (!candidate.isApproved()) {
      return blocked(
        `recorded request ${candidate.getId()} is ${candidate.getState()}, which does not authorize an action`,
      );
    }
    const grantId = candidate.getGrantId();
    if (grantId === null) {
      return blocked(`recorded request ${candidate.getId()} carries no grant`);
    }
    if (candidate.getDecisionRevision() === null) {
      return blocked(`grant ${grantId} carries no recorded decision revision`);
    }
    if (refreshed.projectId !== request.projectId.trim()) {
      return blocked(`grant ${grantId} belongs to project ${refreshed.projectId}`);
    }
    if (!candidate.canAuthorizeAction(request.actionScope.trim(), request.expectedHeadSha.trim())) {
      return blocked(
        `grant ${grantId} authorizes ${candidate.getActionScope()} at ${
          candidate.getExpectedHeadSha() ?? 'no commit'
        }, not ${request.actionScope.trim()} at ${request.expectedHeadSha.trim()}`,
      );
    }
    const mergeGrant = candidate.getMergeGrant();
    if (mergeGrant !== null) {
      const targetRepo = this.resolveTargetRepository(request);
      const targetPr = this.resolveTargetPullRequest(request);
      if (
        targetRepo === null ||
        targetPr === null ||
        mergeGrant.repository.owner !== targetRepo.owner ||
        mergeGrant.repository.repo !== targetRepo.repo ||
        mergeGrant.pullRequestNumber !== targetPr
      ) {
        return blocked(
          `grant ${grantId} authorizes ${mergeGrant.repository.owner}/${mergeGrant.repository.repo} pull request ${mergeGrant.pullRequestNumber}`,
        );
      }
    }
    if (candidate.getConsumptions().length > 0) {
      return blocked(`grant ${grantId} is already consumed by another action`);
    }
    const attemptBlock = await this.bindAttempt(candidate, refreshed, request, grantId);
    if (attemptBlock !== null) {
      return attemptBlock;
    }
    return {
      outcome: 'authorized',
      grantId,
      requestId: candidate.getId(),
      expectedHeadSha: request.expectedHeadSha.trim(),
      policyRevision: candidate.getPolicyRevision(),
    };
  }

  /**
   * A named grant locates its request directly. Without a grant id, only an
   * owner request recorded at the requested head may apply; a policy grant is
   * resolved only by its id. Nothing is invented when nothing is recorded.
   */
  private async findRecordedRequest(
    request: ResolveActionAuthorizationRequest,
  ): Promise<CoordinationRequestRecord | null> {
    if (isFilled(request.authorizationGrantId)) {
      return this.deps?.requestRepo.findRequestByGrantId(request.authorizationGrantId.trim()) ?? null;
    }
    const recorded = await (this.deps?.requestRepo.listRequests(request.projectId.trim()) ?? []);
    const head = request.expectedHeadSha.trim();
    const matching = recorded.filter(
      (candidate) =>
        candidate.projectId === request.projectId.trim() &&
        candidate.actionScope === request.actionScope.trim() &&
        candidate.expectedHeadSha === head &&
        !isPolicyGrantRecord(candidate) &&
        this.matchesMergeGrantCoordinates(candidate, request),
    );
    const approved = matching.filter((candidate) => candidate.state === 'approved');
    const preferred =
      approved.length > 0
        ? approved
        : matching.filter((candidate) => candidate.state === 'awaiting-decision');
    return preferred.length > 0 ? preferred[preferred.length - 1] : null;
  }

  /**
   * CO24e: a grant is bound to one attempt. A resolve that names an attempt must name the
   * grant's recorded one; an owner grant that records none is bound to the first attempt
   * that resolves it, durably, so a later consumption by another attempt at the same head
   * is refused. A version-2 record without an attempt, and an unusable attempt id, block.
   * A merge grant is attempt-less by design (DT6b) and is never bound.
   */
  private async bindAttempt(
    candidate: CoordinationRequest,
    record: CoordinationRequestRecord,
    request: ResolveActionAuthorizationRequest,
    grantId: string,
  ): Promise<ResolveActionAuthorizationResult | null> {
    if (candidate.isMissingRecordedAttempt()) {
      return blocked('grant-attempt-unrecorded');
    }
    if (request.attemptId === undefined) {
      return null;
    }
    if (!isFilled(request.attemptId)) {
      return blocked('grant-attempt-invalid');
    }
    const supplied = request.attemptId.trim();
    const bound = candidate.getBoundAttemptId();
    if (bound !== null) {
      return bound === supplied ? null : blocked('grant-attempt-mismatch');
    }
    if (candidate.getMergeGrant() !== null) {
      return null;
    }
    // CO24f: an unbound owner grant binds only an attempt that exists, belongs
    // to the grant's project and was collected at the requested head, read
    // through the attempt-facts port. Anything else refuses without binding,
    // so a wrong attempt can never attach to — or kill — the grant.
    const facts = await (this.deps?.attemptFactsRead?.findAttemptFactsById(supplied) ?? null);
    if (facts === null) {
      return blocked('grant-attempt-unknown');
    }
    if (facts.projectId === null || facts.projectId !== record.projectId) {
      return blocked('grant-attempt-foreign');
    }
    if (facts.collectedHeadSha === null) {
      return blocked('grant-attempt-uncollected');
    }
    if (facts.collectedHeadSha !== request.expectedHeadSha.trim()) {
      return blocked('grant-attempt-head-mismatch');
    }
    let binding: CoordinationRequestRecord;
    try {
      binding = CoordinationRequest.fromRecord({
        ...record,
        grantRecordVersion: GRANT_RECORD_VERSION,
        grantAttemptId: supplied,
        revision: candidate.nextRevision(),
        updatedAtIso: new Date().toISOString(),
      }).toRecord();
    } catch {
      return blocked('grant-attempt-invalid');
    }
    try {
      await (this.deps?.requestRepo.saveRequest(binding) ?? Promise.resolve());
    } catch (error: unknown) {
      if (error instanceof CoordinationRequestRevisionConflictError) {
        return blocked(`grant ${grantId} moved while it was being bound to an attempt`);
      }
      throw error;
    }
    return null;
  }

  /** A pending request may have an answer recorded since it was last read. */
  private async refreshFromVerifiedAnswer(
    record: CoordinationRequestRecord,
  ): Promise<CoordinationRequestRecord> {
    const decisionTransport = this.deps?.decisionTransport;
    if (decisionTransport === undefined || record.state !== 'awaiting-decision') {
      return record;
    }
    const answer = await decisionTransport.readDecisionAnswer({
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
    });
    if (answer.state === 'awaiting-decision' || answer.state === 'declined') {
      return record;
    }
    if (answer.state === 'approved' && answer.grantId === null) {
      // An approval without a recorded grant authorizes nothing.
      return record;
    }
    const refreshed: CoordinationRequestRecord = {
      ...record,
      state: answer.state,
      decisionRevision: answer.decisionRevision,
      grantId: answer.grantId,
      revision: record.revision + 1,
      updatedAtIso: new Date().toISOString(),
    };
    await (this.deps?.requestRepo.saveRequest(refreshed) ?? Promise.resolve());
    return refreshed;
  }

  private resolveTargetRepository(
    request: ResolveActionAuthorizationRequest,
  ): { owner: string; repo: string } | null {
    if (typeof request.repository === 'object' && request.repository !== null) {
      const { owner, repo } = request.repository as { owner?: unknown; repo?: unknown };
      if (typeof owner === 'string' && typeof repo === 'string' && owner.trim() && repo.trim()) {
        return { owner: owner.trim(), repo: repo.trim() };
      }
    } else if (typeof request.repository === 'string') {
      const parts = request.repository.trim().split('/');
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return { owner: parts[0].trim(), repo: parts[1].trim() };
      }
    }
    return null;
  }

  private resolveTargetPullRequest(request: ResolveActionAuthorizationRequest): number | null {
    const pr = request.pullRequestNumber;
    return typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0 ? pr : null;
  }

  private matchesMergeGrantCoordinates(
    record: CoordinationRequestRecord,
    request: ResolveActionAuthorizationRequest,
  ): boolean {
    if (record.mergeGrant === undefined) {
      return true;
    }
    const targetRepo = this.resolveTargetRepository(request);
    const targetPr = this.resolveTargetPullRequest(request);
    if (targetRepo === null || targetPr === null) {
      return false;
    }
    return (
      record.mergeGrant.repository.owner === targetRepo.owner &&
      record.mergeGrant.repository.repo === targetRepo.repo &&
      record.mergeGrant.pullRequestNumber === targetPr
    );
  }
}
