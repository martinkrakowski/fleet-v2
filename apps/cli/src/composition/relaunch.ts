/**
 * The read-only composition of the relaunch reads (CO29a-ro2): the halt
 * marker and the driver lease `relaunch inventory` reads are opened
 * read-only, so a corrupt store file is never quarantined by a read-only
 * command — the read answers the typed unreadable error and writes nothing.
 * Every other command keeps its writable instances.
 */

import { ConductorDriverLeaseAdapter, ConductorHaltAdapter } from '@fleet/work-execution';

export interface ComposeReadOnlyRelaunchInput {
  /** The state directory the relaunch reads; the stores it names are never written. */
  readonly stateDir?: string;
}

export function composeReadOnlyRelaunch(input: ComposeReadOnlyRelaunchInput = {}) {
  return {
    halt: new ConductorHaltAdapter({ stateDir: input.stateDir, readOnly: true }),
    driverLease: new ConductorDriverLeaseAdapter({ stateDir: input.stateDir, readOnly: true }),
  };
}
