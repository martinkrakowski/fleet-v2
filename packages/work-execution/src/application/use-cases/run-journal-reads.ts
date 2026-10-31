/**
 * Shared helper for scans that read several runs' journals (EX-3a): one grouped
 * read when the port offers `listForRuns`, otherwise the per-run `listForRun`
 * calls the older fakes implement. The returned map has every requested run id
 * as a key, each with that run's entries in append order (`[]` when none).
 */
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';

export type RunJournalRunReads = Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;

/** The entries of several runs' journals from as few store reads as the port offers. */
export async function journalsForRuns(
  runJournal: RunJournalRunReads,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>> {
  const { listForRuns } = runJournal;
  if (listForRuns) {
    return listForRuns.call(runJournal, runIds);
  }
  const lists = await Promise.all(runIds.map((runId) => runJournal.listForRun(runId)));
  return new Map(runIds.map((runId, index) => [runId, lists[index] ?? []]));
}
