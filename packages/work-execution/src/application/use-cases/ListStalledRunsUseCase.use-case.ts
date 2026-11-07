/**
 * ListStalledRunsUseCase (PT1a, SN3): the runs parked for longer than
 * `policy.daemon.stallAfterMinutes`, sorted oldest first, from the same
 * `stalledRunsOf` the conductor pass raises attention from, so the status view
 * and the attention items never disagree. Read-only; total: a store failure
 * or a malformed clock is a typed refusal, never a throw.
 */

import { isCanonicalIso } from '../../domain/lane-activity-records.js';
import { stalledRunsOf } from '../../domain/stall-attention.js';
import { DEFAULT_STALL_THRESHOLDS } from '../../domain/stall-rules.js';
import type {
  ListStalledRunsPort,
  ListStalledRunsRequest,
  ListStalledRunsResult,
} from '../ports/in/ListStalledRunsPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import { journalsForRuns, type RunJournalRunReads } from './run-journal-reads.js';

export interface ListStalledRunsDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: RunJournalRunReads;
  /** `policy.daemon.stallAfterMinutes`; absent reads as the default (30). */
  readonly stallAfterMinutes?: number;
}

export class ListStalledRunsUseCase implements ListStalledRunsPort {
  constructor(private readonly deps: ListStalledRunsDependencies) {}

  async listStalledRuns(request: ListStalledRunsRequest): Promise<ListStalledRunsResult> {
    const nowIso: unknown = Object.getOwnPropertyDescriptor(request ?? {}, 'nowIso')?.value;
    if (!isCanonicalIso(nowIso)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    try {
      const records = await this.deps.runRepo.list();
      const journals = await journalsForRuns(
        this.deps.runJournal,
        records.map((record) => record.runId),
      );
      const stallAfterMinutes = this.deps.stallAfterMinutes ?? DEFAULT_STALL_THRESHOLDS.parkedMinutes;
      const stalled = stalledRunsOf({ records, journals, stallAfterMinutes, nowIso });
      return {
        outcome: 'listed',
        stallAfterMinutes,
        stalled: stalled.map((view) => ({
          runId: view.runId,
          class: view.parkClass,
          ageMinutes: view.ageMinutes,
          workOrderId: view.workOrderId,
        })),
      };
    } catch {
      return { outcome: 'refused', reason: 'unreadable' };
    }
  }
}
