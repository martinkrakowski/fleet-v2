/**
 * `confirmFromStdin` (lane VB27): the default confirmation gate reads exactly
 * one line from `process.stdin`, accepts only an explicit y/yes (case- and
 * space-tolerant), decides on the first line, declines on empty or
 * whitespace-only EOF, resolves `false` (never throws) when stdin is already
 * ended or errors, and always detaches its listeners and pauses stdin once
 * settled — later data cannot change the answer. Tested in-memory with a
 * `PassThrough` swapped in for `process.stdin`; cost is O(n) in the single
 * line length, with no filesystem, network, or timer overhead.
 */

import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmFromStdin } from "../hosts.js";
import type { CliIo } from "../index.js";

const QUESTION = "Write the installation file?";

function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

describe("confirmFromStdin", () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const fakes: PassThrough[] = [];

  beforeEach(() => {
    expect(originalStdin).toBeDefined();
  });

  afterEach(() => {
    for (const fake of fakes.splice(0)) {
      fake.destroy();
    }
    Object.defineProperty(process, "stdin", originalStdin!);
  });

  /** Replace `process.stdin` with a fresh `PassThrough` for one confirm call. */
  const installStdin = (): PassThrough => {
    const fake = new PassThrough();
    fakes.push(fake);
    Object.defineProperty(process, "stdin", {
      value: fake,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return fake;
  };

  /** Run one confirm against the installed fake, feeding the given chunks. */
  const confirmWith = async (
    chunks: readonly string[],
    { end = true }: { end?: boolean } = {},
  ): Promise<{ confirmed: boolean; fake: PassThrough; stdout: string[] }> => {
    const { io, stdout } = mockIo();
    const fake = installStdin();
    const pending = confirmFromStdin(io)(QUESTION);
    for (const chunk of chunks) {
      fake.write(chunk);
    }
    if (end) {
      fake.end();
    }
    const confirmed = await pending;
    return { confirmed, fake, stdout };
  };

  it("accepts an explicit yes: y, Y, yes, YES, surrounding space, and y without a newline", async () => {
    for (const answer of ["y\n", "Y\n", "yes\n", "YES\n", " y \n"]) {
      const { confirmed } = await confirmWith([answer]);
      expect(confirmed, `expected ${JSON.stringify(answer)} to confirm`).toBe(
        true,
      );
    }
    const { confirmed, fake } = await confirmWith(["y"], { end: true });
    expect(confirmed).toBe(true);
    expect(fake.readableEnded).toBe(true);
  });

  it("declines non-matching and empty lines: n, empty line, yess, ye, y y, yes please, no", async () => {
    for (const answer of [
      "n\n",
      "\n",
      "yess\n",
      "ye\n",
      "y y\n",
      "yes please\n",
      "no\n",
    ]) {
      const { confirmed, fake } = await confirmWith([answer]);
      expect(confirmed, `expected ${JSON.stringify(answer)} to decline`).toBe(
        false,
      );
      expect(fake.listenerCount("data")).toBe(0);
      expect(fake.listenerCount("end")).toBe(0);
      expect(fake.listenerCount("error")).toBe(0);
      expect(fake.isPaused()).toBe(true);
    }
  });

  it("declines empty EOF and whitespace-only EOF", async () => {
    const emptyEof = await confirmWith([], { end: true });
    expect(emptyEof.confirmed).toBe(false);
    expect(emptyEof.fake.listenerCount("data")).toBe(0);
    expect(emptyEof.fake.listenerCount("end")).toBe(0);
    expect(emptyEof.fake.listenerCount("error")).toBe(0);
    expect(emptyEof.fake.isPaused()).toBe(true);

    const whitespaceEof = await confirmWith(["   "], { end: true });
    expect(whitespaceEof.confirmed).toBe(false);
    expect(whitespaceEof.fake.listenerCount("data")).toBe(0);
    expect(whitespaceEof.fake.listenerCount("end")).toBe(0);
    expect(whitespaceEof.fake.listenerCount("error")).toBe(0);
    expect(whitespaceEof.fake.isPaused()).toBe(true);
  });

  it("decides on the first line only: n then y declines, y then n confirms, split chunks still count", async () => {
    const firstNo = await confirmWith(["n\ny\n"]);
    expect(firstNo.confirmed).toBe(false);

    const firstYes = await confirmWith(["y\nn\n"]);
    expect(firstYes.confirmed).toBe(true);

    const { confirmed } = await confirmWith(["ye", "s\n"], { end: false });
    expect(confirmed).toBe(true);
  });

  it("resolves false without attaching listeners when stdin is already ended", async () => {
    const { io, stdout } = mockIo();
    const fake = installStdin();
    fake.resume();
    let resolveEnded: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const endListener = (): void => resolveEnded();
    fake.on("end", endListener);
    fake.end();
    await ended;
    fake.removeListener("end", endListener);
    expect(fake.readableEnded).toBe(true);

    const confirmed = await confirmFromStdin(io)(QUESTION);
    expect(confirmed).toBe(false);
    expect(stdout).toEqual([`${QUESTION} `, "\n"]);
    expect(fake.listenerCount("data")).toBe(0);
    expect(fake.listenerCount("end")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
  });

  it("resolves false and cleans up listeners on stdin error", async () => {
    const { io, stdout } = mockIo();
    const fake = installStdin();
    const pending = confirmFromStdin(io)(QUESTION);
    fake.destroy(new Error("stdin failed"));
    await expect(pending).resolves.toBe(false);
    expect(fake.listenerCount("data")).toBe(0);
    expect(fake.listenerCount("end")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
    expect(fake.isPaused()).toBe(true);
    expect(stdout).toEqual([`${QUESTION} `]);
  });

  it("writes the question exactly once and detaches and pauses stdin after settling", async () => {
    const { confirmed, fake, stdout } = await confirmWith(["y\n"], {
      end: false,
    });
    expect(confirmed).toBe(true);
    expect(stdout).toEqual([`${QUESTION} `]);
    expect(fake.listenerCount("data")).toBe(0);
    expect(fake.listenerCount("end")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
    expect(fake.isPaused()).toBe(true);
  });

  it("ignores data emitted after settling: neither n nor y changes the resolved answer", async () => {
    const declined = await confirmWith(["n\n"], { end: false });
    expect(declined.confirmed).toBe(false);
    declined.fake.write("y\n");
    expect(declined.confirmed).toBe(false);

    const accepted = await confirmWith(["y\n"], { end: false });
    expect(accepted.confirmed).toBe(true);
    accepted.fake.write("n\n");
    expect(accepted.confirmed).toBe(true);
  });
});
