/**
 * Shared helper functions for IssueMergeGrantUseCase and IssuePolicyForgeGrantUseCase:
 * unique id minting, sequential grant cancels, and live grant sweep resolution.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { PolicyGrantIdSource } from '../ports/in/IssuePolicyForgeGrantPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { cancelPolicyGrantOnce } from './policy-grant-cancel.js';

/** strict: a leftover conflict refuses the whole issue; best-effort: the sweep ignores it. */
export type CancelMode = 'strict' | 'best-effort';

export interface CancelTargetsResult {
  readonly cancelledIds: string[];
  readonly conflict: boolean;
}

export type MintGrantIdsResult =
  | { readonly requestId: string; readonly grantId: string }
  | { readonly refusal: string };

export type SweepGrantsResult =
  | {
      readonly outcome: 'superseded';
      readonly requestId: string;
      readonly grantId: string;
      readonly cancelledGrantIds: readonly string[];
      readonly unresolvedGrantIds: readonly string[];
    }
  | {
      readonly outcome: 'issued';
      readonly cancelledGrantIds: readonly string[];
    };

export async function mintUniqueGrantIds(
  ids: PolicyGrantIdSource,
  requestRepo: CoordinationRequestRepositoryPort,
  grantKind: 'merge' | 'policy',
): Promise<MintGrantIdsResult> {
  const requestId = ids.newRequestId();
  const grantId = ids.newGrantId();
  const refusal = `a minted ${grantKind} grant id is already recorded`;
  if (
    typeof requestId !== 'string' ||
    requestId.trim().length === 0 ||
    typeof grantId !== 'string' ||
    grantId.trim().length === 0
  ) {
    return { refusal };
  }
  if (
    (await requestRepo.findRequestById(requestId)) !== null ||
    (await requestRepo.findRequestByGrantId(grantId)) !== null
  ) {
    return { refusal };
  }
  return { requestId, grantId };
}

function compareRecordsByCreation(
  left: CoordinationRequestRecord,
  right: CoordinationRequestRecord,
): number {
  if (left.createdAtIso !== right.createdAtIso) {
    return left.createdAtIso < right.createdAtIso ? -1 : 1;
  }
  return left.id < right.id ? -1 : 1;
}

/** Sequential cancels over a promise chain (never `for … await`). */
export async function cancelGrantTargets(
  requestRepo: CoordinationRequestRepositoryPort,
  targets: readonly CoordinationRequestRecord[],
  now: string,
  mode: CancelMode,
): Promise<CancelTargetsResult> {
  const cancelledIds: string[] = [];
  let stopped = false;
  let conflict = false;
  await targets.reduce(
    (chain, record) =>
      chain.then(async () => {
        if (stopped) {
          return;
        }
        const outcome = await cancelPolicyGrantOnce(requestRepo, record, now);
        if (outcome === 'cancelled') {
          if (record.grantId !== null) {
            cancelledIds.push(record.grantId);
          }
        } else if (outcome === 'conflict') {
          conflict = true;
          if (mode === 'strict') {
            stopped = true;
          }
        }
      }),
    Promise.resolve(),
  );
  return { cancelledIds, conflict };
}

export async function sweepLiveGrants(params: {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly projectId: string;
  readonly requestId: string;
  readonly grantId: string;
  readonly now: string;
  readonly isLive: (record: CoordinationRequestRecord) => boolean;
  readonly cancelledEarlierIds: readonly string[];
}): Promise<SweepGrantsResult> {
  const { requestRepo, projectId, requestId, grantId, now, isLive, cancelledEarlierIds } = params;
  const live = (await requestRepo.listRequests(projectId)).filter(isLive);
  const ordered = [...live].sort(compareRecordsByCreation);
  const newest = ordered.at(-1);
  if (newest?.id !== requestId) {
    // A newer live grant exists: this issue's own grant is cancelled and the
    // newer one stays live. Superseded is a fixed outcome, never an error.
    let own: 'cancelled' | 'skipped' | 'conflict' = 'skipped';
    const mine = await requestRepo.findRequestById(requestId);
    if (mine !== null && isLive(mine)) {
      own = await cancelPolicyGrantOnce(requestRepo, mine, now);
    }
    // Report only what happened: a confirmed cancel, nothing to cancel, or a cancel that may
    // have left this grant live beside the newer one.
    return {
      outcome: 'superseded',
      requestId,
      grantId,
      cancelledGrantIds: own === 'cancelled' ? [grantId] : [],
      unresolvedGrantIds: own === 'conflict' ? [grantId] : [],
    };
  }
  const cancelledSwept = await cancelGrantTargets(requestRepo, ordered.slice(0, -1), now, 'best-effort');

  const cancelledGrantIds = [
    ...cancelledEarlierIds,
    ...cancelledSwept.cancelledIds,
  ].sort((left, right) => left.localeCompare(right));

  return {
    outcome: 'issued',
    cancelledGrantIds,
  };
}
