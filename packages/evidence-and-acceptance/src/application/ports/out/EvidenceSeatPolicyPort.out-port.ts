/**
 * EvidenceSeatPolicyPort is the evidence context's own consumer-side contract
 * for the installation's seat policy. It is a structural subset of
 * `@fleet/installation`'s derived model: the evidence context may not import
 * `@fleet/installation`, so the apps wire this port from
 * `deriveInstallationModel(...)`.
 */

export type EvidenceSeatCostClass = 'free' | 'plan-quota' | 'paid';

export interface EvidenceCatalogueSeat {
  readonly id: string;
  readonly model: string;
  readonly variant?: string;
  readonly costClass?: EvidenceSeatCostClass;
}

export interface CheckReviewerSeatRequest {
  readonly reviewerModel: string;
}

export type ReviewerSeatCheck =
  | { readonly outcome: 'allowed' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface EvidenceSeatPolicyPort {
  checkReviewerSeat(request: CheckReviewerSeatRequest): Promise<ReviewerSeatCheck>;
}
