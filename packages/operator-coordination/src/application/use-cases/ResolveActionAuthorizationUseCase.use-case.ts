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
import {
  GRANT_RECORD_VERSION,
  isReleaseActionScope,
  readReleaseRoot,
  readReleaseNonce,
  releaseRootsAgree,
  isShadowImportActionScope,
  isSignedDecisionRequired,
  releaseGrantDigestPayload,
  RELEASE_GRANT_DIGEST_PREFIX,
  SHADOW_IMPORT_ACTION_SCOPE,
  SHADOW_IMPORT_DIGEST_PREFIX,
  shadowImportDigestPayload,
  verifySignedDecisionBinding,
} from '../../domain/coordination-records.js';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { readPlainObjectLoose } from '../../domain/record-input.js';
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
  /**
   * The SHA-256 digest a shadow import grant's request id is bound by.
   * Injected, so the application layer stays free of `node:crypto`; a shadow
   * resolve without it fails closed, never silently skips the digest check.
   */
  readonly computeDigest?: (payload: string) => string;
  /**
   * The trusted clock the shadow import grant's expiry is measured against.
   * Injected by the composition root, never taken from the resolve request:
   * a caller-supplied `nowIso` could backdate the clock past expiry. Ordinary
   * (non-shadow) resolves keep exactly their main behaviour and never
   * consult this clock or the digest.
   */
  readonly shadowImportClock?: { readonly nowIso: () => string };
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function blocked(reason: string): ResolveActionAuthorizationResult {
  return { outcome: 'blocked', reason };
}

/**
 * A descriptor-safe snapshot of the request's nested `repository`. A nested
 * plain object is copied with own data descriptors only (no getter ever runs,
 * so an accessor on `repository.owner` or `repository.repo` collapses to
 * `undefined` and is refused later as an invalid repository); anything the
 * reader cannot snapshot descriptor-safely becomes `null`, which
 * `resolveTargetRepository` refuses. A string `owner/repo` coordinate is not
 * an object and passes through for the later validation.
 */
function snapshotRepository(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  try {
    return readPlainObjectLoose(value);
  } catch {
    return null;
  }
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
    // Standing shadow import grant (owner decision 2026-11-18): the resolve
    // is head-free — the grant is bound by its digest-bound request id, its
    // exact repository and its capped expiry, never by a commit. Its clock is
    // the composition root's alone: any `nowIso` on the request is ignored,
    // and an unwired clock or digest fails closed. Every non-shadow path
    // below keeps exactly its main behaviour.
    // The shadow path reads the request through a descriptor-safe snapshot
    // (no getter ever runs, a hostile accessor or proxy is a typed refusal),
    // so a hostile object can never throw out of the shadow branch.
    // The snapshot is taken FIRST, before any field — including `actionScope` —
    // is read, so no getter on any field (not even the one that routes the
    // request) can run before the request is frozen. A throwing trap during
    // the snapshot is a hostile proxy: a typed refusal, never an exception.
    let snapshot: Record<string, unknown> | null = null;
    try {
      snapshot = readPlainObjectLoose(input);
    } catch {
      return blocked('invalid-request');
    }
    // An accessor field snapshots to `undefined` (its value is never read), but
    // its presence is still visible through its own property descriptor, and
    // inspecting a descriptor never runs a getter. A getter-carrying
    // `actionScope` therefore cannot be resolved head-free at all: it is a
    // typed refusal with a getter-call count of 0. A plain-data `actionScope`
    // — every ordinary request — reads exactly as before from the snapshot.
    const actionScopeDescriptor = Object.getOwnPropertyDescriptor(input, 'actionScope');
    if (actionScopeDescriptor !== undefined && actionScopeDescriptor.get !== undefined) {
      return blocked('invalid-request');
    }
    const scope =
      snapshot !== null && typeof snapshot['actionScope'] === 'string'
        ? (snapshot['actionScope'] as string).trim()
        : '';
    if (isShadowImportActionScope(scope)) {
      if (snapshot === null) {
        return blocked('invalid-request');
      }
      // The nested `repository` is snapshotted with own data descriptors too,
      // so a getter on `repository.owner` or `repository.repo` never runs
      // later in `resolveTargetRepository`: the resolve reads only from the
      // snapshots, never from the original request or its nested object.
      const shadowRequest = {
        ...snapshot,
        repository: snapshotRepository(snapshot['repository']),
      };
      return this.resolveShadowImport(shadowRequest as unknown as ResolveActionAuthorizationRequest);
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
    // CO14 follow-up: read the stored release root descriptor-safely before
    // anything evaluates the record, so a hostile accessor is a typed refusal.
    if (readReleaseRoot(recorded).state === 'invalid') {
      return blocked('release-grant-root-mismatch');
    }
    const refreshedResult = await this.refreshFromVerifiedAnswer(recorded);
    if (refreshedResult.refusalReason !== undefined) {
      // A pinned owner-key refusal blocks before any grant state is checked.
      return blocked(refreshedResult.refusalReason);
    }
    const refreshed = refreshedResult.record;
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
    const recordedRoot = readReleaseRoot(refreshed);
    const requestedRoot = readReleaseRoot(request);
    if (!releaseRootsAgree(recordedRoot, requestedRoot)) {
      return blocked('release-grant-root-mismatch');
    }
    // RR1: a release grant's root is bound into its request id. A record
    // whose id does not carry the prefix carries an unsigned (pre-RR1) root
    // and fails closed; a prefixed record is re-verified against the digest
    // of its recorded coordinates, so a tampered root can never masquerade
    // behind a valid-looking id.
    if (isReleaseActionScope(candidate.getActionScope())) {
      if (
        recordedRoot.state !== 'valid' ||
        !candidate.getId().startsWith(RELEASE_GRANT_DIGEST_PREFIX)
      ) {
        return blocked('release-grant-digest-mismatch');
      }
      if (this.deps?.computeDigest === undefined) {
        return blocked('digest-unavailable');
      }
      const payloadResult = releaseGrantDigestPayload({
        actionScope: candidate.getActionScope(),
        projectId: refreshed.projectId,
        expectedHeadSha: refreshed.expectedHeadSha ?? '',
        releaseRoot: recordedRoot.value,
        nonce: readReleaseNonce(refreshed),
      });
      const expectedRequestId = payloadResult.ok
        ? `${RELEASE_GRANT_DIGEST_PREFIX}${this.deps.computeDigest(payloadResult.value)}`
        : null;
      if (!payloadResult.ok || candidate.getId() !== expectedRequestId) {
        return blocked('release-grant-digest-mismatch');
      }
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
    // KEY0c2: every owner-gated approval is re-bound to a verified signed
    // answer when a decision transport is injected, before anything is
    // authorized. The check runs after every stored-coordinate refusal, so
    // origin/main's exact refusal reasons are preserved.
    const signatureBlock = await this.verifyOwnerDecisionForRecord(candidate, refreshed, resumable);
    if (signatureBlock !== null) {
      return signatureBlock;
    }
    return {
      outcome: 'authorized',
      grantId,
      requestId: candidate.getId(),
      expectedHeadSha: request.expectedHeadSha.trim(),
      policyRevision: candidate.getPolicyRevision(),
      ...(recordedRoot.state === 'valid' ? { releaseRoot: recordedRoot.value } : {}),
    };
  }

  /**
   * KEY0c2: when a decision transport is injected, an owner-gated approval —
   * a stored `approved` record (or a resumable `completed` release record) whose
   * scope is not a closed-kind policy or merge grant — is re-read through the
   * transport and bound to the signed answer. Anything the transport reports
   * as awaiting or declined, an owner-key refusal, or a mismatching binding
   * blocks; when no transport is injected the origin/main behaviour is kept
   * exactly. Returns the block, or null when the record may authorize.
   */
  private async verifyOwnerDecisionForRecord(
    candidate: CoordinationRequest,
    refreshed: CoordinationRequestRecord,
    resumable: boolean,
  ): Promise<ResolveActionAuthorizationResult | null> {
    const decisionTransport = this.deps?.decisionTransport;
    if (decisionTransport === undefined) {
      return null;
    }
    if (refreshed.state !== 'approved' && !(refreshed.state === 'completed' && resumable)) {
      return null;
    }
    if (!isSignedDecisionRequired(candidate.toRecord())) {
      return null;
    }
    const answer = await decisionTransport.readDecisionAnswer({
      requestId: refreshed.id,
      projectId: refreshed.projectId,
      actionScope: refreshed.actionScope,
      expectedHeadSha: refreshed.expectedHeadSha,
    });
    if (answer.state === 'awaiting-decision' && answer.refusalReason !== undefined) {
      return blocked(answer.refusalReason);
    }
    if (!verifySignedDecisionBinding(refreshed, answer).ok) {
      return blocked('decision-signature-invalid');
    }
    return null;
  }

  /**
   * The explicit head-free resolve path for a standing `merge:import-shadow`
   * grant. The grant is re-checked against its stored coordinates on every
   * resolve: the request-id digest is recomputed from
   * `candidate.getShadowImportGrant()` with the injected digest (a mismatch
   * means the stored coordinates no longer match the id the grant was bound
   * by), and the expiry is measured with the injected clock alone — never a
   * request field, so a caller cannot backdate the clock past expiry. An
   * unwired clock or digest fails closed. Nothing is bound and no
   * consumption is checked: a standing grant resolves until it expires or is
   * revoked.
   */
  private async resolveShadowImport(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    if (!isFilled(request.projectId)) {
      return blocked('project-id-required');
    }
    if (!isFilled(request.authorizationGrantId)) {
      return blocked('grant-missing');
    }
    const grantId = request.authorizationGrantId.trim();
    const requestedRepository = this.resolveTargetRepository(request);
    if (requestedRepository === null) {
      return blocked('grant-wrong-repository');
    }
    if (this.deps?.shadowImportClock === undefined) {
      return blocked('clock-unavailable');
    }
    const nowIso = this.deps.shadowImportClock.nowIso();
    if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
      return blocked('invalid-now-iso');
    }
    if (this.deps.computeDigest === undefined) {
      return blocked('digest-unavailable');
    }
    const recorded = await this.deps.requestRepo.findRequestByGrantId(grantId);
    if (recorded === null) {
      return blocked('grant-missing');
    }
    const refreshedResult = await this.refreshFromVerifiedAnswer(recorded);
    if (refreshedResult.refusalReason !== undefined) {
      // A pinned owner-key refusal blocks before any grant state is checked.
      return blocked(refreshedResult.refusalReason);
    }
    const refreshed = refreshedResult.record;
    if (refreshed.state === 'cancelled') {
      return blocked('grant-revoked');
    }
    if (refreshed.state !== 'approved' || refreshed.decisionRevision === null) {
      return blocked('grant-not-approved');
    }
    let candidate: CoordinationRequest;
    try {
      candidate = CoordinationRequest.fromRecord(refreshed);
    } catch {
      return blocked('grant-wrong-scope');
    }
    if (
      candidate.getActionScope() !== SHADOW_IMPORT_ACTION_SCOPE ||
      !candidate.canAuthorizeShadowImport(SHADOW_IMPORT_ACTION_SCOPE)
    ) {
      return blocked('grant-wrong-scope');
    }
    const shadowGrant = candidate.getShadowImportGrant();
    if (shadowGrant === null) {
      return blocked('grant-wrong-scope');
    }
    const payloadResult = shadowImportDigestPayload(shadowGrant);
    const expectedRequestId = payloadResult.ok
      ? `${SHADOW_IMPORT_DIGEST_PREFIX}${this.deps.computeDigest(payloadResult.value)}`
      : null;
    if (!payloadResult.ok || candidate.getId() !== expectedRequestId) {
      return blocked('grant-digest-mismatch');
    }
    if (refreshed.projectId !== request.projectId.trim()) {
      return blocked('grant-wrong-project');
    }
    if (
      shadowGrant.repository.owner !== requestedRepository.owner ||
      shadowGrant.repository.repo !== requestedRepository.repo
    ) {
      return blocked('grant-wrong-repository');
    }
    // The expiry is measured with the trusted clock alone: a request-supplied
    // `nowIso` can never revive an expired grant.
    if (Date.parse(nowIso) >= Date.parse(shadowGrant.expiresAtIso)) {
      return blocked('grant-expired');
    }
    // KEY0c2: a standing shadow import grant is also re-bound to a verified
    // signed answer when a decision transport is injected.
    const signatureBlock = await this.verifyOwnerDecisionForRecord(candidate, refreshed, false);
    if (signatureBlock !== null) {
      return signatureBlock;
    }
    return {
      outcome: 'authorized',
      grantId,
      requestId: candidate.getId(),
      expectedHeadSha: '',
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

  /**
   * A pending request may have an answer recorded since it was last read.
   * Returns the (possibly refreshed) record plus the answer's named
   * owner-key refusal, if any: the caller blocks on it before any grant
   * state is consulted.
   */
  private async refreshFromVerifiedAnswer(
    record: CoordinationRequestRecord,
  ): Promise<{ readonly record: CoordinationRequestRecord; readonly refusalReason?: string }> {
    const decisionTransport = this.deps?.decisionTransport;
    if (decisionTransport === undefined || record.state !== 'awaiting-decision') {
      return { record };
    }
    const answer = await decisionTransport.readDecisionAnswer({
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
    });
    if (answer.state === 'awaiting-decision') {
      return {
        record,
        ...(answer.refusalReason !== undefined ? { refusalReason: answer.refusalReason } : {}),
      };
    }
    if (answer.state === 'declined') {
      return { record };
    }
    if (answer.state === 'approved' && answer.grantId === null) {
      // An approval without a recorded grant authorizes nothing.
      return { record };
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
    return { record: refreshed };
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
