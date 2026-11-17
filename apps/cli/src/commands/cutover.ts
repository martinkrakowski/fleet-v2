/**
 * The `cutover` command group of the CLI driver. `status` and `rollback` (lane
 * CO30a) read and move the cutover record through `ManageCutoverUseCase`;
 * `switch` is the one-way door through the shadow criteria and `retire` closes
 * the record after the rollback window (lane CO30b). The rest of this note is
 * lane CO32: reads only: the `shadow report` subcommand compares the fleet-v2 merge queue against the
 * shell train's recorded queue for one repository and prints one JSON document
 * of ids and codes. It writes nothing and grants nothing.
 *
 * The fleet merge queue keeps a `parked` entry live, so the shell side must be
 * counted the same way: a shell parked PR is absent from the shell queue file
 * but present in the shell parked list, so the parked list's `pr sha base`
 * lines are parsed with the same queue parser and merged into the shell set.
 * A parked list that is unreadable or secret-shaped refuses the report —
 * comparing without it would silently mis-report parked PRs. The train's
 * in-progress head (`inprogress`) is parsed the same way and counted on the
 * shell side; fleet entries are keyed by their own recorded base branch.
 */

import { firstPositional, str, CliUsageError, type Payload } from './payload.js';
import type { CommandHandler } from './payload.js';
import {
  compareShadowEnqueueSets,
  isMergeQueueEntryLive,
  parseLegacyTrainParkedQueue,
  parseLegacyTrainQueue,
  type LegacyTrainQueueLine,
} from '@fleet/work-execution';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Parse `--repository owner/repo`; usage error when absent or malformed. */
function repositoryFromPayload(p: Payload, subcommand: string): { owner: string; repo: string } {
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
    throw new CliUsageError(`cutover shadow ${subcommand} requires --repository as owner/repo`);
  }
  return { owner: segments[0], repo: segments[1] };
}

/** Usage error for a flag or positional the subcommand does not take; the value is never echoed. */
function rejectUnexpectedInput(
  p: Payload,
  subcommand: string,
  allowed: readonly string[],
  allowedPositionals = 0,
): void {
  for (const key of Object.keys(p)) {
    if (key === 'positional') {
      if (Array.isArray(p[key]) && p[key].length > allowedPositionals) {
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

/** A flag value as a number: a number as given, a string only when it matches `pattern`, else NaN. */
function revisionFromFlagValue(value: unknown, pattern: RegExp): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && pattern.test(value) ? Number(value) : Number.NaN;
}

function expectedRevisionFlag(p: Payload, move: 'rollback' | 'retire'): number {
  const revision = revisionFromFlagValue(p['expectedRevision'], /^[1-9]\d{0,9}$/);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new CliUsageError(`cutover ${move} requires --expected-revision as a positive integer`);
  }
  return revision;
}

/** The switch revision accepts 0, the one-way door's no-record-yet revision. */
function switchExpectedRevisionFlag(p: Payload): number {
  const revision = revisionFromFlagValue(p['expectedRevision'], /^\d{1,10}$/);
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 1_000_000_000) {
    throw new CliUsageError('cutover switch requires --expected-revision as an integer between 0 and 1000000000');
  }
  return revision;
}

function operationIdFlag(p: Payload, subcommand: 'rollback' | 'switch' | 'retire'): string {
  const operationId = p['operationId'];
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw new CliUsageError(`cutover ${subcommand} requires --operation-id`);
  }
  return operationId;
}

function relaunchPlanDigestFlag(p: Payload): string {
  const digest = p['relaunchPlanDigest'];
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new CliUsageError('cutover switch requires --relaunch-plan-digest as 64 lowercase hex characters');
  }
  return digest;
}

type CutoverRuntime = Parameters<CommandHandler>[1];

/**
 * The optional `--day YYYY-MM-DD` flag. Only the syntax is checked here: the
 * use case owns the day's meaning (too early, too old, ordering), so this
 * wiring never re-validates a well-formed day.
 */
function optionalDayFlag(p: Payload): string | undefined {
  const value = p['day'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliUsageError('--day requires a value');
  }
  return value;
}

/**
 * SH8a: `cutover shadow record-day`. The flags are the report's two plus an
 * optional `--day`; anything else is a usage error. Without a durable state
 * directory the composed use case is undefined and the command refuses with
 * `state-dir-required`; otherwise the use case's result is returned UNCHANGED
 * — `recorded` and `unchanged` complete (0), every other outcome exits 1.
 */
async function recordShadowDayHandler(payload: Payload, runtime: CutoverRuntime): Promise<unknown> {
  rejectUnexpectedInput(payload, 'shadow record-day', ['repository', 'legacyStateDir', 'day'], 1);
  const repository = repositoryFromPayload(payload, 'record-day');
  const stateDir = str(payload, 'legacyStateDir').trim();
  if (stateDir === '') {
    throw new CliUsageError('cutover shadow record-day requires --legacy-state-dir');
  }
  const day = optionalDayFlag(payload);
  const recordShadowDay = runtime.execution.recordShadowDay;
  if (recordShadowDay === undefined) {
    return { outcome: 'refused', reason: 'state-dir-required' };
  }
  return recordShadowDay.execute({
    repository,
    legacyStateDir: stateDir,
    ...(day === undefined ? {} : { day }),
  });
}

/** Reads the shared flags of a revisioned move and runs it; the use case result is returned unchanged. */
async function executeMove(
  payload: Payload,
  runtime: CutoverRuntime,
  move: 'rollback' | 'switch' | 'retire',
  expectedRevision: number,
  extra: () => Readonly<Record<string, string>>,
): Promise<unknown> {
  const operationId = operationIdFlag(payload, move);
  const moveFlags = extra();
  const nowIso = optionalIsoFlag(payload, 'nowIso', 'now-iso') ?? runtime.daemon.now();
  const deadlineIso = optionalIsoFlag(payload, 'deadlineIso', 'deadline-iso');
  return runtime.execution.manageCutover.execute({
    move,
    expectedRevision,
    operationId,
    ...moveFlags,
    nowIso,
    ...(deadlineIso === undefined ? {} : { deadlineIso }),
  });
}

/** The handler of a move that takes only a revision and an operation id (rollback and retire). */
function revisionMoveHandler(move: 'rollback' | 'retire'): CommandHandler {
  return async (payload, runtime) => {
    rejectUnexpectedInput(payload, move, ['expectedRevision', 'operationId', 'nowIso', 'deadlineIso']);
    return executeMove(payload, runtime, move, expectedRevisionFlag(payload, move), () => ({}));
  };
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

  rollback: revisionMoveHandler('rollback'),

  switch: async (payload, runtime) => {
    rejectUnexpectedInput(payload, 'switch', [
      'expectedRevision', 'operationId', 'relaunchPlanDigest', 'nowIso', 'deadlineIso',
    ]);
    const expectedRevision = switchExpectedRevisionFlag(payload);
    return executeMove(payload, runtime, 'switch', expectedRevision, () => ({
      relaunchPlanDigest: relaunchPlanDigestFlag(payload),
    }));
  },

  retire: revisionMoveHandler('retire'),

  shadow: async (payload, runtime) => {
    const sub = firstPositional(payload);
    if (sub !== 'report' && sub !== 'record-day') {
      throw new CliUsageError(
        sub === ''
          ? 'cutover shadow requires a subcommand: fleet-v2 cutover shadow report or fleet-v2 cutover shadow record-day'
          : 'cutover shadow has no such subcommand: the two shadow subcommands are report and record-day',
      );
    }
    if (sub === 'record-day') {
      return recordShadowDayHandler(payload, runtime);
    }
    const repository = repositoryFromPayload(payload, 'report');
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
      // Parked lines are the shell's 6-field `pr head reason attempt notBefore
      // base` record (SH4d), not the queue's 3-field `pr sha base` shape — so
      // they parse with the parked-specific parser, which is a superset of the
      // queue entry for accounting purposes.
      const parsedParked = parseLegacyTrainParkedQueue(parked.lines.join('\n'));
      if (!parsedParked.ok) {
        return {
          outcome: 'refused',
          reason: parsedParked.reason === 'secret-shaped' ? 'secret-shaped' : 'shell-queue-unreadable',
          kind: 'enqueue-set',
        };
      }
      parkedLines = parsedParked.lines.map((line) => (line.ok ? { ok: true as const, entry: line.entry } : line));
    }

    // The train head (`inprogress`) is part of the shell's enqueue set: it has
    // left the queue but has not merged. Parse it with the same queue parser
    // and merge it into the same accounting as the parked lines — a missing
    // field is unknown evidence (an older adapter), an unreadable or
    // secret-shaped head refuses the report.
    const inprogress = shellState.inprogress;
    if (inprogress === undefined) {
      return { outcome: 'unknown', reason: 'shell-state-incomplete', kind: 'enqueue-set' };
    }
    if (inprogress.status === 'unreadable') {
      return { outcome: 'refused', reason: 'shell-queue-unreadable', kind: 'enqueue-set' };
    }
    let inprogressLines: readonly LegacyTrainQueueLine[] = [];
    if (inprogress.status === 'read') {
      const parsedInprogress = parseLegacyTrainQueue(inprogress.lines.join('\n'));
      if (!parsedInprogress.ok) {
        return {
          outcome: 'refused',
          reason: parsedInprogress.reason === 'secret-shaped' ? 'secret-shaped' : 'shell-queue-unreadable',
          kind: 'enqueue-set',
        };
      }
      inprogressLines = parsedInprogress.lines;
    }

    const allLines = parsed.lines.concat(parkedLines, inprogressLines);
    const understood = allLines.filter(
      (line): line is Extract<LegacyTrainQueueLine, { ok: true }> => line.ok,
    );
    const unknownLines = allLines.filter((line) => !line.ok).map((line) => line.line);

    const deadlineIso = new Date(Date.now() + 60_000).toISOString();
    // The fleet list use case partitions the queue by base (an omitted base
    // selects `main`), so the read goes through the repository port and every
    // live entry is compared under its own recorded base, `main` when it has
    // none.
    const records = await runtime.execution.mergeQueueRepository.listMergeEntries({ repository, deadlineIso });
    const fleet = records
      .filter(
        (entry) =>
          isMergeQueueEntryLive(entry) &&
          entry.repository.owner === repository.owner &&
          entry.repository.repo === repository.repo,
      )
      .map((entry) => ({
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
        base: entry.baseBranch ?? 'main',
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
    const inprogressCount = inprogress.status === 'read' ? inprogress.lines.length : 0;
    const batchesEnabled = shellState.batchesEnabled;
    const batchesEnabledLines =
      batchesEnabled === undefined
        ? null
        : batchesEnabled.status === 'read'
          ? batchesEnabled.lines.length
          : batchesEnabled.status === 'absent'
            ? 0
            : null;

    // An incomplete comparison is never a pass: it answers `unknown` (exit 1)
    // and `equal` is false, so matching entries beside an unparseable shell
    // line or unreadable chain/batch state cannot read as a clean shadow day.
    const complete =
      unknownLines.length === 0 &&
      shellState.chains.status !== 'unreadable' &&
      shellState.batch.status !== 'unreadable' &&
      batchesEnabled !== undefined &&
      batchesEnabled.status !== 'unreadable';
    return {
      outcome: complete ? 'completed' : 'unknown',
      ...(complete ? {} : { reason: 'shell-state-incomplete' }),
      kind: 'enqueue-set',
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
        inprogressLines: inprogressCount,
        chainFiles,
        batchLines,
        batchesEnabledLines,
      },
    };
  },
};
