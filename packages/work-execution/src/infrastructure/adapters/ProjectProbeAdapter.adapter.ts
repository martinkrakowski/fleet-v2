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
  CommandRunResult,
} from "../../application/ports/out/CommandExecutorPort.out-port.js";
import type {
  ProjectProbeCheck,
  ProjectProbePort,
  ProjectProbeReport,
  ProjectProbeRequest,
} from "../../application/ports/out/ProjectProbePort.out-port.js";
import type { ExecutorForRecordedHostResult } from "./ExecutorForHost.helper.js";

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
 * config and against credential prompts: no fsmonitor, no repository hooks,
 * no protocol transport outside the allowed set, and no terminal askpass.
 * `protocol.allow=never` closes every transport, then each protocol is
 * re-opened explicitly — a plain URL is always https/ssh/git/file, never a
 * subordinate protocol like `ext::` or an `-oProxyCommand` injection.
 */
export const GIT_HARDENING = [
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
] as const;

/** Minimal environment: no inherited secrets, no credential prompts. */
const PROBE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
} as const;

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
    const checks: ProjectProbeCheck[] = [];
    let defaultBranch: string | null = null;
    // The first sorted host whose `clone-is-work-tree` passed supplies the
    // detected scripts; never re-resolve it once recorded.
    let scriptsSource: { host: string; path: string; executor: CommandExecutorPort } | null = null;

    const repositoryAnswers = await this.repositoryAnswers(request);
    checks.push(repositoryAnswers.check);
    defaultBranch = repositoryAnswers.defaultBranch;

    const hostNames = Object.keys(request.clones).sort();
    for (const host of hostNames) {
      const clone = request.clones[host];
      const hostExecutor = this.options.executorForHost(host);
      if (!hostExecutor.ok) {
        checks.push(this.check("host-reachable", host, "unknown", hostExecutor.reason));
        continue;
      }
      const executor = hostExecutor.executor;

      // clone-is-work-tree
      const workTree = await this.runGit(executor, [
        "-C",
        clone.path,
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      if (this.unreachable(workTree)) {
        checks.push(this.check("clone-is-work-tree", host, "unknown", `${host} did not answer`));
        // STOP this host's remaining checks: the host is not answering.
        continue;
      }
      if (workTree.stdout.trim() === "true") {
        checks.push(this.check("clone-is-work-tree", host, "pass", `git work tree at ${clone.path}`));
        if (scriptsSource === null) scriptsSource = { host, path: clone.path, executor };
      } else {
        checks.push(
          this.check(
            "clone-is-work-tree",
            host,
            "fail",
            `no git work tree at ${clone.path}; on ${host} run: git clone ${request.repository} ${clone.path}`,
          ),
        );
      }

      // origin-matches
      const origin = await this.runGit(executor, ["-C", clone.path, "remote", "get-url", "origin"]);
      if (this.unreachable(origin)) {
        checks.push(this.check("origin-matches", host, "unknown", `${host} did not answer`));
      } else if (
        origin.exitCode === 0 &&
        normaliseRepository(origin.stdout) === normaliseRepository(request.repository)
      ) {
        checks.push(this.check("origin-matches", host, "pass", "origin matches"));
      } else {
        checks.push(this.check("origin-matches", host, "fail", "origin does not match the profile's repository"));
      }

      // worktree-root-exists
      const rootExists = await this.runCommand(executor, ["test", "-d", clone.worktreeRoot]);
      if (this.unreachable(rootExists)) {
        checks.push(this.check("worktree-root-exists", host, "unknown", `${host} did not answer`));
      } else if (rootExists.exitCode === 0) {
        checks.push(this.check("worktree-root-exists", host, "pass", "worktree root exists"));
      } else if (rootExists.exitCode === 1) {
        checks.push(
          this.check(
            "worktree-root-exists",
            host,
            "fail",
            `missing; on ${host} run: mkdir -p ${clone.worktreeRoot}`,
          ),
        );
      } else {
        checks.push(this.check("worktree-root-exists", host, "unknown", `${host} did not answer`));
      }

      // lane-dir-ignored
      const laneIgnored = await this.runGit(executor, [
        "-C",
        clone.path,
        "check-ignore",
        "-q",
        ".lane/probe.md",
      ]);
      if (this.unreachable(laneIgnored)) {
        checks.push(this.check("lane-dir-ignored", host, "unknown", `${host} did not answer`));
      } else if (laneIgnored.exitCode === 0) {
        checks.push(this.check("lane-dir-ignored", host, "pass", ".lane/ is ignored"));
      } else if (laneIgnored.exitCode === 1) {
        checks.push(
          this.check(
            "lane-dir-ignored",
            host,
            "fail",
            `.lane/ is not ignored; add the line .lane/ to ${clone.path}/.gitignore`,
          ),
        );
      } else {
        checks.push(this.check("lane-dir-ignored", host, "unknown", `${host} did not answer`));
      }

      // agent-instructions-tracked
      checks.push(await this.agentInstructionsTracked(executor, host, clone.path));
    }

    return {
      probedAtIso: this.now().toISOString(),
      probedFrom: "orchestrator",
      checks,
      defaultBranch,
      detectedScripts: scriptsSource === null ? [] : await this.detectScripts(scriptsSource),
    };
  }

  /** The `repository-answers` check plus the branch it named, if any. */
  private async repositoryAnswers(request: ProjectProbeRequest): Promise<{
    check: ProjectProbeCheck;
    defaultBranch: string | null;
  }> {
    const repository = request.repository;
    if (repository.trim() === "" || repository.startsWith("-") || repository.includes("::")) {
      return {
        check: this.check("repository-answers", null, "fail", "repository is not a plain URL or path"),
        defaultBranch: null,
      };
    }
    const run = await this.runGit(this.options.orchestrator, [
      "ls-remote",
      "--symref",
      repository,
      "HEAD",
    ]);
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
    if (head !== null) {
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
    const run = await this.runGit(source.executor, [
      "-C",
      source.path,
      "show",
      "HEAD:package.json",
    ]);
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
      .sort();
  }

  /** Run an argv array with the probe's timeout and minimal environment. */
  private runCommand(executor: CommandExecutorPort, argv: readonly string[]): Promise<CommandRunResult> {
    return executor.run(argv, { timeoutMs: this.timeoutMs, env: { ...PROBE_ENV } });
  }

  /** Every git call is `git` followed by the hardening overrides. */
  private runGit(executor: CommandExecutorPort, args: readonly string[]): Promise<CommandRunResult> {
    return this.runCommand(executor, ["git", ...GIT_HARDENING, ...args]);
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
