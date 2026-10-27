/**
 * Build an S1 seat plan from a derived v2 installation model. Pure: the
 * caller loads and derives the installation. Seat ids are the installation's
 * seat ids; triggers map onto stop-reason classes; health is NOT copied into
 * the plan (it is read at selection time, see `unhealthySeatIdsOf`).
 */

import type { ChainStep, ChainTrigger, FleetInstallationModel, SeatModel } from '@fleet/installation';
import type { SeatPlanProps, SeatPlanSeat, StopReasonValue } from '@fleet/work-execution';

const TRIGGER_TO_STOP_REASON: Readonly<Record<ChainTrigger, StopReasonValue>> = {
  '429': 'rate-limited',
  '402': 'payment',
  timeout: 'timeout',
  quota: 'rate-limited',
  'no-commit': 'no-commit',
};

function planSeat(step: ChainStep, seat: SeatModel): SeatPlanSeat {
  const on = [...new Set((step.triggers ?? []).map((trigger) => TRIGGER_TO_STOP_REASON[trigger]))];
  return {
    id: seat.id,
    model: seat.model,
    tool: seat.tool,
    ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
    ...(seat.agent !== undefined ? { agent: seat.agent } : {}),
    ...(on.length > 0 ? { on } : {}),
  };
}

function chainSeats(
  steps: readonly ChainStep[] | undefined,
  seatsById: ReadonlyMap<string, SeatModel>,
): SeatPlanSeat[] {
  const out: SeatPlanSeat[] = [];
  for (const step of steps ?? []) {
    const seat = seatsById.get(step.seatId);
    if (seat !== undefined) {
      out.push(planSeat(step, seat));
    }
  }
  return out;
}

/** The plan, or a reason when the installation has no implementer chain. */
export function seatPlanFromInstallation(
  model: FleetInstallationModel,
): { readonly plan: SeatPlanProps } | { readonly reason: string } {
  const seatsById = new Map((model.seats ?? []).map((seat) => [seat.id, seat] as const));
  const chains = model.chains ?? {};
  const firstPass = chainSeats(chains.implementer, seatsById);
  if (firstPass.length === 0) {
    return { reason: 'The installation has no implementer chain to build a seat plan from' };
  }
  const fixSource = chains.fix !== undefined && chains.fix.length > 0 ? chains.fix : chains.implementer;
  return {
    plan: {
      version: 1,
      'first-pass': firstPass,
      fix: chainSeats(fixSource, seatsById),
      review: chainSeats(chains.reviewer, seatsById),
    },
  };
}

/** Seat ids the installation marks unhealthy, in file order. */
export function unhealthySeatIdsOf(model: FleetInstallationModel | undefined): string[] {
  return (model?.seats ?? []).filter((seat) => seat.health === 'unhealthy').map((seat) => seat.id);
}
