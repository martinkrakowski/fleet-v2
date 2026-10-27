// S2a: `brief prepare --acceptanceSpec` accepts exactly one JSON object; a
// malformed value is a usage error (exit 2). The use case validates the spec.

import { describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../index.js";

function capturingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    stdout,
    stderr,
  };
}

function briefArgs(specFlag?: string): string[] {
  const args = [
    "brief",
    "prepare",
    "--workOrderId",
    "wo-spec",
    "--laneId",
    "lane-spec",
    "--baseCommit",
    "abc123",
    "--ownedPaths",
    "packages/x/src",
    "--seatTool",
    "opencode",
    "--independentReviewer",
    "reviewer-model",
  ];
  if (specFlag !== undefined) args.push("--acceptanceSpec", specFlag);
  return args;
}

describe("brief prepare --acceptanceSpec", () => {
  it("a malformed JSON value is a usage error (exit 2)", async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs("not-json"), io);
    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain(
      "brief prepare requires a JSON object in '--acceptanceSpec'",
    );
    expect(stdout).toHaveLength(0);
  });

  it("a JSON array value is a usage error (exit 2)", async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs("[1,2]"), io);
    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain(
      "brief prepare requires a JSON object in '--acceptanceSpec'",
    );
    expect(stdout).toHaveLength(0);
  });

  it("a JSON string value is a usage error (exit 2)", async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(briefArgs('"text"'), io);
    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("--acceptanceSpec");
    expect(stdout).toHaveLength(0);
  });

  it("a valid spec JSON object reaches the use case (exit 1 for the unrelated rejection)", async () => {
    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(
      briefArgs(
        '{"commitRequired":true,"diffCheck":true,"commands":[{"argv":["corepack","yarn","build"]}]}',
      ),
      io,
    );
    expect(exitCode).toBe(1);
    expect(stderr.join("")).not.toContain("--acceptanceSpec");
    expect(stdout.join("")).toContain("rejected");
  });
});
