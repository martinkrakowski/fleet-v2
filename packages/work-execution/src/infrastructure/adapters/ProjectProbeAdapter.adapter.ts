/**
 * ProjectProbeAdapter implements ProjectProbePort over two injected
 * CommandExecutorPorts (orchestrator and per-host) — a read-only probe that
 * never runs a fix. It answers three questions about a project: does the
 * repository answer, and on each lane-runner host is the clone there and
 * correctly set up? An unreachable host is `unknown`; a failing check carries
 * the command that would fix it; nothing is ever run to fix it. No command
 * output that could carry a credential (stderr, a remote URL) is ever copied
 * into a `detail`.
 */

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from "../../application/ports/out/CommandExecutorPort.out-port.js";
import type {
  ProjectProbeCheck,
  ProjectProbeClone,
  ProjectProbePort,
  ProjectProbeReport,
  ProjectProbeRequest,
} from "../../application/ports/out/ProjectProbePort.out-port.js";
import type { ExecutorForRecordedHostResult } from "./ExecutorForHost.helper.js";
import { resolvePhysicalPath } from "./ResolvePhysicalPath.helper.js";

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export interface ProjectProbeAdapterOptions {
  /** The orchestrator's own executor (never a remote host). */
  readonly orchestrator: CommandExecutorPort;
  /** Selects the executor for a named installation host; may refuse. */
  readonly executorForHost: (hostName: string) => ExecutorForRecordedHostResult;
  readonly now?: () => Date;
  /** Wall-clock budget per command; defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Applied to every git command, hardening it against the repository's own
 * config and against credential prompts: no pager, no fsmonitor, no repository
 * hooks, no protocol transport outside the allowed set, and no terminal
 * askpass. `protocol.allow=never` closes every transport, then each protocol is
 * re-opened explicitly — a plain URL is always https/ssh/git/file, never a
 * subordinate protocol like `ext::` or an `-oProxyCommand` injection.
 */
export const GIT_HARDENING = [
  "-c",
  "core.pager=cat",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "protocol.git.allow=always",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "protocol.version=2",
] as const;

/**
 * Minimal environment for the orchestrator's `git ls-remote`: no inherited
 * secrets, no credential prompts, and `SSH_AUTH_SOCK` passed through when set
 * so git over ssh can reach the agent.
 */
function orchestratorEnv(): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    ...(process.env.SSH_AUTH_SOCK !== undefined
      ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
      : {}),
  };
}

/** Single-quote a value for a shell hint, escaping `'` as `'\''`. */
function shellQuote(v: string): string {
  return `'${v.replaceAll("'", String.raw`'\''`)}'`;
}

/** Strip `scheme://<userinfo>@` (up to the last `@` before the first `/`) to `scheme://`. */
export function redactUserinfo(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");
}

function hasRepositoryCredential(repository: string): boolean {
  // Scheme-less form (`user:secret@host:path`), checked on every input so a
  // `user:secret@` before a later `://` is never missed.
  const slash = repository.indexOf("/");
  const beforeSlash = slash === -1 ? repository : repository.slice(0, slash);
  const firstAt = beforeSlash.indexOf("@");
  if (firstAt !== -1 && beforeSlash.slice(0, firstAt).includes(":")) return true;

  const schemeEnd = repository.indexOf("://");
  if (schemeEnd === -1) return false;
  const scheme = repository.slice(0, schemeEnd).toLowerCase();
  const rest = repository.slice(schemeEnd + 3);
  const restSlash = rest.indexOf("/");
  const authority = restSlash === -1 ? rest : rest.slice(0, restSlash);
  const at = authority.lastIndexOf("@");
  if (at === -1) return false;
  if (scheme === "http" || scheme === "https") return true;
  return authority.slice(0, at).includes(":");
}

/** Trim whitespace and strip one trailing `/` then one trailing `.git`. */
function normaliseRepository(value: string): string {
  let v = value.trim();
  if (v.endsWith("/")) v = v.slice(0, -1);
  if (v.endsWith(".git")) v = v.slice(0, -4);
  return v;
}

export class ProjectProbeAdapter implements ProjectProbePort {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly options: ProjectProbeAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async probe(request: ProjectProbeRequest): Promise<ProjectProbeReport> {
    const repository = request.repository.trim();
    const checks: ProjectProbeCheck[] = [];
    let defaultBranch: string | null = null;
    // The first sorted host whose `clone-is-work-tree` passed supplies the
    // detected scripts; never re-resolve it once recorded.
    let scriptsSource: { host: string; path: string; executor: CommandExecutorPort } | null = null;

    const repositoryAnswers = await this.repositoryAnswers(repository);
    checks.push(repositoryAnswers.check);
    defaultBranch = repositoryAnswers.defaultBranch;
    if (repositoryAnswers.refused) {
      return {
        probedAtIso: this.now().toISOString(),
        probedFrom: "orchestrator",
        checks,
        defaultBranch: null,
        detectedScripts: [],
      };
    }

    const hostNames = Object.keys(request.clones).sort(compareCodeUnits);
    for (const host of hostNames) {
      const clone = request.clones[host];
      const hostExecutor = this.options.executorForHost(host);
      if (!hostExecutor.ok) {
        checks.push(this.check("host-reachable", host, "unknown", hostExecutor.reason));
        continue;
      }
      const executor = hostExecutor.executor;
      if (await this.probeHost(host, clone, repository, checks, executor)) {
        scriptsSource ??= { host, path: clone.path, executor };
      }
    }

    return {
      probedAtIso: this.now().toISOString(),
      probedFrom: "orchestrator",
      checks,
      defaultBranch,
      detectedScripts: scriptsSource === null ? [] : await this.detectScripts(scriptsSource),
    };
  }

  private async probeHost(
    host: string,
    clone: ProjectProbeClone,
    repository: string,
    checks: ProjectProbeCheck[],
    executor: CommandExecutorPort,
  ): Promise<boolean> {
    // clone-is-work-tree
    const workTree = await this.runGit(executor, [
      "-C",
      clone.path,
      "rev-parse",
      "--show-toplevel",
    ]);
    if (this.unreachable(workTree)) {
      checks.push(this.check("clone-is-work-tree", host, "unknown", `${host} did not answer`));
      // STOP this host's remaining checks: the host is not answering.
      return false;
    }
    let clonePassed = false;
    if (workTree.exitCode === 0) {
      const toplevel = workTree.stdout.trim();
      // A symlinked clone (macOS `/var/folders/...` → `/private/var/...`) has
      // `--show-toplevel` print the physical path while the profile holds the
      // path as given; accept either form. Unresolvable falls back to plain.
      const physicalClonePath = await resolvePhysicalPath(executor, clone.path, this.timeoutMs);
      if (toplevel === clone.path || (physicalClonePath !== null && toplevel === physicalClonePath)) {
        checks.push(this.check("clone-is-work-tree", host, "pass", `git work tree at ${clone.path}`));
        clonePassed = true;
      } else {
        checks.push(
          this.check(
            "clone-is-work-tree",
            host,
            "fail",
            `${clone.path} is inside another repository at ${toplevel}; use the clone's own root`,
          ),
        );
      }
    } else {
      checks.push(
        this.check(
          "clone-is-work-tree",
          host,
          "fail",
          `no git work tree at ${clone.path}; on ${host} run: git clone ${shellQuote(redactUserinfo(repository))} ${shellQuote(clone.path)}`,
        ),
      );
    }

    checks.push(await this.originMatches(executor, host, clone.path, repository));
    checks.push(await this.worktreeRootExists(executor, host, clone.worktreeRoot));
    checks.push(await this.laneDirIgnored(executor, host, clone.path));
    checks.push(await this.agentInstructionsTracked(executor, host, clone.path));
    return clonePassed;
  }

  private async originMatches(
    executor: CommandExecutorPort,
    host: string,
    path: string,
    repository: string,
  ): Promise<ProjectProbeCheck> {
    const origin = await this.runGit(executor, ["-C", path, "remote", "get-url", "origin"]);
    if (this.unreachable(origin)) {
      return this.check("origin-matches", host, "unknown", `${host} did not answer`);
    }
    if (
      origin.exitCode === 0 &&
      normaliseRepository(origin.stdout) === normaliseRepository(repository)
    ) {
      return this.check("origin-matches", host, "pass", "origin matches");
    }
    return this.check("origin-matches", host, "fail", "origin does not match the profile's repository");
  }

  private async worktreeRootExists(
    executor: CommandExecutorPort,
    host: string,
    worktreeRoot: string,
  ): Promise<ProjectProbeCheck> {
    const rootExists = await this.runCommand(executor, ["test", "-d", worktreeRoot]);
    if (this.unreachable(rootExists)) {
      return this.check("worktree-root-exists", host, "unknown", `${host} did not answer`);
    }
    if (rootExists.exitCode === 0) {
      return this.check("worktree-root-exists", host, "pass", "worktree root exists");
    }
    if (rootExists.exitCode === 1) {
      return this.check(
        "worktree-root-exists",
        host,
        "fail",
        `missing; on ${host} run: mkdir -p ${shellQuote(worktreeRoot)}`,
      );
    }
    return this.check("worktree-root-exists", host, "unknown", `${host} did not answer`);
  }

  private async laneDirIgnored(
    executor: CommandExecutorPort,
    host: string,
    path: string,
  ): Promise<ProjectProbeCheck> {
    const laneIgnored = await this.runGit(executor, [
      "-C",
      path,
      "check-ignore",
      "-q",
      ".lane/probe.md",
    ]);
    if (this.unreachable(laneIgnored)) {
      return this.check("lane-dir-ignored", host, "unknown", `${host} did not answer`);
    }
    if (laneIgnored.exitCode === 0) {
      return this.check("lane-dir-ignored", host, "pass", ".lane/ is ignored");
    }
    if (laneIgnored.exitCode === 1) {
      return this.check(
        "lane-dir-ignored",
        host,
        "fail",
        `.lane/ is not ignored; add the line .lane/ to ${shellQuote(path + "/.gitignore")}`,
      );
    }
    return this.check("lane-dir-ignored", host, "unknown", `${host} did not answer`);
  }

  /** The `repository-answers` check plus the branch it named, if any. */
  private async repositoryAnswers(repository: string): Promise<{
    check: ProjectProbeCheck;
    defaultBranch: string | null;
    refused?: boolean;
  }> {
    // Remote-helper syntax is `<transport>::<address>` at the start; a `::`
    // inside a bracketed IPv6 host (ssh://[::1]/p) is an address, not a helper.
    if (repository === "" || repository.startsWith("-") || /^[A-Za-z0-9+.-]*::/.test(repository)) {
      return {
        check: this.check("repository-answers", null, "fail", "repository is not a plain URL or path"),
        defaultBranch: null,
        refused: true,
      };
    }
    if (hasRepositoryCredential(repository)) {
      return {
        check: this.check(
          "repository-answers",
          null,
          "fail",
          "repository URL carries a credential; register it without one",
        ),
        defaultBranch: null,
        refused: true,
      };
    }
    const run = await this.runGit(
      this.options.orchestrator,
      ["ls-remote", "--symref", repository, "HEAD"],
      { cwd: "/", env: orchestratorEnv() },
    );
    if (this.unreachable(run)) {
      return {
        check: this.check("repository-answers", null, "unknown", "orchestrator could not run git"),
        defaultBranch: null,
      };
    }
    if (run.exitCode !== 0) {
      return {
        check: this.check("repository-answers", null, "fail", `git ls-remote exited ${run.exitCode}`),
        defaultBranch: null,
      };
    }
    const head = run.stdout.match(/^ref: refs\/heads\/([^\s\t]+)\tHEAD$/m);
    if (
      head !== null &&
      !head[1].startsWith("-") &&
      /^[A-Za-z0-9._/-]{1,200}$/.test(head[1])
    ) {
      return {
        check: this.check("repository-answers", null, "pass", `default branch ${head[1]}`),
        defaultBranch: head[1],
      };
    }
    return {
      check: this.check("repository-answers", null, "pass", "remote answered; default branch not named"),
      defaultBranch: null,
    };
  }

  private async agentInstructionsTracked(
    executor: CommandExecutorPort,
    host: string,
    path: string,
  ): Promise<ProjectProbeCheck> {
    const agents = await this.runGit(executor, ["-C", path, "ls-files", "--error-unmatch", "AGENTS.md"]);
    if (this.unreachable(agents)) {
      return this.check("agent-instructions-tracked", host, "unknown", `${host} did not answer`);
    }
    if (agents.exitCode === 0) {
      return this.check("agent-instructions-tracked", host, "pass", "AGENTS.md");
    }
    const claude = await this.runGit(executor, ["-C", path, "ls-files", "--error-unmatch", "CLAUDE.md"]);
    if (this.unreachable(claude)) {
      return this.check("agent-instructions-tracked", host, "unknown", `${host} did not answer`);
    }
    if (claude.exitCode === 0) {
      return this.check("agent-instructions-tracked", host, "pass", "CLAUDE.md");
    }
    return this.check("agent-instructions-tracked", host, "fail", "no AGENTS.md or CLAUDE.md is tracked");
  }

  /** Script names of the clone's HEAD `package.json`; any failure → `[]`. */
  private async detectScripts(source: {
    host: string;
    path: string;
    executor: CommandExecutorPort;
  }): Promise<string[]> {
    const run = await this.runGit(
      source.executor,
      ["-C", source.path, "cat-file", "blob", "HEAD:package.json"],
      { maxBufferBytes: 1_048_576 },
    );
    if (this.unreachable(run) || run.exitCode !== 0) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];
    return Object.keys(scripts)
      .filter((name) => /^[A-Za-z0-9:_.-]{1,64}$/.test(name))
      .sort(compareCodeUnits)
      .slice(0, 200);
  }

  /** Run an argv array with the probe's timeout and optional extra run options. */
  private runCommand(
    executor: CommandExecutorPort,
    argv: readonly string[],
    extra?: Omit<CommandRunOptions, "timeoutMs">,
  ): Promise<CommandRunResult> {
    return executor.run(argv, {
      ...extra,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Every git call is `git` followed by the hardening overrides. */
  private runGit(
    executor: CommandExecutorPort,
    args: readonly string[],
    extra?: Omit<CommandRunOptions, "timeoutMs">,
  ): Promise<CommandRunResult> {
    return this.runCommand(executor, ["git", ...GIT_HARDENING, ...args], extra);
  }

  /** A run that never reported an exit — spawn failure, timeout, kill — is unreachable. */
  private unreachable(run: CommandRunResult): boolean {
    return run.error !== undefined || run.exitCode === null;
  }

  private check(
    name: string,
    host: string | null,
    result: ProjectProbeCheck["result"],
    detail: string,
  ): ProjectProbeCheck {
    return { name, host, result, detail };
  }
}
