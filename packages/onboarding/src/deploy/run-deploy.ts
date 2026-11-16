/**
 * Pure, probe-injected checked deploy sequencing. The engine spawns nothing,
 * opens no socket and reads no file: every side effect enters through a
 * `DeployProbes` implementation. Any probe throw, missing probe method or
 * invalid probe result becomes a refusal, never a crash. `HEAD` is re-read
 * once immediately before the repoint, so a commit that moved during the
 * build is refused. A failed or unverifiable install rollback is reported
 * as `rollback-failed` or `no-rollback-target`, never as a plain refusal.
 * Request fields are snapshotted during validation and never re-read
 * afterwards.
 */

import type {
  DeployInstallFailure,
  DeployProbes,
  DeployRequest,
  DeployResult,
} from './types.js';

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

/** Whether a `HEAD` reading names exactly the expected commit. */
function headMatches(head: unknown, commit: string): boolean {
  return (
    typeof head === 'string' &&
    head.trim().length > 0 &&
    /^[0-9a-fA-F]{40,64}$/.test(head.trim()) &&
    head.trim().toLowerCase() === commit.toLowerCase()
  );
}

/**
 * Restore the install link to its previous target after a failed install:
 * repoint at most once, verify the restore by reading the target back and
 * never throw. With no previous target there is nothing to restore, so the
 * link is left pointing at the unverified build.
 */
async function restorePrevious(
  probes: DeployProbes,
  link: string,
  previousTarget: string | undefined,
): Promise<'restored' | 'rollback-failed' | 'no-rollback-target'> {
  if (previousTarget === undefined) {
    return 'no-rollback-target';
  }
  try {
    await probes.repoint(link, previousTarget);
    const restoredTarget = await probes.currentTarget(link);
    return restoredTarget === previousTarget ? 'restored' : 'rollback-failed';
  } catch {
    return 'rollback-failed';
  }
}

/**
 * Turn a failed install plus the outcome of the restore into the result
 * the operator sees: a verified restore is a plain refusal; an unknown or
 * impossible restore is a distinct failed-install outcome.
 */
function installFailure(
  reason: DeployInstallFailure,
  state: 'restored' | 'rollback-failed' | 'no-rollback-target',
): DeployResult {
  if (state === 'restored') {
    return refusal(reason, reason);
  }
  return { outcome: state, reason, detail: `${reason}; ${state}` };
}

type Refused = DeployResult | undefined;

/** Every probe method must exist; otherwise the run is a probe failure. */
function probesComplete(probes: DeployProbes): boolean {
  if (typeof probes !== 'object' || probes === null) {
    return false;
  }
  return probeMethods().every(
    (method) => typeof probes[method as keyof DeployProbes] === 'function',
  );
}

/** Snapshot the request; a throwing getter is a malformed request. */
function trySnapshot(request: DeployRequest): RequestSnapshot | undefined {
  try {
    return snapshotRequest(request);
  } catch {
    return undefined;
  }
}

/**
 * Only an explicit boolean is a valid merge result: any other value is a
 * probe failure, never silently "no merge". Returns a refusal or
 * `undefined` to continue.
 */
async function refuseOnMerge(
  probes: DeployProbes,
  repoPath: string,
  mergeDetail: string,
): Promise<Refused> {
  const merge = await probes.mergeInProgress(repoPath);
  if (merge === true) {
    return refusal('merge-in-progress', mergeDetail);
  }
  if (merge !== false) {
    return refusal('probe-failed', 'probe-failed');
  }
  return undefined;
}

/** Refuse unless `HEAD` names exactly the requested commit. */
async function refuseOnHead(
  probes: DeployProbes,
  req: RequestSnapshot,
  detail: string,
): Promise<Refused> {
  const head = await probes.headCommit(req.repoPath);
  return headMatches(head, req.commit)
    ? undefined
    : refusal('commit-mismatch', detail);
}

/** Run the build, then every suite in order; stop at the first failure. */
async function refuseOnBuildOrSuite(
  probes: DeployProbes,
  req: RequestSnapshot,
): Promise<Refused> {
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
  return undefined;
}

/** A digest probe result must be a non-empty string. */
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Merge re-check, then the `HEAD` re-read, both immediately before repoint. */
async function refuseBeforeRepoint(
  probes: DeployProbes,
  req: RequestSnapshot,
): Promise<Refused> {
  const merge = await refuseOnMerge(
    probes,
    req.repoPath,
    'merge-in-progress before repoint',
  );
  if (merge !== undefined) {
    return merge;
  }
  return refuseOnHead(probes, req, 'commit-mismatch before repoint');
}

/** What the install link pointed at before the repoint, if anything. */
type PreviousTarget =
  | { readonly refused: DeployResult }
  | { readonly refused?: undefined; readonly target: string | undefined };

/**
 * Only `undefined` (no current target) or a valid non-empty string is an
 * acceptable previous target; anything else is a probe failure.
 */
async function readPreviousTarget(
  probes: DeployProbes,
  link: string,
): Promise<PreviousTarget> {
  const target = await probes.currentTarget(link);
  if (target !== undefined && !isNonEmptyString(target)) {
    return { refused: refusal('probe-failed', 'probe-failed') };
  }
  return { target };
}

/**
 * Compare the installed bytes with the staged bytes; any shortfall restores
 * the previous target (once) and reports the failed install.
 */
async function confirmInstalled(
  probes: DeployProbes,
  req: RequestSnapshot,
  stagedDigest: string,
  previousTarget: string | undefined,
): Promise<DeployResult | string> {
  const installedDigest = await probes.digestTree(req.installLink);
  let failure: DeployInstallFailure | undefined;
  if (!isDigest(installedDigest)) {
    failure = 'probe-failed';
  } else if (installedDigest !== stagedDigest) {
    failure = 'bytes-mismatch';
  }
  if (failure === undefined) {
    return installedDigest;
  }
  return installFailure(
    failure,
    await restorePrevious(probes, req.installLink, previousTarget),
  );
}

/**
 * Run the checked deploy in exact order: validate, refuse on merge,
 * verify `HEAD`, build, run suites, digest the staged build, re-check for
 * a merge, re-read `HEAD`, repoint atomically, verify installed bytes and
 * report rollback-failed or no-rollback-target on mismatch or an
 * unconfirmed repoint.
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
    if (!probesComplete(probes)) {
      return refusal('probe-failed', 'probe-failed');
    }
    req = trySnapshot(request);
    if (req === undefined) {
      return refusal('invalid-request', 'invalid-request');
    }

    const refusedBeforeBuild =
      (await refuseOnMerge(probes, req.repoPath, 'merge-in-progress')) ??
      (await refuseOnHead(probes, req, 'commit-mismatch')) ??
      (await refuseOnBuildOrSuite(probes, req));
    if (refusedBeforeBuild !== undefined) {
      return refusedBeforeBuild;
    }

    const stagedDigest = await probes.digestTree(req.stagingPath);
    if (!isDigest(stagedDigest)) {
      return refusal('probe-failed', 'probe-failed');
    }

    const refusedBeforeRepoint = await refuseBeforeRepoint(probes, req);
    if (refusedBeforeRepoint !== undefined) {
      return refusedBeforeRepoint;
    }

    const previous = await readPreviousTarget(probes, req.installLink);
    if (previous.refused !== undefined) {
      return previous.refused;
    }
    previousTarget = previous.target;

    repointAttempted = true;
    await probes.repoint(req.installLink, req.stagingPath);

    const installed = await confirmInstalled(
      probes,
      req,
      stagedDigest,
      previousTarget,
    );
    if (typeof installed !== 'string') {
      return installed;
    }

    repointConfirmed = true;
    return {
      outcome: 'deployed',
      digest: installed,
      previousTarget,
      commit: req.commit.toLowerCase(),
    };
  } catch {
    if (req !== undefined && repointAttempted && !repointConfirmed) {
      return installFailure(
        'probe-failed',
        await restorePrevious(probes, req.installLink, previousTarget),
      );
    }
    return refusal('probe-failed', 'probe-failed');
  }
}
