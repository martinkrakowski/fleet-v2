// @generated inbound contract scaffold — refined for lane CO17.
/** See this context's contracts registry in manifest.yaml. */
import type { BuildFactPackFact } from './BuildFactPackPort.in-port.js';
import type { PrepareBriefPackageRequest } from './PrepareBriefPackagePort.in-port.js';

export interface AuthorBriefFactPackRequest {
  readonly repositoryPath: string;
  readonly commit: string;
  readonly facts: readonly BuildFactPackFact[];
}

export interface AuthorBriefSeat {
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
}

export interface AuthorBriefRequest {
  readonly workOrderId: string;
  readonly laneId: string;
  /** The prepare request whose prose the seat replaces; `proseMarkdown` is set by the use case. */
  readonly prepare: Omit<PrepareBriefPackageRequest, 'proseMarkdown'>;
  readonly factPack: AuthorBriefFactPackRequest;
  readonly seat: AuthorBriefSeat;
  /** The pinned read-only checkout the seat reads. */
  readonly checkoutPath: string;
  /** The ignored directory the session writes into. */
  readonly briefsDir: string;
}

export const AUTHOR_BRIEF_REFUSAL_REASONS = [
  'invalid-request', 'fact-pack-refused', 'seat-unavailable', 'parse-violation',
  'lint-violation', 'freeze-rejected', 'secret-shaped',
] as const;
export type AuthorBriefRefusalReason = (typeof AUTHOR_BRIEF_REFUSAL_REASONS)[number];

export type AuthorBriefResult =
  | { readonly outcome: 'authored'; readonly attemptId: string; readonly briefDigest: string; readonly sessionKey: string }
  | { readonly outcome: 'refused'; readonly reason: AuthorBriefRefusalReason; readonly detail: string | null }
  | { readonly outcome: 'unknown'; readonly reason: 'seat-call-failed' | 'session-outcome-unknown' };

export interface AuthorBriefPort {
  authorBrief(request: AuthorBriefRequest): Promise<AuthorBriefResult>;
}
