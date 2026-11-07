// @generated inbound contract scaffold — refined for lane T2c.
/**
 * RequestToolPermissionPort: record one pending tool-permission request under
 * an API-issued id with the tool input stored verbatim, then wait for the
 * first verdict; no verdict before the deadline is an explicit deny, and the
 * request never returns updatedInput.
 */

export type ToolPermissionRefusal =
  | 'body-not-an-object'
  | 'tool-name-missing'
  | 'tool-name-invalid'
  | 'tool-input-missing'
  | 'tool-input-not-serialisable'
  | 'tool-input-too-large'
  | 'thread-id-invalid'
  | 'too-many-pending-requests'
  | 'internal-error'
  | 'decision-missing'
  | 'decision-invalid'
  | 'request-id-invalid';

export type RequestToolPermissionOutcome =
  | { readonly outcome: 'allowed'; readonly requestId: string }
  | {
      readonly outcome: 'denied';
      readonly requestId: string;
      readonly reason: 'owner-denied' | 'no-verdict';
      readonly message: string;
    }
  | { readonly outcome: 'refused'; readonly reason: ToolPermissionRefusal };

export interface RequestToolPermissionPort {
  requestToolPermission(
    body: unknown,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<RequestToolPermissionOutcome>;
}
