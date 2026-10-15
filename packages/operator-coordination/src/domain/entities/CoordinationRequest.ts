// @generated entity stub — refined for step 5.
/**
 * CoordinationRequest is the aggregate root for one scoped proposal: the exact
 * action scope, expected commit, proposal digest, policy revision and decision
 * revision that were recorded before its authorized decider was asked. It owns
 * its authorization consumptions and relay acknowledgements.
 *
 * The invariants are deliberately conservative: only an approved request with a
 * recorded grant and decision revision authorizes its exact action and expected
 * commit; a grant is never spent twice on the same action id; and a delivery
 * gap is recorded explicitly rather than inferred from silence.
 */

import type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
  RelayAcknowledgementRecord,
} from '../coordination-records.js';
import { CoordinationKind } from '../value-objects/CoordinationKind.vo.js';
import type { CoordinationKindValue } from '../value-objects/CoordinationKind.vo.js';
import { CoordinationState } from '../value-objects/CoordinationState.vo.js';
import type { CoordinationStateValue } from '../value-objects/CoordinationState.vo.js';

const DELIVERY_STATUSES: readonly string[] = ['delivered', 'pending', 'delivery-gap'];

export class CoordinationRequest {
  private constructor(private readonly record: CoordinationRequestRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: CoordinationRequestRecord): CoordinationRequest {
    if (typeof record !== 'object' || record === null) {
      throw new Error('CoordinationRequest requires a record');
    }
    for (const field of [
      'id',
      'projectId',
      'actionScope',
      'proposalDigest',
      'policyRevision',
      'createdAtIso',
      'updatedAtIso',
    ] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`CoordinationRequest requires a non-empty ${field}`);
      }
    }
    for (const field of ['expectedHeadSha', 'decisionRevision', 'grantId'] as const) {
      const value = record[field];
      if (value !== null && (typeof value !== 'string' || value.trim().length === 0)) {
        throw new Error(`CoordinationRequest ${field} must be a non-empty string or null`);
      }
    }
    const kind = CoordinationKind.create(record.kind);
    if (!kind.success || kind.value === undefined) {
      throw new Error(`CoordinationRequest has an invalid kind: ${String(record.kind)}`);
    }
    const state = CoordinationState.create(record.state);
    if (!state.success || state.value === undefined) {
      throw new Error(`CoordinationRequest has an invalid state: ${String(record.state)}`);
    }
    if (!DELIVERY_STATUSES.includes(record.deliveryStatus)) {
      throw new Error(`CoordinationRequest has an invalid delivery status: ${String(record.deliveryStatus)}`);
    }
    if (record.deliveryStatus === 'delivery-gap') {
      if (typeof record.deliveryGapReason !== 'string' || record.deliveryGapReason.length === 0) {
        throw new Error('CoordinationRequest requires a delivery gap reason for a delivery gap');
      }
    } else if (record.deliveryGapReason !== null) {
      throw new Error('CoordinationRequest records a delivery gap reason without a delivery gap');
    }
    if (!Number.isInteger(record.revision) || record.revision < 0) {
      throw new Error('CoordinationRequest requires a non-negative integer revision');
    }
    const consumptions = CoordinationRequest.readConsumptions(record.consumptions);
    const acknowledgements = CoordinationRequest.readAcknowledgements(record.acknowledgements);
    return new CoordinationRequest({
      ...record,
      consumptions,
      acknowledgements,
    });
  }

  private static readConsumptions(
    consumptions: readonly AuthorizationConsumptionRecord[],
  ): readonly AuthorizationConsumptionRecord[] {
    if (!Array.isArray(consumptions)) {
      throw new Error('CoordinationRequest requires an array of consumptions');
    }
    const seenIds = new Set<string>();
    const seenActions = new Set<string>();
    for (const consumption of consumptions) {
      if (seenIds.has(consumption.consumptionId)) {
        throw new Error(
          `CoordinationRequest repeats consumption id: ${consumption.consumptionId}`,
        );
      }
      if (seenActions.has(consumption.actionId)) {
        throw new Error(
          `CoordinationRequest authorizes action ${consumption.actionId} more than once`,
        );
      }
      seenIds.add(consumption.consumptionId);
      seenActions.add(consumption.actionId);
    }
    return Object.freeze(consumptions.map((consumption) => ({ ...consumption })));
  }

  private static readAcknowledgements(
    acknowledgements: readonly RelayAcknowledgementRecord[],
  ): readonly RelayAcknowledgementRecord[] {
    if (!Array.isArray(acknowledgements)) {
      throw new Error('CoordinationRequest requires an array of acknowledgements');
    }
    const seenIds = new Set<string>();
    for (const acknowledgement of acknowledgements) {
      if (seenIds.has(acknowledgement.acknowledgementId)) {
        throw new Error(
          `CoordinationRequest repeats acknowledgement id: ${acknowledgement.acknowledgementId}`,
        );
      }
      seenIds.add(acknowledgement.acknowledgementId);
    }
    return Object.freeze(acknowledgements.map((acknowledgement) => ({ ...acknowledgement })));
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): CoordinationRequestRecord {
    return {
      ...this.record,
      consumptions: this.record.consumptions.map((consumption) => ({ ...consumption })),
      acknowledgements: this.record.acknowledgements.map((acknowledgement) => ({
        ...acknowledgement,
      })),
    };
  }

  getKind(): CoordinationKindValue {
    return this.record.kind;
  }

  getState(): CoordinationStateValue {
    return this.record.state;
  }

  getActionScope(): string {
    return this.record.actionScope;
  }

  getExpectedHeadSha(): string | null {
    return this.record.expectedHeadSha;
  }

  getPolicyRevision(): string {
    return this.record.policyRevision;
  }

  getGrantId(): string | null {
    return this.record.grantId;
  }

  getDecisionRevision(): string | null {
    return this.record.decisionRevision;
  }

  isApproved(): boolean {
    return this.record.state === 'approved';
  }

  isTerminal(): boolean {
    return (
      this.record.state === 'completed' ||
      this.record.state === 'declined' ||
      this.record.state === 'expired' ||
      this.record.state === 'cancelled'
    );
  }

  /**
   * The recorded grant authorizes only this request's exact action scope at its
   * expected commit. A moved head, a different scope, a missing decision
   * revision or any state other than approved blocks the action.
   */
  canAuthorizeAction(actionScope: string, expectedHeadSha: string): boolean {
    if (!this.isApproved() || this.record.grantId === null) {
      return false;
    }
    if (this.record.decisionRevision === null) {
      return false;
    }
    return (
      this.record.actionScope === actionScope && this.record.expectedHeadSha === expectedHeadSha
    );
  }

  getConsumptions(): readonly AuthorizationConsumptionRecord[] {
    return this.record.consumptions.map((consumption) => ({ ...consumption }));
  }

  hasConsumptionForAction(actionId: string): boolean {
    return this.record.consumptions.some((consumption) => consumption.actionId === actionId);
  }

  getConsumptionsForGrant(grantId: string): readonly AuthorizationConsumptionRecord[] {
    return this.record.consumptions
      .filter((consumption) => consumption.grantId === grantId)
      .map((consumption) => ({ ...consumption }));
  }

  getAcknowledgements(): readonly RelayAcknowledgementRecord[] {
    return this.record.acknowledgements.map((acknowledgement) => ({ ...acknowledgement }));
  }

  /** Silence is not acknowledgement; only a recorded response counts. */
  isAcknowledgedBy(recipientId: string): boolean {
    return this.record.acknowledgements.some(
      (acknowledgement) => acknowledgement.recipientId === recipientId,
    );
  }

  hasDeliveryGap(): boolean {
    return this.record.deliveryStatus === 'delivery-gap';
  }

  getDeliveryGapReason(): string | null {
    return this.record.deliveryGapReason;
  }

  getRevision(): number {
    return this.record.revision;
  }

  /** Optimistic concurrency: request revisions only move forward. */
  nextRevision(): number {
    return this.record.revision + 1;
  }
}
