/**
 * The `cutover` command group of the CLI driver. `status` and `rollback` (lane
 * CO30a) read and move the cutover record through `ManageCutoverUseCase`;
 * `switch` and `retire` are not mounted until CO30b. The rest of this note is
 * lane CO32: reads only: the `shadow report` subcommand compares the fleet-v2 merge queue against the
 * shell train's recorded queue for one repository and prints one JSON document
 * of ids and codes. It writes nothing and grants nothing.
 *
 * The fleet merge queue keeps a `parked` entry live, so the shell side must be
 * counted the same way: a shell parked PR is absent from the shell queue file
 * but present in the shell parked list, so the parked list's `pr sha base`
 * lines are parsed with the same queue parser and merged into the shell set.
 * A parked list that is unreadable or secret-shaped refuses the report —
 * comparing without it would silently mis-report parked PRs.
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

/** Usage error for a flag or positional the subcommand does not take; the value is never echoed. */
function rejectUnexpectedInput(p: Payload, subcommand: string, allowed: readonly string[]): void {
  for (const key of Object.keys(p)) {
    if (key === 'positional') {
      if (Array.isArray(p[key]) && p[key].length > 0) {
        throw new CliUsageError(`cutover ${subcommand} takes no positional arguments`);
      }
    } else if (!allowed.includes(key)) {
      throw new CliUsageError(`cutover ${subcommand} does not accept an unknown flag`);
    }
  }
}

/** An optional string flag; a flag given without a value is a usage error. */
function optionalIsoFlag(p: Payload, key: string, flag: string): string | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliUsageError(`--${flag} requires a value`);
  }
  return value;
}

function expectedRevisionFlag(p: Payload): number {
  const value = p['expectedRevision'];
  const revision =
    typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new CliUsageError('cutover rollback requires --expected-revision as a positive integer');
  }
  return revision;
}

export const cutoverCommands: Readonly<Record<string, CommandHandler>> = {
  status: async (payload, runtime) => {
    rejectUnexpectedInput(payload, 'status', ['nowIso', 'deadlineIso']);
    const nowIso = optionalIsoFlag(payload, 'nowIso', 'now-iso');
    const deadlineIso = optionalIsoFlag(payload, 'deadlineIso', 'deadline-iso');
    return runtime.execution.manageCutover.execute({
      move: 'status',
      ...(nowIso === undefined ? {} : { nowIso }),
      ...(deadlineIso === undefined ? {} : { deadlineIso }),
    });
  },

  rollback: async (payload, runtime) => {
    rejectUnexpectedInput(payload, 'rollback', ['expectedRevision', 'operationId', 'nowIso', 'deadlineIso']);
    const expectedRevision = expectedRevisionFlag(payload);
    const operationId = payload['operationId'];
    if (typeof operationId !== 'string' || operationId.trim() === '') {
      throw new CliUsageError('cutover rollback requires --operation-id');
    }
    const nowIso = optionalIsoFlag(payload, 'nowIso', 'now-iso') ?? runtime.daemon.now();
    const deadlineIso = optionalIsoFlag(payload, 'deadlineIso', 'deadline-iso');
    return runtime.execution.manageCutover.execute({
      move: 'rollback',
      expectedRevision,
      operationId,
      nowIso,
      ...(deadlineIso === undefined ? {} : { deadlineIso }),
    });
  },

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

    // The shell queue excludes the PRs it parked, while the fleet queue keeps
    // `parked` entries live. Merge the shell parked list in so both sides
    // count the same PRs. Refuse when the parked list cannot be understood.
    const parked = shellState.parked;
    if (parked.status === 'unreadable') {
      return { outcome: 'refused', reason: 'shell-queue-unreadable', kind: 'enqueue-set' };
    }
    let parkedLines: readonly LegacyTrainQueueLine[] = [];
    if (parked.status === 'read') {
      const parsedParked = parseLegacyTrainQueue(parked.lines.join('\n'));
      if (!parsedParked.ok) {
        return {
          outcome: 'refused',
          reason: parsedParked.reason === 'secret-shaped' ? 'secret-shaped' : 'shell-queue-unreadable',
          kind: 'enqueue-set',
        };
      }
      parkedLines = parsedParked.lines;
    }

    const understood = parsed.lines
      .concat(parkedLines)
      .filter((line): line is Extract<LegacyTrainQueueLine, { ok: true }> => line.ok);
    const unknownLines = parsed.lines
      .concat(parkedLines)
      .filter((line) => !line.ok)
      .map((line) => line.line);

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

    // A missing chains directory or batch file genuinely means empty; an
    // unreadable one means the count is unknown. Report `null` for unknown so
    // an operator never mistakes unavailable state for empty state, and mark
    // the report incomplete when any source was unreadable.
    const chainFiles =
      shellState.chains.status === 'read'
        ? shellState.chains.chains.length
        : shellState.chains.status === 'absent'
          ? 0
          : null;
    const batchLines =
      shellState.batch.status === 'read'
        ? shellState.batch.lines.length
        : shellState.batch.status === 'absent'
          ? 0
          : null;

    // An incomplete comparison is never a pass: it answers `unknown` (exit 1)
    // and `equal` is false, so matching entries beside an unparseable shell
    // line or unreadable chain/batch state cannot read as a clean shadow day.
    const complete =
      unknownLines.length === 0 &&
      shellState.chains.status !== 'unreadable' &&
      shellState.batch.status !== 'unreadable';
    return {
      outcome: complete ? 'completed' : 'unknown',
      ...(complete ? {} : { reason: 'shell-state-incomplete' }),
      kind: 'enqueue-set',
      fleetBase: 'main',
      equal: complete && result.equal,
      complete,
      compared: result.compared,
      fleetCount: result.fleetCount,
      shellCount: result.shellCount,
      truncated: result.truncated,
      divergences: result.divergences,
      shell: {
        queue: 'read',
        unknownLines,
        parkedLines: shellState.parked.status === 'read' ? shellState.parked.lines.length : 0,
        chainFiles,
        batchLines,
      },
    };
  },
};
