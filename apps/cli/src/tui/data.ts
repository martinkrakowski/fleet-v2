/**
 * The in-process data layer behind the TUI shell: it adapts the runtime's
 * read-only lane-run listing into the rows the shell frames. A source that
 * cannot be read is reported as not read — never invented rows or a fake
 * value.
 */
import type { ListLaneRunsResult } from '@fleet/work-execution';

import { scheduleText } from '../conductor.js';

export type TuiListRuns = (nowIso: string) => Promise<ListLaneRunsResult>;

export interface TuiDataSource {
  readonly listRuns: (nowIso: string) => Promise<readonly string[]>;
}

export function createTuiDataSource(listRuns: TuiListRuns): TuiDataSource {
  return {
    listRuns: async (nowIso: string) => {
      try {
        const result = await listRuns(nowIso);
        if (result.outcome === 'listed') {
          return scheduleText(result);
        }
        return [`lane runs not read: ${result.reason}`];
      } catch {
        // A source that cannot be read is reported as not read.
        return ['lane runs not read'];
      }
    },
  };
}
