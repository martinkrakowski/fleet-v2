// Implemented for lane E3a-1 (repository saves emit change signals).
/**
 * NoopChangeSignalAdapter implements ChangeSignalPort (in-process-noop) by
 * doing nothing, so a repository can always emit without an observer wired.
 */

import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';

export class NoopChangeSignalAdapter implements ChangeSignalPort {
  emit(_signal: ChangeSignal): void {
    // no-op
  }
}
