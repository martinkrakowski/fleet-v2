// @generated adapter scaffold — implemented for migration station O3 (reviewed git subprocesses).
/**
 * WorkspaceAdapter implements WorkspacePort. It inspects a Git worktree as a
 * typed record through reviewed `git` subprocesses; every read leaves the
 * worktree untouched (no resets, no checkouts, no cleanup) and the one write
 * is `commitLaneOutput`: stage, `commit-tree`, `update-ref` by
 * compare-and-swap; never a push, a reset or a checkout. Unreadable state is
 * an error, never a silent guess.
 *
 * Every command runs through the configured `CommandExecutorPort` (local or
 * ssh) with an explicit wall-clock budget: git commands, existence probes
 * and file reads each get 60 s; a run that exceeds its budget is killed and
 * reported as a failure, never a success. The former direct `sshHost` seam
 * is gone: transport selection is the
 * executor's job, made once from the installation configuration and not
 * re-decided here per call. In particular, once a worktree ssh host is
 * configured, git runs through that ssh transport even when the worktree
 * path also exists locally — the legacy `existsSync` probe is no longer part
 * of the transport decision (documented, tested change).
 */

import * as path from 'node:path';

import {
  WorktreePathRefusedError,
  type ResolveBaseTipRequest,
  type ResolveBaseTipResult,
  type WorktreeInspection,
  type WorktreeInspectionRequest,
  type WorkspacePort,
} from '../../application/ports/out/WorkspacePort.out-port.js';
import type {
  ArtifactManifestRemovalCheckResult,
  VerifyArtifactManifestRequest,
} from '../../application/ports/out/AttemptArtifactPort.out-port.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import { LANE_DIFF_SECRET_PATTERNS, containsSecretShape } from '@fleet/shared';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { CommandRunResult } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
import { isFixedProtectedPath, pathUnderPrefix } from '../../domain/lane-diff-check.js';
import type { ExecutorForRecordedHostResult } from './ExecutorForHost.helper.js';
import { resolvePhysicalPath } from './ResolvePhysicalPath.helper.js';
import { isValidAgyModel } from './AgyRunnerAdapter.adapter.js';
import type {
  CommitLaneOutputRequest,
  CommitLaneOutputResult,
  InspectWorktreeForRemovalRequest,
  InspectWorktreeForRemovalResult,
  ListWorktreesRequest,
  ListWorktreesResult,
  PrepareLaneWorktreeRequest,
  PrepareLaneWorktreeResult,
  PreserveWorktreeEditsRequest,
  PreserveWorktreeEditsResult,
  ReadFilesystemSpaceRequest,
  ReadFilesystemSpaceResult,
  RemoveLaneWorktreeRequest,
  RemoveLaneWorktreeResult,
  RemoveWorktreeManifestCheck,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  ResetWorktreeToHeadRequest,
  ResetWorktreeToHeadResult,
  VerifySavedPatchRequest,
  WorktreeLastActivity,
  WorktreeStatusCounts,
} from '../../application/ports/out/WorkspacePort.out-port.js';
import { runnerHasHostName } from '../../domain/execution-records.js';
import { SEALED_MANIFEST_PATH_PATTERN } from '../../domain/artifact-manifest.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import { AttemptArtifactAdapter } from './AttemptArtifactAdapter.adapter.js';

/**
 * Adapter-layer helper for resolving one caller-supplied path against a
 * worktree root. This is the single containment point for every worktree
 * target path built from caller input: the worktree must be an absolute
 * path that is not the filesystem root, an absolute candidate is accepted
 * only when it lies inside the worktree itself, and the resulting relative
 * candidate must pass the domain check before anything is joined and run.
 */

/**
 * Resolve one target path under `worktreePath`. Returns the absolute target
 * path, or throws `WorktreePathRefusedError` before any command runs.
 *
 * - The worktree root is stripped of trailing slashes; an empty result
 *   (`/`, `//`, `''`) or a relative worktree path is refused.
 * - An absolute candidate is rewritten to its worktree-relative form when it
 *   starts with `root + '/'`; any other absolute candidate is refused.
 * - The relative candidate must pass `validateWorktreeRelativePath`.
 */
export function resolveWorktreeTarget(worktreePath: string, candidate: string): string {
  const rootRefusal = worktreeRootRefusal(worktreePath);
  if (rootRefusal !== null) {
    throw new WorktreePathRefusedError(candidate, rootRefusal);
  }
  const trimmedWorktreeRoot = worktreePath.replace(/\/+$/, '');
  let relative = candidate;
  if (relative.startsWith('/') && relative.startsWith(`${trimmedWorktreeRoot}/`)) {
    relative = relative.slice(trimmedWorktreeRoot.length + 1);
  }
  const refusedReason = validateWorktreeRelativePath(relative);
  if (refusedReason !== null) {
    throw new WorktreePathRefusedError(candidate, refusedReason);
  }
  return path.join(worktreePath, relative);
}

/**
 * The worktree-root check alone: returns a reason string when `worktreePath`
 * is not an absolute path that is not the filesystem root, and null when the
 * containment prefix is sound. Callers that never derive a file target from
 * the worktree (for example brief placement, which joins only fixed `.lane`
 * names) use this instead of the full resolution.
 */
export function worktreeRootRefusal(worktreePath: string): string | null {
  const trimmed = worktreePath.replace(/\/+$/, '');
  if (trimmed === '' || !worktreePath.startsWith('/')) {
    return 'worktree path must be an absolute path that is not the filesystem root';
  }
  return null;
}

function stripTrailingSlashes(entry: string): string {
  let end = entry.length;
  while (end > 0 && entry[end - 1] === '/') {
    end -= 1;
  }
  return entry.slice(0, end);
}

function pathOrAncestorInSet(path: string, set: ReadonlySet<string>): boolean {
  let prefix = path;
  for (;;) {
    if (set.has(prefix)) return true;
    const slash = prefix.lastIndexOf('/');
    if (slash === -1) break;
    prefix = prefix.slice(0, slash);
  }
  return false;
}

/**
 * GB3: true when restoring the tracked `trackedPaths` (the paths `git reset
 * --hard` would write) could overwrite or remove an untracked path in
 * `untrackedFiles`. The dangerous shapes are a tracked path masked by an
 * untracked file or directory at that path or above it, and an untracked path
 * sitting at a tracked path or below one: in both cases reset would have to
 * replace or delete the untracked entry to restore the tracked one.
 */
export function resetWouldDestroyUntracked(
  trackedPaths: readonly string[],
  untrackedFiles: readonly string[],
): boolean {
  const untracked = new Set(untrackedFiles);
  for (const tracked of trackedPaths) {
    if (pathOrAncestorInSet(tracked, untracked)) {
      return true;
    }
  }
  const trackedSet = new Set(trackedPaths);
  for (const untrackedFile of untrackedFiles) {
    if (pathOrAncestorInSet(untrackedFile, trackedSet)) {
      return true;
    }
  }
  return false;
}

export interface WorkspaceAdapterOptions {
  /**
   * Executor owning the worktree's host commands. Every git command,
   * existence probe and file read runs through it, locally or over the ssh
   * transport the executor carries.
   */
  readonly executor?: CommandExecutorPort;
  /**
   * H9b2. When given, a request carrying a recorded runner block (reads,
   * brief placement, manifest sealing, worktree prepare and commit) goes
   * through this helper, which confirms a named host, resolves an alias-only
   * record through the installation or refuses it (D2), and keeps the legacy
   * executor otherwise. A request with no recorded block (manual prepare)
   * keeps `executor`.
   */
  readonly executorForRecordedHost?: (
    recorded: AttemptRunnerRecord | null | undefined,
  ) => ExecutorForRecordedHostResult;
  /**
   * C2': the fail-closed artifact-manifest check behind `removeWorktree`'s
   * manifest gate. When omitted, the adapter builds its own
   * `AttemptArtifactAdapter` over the same executors and answers through
   * `checkArtifactManifestForRemoval`.
   */
  readonly checkArtifactManifest?: (
    request: VerifyArtifactManifestRequest,
  ) => Promise<ArtifactManifestRemovalCheckResult>;
}

/** Residue markers a previous attempt may have left in the worktree. */
const laneResidueFiles = ['.lane/brief.md', '.lane/brief-manifest.json', '.lane/notes.md'];

/** Wall-clock budget for one read-only git command in the worktree. */
const GIT_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for the base-commit fetch when the clone lacks it. */
const GIT_FETCH_TIMEOUT_MS = 120 * 1000;

/** Wall-clock budget for one existence probe (`test -e`). */
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for one file read (`cat`). */
const CAT_TIMEOUT_MS = 60 * 1000;

/** Porcelain status pairs that mean a path is in a merge state, never counted as tracked. */
const UNMERGED_STATUS_PAIRS = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

/** The in-progress operation files probed in a worktree's git directory, in probe order. */
const IN_PROGRESS_OPERATION_FILES = [
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
];

/** The commit's argv hardening (2026-10-16 plan, step 4): no hooks, no signing, no fsmonitor. */
const COMMIT_GIT_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'core.fsmonitor=false',
];

/**
 * K7-5a: the branch a lane run's worktree is created on — 'fleet/' + runId,
 * where the run id is 'run-' + a 25-character ULID (Crockford alphabet,
 * first character 0–7).
 */
const LANE_RUN_BRANCH_PATTERN = /^fleet\/run-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** K7-5a: the work order's base commit, 40 lowercase hex. */
const BASE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * K7-5a validation: whether `value` is an absolute, normalised path — no
 * `..` or `.` segments, no doubled or trailing slash, no NUL, not the
 * filesystem root. Fixed refusal reasons only; the path is never echoed.
 */
function isAbsoluteNormalisedPath(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.includes('\0')) {
    return false;
  }
  if (value.includes('//') || value.endsWith('/')) {
    return false;
  }
  return value
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * K7-5a validation of one `prepareLaneWorktree` request, before any command
 * runs: both paths absolute and normalised, the worktree path outside the
 * clone, the branch a lane-run branch and the base a 40-hex commit.
 */
export function prepareLaneWorktreeRequestIsValid(request: PrepareLaneWorktreeRequest): boolean {
  const { clonePath, worktreePath, branch, baseCommit } = request;
  if (!isAbsoluteNormalisedPath(clonePath) || !isAbsoluteNormalisedPath(worktreePath)) {
    return false;
  }
  if (worktreePath === clonePath || worktreePath.startsWith(`${clonePath}/`)) {
    return false;
  }
  return LANE_RUN_BRANCH_PATTERN.test(branch) && BASE_COMMIT_PATTERN.test(baseCommit);
}

/**
 * EX-2a validation of one `removeLaneWorktree` request, before any command
 * runs: the recorded host is named, all three paths are absolute and
 * normalised, the worktree path sits directly under the worktree root, it is
 * neither equal to nor inside the clone, and the branch is a lane-run
 * branch.
 */
export function removeLaneWorktreeRequestIsValid(request: RemoveLaneWorktreeRequest): boolean {
  const { clonePath, worktreeRoot, worktreePath, branch, recordedHost } = request;
  if (!runnerHasHostName(recordedHost)) {
    return false;
  }
  if (
    !isAbsoluteNormalisedPath(clonePath) ||
    !isAbsoluteNormalisedPath(worktreeRoot) ||
    !isAbsoluteNormalisedPath(worktreePath)
  ) {
    return false;
  }
  if (!worktreePath.startsWith(`${worktreeRoot}/`)) {
    return false;
  }
  if (worktreePath === clonePath || worktreePath.startsWith(`${clonePath}/`)) {
    return false;
  }
  return LANE_RUN_BRANCH_PATTERN.test(branch);
}

/**
 * KW3' (conductor plan §3.10.3) path validation of one `removeWorktree`
 * request, before any command runs: all three paths are absolute and
 * normalised, the worktree path sits strictly under the worktree root, and it
 * is neither equal to nor inside the clone. A path problem is refused as
 * `path-refused`. This is the lexical pre-command check; containment against
 * the resolved physical paths is enforced again in `removeCheckedListedWorktree`
 * after the listed entry is found, so a symlink inside the root pointing at a
 * worktree outside it is still refused.
 */
function removeWorktreePathRefusal(request: RemoveWorktreeRequest): boolean {
  const { repositoryRoot, worktreeRoot, worktreePath } = request;
  if (
    !isAbsoluteNormalisedPath(repositoryRoot) ||
    !isAbsoluteNormalisedPath(worktreeRoot) ||
    !isAbsoluteNormalisedPath(worktreePath)
  ) {
    return true;
  }
  if (!worktreePath.startsWith(`${worktreeRoot}/`)) {
    return true;
  }
  return worktreePath === repositoryRoot || worktreePath.startsWith(`${repositoryRoot}/`);
}

/**
 * KW3' (conductor plan §3.10.3) non-path validation of one `removeWorktree`
 * request: the recorded host is named, `expectedHead` is a real commit sha
 * (40 or 64 lowercase hex, not all zeros), `expectedBranch` is a non-empty
 * branch that is not `main`, and `expectedLastActivityIso` is either null (no
 * activity was readable under the caller's hold) or an ISO-8601 UTC instant with milliseconds (the form `toISOString` writes). Any
 * other malformed request is refused as `invalid-request`.
 */
/** True when `value` is exactly what `toISOString` writes, so no calendar date was normalised. */
function isCanonicalIsoInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function removeWorktreeRequestIsValid(request: RemoveWorktreeRequest): boolean {
  const { expectedHead, expectedBranch, expectedLastActivityIso, recordedHost, repositoryRoot, worktreeRoot, worktreePath } = request;
  if (!runnerHasHostName(recordedHost)) {
    return false;
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedHead) || /^0+$/.test(expectedHead)) {
    return false;
  }
  if (typeof expectedBranch !== 'string' || expectedBranch === '' || expectedBranch === 'main') {
    return false;
  }
  if (
    expectedLastActivityIso !== null &&
    (typeof expectedLastActivityIso !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expectedLastActivityIso) ||
      !isCanonicalIsoInstant(expectedLastActivityIso))
  ) {
    return false;
  }
  // C2': every input is size-bounded before any command runs.
  if (
    typeof repositoryRoot !== 'string' ||
    repositoryRoot.length > 4096 ||
    typeof worktreeRoot !== 'string' ||
    worktreeRoot.length > 4096 ||
    typeof worktreePath !== 'string' ||
    worktreePath.length > 4096 ||
    expectedBranch.length > 256
  ) {
    return false;
  }
  return true;
}

/**
 * C2': a bounded, path-free approval reference: non-empty, at most 256
 * characters, no `/`, no `\`, no whitespace or control characters, and never
 * a secret-shaped string.
 */
function isValidApprovalReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/[\s\p{C}]/u.test(value) &&
    !containsSecretShape(value) &&
    !LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(value))
  );
}

/**
 * C2': validation of the manifest coordinates one `removeWorktree` request is
 * gated on. `uncollected` is valid as-is; `sealed` must carry a
 * content-addressed manifest path whose embedded digest slice matches the
 * recorded digest; `force-unsealed` must carry a bounded attempt id and a
 * clean approval reference; anything else is `invalid-request`.
 */
function removeWorktreeManifestIsValid(manifest: unknown): boolean {
  let snap: Partial<Record<keyof RemoveWorktreeManifestCheck, unknown>> & Record<string, unknown>;
  try {
    // Descriptor-safe snapshot: an accessor or a throwing getter reads as invalid.
    const read = snapshotPlainDataRecord(manifest);
    if (read === null) {
      return false;
    }
    snap = read;
  } catch {
    return false;
  }
  const attemptIdOk = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !value.includes('/') && !value.includes('\0');
  if (snap.kind === 'uncollected') {
    return true;
  }
  if (snap.kind === 'sealed') {
    const match =
      typeof snap.manifestPath === 'string' ? SEALED_MANIFEST_PATH_PATTERN.exec(snap.manifestPath) : null;
    return (
      attemptIdOk(snap.attemptId) &&
      typeof snap.manifestPath === 'string' &&
      match !== null &&
      typeof snap.expectedManifestSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(snap.expectedManifestSha256) &&
      match[1] === snap.expectedManifestSha256.slice(0, 16)
    );
  }
  if (snap.kind === 'force-unsealed') {
    return attemptIdOk(snap.attemptId) && isValidApprovalReference(snap.approvalReference);
  }
  return false;
}

/**
 * C2': a descriptor-safe snapshot of one `removeWorktree` request. A null, a
 * non-object or a request with a throwing getter reads as null; the caller
 * answers `invalid-request` and never throws.
 */
function snapshotRemoveWorktreeRequest(request: unknown): RemoveWorktreeRequest | null {
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(request);
  } catch {
    return null;
  }
  if (snap === null) {
    return null;
  }
  return snap as unknown as RemoveWorktreeRequest;
}

/**
 * C2': the hardened prefix every git read inside `removeWorktree` runs under:
 * no protocol transport, no lazy fetch, no terminal prompt, no optional
 * locks, no hooks, no fsmonitor. Reads only — the removal itself stays the
 * plain five-argv `git worktree remove`.
 */
const REMOVAL_GIT_READ_PREFIX = [
  'env',
  'GIT_ALLOW_PROTOCOL=none',
  'GIT_NO_LAZY_FETCH=1',
  'GIT_TERMINAL_PROMPT=0',
  'git',
  '--no-optional-locks',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
] as const;

/** C2': the bounded output buffer of one hardened git read. */
const REMOVAL_READ_MAX_BUFFER_BYTES = 1_048_576;

/**
 * C2': one hardened git read. A thrown executor rejection is answered as an
 * unanswered `CommandRunResult` (`exitCode: null`), which every caller reads
 * as unknown — it never propagates and never embeds stderr.
 */
async function runRemovalGitRead(
  executor: CommandExecutorPort,
  repoOrWorktreePath: string,
  gitArgs: readonly string[],
): Promise<CommandRunResult> {
  try {
    return await executor.run(
      [...REMOVAL_GIT_READ_PREFIX, '-C', repoOrWorktreePath, ...gitArgs],
      { timeoutMs: GIT_TIMEOUT_MS, maxBufferBytes: REMOVAL_READ_MAX_BUFFER_BYTES },
    );
  } catch {
    return { signal: null, stdout: '', stderr: '', exitCode: null, error: 'executor-threw' };
  }
}

/**
 * C2': the executor the removal's activity reads run through: every `git -C`
 * argv is rewritten onto the hardened read prefix, and every other subprocess
 * call is bounded. Only the removal path uses this wrapper, so
 * `inspectWorktreeForRemoval` and `removeLaneWorktree` keep their argv.
 */
function removalActivityExecutor(executor: CommandExecutorPort): CommandExecutorPort {
  return {
    run: async (argv, options) => {
      if (argv[0] === 'git' && argv[1] === '-C' && typeof argv[2] === 'string') {
        return runRemovalGitRead(executor, argv[2], argv.slice(3));
      }
      return executor.run(argv, {
        ...(options ?? {}),
        ...(options?.maxBufferBytes === undefined ? { maxBufferBytes: REMOVAL_READ_MAX_BUFFER_BYTES } : {}),
      });
    },
  };
}

/** One entry of `git worktree list --porcelain`, as far as this adapter reads it. */
interface ListedWorktreeEntry {
  readonly path: string;
  /** The entry's `HEAD` sha, or null when the list did not carry one. */
  readonly head: string | null;
  /** The checked-out branch without `refs/heads/`, or null when detached. */
  readonly branch: string | null;
  readonly locked: boolean;
  /** The administrative entry is stale (`prunable <reason>`); never pruned here. */
  readonly prunable: boolean;
}

function isIgnoredPorcelainLine(line: string): boolean {
  return (
    line === 'bare' ||
    line === 'detached' ||
    line.startsWith('branch ') ||
    line === 'annotation' ||
    line.startsWith('annotation ')
  );
}

function applyPorcelainAttribute(
  current: ListedWorktreeEntry,
  line: string,
): ListedWorktreeEntry | null {
  if (line.startsWith('HEAD ')) {
    return { ...current, head: line.slice('HEAD '.length).trim() };
  }
  if (line.startsWith('branch refs/heads/')) {
    return {
      ...current,
      branch: unquotePorcelainPath(line.slice('branch refs/heads/'.length).trim()),
    };
  }
  if (line === 'locked' || line.startsWith('locked ')) {
    return { ...current, locked: true };
  }
  if (line === 'prunable' || line.startsWith('prunable ')) {
    return { ...current, prunable: true };
  }
  if (isIgnoredPorcelainLine(line)) {
    return current;
  }
  return null;
}

/**
 * Strict-enough parse of `git worktree list --porcelain`: entries split on
 * blank lines, each starting with `worktree <path>`, optionally followed by
 * `HEAD <sha>`, `branch refs/heads/<name>` or `detached`, and an optional
 * `locked` (with or without a reason).
 */
export function parseWorktreeList(stdout: string): ListedWorktreeEntry[] | null {
  if (stdout.trim() === '') return null;
  const entries: ListedWorktreeEntry[] = [];
  let current: ListedWorktreeEntry | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      const rawPath = line.slice('worktree '.length).trim();
      if (rawPath === '') return null;
      current = {
        path: unquotePorcelainPath(rawPath),
        head: null,
        branch: null,
        locked: false,
        prunable: false,
      };
      entries.push(current);
      continue;
    }
    if (current === null) return null;
    const updated = applyPorcelainAttribute(current, line);
    if (updated === null) return null;
    current = updated;
    entries[entries.length - 1] = current;
  }
  return entries.length > 0 ? entries : null;
}

/** The listed entry whose path is exactly `targetPath`, or null. */
function listedWorktreeAt(entries: readonly ListedWorktreeEntry[], targetPath: string): ListedWorktreeEntry | null {
  return entries.find((entry) => entry.path === targetPath) ?? null;
}

/** The outcome of resolving one worktree path in the clone's `worktree list`. */
type ListedLaneWorktree =
  | { readonly kind: 'entry'; readonly entry: ListedWorktreeEntry }
  | { readonly kind: 'not-listed' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'refused' };

/**
 * One extracted step of `commitLaneOutput`: either the step's data, or the
 * result that ends the method (`failure`).
 */
type LaneCommitStep<T> = { readonly data: T } | { readonly failure: CommitLaneOutputResult };

/**
 * Step 3 of `removeLaneWorktree`: find the worktree — git must list the
 * path (or its physical form) as a worktree of this clone. A failed or
 * exit-code-less list is `unknown`, a non-zero exit is `refused`, an
 * unparsable listing is `unknown`.
 */
async function listedLaneWorktree(
  executor: CommandExecutorPort,
  clonePath: string,
  worktreePath: string,
): Promise<ListedLaneWorktree> {
  const listRun = await executor.run(
    ['git', '-C', clonePath, 'worktree', 'list', '--porcelain'],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (listRun.exitCode === null || listRun.error !== undefined) {
    return { kind: 'unknown' };
  }
  if (listRun.exitCode !== 0) {
    return { kind: 'refused' };
  }
  const listed = parseWorktreeList(listRun.stdout);
  if (listed === null) {
    return { kind: 'unknown' };
  }
  const entry = listedWorktreeAt(listed, worktreePath);
  if (entry !== null) {
    return { kind: 'entry', entry };
  }
  // A symlinked worktree path (macOS `/var/folders/...` →
  // `/private/var/...`) is listed under its physical form; accept
  // either, as `alreadyPreparedOutcome` does. Unresolvable falls back
  // to the path as given.
  const physicalWorktreePath = await resolvePhysicalPath(executor, worktreePath, GIT_TIMEOUT_MS);
  if (physicalWorktreePath !== null && physicalWorktreePath !== worktreePath) {
    const physicalEntry = listedWorktreeAt(listed, physicalWorktreePath);
    if (physicalEntry !== null) {
      return { kind: 'entry', entry: physicalEntry };
    }
  }
  return { kind: 'not-listed' };
}

/**
 * Steps 6–7 of `removeLaneWorktree`: only a clean worktree goes — nothing
 * uncommitted and no untracked file (`--untracked-files=all` lists every
 * untracked file; ignored files are not listed and are lost on removal, as
 * K-WT accepts) — then one `worktree remove` call with no flags. The branch
 * is kept. The removal answers the branch tip the list showed, so the reap
 * can journal it.
 */
async function removeCleanListedWorktree(
  executor: CommandExecutorPort,
  clonePath: string,
  worktreePath: string,
  branchTip: string,
): Promise<RemoveLaneWorktreeResult> {
  const statusRun = await executor.run(
    ['git', '-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (statusRun.exitCode === null || statusRun.error !== undefined) {
    return { outcome: 'unknown' };
  }
  if (statusRun.exitCode !== 0) {
    return { outcome: 'refused', reason: 'git-refused' };
  }
  if (statusRun.stdout.trim() !== '') {
    return { outcome: 'refused', reason: 'dirty' };
  }
  const removeRun = await executor.run(
    ['git', '-C', clonePath, 'worktree', 'remove', worktreePath],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (removeRun.exitCode === null || removeRun.error !== undefined) {
    return { outcome: 'unknown' };
  }
  if (removeRun.exitCode !== 0) {
    return { outcome: 'refused', reason: 'git-refused' };
  }
  return { outcome: 'removed', branchTip };
}
const COMMIT_HEAD_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const COMMIT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The commit message of one edit-only attempt: a subject line and the two
 * trailers, nothing else.
 */
export function editOnlyCommitMessage(attemptId: string, implementerModel: string): string {
  return 'fleet: edit-only lane output for ' + attemptId + '\n\n' +
    'Implemented-By: agy ' + implementerModel + '\n' +
    'Fleet-Attempt: ' + attemptId + '\n';
}

/**
 * Validate that an SSH host string is safe to pass to subprocess commands.
 * Matches `^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$` and does not start with `-`.
 */
export function isSafeSshHost(host: string): boolean {
  if (typeof host !== 'string' || host.startsWith('-')) {
    return false;
  }
  const atIndex = host.indexOf('@');
  if (atIndex !== -1 && host.slice(atIndex + 1).startsWith('-')) {
    return false;
  }
  return SAFE_SSH_HOST_PATTERN.test(host);
}

const SAFE_SSH_HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;

/** Strip porcelain v1 quoting around paths with special characters. */
function unquotePorcelainPath(porcelainPath: string): string {
  if (porcelainPath.startsWith('"') && porcelainPath.endsWith('"')) {
    return porcelainPath.slice(1, -1);
  }
  return porcelainPath;
}

const RAW_DIFF_TREE_META = /^:[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} [ACDMTUX]$/;

/**
 * Strict parse of `git diff-tree -r --no-renames -z` raw output: null unless the
 * text is empty or ends in NUL and splits into complete (meta, path) pairs with
 * a well-formed meta and a non-empty path.
 */
function parseRawDiffTree(stdout: string): { readonly dstMode: string; readonly path: string }[] | null {
  if (stdout === '') return [];
  if (!stdout.endsWith('\0')) return null;
  const fields = stdout.slice(0, -1).split('\0');
  if (fields.length % 2 !== 0) return null;
  const entries: { readonly dstMode: string; readonly path: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const meta = fields[index] ?? '';
    const path = fields[index + 1] ?? '';
    if (!RAW_DIFF_TREE_META.test(meta) || path === '') return null;
    entries.push({ dstMode: meta.slice(1).split(' ')[1] ?? '', path });
  }
  return entries;
}

/**
 * Step 1 of `commitLaneOutput`: the request validation alone, before any
 * command runs — the worktree root, the expected head, the attempt id, the
 * implementer model and non-empty allowed-path prefixes.
 */
function commitRequestIsInvalid(request: CommitLaneOutputRequest): boolean {
  const worktreeRefusal = worktreeRootRefusal(request.worktreePath);
  const allowedPathPrefixes = request.allowedPathPrefixes;
  const prefixesValid =
    allowedPathPrefixes.length > 0 &&
    allowedPathPrefixes.every((prefix) => typeof prefix === 'string' && prefix !== '');
  return (
    worktreeRefusal !== null ||
    COMMIT_HEAD_PATTERN.test(request.expectedHead) !== true ||
    COMMIT_ATTEMPT_ID_PATTERN.test(request.attemptId) !== true ||
    isValidAgyModel(request.implementerModel) !== true ||
    prefixesValid !== true
  );
}

/**
 * Step 7b of `commitLaneOutput`: the staged-tree check. Raw `-z` output:
 * ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0" per entry.
 * Parsed strictly: anything that is not a sequence of complete, well-formed
 * records refuses (fail closed). A symlink (120000) or gitlink (160000) is
 * never committed, nor a protected path, nor anything outside the prefixes.
 */
function stagedTreeOutsideAllowedPaths(diffStdout: string, allowedPathPrefixes: readonly string[]): boolean {
  const entries = parseRawDiffTree(diffStdout);
  return (
    entries === null ||
    entries.some(
      (entry) =>
        entry.dstMode === '120000' ||
        entry.dstMode === '160000' ||
        isFixedProtectedPath(entry.path) ||
        allowedPathPrefixes.some((prefix) => pathUnderPrefix(entry.path, prefix)) !== true,
    )
  );
}

function patchPathRefusal(patchPath: unknown, worktreePath: string): 'invalid-request' | 'patch-path-inside-worktree' | null {
  if (typeof patchPath !== 'string' || !patchPath.startsWith('/') || patchPath.includes('\0')) {
    return 'invalid-request';
  }
  const trimmedRoot = worktreePath.replace(/\/+$/, '');
  if (patchPath === trimmedRoot || patchPath.startsWith(`${trimmedRoot}/`)) {
    return 'patch-path-inside-worktree';
  }
  return null;
}

/**
 * Hardening overrides for recovery git commands (plan GB3): ignore repo fsmonitor,
 * hooks, external diff drivers, prefixes and colors.
 */
export const RECOVERY_GIT_CONFIG: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'diff.external=',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'color.ui=false',
];

const FILTER_DRIVER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function filterDriverOverrides(drivers: readonly string[]): string[] {
  const overrides: string[] = [];
  for (const driver of drivers) {
    overrides.push(
      '-c', `filter.${driver}.clean=`,
      '-c', `filter.${driver}.smudge=`,
      '-c', `filter.${driver}.process=`,
      '-c', `filter.${driver}.required=false`,
    );
  }
  return overrides;
}

function parseFilterDrivers(stdout: string): Set<string> | null {
  const drivers = new Set<string>(['lfs']);
  for (const key of stdout.split('\0')) {
    if (key === '') continue;
    const match = /^filter\.(.+)\.(?:clean|smudge|process)$/.exec(key);
    if (match === null) continue;
    const driver = match[1] ?? '';
    if (!FILTER_DRIVER_NAME_PATTERN.test(driver)) {
      return null;
    }
    drivers.add(driver);
  }
  return drivers;
}

async function collectFilterDriverOverrides(
  executor: CommandExecutorPort,
  worktreePath: string,
): Promise<string[] | null> {
  const result = await executor.run(
    [
      'git',
      '-C',
      worktreePath,
      ...RECOVERY_GIT_CONFIG,
      'config',
      '-z',
      '--includes',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process)$',
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.exitCode === 1) {
    return filterDriverOverrides(['lfs']);
  }
  if (result.exitCode !== 0 || result.error !== undefined) {
    return null;
  }
  const drivers = parseFilterDrivers(result.stdout);
  if (drivers === null) {
    return null;
  }
  return filterDriverOverrides([...drivers].sort((a, b) => a.localeCompare(b)));
}

/**
 * GB3: extracts literal pathspecs for tracked paths' top-level directories
 * or root file paths, so `ls-files --others -z` does not walk ignored
 * directories (like `node_modules`) that hold no tracked paths.
 */
export function topLevelTrackedPathspecs(trackedPaths: readonly string[]): string[] {
  const topLevels = new Set<string>();
  for (const p of trackedPaths) {
    if (p === '') continue;
    const slash = p.indexOf('/');
    const top = slash === -1 ? p : p.slice(0, slash);
    if (top !== '') {
      topLevels.add(`:(literal)${top}`);
    }
  }
  return [...topLevels].sort((a, b) => a.localeCompare(b));
}

async function queryUntrackedPaths(
  runGitFn: (args: readonly string[]) => Promise<string>,
  pathspecs: readonly string[],
): Promise<string[]> {
  const fullRun =
    pathspecs.length === 0
      ? ''
      : await runGitFn([...RECOVERY_GIT_CONFIG, 'ls-files', '--others', '-z', '--', ...pathspecs]);
  const dirsRun = await runGitFn([
    ...RECOVERY_GIT_CONFIG,
    'ls-files',
    '--others',
    '--directory',
    '-z',
  ]);
  return parseUntrackedListing(fullRun, dirsRun);
}

export function parseUntrackedListing(stdoutA: string, stdoutB: string): string[] {
  return [
    ...new Set(
      [...stdoutA.split('\0'), ...stdoutB.split('\0')]
        .map((entry) => stripTrailingSlashes(entry))
        .filter((entry) => entry !== ''),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export async function writeAndVerifyPatch(
  executor: CommandExecutorPort,
  physicalParent: string,
  patchPath: string,
  worktreePath: string,
): Promise<'preserved' | 'destination-exists' | 'nothing-to-preserve' | 'git-refused'> {
  const mkTemp = await executor.run(
    ['mktemp', path.join(physicalParent, '.fleet-patch.XXXXXX')],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (mkTemp.exitCode !== 0 || mkTemp.error !== undefined) {
    return 'git-refused';
  }
  const tempPath = mkTemp.stdout.trim();
  const diffRun = await executor.run(
    [
      'git',
      '-C',
      worktreePath,
      ...RECOVERY_GIT_CONFIG,
      'diff',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      'HEAD',
      `--output=${tempPath}`,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (diffRun.exitCode !== 0 || diffRun.error !== undefined) {
    await executor.run(['rm', '-f', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
    return 'git-refused';
  }
  const sizeCheck = await executor.run(['test', '-s', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
  if (sizeCheck.exitCode === 1) {
    await executor.run(['rm', '-f', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
    return 'nothing-to-preserve';
  }
  if (sizeCheck.exitCode !== 0 || sizeCheck.error !== undefined) {
    await executor.run(['rm', '-f', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
    return 'git-refused';
  }
  const move = await executor.run(['mv', '-n', tempPath, patchPath], { timeoutMs: GIT_TIMEOUT_MS });
  if (move.exitCode !== 0 || move.error !== undefined) {
    await executor.run(['rm', '-f', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
    return 'git-refused';
  }
  const tempCheck = await executor.run(['test', '-e', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
  if (tempCheck.exitCode === 0) {
    await executor.run(['rm', '-f', tempPath], { timeoutMs: GIT_TIMEOUT_MS });
    return 'destination-exists';
  }
  const verify = await executor.run(
    ['git', '-C', worktreePath, ...RECOVERY_GIT_CONFIG, 'apply', '--check', '-R', patchPath],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (verify.exitCode !== 0 || verify.error !== undefined) {
    await executor.run(['rm', '-f', patchPath], { timeoutMs: GIT_TIMEOUT_MS });
    return 'git-refused';
  }
  return 'preserved';
}

function isValidInspectRequest(request: InspectWorktreeForRemovalRequest): boolean {
  const { repositoryRoot, worktreePath, defaultRef } = request;
  if (!isAbsoluteNormalisedPath(repositoryRoot) || !isAbsoluteNormalisedPath(worktreePath)) {
    return false;
  }
  if (typeof defaultRef !== 'string' || defaultRef === '') {
    return false;
  }
  if (/\s/.test(defaultRef) || defaultRef.includes('\0')) {
    return false;
  }
  return true;
}

function parseWorktreeStatusCounts(stdout: string): WorktreeStatusCounts {
  let tracked = 0;
  let untracked = 0;
  let unmerged = 0;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('?? ')) {
      untracked += 1;
    } else if (UNMERGED_STATUS_PAIRS.has(line.slice(0, 2))) {
      unmerged += 1;
    } else {
      tracked += 1;
    }
  }
  return { tracked, untracked, unmerged };
}

function parseDuKilobytes(stdout: string): number | null {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) return null;
  const kilobytes = Number.parseInt(lastLine.trim().split(/\s+/)[0] ?? '', 10);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) return null;
  return kilobytes;
}

function parseFilesystemKilobytes(field: string | undefined): number | null {
  if (field === undefined || !/^\d+$/.test(field)) {
    return null;
  }
  const kilobytes = Number.parseInt(field, 10);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) {
    return null;
  }
  return kilobytes;
}

function parseReflogTimestamp(stdout: string): number | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  const match = /@\{([^}]+)\}/.exec(trimmed);
  const dateString = match !== null ? match[1]! : trimmed;
  const ms = Date.parse(dateString);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * One `stat` answer as milliseconds. The first token is the whole-second epoch
 * (`%Y` / `%m`); the sub-second part comes from the same line when the host
 * prints it (GNU `%y`: `2026-01-01 00:00:00.123456789 +0000`, BSD `%Fm`:
 * `1767225600.123456`). A host that prints only whole seconds yields whole
 * seconds and `fractional: false`; the removal re-check treats such a reading
 * as too coarse to prove quiet. Whole-second readings alone cannot tell a write made in the same
 * second as the caller's inspection from the inspected state, so the removal
 * re-check compares at millisecond precision.
 */
function parseStatMtime(line: string): { readonly ms: number; readonly fractional: boolean } | null {
  const tokens = line.trim().split(/\s+/);
  const first = tokens[0];
  if (first === undefined || !/^\d+$/.test(first)) {
    return null;
  }
  const seconds = Number.parseInt(first, 10);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  let millis = 0;
  let fractional = false;
  for (const token of tokens.slice(1)) {
    const fraction = /^(?:\d{2}:\d{2}:\d{2}|\d+)\.(\d+)$/.exec(token);
    if (fraction !== null) {
      millis = Number.parseInt(fraction[1]!.padEnd(3, '0').slice(0, 3), 10);
      // An all-zero fraction is a filesystem that stores whole seconds.
      fractional = /[1-9]/.test(fraction[1]!);
      break;
    }
  }
  return { ms: seconds * 1000 + millis, fractional };
}

async function readReflogActivityMs(
  executor: CommandExecutorPort,
  worktreePath: string,
): Promise<number | null> {
  const reflogRun = await executor.run(
    ['git', '-C', worktreePath, 'reflog', 'show', '-1', '--date=iso-strict', '--format=%gD', 'HEAD'],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (reflogRun.exitCode === 0 && reflogRun.error === undefined) {
    return parseReflogTimestamp(reflogRun.stdout);
  }
  return null;
}

async function detectStatFlavour(
  executor: CommandExecutorPort,
  worktreePath: string,
): Promise<'gnu' | 'bsd' | null> {
  const gnuStatRun = await executor.run(['stat', '-c', '%Y', worktreePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (gnuStatRun.exitCode === 0 && gnuStatRun.error === undefined) {
    return 'gnu';
  }
  const bsdStatRun = await executor.run(['stat', '-f', '%m', worktreePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (bsdStatRun.exitCode === 0 && bsdStatRun.error === undefined) {
    return 'bsd';
  }
  return null;
}

async function readIndexActivityMs(
  executor: CommandExecutorPort,
  worktreePath: string,
  flavour: 'gnu' | 'bsd',
): Promise<{ readonly ms: number; readonly fractional: boolean } | null> {
  const indexPathRun = await executor.run(
    ['git', '-C', worktreePath, 'rev-parse', '--git-path', 'index'],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (indexPathRun.exitCode !== 0 || indexPathRun.error !== undefined) {
    return null;
  }
  let indexPath = indexPathRun.stdout.trim();
  if (!indexPath.startsWith('/')) {
    indexPath = path.join(worktreePath, indexPath);
  }
  const indexStatRun = await executor.run(
    flavour === 'gnu' ? ['stat', '-c', '%Y %y', indexPath] : ['stat', '-f', '%m %Fm', indexPath],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (
    indexStatRun.exitCode !== 0 ||
    indexStatRun.error !== undefined ||
    indexStatRun.stdout.trim() === ''
  ) {
    return null;
  }
  return parseStatMtime(indexStatRun.stdout.trim());
}

async function walkTreeActivity(
  executor: CommandExecutorPort,
  worktreePath: string,
  flavour: 'gnu' | 'bsd',
): Promise<{ newestMs: number | null; unknown: boolean; coarse: boolean }> {
  const walkArgv =
    flavour === 'gnu'
      ? ['find', worktreePath, '-name', '.git', '-prune', '-o', '-type', 'f', '-exec', 'stat', '-c', '%Y %y', '{}', '+']
      : ['find', worktreePath, '-name', '.git', '-prune', '-o', '-type', 'f', '-exec', 'stat', '-f', '%m %Fm', '{}', '+'];
  const walkRun = await executor.run(walkArgv, { timeoutMs: GIT_TIMEOUT_MS });
  let newestMs: number | null = null;
  let coarse = false;
  for (const line of walkRun.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const lineMtime = parseStatMtime(trimmed);
    if (lineMtime === null) continue;
    if (!lineMtime.fractional) coarse = true;
    if (newestMs === null || lineMtime.ms > newestMs) {
      newestMs = lineMtime.ms;
    }
  }
  const unknown = walkRun.exitCode === null || walkRun.error !== undefined || walkRun.exitCode !== 0;
  return { newestMs, unknown, coarse };
}

export class WorkspaceAdapter implements WorkspacePort {
  constructor(private readonly options?: WorkspaceAdapterOptions) {}

  /**
   * C2': the fail-closed manifest check behind `removeWorktree`'s gate. When
   * composition supplied one, it is used; otherwise a private
   * `AttemptArtifactAdapter` over the same executors answers.
   */
  private checkArtifactManifest(
    request: VerifyArtifactManifestRequest,
  ): Promise<ArtifactManifestRemovalCheckResult> {
    const supplied = this.options?.checkArtifactManifest;
    if (supplied !== undefined) {
      return supplied(request);
    }
    const fallback = new AttemptArtifactAdapter({
      ...(this.options?.executor !== undefined ? { executor: this.options.executor } : {}),
      ...(this.options?.executorForRecordedHost !== undefined
        ? { executorForRecordedHost: this.options.executorForRecordedHost }
        : {}),
    });
    return fallback.checkArtifactManifestForRemoval(request);
  }

  /**
   * When given, a request carrying a recorded runner block (reads, brief
   * placement, manifest sealing, worktree prepare and commit) goes through
   * this helper, which confirms a named host, resolves an alias-only record
   * through the installation or refuses it (D2), and keeps the legacy
   * executor otherwise. A request with no recorded block (manual prepare)
   * keeps `executor`. The executor is the only transport; without one there
   * is nothing to run.
   */
  private executorFor(
    recordedHost?: AttemptRunnerRecord | null,
  ): CommandExecutorPort {
    if (
      this.options?.executorForRecordedHost !== undefined &&
      recordedHost !== null &&
      recordedHost !== undefined
    ) {
      const resolved = this.options.executorForRecordedHost(recordedHost);
      if (!resolved.ok) {
        throw new Error(resolved.reason);
      }
      return resolved.executor;
    }
    const executor = this.options?.executor;
    if (executor === undefined) {
      throw new Error('WorkspaceAdapter requires a configured CommandExecutorPort executor');
    }
    return executor;
  }

  async inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection> {
    const { worktreePath, baseCommit } = request;
    const executor = this.executorFor(request.recordedHost);

    let checkedOutCommit: string;
    try {
      checkedOutCommit = (await this.runGit(worktreePath, ['rev-parse', 'HEAD'], executor)).trim();
    } catch (error) {
      throw new Error(`Unable to read HEAD commit in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    let statusOutput: string;
    try {
      statusOutput = await this.runGit(
        worktreePath,
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-uall'],
        executor,
      );
    } catch (error) {
      throw new Error(`Unable to read git status in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    const uncommittedPaths: string[] = [];
    const untrackedPaths: string[] = [];
    for (const line of statusOutput.split('\n')) {
      if (line === '') continue;
      // Porcelain v1: two status columns, one space, then the path.
      const entryPath = unquotePorcelainPath(line.slice(3));
      if (entryPath === '') continue;
      if (line.startsWith('?? ')) {
        untrackedPaths.push(entryPath);
      } else {
        uncommittedPaths.push(entryPath);
      }
    }

    const residueFromEarlierAttempts: string[] = [];
    for (const residueFile of laneResidueFiles) {
      const residuePath = path.join(worktreePath, residueFile);
      if (await this.pathExists(worktreePath, residuePath, executor)) residueFromEarlierAttempts.push(residueFile);
    }

    const missingExpectedArtifacts: string[] = [];
    for (const expectedPath of request.expectedArtifactPaths) {
      // Every caller-supplied expected-artifact path is contained here: an
      // absolute or escaping entry is refused before any probe runs.
      const absolutePath = resolveWorktreeTarget(worktreePath, expectedPath);
      if (!(await this.pathExists(worktreePath, absolutePath, executor))) {
        missingExpectedArtifacts.push(expectedPath);
      }
    }

    return {
      worktreePath,
      checkedOutCommit,
      matchesBaseCommit:
        checkedOutCommit === baseCommit ||
        checkedOutCommit.startsWith(baseCommit) ||
        baseCommit.startsWith(checkedOutCommit),
      uncommittedPaths,
      untrackedPaths,
      residueFromEarlierAttempts,
      missingExpectedArtifacts,
    };
  }

  /** Read-only git in the worktree, through the executor, within its budget. */
  private async runGit(
    worktreePath: string,
    args: readonly string[],
    executor: CommandExecutorPort,
  ): Promise<string> {
    const result = await executor.run(['git', '-C', worktreePath, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed in ${worktreePath}: exit ${String(result.exitCode)}` +
          (result.stderr.trim() !== '' ? `: ${result.stderr.trim()}` : ''),
      );
    }
    return result.stdout;
  }

  /** Existence of one absolute path in the worktree's filesystem. */
  private async pathExists(
    worktreePath: string,
    targetPath: string,
    executor: CommandExecutorPort,
  ): Promise<boolean> {
    const result = await executor.run(['test', '-e', targetPath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(
        `Unable to probe ${targetPath}: exit ${String(result.exitCode)}` +
          (result.error !== undefined ? `: ${result.error}` : ''),
      );
    }
    return result.exitCode === 0;
  }

  async readWorktreeFile(
    worktreePath: string,
    relativePath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    // Containment lives in the shared adapter helper: the worktree must be
    // an absolute path that is not the filesystem root, an absolute candidate
    // is accepted only when it lies inside the worktree itself, and the
    // relative form must pass the domain check — all before any command.
    const targetPath = resolveWorktreeTarget(worktreePath, relativePath);
    const executor = this.executorFor(recordedHost);
    const result = await executor.run(['cat', targetPath], { timeoutMs: CAT_TIMEOUT_MS });
    // A null exit code (spawn failure, timeout) is a failed read, not an
    // absent file; only exit 1 and friends mean "no such file".
    if (result.exitCode === null) {
      throw new Error(
        `Unable to read ${targetPath}` + (result.error !== undefined ? `: ${result.error}` : ''),
      );
    }
    return result.exitCode === 0 ? result.stdout : null;
  }

  /**
   * One commit command in the worktree with the commit hardening: no hooks,
   * no signing, no fsmonitor. `ok: false` when the command failed or never
   * reported an exit code, with a fixed reason that never carries stderr or
   * a path.
   */
  private async runCommitGit(
    executor: CommandExecutorPort,
    worktreePath: string,
    args: readonly string[],
  ): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
    const result = await executor.run(['git', '-C', worktreePath, ...COMMIT_GIT_CONFIG, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.error !== undefined) {
      return { ok: false, reason: 'git ' + args[0] + ' failed' };
    }
    return { ok: true, stdout: result.stdout };
  }

  /**
   * Stage the whole checked change set, write the staged tree and read
   * HEAD's tree. The one shared HEAD-tree comparison for both of its uses:
   * the nothing-to-commit check on the main path and the ownership proof of
   * the already-committed path.
   */
  private async stageAndCompareWithHeadTree(
    executor: CommandExecutorPort,
    worktreePath: string,
  ): Promise<{ ok: true; tree: string; headTree: string } | { ok: false; reason: string }> {
    // Stage the whole checked change set. Ignored files are never staged.
    const addRun = await this.runCommitGit(executor, worktreePath, ['add', '-A', '--', '.']);
    if (!addRun.ok) return { ok: false, reason: addRun.reason };
    const treeRun = await this.runCommitGit(executor, worktreePath, ['write-tree']);
    if (!treeRun.ok) return { ok: false, reason: treeRun.reason };
    const headTreeRun = await this.runCommitGit(executor, worktreePath, ['rev-parse', '--verify', 'HEAD^{tree}']);
    if (!headTreeRun.ok) return { ok: false, reason: headTreeRun.reason };
    return { ok: true, tree: treeRun.stdout.trim(), headTree: headTreeRun.stdout.trim() };
  }

  /**
   * Step 2 of `commitLaneOutput`: the commit runs on the recorded host's
   * executor when there is one.
   */
  private laneCommitExecutor(request: CommitLaneOutputRequest): LaneCommitStep<CommandExecutorPort> {
    try {
      return { data: this.executorFor(request.recordedHost) };
    } catch {
      return { failure: { outcome: 'error', reason: 'worktree host could not be resolved' } };
    }
  }

  /**
   * Steps 3–4 of `commitLaneOutput`: read HEAD, then the checked-out
   * branch, refusing a detached head.
   */
  private async laneCommitHeadAndBranch(
    executor: CommandExecutorPort,
    worktreePath: string,
  ): Promise<LaneCommitStep<{ head: string; branchRef: string }>> {
    // 3. Read HEAD.
    const headRun = await this.runCommitGit(executor, worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!headRun.ok) return { failure: { outcome: 'error', reason: headRun.reason } };
    const head = headRun.stdout.trim();

    // 4. The checked-out branch, else a detached head is refused.
    const branchRun = await this.runCommitGit(executor, worktreePath, ['symbolic-ref', '-q', 'HEAD']);
    if (!branchRun.ok) return { failure: { outcome: 'refused', reason: 'detached-head' } };
    const branchRef = branchRun.stdout.trim();
    if (branchRef.startsWith('refs/heads/') !== true) {
      return { failure: { outcome: 'refused', reason: 'detached-head' } };
    }
    return { data: { head, branchRef } };
  }

  /**
   * Steps 6–7b of `commitLaneOutput`: stage the change set, write the
   * staged tree and compare it with HEAD's tree (the shared comparison
   * helper), then re-check the tree that is actually about to be committed
   * against the allowed-path prefixes.
   */
  private async laneCommitStagedTree(
    executor: CommandExecutorPort,
    worktreePath: string,
    expectedHead: string,
    allowedPathPrefixes: readonly string[],
  ): Promise<LaneCommitStep<{ tree: string }>> {
    // 6–7. Stage the change set, write the staged tree and compare it with
    // HEAD's tree (the shared comparison helper).
    const stagedTree = await this.stageAndCompareWithHeadTree(executor, worktreePath);
    if (!stagedTree.ok) return { failure: { outcome: 'error', reason: stagedTree.reason } };
    const tree = stagedTree.tree;
    if (tree === stagedTree.headTree) {
      return { failure: { outcome: 'nothing-to-commit' } };
    }

    // 7b. The diff check ran before staging; re-check the tree that is
    // actually about to be committed, so a file written between the check
    // and `add -A` is refused here. Nothing is committed and no ref moves;
    // the staged index is left as it is (no reset).
    const diffTreeRun = await this.runCommitGit(
      executor,
      worktreePath,
      ['diff-tree', '-r', '--no-renames', '-z', expectedHead, tree],
    );
    if (!diffTreeRun.ok) return { failure: { outcome: 'error', reason: diffTreeRun.reason } };
    if (stagedTreeOutsideAllowedPaths(diffTreeRun.stdout, allowedPathPrefixes)) {
      return { failure: { outcome: 'refused', reason: 'outside-allowed-paths' } };
    }
    return { data: { tree } };
  }

  /**
   * Step 8 of `commitLaneOutput`: write the commit — the dispatch head is
   * the only parent.
   */
  private async laneCommitWrite(
    executor: CommandExecutorPort,
    worktreePath: string,
    tree: string,
    expectedHead: string,
    commitMessage: string,
  ): Promise<LaneCommitStep<string>> {
    const commitRun = await this.runCommitGit(
      executor,
      worktreePath,
      ['commit-tree', tree, '-p', expectedHead, '--no-gpg-sign', '-m', commitMessage],
    );
    if (!commitRun.ok) return { failure: { outcome: 'error', reason: commitRun.reason } };
    const commit = commitRun.stdout.trim();
    if (COMMIT_HEAD_PATTERN.test(commit) !== true) {
      return { failure: { outcome: 'error', reason: 'git commit-tree failed' } };
    }
    return { data: commit };
  }

  /**
   * Step 9 of `commitLaneOutput`: move the branch by compare-and-swap —
   * git refuses when the branch moved since `expectedHead`, and then
   * nothing was moved.
   */
  private async laneCommitRefSwap(
    executor: CommandExecutorPort,
    worktreePath: string,
    branchRef: string,
    commit: string,
    expectedHead: string,
    attemptId: string,
  ): Promise<CommitLaneOutputResult> {
    const updateRun = await this.runCommitGit(
      executor,
      worktreePath,
      ['update-ref', '-m', 'fleet edit-only commit ' + attemptId, branchRef, commit, expectedHead],
    );
    if (!updateRun.ok) return { outcome: 'refused', reason: 'ref-moved' };

    // 10. Done.
    return { outcome: 'committed', headCommit: commit, branchRef };
  }

  async commitLaneOutput(request: CommitLaneOutputRequest): Promise<CommitLaneOutputResult> {
    // 1. Validate before any command runs.
    if (commitRequestIsInvalid(request)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. The commit runs on the recorded host's executor when there is one.
    const executorStep = this.laneCommitExecutor(request);
    if ('failure' in executorStep) return executorStep.failure;
    const executor = executorStep.data;

    const { worktreePath } = request;

    // 3–4. Read HEAD and the checked-out branch.
    const headAndBranch = await this.laneCommitHeadAndBranch(executor, worktreePath);
    if ('failure' in headAndBranch) return headAndBranch.failure;
    const { head, branchRef } = headAndBranch.data;

    // 5. HEAD must be the dispatch head; a crash after the commit reads as
    // already-committed instead of a head-moved refusal (the ownership
    // proof lives in `alreadyCommittedOutcome`).
    if (head !== request.expectedHead) {
      return this.alreadyCommittedOutcome(executor, request, worktreePath, head, branchRef);
    }

    // 6–7b. Stage the change set, compare the staged tree with HEAD's tree
    // and re-check the allowed-path prefixes on the committed tree.
    const stagedTree = await this.laneCommitStagedTree(
      executor,
      worktreePath,
      request.expectedHead,
      request.allowedPathPrefixes,
    );
    if ('failure' in stagedTree) return stagedTree.failure;

    // 8. Write the commit: the dispatch head is the only parent.
    const commitStep = await this.laneCommitWrite(
      executor,
      worktreePath,
      stagedTree.data.tree,
      request.expectedHead,
      editOnlyCommitMessage(request.attemptId, request.implementerModel),
    );
    if ('failure' in commitStep) return commitStep.failure;

    // 9–10. Move the branch by compare-and-swap, then report the commit.
    return this.laneCommitRefSwap(
      executor,
      worktreePath,
      branchRef,
      commitStep.data,
      request.expectedHead,
      request.attemptId,
    );
  }

  /**
   * The already-committed path: HEAD moved past `expectedHead` and the
   * commit must be proven to be this adapter's — the dispatch head as the
   * only parent, this adapter's exact message, and a worktree holding
   * nothing beyond that commit. A foreign commit carrying the trailer never
   * passes.
   */
  private async alreadyCommittedOutcome(
    executor: CommandExecutorPort,
    request: CommitLaneOutputRequest,
    worktreePath: string,
    head: string,
    branchRef: string,
  ): Promise<CommitLaneOutputResult> {
    const parentsRun = await this.runCommitGit(executor, worktreePath, ['show', '-s', '--format=%P', 'HEAD']);
    if (!parentsRun.ok) return { outcome: 'error', reason: parentsRun.reason };
    const parents = parentsRun.stdout.trim();
    if (parents !== request.expectedHead) {
      return { outcome: 'refused', reason: 'head-moved' };
    }
    const messageRun = await this.runCommitGit(executor, worktreePath, ['show', '-s', '--format=%B', 'HEAD']);
    if (!messageRun.ok) return { outcome: 'error', reason: messageRun.reason };
    const expectedMessage = editOnlyCommitMessage(request.attemptId, request.implementerModel);
    // Trailing whitespace only: a leading newline or space is an agent-written body.
    if (messageRun.stdout.replace(/\s+$/u, '') !== expectedMessage.replace(/\s+$/u, '')) {
      return { outcome: 'refused', reason: 'head-moved' };
    }
    const ownershipTree = await this.stageAndCompareWithHeadTree(executor, worktreePath);
    if (!ownershipTree.ok) return { outcome: 'error', reason: ownershipTree.reason };
    if (ownershipTree.tree !== ownershipTree.headTree) {
      return { outcome: 'refused', reason: 'head-moved' };
    }
    return { outcome: 'already-committed', headCommit: head, branchRef };
  }

  /**
   * K7-5a (K7-D7, "Start reserves first"): create the run's worktree at
   * exactly the path the capacity reserve chose, on a new branch at the
   * work order's base, in the project's clone, through the reserved host's
   * executor. One `worktree add` with no `--force`; a worktree already
   * prepared exactly this way reads as `already-prepared` so a retried
   * start is safe. It never removes, resets or checks out anything.
   */
  async prepareLaneWorktree(request: PrepareLaneWorktreeRequest): Promise<PrepareLaneWorktreeResult> {
    // 1. Validate before any command runs (no executor call on a bad request).
    if (prepareLaneWorktreeRequestIsValid(request) !== true) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. The write runs on the reserved host's executor; an unresolvable
    //    host is a transport failure: the worktree may or may not exist.
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'unknown' };
    }

    const { clonePath, worktreePath, branch, baseCommit } = request;

    try {
      // 3. Already there? A path that exists must be exactly what a prior
      //    start of this run would have made; anything else is refused.
      if (await this.pathExists(worktreePath, worktreePath, executor)) {
        return await this.alreadyPreparedOutcome(executor, clonePath, worktreePath, branch, baseCommit);
      }

      // 4. Branch taken elsewhere? (`--verify --quiet`: exit 1 means free.)
      const branchRun = await executor.run(
        ['git', '-C', clonePath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (branchRun.exitCode === null || branchRun.error !== undefined) {
        return { outcome: 'unknown' };
      }
      if (branchRun.exitCode === 0) {
        return { outcome: 'refused', reason: 'branch-exists-other' };
      }
      if (branchRun.exitCode !== 1) {
        return { outcome: 'refused', reason: 'git-refused' };
      }

      // 5. Ensure the base commit exists in the clone before creating a
      //    worktree on it. A clone that has never fetched the base refuses
      //    `worktree add`; fetch the default remote (`origin`) — never a
      //    caller-supplied ref — and check again. A null exit or an error
      //    on either command is `unknown`, as in step 6.
      const catFileRun = await executor.run(
        ['git', '-C', clonePath, 'cat-file', '-e', `${baseCommit}^{commit}`],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (catFileRun.exitCode === null || catFileRun.error !== undefined) {
        return { outcome: 'unknown' };
      }
      if (catFileRun.exitCode !== 0) {
        const fetchRun = await executor.run(
          [
            'git', '-C', clonePath, '-c', 'core.hooksPath=/dev/null',
            'fetch', '--quiet', 'origin',
          ],
          { timeoutMs: GIT_FETCH_TIMEOUT_MS },
        );
        if (fetchRun.exitCode === null || fetchRun.error !== undefined) {
          return { outcome: 'unknown' };
        }
        const catFileAfterFetchRun = await executor.run(
          ['git', '-C', clonePath, 'cat-file', '-e', `${baseCommit}^{commit}`],
          { timeoutMs: GIT_TIMEOUT_MS },
        );
        if (catFileAfterFetchRun.exitCode === null || catFileAfterFetchRun.error !== undefined) {
          return { outcome: 'unknown' };
        }
        if (catFileAfterFetchRun.exitCode !== 0) {
          return { outcome: 'refused', reason: 'git-refused' };
        }
      }

      // 6. Create: one call, no `--force`. A non-zero exit refuses; a thrown
      //    or unanswered command is `unknown` — the worktree may or may not exist.
      const addRun = await executor.run(
        [
          'git', '-C', clonePath, '-c', 'core.hooksPath=/dev/null',
          'worktree', 'add', '-b', branch, worktreePath, baseCommit,
        ],
        { timeoutMs: GIT_TIMEOUT_MS },
      );
      if (addRun.exitCode === null || addRun.error !== undefined) {
        return { outcome: 'unknown' };
      }
      return addRun.exitCode === 0
        ? { outcome: 'prepared' }
        : { outcome: 'refused', reason: 'git-refused' };
    } catch {
      return { outcome: 'unknown' };
    }
  }

  /**
   * CB-D2 (CB2): resolve the tip of one lane run's base branch on the forge,
   * through the reserved host's executor. The only command is a hardened
   * `git ls-remote --exit-code origin refs/heads/<baseBranch>`; exit 2 is a
   * missing base; a resolved tip is the single listed 40-hex head of exactly
   * that ref. Nothing is fetched, no stderr reaches the result, and any
   * other answer is `unknown` — never a guess.
   */
  async resolveBaseTip(request: ResolveBaseTipRequest): Promise<ResolveBaseTipResult> {
    // 1. Validate before any command runs (no executor call on a bad request).
    if (
      !isAbsoluteNormalisedPath(request.clonePath) ||
      parseBaseBranch(request.baseBranch) === undefined
    ) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. The read runs on the reserved host's executor; an unresolvable host
    //    or a throw is unknown — nothing is known to have been read.
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'unknown' };
    }

    const ref = `refs/heads/${request.baseBranch}`;
    try {
      const run = await executor.run(
        [
          'git', '-C', request.clonePath, '-c', 'core.hooksPath=/dev/null',
          'ls-remote', '--exit-code', 'origin', ref,
        ],
        { timeoutMs: GIT_FETCH_TIMEOUT_MS },
      );
      if (run.exitCode === null || run.error !== undefined) {
        return { outcome: 'unknown' };
      }
      if (run.exitCode === 2) {
        return { outcome: 'missing' };
      }
      if (run.exitCode !== 0) {
        return { outcome: 'unknown' };
      }
      // One line, one trailing newline stripped: `<40 lowercase hex><TAB>refs/heads/<baseBranch>`.
      const lines = run.stdout.replace(/\n$/, '').split('\n');
      if (lines.length !== 1) {
        return { outcome: 'unknown' };
      }
      const fields = lines[0]!.split('\t');
      if (fields.length !== 2) {
        return { outcome: 'unknown' };
      }
      const [tip, listedRef] = fields;
      if (tip === undefined || !BASE_COMMIT_PATTERN.test(tip) || listedRef !== ref) {
        return { outcome: 'unknown' };
      }
      return { outcome: 'resolved', tip };
    } catch {
      return { outcome: 'unknown' };
    }
  }

  /**
   * GB3: preserve the worktree's uncommitted tracked edits as a patch file
   * outside it (`git diff --binary HEAD`). The worktree root and the patch
   * destination's parent are canonicalized on the recorded host, and a
   * destination that resolves inside the worktree (including through a symlink
   * alias), already exists or is a symlink is refused before anything is
   * written. The patch is written atomically via a fresh temp file and a
   * no-clobber rename, never through a link and never over an existing file.
   */
  async preserveWorktreeEdits(request: PreserveWorktreeEditsRequest): Promise<PreserveWorktreeEditsResult> {
    // 1. Validate before any command runs (no executor call on a bad request).
    if (worktreeRootRefusal(request.worktreePath) !== null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const patchPath = request.patchPath;
    const pathRefusal = patchPathRefusal(patchPath, request.worktreePath);
    if (pathRefusal !== null) {
      return { outcome: 'refused', reason: pathRefusal };
    }

    // 2. The write runs on the recorded host's executor; an unresolvable host
    //    is a transport failure, like the other workspace writes.
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'error', reason: 'worktree host could not be resolved' };
    }

    // 3. Canonicalize on the recorded host: a symlink alias of the destination's
    //    parent can place it inside the worktree even when the lexical path is
    //    outside, so the physical root and parent decide.
    const physicalRoot = await resolvePhysicalPath(executor, request.worktreePath, GIT_TIMEOUT_MS);
    const physicalParent = await resolvePhysicalPath(executor, path.dirname(patchPath), GIT_TIMEOUT_MS);
    if (physicalRoot === null || physicalParent === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const physicalPatchPath = path.join(physicalParent, path.basename(patchPath));
    if (physicalPatchPath === physicalRoot || physicalPatchPath.startsWith(`${physicalRoot}/`)) {
      return { outcome: 'refused', reason: 'patch-path-inside-worktree' };
    }

    // 4. Refuse an existing or symlink destination before any write; refused
    //    requests write nothing.
    const existsRun = await executor.run(['test', '-e', patchPath], { timeoutMs: PROBE_TIMEOUT_MS });
    const linkRun = await executor.run(['test', '-L', patchPath], { timeoutMs: PROBE_TIMEOUT_MS });
    if (existsRun.exitCode === 0 || linkRun.exitCode === 0) {
      // The reconcile reads destination-exists as a saved patch, so only a
      // regular, non-empty file may answer it.
      const regularRun = await executor.run(['test', '-f', patchPath], { timeoutMs: PROBE_TIMEOUT_MS });
      const nonEmptyRun = await executor.run(['test', '-s', patchPath], { timeoutMs: PROBE_TIMEOUT_MS });
      const savedPatch = linkRun.exitCode !== 0 && regularRun.exitCode === 0 && nonEmptyRun.exitCode === 0;
      return { outcome: 'refused', reason: savedPatch ? 'destination-exists' : 'git-refused' };
    }

    // 5-6. Write the binary-safe diff directly via git into a fresh temp file,
    //      move it without clobbering, verify it against the worktree with
    //      `git apply --check -R`, and read the byte count.
    const writeOutcome = await writeAndVerifyPatch(executor, physicalParent, patchPath, request.worktreePath);
    if (writeOutcome !== 'preserved') {
      return { outcome: 'refused', reason: writeOutcome };
    }

    const wcRun = await executor.run(['wc', '-c', patchPath], { timeoutMs: GIT_TIMEOUT_MS });
    if (wcRun.exitCode !== 0 || wcRun.error !== undefined) {
      await executor.run(['rm', '-f', patchPath], { timeoutMs: GIT_TIMEOUT_MS });
      return { outcome: 'refused', reason: 'git-refused' };
    }
    const rawBytes = Number.parseInt(wcRun.stdout.trim().split(/\s+/)[0] ?? '0', 10);
    const patchBytes = Number.isNaN(rawBytes) ? 0 : rawBytes;

    return { outcome: 'preserved', patchPath, patchBytes };
  }

  /**
   * GB3: verify that one preserved patch matches the worktree
   * (`git apply --check -R <patchPath>`).
   */
  async verifySavedPatch(request: VerifySavedPatchRequest): Promise<boolean> {
    if (worktreeRootRefusal(request.worktreePath) !== null) {
      return false;
    }
    if (patchPathRefusal(request.patchPath, request.worktreePath) !== null) {
      return false;
    }
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return false;
    }
    const result = await executor.run(
      ['git', '-C', request.worktreePath, ...RECOVERY_GIT_CONFIG, 'apply', '--check', '-R', request.patchPath],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    return result.exitCode === 0 && result.error === undefined;
  }

  /**
   * GB3: discard the worktree's tracked modifications back to its recorded head
   * (`git reset --hard`, no ref argument — HEAD and the branch cannot move),
   * leaving untracked files untouched. Refuses before resetting when restoring
   * or clearing a tracked path (HEAD's tree or the index) would overwrite or
   * remove an untracked path, and verifies after resetting that the untracked
   * paths are unchanged.
   */
  async resetWorktreeToHead(request: ResetWorktreeToHeadRequest): Promise<ResetWorktreeToHeadResult> {
    // 1. Validate before any command runs (no executor call on a bad request).
    if (worktreeRootRefusal(request.worktreePath) !== null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'error', reason: 'worktree host could not be resolved' };
    }
    try {
      const runGitInWorktree = (args: readonly string[]): Promise<string> =>
        this.runGit(request.worktreePath, args, executor);

      // 2. Read the head to report, and list the tracked paths reset would
      //    restore or clear: HEAD's tree AND the index — a staged addition is
      //    not in HEAD, but `reset --hard` still removes it from index and
      //    worktree, so it must take part in the obstruction check — plus the
      //    untracked files present. Run with -z and no .trim() so quoted/special
      //    characters are preserved faithfully.
      const head = (await runGitInWorktree(['rev-parse', 'HEAD'])).trim();
      const trackedRun = await runGitInWorktree(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
      const indexRun = await runGitInWorktree([...RECOVERY_GIT_CONFIG, 'ls-files', '--cached', '-z']);
      const trackedPaths = [
        ...new Set([...trackedRun.split('\0'), ...indexRun.split('\0')].filter((line) => line !== '')),
      ];
      const pathspecs = topLevelTrackedPathspecs(trackedPaths);
      const untrackedFiles = await queryUntrackedPaths(runGitInWorktree, pathspecs);

      // 3. Refuse BEFORE resetting when restoring a tracked path could overwrite
      //    or remove an untracked path (for example a deleted tracked path masked
      //    by an untracked directory or file at that path).
      if (resetWouldDestroyUntracked(trackedPaths, untrackedFiles)) {
        return { outcome: 'refused', reason: 'untracked-obstructs' };
      }

      // 4. Reset: `git reset --hard` with no ref argument, so HEAD and the
      //    branch ref cannot move. Neutralize filter drivers so no lane-chosen
      //    filter runs.
      const filterOverrides = await collectFilterDriverOverrides(executor, request.worktreePath);
      if (filterOverrides === null) {
        return { outcome: 'refused', reason: 'git-refused' };
      }
      await runGitInWorktree([...RECOVERY_GIT_CONFIG, ...filterOverrides, 'reset', '--hard']);

      // 5. Verify the untracked paths are unchanged.
      const afterUntracked = await queryUntrackedPaths(runGitInWorktree, pathspecs);
      const unchanged =
        untrackedFiles.length === afterUntracked.length &&
        untrackedFiles.every((entry, index) => entry === afterUntracked[index]);
      if (!unchanged) {
        return { outcome: 'error', reason: 'Untracked paths changed while resetting' };
      }
      return { outcome: 'reset', headCommit: head };
    } catch {
      return { outcome: 'refused', reason: 'git-refused' };
    }
  }

  /**
   * EX-2a (D17): remove one finished lane run's clean worktree, keeping its
   * branch. Never `--force`, never a branch delete, never `prune`: the only
   * write is `git worktree remove <path>` with no flags. Every command runs
   * through the recorded host's executor — never the configured or legacy
   * executor — and when the recorded host is not named or no host executor
   * is configured, nothing runs. Gitdir linkage is proven by the `worktree
   * list` check: git itself lists the path as a worktree of this clone (E6).
   */
  /**
   * Step 2 of `removeLaneWorktree`: the write runs on the recorded host's
   * executor and nowhere else — never the configured or legacy fallback.
   * No host executor configured, a refusal or a throw yields `null` —
   * nothing has run.
   */
  private recordedHostExecutor(
    recordedHost: AttemptRunnerRecord | null | undefined,
  ): CommandExecutorPort | null {
    const selector = this.options?.executorForRecordedHost;
    if (selector === undefined) {
      return null;
    }
    try {
      const resolved = selector(recordedHost);
      if (!resolved.ok) {
        return null;
      }
      return resolved.executor;
    } catch {
      return null;
    }
  }

  async removeLaneWorktree(request: RemoveLaneWorktreeRequest): Promise<RemoveLaneWorktreeResult> {
    // 1. Validate before anything runs (no executor call on a bad request).
    if (removeLaneWorktreeRequestIsValid(request) !== true) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. The write runs on the recorded host's executor and nowhere else.
    const executor = this.recordedHostExecutor(request.recordedHost);
    if (executor === null) {
      return { outcome: 'unknown' };
    }
    try {
      return await this.removeListedLaneWorktree(request, executor);
    } catch {
      return { outcome: 'unknown' };
    }
  }

  /**
   * Steps 3–7 of `removeLaneWorktree` on a resolved executor: find the
   * worktree in the clone's list, check its branch, tip and lock, then
   * remove it only when it is clean. The outer try/catch stays in
   * `removeLaneWorktree` and answers `unknown` on any throw.
   */
  private async removeListedLaneWorktree(
    request: RemoveLaneWorktreeRequest,
    executor: CommandExecutorPort,
  ): Promise<RemoveLaneWorktreeResult> {
    const { clonePath, worktreePath, branch } = request;
    const found = await listedLaneWorktree(executor, clonePath, worktreePath);
    if (found.kind === 'unknown') {
      return { outcome: 'unknown' };
    }
    if (found.kind === 'refused') {
      return { outcome: 'refused', reason: 'git-refused' };
    }
    if (found.kind === 'not-listed') {
      // Not listed: gone is `already-removed`; a present path that git
      // does not list as a worktree of this clone is never touched.
      const exists = await this.pathExists(worktreePath, worktreePath, executor);
      return exists
        ? { outcome: 'refused', reason: 'not-a-worktree' }
        : { outcome: 'already-removed' };
    }

    // 4. The branch is the record of the run (D17): a detached entry, or
    //    one on another branch, is refused, never removed.
    const branchRefusal = this.listedWorktreeBranchRefusal(found.entry, branch);
    if (branchRefusal !== null) {
      return branchRefusal;
    }

    // 4b. The listed tip is what the reap journals as the recovery handle, so
    //     it must be a real commit before anything is removed; an unborn or
    //     unreadable HEAD answers unknown with nothing removed.
    const branchTip = this.listedWorktreeBranchTip(found.entry);
    if (branchTip === null) {
      return { outcome: 'unknown' };
    }

    // 5. A locked worktree is never removed.
    const lockRefusal = this.listedWorktreeLockRefusal(found.entry);
    if (lockRefusal !== null) {
      return lockRefusal;
    }
    return removeCleanListedWorktree(executor, clonePath, worktreePath, branchTip);
  }

  /**
   * KW3' (conductor plan §3.10.3): remove one worktree after re-reading HEAD,
   * the branch, the porcelain status, the lock, the in-progress operation
   * files and the bounded file walk in this one executor call, and only then
   * run `git worktree remove <path>`. Never `--force`, never a branch
   * command, never `prune`, never `rm`, never a fetch or a push. The only
   * write is `git worktree remove <path>` with no flags. Every command runs
   * through the recorded host's executor — never the configured or legacy
   * executor — and when the recorded host is not named or no host executor is
   * configured, nothing runs. A refusal removes nothing; `partial` means the
   * command ran but the directory or its administrative entry is still there;
   * `unknown` means the executor did not answer.
   */
  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    // 1. Validate before anything runs (no executor call on a bad request).
    //    C2': the request is snapshotted without running any getter, so a
    //    null, a primitive or a throwing getter is a typed refusal, and no
    //    hostile input ever throws.
    const snapshotted = snapshotRemoveWorktreeRequest(request);
    if (snapshotted === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (removeWorktreePathRefusal(snapshotted)) {
      return { outcome: 'refused', reason: 'path-refused' };
    }
    if (!removeWorktreeRequestIsValid(snapshotted)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (!removeWorktreeManifestIsValid(snapshotted.manifest)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. The removal runs on the recorded host's executor and nowhere else.
    const executor = this.recordedHostExecutor(snapshotted.recordedHost);
    if (executor === null) {
      return { outcome: 'unknown', reason: 'no executor for the recorded host' };
    }
    try {
      return await this.removeCheckedListedWorktree(snapshotted, executor);
    } catch {
      return { outcome: 'unknown', reason: 'the removal did not report' };
    }
  }

  /**
   * Steps 3–6 of `removeWorktree` on a resolved executor: find the worktree in
   * the clone's list, re-read HEAD, branch, status, lock, in-progress
   * operations and the bounded file walk through the same executor, then
   * remove it only when every guard still holds. The outer try/catch stays in
   * `removeWorktree` and answers `unknown` on any throw.
   */
  private async removeCheckedListedWorktree(
    request: RemoveWorktreeRequest,
    executor: CommandExecutorPort,
  ): Promise<RemoveWorktreeResult> {
    const { repositoryRoot, worktreeRoot, worktreePath, expectedHead, expectedBranch, expectedLastActivityIso } =
      request;

    // 3. Containment and the listed facts. C2': the git reads run hardened.
    const listRun = await runRemovalGitRead(executor, repositoryRoot, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    if (listRun.exitCode === null || listRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'git worktree list did not report an exit code' };
    }
    if (listRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'git worktree list failed' };
    }
    const listed = parseWorktreeList(listRun.stdout);
    if (listed === null) {
      return { outcome: 'unknown', reason: 'git worktree list output could not be parsed' };
    }
    const entry = await this.findLinkedWorktreeEntry(executor, repositoryRoot, worktreePath, listed, true);
    if (entry === null) {
      return { outcome: 'refused', reason: 'not-a-linked-worktree' };
    }

    // 3b. Containment against the resolved physical paths. The lexical check
    //     above cannot see a symlink inside the worktree root pointing at a
    //     linked worktree outside it; the listed entry's path is the physical
    //     path git lists, so it is compared against the physical root, and a
    //     target outside the configured root is refused.
    const physicalWorktreeRoot = await resolvePhysicalPath(executor, worktreeRoot, GIT_TIMEOUT_MS);
    if (physicalWorktreeRoot === null) {
      return { outcome: 'unknown', reason: 'the worktree root could not be resolved to a physical path' };
    }
    const containmentRoot = physicalWorktreeRoot;
    if (entry.path === containmentRoot || !entry.path.startsWith(`${containmentRoot}/`)) {
      return { outcome: 'refused', reason: 'path-refused' };
    }
    //     The requested path itself must be the listed physical path: a
    //     registered path since replaced by a symlink resolves elsewhere, and
    //     a path that is itself reached through a symlink is refused too.
    const physicalRequestedPath = await resolvePhysicalPath(executor, worktreePath, GIT_TIMEOUT_MS);
    if (physicalRequestedPath === null) {
      return { outcome: 'unknown', reason: 'the worktree path could not be resolved to a physical path' };
    }
    if (physicalRequestedPath !== entry.path || physicalRequestedPath !== worktreePath) {
      return { outcome: 'refused', reason: 'path-refused' };
    }
    //     A worktree inside the clone itself (reached through an alias of the
    //     repository root) is refused as well.
    const physicalRepositoryRoot = await resolvePhysicalPath(executor, repositoryRoot, GIT_TIMEOUT_MS);
    if (
      physicalRepositoryRoot === null ||
      physicalRequestedPath === physicalRepositoryRoot ||
      physicalRequestedPath.startsWith(`${physicalRepositoryRoot}/`)
    ) {
      return { outcome: 'refused', reason: 'path-refused' };
    }

    // 4. Re-read the facts, in this order, through the same executor.
    //    HEAD first: a moved HEAD refuses before anything else is read.
    const headRun = await runRemovalGitRead(executor, worktreePath, ['rev-parse', 'HEAD']);
    if (headRun.exitCode === null || headRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'git rev-parse HEAD did not report an exit code' };
    }
    if (headRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'git rev-parse HEAD failed' };
    }
    const head = headRun.stdout.trim();
    if (head !== expectedHead) {
      return { outcome: 'refused', reason: 'head-moved' };
    }

    //    Branch, from the listed entry.
    if (entry.branch === null) {
      return { outcome: 'refused', reason: 'detached' };
    }
    if (entry.branch !== expectedBranch) {
      return { outcome: 'refused', reason: 'branch-mismatch' };
    }

    //    Status: a read that did not answer is never a refusal.
    const statusResult = await this.readWorktreeStatus(executor, worktreePath, true);
    if (statusResult.outcome === 'unknown') {
      return { outcome: 'unknown', reason: statusResult.reason };
    }
    if (statusResult.status.tracked + statusResult.status.untracked + statusResult.status.unmerged > 0) {
      return { outcome: 'refused', reason: 'dirty' };
    }

    //    Lock.
    if (entry.locked) {
      return { outcome: 'refused', reason: 'locked' };
    }

    //    In-progress operations.
    const inProgressResult = await this.readInProgressOperations(executor, worktreePath, true);
    if (inProgressResult.outcome === 'unknown') {
      return { outcome: 'unknown', reason: inProgressResult.reason };
    }
    if (inProgressResult.operations.length > 0) {
      return { outcome: 'refused', reason: 'busy' };
    }

    //    Bounded activity: the porcelain status cannot see writes to ignored
    //    files, so the removal re-runs the bounded file walk and refuses busy
    //    when the newest mtime moved past the value read under the caller's
    //    hold, or when no baseline was read, or when the walk cannot answer
    //    (conductor plan §3.10.3).
    //    Instants are compared as parsed times, never as strings, and a
    //    reading without a sub-second part is too coarse to prove quiet.
    const activity = await this.readLastActivityDetailed(
      removalActivityExecutor(executor),
      worktreePath,
    );
    if (activity.unknown || activity.coarse || expectedLastActivityIso === null) {
      return { outcome: 'refused', reason: 'busy' };
    }
    if (
      activity.iso !== null &&
      Date.parse(activity.iso) > Date.parse(expectedLastActivityIso)
    ) {
      return { outcome: 'refused', reason: 'busy' };
    }

    // 4b. Artifact-manifest gate (C2'): after every git and activity guard has
    //     succeeded, the manifest decides. An uncollected worktree is refused;
    //     a force-unsealed request (owner approval already consumed by the use
    //     case) proceeds; a sealed request is removed only when the manifest
    //     on disk still verifies, and an unreadable check is unknown — never
    //     missing, never clean.
    const manifest = request.manifest;
    if (manifest.kind === 'uncollected') {
      return { outcome: 'refused', reason: 'artifacts not collected' };
    }
    if (manifest.kind === 'sealed') {
      let check: ArtifactManifestRemovalCheckResult;
      try {
        check = await this.checkArtifactManifest({
          attemptId: manifest.attemptId,
          worktreePath,
          manifestPath: manifest.manifestPath,
          expectedManifestSha256: manifest.expectedManifestSha256,
          recordedHost: request.recordedHost ?? null,
        });
      } catch {
        return { outcome: 'unknown', reason: 'artifact-manifest-unreadable' };
      }
      if (check.outcome === 'missing') {
        return { outcome: 'refused', reason: 'artifacts not collected' };
      }
      if (check.outcome === 'mismatch') {
        return { outcome: 'refused', reason: 'artifacts changed since collection' };
      }
      if (check.outcome !== 'sealed') {
        return { outcome: 'unknown', reason: 'artifact-manifest-unreadable' };
      }
    }

    // 5. Remove: exactly these five argv entries, no flags at all.
    const removeRun = await executor.run(
      ['git', '-C', repositoryRoot, 'worktree', 'remove', worktreePath],
      { timeoutMs: GIT_TIMEOUT_MS, maxBufferBytes: REMOVAL_READ_MAX_BUFFER_BYTES },
    );
    if (removeRun.exitCode === null || removeRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'the remove did not report an exit code' };
    }
    if (removeRun.exitCode !== 0) {
      return { outcome: 'refused', reason: 'git-refused' };
    }

    // 6. Post-conditions, only after exit 0.
    const existsRun = await executor.run(['test', '-e', worktreePath], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBufferBytes: REMOVAL_READ_MAX_BUFFER_BYTES,
    });
    // `test -e` answers 1 when the directory is gone; a missing exit code, a
    // reported error or any other exit is an unanswered probe, never a proof
    // of removal.
    if (existsRun.exitCode === null || existsRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'the existence probe did not report an exit code' };
    }
    if (existsRun.exitCode === 0) {
      return { outcome: 'partial', detail: 'directory-present' };
    }
    if (existsRun.exitCode !== 1) {
      return { outcome: 'unknown', reason: 'the existence probe failed' };
    }
    const relistRun = await runRemovalGitRead(executor, repositoryRoot, [
      'worktree',
      'list',
      '--porcelain',
    ]);
    // A failed or unparseable relist cannot confirm that the administrative
    // entry is gone, so it must not be reported as `removed`.
    if (relistRun.exitCode === null || relistRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'the post-removal worktree list did not report an exit code' };
    }
    if (relistRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'the post-removal worktree list failed' };
    }
    const relisted = parseWorktreeList(relistRun.stdout);
    if (relisted === null) {
      return { outcome: 'unknown', reason: 'the post-removal worktree list output could not be parsed' };
    }
    if (listedWorktreeAt(relisted, entry.path) !== null) {
      return { outcome: 'partial', detail: 'admin-entry-present' };
    }
    return { outcome: 'removed', branchTip: head };
  }

  /**
   * Step 4 of `removeListedLaneWorktree`: the branch is the record of the
   * run (D17) — a detached entry, or one on another branch, is refused,
   * never removed.
   */
  private listedWorktreeBranchRefusal(
    entry: ListedWorktreeEntry,
    branch: string,
  ): RemoveLaneWorktreeResult | null {
    if (entry.branch === null || entry.branch !== branch) {
      return { outcome: 'refused', reason: 'branch-mismatch' };
    }
    return null;
  }

  /**
   * Step 4b of `removeListedLaneWorktree`: the listed tip is what the reap
   * journals as the recovery handle, so it must be a real commit before
   * anything is removed; an unborn or unreadable HEAD answers `null`.
   */
  private listedWorktreeBranchTip(entry: ListedWorktreeEntry): string | null {
    const branchTip = entry.head;
    if (branchTip === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(branchTip) || /^0+$/.test(branchTip)) {
      return null;
    }
    return branchTip;
  }

  /** Step 5 of `removeListedLaneWorktree`: a locked worktree is never removed. */
  private listedWorktreeLockRefusal(entry: ListedWorktreeEntry): RemoveLaneWorktreeResult | null {
    if (entry.locked) {
      return { outcome: 'refused', reason: 'locked' };
    }
    return null;
  }

  /**
   * KW2 (D18): list one registered clone's worktrees. Read-only: it never
   * prunes, removes, locks or fetches anything, and it never scans a host.
   */
  async listWorktrees(request: ListWorktreesRequest): Promise<ListWorktreesResult> {
    if (!isAbsoluteNormalisedPath(request.repositoryRoot)) {
      return { outcome: 'unknown', reason: 'invalid-request' };
    }
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'unknown', reason: 'no executor for the read' };
    }
    const run = await executor.run(
      ['git', '-C', request.repositoryRoot, 'worktree', 'list', '--porcelain'],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (run.exitCode === null || run.error !== undefined) {
      return { outcome: 'unknown', reason: 'git worktree list did not report an exit code' };
    }
    if (run.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'git worktree list failed' };
    }
    const worktrees = parseWorktreeList(run.stdout);
    if (worktrees === null) {
      return { outcome: 'unknown', reason: 'git worktree list output could not be parsed' };
    }
    return { outcome: 'listed', worktrees };
  }

  /**
   * KW2 (D18): read one worktree's removal facts — HEAD, branch or detached,
   * the ancestor answer against the default branch, the porcelain status
   * counts, the lock, the in-progress operations, the last activity and the
   * budgeted size. Every refusal happens before any command runs; a command
   * that never reports an exit code is unknown, never a guess.
   */
  async inspectWorktreeForRemoval(
    request: InspectWorktreeForRemovalRequest,
  ): Promise<InspectWorktreeForRemovalResult> {
    // 1. Validate before any command runs (no executor call on a bad request).
    if (!isValidInspectRequest(request)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const { repositoryRoot, worktreePath, defaultRef } = request;

    // 2. The read runs on the recorded host's executor; an unresolvable host
    //    is unknown — nothing is known to have been read.
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'unknown', reason: 'no executor for the read' };
    }

    // 3. List the clone's worktrees.
    const listRun = await executor.run(
      ['git', '-C', repositoryRoot, 'worktree', 'list', '--porcelain'],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (listRun.exitCode === null || listRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'git worktree list did not report an exit code' };
    }
    if (listRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'git worktree list failed' };
    }
    const listed = parseWorktreeList(listRun.stdout);
    if (listed === null) {
      return { outcome: 'unknown', reason: 'git worktree list output could not be parsed' };
    }

    // 4 & 5. Find the entry and ensure it is a linked worktree (not main checkout).
    const entry = await this.findLinkedWorktreeEntry(executor, repositoryRoot, worktreePath, listed);
    if (entry === null) {
      return { outcome: 'refused', reason: 'not-a-linked-worktree' };
    }

    // 6. Facts from the entry.
    const { head, branch, locked } = entry;
    const detached = branch === null;

    // 7. Ancestor answer against the default branch.
    const headOnDefault = await this.readHeadOnDefault(executor, worktreePath, head, defaultRef);

    // 8. Status counts.
    const statusResult = await this.readWorktreeStatus(executor, worktreePath);
    if (statusResult.outcome === 'unknown') {
      return statusResult;
    }

    // 9. In-progress operations.
    const inProgressResult = await this.readInProgressOperations(executor, worktreePath);
    if (inProgressResult.outcome === 'unknown') {
      return inProgressResult;
    }

    // 10. Last activity.
    const lastActivity = await this.readLastActivity(executor, worktreePath);

    // 11. Size (budgeted; a failure is null, never a guess).
    const sizeBytes = await this.readWorktreeSize(executor, worktreePath);

    return {
      outcome: 'inspected',
      facts: {
        path: worktreePath,
        head,
        branch,
        detached,
        headOnDefault,
        status: statusResult.status,
        locked,
        inProgressOperations: inProgressResult.operations,
        lastActivity,
        sizeBytes,
      },
    };
  }

  private async findLinkedWorktreeEntry(
    executor: CommandExecutorPort,
    repositoryRoot: string,
    worktreePath: string,
    listed: readonly ListedWorktreeEntry[],
    requirePhysicalRepositoryRoot = false,
  ): Promise<ListedWorktreeEntry | null> {
    let entry = listedWorktreeAt(listed, worktreePath);
    if (entry === null) {
      const physicalWorktreePath = await resolvePhysicalPath(executor, worktreePath, GIT_TIMEOUT_MS);
      if (physicalWorktreePath !== null && physicalWorktreePath !== worktreePath) {
        entry = listedWorktreeAt(listed, physicalWorktreePath);
      }
    }
    if (entry === null || entry.path === repositoryRoot) {
      return null;
    }
    const physicalRepositoryRoot = await resolvePhysicalPath(executor, repositoryRoot, GIT_TIMEOUT_MS);
    if (physicalRepositoryRoot !== null && entry.path === physicalRepositoryRoot) {
      return null;
    }
    // A removal must prove the entry is not the main checkout; when the
    // physical repository root cannot be resolved it cannot, so it refuses.
    if (physicalRepositoryRoot === null && requirePhysicalRepositoryRoot) {
      return null;
    }
    return entry;
  }

  private async readHeadOnDefault(
    executor: CommandExecutorPort,
    worktreePath: string,
    head: string | null,
    defaultRef: string,
  ): Promise<boolean | null> {
    if (head === null) return null;
    const mergeBaseRun = await executor.run(
      ['git', '-C', worktreePath, 'merge-base', '--is-ancestor', head, defaultRef],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (mergeBaseRun.exitCode === 0) return true;
    if (mergeBaseRun.exitCode === 1) return false;
    return null;
  }

  private async readWorktreeStatus(
    executor: CommandExecutorPort,
    worktreePath: string,
    hardened: boolean = false,
  ): Promise<{ outcome: 'read'; status: WorktreeStatusCounts } | { outcome: 'unknown'; reason: string }> {
    const statusRun = hardened
      ? await runRemovalGitRead(executor, worktreePath, ['status', '--porcelain', '--untracked-files=all'])
      : await executor.run(
          [
            'git',
            '--no-optional-locks',
            '-c',
            'core.fsmonitor=false',
            '-C',
            worktreePath,
            'status',
            '--porcelain',
            '--untracked-files=all',
          ],
          { timeoutMs: GIT_TIMEOUT_MS },
        );
    if (statusRun.exitCode === null || statusRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'git status did not report an exit code' };
    }
    if (statusRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'git status failed' };
    }
    return { outcome: 'read', status: parseWorktreeStatusCounts(statusRun.stdout) };
  }

  private async readInProgressOperations(
    executor: CommandExecutorPort,
    worktreePath: string,
    hardened: boolean = false,
  ): Promise<{ outcome: 'read'; operations: string[] } | { outcome: 'unknown'; reason: string }> {
    const gitDirRun = hardened
      ? await runRemovalGitRead(executor, worktreePath, ['rev-parse', '--git-dir'])
      : await executor.run(['git', '-C', worktreePath, 'rev-parse', '--git-dir'], {
          timeoutMs: GIT_TIMEOUT_MS,
        });
    if (gitDirRun.exitCode === null || gitDirRun.error !== undefined) {
      return { outcome: 'unknown', reason: 'git rev-parse --git-dir did not report an exit code' };
    }
    if (gitDirRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'git rev-parse --git-dir failed' };
    }
    const rawGitDir = gitDirRun.stdout.trim();
    const gitDir = rawGitDir.startsWith('/') ? rawGitDir : path.join(worktreePath, rawGitDir);
    const inProgressOperations: string[] = [];
    for (const name of IN_PROGRESS_OPERATION_FILES) {
      const probeRun = await executor.run(['test', '-e', path.join(gitDir, name)], {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBufferBytes: REMOVAL_READ_MAX_BUFFER_BYTES,
      });
      if (probeRun.exitCode === null || probeRun.error !== undefined) {
        return { outcome: 'unknown', reason: 'operation file probe did not report an exit code' };
      }
      if (probeRun.exitCode === 0) {
        inProgressOperations.push(name);
      } else if (probeRun.exitCode !== 1) {
        // Only `test -e` exit 1 means "file absent". Any other exit is an
        // unanswered probe: it cannot establish that no operation is in
        // progress, so it is never treated as absent.
        return { outcome: 'unknown', reason: 'operation file probe failed with an unexpected exit' };
      }
    }
    return { outcome: 'read', operations: inProgressOperations };
  }

  private async readWorktreeSize(
    executor: CommandExecutorPort,
    worktreePath: string,
  ): Promise<number | null> {
    const sizeRun = await executor.run(['du', '-sk', worktreePath], { timeoutMs: GIT_TIMEOUT_MS });
    if (sizeRun.exitCode !== 0 || sizeRun.error !== undefined) {
      return null;
    }
    const kb = parseDuKilobytes(sizeRun.stdout);
    return kb !== null ? kb * 1024 : null;
  }

  /**
   * KW2: read the free and total bytes of the filesystem holding a path.
   */
  async readFilesystemSpace(request: ReadFilesystemSpaceRequest): Promise<ReadFilesystemSpaceResult> {
    if (!isAbsoluteNormalisedPath(request.path)) {
      return { outcome: 'unknown', reason: 'invalid-request' };
    }
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'unknown', reason: 'no executor for the read' };
    }
    const run = await executor.run(['df', '-P', '-k', request.path], { timeoutMs: GIT_TIMEOUT_MS });
    if (run.exitCode === null || run.error !== undefined) {
      return { outcome: 'unknown', reason: 'df did not report an exit code' };
    }
    if (run.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'df failed' };
    }
    const lines = run.stdout.split('\n').filter((line) => line.trim() !== '');
    const last = lines[lines.length - 1];
    if (last === undefined) {
      return { outcome: 'unknown', reason: 'df printed no line' };
    }
    const fields = last.trim().split(/\s+/);
    const total = parseFilesystemKilobytes(fields[1]);
    const available = parseFilesystemKilobytes(fields[3]);
    if (total === null || available === null) {
      return { outcome: 'unknown', reason: 'df output could not be parsed' };
    }
    return { outcome: 'read', freeBytes: available * 1024, totalBytes: total * 1024 };
  }

  /**
   * KW2: the newest activity of one worktree — the reflog date, the index
   * mtime and the bounded tree walk, whichever is newest. `unknown` is true
   * when the tree walk did not finish (or could not be asked), never when the
   * answer is known.
   */
  private async readLastActivity(
    executor: CommandExecutorPort,
    worktreePath: string,
  ): Promise<WorktreeLastActivity> {
    const { iso, unknown } = await this.readLastActivityDetailed(executor, worktreePath);
    return { iso, unknown };
  }

  /**
   * `readLastActivity` plus `coarse`: true when any file or index reading
   * carried no sub-second part, so an equal-to-baseline answer cannot prove
   * that nothing was written later in the same second.
   */
  private async readLastActivityDetailed(
    executor: CommandExecutorPort,
    worktreePath: string,
  ): Promise<{ iso: string | null; unknown: boolean; coarse: boolean }> {
    // reflog: the newest reflog entry's timestamp; a non-zero exit or empty
    // stdout contributes nothing.
    let newestMs: number | null = null;
    const reflogMs = await readReflogActivityMs(executor, worktreePath);
    if (reflogMs !== null) {
      newestMs = reflogMs;
    }
    // An unreadable reflog is an unreadable activity source: too coarse to prove quiet.
    let coarse = reflogMs === null;

    // Detect the `stat` flavour once: GNU (`-c %Y`) or BSD (`-f %m`).
    const flavour = await detectStatFlavour(executor, worktreePath);

    let unknown = false;
    if (flavour === null) {
      // Neither stat answered: the index mtime and the walk are unknown.
      unknown = true;
    } else {
      // Index mtime: resolve the index path, then stat it with the detected flavour.
      const indexMtime = await readIndexActivityMs(executor, worktreePath, flavour);
      if (indexMtime === null) {
        // An unreadable index is an unreadable activity source: too coarse to prove quiet.
        coarse = true;
      } else {
        if (!indexMtime.fractional) coarse = true;
        if (newestMs === null || indexMtime.ms > newestMs) {
          newestMs = indexMtime.ms;
        }
      }

      // Bounded tree walk: newest file mtime under the worktree, skipping .git.
      const walk = await walkTreeActivity(executor, worktreePath, flavour);
      if (walk.newestMs !== null && (newestMs === null || walk.newestMs > newestMs)) {
        newestMs = walk.newestMs;
      }
      if (walk.coarse) {
        coarse = true;
      }
      if (walk.unknown) {
        unknown = true;
      }
    }

    if (newestMs === null) {
      return { iso: null, unknown: true, coarse };
    }
    return { iso: new Date(newestMs).toISOString(), unknown, coarse };
  }

  /**
   * K7-5a, step 3's read side: prove the existing path is exactly the
   * prepared worktree — a listed worktree of this clone, on `branch`, HEAD
   * at `baseCommit`, nothing uncommitted or untracked — or refuse. A
   * command that never reported an exit code is `unknown`, not a refusal.
   */
  private async alreadyPreparedOutcome(
    executor: CommandExecutorPort,
    clonePath: string,
    worktreePath: string,
    branch: string,
    baseCommit: string,
  ): Promise<PrepareLaneWorktreeResult> {
    const [headRun, statusRun, listRun] = await Promise.all([
      executor.run(
        // --abbrev-ref applies to every later argument, so the commit is asked for before it:
        // stdout is the toplevel, the full HEAD commit, then the branch name.
        ['git', '-C', worktreePath, 'rev-parse', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'],
        { timeoutMs: GIT_TIMEOUT_MS },
      ),
      executor.run(
        ['git', '-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'],
        { timeoutMs: GIT_TIMEOUT_MS },
      ),
      executor.run(['git', '-C', clonePath, 'worktree', 'list', '--porcelain'], {
        timeoutMs: GIT_TIMEOUT_MS,
      }),
    ]);
    const commands = [headRun, statusRun, listRun];
    if (commands.some((run) => run.exitCode === null || run.error !== undefined)) {
      return { outcome: 'unknown' };
    }
    if (commands.some((run) => run.exitCode !== 0)) {
      return { outcome: 'refused', reason: 'path-exists-other' };
    }
    const revParseLines = headRun.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const [toplevel, head, checkedBranch] = revParseLines;
    const listedWorktrees = listRun.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => unquotePorcelainPath(line.slice('worktree '.length).trim()));
    // A symlinked worktree (macOS `/var/folders/...` → `/private/var/...`) has
    // `--show-toplevel` and `worktree list` print the physical path while the
    // request holds the path as given; accept either form. Unresolvable falls
    // back to the plain comparison.
    const physicalWorktreePath = await resolvePhysicalPath(
      executor,
      worktreePath,
      GIT_TIMEOUT_MS,
    );
    const toplevelMatches =
      toplevel === worktreePath ||
      (physicalWorktreePath !== null && toplevel === physicalWorktreePath);
    const listedMatches =
      listedWorktrees.includes(worktreePath) ||
      (physicalWorktreePath !== null && listedWorktrees.includes(physicalWorktreePath));
    const exactlyPrepared =
      toplevelMatches &&
      checkedBranch === branch &&
      head === baseCommit &&
      statusRun.stdout.trim() === '' &&
      listedMatches;
    return exactlyPrepared
      ? { outcome: 'already-prepared' }
      : { outcome: 'refused', reason: 'path-exists-other' };
  }
}
