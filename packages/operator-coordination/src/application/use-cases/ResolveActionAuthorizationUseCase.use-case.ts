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
import { GRANT_RECORD_VERSION, isReleaseActionScope, isReleaseRootCoordinate } from '../../domain/coordination-records.js';
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
    // CO14 follow-up: a release grant already durably consumed by exactly the
    // deterministic action id this resolve names resolves again idempotently,
    // so a crash between the consumption and the release's own write leaves
    // the retry able to recover. Any other consumed grant stays blocked, and
    // a completed record that does not resume is refused like any other
    // non-approving state.
    const resumeActionId = isFilled(request.resumeActionId) ? request.resumeActionId.trim() : undefined;
    const consumptions = candidate.getConsumptions();
    const resumable =
      resumeActionId !== undefined &&
      isReleaseActionScope(candidate.getActionScope()) &&
      consumptions.length === 1 &&
      consumptions[0].actionId === resumeActionId;
    if (!candidate.isApproved() && !resumable) {
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
    if (
      !resumable &&
      !candidate.canAuthorizeAction(request.actionScope.trim(), request.expectedHeadSha.trim())
    ) {
      return blocked(
        `grant ${grantId} authorizes ${candidate.getActionScope()} at ${
          candidate.getExpectedHeadSha() ?? 'no commit'
        }, not ${request.actionScope.trim()} at ${request.expectedHeadSha.trim()}`,
      );
    }
    if (
      resumable &&
      (candidate.getActionScope() !== request.actionScope.trim() ||
        candidate.getExpectedHeadSha() !== request.expectedHeadSha.trim())
    ) {
      // A resumed release grant still authorizes only its recorded scope at
      // its recorded head; the resume never widens either.
      return blocked(
        `grant ${grantId} authorizes ${candidate.getActionScope()} at ${
          candidate.getExpectedHeadSha() ?? 'no commit'
        }, not ${request.actionScope.trim()} at ${request.expectedHeadSha.trim()}`,
      );
    }
    // CO14 follow-up: a release grant bound to one root authorizes only an
    // operation on that root. An invalid coordinate on either side fails
    // closed as a mismatch, never as a match.
    const recordedRoot = isReleaseRootCoordinate(refreshed.releaseRoot) ? refreshed.releaseRoot : undefined;
    const requestedRoot = isReleaseRootCoordinate(request.releaseRoot) ? request.releaseRoot : undefined;
    if (recordedRoot !== requestedRoot) {
      return blocked('release-grant-root-mismatch');
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
    if (candidate.getConsumptions().length > 0 && !resumable) {
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
      ...(recordedRoot !== undefined ? { releaseRoot: recordedRoot } : {}),
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
    const resumeActionId = isFilled(request.resumeActionId) ? request.resumeActionId.trim() : undefined;
    const matching = recorded.filter(
      (candidate) =>
        candidate.projectId === request.projectId.trim() &&
        candidate.actionScope === request.actionScope.trim() &&
        candidate.expectedHeadSha === head &&
        !isPolicyGrantRecord(candidate) &&
        this.matchesMergeGrantCoordinates(candidate, request),
    );
    const approved = matching.filter((candidate) => candidate.state === 'approved');
    if (approved.length > 0) {
      return approved[approved.length - 1];
    }
    if (resumeActionId !== undefined) {
      // CO14 follow-up: a release grant consumed by exactly the resuming
      // action id is still the grant that authorizes this resolve, so the
      // retry after a crash between consumption and write finds it again.
      const resumable = matching.filter(
        (candidate) =>
          candidate.state === 'completed' &&
          candidate.consumptions.length === 1 &&
          candidate.consumptions[0].actionId === resumeActionId,
      );
      if (resumable.length > 0) {
        return resumable[resumable.length - 1];
      }
    }
    const awaiting = matching.filter((candidate) => candidate.state === 'awaiting-decision');
    return awaiting.length > 0 ? awaiting[awaiting.length - 1] : null;
  }

  /**
   * CO24e: a grant is bound to one attempt. A resolve that names an attempt must name the
   * grant's recorded one; an owner grant that records none is bound to the first attempt
   * that resolves it, durably, so a later consumption by another attempt at the same head
   * is refused. A version-2 record without an attempt, and an unusable attempt id, block.
   * A merge grant is attempt-less by design (DT6b) and is never bound.
   *
   * CO24g: a resolve that names no attempt cannot authorize an owner grant. An unbound one
   * refuses (`attempt-required`) without binding or consuming, and an already-bound one also
   * refuses, because every caller that resolves a bound owner grant passes its attempt and no
   * anonymous path is needed. Policy grants keep their own recorded attempt and are resolved
   * only by their id, so they stay unaffected. Two grant kinds are attempt-less by design and
   * are exempt by kind, never by a missing attemptId: a merge grant (DT6b), anchored by
   * repository, pull request and head, and a release grant (CO14), anchored by its
   * `release:<action>` scope, exact head and one deterministic consumption.
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
    // DT6b: a merge grant is anchored by repository, pull request and head, never by an
    // attempt; it resolves unbound and is never bound.
    if (candidate.getMergeGrant() !== null) {
      return null;
    }
    // CO24g: an unbound release grant is attempt-less by design (cutover row CO14). It is
    // anchored by its exact `release:<action>` scope (only `release:install`,
    // `release:swap` or `release:rollback`) and exact head, and consumed once
    // by its deterministic action id, so it resolves with or without an attempt
    // coordinate and is never bound to a work attempt. A bound release grant is held
    // to its attempt and falls through to the normal checks. The gate is the grant's
    // recorded scope — the grant kind — never the absence of an attemptId, and
    // never an arbitrary `release:*` prefix.
    if (isReleaseActionScope(candidate.getActionScope()) && candidate.getBoundAttemptId() === null) {
      return null;
    }
    if (request.attemptId === undefined) {
      // A policy grant carries its own recorded attempt and resolves only by its id, so it
      // is unaffected by the attempt-required default. Every other grant — an owner grant,
      // bound or not — refuses without the attempt coordinate.
      if (candidate.getPolicyGrant() !== null) {
        return null;
      }
      return blocked('attempt-required');
    }
    if (!isFilled(request.attemptId)) {
      return blocked('grant-attempt-invalid');
    }
    const supplied = request.attemptId.trim();
    const bound = candidate.getBoundAttemptId();
    if (bound !== null) {
      return bound === supplied ? null : blocked('grant-attempt-mismatch');
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
