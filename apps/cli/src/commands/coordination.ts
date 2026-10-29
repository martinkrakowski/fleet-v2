/** The `coordination` command group of the CLI driver; its entries moved verbatim from the command table. */

import { COORDINATION_KINDS } from '@fleet/operator-coordination';
import { forgeActionScope } from '@fleet/work-execution';
import type { AttentionItemState } from '@fleet/operator-coordination';
import { str, optStr, strOrNull, num, strArr, nested, enumOf, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

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
    'request-decision': async (p, rt) =>
      rt.coordination.requestScopedDecision.requestScopedDecision({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: strOrNull(p, 'expectedHeadSha'),
        proposalDigest: str(p, 'proposalDigest'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'resolve-auth': async (p, rt) =>
      rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: str(p, 'projectId'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        authorizationGrantId: optStr(p, 'authorizationGrantId'),
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
};
