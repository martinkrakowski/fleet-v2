/**
 * The `cutover` command group of the CLI driver (lane CO32). Reads only: the
 * `shadow report` subcommand compares the fleet-v2 merge queue against the
 * shell train's recorded queue for one repository and prints one JSON document
 * of ids and codes. It writes nothing and grants nothing.
 */

import { firstPositional, str, CliUsageError, type Payload } from './payload.js';
import type { CommandHandler } from './payload.js';
import {
  compareShadowEnqueueSets,
  parseLegacyTrainQueue,
  type LegacyTrainQueueLine,
} from '@fleet/work-execution';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Parse `--repository owner/repo`; usage error when absent or malformed. */
function repositoryFromPayload(p: Payload): { owner: string; repo: string } {
  const raw = str(p, 'repository').trim();
  const segments = raw.split('/');
  if (
    raw === '' ||
    segments.length !== 2 ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[0]) ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[1]) ||
    segments[0] === '.' ||
    segments[0] === '..' ||
    segments[1] === '.' ||
    segments[1] === '..'
  ) {
    throw new CliUsageError('cutover shadow report requires --repository as owner/repo');
  }
  return { owner: segments[0], repo: segments[1] };
}

export const cutoverCommands: Readonly<Record<string, CommandHandler>> = {
  shadow: async (payload, runtime) => {
    const sub = firstPositional(payload);
    if (sub !== 'report') {
      throw new CliUsageError('cutover shadow requires the report subcommand: fleet-v2 cutover shadow report');
    }
    const repository = repositoryFromPayload(payload);
    const stateDir = str(payload, 'legacyStateDir').trim();
    if (stateDir === '') {
      throw new CliUsageError('cutover shadow report requires --legacy-state-dir');
    }

    const shellState = await runtime.execution.legacyTrainState.readLegacyTrainState({ stateDir });
    if (shellState.queue.status === 'absent') {
      return { outcome: 'refused', reason: 'shell-queue-absent', kind: 'enqueue-set' };
    }
    if (shellState.queue.status === 'unreadable') {
      return { outcome: 'refused', reason: 'shell-queue-unreadable', kind: 'enqueue-set' };
    }

    const parsed = parseLegacyTrainQueue(shellState.queue.lines.join('\n'));
    if (!parsed.ok) {
      return {
        outcome: 'refused',
        reason: parsed.reason === 'secret-shaped' ? 'secret-shaped' : 'shell-queue-unreadable',
        kind: 'enqueue-set',
      };
    }

    const understood = parsed.lines.filter(
      (line): line is Extract<LegacyTrainQueueLine, { ok: true }> => line.ok,
    );
    const unknownLines = parsed.lines.filter((line) => !line.ok).map((line) => line.line);

    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    const view = await runtime.execution.listMergeQueue.list({ repository, deadlineIso });
    const fleet = view.entries.map((entry) => ({
      pullRequest: entry.pullRequest,
      headOid: entry.headOid,
      base: 'main',
    }));
    const shell = understood.map((line) => ({
      pullRequest: line.entry.pullRequest,
      headOid: line.entry.headOid,
      base: line.entry.base,
    }));
    const result = compareShadowEnqueueSets({ fleet, shell });

    return {
      outcome: 'completed',
      kind: 'enqueue-set',
      fleetBase: 'main',
      equal: result.equal,
      complete: unknownLines.length === 0,
      compared: result.compared,
      fleetCount: result.fleetCount,
      shellCount: result.shellCount,
      truncated: result.truncated,
      divergences: result.divergences,
      shell: {
        queue: 'read',
        unknownLines,
        parkedLines: shellState.parked.status === 'read' ? shellState.parked.lines.length : 0,
        chainFiles: shellState.chains.status === 'read' ? shellState.chains.chains.length : 0,
        batchLines: shellState.batch.status === 'read' ? shellState.batch.lines.length : 0,
      },
    };
  },
};
