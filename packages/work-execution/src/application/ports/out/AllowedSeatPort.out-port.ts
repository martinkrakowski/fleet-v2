// Outbound contract: decide whether a dispatch seat or a reviewer model may be
// used under the installation's free-seat policy. Refined from the generated
// scaffold for lane FS3a-B.
/**
 * AllowedSeatPort: given the installation's seat catalogue and
 * `policy.useFreeSeats`, decide whether a dispatch seat (tool, model, variant)
 * or a reviewer model may be used. The input is a structural subset of
 * `@fleet/installation`'s derived model, so work-execution stays free of a
 * dependency on that package. With the flag false only seats that are all not
 * free are allowed; an unknown or mixed match is refused (fail closed).
 */

export interface AllowedSeatCatalogueSeat {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly costClass: 'free' | 'plan-quota' | 'paid';
}

export interface DispatchSeatQuery {
  readonly tool: string;
  readonly model: string;
  readonly variant?: string | null;
}

export interface ReviewerModelQuery {
  readonly model: string;
}

export type AllowedSeatVerdict =
  | { readonly allowed: true; readonly useFreeSeats: boolean }
  | { readonly allowed: false; readonly useFreeSeats: false; readonly reason: string };

export interface AllowedSeatPort {
  checkDispatchSeat(query: DispatchSeatQuery): AllowedSeatVerdict;
  checkReviewerModel(query: ReviewerModelQuery): AllowedSeatVerdict;
}
