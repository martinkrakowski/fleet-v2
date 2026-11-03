/**
 * The system clock adapter: reports the current wall-clock time as a zoned
 * ISO-8601 string. It is the only source of time for lease expiry in this
 * context; a throwing or malformed reading is refused by its caller, never
 * repaired or replaced by a request time.
 */

import type { ClockPort } from '../../application/ports/out/ClockPort.out-port.js';

export class SystemClockAdapter implements ClockPort {
  nowIso(): string {
    return new Date().toISOString();
  }
}
