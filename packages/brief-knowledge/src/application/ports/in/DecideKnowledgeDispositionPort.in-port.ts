// @generated inbound contract scaffold — refined for migration step 4.
/**
 * DecideKnowledgeDispositionPort: accept, defer, reject or flag a policy
 * proposal with checker identity and reasons. Deliberate disposition — not
 * capture — promotes a candidate into reusable context, and a policy
 * proposal never becomes an accepted keeper.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';
import type { KnowledgeDispositionValue } from '../../../domain/value-objects/KnowledgeDisposition.vo.js';

export interface DecideKnowledgeDispositionRequest {
  readonly entryId: string;
  readonly disposition: KnowledgeDispositionValue;
  readonly checkerId: string;
  readonly reason: string;
  /**
   * The checker's justification for accepting a triage-flagged candidate.
   * Required only when the entry carries a `triageFlag` and the disposition
   * is `accepted`; it never substitutes for `reason` or for the policy
   * proposal guard. Refused when it is empty, longer than 1024 characters or
   * credential-shaped — never redacted.
   */
  readonly overrideReason?: string;
  readonly nowIso?: string;
}

export type DecideKnowledgeDispositionResult =
  | { readonly outcome: 'decided'; readonly entry: KnowledgeEntryRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface DecideKnowledgeDispositionPort {
  /** Record one deliberate disposition with checker identity and reason. */
  decideKnowledgeDisposition(request: DecideKnowledgeDispositionRequest): Promise<DecideKnowledgeDispositionResult>;
}
