/**
 * `fleet-v2 state` (lane E1b): a read-only check of every JSON state store
 * the four contexts own. CLI only (owner decision D4): no API route reaches
 * this module. `check` never writes, locks, creates or quarantines anything.
 */
import { promises as fs } from 'node:fs';

import { boundDoctorDetail, type DoctorLine } from '@fleet/onboarding';
import {
  WORK_EXECUTION_STATE_FILES,
  type StateFileCheck,
  type StateFileDescriptor,
  type StateFileReadResult,
} from '@fleet/work-execution';
import { EVIDENCE_AND_ACCEPTANCE_STATE_FILES } from '@fleet/evidence-and-acceptance';
import { BRIEF_KNOWLEDGE_STATE_FILES } from '@fleet/brief-knowledge';
import { OPERATOR_COORDINATION_STATE_FILES } from '@fleet/operator-coordination';

import type { CliIo } from './index.js';

export interface StateCliOptions {
  /** The resolved global --state-dir / FLEET_STATE_DIR; runCli passes it. */
  readonly stateDir?: string;
}

/** Every store file, in a fixed order: work-execution, evidence, knowledge, coordination. */
export const STATE_FILE_DESCRIPTORS: readonly StateFileDescriptor[] = [
  ...WORK_EXECUTION_STATE_FILES,
  ...EVIDENCE_AND_ACCEPTANCE_STATE_FILES,
  ...BRIEF_KNOWLEDGE_STATE_FILES,
  ...OPERATOR_COORDINATION_STATE_FILES,
];

export const STATE_HELP = `Usage: fleet-v2 [--state-dir <path>] state check

Read-only check of every JSON state store under the state directory
(--state-dir or FLEET_STATE_DIR): one line per store file (ok, missing,
unreadable: <reason>, or invalid record <n>), then each quarantine copy kept
for it. It never writes, locks or quarantines anything.

Exit codes: 0 every store file is readable or missing, 1 any store file is
unreadable, 2 usage error (including no state directory).`;

/** One status phrase for a store file or quarantine copy. */
export function describeStateFileResult(result: StateFileReadResult): string {
  switch (result.status) {
    case 'ok':
      return `ok (${result.recordCount} records)`;
    case 'missing':
      return 'missing';
    case 'read-error':
      return `unreadable: cannot read (${result.code})`;
    case 'unreadable':
      return result.recordIndex === null
        ? `unreadable: ${result.detail}`
        : `invalid record ${result.recordIndex}`;
  }
}

export function isBadStateFileResult(result: StateFileReadResult): boolean {
  return result.status === 'unreadable' || result.status === 'read-error';
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
      ? 'nothing was changed; no quarantine copies exist yet\n'
      : 'nothing was changed; the quarantine copies listed above are kept for recovery\n',
  );
  return 1;
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
      detail: boundDoctorDetail(`unreadable: ${bad.join(', ')}; run fleet-v2 state check`),
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
  if (subcommand === 'help' || argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${STATE_HELP}\n`);
    return 0;
  }
  if (subcommand !== 'check') {
    io.stderr(`Unknown state subcommand: ${subcommand === '' ? '(none)' : subcommand}\n${STATE_HELP}\n`);
    return 2;
  }
  if (options.stateDir === undefined) {
    io.stderr('state check needs a state directory: pass --state-dir <path> or set FLEET_STATE_DIR\n');
    return 2;
  }
  return stateCheck(argv.slice(1), io, options.stateDir);
}
