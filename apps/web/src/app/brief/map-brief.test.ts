import { types } from "node:util";
import { describe, expect, it } from "vitest";
import { WORK_ORDER_BRIEF_LIST_FIXTURE } from "./fixture";
import {
  MAX_WORK_ORDER_ENTRIES,
  formatBriefDigest,
  readExactRecord,
  parseWorkOrderBriefListEnvelope,
  readEnvelopeCode,
  selectWorkOrderEntry,
} from "./map-brief";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ok = (entries: unknown) => ({ code: "OK", result: { entries } });
const entries = () => clone(WORK_ORDER_BRIEF_LIST_FIXTURE.entries) as unknown as Record<string, unknown>[];
const parse = (value: unknown) => parseWorkOrderBriefListEnvelope(value, types.isProxy);

describe("parseWorkOrderBriefListEnvelope", () => {
  it("parses the work-order list fixture", () => {
    const parsed = parse(ok(entries()));
    expect(parsed?.entries).toHaveLength(2);
    expect(parsed?.entries[0].workOrder.id).toBe("wo-0144");
    expect(parsed?.entries[1].latestAttempt).toBeNull();
  });

  it("parses an empty list", () => {
    expect(parse(ok([]))).toEqual({ entries: [] });
  });

  it("refuses null, undefined, primitives, and non-object envelopes", () => {
    for (const value of [null, undefined, 1, "OK", true, [], () => 1, ok(undefined), { code: "OK" }, { code: "OK", result: null }, { code: "OK", result: {} }]) {
      expect(parse(value)).toBeNull();
    }
  });

  it("refuses live and revoked Proxy inputs without invoking traps", () => {
    let trapped = 0;
    const handler: ProxyHandler<object> = {
      get() { trapped += 1; return undefined; },
      ownKeys() { trapped += 1; return []; },
      getOwnPropertyDescriptor() { trapped += 1; return undefined; },
      getPrototypeOf() { trapped += 1; return null; },
    };
    const live = new Proxy(ok(entries()), handler);
    const nested = ok([new Proxy(entries()[0], handler)]);
    const revoked = Proxy.revocable(ok(entries()), {});
    revoked.revoke();
    expect(parse(live)).toBeNull();
    expect(readEnvelopeCode(live, types.isProxy)).toBeNull();
    expect(parse(nested)).toBeNull();
    expect(parse(revoked.proxy)).toBeNull();
    expect(readEnvelopeCode(revoked.proxy, types.isProxy)).toBeNull();
    expect(trapped).toBe(0);
  });

  it("refuses objects with own getter properties without invoking them", () => {
    let calls = 0;
    const env = { code: "OK" } as Record<string, unknown>;
    Object.defineProperty(env, "result", { enumerable: true, get() { calls += 1; return { entries: [] }; } });
    const e = entries();
    Object.defineProperty(e[0], "briefMarkdown", { enumerable: true, get() { calls += 1; return null; } });
    expect(parse(env)).toBeNull();
    expect(parse(ok(e))).toBeNull();
    expect(calls).toBe(0);
  });

  it("refuses objects with inherited getters on prototype without invoking them", () => {
    let calls = 0;
    const proto = { get code() { calls += 1; return "OK"; } };
    const inherited = Object.create(proto) as Record<string, unknown>;
    inherited.result = { entries: [] };
    expect(parse(inherited)).toBeNull();
    expect(readEnvelopeCode(inherited, types.isProxy)).toBeNull();
    expect(calls).toBe(0);
  });

  it("refuses arrays and objects with Symbol.iterator overrides", () => {
    let calls = 0;
    const list = entries();
    Object.defineProperty(list, Symbol.iterator, { value() { calls += 1; return [][Symbol.iterator](); } });
    const env = ok(entries()) as Record<string | symbol, unknown>;
    env[Symbol.iterator] = () => { calls += 1; return [][Symbol.iterator](); };
    expect(parse(ok(list))).toBeNull();
    expect(parse(env)).toBeNull();
    expect(calls).toBe(0);
  });

  it("refuses reserved own keys (__proto__, constructor, prototype)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const env = ok(entries()) as Record<string, unknown>;
      Object.defineProperty(env, key, { value: 1, enumerable: true, configurable: true, writable: true });
      expect(parse(env)).toBeNull();
      const withCode = { code: "X" } as Record<string, unknown>;
      Object.defineProperty(withCode, key, { value: 1, enumerable: true, configurable: true, writable: true });
      expect(readEnvelopeCode(withCode, types.isProxy)).toBeNull();
    }
  });

  it("refuses extra keys on envelope, result, entry, workOrder, and attempt", () => {
    const e1 = entries();
    (e1[0] as Record<string, unknown>).extra = 1;
    const e2 = entries();
    (e2[0].workOrder as Record<string, unknown>).extra = 1;
    const e3 = entries();
    (e3[0].latestAttempt as Record<string, unknown>).extra = 1;
    expect(parse({ ...ok(entries()), extra: 1 })).toBeNull();
    expect(parse({ code: "OK", result: { entries: entries(), extra: 1 } })).toBeNull();
    expect(parse(ok(e1))).toBeNull();
    expect(parse(ok(e2))).toBeNull();
    expect(parse(ok(e3))).toBeNull();
  });

  it("refuses non-array entries, array-like objects, and non-array string lists", () => {
    const arrayLike = { length: 1, 0: entries()[0] };
    const e1 = entries();
    (e1[0].workOrder as Record<string, unknown>).ownedPaths = { length: 1, 0: "a" };
    const e2 = entries();
    (e2[0].workOrder as Record<string, unknown>).prerequisiteWorkOrderIds = "wo-1";
    const e3 = entries();
    (e3[0].latestAttempt as Record<string, unknown>).ownerDecisionReferences = { length: 0 };
    expect(parse(ok(arrayLike))).toBeNull();
    expect(parse(ok("entries"))).toBeNull();
    expect(parse(ok(e1))).toBeNull();
    expect(parse(ok(e2))).toBeNull();
    expect(parse(ok(e3))).toBeNull();
  });

  it("refuses sparse arrays with holes", () => {
    const sparse: unknown[] = [entries()[0]];
    sparse[2] = entries()[1];
    const e = entries();
    (e[0].workOrder as Record<string, unknown>).ownedPaths = new Array<string>(2);
    expect(parse(ok(sparse))).toBeNull();
    expect(parse(ok(e))).toBeNull();
  });

  it("refuses oversized entries lists and enormous lengths above the bound", () => {
    const one = entries()[0];
    expect(parse(ok(Array.from({ length: MAX_WORK_ORDER_ENTRIES }, () => one)))).not.toBeNull();
    expect(parse(ok(Array.from({ length: MAX_WORK_ORDER_ENTRIES + 1 }, () => one)))).toBeNull();
    const huge = new Array<unknown>(4_294_967_295);
    expect(parse(ok(huge))).toBeNull();
  });

  it("refuses wrong primitives instead of coercing them", () => {
    const e1 = entries();
    (e1[0].latestAttempt as Record<string, unknown>).outcome = 123;
    const e2 = entries();
    (e2[0].workOrder as Record<string, unknown>).risk = "low";
    const e3 = entries();
    (e3[0].workOrder as Record<string, unknown>).revision = "3";
    const e4 = entries();
    e4[0].briefMarkdown = undefined;
    for (const bad of [e1, e2, e3, e4]) {
      expect(parse(ok(bad))).toBeNull();
    }
  });
});

describe("readExactRecord", () => {
  it("refuses objects with a non-plain prototype", () => {
    class Custom { code = "OK"; }
    expect(readExactRecord(new Custom(), ["code"], [])).toBeNull();
    expect(readExactRecord(Object.create({ code: "OK" }), [], ["code"])).toBeNull();
    expect(readExactRecord({ code: "OK" }, ["code"], [])).toEqual({ code: "OK" });
  });
});

describe("readEnvelopeCode", () => {
  it("reads the code of an envelope with an optional result and nothing else", () => {
    expect(readEnvelopeCode({ code: "INTERNAL_ERROR" }, types.isProxy)).toBe("INTERNAL_ERROR");
    expect(readEnvelopeCode({ code: "INTERNAL_ERROR", result: null }, types.isProxy)).toBe("INTERNAL_ERROR");
    expect(readEnvelopeCode({ code: "INTERNAL_ERROR", extra: true }, types.isProxy)).toBeNull();
    expect(readEnvelopeCode({ code: "" }, types.isProxy)).toBeNull();
    expect(readEnvelopeCode({ code: 5 }, types.isProxy)).toBeNull();
    expect(readEnvelopeCode(null, types.isProxy)).toBeNull();
  });
});

describe("selectWorkOrderEntry and formatBriefDigest", () => {
  const list = WORK_ORDER_BRIEF_LIST_FIXTURE.entries;
  it("selects by id, else the first entry, else null", () => {
    expect(selectWorkOrderEntry(list, "wo-0145")?.workOrder.id).toBe("wo-0145");
    expect(selectWorkOrderEntry(list, "missing")?.workOrder.id).toBe("wo-0144");
    expect(selectWorkOrderEntry(list)?.workOrder.id).toBe("wo-0144");
    expect(selectWorkOrderEntry([], "wo-0144")).toBeNull();
  });

  it("formatBriefDigest renders null as not recorded", () => {
    expect(formatBriefDigest(null)).toBe("not recorded");
    expect(formatBriefDigest("   ")).toBe("not recorded");
    expect(formatBriefDigest("abc123")).toBe("abc123");
  });
});
