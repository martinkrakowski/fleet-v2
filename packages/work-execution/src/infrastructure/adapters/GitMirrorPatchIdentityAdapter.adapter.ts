// @generated adapter scaffold — refined for lane DT7.
/**
 * GitMirrorPatchIdentityAdapter implements PatchIdentityPort against a bare
 * mirror of the repository at `<stateDir>/mirrors/<repoDigest>.git`. It tells
 * the merge pass whether a `premerge` receipt may be carried from the old head
 * to the new head after a forge branch update: the three-dot patch-id of the
 * lane diff must be unchanged, and the update must touch no file of the lane's
 * diff (§3.3.1). Both facts are computed with allow-listed read-only git argv
 * through CommandExecutorPort with `cwd` set to the mirror; the live checkout
 * is never resolved or touched.
 */

import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';

import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  PatchIdentityPort,
  PatchIdentityRequest,
  PatchIdentityResult,
} from '../../application/ports/out/PatchIdentityPort.out-port.js';
import { LocalExecutor } from './LocalExecutor.adapter.js';

/** The mirror digest matches `MergeQueueEntryRecord.repoDigest` (12 lowercase hex). */
const DIGEST_PATTERN = /^[0-9a-f]{12}$/;
/** Every SHA argument is validated before it can touch argv. */
const SHA40_PATTERN = /^[0-9a-f]{40}$/;

export interface GitMirrorPatchIdentityAdapterOptions {
  readonly stateDir: string;
  /** Defaults to a local executor; tests inject a scripted one. */
  readonly executor?: CommandExecutorPort;
  /** Tests only: substitute the digest-derived mirror path. */
  readonly mirrorDirOverride?: string;
}

/** Pure decision helpers, exported so tests may call them directly. */
export function isValidRepositoryDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

export function isValidSha40(value: string): boolean {
  return SHA40_PATTERN.test(value);
}

/**
 * Positive wall-clock milliseconds remaining until `deadlineIso`, or null when
 * it is unparsable or already past. Null means no command may be issued.
 */
export function deadlineTimeoutMs(deadlineIso: string): number | null {
  const parsed = Date.parse(deadlineIso);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const remaining = parsed - Date.now();
  return remaining > 0 ? remaining : null;
}

/** A clean `git diff --patch-id` run: non-empty trimmed stdout, else null. */
export function parsePatchId(outcome: CommandRunResult): string | null {
  if (outcome.exitCode !== 0 || outcome.signal !== null || outcome.error !== undefined) {
    return null;
  }
  const trimmed = outcome.stdout.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A clean NUL-split `git diff --name-only -z` run, or null on failure. */
export function parseChangedFilesNul(outcome: CommandRunResult): readonly string[] | null {
  if (outcome.exitCode !== 0 || outcome.signal !== null || outcome.error !== undefined) {
    return null;
  }
  return outcome.stdout.split('\0').filter((entry) => entry.length > 0);
}

/** Paths present in both lists, in first-list order, each once. */
export function intersectPaths(first: readonly string[], second: readonly string[]): readonly string[] {
  const secondSet = new Set(second);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of first) {
    if (secondSet.has(entry) && !seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

export interface PatchIdentityFacts {
  readonly oldPatchId: string;
  readonly newPatchId: string;
  readonly overlapWithLaneDiff: readonly string[];
}

/**
 * The carry verdict for computed facts. Carry needs both the three-dot
 * patch-id guard (unchanged) and the §3.3.1 file rule (no lane file touched by
 * the update). The reason stays patch-id-centered: an unchanged patch id with a
 * non-empty overlap reports `patch-id-unchanged` with `carry: false`.
 */
export function carryVerdict(facts: PatchIdentityFacts): {
  carry: boolean;
  reason: 'patch-id-unchanged' | 'patch-id-changed';
} {
  if (facts.oldPatchId !== facts.newPatchId) {
    return { carry: false, reason: 'patch-id-changed' };
  }
  if (facts.overlapWithLaneDiff.length > 0) {
    return { carry: false, reason: 'patch-id-unchanged' };
  }
  return { carry: true, reason: 'patch-id-unchanged' };
}

function unknownResult(
  oldPatchId: string | null,
  newPatchId: string | null,
): {
  ok: true;
  carry: false;
  reason: 'unknown';
  oldPatchId: string | null;
  newPatchId: string | null;
  filesChangedByUpdate: readonly string[];
  overlapWithLaneDiff: readonly string[];
} {
  return {
    ok: true,
    carry: false,
    reason: 'unknown',
    oldPatchId,
    newPatchId,
    filesChangedByUpdate: [],
    overlapWithLaneDiff: [],
  };
}

export class GitMirrorPatchIdentityAdapter implements PatchIdentityPort {
  private readonly executor: CommandExecutorPort;
  private readonly stateDir: string;
  private readonly mirrorDirOverride: string | undefined;

  constructor(options: GitMirrorPatchIdentityAdapterOptions) {
    this.stateDir = options.stateDir;
    this.executor = options.executor ?? new LocalExecutor();
    this.mirrorDirOverride = options.mirrorDirOverride;
  }

  async lanePatchIdentity(request: PatchIdentityRequest): Promise<PatchIdentityResult> {
    if (!isValidRepositoryDigest(request.repositoryDigest)) {
      return { ok: false, reason: 'refused', code: 'bad-digest' };
    }
    if (
      !isValidSha40(request.baseSha) ||
      !isValidSha40(request.oldHeadSha) ||
      !isValidSha40(request.newHeadSha)
    ) {
      return { ok: false, reason: 'refused', code: 'bad-sha' };
    }
    const timeoutMs = deadlineTimeoutMs(request.deadlineIso);
    if (timeoutMs === null) {
      return unknownResult(null, null);
    }
    const mirror = await this.resolveMirror(request.repositoryDigest);
    if (mirror === null) {
      return { ok: false, reason: 'refused', code: 'no-mirror' };
    }
    if (!(await this.isBareMirror(mirror, timeoutMs))) {
      return { ok: false, reason: 'refused', code: 'no-mirror' };
    }
    const oldPatchId = await this.patchId(request.baseSha, request.oldHeadSha, mirror, timeoutMs);
    if (oldPatchId === null) {
      return unknownResult(null, null);
    }
    const newPatchId = await this.patchId(request.baseSha, request.newHeadSha, mirror, timeoutMs);
    if (newPatchId === null) {
      return unknownResult(oldPatchId, null);
    }
    const filesChangedByUpdate = await this.changedFiles(
      ['git', 'diff', '--name-only', '-z', request.oldHeadSha, request.newHeadSha],
      mirror,
      timeoutMs,
    );
    if (filesChangedByUpdate === null) {
      return unknownResult(oldPatchId, newPatchId);
    }
    const laneDiffFiles = await this.changedFiles(
      ['git', 'diff', '--name-only', '-z', `${request.baseSha}...${request.oldHeadSha}`],
      mirror,
      timeoutMs,
    );
    if (laneDiffFiles === null) {
      return {
        ok: true,
        carry: false,
        reason: 'unknown',
        oldPatchId,
        newPatchId,
        filesChangedByUpdate,
        overlapWithLaneDiff: [],
      };
    }
    const overlapWithLaneDiff = intersectPaths(laneDiffFiles, filesChangedByUpdate);
    const verdict = carryVerdict({ oldPatchId, newPatchId, overlapWithLaneDiff });
    return {
      ok: true,
      carry: verdict.carry,
      reason: verdict.reason,
      oldPatchId,
      newPatchId,
      filesChangedByUpdate,
      overlapWithLaneDiff,
    };
  }

  private async resolveMirror(digest: string): Promise<string | null> {
    const mirrorsRoot = join(this.stateDir, 'mirrors');
    const candidate = this.mirrorDirOverride ?? join(mirrorsRoot, `${digest}.git`);
    let rootReal: string;
    let mirrorReal: string;
    try {
      rootReal = await fs.realpath(mirrorsRoot);
      mirrorReal = await fs.realpath(candidate);
    } catch {
      return null;
    }
    if (mirrorReal === rootReal || !mirrorReal.startsWith(rootReal + sep)) {
      return null;
    }
    return mirrorReal;
  }

  private async isBareMirror(mirror: string, timeoutMs: number): Promise<boolean> {
    const outcome = await this.runGit(
      ['git', 'rev-parse', '--is-bare-repository'],
      mirror,
      timeoutMs,
    );
    if (outcome.exitCode !== 0 || outcome.signal !== null || outcome.error !== undefined) {
      return false;
    }
    return outcome.stdout.trim() === 'true';
  }

  private async patchId(
    base: string,
    head: string,
    mirror: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const outcome = await this.runGit(
      ['git', 'diff', '--patch-id', '--stable', `${base}...${head}`],
      mirror,
      timeoutMs,
    );
    return parsePatchId(outcome);
  }

  private async changedFiles(
    argv: readonly string[],
    mirror: string,
    timeoutMs: number,
  ): Promise<readonly string[] | null> {
    const outcome = await this.runGit(argv, mirror, timeoutMs);
    return parseChangedFilesNul(outcome);
  }

  private async runGit(
    argv: readonly string[],
    mirror: string,
    timeoutMs: number,
  ): Promise<CommandRunResult> {
    return this.executor.run(argv, { cwd: mirror, timeoutMs });
  }
}
