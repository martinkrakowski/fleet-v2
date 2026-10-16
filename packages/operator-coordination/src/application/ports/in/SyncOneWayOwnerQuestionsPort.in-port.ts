// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * SyncOneWayOwnerQuestionsPort: for each open one-way question, read its linked
 * request's decision through the DecisionTransportPort. A verified approved
 * decision moves the question to answered (shape accept, answeredVia
 * 'signed-decision'); a verified declined decision moves it to rejected.
 * Anything else — awaiting, unverified, error — leaves the question unchanged.
 * The coordination request is never written, and the answered-at moment comes
 * from the injected clock, never a request.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

export interface SyncOneWayOwnerQuestionsResult {
  readonly outcome: 'synced';
  /** Questions moved to answered this run, in listing order. */
  readonly answered: readonly OwnerQuestionRecord[];
  /** Questions moved to rejected this run, in listing order. */
  readonly rejected: readonly OwnerQuestionRecord[];
  /** Open one-way questions whose decision was still undecided or unreadable. */
  readonly unchanged: readonly OwnerQuestionRecord[];
}

export interface SyncOneWayOwnerQuestionsPort {
  /** Read each open one-way question's linked decision and reconcile state. */
  syncOneWayOwnerQuestions(): Promise<SyncOneWayOwnerQuestionsResult>;
}
