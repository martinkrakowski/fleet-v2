import { describe, expect, it } from "vitest";
import { WORK_ORDER_BRIEF_LIST_FIXTURE } from "./fixture";
import { briefDataFromEnvelope, loadBriefData } from "./live";

const SHAPE = "api boundary returned an unexpected work-orders shape";
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("loadBriefData", () => {
  it("loadBriefData returns not-configured until A-WO is wired", async () => {
    await expect(loadBriefData()).resolves.toEqual({
      view: "not-configured",
      reason: "GET /v1/work-orders is not served yet",
    });
    await expect(loadBriefData("wo-0144")).resolves.toMatchObject({ view: "not-configured" });
  });
});

describe("briefDataFromEnvelope", () => {
  it("lists the fixture and selects by id", () => {
    const env = { code: "OK", result: clone(WORK_ORDER_BRIEF_LIST_FIXTURE) };
    const data = briefDataFromEnvelope(env, "wo-0145");
    expect(data).toMatchObject({ view: "listed", selectedId: "wo-0145" });
    expect(briefDataFromEnvelope(env)).toMatchObject({ selectedId: "wo-0144" });
  });

  it("briefDataFromEnvelope returns empty for an empty entries list", () => {
    expect(briefDataFromEnvelope({ code: "OK", result: { entries: [] } })).toEqual({ view: "empty" });
  });

  it("briefDataFromEnvelope returns error with code on non-OK envelope", () => {
    const reason = "api boundary answered INTERNAL_ERROR for /v1/work-orders";
    expect(briefDataFromEnvelope({ code: "INTERNAL_ERROR" })).toEqual({ view: "error", reason });
    expect(briefDataFromEnvelope({ code: "INTERNAL_ERROR", result: null })).toEqual({ view: "error", reason });
  });

  it("briefDataFromEnvelope refuses non-OK envelopes with extra keys", () => {
    expect(briefDataFromEnvelope({ code: "INTERNAL_ERROR", extra: true })).toEqual({ view: "error", reason: SHAPE });
  });

  it("briefDataFromEnvelope returns error on malformed envelope", () => {
    for (const value of [null, undefined, 3, "x", [], {}, { code: "OK" }, { code: "OK", result: { nope: 1 } }]) {
      expect(briefDataFromEnvelope(value)).toEqual({ view: "error", reason: SHAPE });
    }
  });

  it("briefDataFromEnvelope refuses Proxy envelopes without throwing", () => {
    let trapped = 0;
    const handler: ProxyHandler<object> = {
      get() { trapped += 1; return undefined; },
      ownKeys() { trapped += 1; return []; },
      getPrototypeOf() { trapped += 1; return null; },
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(briefDataFromEnvelope(new Proxy({ code: "OK" }, handler))).toEqual({ view: "error", reason: SHAPE });
    expect(briefDataFromEnvelope(revoked.proxy)).toEqual({ view: "error", reason: SHAPE });
    expect(trapped).toBe(0);
  });

  it("briefDataFromEnvelope refuses malformed nested outcome objects", () => {
    const first = clone(WORK_ORDER_BRIEF_LIST_FIXTURE.entries[0]);
    const bad = [
      { code: "OK", result: null },
      { code: "OK", result: { entries: [{ ...first, latestAttempt: { ...first.latestAttempt, outcome: 123 } }] } },
      { code: "OK", result: { entries: [{ workOrder: { id: 42 }, latestAttempt: null, briefMarkdown: null }] } },
    ];
    for (const env of bad) {
      expect(briefDataFromEnvelope(env)).toEqual({ view: "error", reason: SHAPE });
    }
  });
});
