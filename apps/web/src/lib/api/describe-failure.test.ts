import { describe, expect, it } from "vitest";

import { describeFailure } from "./describe-failure";

describe("describeFailure", () => {
  it("returns unknown error for non-Error primitives, null, and undefined", () => {
    expect(describeFailure("http://x/y")).toBe("unknown error");
    expect(describeFailure(null)).toBe("unknown error");
    expect(describeFailure(undefined)).toBe("unknown error");
    expect(describeFailure(42)).toBe("unknown error");
    expect(describeFailure(true)).toBe("unknown error");
  });

  it("returns unknown error for plain objects, array-likes, and sparse arrays", () => {
    expect(describeFailure({ message: "fetch failed" })).toBe(
      "unknown error",
    );
    expect(describeFailure({ length: 1_000_000_000, 0: "a" })).toBe(
      "unknown error",
    );
    const sparse = new Array(2);
    sparse[1] = "a";
    expect(describeFailure(sparse)).toBe("unknown error");
  });

  it("ignores prototype-polluting keys on non-Error values and error.cause", () => {
    const polluted = JSON.parse('{"__proto__":{"message":"fetch failed"}}');
    expect(describeFailure(polluted)).toBe("unknown error");
    const defined = Object.defineProperty({}, "constructor", {
      value: { message: "fetch failed" },
    });
    expect(describeFailure(defined)).toBe("unknown error");

    const cause = Object.defineProperty({}, "constructor", {
      value: { message: "fetch failed" },
    });
    const withCause = Object.assign(new Error("fetch failed"), { cause });
    expect(describeFailure(withCause)).toBe("fetch failed");
  });

  it("preserves a plain-words message verbatim", () => {
    expect(describeFailure(new Error("fetch failed"))).toBe("fetch failed");
    expect(describeFailure(new Error("a"))).toBe("a");
    expect(describeFailure(new Error("a".repeat(80)))).toBe("a".repeat(80));
  });

  it("replaces messages containing digits, punctuation, or empty text with request failed", () => {
    for (const message of [
      "",
      "line 1",
      "failed.",
      "a/b",
      "a:b",
      "a-b",
      "getaddrinfo ENOTFOUND api.example.test",
      "http://x/y",
    ]) {
      expect(describeFailure(new Error(message))).toBe("request failed");
    }
  });

  it("replaces messages longer than 80 characters including enormous strings with request failed", () => {
    expect(describeFailure(new Error("a".repeat(81)))).toBe("request failed");
    expect(describeFailure(new Error("a".repeat(100_000)))).toBe(
      "request failed",
    );
  });

  it("appends a valid cause code as (CODE)", () => {
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        }),
      ),
    ).toBe("fetch failed (ENOTFOUND)");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), { cause: { code: "AB" } }),
      ),
    ).toBe("fetch failed (AB)");
    const code = "A" + "B".repeat(40);
    expect(
      describeFailure(
        Object.assign(new Error("request failed"), {
          cause: { code },
        }),
      ),
    ).toBe("request failed (" + code + ")");
  });

  it("omits cause code when cause is not an object or code fails ERROR_CODE", () => {
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), {
          cause: { code: "enotfound" },
        }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), { cause: { code: "A" } }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), {
          cause: { code: "A" + "B".repeat(41) },
        }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), { cause: { code: 404 } }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), { cause: { code: null } }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), { cause: "ENOTFOUND" }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(
        Object.assign(new Error("fetch failed"), { cause: null }),
      ),
    ).toBe("fetch failed");
    expect(
      describeFailure(Object.assign(new Error("fetch failed"), {})),
    ).toBe("fetch failed");
  });

  it("never leaks the original message when the message is not plain words", () => {
    const host = "getaddrinfo ENOTFOUND api.example.test";
    expect(describeFailure(new Error(host))).not.toContain(host);
    expect(describeFailure(new Error(host))).not.toContain("api.example.test");
    expect(describeFailure(new Error("http://x/y"))).toBe("request failed");
  });

  it("lets a throwing cause getter escape (known limitation: unguarded property read)", () => {
    const error = new Error("fetch failed");
    Object.defineProperty(error, "cause", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => describeFailure(error)).toThrow("boom");
  });
});
