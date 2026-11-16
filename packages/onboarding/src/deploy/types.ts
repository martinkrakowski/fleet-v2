/**
 * Checked deploy types. Pure data: a deploy request names the repository,
 * commit, build and suite commands, staging path and install link; a result
 * is a verified deploy, a refusal with a reason code, or one of two
 * failed-install outcomes (`rollback-failed` or `no-rollback-target`). A
 * detail
 * never contains command output, paths, commit hashes or tokens — only
 * step numbers and reason codes.
 */

/** Every side effect a checked deploy performs, injected by the caller. */
export interface DeployProbes {
  /** Whether a merge is in progress in the repository. */
  mergeInProgress(repoPath: string): Promise<boolean>;
  /** The commit the repository's `HEAD` currently points at. */
  headCommit(repoPath: string): Promise<string>;
  /** Run one argv command in a working directory; never a shell string. */
  runCommand(
    argv: readonly string[],
    cwd: string,
  ): Promise<{ exitCode: number | null }>;
  /** A content digest of the tree at `path`. */
  digestTree(path: string): Promise<string>;
  /** The target the install link currently points at, or `undefined`. */
  currentTarget(link: string): Promise<string | undefined>;
  /** Atomically point the install link at `target`. */
  repoint(link: string, target: string): Promise<void>;
}

/** A fully-specified request to deploy a verified build. */
export interface DeployRequest {
  /** The repository the build and suites run in. */
  readonly repoPath: string;
  /** The commit expected at `HEAD`: 40-64 hex characters. */
  readonly commit: string;
  /** The build command, as an argv (never a shell string). */
  readonly buildArgv: readonly string[];
  /** The test suites, each as an argv, run in order. */
  readonly suiteArgvs: readonly (readonly string[])[];
  /** The staged build tree the digest is taken from. */
  readonly stagingPath: string;
  /** The install link atomically repointed at the staged build. */
  readonly installLink: string;
}

/** Why a checked deploy refused to proceed. */
export type DeployRefusalReason =
  | 'invalid-request'
  | 'merge-in-progress'
  | 'commit-mismatch'
  | 'build-failed'
  | 'suite-failed'
  | 'bytes-mismatch'
  | 'probe-failed';

/** Why an install failed after the install link was repointed. */
export type DeployInstallFailure = 'bytes-mismatch' | 'probe-failed';

/** The outcome of one checked deploy attempt. */
export type DeployResult =
  | {
      readonly outcome: 'deployed';
      /** The verified digest of the installed build. */
      readonly digest: string;
      /** The target the install link pointed at before the deploy. */
      readonly previousTarget: string | undefined;
      /** The commit `HEAD` was verified at, in lower case. */
      readonly commit: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: DeployRefusalReason;
      /** Step numbers and reason codes only — never output or secrets. */
      readonly detail: string;
    }
  | {
      readonly outcome: 'rollback-failed';
      readonly reason: DeployInstallFailure;
      /** The install link is in an unknown state. */
      readonly detail: string;
    }
  | {
      readonly outcome: 'no-rollback-target';
      readonly reason: DeployInstallFailure;
      /** The install link may point at an unverified build and was not removed. */
      readonly detail: string;
    };
