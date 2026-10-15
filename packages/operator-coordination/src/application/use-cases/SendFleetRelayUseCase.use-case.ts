/**
 * SendFleetRelayUseCase implements SendFleetRelayPort. It records an attributed
 * notice and delivers it through the transport port, keeping delivery distinct
 * from recipient acknowledgement.
 *
 * A transport receipt proves delivery only. Delivery never records an
 * acknowledgement: only an actual recipient response, with its provenance, can
 * close a relay. A failed delivery is recorded as a delivery gap with its reason
 * so the notice stays visible and outstanding, and a gapped notice may be sent
 * again while it remains unanswered.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import type {
  SendFleetRelayPort,
  SendFleetRelayRequest,
  SendFleetRelayResult,
} from '../ports/in/SendFleetRelayPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { RelayTransportPort } from '../ports/out/RelayTransportPort.out-port.js';

export interface SendFleetRelayDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly relayTransport: RelayTransportPort;
}

const REQUIRED_TEXT_FIELDS = ['requestId', 'projectId', 'recipientId', 'summary', 'policyRevision'] as const;

function rejected(reason: string): SendFleetRelayResult {
  return { outcome: 'rejected', reason };
}

export class SendFleetRelayUseCase implements SendFleetRelayPort {
  constructor(private readonly deps?: SendFleetRelayDependencies) {}

  async sendFleetRelay(request: SendFleetRelayRequest): Promise<SendFleetRelayResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<SendFleetRelayResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: SendFleetRelayUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is rejected by the field validation below.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: SendFleetRelayUseCase');
    }
    const request = input as SendFleetRelayRequest;
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof request[field] !== 'string' || request[field].trim().length === 0) {
        return rejected(`a fleet relay requires a non-empty ${field}`);
      }
    }
    const requestId = request.requestId.trim();
    const recipientId = request.recipientId.trim();
    const existing = await this.deps.requestRepo.findRequestById(requestId);
    if (existing !== null && existing.kind !== 'relay') {
      return rejected(`recorded request ${requestId} is not a relay notice`);
    }
    if (existing !== null && existing.acknowledgements.length > 0) {
      return rejected(`relay ${requestId} was already answered by a recipient response`);
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso =
      typeof request.nowIso === 'string' && request.nowIso.trim().length > 0
        ? request.nowIso
        : new Date().toISOString();
    const receipt = await this.deps.relayTransport.deliverRelayNotice({
      requestId,
      projectId: request.projectId.trim(),
      recipientId,
      summary: request.summary.trim(),
    });
    const delivered: CoordinationRequestRecord = CoordinationRequest.fromRecord({
      id: requestId,
      projectId: request.projectId.trim(),
      kind: 'relay',
      state: 'executing',
      actionScope: `relay:${recipientId}`,
      expectedHeadSha: null,
      // A relay carries no proposal content; its digest names the addressed
      // recipient. Content hashing belongs to infrastructure, not here.
      proposalDigest: `relay:${recipientId}`,
      policyRevision: request.policyRevision.trim(),
      decisionRevision: null,
      grantId: null,
      // Delivery is transport evidence only; it never records a response, so an
      // unanswered notice carries no acknowledgement on a re-send either.
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: receipt.outcome === 'delivered' ? 'delivered' : 'delivery-gap',
      deliveryGapReason: receipt.outcome === 'delivered' ? null : receipt.reason,
      revision: existing === null ? 0 : existing.revision + 1,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    }).toRecord();
    await this.deps.requestRepo.saveRequest(delivered);
    if (receipt.outcome === 'delivery-gap') {
      return { outcome: 'delivery-gap', request: delivered, reason: receipt.reason };
    }
    return { outcome: 'delivered', request: delivered };
  }
}
