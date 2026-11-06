// @generated use-case scaffold — refined for lane CO27.
/**
 * SaveLaneEditsUseCase: save one lane worktree's edits to a save ref before
 * any abort (cutover plan CO27, §4 step 5, invariants I2 and I7). It never
 * aborts, resets, removes, checks out or pushes anything; it writes only the
 * journal and the save ref. Order: validate, read the keyed journal (a final
 * result is returned as recorded), check the runner is idle (unknown is never
 * idle), run the lane diff check, journal the intent durably, save, verify the
 * tree digest, journal the result (a failed final append preserves the outcome).
 * `execute` takes `unknown` and never throws.
 * Results carry ids, codes, counts and digests only.
 */

import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import type { LaneDiffSecretPattern } from '../../domain/lane-diff-check.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type {
  SaveLaneEditsRefusalCode,
  SaveLaneEditsRequest,
  SaveLaneEditsResult,
} from '../ports/in/SaveLaneEditsPort.in-port.js';
import type { CutoverJournalEntry, CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { LaneDiffCheckPort } from '../ports/out/LaneDiffCheckPort.out-port.js';
import type { LaneEditSavePort } from '../ports/out/LaneEditSavePort.out-port.js';

export interface SaveLaneEditsDependencies {
  readonly diffCheck: Pick<LaneDiffCheckPort, 'checkLaneDiff'>;
  readonly runner: Pick<ExecutionRunnerPort, 'inspectWorktreeRun'>;
  readonly laneSave: Pick<LaneEditSavePort, 'saveLaneEdits'>;
  readonly journal: Pick<CutoverJournalPort, 'append' | 'listByKeyPrefix'>;
  /** A ULID for each journal entry. */
  readonly mintEntryId: () => string;
}

const PLAN_DIGEST = /^[0-9a-f]{7,64}$/;
const BASE_COMMIT = /^[0-9a-f]{40,64}$/;
const LANE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_PREFIXES = 200;
const MAX_TEXT = 200;
const MAX_PATH = 4096;
const SAFE_RULE = /^[A-Za-z0-9:._-]{1,80}$/;

const refused = (
  reason: SaveLaneEditsRefusalCode,
  detail: Readonly<Record<string, number | string>> | null = null,
): SaveLaneEditsResult => ({ outcome: 'refused', reason, detail });

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;

/** A dense array of at most `max` items; a hole or an over-sized list is refused. */
function denseArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
  }
  return [...value];
}

function textList(value: unknown): readonly string[] | null {
  const items = denseArray(value, MAX_PREFIXES);
  return items !== null && items.every((item) => isText(item, MAX_TEXT)) ? (items as string[]) : null;
}

/** Reads each property once inside try/catch; a throwing getter or a bad field is a null. Never echoes. */
function readRequest(input: unknown): SaveLaneEditsRequest | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const raw = input as Record<string, unknown>;
    const { planDigest, laneId, attemptId, worktreePath, clonePath, recordedHost, baseCommit, nowIso } = raw;
    const prefixes = textList(raw.allowedPathPrefixes);
    const protectedPaths = raw.policyProtectedPaths === undefined ? undefined : textList(raw.policyProtectedPaths);
    const patternItems = raw.secretPatterns === undefined ? undefined : denseArray(raw.secretPatterns, MAX_PREFIXES);
    if (
      typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest) ||
      typeof laneId !== 'string' || !LANE_ID.test(laneId) ||
      !(attemptId === null || isText(attemptId, 128)) ||
      !isText(worktreePath, MAX_PATH) || !worktreePath.startsWith('/') ||
      !isText(clonePath, MAX_PATH) || !clonePath.startsWith('/') ||
      !(recordedHost === null || (typeof recordedHost === 'object' && !Array.isArray(recordedHost))) ||
      typeof baseCommit !== 'string' || !BASE_COMMIT.test(baseCommit) ||
      prefixes === null || protectedPaths === null || patternItems === null ||
      !isZonedIsoDateTime(nowIso)
    ) {
      return null;
    }
    let secretPatterns: LaneDiffSecretPattern[] | undefined;
    if (patternItems !== undefined) {
      secretPatterns = [];
      for (const item of patternItems) {
        if (typeof item !== 'object' || item === null) return null;
        const { name, regex } = item as Record<string, unknown>;
        if (!isText(name, MAX_TEXT) || !(regex instanceof RegExp)) return null;
        secretPatterns.push({ name, regex });
      }
    }
    return {
      planDigest, laneId, attemptId, worktreePath, clonePath, baseCommit, nowIso,
      recordedHost: recordedHost as AttemptRunnerRecord | null,
      allowedPathPrefixes: prefixes,
      ...(protectedPaths !== undefined ? { policyProtectedPaths: protectedPaths } : {}),
      ...(secretPatterns !== undefined ? { secretPatterns } : {}),
    };
  } catch {
    return null;
  }
}

/** Counts per rule code only: never a path, a line or a matched value. */
function countByRule(findings: readonly { readonly rule?: unknown }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const rule = typeof finding.rule === 'string' && SAFE_RULE.test(finding.rule) ? finding.rule : 'unclassified';
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

export class SaveLaneEditsUseCase {
  constructor(private readonly deps: SaveLaneEditsDependencies) {}

  async execute(input: unknown): Promise<SaveLaneEditsResult> {
    try {
      const request = readRequest(input);
      return request === null ? refused('invalid-request') : await this.save(request);
    } catch {
      return { outcome: 'unknown', reason: 'save-unknown' };
    }
  }

  private async save(request: SaveLaneEditsRequest): Promise<SaveLaneEditsResult> {
    const { planDigest, laneId, nowIso } = request;
    const journalKey = `relaunch/${planDigest}/${laneId}/save`;
    const journalPrefix = `relaunch/${planDigest}/${laneId}/`;
    const slug = laneId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/\.{2,}/g, '.');
    const name = `${planDigest.slice(0, 12)}-${slug}`.slice(0, 64).replace(/(\.lock|\.)+$/, '');
    const saveRef = `refs/fleet/saved/${name}`;
    const first = await this.readJournal(journalPrefix, journalKey, saveRef, planDigest, laneId);
    if (first.done) return first.result;

    // The runner addresses the worktree by directory: a lane without a recorded attempt
    // is addressed by its lane id; a recovered pass checks again.
    const busy = await this.worktreeBusy(request);
    if (busy !== null) return busy;
    const diff = await this.checkDiff(request);
    if (diff !== null) return diff;

    if (!first.hasIntent) {
      const intent = await this.append({ key: journalKey, kind: 'intent', entryId: '', recordedAtIso: nowIso });
      if (intent === 'duplicate-intent') {
        const again = await this.readJournal(journalPrefix, journalKey, saveRef, planDigest, laneId);
        if (again.done) return again.result;
      } else if (intent !== 'appended') {
        return refused('journal-unavailable');
      }
    }

    let saved;
    try {
      const { recordedHost, clonePath, worktreePath } = request;
      const commitMessage = `fleet-v2 lane save ${planDigest.slice(0, 12)}`;
      saved = await this.deps.laneSave.saveLaneEdits({ recordedHost, clonePath, worktreePath, saveRef, commitMessage });
    } catch {
      saved = { outcome: 'unknown', reason: 'save-failed' } as const;
    }
    // A refused or unreadable final append never replaces the outcome that already
    // happened (brief §6 step 8); the next pass reconciles the missing result.
    const finish = async (entry: Omit<CutoverJournalEntry, 'key' | 'kind' | 'entryId' | 'recordedAtIso'>) =>
      this.append({ key: journalKey, kind: 'result', entryId: '', recordedAtIso: nowIso, ...entry });

    if (saved.outcome === 'refused') {
      await finish({ outcome: 'refused', reasonCode: saved.reason });
      return refused('save-refused', { reason: saved.reason });
    }
    if (saved.outcome === 'unknown') {
      await finish({ outcome: 'ambiguous', reasonCode: 'save-unknown' });
      return { outcome: 'unknown', reason: 'save-unknown' };
    }
    if (saved.treeDigest !== saved.worktreeTreeDigest) {
      await finish({ outcome: 'refused', reasonCode: 'tree-digest-mismatch' });
      return refused('tree-digest-mismatch');
    }
    const { outcome, commitId, treeDigest, saveRef: savedRef } = saved;
    await finish({ outcome: 'completed', reasonCode: outcome, digest: treeDigest, commitId, saveRef: savedRef });
    return { outcome, planDigest, laneId, journalKey, saveRef: savedRef, commitId, treeDigest };
  }

  /** The idempotence read: a final result is returned as recorded; an intent alone is a recovery. */
  private async readJournal(
    prefix: string, key: string, saveRef: string, planDigest: string, laneId: string,
  ): Promise<{ done: true; result: SaveLaneEditsResult } | { done: false; hasIntent: boolean }> {
    let listed;
    try {
      listed = await this.deps.journal.listByKeyPrefix(prefix);
    } catch {
      listed = { outcome: 'unreadable' } as const;
    }
    if (listed.outcome !== 'listed') return { done: true, result: refused('journal-unreadable') };
    const own = listed.entries.filter((entry) => entry.key === key);
    const final = own.find((entry) => entry.kind === 'result' && entry.outcome !== undefined && entry.outcome !== 'ambiguous');
    if (final === undefined) return { done: false, hasIntent: own.some((entry) => entry.kind === 'intent') };
    if (final.outcome === 'refused') {
      return { done: true, result: refused('save-refused', { reason: final.reasonCode ?? 'unclassified' }) };
    }
    if (final.commitId == null || final.digest == null) return { done: true, result: refused('journal-unreadable') };
    return {
      done: true,
      result: {
        outcome: final.reasonCode === 'already-saved' ? 'already-saved' : 'saved',
        planDigest, laneId, journalKey: key, saveRef: final.saveRef ?? saveRef,
        commitId: final.commitId, treeDigest: final.digest,
      },
    };
  }

  private async worktreeBusy(request: SaveLaneEditsRequest): Promise<SaveLaneEditsResult | null> {
    try {
      const inspect = this.deps.runner.inspectWorktreeRun;
      if (inspect === undefined) return refused('worktree-state-unknown');
      const state = await inspect.call(this.deps.runner, {
        attemptId: request.attemptId ?? request.laneId,
        worktreePath: request.worktreePath,
      });
      if (state.state === 'idle') return null;
      return refused(state.state === 'running' ? 'worktree-busy' : 'worktree-state-unknown');
    } catch {
      return refused('worktree-state-unknown');
    }
  }

  private async checkDiff(request: SaveLaneEditsRequest): Promise<SaveLaneEditsResult | null> {
    try {
      const { policyProtectedPaths, secretPatterns } = request;
      const verdict = await this.deps.diffCheck.checkLaneDiff({
        worktreePath: request.worktreePath,
        baseCommit: request.baseCommit,
        allowedPathPrefixes: request.allowedPathPrefixes,
        ...(policyProtectedPaths ? { policyProtectedPaths } : {}),
        ...(secretPatterns ? { secretPatterns } : {}),
      });
      if (verdict.outcome === 'clean') return null;
      // Fail closed: any finding refuses the save, not only a secret-shaped one.
      if (verdict.outcome === 'findings') return refused('diff-check-findings', countByRule(verdict.findings));
      return refused('diff-check-error');
    } catch {
      return refused('diff-check-error');
    }
  }

  /** Appends one entry; the refusal code, `appended`, or `unavailable` for a throw. */
  private async append(entry: CutoverJournalEntry): Promise<string> {
    try {
      const result = await this.deps.journal.append({ ...entry, entryId: this.deps.mintEntryId() });
      return result.outcome === 'appended' ? 'appended' : result.reason;
    } catch {
      return 'unavailable';
    }
  }
}
