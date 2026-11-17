// Lane CO5: import of the legacy shell merge-train queue state.
import type { LegacyTrainQueueEntry } from '../../domain/legacy-train-queue.js';
import { parseLegacyTrainQueue } from '../../domain/legacy-train-queue.js';
import { isMergeQueueEntryLive } from '../../domain/merge-queue-records.js';
import type {
  ImportTrainStateKey,
  ImportTrainStatePort,
  ImportTrainStateReport,
  ImportTrainStateRequest,
  ImportTrainStateResult,
} from '../ports/in/ImportTrainStatePort.in-port.js';
import { IMPORT_KEYS_MAX } from '../ports/in/ImportTrainStatePort.in-port.js';
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
      state.batch.status === 'unreadable' ||
      state.inprogress === undefined ||
      state.inprogress.status === 'unreadable'
    ) {
      return { outcome: 'refused', reason: 'legacy-unreadable' };
    }

    const sourceLines: Readonly<Record<'queue' | 'inprogress' | 'parked', readonly string[]>> = {
      queue: state.queue.status === 'read' ? state.queue.lines : [],
      inprogress: state.inprogress.status === 'read' ? state.inprogress.lines : [],
      parked: state.parked.status === 'read' ? state.parked.lines : [],
    };

    // Each source is parsed with the same strict parser; a secret-shaped line
    // in any of the three refuses the import wholesale.
    const parsedBySource = {
      queue: parseLegacyTrainQueue(sourceLines.queue.join('\n')),
      inprogress: parseLegacyTrainQueue(sourceLines.inprogress.join('\n')),
      parked: parseLegacyTrainQueue(sourceLines.parked.join('\n')),
    } as const;
    for (const parsed of Object.values(parsedBySource)) {
      if (!parsed.ok) {
        return {
          outcome: 'refused',
          reason: parsed.reason === 'secret-shaped' ? 'secret-shaped' : 'legacy-unreadable',
        };
      }
    }

    const deadlineIso = new Date(Date.parse(this.deps.nowIso()) + 60_000).toISOString();
    const liveEntries = (await this.deps.queue.listMergeEntries({ repository: request.repository, deadlineIso })).filter(
      isMergeQueueEntryLive,
    );

    const sources = ['queue', 'inprogress', 'parked'] as const;
    const unknownBySource: Record<(typeof sources)[number], number[]> = { queue: [], inprogress: [], parked: [] };
    for (const source of sources) {
      const parsed = parsedBySource[source];
      if (!parsed.ok) {
        continue;
      }
      for (const line of parsed.lines) {
        if (!line.ok) {
          unknownBySource[source].push(line.line);
        }
      }
    }

    // Dedupe by the (pullRequest, headOid, base) triple across all three
    // sources, in source order queue, then inprogress, then parked: the first
    // source in that order wins and is recorded as the key's source. The base
    // is part of the identity so that the same PR/head on a different base is
    // never silently dropped because an earlier source held it on another base.
    const seenPairs = new Set<string>();
    const deduped: { readonly source: (typeof sources)[number]; readonly entry: LegacyTrainQueueEntry }[] = [];
    for (const source of sources) {
      const parsed = parsedBySource[source];
      if (!parsed.ok) {
        continue;
      }
      for (const line of parsed.lines) {
        if (!line.ok) {
          continue;
        }
        const entry = line.entry;
        const pair = `${entry.pullRequest}:${entry.headOid}:${entry.base}`;
        if (seenPairs.has(pair)) {
          continue;
        }
        seenPairs.add(pair);
        deduped.push({ source, entry });
      }
    }

    let notImportableBase = 0;
    let alreadyQueued = 0;
    const candidates: LegacyTrainQueueEntry[] = [];
    const allKeys: ImportTrainStateKey[] = [];
    for (const { source, entry } of deduped) {
      let disposition: ImportTrainStateKey['disposition'];
      if (entry.base !== 'main') {
        disposition = 'not-importable-base';
        notImportableBase += 1;
      } else if (source === 'inprogress') {
        // The legacy train is already merging this PR; enqueueing it would let
        // both trains act on it. It is reported, never an import candidate.
        disposition = 'in-progress';
      } else {
        const alreadyLive = liveEntries.some(
          (record) =>
            record.repository.owner === request.repository.owner &&
            record.repository.repo === request.repository.repo &&
            record.pullRequest === entry.pullRequest &&
            record.headOid === entry.headOid,
        );
        if (alreadyLive) {
          disposition = 'already-queued';
          alreadyQueued += 1;
        } else {
          disposition = 'would-import';
          candidates.push(entry);
        }
      }
      allKeys.push({
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
        base: entry.base,
        source,
        disposition,
      });
    }
    const keys = allKeys.slice(0, IMPORT_KEYS_MAX);
    const keysTruncated = allKeys.length > IMPORT_KEYS_MAX;

    const report: ImportTrainStateReport = {
      unknownLineNumbers: unknownBySource.queue,
      notImportableBase,
      alreadyQueued,
      parkedLines: state.parked.status === 'read' ? state.parked.lines.length : 0,
      chainFiles: state.chains.status === 'read' ? state.chains.chains.length : 0,
      batchLines: state.batch.status === 'read' ? state.batch.lines.length : 0,
      inprogressLines: state.inprogress.status === 'read' ? state.inprogress.lines.length : 0,
      unknownBySource,
      keys,
      keysTruncated,
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
