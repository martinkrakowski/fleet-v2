/**
 * Source-text assertions for the work-order head evidence panel, in the style
 * of `timeline-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORK_ORDER_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(WORK_ORDER_DIR, ...parts), "utf8");

describe("work-order head evidence wiring", () => {
  const panel = read("components", "head-evidence-panel.tsx");
  const map = read("map-evidence.ts");
  const live = read("live.ts");

  it("renders evidence as plain text with no unsafe or client behaviour", () => {
    expect(panel).toContain("<time");
    expect(panel).toContain("tallyText(");
    expect(panel).toContain("kindText(");
    expect(panel).not.toContain("dangerouslySetInnerHTML");
    expect(panel).not.toContain("AlertBox");
    expect(panel).not.toContain("onConfirm");
    expect(panel).not.toContain("fetch(");
    expect(panel).not.toContain("aria-live");
    expect(panel).not.toContain("href=");
    expect(panel).not.toContain("hostId");
    expect(panel).not.toContain("evidenceRef");
    expect(panel).not.toContain("filePath");
    expect(panel).not.toContain('"use client"');
    expect(panel).not.toContain("passed");
  });

  it("maps evidence without carrying provenance or location fields", () => {
    expect(map).not.toContain("filePath:");
    expect(map).not.toContain("hostId:");
    expect(map).not.toContain("evidenceRef:");
    expect(map).toContain("reviewTally");
  });

  it("batches evidence reads beside the journals on the server", () => {
    expect(live).toContain("Promise.all(");
    expect(live).toContain("readEvidencePanel(");
  });
});
