/**
 * `fleet-v2 state` (lane E1b): a read-only check of every JSON state store
 * the four contexts own, plus `restore`, which replaces a missing or
 * unreadable store from a quarantine copy. CLI only (owner decision D4): no
 * API route reaches this module. `check` never writes, locks, creates or
 * quarantines anything; `restore` writes only under the store's lock after
 * confirmation.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { boundDoctorDetail, type DoctorLine } from '@fleet/onboarding';
import {
  WORK_EXECUTION_STATE_FILES,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  inspectVersionedRecordListBytes,
  liveRunAttemptIds,
  parseVersionedAttemptStateRecord,
  parseVersionedJournalEntryStateRecord,
  parseVersionedReservationStateRecord,
  planAttemptScopedCompaction,
  type ActionJournalEntryRecord,
  type AttemptRecord,
  type CapacityReservationRecord,
  type RestoreStateFileOutcome,
  type StateFileCheck,
  type StateFileDescriptor,
  type StateFileReadResult,
} from '@fleet/work-execution';
import { EVIDENCE_AND_ACCEPTANCE_STATE_FILES } from '@fleet/evidence-and-acceptance';
import { BRIEF_KNOWLEDGE_STATE_FILES } from '@fleet/brief-knowledge';
import { OPERATOR_COORDINATION_STATE_FILES } from '@fleet/operator-coordination';

import { confirmFromStdin } from './hosts.js';
import type { CliIo } from './index.js';

export interface StateCliOptions {
  /** The resolved global --state-dir / FLEET_STATE_DIR; runCli passes it. */
  readonly stateDir?: string;
  /** Confirmation for restore; defaults to one stdin y/N prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

/** Every store file, in a fixed order: work-execution, evidence, knowledge, coordination. */
export const STATE_FILE_DESCRIPTORS: readonly StateFileDescriptor[] = [
  ...WORK_EXECUTION_STATE_FILES,
  ...EVIDENCE_AND_ACCEPTANCE_STATE_FILES,
  ...BRIEF_KNOWLEDGE_STATE_FILES,
  ...OPERATOR_COORDINATION_STATE_FILES,
];

export const STATE_HELP = `Usage: fleet-v2 [--state-dir <path>] state check | state restore <file> --from <quarantine copy> [--yes] | state compact [--yes]

Read-only check of every JSON state store under the state directory
(--state-dir or FLEET_STATE_DIR): one line per store file (ok, missing,
unreadable: <reason>, invalid record <n>, or unsupported schemaVersion at
record <n>), then each quarantine copy kept for it. It never writes, locks
or quarantines anything. Readable versioned stores report their observed
schemaVersion values, e.g. ok (2 records, schemaVersion 1).

restore replaces only a missing or unreadable store file with a quarantine copy
of the same store that validates fully; <file> is one of the store file names
state check prints; --from is a copy name or path directly inside <state
dir>/quarantine (no symlinks); it shows both record counts, asks y/N unless
--yes, writes under the store's lock and keeps the replaced bytes as a
quarantine copy; it never repairs.

compact removes finished records from attempts.json, journal.json and
reservations.json: only collected or cancelled attempts that no live lane run,
held reservation or unfinished journal entry references, with their finished
journal entries and released reservations. It runs state check first, refuses
(and writes nothing) when any store is unreadable, asks y/N unless --yes,
writes under each store's lock, keeps the last five pre-compaction copies in
<state dir>/quarantine and runs state check again. Exit codes for compact: 0
compacted or nothing to compact; 1 refused, declined or failed; 2 usage. Run
it with the conductor stopped: it locks one store at a time, so a lane run
saved while it works is only caught by a second read of the lane runs just
before the stores are rewritten.

Exit codes: 0 every store file is readable or missing, 1 any store file is
unreadable or holds an unsupported schemaVersion, 2 usage error (including
no state directory). Exit codes for restore: 0 restored; 1 refused, declined
or invalid candidate; 2 usage.`;

/** `record` or `records` for a count. */
function recordWord(count: number): string {
  return count === 1 ? 'record' : 'records';
}

/** The `, schemaVersion 1` / `, schemaVersions 1, 2` suffix of an ok line. */
function formatSchemaVersions(versions: readonly number[] | undefined): string {
  if (versions === undefined || versions.length === 0) {
    return '';
  }
  const label = versions.length === 1 ? 'schemaVersion' : 'schemaVersions';
  return `, ${label} ${versions.join(', ')}`;
}

/** One status phrase for a store file or quarantine copy. */
export function describeStateFileResult(result: StateFileReadResult): string {
  switch (result.status) {
    case 'ok':
      return `ok (${result.recordCount} ${recordWord(result.recordCount)}${formatSchemaVersions(result.schemaVersions)})`;
    case 'missing':
      return 'missing';
    case 'read-error':
      return `unreadable: cannot read (${result.code})`;
    case 'unreadable':
      return result.recordIndex === null
        ? `unreadable: ${result.detail}`
        : `invalid record ${result.recordIndex}`;
    case 'unknown-version':
      return `unsupported schemaVersion at record ${result.recordIndex}`;
  }
}

export function isBadStateFileResult(result: StateFileReadResult): boolean {
  return (
    result.status === 'unreadable' ||
    result.status === 'read-error' ||
    result.status === 'unknown-version'
  );
}

/** Check every store; Promise.all keeps the descriptors' order, so output is stable. */
export async function checkStateDirectory(stateDir: string): Promise<StateFileCheck[]> {
  return Promise.all(STATE_FILE_DESCRIPTORS.map((descriptor) => descriptor.check(stateDir)));
}

function errorCodeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unknown';
}

/** How the state directory looks, for the first output line. Never creates it. */
async function describeStateDirectory(directory: string): Promise<string> {
  try {
    const stat = await fs.stat(directory);
    return stat.isDirectory() ? '' : ' (not a directory)';
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    return code === 'ENOENT' ? ' (does not exist yet)' : ` (cannot read: ${code})`;
  }
}

async function stateCheck(argv: readonly string[], io: CliIo, stateDir: string): Promise<number> {
  if (argv.length > 0) {
    io.stderr(`Unknown state check argument: ${argv[0]}\n${STATE_HELP}\n`);
    return 2;
  }
  const note = await describeStateDirectory(stateDir);
  io.stdout(`state directory: ${stateDir}${note}\n`);
  const checks = await checkStateDirectory(stateDir);
  let bad = 0;
  for (const check of checks) {
    if (isBadStateFileResult(check.result)) {
      bad += 1;
    }
    io.stdout(`${check.basename}: ${describeStateFileResult(check.result)}\n`);
    for (const copy of check.quarantineCopies) {
      const size = copy.sizeBytes === null ? '' : `, ${copy.sizeBytes} bytes`;
      io.stdout(`  quarantine ${copy.name}: ${describeStateFileResult(copy.result)}${size}\n`);
    }
  }
  if (bad === 0) {
    io.stdout(`state check: all ${checks.length} store files readable or missing\n`);
    return 0;
  }
  io.stdout(`state check: ${bad} of ${checks.length} store files unreadable\n`);
  const copies = checks.reduce((total, check) => total + check.quarantineCopies.length, 0);
  io.stdout(
    copies === 0
      ? 'nothing was changed; no quarantine copies were found\n'
      : 'nothing was changed; the quarantine copies listed above are kept for recovery\n',
  );
  if (copies > 0) {
    io.stdout('restore one with: fleet-v2 state restore <file> --from <quarantine copy name>\n');
  }
  return 1;
}

interface ParsedRestoreArgs {
  readonly from?: string;
  readonly yes: boolean;
  readonly positionals: readonly string[];
}

function parseFromValue(
  token: string,
  argv: readonly string[],
  index: number,
): { readonly value: string | undefined; readonly nextIndex: number } {
  if (token === '--from') {
    return { value: argv[index + 1], nextIndex: index + 1 };
  }
  return { value: token.slice('--from='.length), nextIndex: index };
}

function isInvalidFromValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === '' || value.startsWith('--');
}

function parseRestoreArgs(
  argv: readonly string[],
  io: CliIo,
): ParsedRestoreArgs | null {
  let from: string | undefined;
  let yes = false;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token === '--from' || token.startsWith('--from=')) {
      if (from !== undefined) {
        io.stderr(`Unknown state restore option: ${token}\n${STATE_HELP}\n`);
        return null;
      }
      const parsed = parseFromValue(token, argv, index);
      index = parsed.nextIndex;
      if (isInvalidFromValue(parsed.value)) {
        io.stderr(`--from requires a quarantine copy name\n${STATE_HELP}\n`);
        return null;
      }
      from = parsed.value;
      continue;
    }
    if (token.startsWith('--')) {
      io.stderr(`Unknown state restore option: ${token}\n${STATE_HELP}\n`);
      return null;
    }
    positionals.push(token);
  }
  return { from, yes, positionals };
}

async function readCurrentStoreFile(
  filePath: string,
): Promise<{ readonly status: 'ok'; readonly bytes: Buffer | null } | { readonly status: 'error'; readonly code: string }> {
  try {
    const bytes = await fs.readFile(filePath);
    return { status: 'ok', bytes };
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT') {
      return { status: 'ok', bytes: null };
    }
    return { status: 'error', code };
  }
}

function formatBeforeRecords(result: StateFileReadResult): string {
  if (result.status === 'ok') {
    return String(result.recordCount);
  }
  if (result.status === 'missing') {
    return 'missing';
  }
  if (result.status === 'unknown-version') {
    return 'unsupported';
  }
  return 'unreadable';
}

/** `fleet-v2 state restore <file> --from <copy> [--yes]` (lane E1b-3b). */
async function stateRestore(
  argv: readonly string[],
  io: CliIo,
  stateDir: string,
  options: StateCliOptions,
): Promise<number> {
  const parsed = parseRestoreArgs(argv, io);
  if (parsed === null) {
    return 2;
  }
  const { from, yes, positionals } = parsed;
  if (positionals.length !== 1) {
    io.stderr(`state restore requires exactly one store file\n${STATE_HELP}\n`);
    return 2;
  }
  const file = positionals[0]!;
  if (from === undefined) {
    io.stderr(`state restore requires --from <quarantine copy>\n${STATE_HELP}\n`);
    return 2;
  }
  const descriptor = STATE_FILE_DESCRIPTORS.find((d) => d.basename === file);
  if (descriptor === undefined) {
    io.stderr(
      `unknown store file '${file}'; expected one of: ${STATE_FILE_DESCRIPTORS.map((d) => d.basename).join(', ')}\n`,
    );
    return 2;
  }
  const read = await descriptor.readQuarantineCopy(stateDir, from);
  if (read.status === 'refused') {
    io.stderr(`${read.reason}\n`);
    io.stdout('nothing changed\n');
    return 1;
  }
  const candidate = descriptor.inspect(read.bytes);
  if (candidate.status !== 'ok') {
    io.stderr(`candidate ${read.name}: ${describeStateFileResult(candidate)}\n`);
    io.stdout('nothing changed\n');
    return 1;
  }
  const currentPath = path.join(stateDir, file);
  const currentRead = await readCurrentStoreFile(currentPath);
  if (currentRead.status === 'error') {
    io.stderr(`cannot read ${currentPath} (${currentRead.code})\n`);
    io.stdout('nothing changed\n');
    return 1;
  }
  const current = currentRead.bytes;
  const currentResult: StateFileReadResult = current === null ? { status: 'missing' } : descriptor.inspect(current);
  const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const currentSuffix = current === null ? '' : `, ${current.length} bytes, sha256 ${sha(current).slice(0, 12)}`;
  const before = formatBeforeRecords(currentResult);
  io.stdout(`restore ${currentPath}\n`);
  io.stdout(`  current:   ${describeStateFileResult(currentResult)}${currentSuffix}\n`);
  io.stdout(
    `  candidate: ok (${candidate.recordCount} ${recordWord(candidate.recordCount)}), ${read.bytes.length} bytes, sha256 ${sha(read.bytes).slice(0, 12)}, from quarantine/${read.name}\n`,
  );
  io.stdout(`  records:   ${before} -> ${candidate.recordCount}\n`);
  if (currentResult.status === 'ok') {
    io.stderr(
      `${file} is readable (${currentResult.recordCount} ${recordWord(currentResult.recordCount)}); state restore replaces only a missing or unreadable store\n`,
    );
    io.stdout('nothing changed\n');
    return 1;
  }
  if (currentResult.status === 'unknown-version') {
    io.stderr(
      `${file} has an unsupported schemaVersion; state restore replaces only a missing or unreadable store\n`,
    );
    io.stdout('nothing changed\n');
    return 1;
  }
  if (!yes) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`restore ${file} from ${read.name}? [y/N]`))) {
      io.stdout('nothing changed\n');
      return 1;
    }
  }
  let outcome: RestoreStateFileOutcome;
  try {
    outcome = await descriptor.restore({
      stateDir,
      candidate: read.bytes,
      expectedCurrentSha256: current === null ? null : sha(current),
      protectNames: [read.name],
    });
  } catch (error: unknown) {
    io.stderr(`restore failed: ${error instanceof Error ? error.message : String(error)}\n`);
    io.stdout('the store file was not changed; run state check to see the quarantine copies\n');
    return 1;
  }
  if (outcome.status === 'refused') {
    io.stderr(`${outcome.reason}\n`);
    io.stdout('nothing changed\n');
    return 1;
  }
  io.stdout(`restored ${file} (${outcome.recordCount} ${recordWord(outcome.recordCount)})\n`);
  io.stdout(outcome.previousCopyPath === null ? 'there was no previous file\n' : `previous bytes kept at ${outcome.previousCopyPath}\n`);
  return 0;
}

/** The three attempt-scoped stores `state compact` rewrites, in apply order. */
const COMPACT_BASENAMES = ['attempts.json', 'journal.json', 'reservations.json'] as const;
type CompactBasename = (typeof COMPACT_BASENAMES)[number];

/** A store larger than this is refused rather than read into memory. */
const MAX_COMPACT_STORE_BYTES = 64 * 1024 * 1024;
const MAX_COMPACT_REASON_CHARS = 200;

const COMPACT_CONFIRM_QUESTION = `compact the attempt-scoped stores (${COMPACT_BASENAMES.join(', ')})? [y/N]`;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A refusal reason that is safe to print: no state-directory path, no free-form error text, bounded. */
function safeCompactReason(reason: string, stateDir: string): string {
  let text = reason;
  if (stateDir !== '') {
    text = text.split(stateDir).join('<state dir>');
  }
  text = text.replace(/\s*\(([^)]*)\)/g, (_match, inner: string) =>
    /^[A-Z][A-Z0-9_]{1,24}$/.test(inner) ? ` (${inner})` : '',
  );
  text = text.replace(/\S*[\\/]\S*/g, '<path>');
  return text.length > MAX_COMPACT_REASON_CHARS ? `${text.slice(0, MAX_COMPACT_REASON_CHARS)}...` : text;
}

function compactRefusal(io: CliIo, message: string): number {
  io.stderr(`state compact refused: ${message}\n`);
  io.stdout('nothing changed\n');
  return 1;
}

function badBasenames(checks: readonly StateFileCheck[]): string {
  return checks
    .filter((check) => isBadStateFileResult(check.result))
    .map((check) => check.basename)
    .join(', ');
}

interface CompactStore<T> {
  readonly basename: CompactBasename;
  readonly sha256: string | null;
  readonly records: readonly T[];
}

type CompactStoreRead<T> =
  | { readonly ok: true; readonly store: CompactStore<T> }
  | { readonly ok: false; readonly message: string };

/** Read one store through its own parser; a symlink, a non-file, an oversized or an unreadable store is a typed refusal. */
async function readCompactStore<T>(
  stateDir: string,
  basename: CompactBasename,
  parseRecord: Parameters<typeof inspectVersionedRecordListBytes<T>>[1],
): Promise<CompactStoreRead<T>> {
  const target = path.join(stateDir, basename);
  let bytes: Buffer;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) {
      return { ok: false, message: `${basename} is not a regular file` };
    }
    if (stat.size > MAX_COMPACT_STORE_BYTES) {
      return { ok: false, message: `${basename} is too large to compact` };
    }
    bytes = await fs.readFile(target);
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT') {
      return { ok: true, store: { basename, sha256: null, records: [] } };
    }
    return { ok: false, message: `${basename} could not be read (${code})` };
  }
  if (bytes.length > MAX_COMPACT_STORE_BYTES) {
    return { ok: false, message: `${basename} is too large to compact` };
  }
  const inspection = inspectVersionedRecordListBytes(bytes, parseRecord);
  if (inspection.status === 'unknown-version') {
    return { ok: false, message: `${basename} has an unsupported schemaVersion` };
  }
  if (inspection.status !== 'ok') {
    return { ok: false, message: `${basename} is unreadable: ${safeCompactReason(inspection.detail, stateDir)}` };
  }
  const ids = (inspection.records as readonly { readonly id: string }[]).map((record) => record.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, message: `${basename} has a duplicate record id` };
  }
  return { ok: true, store: { basename, sha256: sha256Hex(bytes), records: inspection.records } };
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error: unknown) {
    if (errorCodeOf(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Every segment of a store's path, parents included: a linked parent directory leads out of the state directory too. */
async function linkedSegment(stateDir: string, relativePath: string): Promise<string | null> {
  const segments = relativePath.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join('/');
    const entry = await lstatOrNull(path.join(stateDir, prefix));
    if (entry === null) {
      return null;
    }
    if (entry.isSymbolicLink()) {
      return prefix;
    }
  }
  return null;
}

/** The three rewritten stores: a regular file within the size bound, and no directory squatting on the temp name. */
async function compactStoreProblem(stateDir: string, basename: CompactBasename): Promise<string | null> {
  const store = await lstatOrNull(path.join(stateDir, basename));
  if (store !== null && !store.isFile()) {
    return `${basename} is not a regular file`;
  }
  if (store !== null && store.size > MAX_COMPACT_STORE_BYTES) {
    return `${basename} is too large to compact`;
  }
  const temp = await lstatOrNull(path.join(stateDir, `${basename}.compacted`));
  return temp?.isDirectory() === true ? `${basename}.compacted is a directory` : null;
}

/**
 * Before any store is read: no store path (parents included) may be a link, the three rewritten stores,
 * their `.compacted` temp names and the quarantine directory must be of the right kind, and no rewritten
 * store may exceed the size bound. A link is never followed, so this runs before `state check` reads anything.
 */
async function compactPreflight(stateDir: string): Promise<string | null> {
  try {
    for (const descriptor of STATE_FILE_DESCRIPTORS) {
      const linked = await linkedSegment(stateDir, descriptor.basename);
      if (linked !== null) {
        return `${linked} is a link`;
      }
    }
    for (const basename of COMPACT_BASENAMES) {
      const problem = await compactStoreProblem(stateDir, basename);
      if (problem !== null) {
        return problem;
      }
    }
    const quarantine = await lstatOrNull(path.join(stateDir, 'quarantine'));
    return quarantine !== null && !quarantine.isDirectory() ? 'the quarantine directory is not a real directory' : null;
  } catch (error: unknown) {
    return `the state directory could not be inspected (${errorCodeOf(error)})`;
  }
}

interface CompactPlan {
  readonly stores: readonly CompactStore<{ readonly id: string }>[];
  readonly keepLists: readonly (readonly string[])[];
  readonly removable: readonly ReadonlySet<string>[];
}

/** The attempt ids a live lane run lists; throws when the runs cannot be read. */
async function readLiveRunAttemptIds(stateDir: string): Promise<readonly string[]> {
  const runs = await new LaneRunRepositoryAdapter({ stateDir, readOnly: true }).list();
  const journals = await new LaneRunJournalAdapter({ stateDir, readOnly: true }).listForRuns(
    runs.map((run) => run.runId),
  );
  return liveRunAttemptIds(runs, journals);
}

/** Read the three stores and plan; a string is a refusal message. */
async function planCompaction(stateDir: string): Promise<CompactPlan | string> {
  const attempts = await readCompactStore<AttemptRecord>(stateDir, 'attempts.json', parseVersionedAttemptStateRecord);
  if (!attempts.ok) {
    return attempts.message;
  }
  const journal = await readCompactStore<ActionJournalEntryRecord>(
    stateDir,
    'journal.json',
    parseVersionedJournalEntryStateRecord,
  );
  if (!journal.ok) {
    return journal.message;
  }
  const reservations = await readCompactStore<CapacityReservationRecord>(
    stateDir,
    'reservations.json',
    parseVersionedReservationStateRecord,
  );
  if (!reservations.ok) {
    return reservations.message;
  }
  try {
    const plan = planAttemptScopedCompaction({
      attempts: attempts.store.records,
      reservations: reservations.store.records,
      journalEntries: journal.store.records,
      liveRunAttemptIds: await readLiveRunAttemptIds(stateDir),
    });
    const removable = [
      new Set(plan.removableAttemptIds),
      new Set(plan.removableJournalEntryIds),
      new Set(plan.removableReservationIds),
    ];
    const stores = [attempts.store, journal.store, reservations.store];
    const keepLists = stores.map((store, index) =>
      store.records.map((record) => record.id).filter((id) => !removable[index]!.has(id)),
    );
    return { stores, keepLists, removable };
  } catch {
    return 'the lane runs could not be read';
  }
}

/** True when a run now lists an attempt the plan is about to remove (the lane runs moved after the plan was made). */
async function liveRunsMovedUnderPlan(stateDir: string, plan: CompactPlan): Promise<boolean> {
  try {
    const live = await readLiveRunAttemptIds(stateDir);
    return live.some((id) => plan.removable[0]!.has(id));
  } catch {
    return true;
  }
}

async function confirmCompaction(io: CliIo, options: StateCliOptions): Promise<boolean> {
  try {
    const confirm = options.confirm ?? confirmFromStdin(io);
    return await confirm(COMPACT_CONFIRM_QUESTION);
  } catch {
    return false;
  }
}

/** Apply the plan store by store; the first refusal stops the loop, and stores already compacted stay compacted. */
async function applyCompaction(
  io: CliIo,
  stateDir: string,
  plan: CompactPlan,
): Promise<{ readonly compactedCount: number; readonly failed: boolean }> {
  let compactedCount = 0;
  for (const [index, store] of plan.stores.entries()) {
    if (store.sha256 === null) {
      io.stdout(`missing ${store.basename}: nothing to compact\n`);
      continue;
    }
    const descriptor = STATE_FILE_DESCRIPTORS.find((candidate) => candidate.basename === store.basename);
    let refusal: string | null = null;
    let outcome: Awaited<ReturnType<NonNullable<StateFileDescriptor['compact']>>> | null = null;
    if (descriptor?.compact === undefined) {
      refusal = 'the store cannot be compacted';
    } else {
      try {
        outcome = await descriptor.compact({
          stateDir,
          keepIds: plan.keepLists[index]!,
          expectedCurrentSha256: store.sha256,
        });
      } catch {
        refusal = 'the compaction failed';
      }
    }
    if (outcome?.status === 'refused') {
      refusal = safeCompactReason(outcome.reason, stateDir);
    }
    if (refusal !== null || outcome === null) {
      io.stderr(`state compact refused: ${store.basename}: ${refusal ?? 'the compaction failed'}\n`);
      return { compactedCount, failed: true };
    }
    if (outcome.status === 'unchanged') {
      io.stdout(`unchanged ${store.basename}: ${outcome.recordCount} ${recordWord(outcome.recordCount)}\n`);
    } else if (outcome.status === 'compacted') {
      compactedCount += 1;
      io.stdout(`compacted ${store.basename}: ${outcome.beforeCount} -> ${outcome.afterCount} records\n`);
      if (outcome.quarantinePath !== null) {
        io.stdout(`pre-compaction bytes kept at quarantine/${path.basename(outcome.quarantinePath)}\n`);
      }
    }
  }
  return { compactedCount, failed: false };
}

/** `fleet-v2 state compact [--yes]` (lane EX-3c): the operator half of the state compaction. */
async function stateCompact(
  argv: readonly string[],
  io: CliIo,
  stateDir: string,
  options: StateCliOptions,
): Promise<number> {
  const unknownOption = argv.find((token) => token !== '--yes');
  if (unknownOption !== undefined) {
    io.stderr(`Unknown state compact option: ${unknownOption}\n${STATE_HELP}\n`);
    return 2;
  }
  const preflight = await compactPreflight(stateDir);
  if (preflight !== null) {
    return compactRefusal(io, preflight);
  }
  let before: StateFileCheck[];
  try {
    before = await checkStateDirectory(stateDir);
  } catch {
    return compactRefusal(io, 'the state check could not run');
  }
  const badBefore = badBasenames(before);
  if (badBefore !== '') {
    return compactRefusal(io, `${badBefore} is not readable`);
  }
  const plan = await planCompaction(stateDir);
  if (typeof plan === 'string') {
    return compactRefusal(io, plan);
  }
  if (plan.stores.every((store, index) => plan.keepLists[index]!.length === store.records.length)) {
    io.stdout('state compact: nothing to compact\n');
    return 0;
  }
  if (!argv.includes('--yes') && !(await confirmCompaction(io, options))) {
    io.stdout('nothing changed\n');
    return 1;
  }
  if (await liveRunsMovedUnderPlan(stateDir, plan)) {
    return compactRefusal(io, 'the lane runs changed while the plan was being made');
  }
  const { compactedCount, failed } = await applyCompaction(io, stateDir, plan);
  io.stdout(`state compact: ${compactedCount} of ${COMPACT_BASENAMES.length} stores compacted\n`);
  let after: StateFileCheck[];
  try {
    after = await checkStateDirectory(stateDir);
  } catch {
    io.stderr('state check after compaction failed: the state check could not run\n');
    return 1;
  }
  const badAfter = badBasenames(after);
  if (badAfter !== '') {
    io.stderr(`state check after compaction failed: ${badAfter}\n`);
    return 1;
  }
  io.stdout(`state check after compaction: all ${after.length} store files readable or missing\n`);
  return failed ? 1 : 0;
}

/** The doctor's state line: PASS, FAIL naming the bad files, or UNKNOWN. */
export async function stateDoctorLine(stateDir: string): Promise<DoctorLine> {
  const base = { scope: 'state' as const, subject: stateDir, check: 'state-files' };
  try {
    const checks = await checkStateDirectory(stateDir);
    const bad = checks.filter((check) => isBadStateFileResult(check.result)).map((check) => check.basename);
    if (bad.length === 0) {
      return { ...base, status: 'PASS', detail: boundDoctorDetail(`${checks.length} store files readable or missing`) };
    }
    return {
      ...base,
      status: 'FAIL',
      detail: boundDoctorDetail(`run fleet-v2 state check; unreadable: ${bad.join(', ')}`),
    };
  } catch {
    return { ...base, status: 'UNKNOWN', detail: 'the state check could not run' };
  }
}

/** `fleet-v2 state <subcommand>` dispatch. */
export async function stateCommand(
  argv: readonly string[],
  io: CliIo,
  options: StateCliOptions = {},
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    argv[1] === '--help' ||
    argv[1] === '-h'
  ) {
    io.stdout(`${STATE_HELP}\n`);
    return 0;
  }
  if (subcommand !== 'check' && subcommand !== 'restore' && subcommand !== 'compact') {
    io.stderr(`Unknown state subcommand: ${subcommand === '' ? '(none)' : subcommand}\n${STATE_HELP}\n`);
    return 2;
  }
  if (options.stateDir === undefined) {
    io.stderr(`state ${subcommand} needs a state directory: pass --state-dir <path> or set FLEET_STATE_DIR\n`);
    return 2;
  }
  if (subcommand === 'check') {
    return stateCheck(argv.slice(1), io, options.stateDir);
  }
  if (subcommand === 'compact') {
    return stateCompact(argv.slice(1), io, options.stateDir, options);
  }
  return stateRestore(argv.slice(1), io, options.stateDir, options);
}
