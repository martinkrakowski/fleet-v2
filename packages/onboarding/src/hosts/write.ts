/**
 * The write step of the shared onboarding engine (plan section 5): show what
 * a candidate would change, then write it with compare-and-swap on the
 * file's own sha256. The caller confirms the diff, hands the hash it read
 * with the candidate, and this module refuses when the file changed since
 * that hash — a hand edit between the draft and the write is never
 * overwritten, and there is no `--force`.
 *
 * The candidate is validated by the real `parseInstallation` again here, at
 * the moment of writing, so a caller cannot bypass the loader by calling this
 * directly. The file is written to a temporary name in the same directory and
 * renamed over the target, with mode 600 from creation, so a reader never
 * sees a half-written installation file.
 */

import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';

import {
  isFleetInstallationV2,
  parseInstallation,
  writeInstallationV2,
} from '@fleet/installation';

import type { HostDraftCandidate } from './draft.js';

/** What the caller expects the file to hold when it read it. */
export type ExpectedFileHash = string | 'absent';

/** The current on-disk state of one installation file. */
export type InstallationFileRead =
  | { readonly status: 'absent' }
  | {
      readonly status: 'read';
      /** sha256 of the exact bytes on disk. */
      readonly hash: string;
      /** The file's text, so a diff can be taken without a second read. */
      readonly text: string;
      /** The decoded value, or `undefined` when the text is not JSON. */
      readonly value: unknown;
    }
  | { readonly status: 'unreadable'; readonly reason: string };

/** sha256 of the bytes about to be written, lowercase hex. */
export function sha256Of(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Read an installation file and hash exactly the bytes on disk. A missing
 * file is `absent` (hash `absent`, the value a first write expects); any
 * other read failure is `unreadable` and never a reason to write over it.
 */
export async function readInstallationFile(file: string): Promise<InstallationFileRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { status: 'absent' };
    }
    return { status: 'unreadable', reason: code ?? 'unknown' };
  }
  const text = bytes.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { status: 'read', hash: sha256Of(bytes), text, value };
}

/** The hash a read reports, or `absent` when there is no file. */
export function readHashOf(read: InstallationFileRead): ExpectedFileHash {
  return read.status === 'read' ? read.hash : 'absent';
}

/**
 * The text of a candidate as a write would put it on disk: when the loader
 * accepts the candidate, the v2 writer's stable section and key order with a
 * trailing newline, so the diff a caller shows is byte-for-byte the write; and
 * when the loader refused the candidate there are no bytes a write would
 * produce, so it is rendered as plain pretty JSON for display only.
 */
export function serialiseInstallationCandidate(candidate: HostDraftCandidate): string {
  const parsed = parseInstallation(candidate);
  if (parsed.ok && isFleetInstallationV2(parsed.installation)) {
    return writeInstallationV2(parsed.installation);
  }
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

/**
 * The diff between the current file's text and the candidate's, line by line
 * in JSON-lines form: what the current file has and the candidate does not,
 * and the other way round. Both sides keep their own order, so a caller can
 * show removed lines before added ones. An absent current file reports every
 * candidate line as added.
 */
export interface InstallationDiff {
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

/** Multiset difference of two line lists, each side in its own order. */
function lineDelta(from: readonly string[], to: readonly string[]): {
  removed: string[];
  added: string[];
} {
  const remaining = new Map<string, number>();
  for (const text of to) {
    remaining.set(text, (remaining.get(text) ?? 0) + 1);
  }
  const removed: string[] = [];
  for (const text of from) {
    const count = remaining.get(text) ?? 0;
    if (count > 0) {
      remaining.set(text, count - 1);
    } else {
      removed.push(text);
    }
  }
  const remainingFrom = new Map<string, number>();
  for (const text of from) {
    remainingFrom.set(text, (remainingFrom.get(text) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const text of to) {
    const count = remainingFrom.get(text) ?? 0;
    if (count > 0) {
      remainingFrom.set(text, count - 1);
    } else {
      added.push(text);
    }
  }
  return { removed, added };
}

/**
 * Diff the current file text against the candidate's written text. This is
 * the comparison a compare-and-swap write shows: the current text is exactly
 * what a write would replace, so nothing is hidden by re-serialising it.
 */
export function diffInstallationText(
  currentText: string,
  candidateText: string,
): InstallationDiff {
  return lineDelta(currentText.split('\n'), candidateText.split('\n'));
}

/**
 * Diff the current installation value against a candidate, both rendered the
 * way each would be written: the current value keeps its own text order, the
 * candidate is rendered by the v2 writer, so re-ordering a section the write
 * does not touch never shows as a change.
 */
export function diffInstallation(
  current: unknown,
  candidate: HostDraftCandidate,
): InstallationDiff {
  const currentText = current === undefined ? '' : `${JSON.stringify(current, null, 2)}\n`;
  return diffInstallationText(currentText, serialiseInstallationCandidate(candidate));
}

/** Render a diff for display: `-` lines then `+` lines, empty when identical. */
export function renderInstallationDiff(diff: InstallationDiff): string {
  return [
    ...diff.removed.map((text) => `- ${text}`),
    ...diff.added.map((text) => `+ ${text}`),
  ].join('\n');
}

/** One compare-and-swap write: the candidate, the file, the expected hash. */
export interface WriteInstallationRequest {
  readonly file: string;
  /** The candidate file value; re-validated here, never trusted from a caller. */
  readonly candidate: HostDraftCandidate;
  /**
   * The hash the caller read the file at. `absent` means "there was no file";
   * any other value must equal the file's current sha256.
   */
  readonly expectedHash: ExpectedFileHash;
}

/** The outcome of a compare-and-swap write. */
export type WriteInstallationResult =
  | {
      readonly status: 'written';
      readonly file: string;
      /** The sha256 of the bytes now on disk. */
      readonly hash: string;
    }
  | {
      readonly status: 'refused';
      readonly file: string;
      /** The hash the file holds now, so a caller can reload and re-confirm. */
      readonly currentHash: ExpectedFileHash;
      readonly reason: 'changed' | 'invalid' | 'unreadable';
      readonly errors: readonly string[];
    };

/**
 * Write the candidate with compare-and-swap on the file's sha256.
 *
 * Refused, never repaired: a file whose current hash is not `expectedHash`
 * (including a file that appeared or disappeared since it was read); a
 * candidate the real `parseInstallation` rejects, with its errors unchanged;
 * a file that cannot be read. On acceptance the bytes are written to a
 * temporary name in the same directory with mode 600 from creation, fsynced
 * and renamed over the target, and the new hash is returned.
 */
export async function writeInstallation(
  request: WriteInstallationRequest,
): Promise<WriteInstallationResult> {
  const { file, candidate, expectedHash } = request;
  const current = await readInstallationFile(file);
  if (current.status === 'unreadable') {
    return {
      status: 'refused',
      file,
      currentHash: 'absent',
      reason: 'unreadable',
      errors: [`${file}: unreadable`],
    };
  }
  const currentHash = readHashOf(current);
  if (currentHash !== expectedHash) {
    return {
      status: 'refused',
      file,
      currentHash,
      reason: 'changed',
      errors: [
        `${file}: changed on disk since it was read (expected ${expectedHash}, found ${currentHash}); reload and confirm again`,
      ],
    };
  }

  // Re-validate at the moment of writing: the loader is the only authority on
  // what the file may contain, and this is the last point before it lands.
  const parsed = parseInstallation(candidate);
  if (!parsed.ok) {
    return {
      status: 'refused',
      file,
      currentHash,
      reason: 'invalid',
      errors: parsed.errors,
    };
  }
  if (!isFleetInstallationV2(parsed.installation)) {
    return {
      status: 'refused',
      file,
      currentHash,
      reason: 'invalid',
      errors: ['installation: the candidate is not a schema version 2 file'],
    };
  }

  // Already loader-accepted and narrowed to v2 above, so these are the exact
  // bytes the file will hold and the hash the caller gets back.
  const bytes = Buffer.from(writeInstallationV2(parsed.installation), 'utf8');
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return {
      status: 'refused',
      file,
      currentHash,
      reason: 'unreadable',
      errors: [`${file}: could not be written (${(error as Error).message})`],
    };
  }
  return { status: 'written', file, hash: sha256Of(bytes) };
}