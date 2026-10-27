/**
 * Source-text assertions for the W10 seat/model/usage chips and per-work-order
 * usage sums, in the style of `lanes-client.test.tsx` and
 * `work-order/timeline-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LANES_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(LANES_DIR, ...parts), "utf8");

describe("W10 usage chips source wiring", () => {
  const row = read("components", "lane-row.tsx");
  const view = read("../../lib/usage-view.ts");
  const timeline = read("../work-order/components/work-order-timeline.tsx");

  it("shows the three chips and the work-order sum on recorded lane rows", () => {
    expect(row).toContain("seatChipText(");
    expect(row).toContain("modelChipText(");
    expect(row).toContain("usageChip(");
    expect(row).toContain("usageSumText(");
    expect(row).toContain("workOrderHref(attempt.wo)");
    expect(row).toContain('attempt.basis === "recorded"');
    expect(row).not.toContain("dangerouslySetInnerHTML");
    expect(row).not.toContain("fetch(");
    expect(row).not.toContain("AlertBox");
    expect(row).not.toContain("target=");
    expect(row).not.toContain("http");
  });

  it("keeps the usage view pure with type-only imports and exact wording", () => {
    const imports = view.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line.startsWith("import type")).toBe(true);
    }
    expect(view).toContain('"plan, not spend"');
    expect(view).toContain('"not measured"');
    expect(view).not.toContain("?? 0");
    expect(view).not.toContain("|| 0");
  });

  it("adds the same chips to each work-order timeline attempt without making it a client component", () => {
    expect(timeline).toContain("usageSumText(");
    expect(timeline).not.toContain('"use client"');
  });
});
