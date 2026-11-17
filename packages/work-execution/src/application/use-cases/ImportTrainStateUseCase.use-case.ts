// Lane CO5: import of the legacy shell merge-train queue state.
import type { LegacyTrainQueueEntry, LegacyTrainQueueLine } from '../../domain/legacy-train-queue.js';
import { parseLegacyTrainQueue } from '../../domain/legacy-train-queue.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { isMergeQueueEntryLive } from '../../domain/merge-queue-records.js';
import type {
  ImportTrainStateKey,
  ImportTrainStatePort,
  ImportTrainStateRefusal,
  ImportTrainStateReport,
  ImportTrainStateRequest,
  ImportTrainStateResult,
} from '../ports/in/ImportTrainStatePort.in-port.js';
import { IMPORT_KEYS_MAX } from '../ports/in/ImportTrainStatePort.in-port.js';
import type { LegacyTrainStateRead, LegacyTrainStateReadPort } from '../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** The three legacy sources this unit imports from, in dedup-priority order. */
const SOURCES = ['queue', 'inprogress', 'parked'] as const;
type Source = (typeof SOURCES)[number];

export interface ImportTrainStateDependencies {
  readonly legacyState: LegacyTrainStateReadPort;
  readonly queue: MergeQueueRepositoryPort;
  readonly mintUlid: () => string;
  readonly nowIso: () => string;
}

/** The parsed, per-source lines once every source is confirmed readable. */
type ParseLegacyStateResult =
  | { readonly ok: false; readonly refusal: ImportTrainStateRefusal }
  | {
      readonly ok: true;
      readonly parsedBySource: Readonly<Record<Source, readonly LegacyTrainQueueLine[]>>;
      readonly unknownBySource: Record<Source, number[]>;
      readonly parkedLines: number;
      readonly chainFiles: number;
      readonly batchLines: number;
      readonly inprogressLines: number;
    };

/** One deduped (pullRequest, headOid) pair and the source whose entry it keeps. */
interface DedupedEntry {
  readonly source: Source;
  readonly entry: LegacyTrainQueueEntry;
}

/** The outcome of classifying every deduped entry into a disposition. */
interface ClassifiedEntries {
  readonly candidates: LegacyTrainQueueEntry[];
  readonly allKeys: ImportTrainStateKey[];
  readonly alreadyQueued: number;
  readonly notImportableBase: number;
}

const pairKey = (entry: LegacyTrainQueueEntry): string => `${entry.pullRequest}:${entry.headOid}`;

/** Import the shell merge train's queue and report the parked and chain state. */
export class ImportTrainStateUseCase implements ImportTrainStatePort {
  constructor(private readonly deps: ImportTrainStateDependencies) {}

  async importTrainState(request: ImportTrainStateRequest): Promise<ImportTrainStateResult> {
    const requestRefusal = this.validateRequest(request);
    if (requestRefusal !== null) {
      return { outcome: 'refused', reason: requestRefusal };
    }

    const state = await this.deps.legacyState.readLegacyTrainState({ stateDir: request.stateDir });
    const parsed = this.parseLegacyState(state);
    if (!parsed.ok) {
      return { outcome: 'refused', reason: parsed.refusal };
    }

    const deadlineIso = new Date(Date.parse(this.deps.nowIso()) + 60_000).toISOString();
    const liveEntries = (
      await this.deps.queue.listMergeEntries({ repository: request.repository, deadlineIso })
    ).filter(isMergeQueueEntryLive);

    const classified = this.classifyEntries(parsed.parsedBySource, liveEntries, request.repository);
    const report = this.buildReport(parsed, classified);

    if (!request.apply) {
      return { outcome: 'dry-run', wouldImport: classified.candidates.length, ...report };
    }

    const { imported, refused, appliedDuplicates } = await this.applyCandidates(
      classified.candidates,
      request,
      deadlineIso,
    );
    return {
      outcome: 'applied',
      imported,
      refused,
      ...report,
      alreadyQueued: classified.alreadyQueued + appliedDuplicates,
    };
  }

  private validateRequest(request: ImportTrainStateRequest): ImportTrainStateRefusal | null {
    if (!this.isValidRepository(request.repository)) {
      return 'invalid-repository';
    }
    if (request.stateDir.trim() === '') {
      return 'invalid-state-dir';
    }
    if (
      request.apply &&
      (typeof request.authority !== 'string' || request.authority.trim() === '')
    ) {
      return 'authority-required';
    }
    return null;
  }

  /**
   * Confirms every legacy source is readable (the in-progress file included:
   * undefined or `unreadable` refuses, since a consumer must never treat
   * missing in-progress evidence as empty), then parses each of the three
   * sources with the same strict parser. A secret-shaped line in any of
   * them refuses the import wholesale.
   */
  private parseLegacyState(state: LegacyTrainStateRead): ParseLegacyStateResult {
    if (
      state.queue.status === 'unreadable' ||
      state.parked.status === 'unreadable' ||
      state.chains.status === 'unreadable' ||
      state.batch.status === 'unreadable' ||
      state.inprogress === undefined ||
      state.inprogress.status === 'unreadable'
    ) {
      return { ok: false, refusal: 'legacy-unreadable' };
    }

    const sourceLines: Readonly<Record<Source, readonly string[]>> = {
      queue: state.queue.status === 'read' ? state.queue.lines : [],
      inprogress: state.inprogress.status === 'read' ? state.inprogress.lines : [],
      parked: state.parked.status === 'read' ? state.parked.lines : [],
    };

    const parsedBySource: Partial<Record<Source, readonly LegacyTrainQueueLine[]>> = {};
    for (const source of SOURCES) {
      const parsed = parseLegacyTrainQueue(sourceLines[source].join('\n'));
      if (!parsed.ok) {
        return {
          ok: false,
          refusal: parsed.reason === 'secret-shaped' ? 'secret-shaped' : 'legacy-unreadable',
        };
      }
      parsedBySource[source] = parsed.lines;
    }

    const unknownBySource: Record<Source, number[]> = { queue: [], inprogress: [], parked: [] };
    for (const source of SOURCES) {
      for (const line of parsedBySource[source]!) {
        if (!line.ok) {
          unknownBySource[source].push(line.line);
        }
      }
    }

    return {
      ok: true,
      parsedBySource: parsedBySource as Record<Source, readonly LegacyTrainQueueLine[]>,
      unknownBySource,
      parkedLines: state.parked.status === 'read' ? state.parked.lines.length : 0,
      chainFiles: state.chains.status === 'read' ? state.chains.chains.length : 0,
      batchLines: state.batch.status === 'read' ? state.batch.lines.length : 0,
      inprogressLines: state.inprogress.status === 'read' ? state.inprogress.lines.length : 0,
    };
  }

  /**
   * Dedupes by the pair (pullRequest, headOid) across all three sources, in
   * source order queue, then inprogress, then parked: the first source in
   * that order wins and is recorded as the key's source. The base is NOT
   * part of the identity: the same PR/head seen on two different bases
   * across sources still yields exactly one key, so that one logical PR is
   * never reported as two distinct, non-duplicate import candidates.
   */
  private dedupeBySource(parsedBySource: Readonly<Record<Source, readonly LegacyTrainQueueLine[]>>): DedupedEntry[] {
    const seenPairs = new Set<string>();
    const deduped: DedupedEntry[] = [];
    for (const source of SOURCES) {
      for (const line of parsedBySource[source]) {
        if (!line.ok) {
          continue;
        }
        const pair = pairKey(line.entry);
        if (seenPairs.has(pair)) {
          continue;
        }
        seenPairs.add(pair);
        deduped.push({ source, entry: line.entry });
      }
    }
    return deduped;
  }

  /**
   * Classifies every deduped entry into a disposition. A non-`main` base
   * yields `not-importable-base`; an entry already live in the fleet queue
   * yields `already-queued`. Otherwise, if the entry's PULL REQUEST NUMBER —
   * not the full (pullRequest, headOid) pair — appears anywhere in the
   * `inprogress` source, the legacy shell train is actively merging that PR
   * right now: the real shell (tick.sh) MOVES a line from `queue` to
   * `inprogress` when a pass starts, appending it to the in-progress file
   * and omitting it from the rewritten queue, so a PR the shell is actively
   * merging normally appears in `inprogress` ALONE, never duplicated into
   * both files (queue+inprogress together is only a rare crash-leftover
   * artifact, per the shell's own comment). The real shell's own hazard
   * check is PR-number-scoped too (`grep -q "^$pr " "$INPROG"` in
   * tick.sh's queue rewrite): `enqueue.sh` only refuses a second QUEUE line
   * for a PR number already in the queue file, never checks `inprogress`,
   * so it can append a fresh queue line for a PR number whose older head is
   * still in progress — same PR, two different heads, two different pair
   * keys. Keying this hazard by the full pair would miss that case, so any
   * key sharing its PR number with an `inprogress` entry is
   * `legacy-in-progress`, never an ordinary `would-import` candidate, and
   * it is never pushed to `candidates` — so `apply: true` can never enqueue
   * a PR the legacy train is actively merging, whatever head is on the
   * fleet-side entry. The (pullRequest, headOid) pair stays the identity
   * for everything else here (dedup, `already-queued`); only this hazard
   * check is scoped to the PR number alone.
   */
  private classifyEntries(
    parsedBySource: Readonly<Record<Source, readonly LegacyTrainQueueLine[]>>,
    liveEntries: readonly MergeQueueEntryRecord[],
    repository: ImportTrainStateRequest['repository'],
  ): ClassifiedEntries {
    const inProgressPullRequests = new Set<number>();
    for (const line of parsedBySource.inprogress) {
      if (line.ok) {
        inProgressPullRequests.add(line.entry.pullRequest);
      }
    }

    let notImportableBase = 0;
    let alreadyQueued = 0;
    const candidates: LegacyTrainQueueEntry[] = [];
    const allKeys: ImportTrainStateKey[] = [];
    for (const { source, entry } of this.dedupeBySource(parsedBySource)) {
      let disposition: ImportTrainStateKey['disposition'];
      if (entry.base !== 'main') {
        disposition = 'not-importable-base';
        notImportableBase += 1;
      } else if (this.isAlreadyLive(entry, liveEntries, repository)) {
        disposition = 'already-queued';
        alreadyQueued += 1;
      } else if (inProgressPullRequests.has(entry.pullRequest)) {
        disposition = 'legacy-in-progress';
      } else {
        disposition = 'would-import';
        candidates.push(entry);
      }
      allKeys.push({ pullRequest: entry.pullRequest, headOid: entry.headOid, base: entry.base, source, disposition });
    }
    return { candidates, allKeys, alreadyQueued, notImportableBase };
  }

  private isAlreadyLive(
    entry: LegacyTrainQueueEntry,
    liveEntries: readonly MergeQueueEntryRecord[],
    repository: ImportTrainStateRequest['repository'],
  ): boolean {
    return liveEntries.some(
      (record) =>
        record.repository.owner === repository.owner &&
        record.repository.repo === repository.repo &&
        record.pullRequest === entry.pullRequest &&
        record.headOid === entry.headOid,
    );
  }

  private buildReport(
    parsed: {
      readonly unknownBySource: Record<Source, number[]>;
      readonly parkedLines: number;
      readonly chainFiles: number;
      readonly batchLines: number;
      readonly inprogressLines: number;
    },
    classified: ClassifiedEntries,
  ): ImportTrainStateReport {
    const keys = classified.allKeys.slice(0, IMPORT_KEYS_MAX);
    const keysTruncated = classified.allKeys.length > IMPORT_KEYS_MAX;
    return {
      unknownLineNumbers: parsed.unknownBySource.queue,
      notImportableBase: classified.notImportableBase,
      alreadyQueued: classified.alreadyQueued,
      parkedLines: parsed.parkedLines,
      chainFiles: parsed.chainFiles,
      batchLines: parsed.batchLines,
      inprogressLines: parsed.inprogressLines,
      unknownBySource: parsed.unknownBySource,
      keys,
      keysTruncated,
    };
  }

  /** Enqueues every would-import candidate; a decision's outcome sorts into imported, refused or an applied duplicate. */
  private async applyCandidates(
    candidates: readonly LegacyTrainQueueEntry[],
    request: ImportTrainStateRequest,
    deadlineIso: string,
  ): Promise<{ readonly imported: number; readonly refused: number; readonly appliedDuplicates: number }> {
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
    return { imported, refused, appliedDuplicates };
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
