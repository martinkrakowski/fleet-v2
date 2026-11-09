/**
 * GateFailingFilePort (PT1a): read the screened repo-relative file the failing
 * gate check of one attempt head named, from its verification receipts, so the
 * conductor can class a gate park as inside or outside the work order's owned
 * paths. Read-only. The path crosses the port already screened (no absolute
 * path, no `..`, bounded); a receipt that names no file reads as `null`.
 * Failure is a value: an unreadable store is `unavailable`, never a throw.
 */

export interface ReadGateFailingFileRequest {
  readonly attemptId: string;
  /** The exact collected head the gate evaluated. */
  readonly headSha: string;
}

export type ReadGateFailingFileResult =
  | { readonly outcome: 'found'; readonly failingFile: string | null }
  | { readonly outcome: 'unavailable' };

export interface GateFailingFilePort {
  readGateFailingFile(request: ReadGateFailingFileRequest): Promise<ReadGateFailingFileResult>;
}
