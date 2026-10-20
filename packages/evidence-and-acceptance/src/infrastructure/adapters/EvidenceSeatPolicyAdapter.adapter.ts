/**
 * EvidenceSeatPolicyAdapter implements EvidenceSeatPolicyPort from a
 * structural subset of the installation's derived model. It is pure: it
 * performs no I/O and decides only from the options it was constructed with.
 */

import type {
  EvidenceCatalogueSeat,
  EvidenceSeatPolicyPort,
  ReviewerSeatCheck,
} from '../../application/ports/out/EvidenceSeatPolicyPort.out-port.js';

export interface EvidenceSeatPolicyOptions {
  readonly useFreeSeats?: boolean;
  readonly seats?: readonly EvidenceCatalogueSeat[];
}

export class EvidenceSeatPolicyAdapter implements EvidenceSeatPolicyPort {
  constructor(private readonly options: EvidenceSeatPolicyOptions = {}) {}

  async checkReviewerSeat(request: { reviewerModel: string }): Promise<ReviewerSeatCheck> {
    if (this.options.useFreeSeats !== false) {
      return { outcome: 'allowed' };
    }
    const m = request.reviewerModel.trim();
    const seats = this.options.seats ?? [];
    const i = m.lastIndexOf(':');
    const base = i !== -1 && i > m.indexOf('/') ? m.slice(0, i) : m;
    const variant = i !== -1 && i > m.indexOf('/') ? m.slice(i + 1) : undefined;
    const matches = seats.filter((seat) => {
      if (seat.model === m) {
        return true;
      }
      if (variant !== undefined && seat.model === base) {
        return (seat.variant ?? '').toLowerCase() === variant.toLowerCase();
      }
      return false;
    });
    const freeMatches = matches.filter((seat) => seat.costClass === 'free');
    if (matches.length === 0) {
      return {
        outcome: 'refused',
        reason: `reviewer model '${m}' is not a seat in the installation catalogue and policy.useFreeSeats is false; add it as a paid or plan-quota seat`,
      };
    }
    if (freeMatches.length === matches.length) {
      return {
        outcome: 'refused',
        reason: `reviewer model '${m}' is free seat '${freeMatches[0].id}' and policy.useFreeSeats is false`,
      };
    }
    if (freeMatches.length > 0) {
      return {
        outcome: 'refused',
        reason: `reviewer model '${m}' matches seats of mixed cost class (${matches.map((seat) => seat.id).join(', ')}) and policy.useFreeSeats is false; refused as ambiguous`,
      };
    }
    return { outcome: 'allowed' };
  }
}
