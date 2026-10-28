// Implemented use case — the edit-only commit step (work-execution, AG-4).
/**
 * CommitEditOnlyAttemptUseCase: run the edit-only commit step for one ended
 * attempt (plan §3.9.1; 2026-10-16 plan §D7, "Edit-only flow"). The conductor
 * calls it in `collecting`, before collection. The order is fixed:
 *
 * 1. the attempt must be ended with an authoritative receipt;
 * 2. HEAD unchanged since dispatch (or already this attempt's commit — the
 *    step is idempotent, so a crash between the commit and the journal entry
 *    is never a `head-moved` refusal);
 * 3. the frozen brief unchanged (prose + manifest digest);
 * 4. the lane diff check clean against the frozen allowed prefixes;
 * 5. `WorkspacePort.commitLaneOutput` commits the change set with the dispatch
 *    head as the only parent, by compare-and-swap, re-checking the staged
 *    paths against the same frozen prefixes.
 *
 * A diff finding is refused for the owner with path, line and rule name only
 * (a finding never falls back to another seat). An empty change set is left
 * to collection's no-commit rule. Anything unreadable is `unknown`, never an
 * established refusal. Full agy and opencode lanes commit themselves and are
 * `not-applicable` here. The commit is never pushed by this step.
 *
 * Verification is not part of the commit step: the gate (S2b) runs every
 * command right after collection, and a gate failure goes to a fix round or a
 * park. The commit exists only on the lane's local branch.
 */

import type { AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { LaneDiffCheckPort } from '../ports/out/LaneDiffCheckPort.out-port.js';
import { simpleDeterministicHexDigest } from './PrepareBriefPackageUseCase.use-case.js';
import type {
  CommitEditOnlyAttemptRequest,
  CommitEditOnlyAttemptResult,
} from '../ports/in/CommitEditOnlyAttemptPort.in-port.js';

export interface CommitEditOnlyAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: Pick<ExecutionJournalPort, 'appendJournalEntry' | 'listJournalEntriesForAttempt'>;
  readonly workspace: Pick<WorkspacePort, 'commitLaneOutput'>;
  readonly artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'>;
  /** The diff check on the attempt's recorded host; null when that host cannot be reached. */
  readonly laneDiffCheckFor: (attempt: AttemptRecord) => LaneDiffCheckPort | null;
  /** The recorded host's agy mode (D7): edit-only commits here; full and opencode lanes commit themselves. */
  readonly editOnlyModeOf: (attempt: AttemptRecord) => 'edit-only' | 'not-edit-only' | 'unknown';
  readonly policyProtectedPaths?: readonly string[];
  readonly computeDigest?: (content: string) => string;
}

/** One `collect` journal entry for this step; ids and actions are stored data. */
async function appendEditOnlyJournalEntry(
  journal: CommitEditOnlyAttemptDependencies['journal'],
  attempt: AttemptRecord,
  baseCommit: string,
  sessionId: string | null,
  nowIso: string,
  status: 'completed' | 'refused',
  detail: string,
): Promise<void> {
  const priorEntries = await journal.listJournalEntriesForAttempt(attempt.id);
  await journal.appendJournalEntry({
    id: `${attempt.id}:collect:${priorEntries.length + 1}`,
    attemptId: attempt.id,
    workOrderId: attempt.workOrderId,
    action: 'collect',
    baseCommit,
    recordedAtIso: nowIso,
    status,
    sessionId,
    detail,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class CommitEditOnlyAttemptUseCase {
  constructor(private readonly deps?: CommitEditOnlyAttemptDependencies) {}

  async commitEditOnlyAttempt(
    request: CommitEditOnlyAttemptRequest,
  ): Promise<CommitEditOnlyAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: CommitEditOnlyAttemptUseCase');
    }
    const deps = this.deps;

    // Step 1: the attempt must exist.
    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'refused', reason: 'attempt-missing', findings: [] };
    }

    // Step 2: only an edit-only agy seat commits here.
    const editOnly = deps.editOnlyModeOf(attempt);
    if (editOnly === 'not-edit-only') {
      return { outcome: 'not-applicable' };
    }
    if (editOnly === 'unknown') {
      return { outcome: 'unknown', reason: "the recorded host's agy mode is unknown" };
    }

    // Step 3: the attempt must be ended with an authoritative receipt.
    if (
      attempt.state !== 'ended' ||
      attempt.completionReceipt?.authoritative !== true
    ) {
      return { outcome: 'refused', reason: 'not-ended', findings: [] };
    }

    // Step 4: the dispatch head — a fix attempt's prior attempt head, else the base.
    let dispatchHead: string | null;
    if (attempt.kind === 'fix') {
      if (!attempt.priorAttemptId) {
        return { outcome: 'unknown', reason: 'the fix attempt records no prior attempt' };
      }
      const prior = await deps.attemptRepo.findAttemptById(attempt.priorAttemptId);
      const priorHead = prior?.artifacts?.headCommit;
      if (prior === null || prior === undefined || !isNonEmptyString(priorHead)) {
        return { outcome: 'unknown', reason: 'the prior attempt has no recorded head commit' };
      }
      dispatchHead = priorHead;
    } else {
      dispatchHead = attempt.baseCommit;
    }
    const baseCommitForEntry = attempt.baseCommit;
    const expectedHead = dispatchHead;
    const nowIso = request.nowIso ?? new Date().toISOString();

    // Step 5: the frozen brief must be unchanged, and its prefixes present.
    const brief = await this.readFrozenBrief(attempt);
    if (brief.outcome === 'unknown') {
      return brief;
    }
    const digest = (deps.computeDigest ?? simpleDeterministicHexDigest)(
      brief.prose + '\n' + brief.manifestRaw,
    );
    if (digest !== attempt.briefDigest) {
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'refused',
        'edit-only commit refused: brief-changed',
      );
      return { outcome: 'refused', reason: 'brief-changed', findings: [] };
    }
    const rawPrefixes: unknown = brief.manifest['allowedPathPrefixes'];
    if (
      !Array.isArray(rawPrefixes) ||
      rawPrefixes.length === 0 ||
      !rawPrefixes.every((item) => isNonEmptyString(item))
    ) {
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'refused',
        'edit-only commit refused: no-allowed-prefixes',
      );
      return { outcome: 'refused', reason: 'no-allowed-prefixes', findings: [] };
    }
    const allowedPathPrefixes = rawPrefixes as readonly string[];

    // Step 6: the lane diff check on the recorded host, with the same prefixes.
    const diffCheck = deps.laneDiffCheckFor(attempt);
    if (diffCheck === null) {
      return { outcome: 'unknown', reason: 'the recorded host cannot run the lane diff check' };
    }
    const diffVerdict = await diffCheck.checkLaneDiff({
      worktreePath: attempt.worktreePath,
      baseCommit: attempt.baseCommit,
      allowedPathPrefixes,
      policyProtectedPaths: deps.policyProtectedPaths,
    });
    if (diffVerdict.outcome === 'error') {
      // Fixed text: an adapter reason never reaches the result.
      return { outcome: 'unknown', reason: 'the lane diff check could not run' };
    }
    if (diffVerdict.outcome === 'findings') {
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'refused',
        'edit-only commit refused: ' +
          diffVerdict.findings.length +
          ' diff-check finding(s)',
      );
      return {
        outcome: 'refused',
        reason: 'diff-findings',
        findings: diffVerdict.findings,
      };
    }

    // Step 7: the workspace commit. The commit re-checks the staged paths
    // against the same frozen prefixes (AG-1 fix 1), so a file written after
    // the diff check and outside them is refused by the commit itself.
    const implementerModel = attempt.runner?.model;
    if (!isNonEmptyString(implementerModel)) {
      return { outcome: 'unknown', reason: 'the attempt records no runner model' };
    }
    if (deps.workspace.commitLaneOutput === undefined) {
      return { outcome: 'unknown', reason: 'the workspace cannot commit lane output' };
    }
    const commitResult = await deps.workspace.commitLaneOutput({
      worktreePath: attempt.worktreePath,
      expectedHead,
      attemptId: attempt.id,
      implementerModel,
      allowedPathPrefixes,
      recordedHost: attempt.runner ?? null,
    });

    // Step 8: map the commit result; every outcome journals under `collect`.
    if (commitResult.outcome === 'committed') {
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'completed',
        'edit-only commit ' + commitResult.headCommit.slice(0, 12),
      );
      return {
        outcome: 'committed',
        headCommit: commitResult.headCommit,
        alreadyCommitted: false,
      };
    }
    if (commitResult.outcome === 'already-committed') {
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'completed',
        'edit-only commit already present ' + commitResult.headCommit.slice(0, 12),
      );
      return {
        outcome: 'committed',
        headCommit: commitResult.headCommit,
        alreadyCommitted: true,
      };
    }
    if (commitResult.outcome === 'nothing-to-commit') {
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'completed',
        'edit-only commit: nothing to commit',
      );
      return { outcome: 'nothing-to-commit' };
    }
    if (commitResult.outcome === 'refused') {
      const reason = commitResult.reason;
      if (reason === 'invalid-request') {
        return { outcome: 'unknown', reason: 'the workspace refused the commit request' };
      }
      await appendEditOnlyJournalEntry(
        deps.journal,
        attempt,
        baseCommitForEntry,
        attempt.sessionId ?? null,
        nowIso,
        'refused',
        'edit-only commit refused: ' + reason,
      );
      return { outcome: 'refused', reason, findings: [] };
    }
    return { outcome: 'unknown', reason: 'the edit-only commit could not complete' };
  }

  /**
   * Read the frozen brief prose and manifest through the artifact port. Either
   * method missing, a throw or a null is `unknown`; the parsed manifest is
   * returned with the raw text. Nothing else is established by this read.
   */
  private async readFrozenBrief(
    attempt: AttemptRecord,
  ): Promise<
    | { readonly outcome: 'unknown'; readonly reason: string }
    | {
        readonly outcome: 'ok';
        readonly prose: string;
        readonly manifestRaw: string;
        readonly manifest: Record<string, unknown>;
      }
  > {
    if (!isNonEmptyString(attempt.briefPackagePath)) {
      return { outcome: 'unknown', reason: 'the attempt records no frozen brief package path' };
    }
    const artifactPort = this.deps!.artifactPort;
    if (artifactPort.readBriefFile === undefined || artifactPort.readBriefManifest === undefined) {
      return { outcome: 'unknown', reason: 'no artifact port can read the frozen brief' };
    }
    let prose: string | null;
    let manifestRaw: string | null;
    try {
      prose = await artifactPort.readBriefFile(
        attempt.worktreePath,
        attempt.briefPackagePath,
        attempt.runner ?? null,
      );
      manifestRaw = await artifactPort.readBriefManifest(
        attempt.worktreePath,
        attempt.briefPackagePath.replace(/\.md$/, '-manifest.json'),
        attempt.runner ?? null,
      );
    } catch {
      return { outcome: 'unknown', reason: 'reading the frozen brief failed' };
    }
    if (prose === null || manifestRaw === null) {
      return { outcome: 'unknown', reason: 'the frozen brief is missing' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      return { outcome: 'unknown', reason: 'the frozen brief manifest is not JSON' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { outcome: 'unknown', reason: 'the frozen brief manifest is not a JSON object' };
    }
    return {
      outcome: 'ok',
      prose,
      manifestRaw,
      manifest: parsed as Record<string, unknown>,
    };
  }
}
