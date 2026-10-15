// @generated entity stub — refined for step 5.
/**
 * AuthorizationConsumption is the child record binding one grant to one action
 * id and attempt. It exists so reconciliation can prove which action a grant
 * was spent on: a recorded consumption never authorizes a second, unrelated
 * action.
 */

import type { AuthorizationConsumptionRecord } from '../coordination-records.js';

export class AuthorizationConsumption {
  private constructor(private readonly record: AuthorizationConsumptionRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: AuthorizationConsumptionRecord): AuthorizationConsumption {
    if (typeof record !== 'object' || record === null) {
      throw new Error('AuthorizationConsumption requires a record');
    }
    for (const field of [
      'consumptionId',
      'grantId',
      'requestId',
      'actionId',
      'attemptId',
      'expectedHeadSha',
      'consumedAtIso',
    ] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`AuthorizationConsumption requires a non-empty ${field}`);
      }
    }
    return new AuthorizationConsumption({ ...record });
  }

  getId(): string {
    return this.record.consumptionId;
  }

  toRecord(): AuthorizationConsumptionRecord {
    return { ...this.record };
  }

  getGrantId(): string {
    return this.record.grantId;
  }

  getActionId(): string {
    return this.record.actionId;
  }

  getAttemptId(): string {
    return this.record.attemptId;
  }

  isForGrant(grantId: string): boolean {
    return this.record.grantId === grantId;
  }

  isForAction(actionId: string): boolean {
    return this.record.actionId === actionId;
  }

  isForAttempt(attemptId: string): boolean {
    return this.record.attemptId === attemptId;
  }

  equals(other: AuthorizationConsumption): boolean {
    return this.record.consumptionId === other.record.consumptionId;
  }
}
