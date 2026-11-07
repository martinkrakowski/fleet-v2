// @generated outbound contract scaffold — refined for lane O2c-1.
/**
 * OrchestratorRequestJournalPort: the request channel's keyed journal read
 * under `request/<requestId>` (K1b). It is a narrow view over the shared
 * run-journal store: entries expose only fixed facts (entry id, kind, the
 * intent digest, outcome and reason code) and never paths, hosts or raw text.
 * A missing file reads as no entries; an unreadable journal is unknown, never
 * a thrown message. Appends run through the same K1b uniqueness guard as every
 * other journal write, so a duplicate intent is refused before it is written.
 */

export interface OrchestratorRequestJournalEntry {
  readonly entryId: string;
  readonly kind: 'intent' | 'result';
  /** The intent's full request digest; null when absent or on a result. */
  readonly digest: string | null;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
}

export type ReadOrchestratorRequestJournalResult =
  | { readonly outcome: 'read'; readonly entries: readonly OrchestratorRequestJournalEntry[] }
  | { readonly outcome: 'unknown' };

export type AppendOrchestratorRequestJournalResult =
  | { readonly outcome: 'appended' }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unknown' };

export interface OrchestratorRequestJournalPort {
  read(key: string): Promise<ReadOrchestratorRequestJournalResult>;
  appendIntent(
    key: string,
    intent: {
      readonly entryId: string;
      readonly recordedAtIso: string;
      readonly digest: string;
    },
  ): Promise<AppendOrchestratorRequestJournalResult>;
  appendResult(
    key: string,
    result: {
      readonly entryId: string;
      readonly recordedAtIso: string;
      readonly outcome: string;
      readonly reasonCode: string | null;
    },
  ): Promise<AppendOrchestratorRequestJournalResult>;
}
