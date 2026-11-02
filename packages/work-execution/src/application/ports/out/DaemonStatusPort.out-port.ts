// @generated outbound contract scaffold — refined for lane DT3.
/**
 * Atomically write and read the daemon status record v1 (temp plus rename),
 * reporting known absence separately from unreadable state (plan §3.4).
 */
import type {
  BuildDaemonStatusInput,
  DaemonStatusRead,
  DaemonStatusRecord,
} from '../../../domain/daemon-tick.js';

export type DaemonStatusFileRead =
  | { readonly status: 'ok'; readonly record: DaemonStatusRecord }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' };

export interface DaemonStatusPort {
  write(input: BuildDaemonStatusInput): Promise<DaemonStatusRead>;
  read(): Promise<DaemonStatusFileRead>;
}
