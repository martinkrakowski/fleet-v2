/**
 * Doctor check types (plan section 6). Pure data: a doctor line names a
 * scope, a subject, the check that ran, its outcome and a detail string.
 * A detail never contains file contents, keys or tokens — only paths,
 * modes, versions and reasons.
 */

/** Which part of the installation a line reports on. */
export type DoctorScope =
  | 'installation'
  | 'host'
  | 'tool'
  | 'seat'
  | 'credential'
  | 'runner-binary';

/** Outcome of one doctor check. `UNKNOWN` means the check could not tell. */
export type DoctorStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

/** One reported doctor check. */
export interface DoctorLine {
  readonly scope: DoctorScope;
  /** What was checked: a host name, tool id, seat id, credential path. */
  readonly subject: string;
  /** Short name of the check within its subject. */
  readonly check: string;
  readonly status: DoctorStatus;
  /**
   * Human-readable explanation. Paths, modes, versions and reasons only —
   * never file contents, keys or tokens.
   */
  readonly detail: string;
}
