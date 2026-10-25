/**
 * ProjectProbeRecordPort records a probe receipt on a profile at the revision
 * the probe started from. A changed profile is a typed rejection, never an
 * overwrite.
 */

export type ProjectProbeReceiptResult = 'pass' | 'fail' | 'unknown';

export interface ProjectProbeReceiptCheck {
  readonly name: string;
  readonly host: string | null;
  readonly result: ProjectProbeReceiptResult;
  readonly detail: string;
}

export interface ProjectProbeReceipt {
  readonly probedAtIso: string;
  readonly probedFrom: string;
  readonly checks: readonly ProjectProbeReceiptCheck[];
}

export interface ProjectProbeRecordRequest {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly receipt: ProjectProbeReceipt;
}

export type ProjectProbeRecordResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ProjectProbeRecordPort {
  recordProjectProbe(
    request: ProjectProbeRecordRequest,
  ): Promise<ProjectProbeRecordResult>;
}
