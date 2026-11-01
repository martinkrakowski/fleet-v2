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

export const STATE_HELP = `Usage: fleet-v2 [--state-dir <path>] state check | state restore <file> --from <quarantine copy> [--yes]

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

/** How the state directory looks, for the first output line. Never creates it. */
async function describeStateDirectory(directory: string): Promise<string> {
  try {
    const stat = await fs.stat(directory);
    return stat.isDirectory() ? '' : ' (not a directory)';
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'unknown';
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

/** `fleet-v2 state restore <file> --from <copy> [--yes]` (lane E1b-3b). */
async function stateRestore(
  argv: readonly string[],
  io: CliIo,
  stateDir: string,
  options: StateCliOptions,
): Promise<number> {
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
      const value = token === '--from' ? argv[index + 1] : token.slice('--from='.length);
      if (token === '--from') {
        index += 1;
      }
      if (value === undefined || value.trim() === '' || value.startsWith('--')) {
        io.stderr(`--from requires a quarantine copy name\n${STATE_HELP}\n`);
        return 2;
      }
      if (from !== undefined) {
        io.stderr(`Unknown state restore option: ${token}\n${STATE_HELP}\n`);
        return 2;
      }
      from = value;
      continue;
    }
    if (token.startsWith('--')) {
      io.stderr(`Unknown state restore option: ${token}\n${STATE_HELP}\n`);
      return 2;
    }
    positionals.push(token);
  }
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
  let current: Buffer | null;
  try {
    current = await fs.readFile(currentPath);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'unknown';
    if (code === 'ENOENT') {
      current = null;
    } else {
      io.stderr(`cannot read ${currentPath} (${code})\n`);
      io.stdout('nothing changed\n');
      return 1;
    }
  }
  const currentResult: StateFileReadResult = current === null ? { status: 'missing' } : descriptor.inspect(current);
  const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const currentSuffix = current === null ? '' : `, ${current.length} bytes, sha256 ${sha(current).slice(0, 12)}`;
  let before: string;
  if (currentResult.status === 'ok') {
    before = String(currentResult.recordCount);
  } else if (currentResult.status === 'missing') {
    before = 'missing';
  } else {
    before = 'unreadable';
  }
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
  if (subcommand !== 'check' && subcommand !== 'restore') {
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
  return stateRestore(argv.slice(1), io, options.stateDir, options);
}
