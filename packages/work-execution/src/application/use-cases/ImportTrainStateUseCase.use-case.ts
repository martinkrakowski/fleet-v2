// Lane CO5: import of the legacy shell merge-train queue state.
import type { LegacyTrainQueueEntry } from '../../domain/legacy-train-queue.js';
import { parseLegacyTrainQueue } from '../../domain/legacy-train-queue.js';
import { isMergeQueueEntryLive } from '../../domain/merge-queue-records.js';
import type {
  ImportTrainStatePort,
  ImportTrainStateReport,
  ImportTrainStateRequest,
  ImportTrainStateResult,
} from '../ports/in/ImportTrainStatePort.in-port.js';
import type { LegacyTrainStateReadPort } from '../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export interface ImportTrainStateDependencies {
  readonly legacyState: LegacyTrainStateReadPort;
  readonly queue: MergeQueueRepositoryPort;
  readonly mintUlid: () => string;
  readonly nowIso: () => string;
}

/** Import the shell merge train's queue and report the parked and chain state. */
export class ImportTrainStateUseCase implements ImportTrainStatePort {
  constructor(private readonly deps: ImportTrainStateDependencies) {}

  async importTrainState(request: ImportTrainStateRequest): Promise<ImportTrainStateResult> {
    if (!this.isValidRepository(request.repository)) {
      return { outcome: 'refused', reason: 'invalid-repository' };
    }
    if (request.stateDir.trim() === '') {
      return { outcome: 'refused', reason: 'invalid-state-dir' };
    }
    if (
      request.apply &&
      (typeof request.authority !== 'string' || request.authority.trim() === '')
    ) {
      return { outcome: 'refused', reason: 'authority-required' };
    }

    const state = await this.deps.legacyState.readLegacyTrainState({ stateDir: request.stateDir });
    if (
      state.queue.status === 'unreadable' ||
      state.parked.status === 'unreadable' ||
      state.chains.status === 'unreadable' ||
      state.batch.status === 'unreadable'
    ) {
      return { outcome: 'refused', reason: 'legacy-unreadable' };
    }

    const queueLines = state.queue.status === 'read' ? state.queue.lines : [];
    const parsed = parseLegacyTrainQueue(queueLines.join('\n'));
    if (!parsed.ok) {
      return {
        outcome: 'refused',
        reason: parsed.reason === 'secret-shaped' ? 'secret-shaped' : 'legacy-unreadable',
      };
    }

    const deadlineIso = new Date(Date.parse(this.deps.nowIso()) + 60_000).toISOString();
    const liveEntries = (await this.deps.queue.listMergeEntries({ repository: request.repository, deadlineIso })).filter(
      isMergeQueueEntryLive,
    );

    const unknownLineNumbers: number[] = [];
    let notImportableBase = 0;
    let alreadyQueued = 0;
    const candidates: LegacyTrainQueueEntry[] = [];

    for (const line of parsed.lines) {
      if (!line.ok) {
        unknownLineNumbers.push(line.line);
        continue;
      }
      const entry = line.entry;
      if (entry.base !== 'main') {
        notImportableBase += 1;
        continue;
      }
      const alreadyLive = liveEntries.some(
        (record) =>
          record.repository.owner === request.repository.owner &&
          record.repository.repo === request.repository.repo &&
          record.pullRequest === entry.pullRequest &&
          record.headOid === entry.headOid,
      );
      if (alreadyLive) {
        alreadyQueued += 1;
      } else {
        candidates.push(entry);
      }
    }

    const report: ImportTrainStateReport = {
      unknownLineNumbers,
      notImportableBase,
      alreadyQueued,
      parkedLines: state.parked.status === 'read' ? state.parked.lines.length : 0,
      chainFiles: state.chains.status === 'read' ? state.chains.chains.length : 0,
      batchLines: state.batch.status === 'read' ? state.batch.lines.length : 0,
    };

    if (!request.apply) {
      return { outcome: 'dry-run', wouldImport: candidates.length, ...report };
    }

    let imported = 0;
    let refused = 0;
    let appliedDuplicates = 0;
    for (const entry of candidates) {
      const decision = await this.deps.queue.enqueueMergeEntry({
        repository: request.repository,
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
        tier: 2,
        enqueuedBy: 'cli',
        runId: null,
        entryId: this.deps.mintUlid(),
        successorEntryId: this.deps.mintUlid(),
        enqueuedAtIso: this.deps.nowIso(),
        deadlineIso,
      });
      if (decision.outcome === 'created' || decision.outcome === 'supersedes') {
        imported += 1;
      } else if (decision.outcome === 'duplicate') {
        appliedDuplicates += 1;
      } else {
        refused += 1;
      }
    }
    return { outcome: 'applied', imported, refused, ...report, alreadyQueued: alreadyQueued + appliedDuplicates };
  }

  private isValidRepository(repository: ImportTrainStateRequest['repository']): boolean {
    const { owner, repo } = repository;
    if (
      !REPOSITORY_SEGMENT_PATTERN.test(owner) ||
      !REPOSITORY_SEGMENT_PATTERN.test(repo) ||
      owner === '.' ||
      owner === '..' ||
      repo === '.' ||
      repo === '..'
    ) {
      return false;
    }
    return true;
  }
}
