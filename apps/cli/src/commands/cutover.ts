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

type ShellState = Awaited<
  ReturnType<CutoverRuntime['execution']['legacyTrainState']['readLegacyTrainState']>
>;
type ShadowRefusal = Readonly<{ outcome: 'refused' | 'unknown'; reason: string; kind: 'enqueue-set' }>;
type ShadowLines = { readonly lines: readonly LegacyTrainQueueLine[] } | { readonly refusal: ShadowRefusal };

function shadowRefusal(reason: string): ShadowRefusal {
  return { outcome: 'refused', reason, kind: 'enqueue-set' };
}

/** A parse failure refuses as `secret-shaped` when it was, and as an unreadable queue otherwise. */
function parseFailureRefusal(reason: string): ShadowRefusal {
  return shadowRefusal(reason === 'secret-shaped' ? 'secret-shaped' : 'shell-queue-unreadable');
}

/** Parses one shell state file with the given parser; absent reads as no lines, unreadable refuses. */
function parseShellLines(
  source: { readonly status: string; readonly lines?: readonly string[] },
  parse: (text: string) => ReturnType<typeof parseLegacyTrainQueue>,
): ShadowLines {
  if (source.status === 'unreadable') return { refusal: shadowRefusal('shell-queue-unreadable') };
  if (source.status !== 'read') return { lines: [] };
  const result = parse((source.lines ?? []).join('\n'));
  if (!result.ok) return { refusal: parseFailureRefusal(result.reason) };
  return { lines: result.lines };
}

/**
 * Collects every shell enqueue-set line (queue, parked, train head) in the
 * order the checks have always run, or the first refusal.
 */
function collectShellLines(shellState: ShellState): ShadowLines | { readonly refusal: ShadowRefusal } {
  if (shellState.queue.status === 'absent') return { refusal: shadowRefusal('shell-queue-absent') };
  if (shellState.queue.status === 'unreadable') return { refusal: shadowRefusal('shell-queue-unreadable') };
  const queue = parseShellLines(shellState.queue, parseLegacyTrainQueue);
  if ('refusal' in queue) return queue;

  // The shell queue excludes the PRs it parked, while the fleet queue keeps
  // `parked` entries live. Merge the shell parked list in so both sides
  // count the same PRs. Refuse when the parked list cannot be understood.
  // Parked lines are the shell's 6-field record (SH4d), so they parse with the
  // parked-specific parser, a superset of the queue entry for accounting.
  const parked = parseShellLines(shellState.parked, parseLegacyTrainParkedQueue as typeof parseLegacyTrainQueue);
  if ('refusal' in parked) return parked;

  // The train head (`inprogress`) is part of the enqueue set: it has left the
  // queue but has not merged. A missing field is unknown evidence (an older
  // adapter); an unreadable or secret-shaped head refuses the report.
  if (shellState.inprogress === undefined) {
    return { refusal: { outcome: 'unknown', reason: 'shell-state-incomplete', kind: 'enqueue-set' } };
  }
  const head = parseShellLines(shellState.inprogress, parseLegacyTrainQueue);
  if ('refusal' in head) return head;
  return { lines: queue.lines.concat(parked.lines, head.lines) };
}

/** Counts a state source that may be absent (0), unreadable (null) or read; `undefined` is unknown (null). */
function countOrNull(status: string | undefined, readCount: () => number): number | null {
  if (status === 'read') return readCount();
  return status === 'absent' ? 0 : null;
}

/** The fleet side of the comparison: every live entry of this repository under its own base. */
async function fleetEnqueueSet(
  runtime: CutoverRuntime,
  repository: { readonly owner: string; readonly repo: string },
) {
  const deadlineIso = new Date(Date.now() + 60_000).toISOString();
  // The fleet list use case partitions the queue by base (an omitted base
  // selects `main`), so every live entry is compared under its own recorded
  // base, `main` when it has none.
  const records = await runtime.execution.mergeQueueRepository.listMergeEntries({ repository, deadlineIso });
  return records
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
}

/** `cutover shadow report`: compares the fleet merge queue with the shell train's enqueue set. */
async function reportShadowHandler(payload: Payload, runtime: CutoverRuntime): Promise<unknown> {
  const repository = repositoryFromPayload(payload, 'report');
  const stateDir = str(payload, 'legacyStateDir').trim();
  if (stateDir === '') {
    throw new CliUsageError('cutover shadow report requires --legacy-state-dir');
  }

  const shellState = await runtime.execution.legacyTrainState.readLegacyTrainState({ stateDir });
  const collected = collectShellLines(shellState);
  if ('refusal' in collected) return collected.refusal;

  const understood = collected.lines.filter(
    (line): line is Extract<LegacyTrainQueueLine, { ok: true }> => line.ok,
  );
  const unknownLines = collected.lines.filter((line) => !line.ok).map((line) => line.line);

  const fleet = await fleetEnqueueSet(runtime, repository);
  const shell = understood.map((line) => ({
    pullRequest: line.entry.pullRequest,
    headOid: line.entry.headOid,
    base: line.entry.base,
  }));
  const result = compareShadowEnqueueSets({ fleet, shell });

  // A missing chains directory or batch file genuinely means empty; an
  // unreadable one means the count is unknown. Report `null` for unknown so
  // an operator never mistakes unavailable state for empty state.
  const chains = shellState.chains;
  const batch = shellState.batch;
  const batchesEnabled = shellState.batchesEnabled;
  const inprogress = shellState.inprogress;

  // An incomplete comparison is never a pass: it answers `unknown` (exit 1)
  // and `equal` is false, so matching entries beside an unparseable shell
  // line or unreadable chain/batch state cannot read as a clean shadow day.
  const complete =
    unknownLines.length === 0 &&
    chains.status !== 'unreadable' &&
    batch.status !== 'unreadable' &&
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
      inprogressLines: inprogress?.status === 'read' ? inprogress.lines.length : 0,
      chainFiles: countOrNull(chains.status, () => (chains.status === 'read' ? chains.chains.length : 0)),
      batchLines: countOrNull(batch.status, () => (batch.status === 'read' ? batch.lines.length : 0)),
      batchesEnabledLines: countOrNull(batchesEnabled?.status, () =>
        batchesEnabled?.status === 'read' ? batchesEnabled.lines.length : 0,
      ),
    },
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
    return reportShadowHandler(payload, runtime);
  },
};
