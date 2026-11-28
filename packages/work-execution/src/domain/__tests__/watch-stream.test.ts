import { types } from "node:util";

import { describe, expect, it } from "vitest";

import { LANE_DIFF_SECRET_PATTERNS, type IsProxy } from "@fleet/shared";

import {
  appendWatchLines,
  emptyWatchBuffer,
  readWatchLinesAfter,
  redactWatchLine,
  WATCH_BUFFER_LIMITS,
  type WatchBuffer,
} from "../watch-stream.js";

/** The trusted detector every caller must supply (`node:util`'s real one). */
const DETECTOR: IsProxy = types.isProxy;

/**
 * Secret-shaped literals are never written in fixtures; they are built at
 * runtime so the lane-diff check has nothing credential-shaped to scan.
 */
const GITHUB_TOKEN = "gh" + "p_" + "x".repeat(36);
const OPENROUTER_KEY = "sk-or-v1-" + "0123456789abcdef0123";
const OPENAI_KEY = "sk-" + "y".repeat(24);
const AWS_KEY = "AKIA" + "B2C3D4E5F6G7H8I9";

function makeBuffer(lines: string[], atMs = 1000): WatchBuffer {
  const appended = appendWatchLines(emptyWatchBuffer(), lines, atMs, DETECTOR);
  if (!appended.ok) {
    throw new Error(`fixture append refused: ${String(appended.reason)}`);
  }
  return appended.buffer;
}

describe("redactWatchLine", () => {
  it("masks every secret shape with [REDACTED:<rule name>] and never leaks the matched value", () => {
    // One runtime-built sample per registry rule; each must be masked by the
    // rule that owns it (or an earlier rule whose span covers the same text).
    const samples: Record<string, string> = {
      "aws-access-key": AWS_KEY,
      "github-token": GITHUB_TOKEN,
      "github-fine-grained-token": "github" + "_pat_" + "A1b2C3d4E5f6G7h8I9j0K1",
      "private-key-block": "BEGIN RSA PRIVATE" + " KEY",
      "google-oauth-access-token": "ya" + "29." + "a".repeat(24),
      "google-api-key": "AI" + "za" + "b".repeat(34),
      "openai-style-key": OPENAI_KEY,
      "openrouter-key": OPENROUTER_KEY,
      "slack-token": "xo" + "xb-" + "1234567890-abc",
      jwt: "ey" + "J" + "a".repeat(22) + "." + "b".repeat(12) + "." + "c".repeat(12),
      "ssh-public-key-material": "ssh-" + "rsa AAAA" + "B".repeat(24),
      "opencode-server-password": "OPENCODE_SERVER_" + "PASSWORD=" + "hunter22xyz",
      "agy-oauth-file": "antigravity" + "-oauth-token",
      "home-credential-path": "/home/" + "someone/." + "ssh",
      "password-assignment": "pass" + "word: '" + "abcdefgh'",
      "token-assignment": "tok" + "en = '" + "A".repeat(20) + "'",
      "basic-auth-url": "https://" + "user:" + "secret99" + "@",
    };
    expect(Object.keys(samples).length).toBe(LANE_DIFF_SECRET_PATTERNS.length);
    for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
      const sample = samples[pattern.name];
      expect(sample, pattern.name).toBeDefined();
      const result = redactWatchLine(`before ${sample} after`);
      expect(result.ok, pattern.name).toBe(true);
      if (!result.ok) return;
      expect(result.redacted, pattern.name).toBe(true);
      expect(result.line, pattern.name).toMatch(/^before \[REDACTED:[a-z0-9-]+\] after$/);
      expect(result.line.includes(sample!), pattern.name).toBe(false);
    }
    const line = `deploy with ${GITHUB_TOKEN} and ${AWS_KEY}`;
    const result = redactWatchLine(line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.line).toBe(
      `deploy with [REDACTED:github-token] and [REDACTED:aws-access-key]`,
    );
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result).includes(GITHUB_TOKEN)).toBe(false);
  });

  it("masks multiple secrets on the same line", () => {
    const result = redactWatchLine(`${GITHUB_TOKEN} then ${OPENAI_KEY} then ${GITHUB_TOKEN}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.line).toBe(
      "[REDACTED:github-token] then [REDACTED:openai-style-key] then [REDACTED:github-token]",
    );
  });

  it("merges overlapping secret spans from the original line and emits the first matching rule name in LANE_DIFF_SECRET_PATTERNS order", () => {
    // An OpenRouter key matches BOTH openai-style-key (index 6) and
    // openrouter-key (index 7); the merged span is named by the FIRST rule.
    const result = redactWatchLine(`key=${OPENROUTER_KEY}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.line).toBe(`key=[REDACTED:openai-style-key]`);
    expect(result.line.includes("openrouter-key")).toBe(false);
    expect(result.line.includes(OPENROUTER_KEY)).toBe(false);
  });

  it("merges partially overlapping spans from two rules into one union cover", () => {
    // token-assignment (index 15) matches the whole `Token: "..."` clause and
    // openai-style-key (index 6) matches the key inside it: the spans overlap
    // partially, so the merged span must cover the full union and be named by
    // the first rule in registry order.
    const clause = `Token: "${OPENAI_KEY}"`;
    const result = redactWatchLine(`prefix ${clause} suffix`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.line).toBe("prefix [REDACTED:openai-style-key] suffix");
    expect(result.line.includes("Token:")).toBe(false);
    expect(result.line.includes(OPENAI_KEY)).toBe(false);
  });

  it("truncates an oversized line to maxLineChars before scanning", () => {
    const secretInside = `token ${GITHUB_TOKEN}`;
    const long = "a".repeat(WATCH_BUFFER_LIMITS.maxLineChars) + secretInside;
    const result = redactWatchLine(long);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.line).toHaveLength(WATCH_BUFFER_LIMITS.maxLineChars);
    // The secret sits past the truncation point, so nothing of it can leak.
    expect(result.line.includes(GITHUB_TOKEN)).toBe(false);
    expect(result.line.includes("REDACTED")).toBe(false);
    // A secret inside the kept prefix is still scanned on the truncated text.
    const inside = "b".repeat(10) + GITHUB_TOKEN + "c".repeat(WATCH_BUFFER_LIMITS.maxLineChars);
    const insideResult = redactWatchLine(inside);
    expect(insideResult.ok).toBe(true);
    if (!insideResult.ok) return;
    expect(insideResult.truncated).toBe(true);
    expect(insideResult.line.startsWith(`bbbbbbbbbb[REDACTED:github-token]`)).toBe(true);
  });

  it("refuses non-string inputs including null, undefined, primitives, objects with throwing getters, and revoked Proxies without invoking traps", () => {
    const throwing = {
      get toString(): string {
        throw new Error("must not be invoked");
      },
      valueOf(): number {
        throw new Error("must not be invoked");
      },
    };
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    // Revoking the proxy makes every operation on it throw; the guard must
    // refuse before any property access.
    revoke();
    const cases: unknown[] = [
      null,
      undefined,
      42,
      true,
      false,
      Symbol("nope"),
      10n,
      () => "nope",
      { text: "nope" },
      ["nope"],
      throwing,
      revoked,
    ];
    for (const input of cases) {
      const result = redactWatchLine(input);
      expect(result).toEqual({ ok: false, reason: "non-string" });
    }
  });
});

describe("emptyWatchBuffer", () => {
  it("returns an immutable empty buffer and does not mutate prior buffers on append", () => {
    const empty = emptyWatchBuffer();
    expect(empty).toEqual({ entries: [], totalBytes: 0, lastSeq: 0 });
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.entries)).toBe(true);

    const first = emptyWatchBuffer();
    const snapshot = structuredClone(first);
    const second = appendWatchLines(first, ["one", "two"], 1000, DETECTOR);
    expect(second.ok).toBe(true);
    // The input buffer is untouched.
    expect(first).toEqual(snapshot);
    expect(Object.isFrozen(second)).toBe(true);
    if (second.ok) {
      expect(Object.isFrozen(second.buffer)).toBe(true);
      expect(Object.isFrozen(second.buffer.entries)).toBe(true);
      for (const entry of second.buffer.entries) {
        expect(Object.isFrozen(entry)).toBe(true);
      }
    }
  });
});

describe("appendWatchLines caps", () => {
  it("enforces the 2000-line cap by dropping the oldest lines", () => {
    let buffer = emptyWatchBuffer();
    const first = appendWatchLines(buffer, ["oldest"], 1000, DETECTOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    buffer = first.buffer;

    const filler = Array.from({ length: WATCH_BUFFER_LIMITS.maxLines }, (_, i) => `line-${i}`);
    const appended = appendWatchLines(buffer, filler, 2000, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.buffer.entries).toHaveLength(WATCH_BUFFER_LIMITS.maxLines);
    // The oldest line was dropped; the newest survived.
    expect(appended.buffer.entries[0]!.text).toBe("line-0");
    expect(appended.buffer.entries.at(-1)!.text).toBe(`line-${WATCH_BUFFER_LIMITS.maxLines - 1}`);
    expect(appended.buffer.lastSeq).toBe(WATCH_BUFFER_LIMITS.maxLines + 1);
    // Monotonic 1-based seq numbers across the whole buffer.
    const seqs = appended.buffer.entries.map((entry) => entry.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 2));
    expect(appended.buffer.totalBytes).toBe(
      appended.buffer.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    );
  });

  it("enforces the 512 KB byte cap by dropping the oldest lines", () => {
    // A stored line is truncated to maxLineChars (16 384) before it is kept,
    // so 32 full-size lines fill the 512 KB budget exactly.
    const bigLine = "b".repeat(WATCH_BUFFER_LIMITS.maxLineChars);
    let buffer = emptyWatchBuffer();
    let appended = appendWatchLines(
      buffer,
      Array.from({ length: 32 }, () => bigLine),
      1000,
      DETECTOR,
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    buffer = appended.buffer;
    expect(buffer.entries).toHaveLength(32);
    expect(buffer.totalBytes).toBe(WATCH_BUFFER_LIMITS.maxBytes);
    appended = appendWatchLines(buffer, [bigLine, bigLine], 2000, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    // 34 x 16 384 bytes exceed the cap, so the two oldest lines were dropped.
    expect(appended.buffer.totalBytes).toBeLessThanOrEqual(WATCH_BUFFER_LIMITS.maxBytes);
    expect(appended.buffer.entries).toHaveLength(32);
    expect(appended.buffer.entries[0]!.seq).toBe(3);
    expect(appended.buffer.lastSeq).toBe(34);
  });

  it("evicts lines older than 24 hours on append and on cursor read", () => {
    const DAY = WATCH_BUFFER_LIMITS.maxAgeMs;
    let buffer = emptyWatchBuffer();
    let appended = appendWatchLines(buffer, ["old-1", "old-2"], 1000, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    buffer = appended.buffer;
    appended = appendWatchLines(buffer, ["fresh"], 1000 + DAY + 1, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const stale = buffer;
    buffer = appended.buffer;
    // Both stale lines are evicted on append.
    expect(buffer.entries.map((entry) => entry.text)).toEqual(["fresh"]);
    expect(buffer.totalBytes).toBe(buffer.entries[0]!.bytes);
    expect(buffer.lastSeq).toBe(3);

    // On a cursor read the age filter applies without mutating the buffer.
    // Both stale entries (seq 1 and 2) are gone, so cursors below 2 expired
    // and cursor 2 reads only the fresh line.
    expect(readWatchLinesAfter(buffer, 1, 1000 + DAY + 1, DETECTOR)).toEqual({
      ok: false,
      reason: "cursor-expired",
    });
    const read = readWatchLinesAfter(buffer, 2, 1000 + DAY + 1, DETECTOR);
    expect(read).toEqual({ ok: true, lines: ["fresh"], nextCursor: 3 });
    // The input buffer still holds both stale lines.
    expect(stale.entries).toHaveLength(2);
    // A cursor read of the stale buffer at a time when its lines are still
    // fresh keeps them.
    const fresh = readWatchLinesAfter(stale, 0, 1000 + DAY, DETECTOR);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.lines).toEqual(["old-1", "old-2"]);
    }
  });
});

describe("readWatchLinesAfter", () => {
  it("reads only lines after the given numeric cursor and returns nextCursor", () => {
    const buffer = makeBuffer(["alpha", "beta", "gamma"]);
    expect(buffer.lastSeq).toBe(3);
    const fromZero = readWatchLinesAfter(buffer, 0, 1000, DETECTOR);
    expect(fromZero).toEqual({ ok: true, lines: ["alpha", "beta", "gamma"], nextCursor: 3 });
    const fromTwo = readWatchLinesAfter(buffer, 2, 1000, DETECTOR);
    expect(fromTwo).toEqual({ ok: true, lines: ["gamma"], nextCursor: 3 });
    const fromEnd = readWatchLinesAfter(buffer, 3, 1000, DETECTOR);
    expect(fromEnd).toEqual({ ok: true, lines: [], nextCursor: 3 });
  });

  it("returns cursor-expired when the cursor predates the oldest kept line after eviction or age expiry", () => {
    // Byte-cap eviction: 40 full-size lines (16 384 bytes each) exceed the
    // 512 KB budget, so the 8 oldest lines drop.
    const bigLine = "b".repeat(WATCH_BUFFER_LIMITS.maxLineChars);
    const appended = appendWatchLines(
      emptyWatchBuffer(),
      Array.from({ length: 40 }, () => bigLine),
      1000,
      DETECTOR,
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const buffer = appended.buffer;
    expect(buffer.entries).toHaveLength(32);
    expect(buffer.lastSeq).toBe(40);
    // Dropped = lastSeq (40) - kept (32) = 8: cursors below 8 are expired.
    const expired = readWatchLinesAfter(buffer, 7, 1000, DETECTOR);
    expect(expired).toEqual({ ok: false, reason: "cursor-expired" });
    const boundary = readWatchLinesAfter(buffer, 8, 1000, DETECTOR);
    expect(boundary).toEqual({ ok: true, lines: Array(32).fill(bigLine), nextCursor: 40 });
  });
});

describe("hostile inputs", () => {
  const throwingDetector: IsProxy = () => {
    throw new Error("detector must not run");
  };

  it("refuses missing, non-function, and throwing isProxy detectors without touching input objects", () => {
    const buffer = makeBuffer(["alpha"]);
    const touched: string[] = [];
    const tracked = new Proxy(buffer, {
      get(target, key) {
        touched.push(String(key));
        return Reflect.get(target, key);
      },
    });
    const cases: Array<unknown> = [undefined, null, 1, "nope", true, {}, throwingDetector];
    for (const detector of cases) {
      const appended = appendWatchLines(tracked, ["x"], 1000, detector as IsProxy);
      expect(appended).toEqual({ ok: false, reason: "invalid-detector" });
      const read = readWatchLinesAfter(tracked, 0, 1000, detector as IsProxy);
      expect(read).toEqual({ ok: false, reason: "invalid-detector" });
      const bufferRead = appendWatchLines(tracked, tracked, 1000, detector as IsProxy);
      expect(bufferRead).toEqual({ ok: false, reason: "invalid-detector" });
      expect(touched).toEqual([]);
    }
    // The real detector still passes on the same objects.
    expect(appendWatchLines(buffer, ["x"], 1000, DETECTOR).ok).toBe(true);
    expect(readWatchLinesAfter(buffer, 0, 1000, DETECTOR).ok).toBe(true);
  });

  it("refuses null, undefined, non-iterables, array-likes, holes, element getters, prototype-polluting keys, Proxies, and oversized batches in appendWatchLines", () => {
    const buffer = emptyWatchBuffer();
    const withHole = ["a", "b"];
    withHole.length = 3; // index 2 is a hole
    const withElementGetter: string[] = ["a"];
    Object.defineProperty(withElementGetter, 0, {
      get() {
        return "a";
      },
      enumerable: true,
    });
    const polluting = ["a"];
    Object.defineProperty(polluting, "__proto__", {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const proxyTarget = ["a"];
    const proxied = new Proxy(proxyTarget, {});
    const oversized = Array.from({ length: WATCH_BUFFER_LIMITS.maxLines + 1 }, () => "x");
    const cases: Array<[unknown, string]> = [
      [null, "invalid-lines"],
      [undefined, "invalid-lines"],
      [{}, "invalid-lines"], // non-iterable plain object
      [{ length: 1, 0: "a" }, "invalid-lines"], // array-like
      [42, "invalid-lines"],
      ["string", "invalid-lines"],
      [withHole, "invalid-lines"], // sparse array
      [withElementGetter, "invalid-lines"], // element accessor
      [polluting, "invalid-lines"], // prototype-polluting key
      [proxied, "invalid-lines"], // Proxy
      [oversized, "invalid-lines"], // exceeds maxLines
    ];
    for (const [lines, reason] of cases) {
      const result = appendWatchLines(buffer, lines, 1000, DETECTOR);
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it("refuses a batch containing a non-string element without partial state", () => {
    const buffer = emptyWatchBuffer();
    const before = structuredClone(buffer);
    for (const element of [42, null, undefined, { text: "x" }, ["x"], true]) {
      const result = appendWatchLines(buffer, ["good", element], 1000, DETECTOR);
      expect(result).toEqual({ ok: false, reason: "non-string-line" });
    }
    expect(buffer).toEqual(before);
  });

  it("accepts zero as a valid timestamp on append and read", () => {
    const appended = appendWatchLines(emptyWatchBuffer(), ["x"], 0, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.buffer.entries[0]!.atMs).toBe(0);
    const read = readWatchLinesAfter(appended.buffer, 0, 0, DETECTOR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.lines).toEqual(["x"]);
  });

  it("refuses non-finite, negative, negative-zero, and non-integer timestamps", () => {
    const buffer = emptyWatchBuffer();
    const cases: unknown[] = [NaN, Infinity, -Infinity, -0, -1, 1.5, "1000", null, undefined];
    for (const nowMs of cases) {
      expect(appendWatchLines(buffer, ["x"], nowMs, DETECTOR)).toEqual({
        ok: false,
        reason: "invalid-timestamp",
      });
      expect(readWatchLinesAfter(buffer, 0, nowMs, DETECTOR)).toEqual({
        ok: false,
        reason: "invalid-timestamp",
      });
    }
  });

  it("refuses malformed, non-plain, extra-key, getter-bearing, and proxied buffers", () => {
    const good = makeBuffer(["alpha"]);
    const extraKey = { ...good, extra: 1 };
    const getterBuffer = {
      get entries() {
        return [];
      },
      totalBytes: 0,
      lastSeq: 0,
    };
    const classInstance = new (class extends Object {})();
    const proxied = new Proxy({ ...good }, {});
    const polluting: Record<string, unknown> = { ...good };
    Object.defineProperty(polluting, "__proto__", {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const cases: Array<[unknown, string]> = [
      [null, "invalid-buffer"],
      [undefined, "invalid-buffer"],
      [42, "invalid-buffer"],
      ["buffer", "invalid-buffer"],
      [[], "invalid-buffer"],
      [extraKey, "invalid-buffer"],
      [getterBuffer, "invalid-buffer"],
      [classInstance, "invalid-buffer"],
      [proxied, "invalid-buffer"],
      [polluting, "invalid-buffer"],
    ];
    for (const [malformed, reason] of cases) {
      expect(appendWatchLines(malformed, ["x"], 1000, DETECTOR)).toEqual({ ok: false, reason });
      expect(readWatchLinesAfter(malformed, 0, 1000, DETECTOR)).toEqual({ ok: false, reason });
    }
  });

  it("refuses negative, non-integer, negative-zero, non-finite, and future cursors", () => {
    const buffer = makeBuffer(["alpha", "beta"]);
    const cases: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      -0,
      -1,
      0.5,
      "1",
      null,
      undefined,
      3, // future: beyond lastSeq
      99,
    ];
    for (const cursor of cases) {
      expect(readWatchLinesAfter(buffer, cursor, 1000, DETECTOR)).toEqual({
        ok: false,
        reason: "invalid-cursor",
      });
    }
  });
});

describe("watch-stream validation hardening", () => {
  /**
   * A structurally valid buffer whose claimed sizes understate its real byte
   * weight must be refused: the cap is enforced against the text, not the
   * caller's accounting.
   */
  function tamperedBuffer(text: string, bytes: number, totalBytes: number): unknown {
    return {
      entries: [{ seq: 1, text, bytes, atMs: 1000 }],
      totalBytes,
      lastSeq: 1,
    };
  }

  it("refuses a structurally valid buffer whose entries' bytes do not match their text", () => {
    const longLine = "x".repeat(WATCH_BUFFER_LIMITS.maxLineChars);
    const undercounted = tamperedBuffer(longLine, 0, 0);
    expect(appendWatchLines(undercounted, ["y"], 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
    expect(readWatchLinesAfter(undercounted, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
  });

  it("refuses a buffer whose totalBytes does not match the sum of its entries' bytes", () => {
    const line = "y".repeat(10);
    const inflated = tamperedBuffer(line, 10, 10 + 1);
    expect(appendWatchLines(inflated, ["z"], 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
    expect(readWatchLinesAfter(inflated, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
  });

  it("redacts secret-shaped text from a caller-supplied buffer on read instead of returning it verbatim", () => {
    const secretLine = `token ${GITHUB_TOKEN}`;
    const buffer = tamperedBuffer(secretLine, Buffer.byteLength(secretLine, "utf8"), Buffer.byteLength(secretLine, "utf8"));
    const result = readWatchLinesAfter(buffer, 0, 2000, DETECTOR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual(["token [REDACTED:github-token]"]);
    expect(result.lines.join("\n").includes(GITHUB_TOKEN)).toBe(false);
  });

  it("refuses buffers whose entry seqs are unordered or inconsistent with lastSeq", () => {
    // seqs [2, 1] with lastSeq 2 would let a position slice return seq 1
    // after cursor 1; the validator refuses any non-consecutive ordering.
    const reordered = {
      entries: [
        { seq: 2, text: "b", bytes: 1, atMs: 1000 },
        { seq: 1, text: "a", bytes: 1, atMs: 1000 },
      ],
      totalBytes: 2,
      lastSeq: 2,
    };
    expect(appendWatchLines(reordered, ["c"], 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
    expect(readWatchLinesAfter(reordered, 1, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });

    // A gap between entries (seqs [1, 3]) is not a consecutive run.
    const gapped = {
      entries: [
        { seq: 1, text: "a", bytes: 1, atMs: 1000 },
        { seq: 3, text: "c", bytes: 1, atMs: 1000 },
      ],
      totalBytes: 2,
      lastSeq: 3,
    };
    expect(readWatchLinesAfter(gapped, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });

    // lastSeq must sit at the end of the consecutive run: with entries
    // [1, 2] a lastSeq of 3 invents a dropped line that was never there.
    const mislabeled = {
      entries: [
        { seq: 1, text: "a", bytes: 1, atMs: 1000 },
        { seq: 2, text: "b", bytes: 1, atMs: 1000 },
      ],
      totalBytes: 2,
      lastSeq: 3,
    };
    expect(readWatchLinesAfter(mislabeled, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });

    // lastSeq below the entry positions is equally inconsistent.
    expect(readWatchLinesAfter({ ...mislabeled, lastSeq: 1 }, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
  });

  it("refuses a buffer whose accurate accounting still exceeds the maxBytes cap", () => {
    // 33 full-size lines with an ACCURATE total: the previous validator only
    // checked accounting, so this 540 672-byte buffer slipped through.
    const line = "b".repeat(WATCH_BUFFER_LIMITS.maxLineChars);
    const bytes = WATCH_BUFFER_LIMITS.maxLineChars;
    const over = {
      entries: Array.from({ length: 33 }, (_, index) => ({
        seq: index + 1,
        text: line,
        bytes,
        atMs: 1000,
      })),
      totalBytes: 33 * bytes,
      lastSeq: 33,
    };
    expect(over.totalBytes).toBeGreaterThan(WATCH_BUFFER_LIMITS.maxBytes);
    expect(appendWatchLines(over, ["x"], 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
    expect(readWatchLinesAfter(over, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });

    // The line cap is enforced the same way on read.
    const tooManyLines = {
      entries: Array.from({ length: WATCH_BUFFER_LIMITS.maxLines + 1 }, (_, index) => ({
        seq: index + 1,
        text: "a",
        bytes: 1,
        atMs: 1000,
      })),
      totalBytes: WATCH_BUFFER_LIMITS.maxLines + 1,
      lastSeq: WATCH_BUFFER_LIMITS.maxLines + 1,
    };
    expect(readWatchLinesAfter(tooManyLines, 0, 2000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
  });

  it("keeps a redaction-expanded line within maxLineChars so append and read round-trip", () => {
    // A short key at the very end of a maxLineChars line: the marker
    // `[REDACTED:aws-access-key]` is longer than the 20-byte match, so the
    // rebuilt line would exceed the cap and a later snapshot at maxLineChars
    // would refuse the stored text.
    const pad = "p".repeat(WATCH_BUFFER_LIMITS.maxLineChars - 20);
    const line = pad + AWS_KEY;
    expect(line.length).toBe(WATCH_BUFFER_LIMITS.maxLineChars);
    const redaction = redactWatchLine(line);
    expect(redaction.ok).toBe(true);
    if (!redaction.ok) return;
    expect(redaction.redacted).toBe(true);
    expect(redaction.line.length).toBeLessThanOrEqual(WATCH_BUFFER_LIMITS.maxLineChars);

    const appended = appendWatchLines(emptyWatchBuffer(), [line], 1000, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.buffer.entries[0]!.text.length).toBeLessThanOrEqual(
      WATCH_BUFFER_LIMITS.maxLineChars,
    );
    const read = readWatchLinesAfter(appended.buffer, 0, 1000, DETECTOR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.lines[0]).toBe(appended.buffer.entries[0]!.text);
    expect(read.lines[0]!.includes(AWS_KEY)).toBe(false);
  });

  it("never emits a clipped redaction marker when expansion crosses maxLineChars", () => {
    // The marker is 25 chars for a 20-char key: at the cap it cannot fit, so
    // it is dropped whole instead of being cut to a fragment.
    const pad = "p".repeat(WATCH_BUFFER_LIMITS.maxLineChars - 20);
    const redaction = redactWatchLine(pad + AWS_KEY);
    expect(redaction.ok).toBe(true);
    if (!redaction.ok) return;
    expect(redaction.line).toBe(pad);
    expect(redaction.line.includes("[")).toBe(false);
    // With room to spare the same marker is present in full.
    const roomy = redactWatchLine("p".repeat(100) + AWS_KEY);
    expect(roomy.ok && roomy.line.endsWith("[REDACTED:aws-access-key]")).toBe(true);
  });

  it("refuses an append whose timestamp runs backwards past the newest entry and keeps the buffer readable", () => {
    const first = appendWatchLines(emptyWatchBuffer(), ["a"], 100_000_000, DETECTOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(appendWatchLines(first.buffer, ["b"], 1000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-timestamp",
    });
    const same = appendWatchLines(first.buffer, ["b"], 100_000_000, DETECTOR);
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(readWatchLinesAfter(same.buffer, 0, 100_000_000, DETECTOR)).toMatchObject({
      ok: true,
      lines: ["a", "b"],
    });
  });

  it("refuses a buffer whose entry timestamps run backwards", () => {
    const backwards = {
      entries: [
        { seq: 1, text: "a", bytes: 1, atMs: 5000 },
        { seq: 2, text: "b", bytes: 1, atMs: 1000 },
      ],
      totalBytes: 2,
      lastSeq: 2,
    };
    expect(readWatchLinesAfter(backwards, 0, 5000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
    expect(appendWatchLines(backwards, ["c"], 6000, DETECTOR)).toEqual({
      ok: false,
      reason: "invalid-buffer",
    });
  });

  it("refuses counters beyond the safe-integer range and an append that would overflow lastSeq", () => {
    const unsafe = { entries: [], totalBytes: 0, lastSeq: Number.MAX_SAFE_INTEGER + 1 };
    expect(appendWatchLines(unsafe, ["x"], 1000, DETECTOR)).toEqual({ ok: false, reason: "invalid-buffer" });
    expect(readWatchLinesAfter(unsafe, 0, 1000, DETECTOR)).toEqual({ ok: false, reason: "invalid-buffer" });
    const atLimit = { entries: [], totalBytes: 0, lastSeq: Number.MAX_SAFE_INTEGER };
    expect(appendWatchLines(atLimit, ["x"], 1000, DETECTOR)).toEqual({ ok: false, reason: "invalid-buffer" });
    const nearLimit = { entries: [], totalBytes: 0, lastSeq: Number.MAX_SAFE_INTEGER - 1 };
    const ok = appendWatchLines(nearLimit, ["x"], 1000, DETECTOR);
    expect(ok.ok && ok.buffer.lastSeq === Number.MAX_SAFE_INTEGER).toBe(true);
  });

  it("re-redacts secret-shaped text already present in a caller-supplied buffer on append", () => {
    const text = `leak ${GITHUB_TOKEN}`;
    const poisoned = {
      entries: [{ seq: 1, text, bytes: new TextEncoder().encode(text).byteLength, atMs: 1000 }],
      totalBytes: new TextEncoder().encode(text).byteLength,
      lastSeq: 1,
    };
    const appended = appendWatchLines(poisoned, ["ordinary"], 2000, DETECTOR);
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.buffer.entries[0]!.text).toBe("leak [REDACTED:github-token]");
    expect(JSON.stringify(appended.buffer).includes(GITHUB_TOKEN)).toBe(false);
    expect(appended.buffer.totalBytes).toBe(
      appended.buffer.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    );
  });
});

describe("private key block context", () => {
  const BEGIN = "-----" + "BEGIN RSA PRIVATE KEY" + "-----";
  const END = "-----" + "END RSA PRIVATE KEY" + "-----";
  const BODY = ["MIIEowIBAAKCAQEAx7" + "Q".repeat(40), "Zm9vYmFyYmF6cXV4" + "R".repeat(40)];

  it("redacts the base64 body lines between a private key header and its END line, across appends and reads", () => {
    const first = appendWatchLines(emptyWatchBuffer(), ["before", BEGIN, BODY[0]!], 1000, DETECTOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendWatchLines(first.buffer, [BODY[1]!, END, "after"], 1001, DETECTOR);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const read = readWatchLinesAfter(second.buffer, 0, 1001, DETECTOR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const text = read.lines.join("\n");
    for (const body of BODY) {
      expect(text).not.toContain(body);
    }
    expect(read.lines).toEqual([
      "before",
      "-----[REDACTED:private-key-block]-----",
      "[REDACTED:private-key-body]",
      "[REDACTED:private-key-body]",
      END,
      "after",
    ]);
  });

  it("redacts raw body lines of a caller-supplied buffer whose header was never redacted", () => {
    const raw = {
      entries: [
        { seq: 1, text: BEGIN, bytes: BEGIN.length, atMs: 1000 },
        { seq: 2, text: BODY[0]!, bytes: BODY[0]!.length, atMs: 1000 },
      ],
      totalBytes: BEGIN.length + BODY[0]!.length,
      lastSeq: 2,
    };
    const read = readWatchLinesAfter(raw, 1, 1000, DETECTOR);
    expect(read).toEqual({ ok: true, lines: ["[REDACTED:private-key-body]"], nextCursor: 2 });
  });
});

describe("private key block context survives eviction", () => {
  const BEGIN = "-----" + "BEGIN PRIVATE KEY" + "-----";
  const BODY = "MIIEvQIBADANBgkqhkiG9w0B" + "Z".repeat(40);

  it("keeps redacting body lines after the header was evicted by the line cap", () => {
    const head = appendWatchLines(emptyWatchBuffer(), [BEGIN], 1000, DETECTOR);
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    const filler = Array.from({ length: WATCH_BUFFER_LIMITS.maxLines }, () => BODY);
    const first = appendWatchLines(head.buffer, filler, 1000, DETECTOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.buffer.entries).toHaveLength(WATCH_BUFFER_LIMITS.maxLines);
    expect(first.buffer.entries.some((entry) => entry.text.includes("REDACTED:private-key-block"))).toBe(false);
    const second = appendWatchLines(first.buffer, [BODY, "tail"], 1001, DETECTOR);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const texts = second.buffer.entries.map((entry) => entry.text);
    expect(texts.join("\n")).not.toContain(BODY);
  });

  it("keeps redacting after the header aged out of the buffer", () => {
    const first = appendWatchLines(emptyWatchBuffer(), [BEGIN, BODY], 1000, DETECTOR);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const later = 1000 + WATCH_BUFFER_LIMITS.maxAgeMs + 1;
    const second = appendWatchLines(first.buffer, [BODY], later, DETECTOR);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.buffer.entries.map((entry) => entry.text)).toEqual(["[REDACTED:private-key-body]"]);
  });
});
