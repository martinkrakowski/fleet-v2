/**
 * Pure, probe-injected checked deploy sequencing. The engine spawns nothing,
 * opens no socket and reads no file: every side effect enters through a
 * `DeployProbes` implementation. Any probe throw, missing probe method or
 * invalid probe result becomes a refusal, never a crash, and an attempted
 * but unconfirmed repoint is rolled back to the previous target.
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

/** Validate the deploy request; returns the refusal detail or `undefined`. */
function validateRequest(request: DeployRequest): string | undefined {
  if (
    typeof request !== 'object' ||
    request === null ||
    !isNonEmptyString(request.repoPath) ||
    !isNonEmptyString(request.stagingPath) ||
    !isNonEmptyString(request.installLink) ||
    typeof request.commit !== 'string' ||
    !/^[0-9a-fA-F]{40,64}$/.test(request.commit) ||
    !Array.isArray(request.buildArgv) ||
    request.buildArgv.length === 0 ||
    !request.buildArgv.every((s) => isPlainArg(s)) ||
    !Array.isArray(request.suiteArgvs) ||
    request.suiteArgvs.length === 0 ||
    !request.suiteArgvs.every(
      (argv) =>
        Array.isArray(argv) &&
        argv.length > 0 &&
        argv.every((s) => isPlainArg(s)),
    )
  ) {
    return 'invalid-request';
  }
  return undefined;
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

    let invalid: string | undefined;
    try {
      invalid = validateRequest(request);
    } catch {
      // A throwing getter on the request is a malformed request, not a
      // probe failure.
      invalid = 'invalid-request';
    }
    if (invalid !== undefined) {
      return refusal('invalid-request', 'invalid-request');
    }

    // Only an explicit boolean is a valid merge result: any other value is
    // a probe failure, never silently "no merge".
    const mergeBeforeBuild = await probes.mergeInProgress(request.repoPath);
    if (mergeBeforeBuild === true) {
      return refusal('merge-in-progress', 'merge-in-progress');
    }
    if (mergeBeforeBuild !== false) {
      return refusal('probe-failed', 'probe-failed');
    }

    const head = await probes.headCommit(request.repoPath);
    if (
      typeof head !== 'string' ||
      head.trim().length === 0 ||
      !/^[0-9a-fA-F]{40,64}$/.test(head.trim())
    ) {
      return refusal('commit-mismatch', 'commit-mismatch');
    }
    if (head.trim().toLowerCase() !== request.commit.toLowerCase()) {
      return refusal('commit-mismatch', 'commit-mismatch');
    }

    const build = await probes.runCommand(request.buildArgv, request.repoPath);
    if (build === null || build === undefined || build.exitCode !== 0) {
      return refusal('build-failed', 'build-failed at step 0');
    }

    for (let i = 0; i < request.suiteArgvs.length; i++) {
      const suite = await probes.runCommand(
        request.suiteArgvs[i] as readonly string[],
        request.repoPath,
      );
      if (suite === null || suite === undefined || suite.exitCode !== 0) {
        return refusal('suite-failed', `suite-failed at step ${i}`);
      }
    }

    const stagedDigest = await probes.digestTree(request.stagingPath);
    if (typeof stagedDigest !== 'string' || stagedDigest.trim().length === 0) {
      return refusal('probe-failed', 'probe-failed');
    }

    // Same explicit-boolean rule for the pre-repoint merge re-check.
    const mergeBeforeRepoint = await probes.mergeInProgress(request.repoPath);
    if (mergeBeforeRepoint === true) {
      return refusal('merge-in-progress', 'merge-in-progress before repoint');
    }
    if (mergeBeforeRepoint !== false) {
      return refusal('probe-failed', 'probe-failed');
    }

    // Only `undefined` (no current target) or a valid non-empty string is
    // an acceptable previous target; anything else is a probe failure.
    const target = await probes.currentTarget(request.installLink);
    if (target !== undefined && !isNonEmptyString(target)) {
      return refusal('probe-failed', 'probe-failed');
    }
    previousTarget = target;

    repointAttempted = true;
    await probes.repoint(request.installLink, request.stagingPath);

    const installedDigest = await probes.digestTree(request.installLink);
    if (installedDigest !== stagedDigest) {
      if (previousTarget !== undefined) {
        try {
          await probes.repoint(request.installLink, previousTarget);
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
    if (repointAttempted && !repointConfirmed && previousTarget !== undefined) {
      try {
        await probes.repoint(request.installLink, previousTarget);
      } catch {
        // A rollback error must not mask `probe-failed`.
      }
    }
    return refusal('probe-failed', 'probe-failed');
  }
}
