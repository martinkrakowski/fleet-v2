// Lane K5b tests: the triage batching and state builder. Pure, no network:
// the kernel's state builder runs in-process and the secret scan is the
// shared one. Covers plan §5's batching rules — as few batches as the 32 KiB
// total cap allows, a secret-shaped claim never sent, a single claim over
// 8 KiB left out entirely (no flag, still a candidate), never truncated.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildTriageBatches,
  triageContextRef,
  MAX_TRIAGE_FIELD_BYTES,
  MAX_TRIAGE_TOTAL_BYTES,
} from "../claim-triage-state.js";

/** UTF-8 byte length. */
function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

const PREFIXES = ["src/utils"];

/** Verify one batch against the kernel's own caps, independently. */
function expectStateWithinCaps(
  batchStateJson: string,
  batchCount: number,
): void {
  const parsed = JSON.parse(batchStateJson) as Record<string, unknown>;
  const claims = parsed.claims as Record<string, string>;
  const prefixes = parsed.pathPrefixes as string[];
  let total = bytes(JSON.stringify(prefixes));
  for (const claim of Object.values(claims)) {
    expect(bytes(claim)).toBeLessThanOrEqual(MAX_TRIAGE_FIELD_BYTES);
    total += bytes(claim);
  }
  expect(total).toBeLessThanOrEqual(MAX_TRIAGE_TOTAL_BYTES);
  expect(Object.keys(claims).length).toBe(batchCount);
  for (const text of Object.values(claims)) {
    expect(
      createHash("sha256").update(text, "utf8").digest("hex"),
    ).toBeDefined();
  }
}

describe("buildTriageBatches", () => {
  it("produces one batch for small claims and keeps keys k0..kn mapped back", () => {
    const built = buildTriageBatches(PREFIXES, [
      { id: "entry-a", claimText: "Date strings are parsed with parseISO." },
      { id: "entry-b", claimText: "The gate must pass before pushing." },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.batches.length).toBe(1);
    expect(built.excludedIds).toEqual([]);
    const only = built.batches[0];
    expectStateWithinCaps(only.stateJson, 2);
    const parsed = JSON.parse(only.stateJson) as {
      claims: Record<string, string>;
      pathPrefixes: string[];
    };
    expect(Object.keys(parsed.claims)).toEqual(["k0", "k1"]);
    expect(parsed.claims.k0).toBe("Date strings are parsed with parseISO.");
    expect(only.idsByKey).toEqual({ k0: "entry-a", k1: "entry-b" });
    expect(parsed.pathPrefixes).toEqual(["src/utils"]);
    expect(only.keys).toEqual(["k0", "k1"]);
    // 64 hex characters: the kernel's state hash.
    expect(only.stateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("groups candidates into as few batches as the 32 KiB cap allows", () => {
    // 200 claims of ~200 bytes ≈ 40 KiB total → 2 batches under the cap.
    const claims = Array.from({ length: 200 }, (_, index) => ({
      id: `entry-${index}`,
      claimText:
        `Claim number ${index} of two hundred, padded to about two hundred bytes of reusable lesson text for the batch cap.`.padEnd(
          200,
          "x",
        ),
    }));
    const built = buildTriageBatches(PREFIXES, claims);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.batches.length).toBe(2);
    const packed = built.batches
      .flatMap((batch) => batch.candidates.length)
      .reduce((a, b) => a + b, 0);
    expect(packed).toBe(200);
    for (const batch of built.batches) {
      expectStateWithinCaps(batch.stateJson, batch.candidates.length);
    }
    // Every candidate id appears exactly once across the batches.
    const ids = built.batches.flatMap((batch) =>
      batch.candidates.map((c) => c.id),
    );
    expect(new Set(ids).size).toBe(200);
  });

  it("never sends a secret-shaped claim and gives it no flag", () => {
    const built = buildTriageBatches(PREFIXES, [
      { id: "entry-a", claimText: "Date strings are parsed with parseISO." },
      {
        id: "entry-secret",
        claimText:
          "The token is sk-abcdefghijklmnopqrstuvwx and must not leave.",
      },
      { id: "entry-c", claimText: "The gate must pass before pushing." },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.excludedIds).toEqual(["entry-secret"]);
    const sent = built.batches[0].candidates.map((c) => c.id);
    expect(sent).toEqual(["entry-a", "entry-c"]);
    expectStateWithinCaps(built.batches[0].stateJson, 2);
  });

  it("leaves a single claim over 8 KiB out of triage entirely, never truncated", () => {
    const oversized = "a".repeat(MAX_TRIAGE_FIELD_BYTES + 1);
    const built = buildTriageBatches(PREFIXES, [
      { id: "entry-big", claimText: oversized },
      { id: "entry-small", claimText: "Small enough." },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.excludedIds).toEqual(["entry-big"]);
    expect(built.batches.length).toBe(1);
    const parsed = JSON.parse(built.batches[0].stateJson) as {
      claims: Record<string, string>;
    };
    expect(Object.keys(parsed.claims)).toEqual(["k0"]);
    expect(parsed.claims.k0).toBe("Small enough.");
  });

  it("answers nothing when no claim is usable but the prefixes are clean", () => {
    const built = buildTriageBatches(PREFIXES, [
      {
        id: "entry-secret",
        claimText:
          "The token is sk-abcdefghijklmnopqrstuvwx and must not leave.",
      },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.batches).toEqual([]);
    expect(built.excludedIds).toEqual(["entry-secret"]);
  });

  it("refuses when the declared pathPrefixes themselves fail the kernel", () => {
    const built = buildTriageBatches(
      ["src/utils", "The token is sk-abcdefghijklmnopqrstuvwx"],
      [{ id: "entry-a", claimText: "A plain claim." }],
    );
    expect(built).toEqual({ ok: false, reason: "redaction-refused" });
  });
});

describe("triageContextRef", () => {
  it("is the fixed triage reference for a plain attempt id", () => {
    expect(triageContextRef("attempt-42")).toBe("triage:attempt-42");
    expect(triageContextRef("attempt-42")).toBe(triageContextRef("attempt-42"));
  });

  it("digests an oversized or credential-shaped attempt id deterministically", () => {
    for (const attemptId of [
      "a".repeat(200),
      "id with spaces",
      "The token is sk-abcdefghijklmnopqrstuvwx",
    ]) {
      const ref = triageContextRef(attemptId);
      expect(ref).toMatch(/^triage:[0-9a-f]{16}$/);
      expect(triageContextRef(attemptId)).toBe(ref);
    }
  });

  it("reads a blank attempt id as unscoped, like the ranking lane", () => {
    expect(triageContextRef("")).toBe("triage:unscoped");
    expect(triageContextRef("   ")).toBe("triage:unscoped");
  });
});
