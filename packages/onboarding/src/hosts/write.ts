/**
 * The write step of the shared onboarding engine (plan section 5), pure
 * half: show what a candidate would change, and hold the types the
 * compare-and-swap write speaks. Nothing here touches a filesystem, a
 * subprocess, the network or the clock; the node half that reads, locks,
 * temps and renames lives in `write-node.ts`, following the doctor's
 * `probes.ts` / `probes-node.ts` convention.
 *
 * The compare-and-swap contract is decided here and enforced in the node
 * half: the caller hands the hash it read with the candidate and the write
 * refuses when the file changed since that hash — a hand edit between the
 * draft and the write is never overwritten, and there is no `--force`.
 */

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
export function serialiseInstallationCandidate(
  candidate: HostDraftCandidate,
): string {
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
function lineDelta(
  from: readonly string[],
  to: readonly string[],
): {
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
  const currentText =
    current === undefined ? '' : `${JSON.stringify(current, null, 2)}\n`;
  return diffInstallationText(
    currentText,
    serialiseInstallationCandidate(candidate),
  );
}

/** Render a diff for display: `-` lines then `+` lines, empty when identical. */
export function renderInstallationDiff(diff: InstallationDiff): string {
  return [
    ...diff.removed.map((text) => `- ${text}`),
    ...diff.added.map((text) => `+ ${text}`),
  ].join('\n');
}
