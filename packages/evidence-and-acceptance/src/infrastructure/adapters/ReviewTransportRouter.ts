/**
 * Review transport router: picks the installation's reviewer seat for the
 * requested reviewer model and dispatches to the transport for that seat's
 * tool.
 *
 * A seat is chosen only from the reviewer and high-risk-reviewer chains, and
 * only by an exact model match. `--agent reviewer` is the default from
 * `docs/planning/2026-10-15_cutover-completion.md` station 5. Independence
 * (a different model family from the implementer) is enforced before the
 * router by `IndependentReviewAdapter` and `RequestIndependentReviewUseCase`.
 */

import type { RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import { createOcmReviewTransport } from './OcmReviewTransport.adapter.js';
import type { OcmReviewTransportSpawn } from './OcmReviewTransport.adapter.js';

export interface ReviewTransportSeat {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly roles: readonly string[];
}

export interface ReviewTransportChainStep {
  readonly seatId: string;
}

export interface ReviewTransportChains {
  readonly reviewer?: readonly ReviewTransportChainStep[];
  readonly 'high-risk-reviewer'?: readonly ReviewTransportChainStep[];
}

/** How an opencode review reaches the server that can see the attempt's worktree. */
export type ReviewRunnerRoute =
  | { readonly kind: 'installation'; readonly remotePort: number; readonly remoteHost: string; readonly authFile?: string }
  | { readonly kind: 'legacy'; readonly remotePort?: number; readonly remoteHost?: string }
  | { readonly kind: 'none'; readonly reason: string };

/** Where the attempt under review lives, and read-only git reads through its recorded host. */
export interface ReviewLocation {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly route: ReviewRunnerRoute;
  readHead(): Promise<string | null>;
  readStatus(): Promise<string | null>;
  readDiff(fromSha: string, toSha: string): Promise<string | null>;
}

export function reviewerChainSeatIds(chains?: ReviewTransportChains): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const reviewerChain = chains?.reviewer;
  if (reviewerChain !== undefined) {
    for (const step of reviewerChain) {
      if (!seen.has(step.seatId)) {
        seen.add(step.seatId);
        ids.push(step.seatId);
      }
    }
  }

  const highRiskChain = chains?.['high-risk-reviewer'];
  if (highRiskChain !== undefined) {
    for (const step of highRiskChain) {
      if (!seen.has(step.seatId)) {
        seen.add(step.seatId);
        ids.push(step.seatId);
      }
    }
  }

  return ids;
}

export function hasReviewerSeat(
  seats?: readonly ReviewTransportSeat[],
  chains?: ReviewTransportChains,
): boolean {
  if (seats === undefined) {
    return false;
  }
  const seatIds = new Set(seats.map((seat) => seat.id));
  for (const id of reviewerChainSeatIds(chains)) {
    if (seatIds.has(id)) {
      return true;
    }
  }
  return false;
}

export function selectReviewerSeat(
  seats: readonly ReviewTransportSeat[],
  chains: ReviewTransportChains | undefined,
  reviewerModel: string,
): { ok: true; seat: ReviewTransportSeat } | { ok: false; reason: string } {
  const model = reviewerModel.trim();
  const candidates: ReviewTransportSeat[] = [];
  for (const id of reviewerChainSeatIds(chains)) {
    const seat = seats.find((candidate) => candidate.id === id);
    if (seat !== undefined && seat.model === model) {
      candidates.push(seat);
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: `No reviewer seat in the installation serves model '${model}'` };
  }

  if (candidates.length > 1) {
    const ids = candidates.map((seat) => seat.id).join(', ');
    return {
      ok: false,
      reason: `Reviewer model '${model}' matches several reviewer seats (${ids}); refused as ambiguous`,
    };
  }

  const seat = candidates[0];
  if (seat.roles.includes('implementer')) {
    return { ok: false, reason: `Reviewer seat '${seat.id}' also holds the implementer role` };
  }

  return { ok: true, seat };
}

export interface ReviewTransportRouterOptions {
  readonly seats: readonly ReviewTransportSeat[];
  readonly chains?: ReviewTransportChains;
  /** Resolve the attempt's location; throws with a reason when it cannot. */
  readonly locate: (attemptId: string) => Promise<ReviewLocation>;
  /** Path of the ocm-run binary the opencode transport runs. */
  readonly ocmRunBin: string;
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly ocmSpawn?: OcmReviewTransportSpawn;
  readonly makeNonce?: () => string;
}

export const DEFAULT_REVIEW_AGENT = 'reviewer';

export function createReviewTransportRouter(
  options: ReviewTransportRouterOptions,
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  return async (request: RunIndependentReviewRequest): Promise<IndependentReviewTransportResult> => {
    const selected = selectReviewerSeat(options.seats, options.chains, request.reviewerModel);
    if (!selected.ok) {
      throw new Error(selected.reason);
    }

    const seat = selected.seat;
    const location = await options.locate(request.attemptId);

    switch (seat.tool) {
      case 'opencode':
        return runOpencode(options, seat, location, request);
      default:
        throw new Error(
          `Reviewer seat '${seat.id}' uses tool '${seat.tool}', which has no review transport`,
        );
    }
  };
}

function runOpencode(
  options: ReviewTransportRouterOptions,
  seat: ReviewTransportSeat,
  location: ReviewLocation,
  request: RunIndependentReviewRequest,
): Promise<IndependentReviewTransportResult> {
  const route = location.route;
  if (route.kind === 'none') {
    throw new Error(route.reason);
  }

  let remotePort: number;
  if (route.kind === 'legacy') {
    if (typeof route.remotePort !== 'number') {
      throw new Error(`No runner port is configured for the review of attempt ${request.attemptId}`);
    }
    remotePort = route.remotePort;
  } else {
    remotePort = route.remotePort;
  }

  const transport = createOcmReviewTransport({
    ocmRunBin: options.ocmRunBin,
    remotePort,
    ...(route.remoteHost !== undefined ? { remoteHost: route.remoteHost } : {}),
    hostMode: route.kind,
    ...(route.kind === 'installation' && route.authFile !== undefined
      ? { authFile: route.authFile }
      : {}),
    agent: seat.agent ?? DEFAULT_REVIEW_AGENT,
    model: seat.model,
    ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
    resolveReviewDir: () => location.worktreePath,
    readHead: () => location.readHead(),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.ocmSpawn !== undefined ? { spawn: options.ocmSpawn } : {}),
    ...(options.makeNonce !== undefined ? { makeNonce: options.makeNonce } : {}),
  });

  return transport(request);
}
