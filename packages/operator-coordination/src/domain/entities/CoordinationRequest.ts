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
  PolicyGrantRecord,
  RelayAcknowledgementRecord,
} from '../coordination-records.js';
import {
  POLICY_GRANT_HEAD_PATTERN,
  POLICY_GRANT_SOURCE_FOR_KIND,
  isPolicyGrantRecord,
  parsePolicyDecisionRevision,
  policyGrantForgeKindOf,
} from '../policy-grants.js';
import { CoordinationKind } from '../value-objects/CoordinationKind.vo.js';
import type { CoordinationKindValue } from '../value-objects/CoordinationKind.vo.js';
import { CoordinationState } from '../value-objects/CoordinationState.vo.js';
import type { CoordinationStateValue } from '../value-objects/CoordinationState.vo.js';

const DELIVERY_STATUSES: readonly string[] = ['delivered', 'pending', 'delivery-gap'];

/** The record with a writable optional policyGrant so normalization can omit the key. */
type MutableCoordinationRequestRecord = Omit<CoordinationRequestRecord, 'policyGrant'> & {
  policyGrant?: PolicyGrantRecord;
};

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
    const policyGrant = CoordinationRequest.readPolicyGrant(record);
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
    const normalized: MutableCoordinationRequestRecord = {
      ...record,
      consumptions,
      acknowledgements,
    };
    if (policyGrant === undefined) {
      delete normalized.policyGrant;
    } else {
      normalized.policyGrant = policyGrant;
    }
    return new CoordinationRequest(normalized);
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

  private static readPolicyGrant(record: CoordinationRequestRecord): PolicyGrantRecord | undefined {
    let descriptor: PropertyDescriptor | undefined;
    
    try {
      descriptor = Object.getOwnPropertyDescriptor(record, 'policyGrant');
    } catch {
      throw new Error('PolicyGrant validation failed due to a prohibited Proxy trap execution.');
    }
    
    if (descriptor === undefined) {
      return undefined;
    }
    
    if (descriptor.get || descriptor.set) {
      throw new Error('CoordinationRequest policyGrant cannot be an accessor property.');
    }
    
    const raw: unknown = descriptor.value;
    
    if (raw === undefined) {
      return undefined;
    }
    
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(
        'CoordinationRequest policyGrant must be { workOrderId, attemptId, acceptanceReceiptId }',
      );
    }

    let proto: unknown;
    let ownKeys: PropertyKey[];
    
    try {
      proto = Object.getPrototypeOf(raw);
      ownKeys = Reflect.ownKeys(raw);
    } catch {
      throw new Error('PolicyGrant validation failed due to a prohibited Proxy trap execution.');
    }
    
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('CoordinationRequest policyGrant must only use Object.prototype or null as its prototype.');
    }
    
    let keyDescriptors: Array<[PropertyKey, PropertyDescriptor | undefined]>;
    
    try {
      keyDescriptors = ownKeys.map(key => [key, Object.getOwnPropertyDescriptor(raw, key)]);
    } catch {
      throw new Error('PolicyGrant validation failed due to a prohibited Proxy trap execution.');
    }
    
    // Now validate the snapshot and build the stored copy.
    const keys: string[] = [];
    const snapshot: Record<string, unknown> = {};

    for (const [key, keyDescriptor] of keyDescriptors) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('Policy grant key must be a non-empty string.');
      }
      if (!keyDescriptor || keyDescriptor.get || keyDescriptor.set || keyDescriptor.enumerable === false) {
        throw new Error('Policy grant property must be an enumerable data property.');
      }
      keys.push(key);
      snapshot[key] = keyDescriptor.value;
    }
    
    const grantKeys = ['workOrderId', 'attemptId', 'acceptanceReceiptId'];
    if (keys.length !== grantKeys.length || !grantKeys.every((k) => keys.includes(k))) {
      throw new Error(
        'CoordinationRequest policyGrant must be { workOrderId, attemptId, acceptanceReceiptId }',
      );
    }
    
    const collected: Record<string, string> = {};
    for (const key of grantKeys) {
      // Validate and copy from the descriptor snapshot; the object is never read again.
      const value = snapshot[key];

      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
        throw new Error(
          'CoordinationRequest policyGrant must be { workOrderId, attemptId, acceptanceReceiptId }',
        );
      }
      
      collected[key] = value;
    }
    
    const grant: PolicyGrantRecord = {
      workOrderId: collected.workOrderId,
      attemptId: collected.attemptId,
      acceptanceReceiptId: collected.acceptanceReceiptId,
    };
    
    if (record.kind !== 'action-decision') {
      throw new Error('CoordinationRequest policy grant must be an action-decision');
    }
    
    const parsed = parsePolicyDecisionRevision(record.decisionRevision);
    if (parsed === null) {
      throw new Error('CoordinationRequest policy grant must carry a policy decision revision');
    }
    const kind = policyGrantForgeKindOf(record.actionScope);
    if (kind === null || POLICY_GRANT_SOURCE_FOR_KIND[kind] !== parsed.source) {
      throw new Error('CoordinationRequest policy grant scope does not match its setting');
    }
    if (record.expectedHeadSha === null || !POLICY_GRANT_HEAD_PATTERN.test(record.expectedHeadSha)) {
      throw new Error('CoordinationRequest policy grant requires an expected head');
    }

    return Object.freeze(grant);
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): CoordinationRequestRecord {
    const record: MutableCoordinationRequestRecord = {
      ...this.record,
      consumptions: this.record.consumptions.map((consumption) => ({ ...consumption })),
      acknowledgements: this.record.acknowledgements.map((acknowledgement) => ({
        ...acknowledgement,
      })),
    };
    if (this.record.policyGrant !== undefined) {
      record.policyGrant = { ...this.record.policyGrant };
    }
    return record;
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

  getPolicyGrant(): PolicyGrantRecord | null {
    return this.record.policyGrant === undefined ? null : { ...this.record.policyGrant };
  }

  isPolicyGrant(): boolean {
    return isPolicyGrantRecord(this.record);
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
