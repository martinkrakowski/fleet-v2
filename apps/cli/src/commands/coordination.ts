/** The `coordination` command group of the CLI driver; its entries moved verbatim from the command table. */

import { createHash } from 'node:crypto';

import {
  COORDINATION_KINDS,
  SHADOW_IMPORT_ACTION_SCOPE,
  SHADOW_IMPORT_DIGEST_PREFIX,
  shadowImportDigestPayload,
} from '@fleet/operator-coordination';
import { forgeActionScope } from '@fleet/work-execution';
import type { AttentionItemState, RequestScopedDecisionResult } from '@fleet/operator-coordination';
import {
  str,
  optStr,
  strOrNull,
  num,
  strArr,
  nested,
  enumOf,
  CliUsageError,
} from './payload.js';
import type { CommandHandler, Payload } from './payload.js';
import type { FleetCliRuntime } from '../composition.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** The SHA-256 hex digest a shadow import grant's request id is bound by. */
function sha256HexDigest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export const coordinationCommands: Readonly<Record<string, CommandHandler>> = {
    'register-profile': async (p, rt) =>
      rt.coordination.registerProjectProfile.registerProjectProfile({
        projectId: str(p, 'projectId'),
        displayName: str(p, 'displayName'),
        repository: str(p, 'repository'),
        designatedDispatcherHost: str(p, 'designatedDispatcherHost'),
        policyRevision: str(p, 'policyRevision'),
        maxConcurrentLanes: num(p, 'maxConcurrentLanes', 1),
        runnerCapabilities: nested<Record<string, boolean | string>>(p, 'runnerCapabilities') ?? {},
        nowIso: optStr(p, 'nowIso'),
      }),
    capabilities: async (p, rt) =>
      rt.coordination.inspectConfiguredCapabilities.inspectConfiguredCapabilities({
        projectId: str(p, 'projectId'),
        requiredCapabilities: strArr(p, 'requiredCapabilities'),
      }),
    'request-decision': async (p, rt) => {
      const actionScope = str(p, 'actionScope');
      if (actionScope === SHADOW_IMPORT_ACTION_SCOPE) {
        return shadowImportRequestDecision(p, rt);
      }
      return rt.coordination.requestScopedDecision.requestScopedDecision({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: strOrNull(p, 'expectedHeadSha'),
        proposalDigest: str(p, 'proposalDigest'),
        policyRevision: str(p, 'policyRevision'),
        ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'resolve-auth': async (p, rt) =>
      rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: str(p, 'projectId'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        authorizationGrantId: optStr(p, 'authorizationGrantId'),
        ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
      }),
    'consume-auth': async (p, rt) =>
      rt.coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: str(p, 'consumptionId'),
        grantId: str(p, 'grantId'),
        actionId: str(p, 'actionId'),
        actionScope: str(p, 'actionScope') || (str(p, 'actionKind') ? forgeActionScope(str(p, 'actionKind')) : ''),
        attemptId: str(p, 'attemptId'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'publish-observation': async (p, rt) =>
      rt.coordination.publishProjectObservation.publishProjectObservation({
        observationId: str(p, 'observationId'),
        projectId: str(p, 'projectId'),
        eventKind: str(p, 'eventKind'),
        sourceAttemptId: strOrNull(p, 'sourceAttemptId'),
        payloadSummary: str(p, 'payloadSummary'),
        nowIso: optStr(p, 'nowIso'),
      }),
    attention: async (p, rt) =>
      rt.coordination.readProjectAttention.readProjectAttention({
        projectId: str(p, 'projectId'),
      }),
    'attention-items': async (p, rt) =>
      // A supplied filter is passed through as given, even empty, so the use case can refuse it (an empty list);
      // only an absent flag means "no filter".
      rt.coordination.listAttentionItems.listAttentionItems({
        ...(Object.hasOwn(p, 'projectId') ? { projectId: str(p, 'projectId') } : {}),
        ...(Object.hasOwn(p, 'state') ? { state: str(p, 'state') as AttentionItemState } : {}),
        ...(Object.hasOwn(p, 'kind') ? { kind: str(p, 'kind') } : {}),
        ...(Object.hasOwn(p, 'workOrderId') ? { workOrderId: str(p, 'workOrderId') } : {}),
      }),
    'attention-dismiss': async (p, rt) => {
      const revisionRaw = optStr(p, 'expectedRevision');
      const revision = revisionRaw !== undefined && /^\d{1,15}$/.test(revisionRaw) ? Number(revisionRaw) : NaN;
      if (!Number.isSafeInteger(revision)) {
        throw new CliUsageError(
          "attention-dismiss requires '--expectedRevision <n>' with an integer value",
        );
      }
      return rt.coordination.clearAttentionItem.clearAttentionItem(
        {
          action: 'dismiss',
          itemId: str(p, 'itemId'),
          expectedRevision: revision,
        },
        'cli',
        'cli',
      );
    },
    'send-relay': async (p, rt) =>
      rt.coordination.sendFleetRelay.sendFleetRelay({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        recipientId: str(p, 'recipientId'),
        summary: str(p, 'summary'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'ack-relay': async (p, rt) =>
      rt.coordination.recordRelayAcknowledgement.recordRelayAcknowledgement({
        acknowledgementId: str(p, 'acknowledgementId'),
        requestId: str(p, 'requestId'),
        recipientId: str(p, 'recipientId'),
        responseSummary: str(p, 'responseSummary'),
        provenance: str(p, 'provenance'),
        nowIso: optStr(p, 'nowIso'),
      }),
    outstanding: async (p, rt) =>
      rt.coordination.inspectOutstandingCoordination.inspectOutstandingCoordination({
        projectId: optStr(p, 'projectId'),
      }),
    'revoke-grant': async (p, rt) =>
      rt.coordination.requestScopedDecision.revokeOwnerGrant({
        grantId: optStr(p, 'grantId') ?? str(p, 'grant-id'),
      }),
};

/**
 * The standing shadow import grant's request-decision entry. The request id
 * is the digest of the grant's exact coordinates ({ scope, owner, repo,
 * expiresAtIso }), so the CLI derives it from `--repository` and
 * `--expires-at-iso` instead of taking it from the owner's hand: a hand-typed
 * id that does not match the derived one is refused, never silently recorded
 * under a digest it does not carry.
 */
function shadowImportRequestDecision(
  p: Payload,
  rt: FleetCliRuntime,
): Promise<RequestScopedDecisionResult> {
  const repositoryRaw = str(p, 'repository').trim();
  const expiresAtIso = optStr(p, 'expiresAtIso');
  const segments = repositoryRaw.split('/');
  if (
    repositoryRaw === '' ||
    segments.length !== 2 ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[0]!) ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[1]!)
  ) {
    throw new CliUsageError(
      'request-decision: --repository must be owner/repo for merge:import-shadow',
    );
  }
  if (expiresAtIso === undefined) {
    throw new CliUsageError(
      'request-decision: --expires-at-iso is required for merge:import-shadow',
    );
  }
  const shadowImportGrant = { repository: { owner: segments[0]!, repo: segments[1]! }, expiresAtIso };
  const payload = shadowImportDigestPayload(shadowImportGrant);
  if (!payload.ok) {
    throw new CliUsageError('request-decision: invalid shadow import grant coordinates');
  }
  const requestId = `${SHADOW_IMPORT_DIGEST_PREFIX}${sha256HexDigest(payload.value)}`;
  const supplied = optStr(p, 'requestId');
  if (supplied !== undefined && supplied !== requestId) {
    // The id is a non-secret digest handle, so refusing without echoing the
    // supplied value keeps no secret and still tells the owner what to do.
    throw new CliUsageError(
      "request-decision: the hand-typed '--requestId' does not match the id derived from the grant's coordinates",
    );
  }
  return rt.coordination.requestScopedDecision.requestScopedDecision({
    requestId,
    projectId: str(p, 'projectId'),
    kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
    actionScope: SHADOW_IMPORT_ACTION_SCOPE,
    expectedHeadSha: null,
    proposalDigest: str(p, 'proposalDigest'),
    policyRevision: str(p, 'policyRevision'),
    ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
    shadowImportGrant,
  });
}
