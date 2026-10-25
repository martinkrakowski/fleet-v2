/**
 * ProjectProbePort is the outbound contract for a read-only probe of a
 * project before registration or after an edit: the repository answers, and
 * on each lane-runner host the clone is there and correctly set up. It never
 * runs a fix; an unreachable host is `unknown`; a repository URL carrying a
 * credential (any `http://` or `https://` URL with any userinfo, any
 * `scheme://user:password@` URL, or an scp-like `user:password@host:path`
 * form; `ssh://git@host/p` and `git@github.com:o/r` stay allowed because a
 * bare ssh login name is not a secret) is refused without running anything;
 * fix hints redact URL userinfo and single-quote every shell argument; and no
 * command output that could carry a credential (stderr, a remote URL, an
 * unsafe ref) is ever copied into a `detail` or `defaultBranch`.
 */

export type ProjectProbeResult = 'pass' | 'fail' | 'unknown';

export interface ProjectProbeCheck {
  readonly name: string;
  readonly host: string | null;
  readonly result: ProjectProbeResult;
  readonly detail: string;
}

export interface ProjectProbeClone {
  readonly path: string;
  readonly worktreeRoot: string;
}

export interface ProjectProbeRequest {
  readonly repository: string;
  /** Installation host name → its clone; may be empty. */
  readonly clones: Readonly<Record<string, ProjectProbeClone>>;
}

export interface ProjectProbeReport {
  readonly probedAtIso: string;
  readonly probedFrom: 'orchestrator';
  readonly checks: readonly ProjectProbeCheck[];
  /** Default branch named by the remote's HEAD, or null when not established. */
  readonly defaultBranch: string | null;
  /** `package.json` script NAMES from the first clone that answered; never their values. */
  readonly detectedScripts: readonly string[];
}

export interface ProjectProbePort {
  probe(request: ProjectProbeRequest): Promise<ProjectProbeReport>;
}
