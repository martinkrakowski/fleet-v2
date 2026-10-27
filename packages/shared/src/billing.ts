/**
 * How a seat's spend is billed, by the recorded runner kind (telemetry plan §3.6; web usage chips P10).
 * opencode figures are metered spend as opencode recorded it; agy runs on a plan quota, so its figures are
 * estimates, not spend; any other or missing kind is unknown and is never priced. Pure: no I/O.
 */
export const SEAT_BILLINGS = ['metered', 'plan', 'unknown'] as const;

export type SeatBilling = (typeof SEAT_BILLINGS)[number];

export function billingOf(runnerKind: unknown): SeatBilling {
  switch (runnerKind) {
    case 'opencode':
      return 'metered';
    case 'agy':
      return 'plan';
    default:
      return 'unknown';
  }
}
