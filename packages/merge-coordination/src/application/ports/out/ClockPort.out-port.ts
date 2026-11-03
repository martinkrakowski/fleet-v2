// @generated outbound contract scaffold — refined for lane MC5e.
/**
 * Report the current time as a zoned ISO-8601 string; the only source of
 * time for lease expiry in this context; a throwing or malformed reading is
 * refused by its caller, never repaired or replaced by a request time.
 */
export interface ClockPort {
  /** Current time as a zoned ISO-8601 string. */
  nowIso(): string;
}
