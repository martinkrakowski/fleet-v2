/**
 * Pure, probe-injected checked deploy sequencing. The engine spawns nothing,
 * opens no socket and reads no file: every side effect enters through a
 * `DeployProbes` implementation. Any probe throw, missing probe method or
 * invalid probe result becomes a refusal, never a crash, and an attempted
 * but unconfirmed repoint is rolled back to the previous target. Request
 * fields are snapshotted during validation and never re-read afterwards.
 */

import type { DeployProbes, DeployRequest, DeployResult } from './types.js';

/** The probe methods a `DeployProbes` implementation must provide. */
function probeMethods(): string[] {
  return [
    'mergeInProgress',
    'headCommit',
    'runCommand',
    'digestTree',
    'currentTarget',
    'repoint',
  ];
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * An argv element must be a single argument, never a shell string: no
 * whitespace and no shell metacharacters.
 */
function isPlainArg(value: unknown): boolean {
  return isNonEmptyString(value) && !/[\s;&|><$`"']/.test(value as string);
}

/** An argv must be a non-empty array of plain single arguments. */
function isPlainArgv(argv: unknown): boolean {
  return (
    Array.isArray(argv) && argv.length > 0 && argv.every((s) => isPlainArg(s))
  );
}

/** A validated deploy request, snapshotted into plain values. */
interface RequestSnapshot {
  readonly repoPath: string;
  readonly commit: string;
  readonly buildArgv: readonly string[];
  readonly suiteArgvs: readonly (readonly string[])[];
  readonly stagingPath: string;
  readonly installLink: string;
}

/**
 * Read every request field exactly once into a snapshot and validate it,
 * then read every field a second time to flush unstable getters: a field
 * that throws or drifts between reads is refused as `invalid-request`
 * here — with zero probe calls — instead of surfacing after probes have
 * already run. Returns `undefined` for a refused request.
 */
function snapshotRequest(request: DeployRequest): RequestSnapshot | undefined {
  if (typeof request !== 'object' || request === null) {
    return undefined;
  }
  const snapshot: RequestSnapshot = {
    repoPath: request.repoPath,
    commit: request.commit,
    buildArgv: request.buildArgv,
    suiteArgvs: request.suiteArgvs,
    stagingPath: request.stagingPath,
    installLink: request.installLink,
  };
  if (
    !isNonEmptyString(snapshot.repoPath) ||
    !isNonEmptyString(snapshot.stagingPath) ||
    !isNonEmptyString(snapshot.installLink) ||
    typeof snapshot.commit !== 'string' ||
    !/^[0-9a-fA-F]{40,64}$/.test(snapshot.commit) ||
    !isPlainArgv(snapshot.buildArgv) ||
    !Array.isArray(snapshot.suiteArgvs) ||
    snapshot.suiteArgvs.length === 0 ||
    !snapshot.suiteArgvs.every((argv) => isPlainArgv(argv))
  ) {
    return undefined;
  }
  // The same value must come back on every read: the sequencing below
  // works from the snapshot only and never re-reads the request.
  if (
    request.repoPath !== snapshot.repoPath ||
    request.commit !== snapshot.commit ||
    request.buildArgv !== snapshot.buildArgv ||
    request.suiteArgvs !== snapshot.suiteArgvs ||
    request.stagingPath !== snapshot.stagingPath ||
    request.installLink !== snapshot.installLink
  ) {
    return undefined;
  }
  return snapshot;
}

function refusal(reason: string, detail: string): DeployResult {
  return { outcome: 'refused', reason: reason as never, detail };
}

/**
 * Run the checked deploy in exact order: validate, refuse on merge,
 * verify `HEAD`, build, run suites, digest the staged build, re-check for
 * a merge, repoint atomically, verify installed bytes and roll back on
 * mismatch or an unconfirmed repoint.
 */
export async function runCheckedDeploy(
  request: DeployRequest,
  probes: DeployProbes,
): Promise<DeployResult> {
  let repointAttempted = false;
  let repointConfirmed = false;
  let previousTarget: string | undefined;
  // Every request field is snapshotted during validation; the sequencing
  // below never re-reads `request`, so a getter that throws between reads
  // cannot turn a validated request into a late failure after probes have
  // run.
  let req: RequestSnapshot | undefined;

  try {
    if (typeof probes !== 'object' || probes === null) {
      return refusal('probe-failed', 'probe-failed');
    }
    const methods = probeMethods();
    for (const method of methods) {
      if (typeof probes[method as keyof DeployProbes] !== 'function') {
        return refusal('probe-failed', 'probe-failed');
      }
    }

    try {
      req = snapshotRequest(request);
    } catch {
      // A throwing getter on the request is a malformed request, not a
      // probe failure.
      req = undefined;
    }
    if (req === undefined) {
      return refusal('invalid-request', 'invalid-request');
    }

    // Only an explicit boolean is a valid merge result: any other value is
    // a probe failure, never silently "no merge".
    const mergeBeforeBuild = await probes.mergeInProgress(req.repoPath);
    if (mergeBeforeBuild === true) {
      return refusal('merge-in-progress', 'merge-in-progress');
    }
    if (mergeBeforeBuild !== false) {
      return refusal('probe-failed', 'probe-failed');
    }

    const head = await probes.headCommit(req.repoPath);
    if (
      typeof head !== 'string' ||
      head.trim().length === 0 ||
      !/^[0-9a-fA-F]{40,64}$/.test(head.trim())
    ) {
      return refusal('commit-mismatch', 'commit-mismatch');
    }
    if (head.trim().toLowerCase() !== req.commit.toLowerCase()) {
      return refusal('commit-mismatch', 'commit-mismatch');
    }

    const build = await probes.runCommand(req.buildArgv, req.repoPath);
    if (build === null || build === undefined || build.exitCode !== 0) {
      return refusal('build-failed', 'build-failed at step 0');
    }

    for (let i = 0; i < req.suiteArgvs.length; i++) {
      const suite = await probes.runCommand(
        req.suiteArgvs[i] as readonly string[],
        req.repoPath,
      );
      if (suite === null || suite === undefined || suite.exitCode !== 0) {
        return refusal('suite-failed', `suite-failed at step ${i}`);
      }
    }

    const stagedDigest = await probes.digestTree(req.stagingPath);
    if (typeof stagedDigest !== 'string' || stagedDigest.trim().length === 0) {
      return refusal('probe-failed', 'probe-failed');
    }

    // Same explicit-boolean rule for the pre-repoint merge re-check.
    const mergeBeforeRepoint = await probes.mergeInProgress(req.repoPath);
    if (mergeBeforeRepoint === true) {
      return refusal('merge-in-progress', 'merge-in-progress before repoint');
    }
    if (mergeBeforeRepoint !== false) {
      return refusal('probe-failed', 'probe-failed');
    }

    // Only `undefined` (no current target) or a valid non-empty string is
    // an acceptable previous target; anything else is a probe failure.
    const target = await probes.currentTarget(req.installLink);
    if (target !== undefined && !isNonEmptyString(target)) {
      return refusal('probe-failed', 'probe-failed');
    }
    previousTarget = target;

    repointAttempted = true;
    await probes.repoint(req.installLink, req.stagingPath);

    const installedDigest = await probes.digestTree(req.installLink);
    if (
      typeof installedDigest !== 'string' ||
      installedDigest.trim().length === 0
    ) {
      // A null, undefined or empty digest is an invalid probe result, not
      // a mismatch: the repoint is still unconfirmed, so restore the
      // previous target and refuse as probe-failed.
      if (previousTarget !== undefined) {
        try {
          await probes.repoint(req.installLink, previousTarget);
        } catch {
          // A rollback error must not mask `probe-failed`.
        }
      }
      return refusal('probe-failed', 'probe-failed');
    }
    if (installedDigest !== stagedDigest) {
      if (previousTarget !== undefined) {
        try {
          await probes.repoint(req.installLink, previousTarget);
        } catch {
          // A rollback error must not mask `bytes-mismatch`.
        }
      }
      return refusal('bytes-mismatch', 'bytes-mismatch');
    }

    repointConfirmed = true;
    return {
      outcome: 'deployed',
      digest: installedDigest,
      previousTarget,
    };
  } catch {
    if (
      req !== undefined &&
      repointAttempted &&
      !repointConfirmed &&
      previousTarget !== undefined
    ) {
      try {
        await probes.repoint(req.installLink, previousTarget);
      } catch {
        // A rollback error must not mask `probe-failed`.
      }
    }
    return refusal('probe-failed', 'probe-failed');
  }
}
