/**
 * The detection step of `fleet-v2 init` (plan section 5, step 1): platform
 * plus tool versions for the platform tools (node, yarn, git, gh, sh, nc,
 * curl, ssh) and each enabled tool, observed through an injected executor.
 * The engine never spawns anything itself: every observation is one argv
 * array run by the caller's executor, so tests and other transports
 * substitute the whole environment.
 *
 * A missing tool is reported, never fatal — `buildInitPlan` decides which
 * missing tools the chosen features cannot do without (plan section 5:
 * `gh` for a github forge, `git` for a git shelf, `ssh` for an ssh host,
 * `curl` for waves).
 */

import { BUILT_IN_TOOLS, detectTool } from "@fleet/tooling";
import type { CommandRunner, ToolDetection } from "@fleet/tooling";

import type { DoctorCommandExecutor } from "../doctor/probes-node.js";

/** Wall-clock budget for one detection probe. */
const DETECT_TIMEOUT_MS = 10_000;

/** The platform tools init always reports, in report order. */
export const INIT_PLATFORM_TOOLS: readonly string[] = [
  "node",
  "yarn",
  "git",
  "gh",
  "sh",
  "nc",
  "curl",
  "ssh",
];

/** One platform tool the detection observed. */
export interface DetectedPlatformTool {
  readonly name: string;
  /** True only when the probe ran and exited 0. */
  readonly present: boolean;
  /** First line of the probe output; absent for presence-only probes. */
  readonly version?: string;
}

/** Everything detection observed about the environment, as plain data. */
export interface InitDetection {
  /**
   * The kernel name `uname -s` reported (`Linux`, `Darwin`, …), or
   * `unknown` when the probe could not run — never a guess.
   */
  readonly platform: string;
  /**
   * The working directory `pwd` reported; the single-profile host's
   * worktree root is drafted relative to it.
   */
  readonly cwd: string;
  readonly platformTools: readonly DetectedPlatformTool[];
  /**
   * The enabled tools' full detection (sign-in state and model list), in
   * the order the operator listed them. A tool id that is not built in is
   * refused by `buildInitPlan`, not silently dropped here.
   */
  readonly enabledTools: readonly ToolDetection[];
}

/** The probe argv per platform tool. */
const VERSION_PROBES: Readonly<Record<string, readonly string[]>> = {
  node: ["node", "--version"],
  yarn: ["yarn", "--version"],
  git: ["git", "--version"],
  gh: ["gh", "--version"],
  sh: ["sh", "-c", "true"],
  nc: ["nc", "-h"],
  curl: ["curl", "--version"],
  ssh: ["ssh", "-V"],
};

/**
 * Tools whose probe is presence-only: their output is usage text, not a
 * version, so it is never reported as one.
 */
const PRESENCE_ONLY: ReadonlySet<string> = new Set(["sh", "nc"]);

/** First non-empty line of a probe output, trimmed. */
function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

async function probePlatformTool(
  executor: DoctorCommandExecutor,
  name: string,
): Promise<DetectedPlatformTool> {
  const argv = VERSION_PROBES[name];
  if (argv === undefined) {
    return { name, present: false };
  }
  let result: Awaited<ReturnType<typeof executor.run>>;
  try {
    result = await executor.run(argv, { timeoutMs: DETECT_TIMEOUT_MS });
  } catch {
    return { name, present: false };
  }
  // A presence-only probe asks "is it here", not "did the usage text
  // parse": BSD nc exits 1 on `-h`, so 0 or 1 both mean present.
  const present = PRESENCE_ONLY.has(name)
    ? result.exitCode === 0 || result.exitCode === 1
    : result.exitCode === 0;
  const version = PRESENCE_ONLY.has(name)
    ? undefined
    : (firstLine(result.stdout) ?? firstLine(result.stderr));
  return {
    name,
    present,
    ...(present && version !== undefined ? { version } : {}),
  };
}

/**
 * Observe the environment through the injected executor: platform, working
 * directory, every platform tool's version, and the enabled tools' full
 * detection. Probes run concurrently; a probe that throws fails closed
 * (`present: false`, `'unknown'`), never crashes the sweep.
 */
export async function detectInitEnvironment(
  executor: DoctorCommandExecutor,
  enabledTools: readonly string[],
): Promise<InitDetection> {
  const runner: CommandRunner = async (argv) => {
    const result = await executor.run(argv, { timeoutMs: DETECT_TIMEOUT_MS });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout };
  };
  const [uname, pwd, platformTools, enabledToolsDetections] = await Promise.all(
    [
      (async () => {
        try {
          const result = await executor.run(["uname", "-s"], {
            timeoutMs: DETECT_TIMEOUT_MS,
          });
          return result.exitCode === 0
            ? (firstLine(result.stdout) ?? "unknown")
            : "unknown";
        } catch {
          return "unknown";
        }
      })(),
      (async () => {
        try {
          const result = await executor.run(["pwd"], {
            timeoutMs: DETECT_TIMEOUT_MS,
          });
          return result.exitCode === 0 ? (firstLine(result.stdout) ?? "") : "";
        } catch {
          return "";
        }
      })(),
      Promise.all(
        INIT_PLATFORM_TOOLS.map((name) => probePlatformTool(executor, name)),
      ),
      Promise.all(
        BUILT_IN_TOOLS.filter((tool) => enabledTools.includes(tool.id)).map(
          (tool) => detectTool(tool, runner),
        ),
      ),
    ],
  );
  return {
    platform: uname,
    cwd: pwd,
    platformTools,
    enabledTools: enabledToolsDetections,
  };
}
