// @generated inbound contract scaffold — refined for lane DT10b.
/**
 * InspectDaemonStatusPort: the read-only `daemon status` check (daemon-tick
 * plan §3.1). It reads the tick status record and evaluates its health at the
 * caller's clock; it never writes, never quarantines and never throws.
 */
import type {
  DaemonStatusHealth,
  DaemonStatusHealthReason,
  DaemonStatusRecord,
} from '../../../domain/daemon-tick.js';

export interface InspectDaemonStatusRequest {
  readonly nowIso: string;
  /** Tick interval in seconds (1..3600); defaults to policy.daemon.intervalSeconds or 60. */
  readonly intervalSeconds?: number;
}

export type InspectDaemonStatusRefusalReason =
  | 'invalid-request'
  | 'invalid-clock'
  | 'invalid-interval'
  | 'status-unreadable'
  | 'policy-unreadable';

export type InspectDaemonStatusResult =
  | {
      readonly outcome: 'ok';
      readonly exitCode: 0 | 1;
      readonly status: DaemonStatusRecord;
      readonly health: DaemonStatusHealth;
      readonly reasonCode: DaemonStatusHealthReason | null;
    }
  | {
      readonly outcome: 'missing';
      readonly exitCode: 1;
      readonly status: null;
      readonly health: null;
      readonly reasonCode: 'status-missing';
    }
  | {
      readonly outcome: 'refused';
      readonly exitCode: 1;
      readonly status: null;
      readonly health: null;
      readonly reasonCode: InspectDaemonStatusRefusalReason;
    };

export interface InspectDaemonStatusPort {
  inspectStatus(request: InspectDaemonStatusRequest): Promise<InspectDaemonStatusResult>;
}
