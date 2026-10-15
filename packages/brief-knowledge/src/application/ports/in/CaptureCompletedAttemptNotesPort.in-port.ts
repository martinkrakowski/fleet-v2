// @generated inbound contract scaffold — refined for migration step 4.
/**
 * CaptureCompletedAttemptNotesPort: accept bounded notes with
 * completed-attempt identity and record missing/incomplete reports; every
 * bullet becomes a candidate claim. Notes are observations, never
 * instructions or authority, and are only collected after the authoritative
 * lane end — this context never reads live worker files.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface CaptureCompletedAttemptNotesRequest {
  readonly projectId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly headCommitSha: string;
  readonly notesMarkdown: string | null;
  readonly pathPrefixes?: readonly string[];
  readonly nowIso?: string;
}

export type CaptureCompletedAttemptNotesResult =
  | {
      readonly outcome: 'captured';
      readonly notesStatus: 'present' | 'missing';
      readonly candidateEntries: readonly KnowledgeEntryRecord[];
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface CaptureCompletedAttemptNotesPort {
  /** Capture one completed attempt's notes as candidate claims; missing notes are recorded, never an error. */
  captureCompletedAttemptNotes(request: CaptureCompletedAttemptNotesRequest): Promise<CaptureCompletedAttemptNotesResult>;
}
