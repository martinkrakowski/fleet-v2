/**
 * RecordAuthorizationConsumptionUseCase implements RecordAuthorizationConsumptionPort.
 * It durably binds one grant to one action id and attempt and retains the
 * reconciliation receipt on the request it belongs to.
 *
 * A grant authorizes exactly one action, exactly once. A grant that was not
 * recorded, is not approved, no longer matches its expected commit, or was
 * already consumed is refused rather than recorded again, and this port never
 * turns a consumed grant into authority for a second, unrelated action.
 */

import type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
} from '../../domain/coordination-records.js';
import { AuthorizationConsumption } from '../../domain/entities/AuthorizationConsumption.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import type {
  RecordAuthorizationConsumptionPort,
  RecordAuthorizationConsumptionRequest,
  RecordAuthorizationConsumptionResult,
} from '../ports/in/RecordAuthorizationConsumptionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';

export interface RecordAuthorizationConsumptionDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
}

const REQUIRED_TEXT_FIELDS = [
  'consumptionId',
  'grantId',
  'actionId',
  'attemptId',
  'expectedHeadSha',
] as const;

function refused(reason: string): RecordAuthorizationConsumptionResult {
  return { outcome: 'refused', reason };
}

export class RecordAuthorizationConsumptionUseCase implements RecordAuthorizationConsumptionPort {
  constructor(private readonly deps?: RecordAuthorizationConsumptionDependencies) {}

  async recordAuthorizationConsumption(
    request: RecordAuthorizationConsumptionRequest,
  ): Promise<RecordAuthorizationConsumptionResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RecordAuthorizationConsumptionResult> {
    if (!this.deps || typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: RecordAuthorizationConsumptionUseCase');
    }
    const request = input as RecordAuthorizationConsumptionRequest;
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof request[field] !== 'string' || request[field].trim().length === 0) {
        return refused(`an authorization consumption requires a non-empty ${field}`);
      }
    }
    const grantId = request.grantId.trim();
    const recorded = await this.deps.requestRepo.findRequestByGrantId(grantId);
    if (recorded === null) {
      return refused(`no recorded request holds grant ${grantId}`);
    }
    const existing = recorded.consumptions[0];
    if (existing !== undefined) {
      // One grant, one action: a second, unrelated action is never authorized,
      // and the same action is never recorded twice.
      return refused(
        existing.actionId === request.actionId.trim()
          ? `grant ${grantId} already authorized action ${existing.actionId}`
          : `grant ${grantId} already authorized action ${existing.actionId} and never a second action`,
      );
    }
    if (recorded.state !== 'approved') {
      return refused(`grant ${grantId} is ${recorded.state}, which authorizes no action`);
    }
    if (recorded.expectedHeadSha !== request.expectedHeadSha.trim()) {
      return refused(
        `grant ${grantId} was recorded for commit ${recorded.expectedHeadSha ?? 'none'}, not ${request.expectedHeadSha.trim()}`,
      );
    }
    const aggregate = CoordinationRequest.fromRecord(recorded);
    // The composition root supplies the clock; no authority depends on it here.
    const consumedAtIso =
      typeof request.nowIso === 'string' && request.nowIso.trim().length > 0
        ? request.nowIso
        : new Date().toISOString();
    const consumption: AuthorizationConsumptionRecord = AuthorizationConsumption.fromRecord({
      consumptionId: request.consumptionId.trim(),
      grantId,
      requestId: aggregate.getId(),
      actionId: request.actionId.trim(),
      attemptId: request.attemptId.trim(),
      expectedHeadSha: request.expectedHeadSha.trim(),
      consumedAtIso,
    }).toRecord();
    const consumed: CoordinationRequestRecord = CoordinationRequest.fromRecord({
      ...recorded,
      consumptions: [consumption],
      state: 'completed',
      revision: aggregate.nextRevision(),
      updatedAtIso: consumedAtIso,
    }).toRecord();
    await this.deps.requestRepo.saveRequest(consumed);
    return { outcome: 'consumed', consumption };
  }
}
