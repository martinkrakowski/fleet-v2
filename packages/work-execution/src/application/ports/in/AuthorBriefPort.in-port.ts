// @generated inbound contract scaffold — refined for lane CO17.
/** See this context's contracts registry in manifest.yaml. */
import type { BuildFactPackFact } from './BuildFactPackPort.in-port.js';
import type { PrepareBriefPackageRequest, PreparedBriefPackage } from './PrepareBriefPackagePort.in-port.js';
import type { BriefLintFinding } from '../../../domain/brief-answer.js';

export interface AuthorBriefRequest {
  readonly workOrderId: string;
  readonly laneId: string;
  readonly repositoryPath: string;
  readonly checkoutPath: string;
  readonly briefsDir: string;
  readonly commit: string;
  readonly facts: readonly BuildFactPackFact[];
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  /** The prepare request whose prose the seat replaces; `proseMarkdown` is set by the use case. */
  readonly prepare: Omit<PrepareBriefPackageRequest, 'proseMarkdown'>;
}

export type AuthorBriefRefusalReason =
  | 'invalid-request'
  | 'fact-pack-refused'
  | 'session-unavailable'
  | 'answer-invalid'
  | 'secret-shaped'
  | 'brief-lint-failed'
  | 'freeze-rejected';

export interface AuthorBriefRefusal {
  readonly reason: AuthorBriefRefusalReason;
  readonly detail: string;
  readonly findings?: readonly BriefLintFinding[];
}

export type AuthorBriefResult =
  | { readonly outcome: 'authored'; readonly sessionKey: string; readonly prepared: PreparedBriefPackage }
  | { readonly outcome: 'refused'; readonly refusal: AuthorBriefRefusal };

export interface AuthorBriefPort {
  authorBrief(request: AuthorBriefRequest): Promise<AuthorBriefResult>;
}
