// VX10: operator error envelope guards. Every read of `message`,
// `statusCode` and `name` goes through own data descriptors, so hostile
// getters, Proxies and forged values never influence the envelope.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorEnvelope,
  forbiddenEnvelope,
  mapOperatorError,
  newOperationId,
  notFoundEnvelope,
  refusedEnvelope,
  successEnvelope,
} from "../operator/errors.js";

const internalError = (operationId: string) => ({
  statusCode: 500,
  body: { operationId, code: "INTERNAL_ERROR", result: null },
});

let consoleSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  consoleSpy?.mockRestore();
  vi.restoreAllMocks();
});

/** Runs errorEnvelope, silences console.error and asserts the 500 envelope. */
function expectInternalError(operationId: string, error: unknown): void {
  consoleSpy?.mockRestore();
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(errorEnvelope(operationId, error)).toEqual(internalError(operationId));
}

/** A getter descriptor with a call counter; the counter must stay at zero. */
function countingGetter(value: unknown): { descriptor: PropertyDescriptor; calls: () => number } {
  let count = 0;
  return {
    descriptor: {
      get: () => {
        count += 1;
        return value;
      },
      enumerable: true,
      configurable: true,
    },
    calls: () => count,
  };
}

describe("VC10 builder contracts", () => {
  it("refusedEnvelope builds exactly the 422 REFUSED envelope", () => {
    expect(refusedEnvelope("op-1", "because")).toEqual({
      statusCode: 422,
      body: { operationId: "op-1", code: "REFUSED", result: { reason: "because" } },
    });
  });

  it("forbiddenEnvelope builds exactly the 403 FORBIDDEN envelope", () => {
    expect(forbiddenEnvelope("op-2", "scope")).toEqual({
      statusCode: 403,
      body: { operationId: "op-2", code: "FORBIDDEN", result: { reason: "scope" } },
    });
  });

  it("notFoundEnvelope builds exactly the 404 NOT_FOUND envelope", () => {
    expect(notFoundEnvelope("op-3")).toEqual({
      statusCode: 404,
      body: { operationId: "op-3", code: "NOT_FOUND", result: null },
    });
  });

  it("successEnvelope builds exactly the OK envelope and carries a null result verbatim", () => {
    expect(successEnvelope("op-4", { a: 1 })).toEqual({ operationId: "op-4", code: "OK", result: { a: 1 } });
    expect(successEnvelope("op-5", null)).toEqual({ operationId: "op-5", code: "OK", result: null });
  });

  it("newOperationId returns two different non-empty strings across two calls", () => {
    const first = newOperationId();
    const second = newOperationId();
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });
});

describe("shared mapOperatorError and errorEnvelope 501 agreement", () => {
  it("maps a plain Not implemented error to 501 NOT_IMPLEMENTED in both functions", () => {
    const error = new Error("Not implemented: x");
    expect(mapOperatorError(error)).toEqual({ status: 501, code: "NOT_IMPLEMENTED" });
    expect(errorEnvelope("op-6", error)).toEqual({
      statusCode: 501,
      body: { operationId: "op-6", code: "NOT_IMPLEMENTED", result: null },
    });
  });

  it("maps non-implemented-shaped inputs to null and 500 INTERNAL_ERROR", () => {
    for (const error of [new Error("other"), "Not implemented: str", null, undefined]) {
      expect(mapOperatorError(error)).toBeNull();
      expectInternalError("op-refused", error);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    }
  });
});

describe("client statusCode validation", () => {
  it("accepts integer statusCode in 400..499 as BAD_REQUEST with that status", () => {
    for (const statusCode of [400, 499]) {
      expect(errorEnvelope("op-status", { statusCode })).toEqual({
        statusCode,
        body: { operationId: "op-status", code: "BAD_REQUEST", result: null },
      });
    }
  });

  it("refuses non-integer, string, NaN and out-of-range statusCode values with 500", () => {
    for (const statusCode of [399, 500, "404", Number.NaN, Number.POSITIVE_INFINITY, 400.5]) {
      expect(mapOperatorError({ statusCode })).toBeNull();
      expectInternalError("op-bad-status", { statusCode });
      expect(consoleSpy).toHaveBeenCalledWith("operator error: object");
    }
    expect(mapOperatorError(new Error("boom"))).toBeNull();
    expectInternalError("op-bad-status", new Error("boom"));
    expect(consoleSpy).toHaveBeenCalledWith("operator error: Error");
  });
});

describe("getter and accessor guards", () => {
  it("never invokes own or inherited message getters and refuses forged 501", () => {
    const forged = countingGetter("Not implemented: forged");
    const own = Object.create(Error.prototype) as object;
    Object.defineProperty(own, "message", forged.descriptor);
    expect(forged.calls()).toBe(0);
    expect(mapOperatorError(own)).toBeNull();
    expectInternalError("op-getter", own);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    const throwing = countingGetter("Not implemented: forged");
    throwing.descriptor.get = () => {
      throw new Error("no");
    };
    const subclass = new (class extends Error {})("x");
    Object.defineProperty(subclass, "message", throwing.descriptor);
    Object.defineProperty(own, "message", throwing.descriptor);
    expect(throwing.calls()).toBe(0);
    expect(mapOperatorError(subclass)).toBeNull();
    expect(mapOperatorError(own)).toBeNull();
    expectInternalError("op-getter", subclass);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("never invokes statusCode getters and falls back to 500 INTERNAL_ERROR", () => {
    const accessor = countingGetter(400);
    const withAccessor: object = Object.defineProperty({}, "statusCode", accessor.descriptor);
    expect(accessor.calls()).toBe(0);
    expectInternalError("op-status-getter", withAccessor);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    const withThrowing: object = Object.defineProperty({}, "statusCode", {
      get: () => {
        throw new Error("no");
      },
    });
    expectInternalError("op-status-getter", withThrowing);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("never invokes name getters and logs Error", () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const accessor = countingGetter("Forged");
    const forgedName = Object.defineProperty(new Error("x"), "name", accessor.descriptor);
    expect(accessor.calls()).toBe(0);
    expect(errorEnvelope("op-name", forgedName)).toEqual(internalError("op-name"));
    expect(consoleSpy).toHaveBeenCalledWith("operator error: Error");

    const throwingName = Object.defineProperty(new Error("x"), "name", {
      get: () => {
        throw new Error("no");
      },
    });
    expect(errorEnvelope("op-name", throwingName)).toEqual(internalError("op-name"));
    expect(consoleSpy).toHaveBeenLastCalledWith("operator error: Error");
  });
});

describe("500 logging redaction", () => {
  it("logs only the class name and never the message or its caller paths", () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("failed at /var/tmp/example-worktree");
    expect(errorEnvelope("op-log", error)).toEqual(internalError("op-log"));
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith("operator error: Error");
    for (const call of consoleSpy.mock.calls) {
      const text = JSON.stringify(call);
      expect(text).not.toContain("example-worktree");
      expect(text).not.toContain("/var/tmp");
    }
  });

  it("logs an own data name verbatim when it matches the identifier shape", () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const named = Object.defineProperty(new Error("x"), "name", { value: "CustomOperatorError" });
    expect(errorEnvelope("op-log", named)).toEqual(internalError("op-log"));
    expect(consoleSpy).toHaveBeenCalledWith("operator error: CustomOperatorError");
  });

  it("logs TypeError for a TypeError instance via its prototype's own name", () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorEnvelope("op-log", new TypeError("x"))).toEqual(internalError("op-log"));
    expect(consoleSpy).toHaveBeenCalledWith("operator error: TypeError");
  });

  it("logs Error when the name contains a newline or a path", () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const injected = Object.defineProperty(new Error("x"), "name", { value: "Bad\nName/etc" });
    expect(errorEnvelope("op-log", injected)).toEqual(internalError("op-log"));
    expect(consoleSpy).toHaveBeenCalledWith("operator error: Error");
  });
});

describe("hostile inputs", () => {
  it("refuses null, undefined and non-iterable primitives with 500 INTERNAL_ERROR", () => {
    for (const error of [null, undefined, 42, true, Symbol("x"), 10n]) {
      expect(mapOperatorError(error)).toBeNull();
      expectInternalError("op-hostile", error);
      expect(consoleSpy).toHaveBeenCalledWith(`operator error: ${typeof error}`);
    }
  });

  it("handles arrays, array-likes and frozen objects without throwing", () => {
    expect(mapOperatorError([])).toBeNull();
    const sparse: unknown[] = [];
    delete sparse[0];
    expectInternalError("op-hostile", sparse);
    expectInternalError("op-hostile", { length: 1_000_000_000 });
    expect(errorEnvelope("op-hostile", Object.freeze({ statusCode: 400 }))).toEqual({
      statusCode: 400,
      body: { operationId: "op-hostile", code: "BAD_REQUEST", result: null },
    });
    expectInternalError("op-hostile", Object.freeze({}));
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses an own __proto__ data property with 500 INTERNAL_ERROR", () => {
    const polluted = Object.defineProperty({}, "__proto__", {
      value: { statusCode: 400 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(mapOperatorError(polluted)).toBeNull();
    expectInternalError("op-proto", polluted);
  });

  it("handles Proxy errors without running get/has traps or throwing", () => {
    const trapProxy = new Proxy(
      {},
      {
        get: () => {
          throw new Error("get trap");
        },
        has: () => {
          throw new Error("has trap");
        },
        getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
      },
    );
    expect(mapOperatorError(trapProxy)).toBeNull();
    expectInternalError("op-proxy", trapProxy);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    const descriptorProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("descriptor trap");
        },
      },
    );
    expect(mapOperatorError(descriptorProxy)).toBeNull();
    expectInternalError("op-proxy", descriptorProxy);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("survives a Proxy whose getPrototypeOf trap throws with null and 500", () => {
    const protoProxy = new Proxy(new Error("Not implemented: x"), {
      getPrototypeOf: () => {
        throw new Error("proto trap");
      },
    });
    expect(mapOperatorError(protoProxy)).toBeNull();
    expectInternalError("op-proxy", protoProxy);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it("never copies a 10 MB message into logs and returns a typed envelope", () => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const big = "x".repeat(10 * 1024 * 1024);
    expect(errorEnvelope("op-big", new Error(big))).toEqual(internalError("op-big"));
    expect(mapOperatorError(new Error(`Not implemented: ${big}`))).toEqual({
      status: 501,
      code: "NOT_IMPLEMENTED",
    });
    expect(errorEnvelope("op-big", new Error(`Not implemented: ${big}`))).toEqual({
      statusCode: 501,
      body: { operationId: "op-big", code: "NOT_IMPLEMENTED", result: null },
    });
    for (const call of consoleSpy.mock.calls) {
      expect(String(call[0]).length).toBeLessThan(100);
    }
  });
});
