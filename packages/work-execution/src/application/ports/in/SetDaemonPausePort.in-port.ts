// @generated inbound contract scaffold — refined for lane DT10b.
/**
 * SetDaemonPausePort: `daemon pause` / `daemon resume` (daemon-tick plan §3.1).
 * The composition root implements it over the pause marker; it never throws.
 */
import type { DaemonPauseRecord } from '../../../domain/daemon-tick.js';

export interface SetDaemonPauseRequest {
  readonly paused: boolean;
  readonly nowIso: string;
}

export type SetDaemonPauseReasonCode = 'invalid-request' | 'invalid-clock' | 'pause-write-failed';

export type SetDaemonPauseResult =
  | {
      readonly outcome: 'recorded';
      readonly exitCode: 0;
      readonly record: DaemonPauseRecord;
    }
  | {
      readonly outcome: 'refused';
      readonly exitCode: 1;
      readonly reasonCode: SetDaemonPauseReasonCode;
    };

export interface SetDaemonPausePort {
  setPause(request: SetDaemonPauseRequest): Promise<SetDaemonPauseResult>;
}
