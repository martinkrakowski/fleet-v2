// @generated inbound contract scaffold — refined for lane T2c.
/**
 * GiveToolPermissionVerdictPort: record the first verdict on one pending
 * tool-permission request; the first verdict wins, the same decision again
 * changes nothing, and a different decision is a conflict. A verdict grants
 * nothing beyond the one tool call it names. `actorId` is the caller's token
 * id, never the body.
 */

import type { PermissionVerdictRecord } from '../../../domain/entities/PermissionRequest.js';
import type { ToolPermissionRefusal } from './RequestToolPermissionPort.in-port.js';

export type GiveToolPermissionVerdictOutcome =
  | { readonly outcome: 'recorded'; readonly verdict: PermissionVerdictRecord }
  | { readonly outcome: 'unchanged'; readonly verdict: PermissionVerdictRecord }
  | { readonly outcome: 'conflict'; readonly verdict: PermissionVerdictRecord }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'refused'; readonly reason: ToolPermissionRefusal };

export interface GiveToolPermissionVerdictPort {
  giveToolPermissionVerdict(
    body: unknown,
    requestId: string,
    actorId: string,
    threadId: string,
  ): Promise<GiveToolPermissionVerdictOutcome>;
}
