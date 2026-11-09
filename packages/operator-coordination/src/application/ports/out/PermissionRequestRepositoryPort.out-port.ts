// @generated outbound contract scaffold — refined for lane T2c.
/**
 * PermissionRequestRepositoryPort: hold pending tool-permission requests and
 * their first verdict; a request that already holds a verdict is never
 * overwritten. The port is synchronous in-process memory: no filesystem, no
 * network, no subprocess.
 */

import type {
  PermissionRequestRecord,
  PermissionVerdictRecord,
} from '../../../domain/entities/PermissionRequest.js';

export interface PermissionRequestRepositoryPort {
  /** Store one new pending request. Refused when the pending cap is reached. */
  record(
    request: PermissionRequestRecord,
  ): { readonly stored: boolean; readonly reason?: 'too-many-pending-requests' };

  find(requestId: string): PermissionRequestRecord | undefined;

  listPending(): readonly PermissionRequestRecord[];

  /** Record the first verdict; a decided request is never overwritten. */
  recordVerdict(
    requestId: string,
    verdict: PermissionVerdictRecord,
  ): { readonly outcome: 'recorded' | 'unchanged' | 'conflict' | 'unknown' | 'expired' };

  /** Expire a pending request. If already decided or expired, this is a no-op. */
  expire(
    requestId: string,
    reasonCode: 'timed-out' | 'interrupted',
    expiredAtIso?: string,
  ): { readonly outcome: 'expired' | 'noop' | 'unknown' };
}
