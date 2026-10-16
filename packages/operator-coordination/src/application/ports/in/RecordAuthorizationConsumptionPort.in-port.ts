// @generated inbound contract scaffold — refined for step 5.
/**
 * RecordAuthorizationConsumptionPort: durably bind a grant to an action id and
 * attempt and retain the reconciliation receipt. A grant already consumed for
 * that action is refused rather than recorded twice, and this port never
 * authorizes a second, unrelated action.
 */

import type { AuthorizationConsumptionRecord } from '../../../domain/coordination-records.js';

export interface RecordAuthorizationConsumptionRequest {
  readonly consumptionId: string;
  readonly grantId: string;
  readonly actionId: string;
  readonly actionScope: string;
  readonly actionKind?: string;
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly nowIso?: string;
}

export type RecordAuthorizationConsumptionResult =
  | {
      readonly outcome: 'consumed';
      readonly consumption: AuthorizationConsumptionRecord;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: string;
    };

export interface RecordAuthorizationConsumptionPort {
  recordAuthorizationConsumption(
    request: RecordAuthorizationConsumptionRequest,
  ): Promise<RecordAuthorizationConsumptionResult>;
}
