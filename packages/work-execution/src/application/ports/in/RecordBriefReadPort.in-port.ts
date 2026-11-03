// @generated inbound contract scaffold — refined for lane WB4c.
/**
 * RecordBriefReadPort: record one `plan brief-check` read (work-board plan
 * §3.6). The read moment comes from the injected clock, never the body; a
 * `failed` read is a valid record that stores null digest and byte count
 * and echoes nothing from the body.
 */
import type { BriefReadRecord } from '../../../domain/lane-activity-records.js';

export type RecordBriefReadRefusalCode = 'refused' | 'store' | 'clock';

export type RecordBriefReadResult =
  | { readonly outcome: 'recorded'; readonly read: BriefReadRecord }
  | { readonly outcome: 'refused'; readonly code: RecordBriefReadRefusalCode; readonly reason: string };

export interface RecordBriefReadPort {
  /** `body` is untrusted. `actor` is the caller's name, never the body. */
  execute(body: unknown, actor: string): Promise<RecordBriefReadResult>;
}
