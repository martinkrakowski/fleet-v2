/**
 * Direct tests for `detectInitEnvironment` and `INIT_PLATFORM_TOOLS`
 * (lane VB8): report order, fail-closed paths, throwing probes, the
 * `10_000` ms timeout budget and `enabledTools` edge cases.
 *
 * Hostile-input note (brief rule): `detectInitEnvironment` is an internal,
 * fully typed function — it takes a `DoctorCommandExecutor` and a
 * `readonly string[]`, performs no file reads and no untyped record
 * parsing, and `DoctorCommandExecutor` declares exactly one required
 * method (`run`), with no optional port methods. Untrusted-input
 * hardening (null/undefined/non-iterable/getter/Proxy/array-hole
 * refusal loops) is therefore the caller's boundary concern, not this
 * function's; the only loop bounds needed are the two bounded sweeps
 * over `INIT_PLATFORM_TOOLS` and `BUILT_IN_TOOLS`, each
 * `O(INIT_PLATFORM_TOOLS.length + BUILT_IN_TOOLS.length)` with constant
 * work per entry, plus one map lookup per argv (`O(1)` against a
 * bounded record). No runtime hostile-input loop bound beyond that is
 * required.
 */

import { describe, expect, it } from "vitest";

import type {
  DoctorCommandExecutor,
  DoctorCommandRunResult,
} from "../../doctor/probes-node.js";

import { detectInitEnvironment, INIT_PLATFORM_TOOLS } from "../detect.js";
import type { InitDetection } from "../detect.js";

/**
 * One executor answer: exit code, stdout and stderr. An entry whose
 * `throw: true` makes `executor.run` reject.
 */
interface Answer {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  throw?: boolean;
}

type Answers = Record<string, Answer>;

/**
 * An executor answering from a table keyed by the joined argv, with the
 * `10_000` ms budget recorded for every call so the tests can assert it.
 */
function recordingExecutor(
  answers: Answers,
  calls: { argv: string; timeoutMs?: number }[] = [],
): DoctorCommandExecutor {
  return {
    async run(
      argv: readonly string[],
      options?: { timeoutMs?: number },
    ): Promise<DoctorCommandRunResult> {
      calls.push({ argv: argv.join(" "), timeoutMs: options?.timeoutMs });
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
      if (answer.throw === true) {
        throw new Error(`probe rejected: ${argv.join(" ")}`);
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

/**
 * Detection through the recording executor, with the calls list the
 * assertions inspect.
 */
async function runDetection(
  answers: Answers,
  enabledTools: readonly string[] = [],
): Promise<{ detection: InitDetection; calls: { argv: string; timeoutMs?: number }[] }> {
  const calls: { argv: string; timeoutMs?: number }[] = [];
  const detection = await detectInitEnvironment(
    recordingExecutor(answers, calls),
    enabledTools,
  );
  return { detection, calls };
}

/** The fully-present environment, in the style of `init.test.ts`. */
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

describe("INIT_PLATFORM_TOOLS", () => {
  it("is exactly the eight platform tools in report order", () => {
    expect(INIT_PLATFORM_TOOLS).toEqual([
      "node",
      "yarn",
      "git",
      "gh",
      "sh",
      "nc",
      "curl",
      "ssh",
    ]);
  });
});

describe("detectInitEnvironment", () => {
  it("reports platformTools in INIT_PLATFORM_TOOLS order with trimmed firstLine versions", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      // Leading/trailing whitespace and blank lines around the version.
      "node --version": { exitCode: 0, stdout: "\n\n  v20.11.0  \n\n" },
    });
    expect(detection.platformTools.map((tool) => tool.name)).toEqual([
      ...INIT_PLATFORM_TOOLS,
    ]);
    const node = detection.platformTools.find((tool) => tool.name === "node");
    expect(node).toEqual({
      name: "node",
      present: true,
      version: "v20.11.0",
    });
    const pwd = detection.cwd;
    expect(pwd).toBe("/home/developer/fleet");
  });

  it("reads the version from stderr when stdout is empty, and stdout when both are present", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      // ssh writes its banner to stderr (real behaviour) — read anyway.
      "ssh -V": {
        exitCode: 0,
        stdout: "",
        stderr: "  OpenSSH_9.6 \nnoise\n",
      },
      // curl writes both; stdout wins.
      "curl --version": {
        exitCode: 0,
        stdout: "curl 8.5.0\n",
        stderr: "stderr line\n",
      },
    });
    const byName = new Map(
      detection.platformTools.map((tool) => [tool.name, tool]),
    );
    expect(byName.get("ssh")).toEqual({
      name: "ssh",
      present: true,
      version: "OpenSSH_9.6",
    });
    expect(byName.get("curl")).toEqual({
      name: "curl",
      present: true,
      version: "curl 8.5.0",
    });
  });

  it("passes the 10000ms timeoutMs budget to every executor.run call", async () => {
    const { calls } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "grok --version": { exitCode: 0, stdout: "1.0.0" },
      "grok auth status": { exitCode: 0, stdout: "signed in as someone" },
      "grok models": { exitCode: 0, stdout: "Available models:\ngrok-4.7\n" },
    }, ["grok"]);
    // The four sweep probes: uname, pwd, the 8 platform tools, and the
    // enabled tool's detect/sign-in/models probes: 13 calls total.
    expect(calls).toHaveLength(13);
    expect(
      calls.every((call) => call.timeoutMs === 10_000),
      `every probe receives the 10000ms budget; saw ${JSON.stringify(calls)}`,
    ).toBe(true);
  });

  it("returns platform 'unknown' when uname -s exits non-zero or with null exitCode", async () => {
    const failed = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "uname -s": { exitCode: 1, stdout: "Linux\n" },
    });
    expect(failed.detection.platform).toBe("unknown");
    const killed = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "uname -s": { exitCode: null, stdout: "" },
    });
    expect(killed.detection.platform).toBe("unknown");
  });

  it("returns platform 'unknown' when uname -s produces only whitespace", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "uname -s": { exitCode: 0, stdout: "  \n\t\n  " },
    });
    expect(detection.platform).toBe("unknown");
  });

  it("returns platform 'unknown' when uname -s probe throws", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "uname -s": { exitCode: 0, stdout: "Linux\n", throw: true },
    });
    expect(detection.platform).toBe("unknown");
  });

  it("returns empty cwd when pwd exits non-zero or with null exitCode", async () => {
    const failed = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      pwd: { exitCode: 1, stdout: "/home/developer/fleet\n" },
    });
    expect(failed.detection.cwd).toBe("");
    const killed = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      pwd: { exitCode: null, stdout: "" },
    });
    expect(killed.detection.cwd).toBe("");
  });

  it("returns empty cwd when pwd produces only whitespace", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      pwd: { exitCode: 0, stdout: "   \n \n" },
    });
    expect(detection.cwd).toBe("");
  });

  it("returns empty cwd when pwd probe throws", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      pwd: { exitCode: 0, stdout: "/home\n", throw: true },
    });
    expect(detection.cwd).toBe("");
  });

  it("reports present: false with no version when a versioned platform tool exits non-zero", async () => {
    for (const exitCode of [1, 127]) {
      const { detection } = await runDetection({
        ...ENVIRONMENT_ANSWERS,
        // Non-empty output even so: a failure is never quoted as a version.
        "git --version": {
          exitCode,
          stdout: "git version 2.43.0\n",
          stderr: "warning: something\n",
        },
      });
      const git = detection.platformTools.find((tool) => tool.name === "git");
      expect(git).toEqual({ name: "git", present: false });
      expect(Object.hasOwn(git ?? {}, "version")).toBe(false);
    }
  });

  it("omits version when a versioned platform tool exits 0 with empty output", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "node --version": { exitCode: 0, stdout: "", stderr: "" },
    });
    const node = detection.platformTools.find((tool) => tool.name === "node");
    expect(node).toEqual({ name: "node", present: true });
    expect(Object.hasOwn(node ?? {}, "version")).toBe(false);
  });

  it("reports present: false and does not throw when a platform tool probe rejects", async () => {
    const { detection } = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "yarn --version": { exitCode: 0, stdout: "4.1.0\n", throw: true },
    });
    const yarn = detection.platformTools.find((tool) => tool.name === "yarn");
    expect(yarn).toEqual({ name: "yarn", present: false });
    expect(Object.hasOwn(yarn ?? {}, "version")).toBe(false);
  });

  it("reports presence-only tools as present: false for exit codes other than 0 or 1 and omits version", async () => {
    for (const exitCode of [2, null]) {
      const { detection } = await runDetection({
        ...ENVIRONMENT_ANSWERS,
        "nc -h": { exitCode, stdout: "usage: nc\n", stderr: "" },
        "sh -c true": { exitCode, stdout: "noisy stdout\n" },
      });
      const nc = detection.platformTools.find((tool) => tool.name === "nc");
      const sh = detection.platformTools.find((tool) => tool.name === "sh");
      expect(nc).toEqual({ name: "nc", present: false });
      expect(sh).toEqual({ name: "sh", present: false });
      expect(Object.hasOwn(nc ?? {}, "version")).toBe(false);
      expect(Object.hasOwn(sh ?? {}, "version")).toBe(false);
    }
    // Present with 0 or 1 and noisy stdout: still no version.
    const present = await runDetection({
      ...ENVIRONMENT_ANSWERS,
      "nc -h": { exitCode: 1, stdout: "usage: nc\nlots of noise\n" },
    });
    expect(present.detection.platformTools.find((t) => t.name === "nc")).toEqual({
      name: "nc",
      present: true,
    });
  });

  it("fails closed for an enabled tool when its probe throws or returns null exitCode", async () => {
    const throwing = await runDetection(
      {
        "grok --version": { exitCode: 0, stdout: "1.0.0", throw: true },
      },
      ["grok"],
    );
    expect(throwing.detection.enabledTools).toEqual([
      {
        id: "grok",
        installed: false,
        detectOutput: "",
        signIn: "unknown",
        models: "unknown",
      },
    ]);
    // `exitCode: null` arrives at `detectTool` as `-1` (the runner coerces),
    // so the tool is not installed and nothing else is probed.
    const killed = await runDetection(
      { "grok --version": { exitCode: null, stdout: "" } },
      ["grok"],
    );
    expect(killed.detection.enabledTools).toEqual([
      {
        id: "grok",
        installed: false,
        detectOutput: "",
        signIn: "unknown",
        models: "unknown",
      },
    ]);
    expect(
      killed.calls.every((call) => call.argv !== "grok auth status"),
    ).toBe(true);
  });

  it("ignores unknown enabled tool ids without throwing", async () => {
    const { detection } = await runDetection(ENVIRONMENT_ANSWERS, [
      "nonexistent-tool",
      "grok",
    ]);
    expect(detection.enabledTools.map((tool) => tool.id)).toEqual(["grok"]);
  });

  it("yields an empty enabledTools list for an empty request", async () => {
    const { detection } = await runDetection(ENVIRONMENT_ANSWERS, []);
    expect(detection.enabledTools).toEqual([]);
  });

  it("resolves with fail-closed defaults when every probe throws", async () => {
    const answers: Answers = {};
    for (const key of Object.keys(ENVIRONMENT_ANSWERS)) {
      answers[key] = { exitCode: 0, throw: true };
    }
    const { detection } = await runDetection(answers, ["grok"]);
    expect(detection.platform).toBe("unknown");
    expect(detection.cwd).toBe("");
    expect(detection.platformTools.map((tool) => tool.name)).toEqual([
      ...INIT_PLATFORM_TOOLS,
    ]);
    for (const tool of detection.platformTools) {
      expect(tool).toEqual({ name: tool.name, present: false });
    }
    expect(detection.enabledTools).toEqual([
      {
        id: "grok",
        installed: false,
        detectOutput: "",
        signIn: "unknown",
        models: "unknown",
      },
    ]);
  });
});
