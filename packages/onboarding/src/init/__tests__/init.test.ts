/**
 * The init engine (lane O10a): detection through an injected executor and
 * the pure `buildInitPlan`. The loader (`parseInstallation`) has the last
 * word in the engine itself, so every accepted plan here is one the loader
 * already accepted.
 */

import { describe, expect, it } from "vitest";

import { parseInstallation } from "@fleet/installation";

import type {
  DoctorCommandExecutor,
  DoctorCommandRunResult,
} from "../../doctor/probes-node.js";

import { detectInitEnvironment } from "../detect.js";
import type { DetectedPlatformTool, InitDetection } from "../detect.js";
import { buildInitPlan } from "../plan.js";
import type { InitAnswers } from "../plan.js";

/** One executor answer: exit code and stdout, keyed by the joined argv. */
type Answers = Record<
  string,
  { exitCode: number | null; stdout?: string; stderr?: string }
>;

/** An executor that answers from a table and fails closed on anything else. */
function fakeExecutor(answers: Answers): DoctorCommandExecutor {
  return {
    async run(argv: readonly string[]): Promise<DoctorCommandRunResult> {
      const answer = answers[argv.join(" ")];
      if (answer === undefined) {
        return {
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          error: "not found",
        };
      }
      return {
        exitCode: answer.exitCode,
        signal: null,
        stdout: answer.stdout ?? "",
        stderr: answer.stderr ?? "",
      };
    },
  };
}

const ENVIRONMENT_ANSWERS: Answers = {
  "uname -s": { exitCode: 0, stdout: "Linux\n" },
  pwd: { exitCode: 0, stdout: "/home/developer/fleet\n" },
  "node --version": { exitCode: 0, stdout: "v20.11.0\n" },
  "yarn --version": { exitCode: 0, stdout: "4.1.0\n" },
  "git --version": { exitCode: 0, stdout: "git version 2.43.0\n" },
  "gh --version": { exitCode: 0, stdout: "gh version 2.50.0\n" },
  "sh -c true": { exitCode: 0, stdout: "" },
  "nc -h": { exitCode: 0, stdout: "usage: nc\n" },
  "curl --version": { exitCode: 0, stdout: "curl 8.5.0\n" },
  "ssh -V": { exitCode: 0, stderr: "OpenSSH_9.6\n" },
};

/** Detection over the fully-present environment, with no enabled tools. */
async function fullDetection(
  tools: readonly string[] = [],
  extra: Answers = {},
): Promise<InitDetection> {
  return detectInitEnvironment(
    fakeExecutor({ ...ENVIRONMENT_ANSWERS, ...extra }),
    tools,
  );
}

/** The base answers the tests vary; the plan-section 5 example command. */
function baseAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    profile: "single",
    tools: ["opencode", "claude-code"],
    recommend: false,
    isolation: "none",
    forge: "none",
    shelf: "local",
    ...overrides,
  };
}

describe("detectInitEnvironment", () => {
  it("reports platform, working directory and a version per platform tool", async () => {
    const detection = await fullDetection();
    expect(detection.platform).toBe("Linux");
    expect(detection.cwd).toBe("/home/developer/fleet");
    const byName = new Map(
      detection.platformTools.map((tool) => [tool.name, tool]),
    );
    expect(byName.get("node")).toEqual({
      name: "node",
      present: true,
      version: "v20.11.0",
    });
    // `ssh -V` prints to stderr; the version is still read.
    expect(byName.get("ssh")).toEqual({
      name: "ssh",
      present: true,
      version: "OpenSSH_9.6",
    });
    // `sh` and `nc` are presence-only probes.
    expect(byName.get("sh")).toEqual({ name: "sh", present: true });
    expect(byName.get("nc")).toEqual({ name: "nc", present: true });
  });

  it("reports a missing tool as present:false and never throws", async () => {
    const detection = await fullDetection(["claude-code"], {
      "gh --version": { exitCode: null, stdout: "", stderr: "" },
      "claude --version": { exitCode: 0, stdout: "1.0.0" },
      "claude auth status": { exitCode: 0, stdout: "signed in as someone" },
    });
    const gh = detection.platformTools.find((tool) => tool.name === "gh");
    expect(gh).toEqual({ name: "gh", present: false });
    const claude = detection.enabledTools.find(
      (tool) => tool.id === "claude-code",
    );
    expect(claude?.installed).toBe(true);
    expect(claude?.signIn).toBe("signed-in");
  });

  it("detects only the enabled tools, in the order they were enabled", async () => {
    const detection = await fullDetection(["grok"], {
      "grok --version": { exitCode: 0, stdout: "1.0.0" },
      "grok auth status": { exitCode: 0, stdout: "signed in as someone" },
      "grok models": {
        exitCode: 0,
        stdout: "Available models:\ngrok-4.7\n",
      },
    });
    expect(detection.enabledTools.map((tool) => tool.id)).toEqual(["grok"]);
    expect(detection.enabledTools[0]?.signIn).toBe("signed-in");
  });
});

describe("buildInitPlan", () => {
  it("builds the single-machine plan the section 5 example command asks for", async () => {
    const detection = await fullDetection();
    const result = buildInitPlan(baseAnswers(), detection);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseInstallation(result.plan.candidate);
    expect(parsed.ok).toBe(true);
    const hosts = result.plan.candidate.hosts as Record<
      string,
      {
        runner?: { capabilities?: Record<string, unknown> };
      }
    >;
    expect(Object.keys(result.plan.candidate.hosts)).toEqual(["this-machine"]);
    expect(hosts["this-machine"]?.runner?.capabilities).toEqual({
      networkEgressRestricted: false,
      cpuAndMemoryLimited: false,
      processTreeTermination: false,
      filesystemScope: "inherited-directory",
    });
    expect(result.plan.candidate.forge).toEqual({ mode: "none" });
    expect(result.plan.candidate.shelf).toEqual({ provider: "local" });
    expect(result.plan.candidate.tools).toEqual(["opencode", "claude-code"]);
    expect(result.plan.isolationNote).toContain("dispatch will refuse");
    // The exact bytes a write would put on disk.
    expect(result.plan.text.startsWith('{\n  "schemaVersion": 2,')).toBe(true);
  });

  it("writes the container declaration as all true with a scoped worktree", async () => {
    const result = buildInitPlan(
      baseAnswers({ isolation: "container" }),
      await fullDetection(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hosts = result.plan.candidate.hosts as Record<
      string,
      {
        runner?: { capabilities?: Record<string, unknown> };
      }
    >;
    expect(hosts["this-machine"]?.runner?.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    });
    expect(result.plan.isolationNote).toBeUndefined();
  });

  it("refuses a custom isolation without its four values, and uses them when given", async () => {
    const refused = buildInitPlan(
      baseAnswers({ isolation: "custom" }),
      await fullDetection(),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors.join("\n")).toContain("isolationCustom");
    const accepted = buildInitPlan(
      baseAnswers({
        isolation: "custom",
        isolationCustom: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: false,
          processTreeTermination: true,
          filesystemScope: "scoped-worktree",
        },
      }),
      await fullDetection(),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const hosts = accepted.plan.candidate.hosts as Record<
      string,
      {
        runner?: { capabilities?: Record<string, unknown> };
      }
    >;
    expect(hosts["this-machine"]?.runner?.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: false,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    });
  });

  it("refuses a github forge without owner/repo and accepts a well-formed one", async () => {
    const refused = buildInitPlan(
      baseAnswers({ forge: "github" }),
      await fullDetection(),
    );
    expect(refused.ok).toBe(false);
    const accepted = buildInitPlan(
      baseAnswers({ forge: "github", forgeRepo: "owner/repo" }),
      await fullDetection(),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.candidate.forge).toEqual({
      mode: "github",
      owner: "owner",
      repo: "repo",
    });
  });

  it("refuses a git shelf without a repository and drafts the section with it", async () => {
    const refused = buildInitPlan(
      baseAnswers({ shelf: "git" }),
      await fullDetection(),
    );
    expect(refused.ok).toBe(false);
    const accepted = buildInitPlan(
      baseAnswers({ shelf: "git", shelfRepo: "/srv/fleet/keepers.git" }),
      await fullDetection(),
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.plan.candidate.shelf).toEqual({
      provider: "git",
      repoDir: "/srv/fleet/keepers.git",
      branch: "fleet-keepers",
      pathPrefix: "keepers",
    });
  });

  it("reports every missing platform tool and refuses only the ones features need", async () => {
    const detection = await detectInitEnvironment(
      fakeExecutor({
        "uname -s": { exitCode: 0, stdout: "Linux\n" },
        pwd: { exitCode: 0, stdout: "/home/developer/fleet\n" },
      }),
      [],
    );
    const reported = buildInitPlan(baseAnswers(), detection);
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    expect(reported.plan.missingTools).toEqual([
      "node",
      "yarn",
      "git",
      "gh",
      "sh",
      "nc",
      "curl",
      "ssh",
    ]);
    expect(reported.plan.requiredMissingTools).toEqual([]);

    const refused = buildInitPlan(
      baseAnswers({ forge: "github", forgeRepo: "o/r" }),
      detection,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors).toContain(
      "tools: gh is missing, and the chosen features need it",
    );
  });

  it("refuses an unknown tool id and an empty tool list", async () => {
    const detection = await fullDetection();
    const unknown = buildInitPlan(
      baseAnswers({ tools: ["opencode", "wat"] }),
      detection,
    );
    expect(unknown.ok).toBe(false);
    const unknownErrors = unknown.ok ? [] : unknown.errors;
    expect(unknownErrors.join("\n")).toContain("'wat' is not a built-in tool");
    const empty = buildInitPlan(baseAnswers({ tools: [] }), detection);
    expect(empty.ok).toBe(false);
    const emptyErrors = empty.ok ? [] : empty.errors;
    expect(emptyErrors.join("\n")).toContain("at least one tool is required");
  });

  it("drafts the multi profile from the answered hosts and applies the isolation to runners", async () => {
    const result = buildInitPlan(
      baseAnswers({
        profile: "multi",
        isolation: "container",
        hosts: [
          {
            name: "head",
            transport: "local",
            worktreeRoot: "/srv/fleet/worktrees",
            roles: ["orchestrator", "verifier"],
          },
          {
            name: "lane",
            transport: "ssh",
            sshAlias: "lane-host",
            worktreeRoot: "/srv/fleet/worktrees",
            roles: ["lane-runner"],
            runner: { kind: "opencode", port: 4166 },
          },
        ],
      }),
      await fullDetection(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseInstallation(result.plan.candidate);
    expect(parsed.ok).toBe(true);
    const hosts = result.plan.candidate.hosts as Record<
      string,
      {
        runner?: { capabilities?: Record<string, unknown> };
      }
    >;
    expect(hosts.lane?.runner?.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    });
    expect(hosts.head?.runner).toBeUndefined();
  });

  it("refuses a multi profile without host drafts and a single profile with them", async () => {
    const detection = await fullDetection();
    const noHosts = buildInitPlan(baseAnswers({ profile: "multi" }), detection);
    expect(noHosts.ok).toBe(false);
    const noHostsErrors = noHosts.ok ? [] : noHosts.errors;
    expect(noHostsErrors.join("\n")).toContain("--hosts");
    const withHosts = buildInitPlan(
      baseAnswers({
        hosts: [
          {
            name: "x",
            transport: "local",
            worktreeRoot: "/w",
            roles: ["orchestrator"],
          },
        ],
      }),
      detection,
    );
    expect(withHosts.ok).toBe(false);
    const withHostsErrors = withHosts.ok ? [] : withHosts.errors;
    expect(withHostsErrors.join("\n")).toContain("only the multi profile");
  });

  it("carries the recommender catalogue into seats and chains when it can build one", async () => {
    const detection = await fullDetection(["claude-code", "grok"], {
      "claude --version": { exitCode: 0, stdout: "1.0.0" },
      "claude auth status": { exitCode: 0, stdout: "signed in as someone" },
      "grok --version": { exitCode: 0, stdout: "1.0.0" },
      "grok auth status": { exitCode: 0, stdout: "signed in as someone" },
      "grok models": { exitCode: 0, stdout: "Available models:\ngrok-4.7\n" },
    });
    const result = buildInitPlan(baseAnswers({ recommend: true }), detection);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.recommendation?.outcome).toBe("catalogue");
    const parsed = parseInstallation(result.plan.candidate);
    expect(parsed.ok).toBe(true);
    const seats = result.plan.candidate.seats as readonly {
      id: string;
      tool: string;
    }[];
    expect(seats.map((seat) => seat.tool)).toEqual([
      "claude-code",
      "claude-code",
      "claude-code",
      "grok",
    ]);
    expect(result.plan.candidate.chains).toBeDefined();
  });

  it("reports a recommender refusal without refusing the plan (seats can come later)", async () => {
    const detection = await fullDetection(["claude-code"], {
      "claude --version": { exitCode: 0, stdout: "1.0.0" },
      "claude auth status": { exitCode: 0, stdout: "signed in as someone" },
    });
    const result = buildInitPlan(baseAnswers({ recommend: true }), detection);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.recommendation?.outcome).toBe("no-valid-catalogue");
    expect(result.plan.candidate.seats).toBeUndefined();
    const parsed = parseInstallation(result.plan.candidate);
    expect(parsed.ok).toBe(true);
  });

  it("uses operator-named seats verbatim when recommend is false", async () => {
    const result = buildInitPlan(
      baseAnswers({
        seats: [
          {
            id: "impl",
            tool: "claude-code",
            model: "claude-sonnet-4-5",
            roles: ["implementer"],
            costClass: "plan-quota",
          },
        ],
      }),
      await fullDetection(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.candidate.seats).toEqual([
      {
        id: "impl",
        tool: "claude-code",
        model: "claude-sonnet-4-5",
        roles: ["implementer"],
        costClass: "plan-quota",
      },
    ]);
  });

  it("lists credential files in the checklist and never creates them", async () => {
    const result = buildInitPlan(
      baseAnswers({
        profile: "multi",
        forge: "github",
        forgeRepo: "owner/repo",
        waves: {
          baseUrl: "https://waves.example",
          tokenFile: "/run/fleet/waves-token",
        },
        hosts: [
          {
            name: "head",
            transport: "local",
            worktreeRoot: "/srv/fleet/worktrees",
            roles: ["orchestrator", "lane-runner"],
            runner: {
              kind: "opencode",
              port: 46000,
              authFile: "/run/fleet/opencode-auth",
            },
          },
        ],
      }),
      await fullDetection(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commands = result.plan.credentials.map((entry) => entry.command);
    expect(commands).toContain("chmod 600 /run/fleet/opencode-auth");
    expect(commands).toContain("chmod 600 /run/fleet/waves-token");
    expect(commands).toContain("gh auth status");
    // The engine touches no filesystem: there is nothing to clean up.
  });
});
