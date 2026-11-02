// @generated outbound contract scaffold — refined for lane DT3.
/**
 * Read and write the pause marker (plan §3.4); an unreadable marker reads as
 * paused, and that fail-closed mapping lives in the use case, not here.
 */
import type {
  DaemonPauseRead,
  DaemonPauseState,
} from '../../../domain/daemon-tick.js';

export interface DaemonPausePort {
  read(): Promise<DaemonPauseState>;            // state:'clear'|'paused'|'unreadable'
  write(paused: boolean, changedAtIso: string): Promise<DaemonPauseRead>;
}
