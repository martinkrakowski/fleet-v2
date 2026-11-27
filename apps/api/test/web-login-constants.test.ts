import { describe, expect, it } from "vitest";

import {
  WEB_LOGIN_ACTOR,
  WEB_LOGIN_PATH,
  WEB_LOGIN_SCOPES,
  isWebLoginPath,
} from "../server/wiring/web-login.js";

describe("isWebLoginPath refusals", () => {
  it("returns true only for exact WEB_LOGIN_PATH and false for near-miss and empty paths", () => {
    expect(isWebLoginPath(WEB_LOGIN_PATH)).toBe(true);
    // WEB_LOGIN_PATH is the constant under test, not an identity function's
    // echo of its argument; a literal pin proves the constant itself.
    expect(isWebLoginPath("/sessions/login")).toBe(true);
    const nearMisses = [
      "/sessions/login/",
      "/sessions/login?x=1",
      "/Sessions/login",
      "/sessions/loginx",
      " /sessions/login",
      "/sessions/login%2F",
      "/sessions/exchange",
      "",
    ];
    for (const path of nearMisses) {
      expect(isWebLoginPath(path)).toBe(false);
    }
  });

  it("returns false without throwing for null and undefined", () => {
    expect(() => isWebLoginPath(null as never)).not.toThrow();
    expect(isWebLoginPath(null as never)).toBe(false);
    expect(() => isWebLoginPath(undefined as never)).not.toThrow();
    expect(isWebLoginPath(undefined as never)).toBe(false);
  });

  it("returns false without coercing wrong primitives", () => {
    expect(() => isWebLoginPath(5 as never)).not.toThrow();
    expect(isWebLoginPath(5 as never)).toBe(false);
    expect(() => isWebLoginPath(true as never)).not.toThrow();
    expect(isWebLoginPath(true as never)).toBe(false);
    expect(() => isWebLoginPath(Symbol("login") as never)).not.toThrow();
    expect(isWebLoginPath(Symbol("login") as never)).toBe(false);
  });

  it("returns false without iterating for objects, array-likes, and prototype-polluting inputs", () => {
    const holey: string[] = new Array(2);
    holey[1] = "/sessions/login";
    const inputs = [
      {},
      [],
      holey,
      { length: 1, 0: "/sessions/login" },
      { length: 1e9 },
      JSON.parse('{"__proto__":"/sessions/login"}'),
    ];
    for (const input of inputs) {
      expect(() => isWebLoginPath(input as never)).not.toThrow();
      expect(isWebLoginPath(input as never)).toBe(false);
    }
  });

  it("returns false without invoking getters on non-string objects", () => {
    const getterRan = { toString: false, valueOf: false };
    const boobyTrapped = {};
    Object.defineProperty(boobyTrapped, "toString", {
      get() {
        getterRan.toString = true;
        throw new Error("getter invoked");
      },
    });
    Object.defineProperty(boobyTrapped, "valueOf", {
      get() {
        getterRan.valueOf = true;
        throw new Error("getter invoked");
      },
    });
    expect(() => isWebLoginPath(boobyTrapped as never)).not.toThrow();
    expect(isWebLoginPath(boobyTrapped as never)).toBe(false);
    expect(getterRan).toEqual({ toString: false, valueOf: false });
  });

  it("returns false without triggering Proxy traps", () => {
    let trapRan = false;
    const lying = new Proxy(
      {},
      {
        get() {
          trapRan = true;
          throw new Error("trap");
        },
      },
    );
    expect(() => isWebLoginPath(lying as never)).not.toThrow();
    expect(isWebLoginPath(lying as never)).toBe(false);
    expect(trapRan).toBe(false);
  });
});

describe("web-login constants", () => {
  it("WEB_LOGIN_SCOPES equals [\"read\", \"message\", \"operate\", \"tail\"] with length 4 and no mutating or orchestration scopes", () => {
    expect([...WEB_LOGIN_SCOPES]).toEqual(["read", "message", "operate", "tail"]);
    expect(WEB_LOGIN_SCOPES).toHaveLength(4);
    expect(WEB_LOGIN_SCOPES).not.toContain("write");
    expect(WEB_LOGIN_SCOPES).not.toContain("admin");
    expect(WEB_LOGIN_SCOPES).not.toContain("orchestrate");
    expect(WEB_LOGIN_SCOPES).not.toContain("dispatch");
  });

  it("WEB_LOGIN_ACTOR is pinned to \"owner\"", () => {
    // "owner" is pinned as a literal so that any change to the actor — which
    // decides who an interactive session is attributed to, and today has no
    // separate identity decision — shows up in a reviewer's diff instead of
    // silently following a renamed constant.
    expect(WEB_LOGIN_ACTOR).toBe("owner");
  });

  it("WEB_LOGIN_PATH is the login route constant the guard accepts", () => {
    expect(WEB_LOGIN_PATH).toBe("/sessions/login");
    expect(isWebLoginPath(WEB_LOGIN_PATH)).toBe(true);
  });
});
