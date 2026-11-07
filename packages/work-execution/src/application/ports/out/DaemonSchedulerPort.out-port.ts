/**
 * DaemonSchedulerPort: write, read and remove one scheduler unit pair for the
 * daemon tick under the operator's user scope, from rendered text the caller
 * supplies (CO6). It never enables a unit, starts a process, runs a command or
 * reads a credential, and reports written, unchanged, absent or unreadable —
 * keys and codes only, never file text.
 */

export type DaemonSchedulerReadCode =
  | 'unchanged'
  | 'differs'
  | 'absent'
  | 'unreadable';
export type DaemonSchedulerWriteCode = 'written' | 'unchanged' | 'unreadable';
export type DaemonSchedulerRemoveCode = 'absent' | 'unreadable';

/** The two fixed user-scope unit file names (CO6). */
export const DAEMON_SERVICE_UNIT_KEY = 'fleet-v2-daemon.service';
export const DAEMON_TIMER_UNIT_KEY = 'fleet-v2-daemon.timer';

/** The rendered text of the two fixed units, service then timer. */
export interface DaemonSchedulerRendered {
  readonly service: string;
  readonly timer: string;
}

export interface DaemonSchedulerReadResult {
  readonly service: DaemonSchedulerReadCode;
  readonly timer: DaemonSchedulerReadCode;
}

export interface DaemonSchedulerWriteResult {
  readonly service: DaemonSchedulerWriteCode;
  readonly timer: DaemonSchedulerWriteCode;
}

export interface DaemonSchedulerRemoveResult {
  readonly service: DaemonSchedulerRemoveCode;
  readonly timer: DaemonSchedulerRemoveCode;
}

export interface DaemonSchedulerPort {
  read(input: DaemonSchedulerRendered): Promise<DaemonSchedulerReadResult>;
  write(input: DaemonSchedulerRendered): Promise<DaemonSchedulerWriteResult>;
  remove(): Promise<DaemonSchedulerRemoveResult>;
}
