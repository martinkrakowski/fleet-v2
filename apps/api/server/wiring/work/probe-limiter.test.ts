import { describe, expect, it } from "vitest";

import { ProbeLimiter } from "./probe-limiter";

describe("ProbeLimiter", () => {
  it("refuses a second call for the same id while the first is pending", async () => {
    const limiter = new ProbeLimiter();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });

    const first = limiter.run("proj-a", () => gate);
    const second = await limiter.run("proj-a", () => Promise.resolve("second"));

    expect(second).toEqual({ ok: false, reason: "busy-project" });
    release("first");
    await expect(first).resolves.toEqual({ ok: true, value: "first" });
  });

  it("refuses a third distinct id when two are in flight", async () => {
    const limiter = new ProbeLimiter();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const a = limiter.run("proj-a", () => gateA);
    const b = limiter.run("proj-b", () => gateB);
    const c = await limiter.run("proj-c", () => Promise.resolve("c"));

    expect(c).toEqual({ ok: false, reason: "busy-global" });
    releaseA();
    releaseB();
    await Promise.all([a, b]);
  });

  it("frees the global slot after a run resolves", async () => {
    const limiter = new ProbeLimiter();
    let releaseA!: (value: string) => void;
    let releaseB!: (value: string) => void;
    const gateA = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<string>((resolve) => {
      releaseB = resolve;
    });

    const a = limiter.run("proj-a", () => gateA);
    const b = limiter.run("proj-b", () => gateB);
    const c = await limiter.run("proj-c", () => Promise.resolve("c"));
    expect(c).toEqual({ ok: false, reason: "busy-global" });

    releaseA("a");
    await expect(a).resolves.toEqual({ ok: true, value: "a" });

    const c2 = await limiter.run("proj-c", () => Promise.resolve("c2"));
    expect(c2).toEqual({ ok: true, value: "c2" });

    releaseB("b");
    await expect(b).resolves.toEqual({ ok: true, value: "b" });
  });

  it("frees the global slot after a run rejects", async () => {
    const limiter = new ProbeLimiter();
    let rejectA!: (error: Error) => void;
    let rejectB!: (error: Error) => void;
    const gateA = new Promise<string>((_, reject) => {
      rejectA = reject;
    });
    const gateB = new Promise<string>((_, reject) => {
      rejectB = reject;
    });

    const a = limiter.run("proj-a", () => gateA);
    const b = limiter.run("proj-b", () => gateB);
    const c = await limiter.run("proj-c", () => Promise.resolve("c"));
    expect(c).toEqual({ ok: false, reason: "busy-global" });

    rejectA(new Error("boom"));
    await expect(a).rejects.toThrow("boom");

    const c2 = await limiter.run("proj-c", () => Promise.resolve("c2"));
    expect(c2).toEqual({ ok: true, value: "c2" });

    rejectB(new Error("bang"));
    await expect(b).rejects.toThrow("bang");
  });

  it("propagates a task error and frees the per-project slot", async () => {
    const limiter = new ProbeLimiter();

    const result = limiter.run("proj-a", () =>
      Promise.reject(new Error("boom")),
    );
    await expect(result).rejects.toThrow("boom");

    const next = await limiter.run("proj-a", () => Promise.resolve("ok"));
    expect(next).toEqual({ ok: true, value: "ok" });
  });

  it("honours a custom concurrency cap", async () => {
    const limiter = new ProbeLimiter(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const a = limiter.run("proj-a", () => gate);
    const b = await limiter.run("proj-b", () => Promise.resolve("b"));
    expect(b).toEqual({ ok: false, reason: "busy-global" });

    release();
    await a;
  });
});
