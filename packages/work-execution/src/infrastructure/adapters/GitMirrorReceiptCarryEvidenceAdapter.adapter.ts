// @generated adapter scaffold — refined for U6 (receipt carry).
/**
 * GitMirrorReceiptCarryEvidenceAdapter implements ReceiptCarryEvidencePort
 * against the bare mirror at `<stateDir>/mirrors/<repoDigest>.git`, with
 * allow-listed read-only git argv through CommandExecutorPort and `cwd` set to
 * the mirror. It changes no ref and no working tree; the one write is the
 * unreferenced tree object `git merge-tree --write-tree` creates in the
 * mirror's object store, which `git gc` prunes. Every failure maps to a `null` evidence field, which the pure
 * qualifier reads as "unknown evidence" (the run keeps waiting); nothing here
 * throws or decides a carry.
 */

import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';

import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  ReceiptCarryEvidencePort,
  ReceiptCarryEvidenceRequest,
  ReceiptCarryEvidenceResult,
} from '../../application/ports/out/ReceiptCarryEvidencePort.out-port.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import { LocalExecutor } from './LocalExecutor.adapter.js';
import {
  commandRemainingTimeoutMs,
  isValidRepositoryDigest,
  isValidSha40,
  parseChangedFilesNul,
} from './GitMirrorPatchIdentityAdapter.adapter.js';

export interface GitMirrorReceiptCarryEvidenceAdapterOptions {
  readonly stateDir: string;
  /** Defaults to a local executor; tests inject a scripted one. */
  readonly executor?: CommandExecutorPort;
  /** Tests only: substitute the digest-derived mirror path. */
  readonly mirrorDirOverride?: string;
}

function cleanRun(outcome: CommandRunResult | null): outcome is CommandRunResult {
  return outcome !== null && outcome.signal === null && outcome.error === undefined;
}

export class GitMirrorReceiptCarryEvidenceAdapter implements ReceiptCarryEvidencePort {
  private readonly executor: CommandExecutorPort;
  private readonly stateDir: string;
  private readonly mirrorDirOverride: string | undefined;

  constructor(options: GitMirrorReceiptCarryEvidenceAdapterOptions) {
    this.stateDir = options.stateDir;
    this.executor = options.executor ?? new LocalExecutor();
    this.mirrorDirOverride = options.mirrorDirOverride;
  }

  async readCarryEvidence(request: ReceiptCarryEvidenceRequest): Promise<ReceiptCarryEvidenceResult> {
    try {
      return await this.read(request);
    } catch {
      return unknown(null);
    }
  }

  private async read(request: ReceiptCarryEvidenceRequest): Promise<ReceiptCarryEvidenceResult> {
    if (!isValidRepositoryDigest(request.repositoryDigest)) {
      return { ok: false, reason: 'refused', code: 'bad-digest' };
    }
    if (!isValidSha40(request.reviewedHeadSha) || !isValidSha40(request.newHeadSha)) {
      return { ok: false, reason: 'refused', code: 'bad-sha' };
    }
    if (parseBaseBranch(request.baseBranch) === undefined) {
      return { ok: false, reason: 'refused', code: 'bad-base' };
    }
    if (commandRemainingTimeoutMs(request.deadlineIso) === null) {
      return unknown(null);
    }
    const mirror = await this.resolveMirror(request.repositoryDigest);
    if (mirror === null) {
      return { ok: false, reason: 'refused', code: 'no-mirror' };
    }
    const bare = await this.runGit(['git', 'rev-parse', '--is-bare-repository'], mirror, request.deadlineIso);
    if (!cleanRun(bare) || bare.exitCode !== 0 || bare.stdout.trim() !== 'true') {
      return bare !== null && cleanRun(bare) && bare.exitCode === 0
        ? { ok: false, reason: 'refused', code: 'no-mirror' }
        : unknown(null);
    }
    const baseRef = `refs/heads/${request.baseBranch}`;
    const parents = await this.parentsOf(request.newHeadSha, mirror, request.deadlineIso);
    const newHeadTreeSha = await this.singleSha(
      ['git', 'rev-parse', `${request.newHeadSha}^{tree}`], mirror, request.deadlineIso,
    );
    const prChangedPaths = await this.changedPaths(
      ['git', 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
        `${baseRef}...${request.newHeadSha}`, '--'],
      mirror, request.deadlineIso,
    );
    const second = parents !== null && parents.length === 2 ? (parents[1] as string) : null;
    if (second === null) {
      return { ...unknown(parents), newHeadTreeSha, prChangedPaths };
    }
    const secondParentOnBase = await this.isAncestor(second, baseRef, mirror, request.deadlineIso);
    const mainRangeBaseSha = await this.singleSha(
      ['git', 'merge-base', request.reviewedHeadSha, second], mirror, request.deadlineIso,
    );
    const automaticMergeTreeSha = await this.mergeTree(request.reviewedHeadSha, second, mirror, request.deadlineIso);
    return {
      ok: true,
      newHeadParents: parents,
      secondParentOnBase,
      mainRangeBaseSha,
      automaticMergeTreeSha,
      newHeadTreeSha,
      prChangedPaths,
    };
  }

  private async parentsOf(sha: string, mirror: string, deadlineIso: string): Promise<readonly string[] | null> {
    const outcome = await this.runGit(['git', 'rev-list', '--parents', '-n', '1', sha], mirror, deadlineIso);
    if (!cleanRun(outcome) || outcome.exitCode !== 0) {
      return null;
    }
    const tokens = outcome.stdout.trim().split(/\s+/);
    const [self, ...parents] = tokens;
    if (self !== sha || !parents.every(isValidSha40)) {
      return null;
    }
    return parents;
  }

  private async singleSha(argv: readonly string[], mirror: string, deadlineIso: string): Promise<string | null> {
    const outcome = await this.runGit(argv, mirror, deadlineIso);
    if (!cleanRun(outcome) || outcome.exitCode !== 0) {
      return null;
    }
    const first = outcome.stdout.trim().split('\n')[0] ?? '';
    return isValidSha40(first) ? first : null;
  }

  private async isAncestor(ancestor: string, ref: string, mirror: string, deadlineIso: string): Promise<boolean | null> {
    const outcome = await this.runGit(['git', 'merge-base', '--is-ancestor', ancestor, ref], mirror, deadlineIso);
    if (!cleanRun(outcome)) {
      return null;
    }
    if (outcome.exitCode === 0) {
      return true;
    }
    return outcome.exitCode === 1 ? false : null;
  }

  /** The tree of the clean automatic merge; a conflict (exit 1), an error or a malformed answer is null. */
  private async mergeTree(first: string, second: string, mirror: string, deadlineIso: string): Promise<string | null> {
    const outcome = await this.runGit(['git', 'merge-tree', '--write-tree', first, second], mirror, deadlineIso);
    if (!cleanRun(outcome) || outcome.exitCode !== 0) {
      return null;
    }
    const line = outcome.stdout.split('\n')[0] ?? '';
    return isValidSha40(line.trim()) ? line.trim() : null;
  }

  private async changedPaths(argv: readonly string[], mirror: string, deadlineIso: string): Promise<readonly string[] | null> {
    const outcome = await this.runGit(argv, mirror, deadlineIso);
    return outcome === null ? null : parseChangedFilesNul(outcome);
  }

  private async resolveMirror(digest: string): Promise<string | null> {
    const mirrorsRoot = join(this.stateDir, 'mirrors');
    const expected = join(mirrorsRoot, `${digest}.git`);
    const candidate = this.mirrorDirOverride ?? expected;
    try {
      const rootReal = await fs.realpath(mirrorsRoot);
      const mirrorReal = await fs.realpath(candidate);
      const expectedReal = await fs.realpath(expected);
      if (mirrorReal === rootReal || !mirrorReal.startsWith(rootReal + sep) || mirrorReal !== expectedReal) {
        return null;
      }
      return mirrorReal;
    } catch {
      return null;
    }
  }

  private async runGit(argv: readonly string[], mirror: string, deadlineIso: string): Promise<CommandRunResult | null> {
    const timeoutMs = commandRemainingTimeoutMs(deadlineIso);
    if (timeoutMs === null) {
      return null;
    }
    try {
      return await this.executor.run(argv, { cwd: mirror, timeoutMs });
    } catch {
      return null;
    }
  }
}

function unknown(parents: readonly string[] | null): Extract<ReceiptCarryEvidenceResult, { ok: true }> {
  return {
    ok: true,
    newHeadParents: parents,
    secondParentOnBase: null,
    mainRangeBaseSha: null,
    automaticMergeTreeSha: null,
    newHeadTreeSha: null,
    prChangedPaths: null,
  };
}
