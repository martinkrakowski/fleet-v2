/**
 * CutoverRecordRepositoryPort stores and reads the one CutoverRecord v1 of an
 * installation with compare-and-set on its revision (lane CO30a). An absent
 * version reads as 1; an unknown version or an unreadable record is reported,
 * never treated as absent and never overwritten. It performs no forge, host or
 * git action.
 */
import type { CutoverRecord } from '../../../domain/cutover-records.js';

export type CutoverRecordReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly record: CutoverRecord }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'unreadable' };

export type CutoverRecordRepositoryReadResult = CutoverRecordReadResult;

export type CutoverRecordCasRefusalReason =
  | 'invalid-request'
  | 'invalid-record'
  | 'unknown-version'
  | 'unreadable'
  | 'read-only'
  | 'deadline-exceeded';

export type CutoverRecordCasResult =
  | { readonly outcome: 'saved'; readonly record: CutoverRecord }
  | { readonly outcome: 'conflict'; readonly currentRevision: number | null }
  | { readonly outcome: 'refused'; readonly reason: CutoverRecordCasRefusalReason };

export interface CutoverRecordRepositoryPort {
  /** Never writes, locks or quarantines. */
  read(options?: { readonly deadlineIso?: string }): Promise<CutoverRecordRepositoryReadResult>;
  /** Saves `next` only when the stored revision is `expectedRevision` (0 when nothing is stored). Never throws. */
  compareAndSet(request: {
    readonly expectedRevision: number;
    readonly next: CutoverRecord;
    readonly deadlineIso?: string;
  }): Promise<CutoverRecordCasResult>;
}
