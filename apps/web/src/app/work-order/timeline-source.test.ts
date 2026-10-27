/**
 * Source-text assertions for the work-order timeline page, in the style of
 * `app/attempt/journal-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORK_ORDER_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(WORK_ORDER_DIR, ...parts), "utf8");

describe("work-order timeline wiring", () => {
  const page = read("page.tsx");
  const live = read("live.ts");
  const view = read("timeline-view.ts");
  const timeline = read("components", "work-order-timeline.tsx");
  const card = read("../attempt/components/live-work-order-card.tsx");

  it("is a force-dynamic server page without client hooks", () => {
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).not.toContain('"use client"');
    expect(live).not.toContain('"use client"');
    expect(timeline).not.toContain('"use client"');
    expect(timeline).not.toContain("useState");
    expect(timeline).not.toContain("useEffect");
    expect(timeline).not.toContain("use-auto-refresh");
  });

  it("batches journal reads on the server", () => {
    expect(live).toContain("Promise.all(");
    expect(live).toContain("readJournalPanel(");
    expect(live).toContain(
      'import { NOT_CONFIGURED_REASON } from "../attempt/live";',
    );
  });

  it("keeps timeline-view pure with type-only imports", () => {
    const imports = view.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line.startsWith("import type")).toBe(true);
    }
  });

  it("renders recorded facts plainly with no unsafe or client behaviour", () => {
    expect(timeline).toContain("<time");
    expect(timeline).toContain(
      'aria-label="Attempts in fix-chain order, first pass first"',
    );
    expect(timeline).toContain("LiveJournalPanel");
    expect(timeline).toContain("head evidence: not read on this page");
    expect(timeline).not.toContain("dangerouslySetInnerHTML");
    expect(timeline).not.toContain("AlertBox");
    expect(timeline).not.toContain("onConfirm");
    expect(timeline).not.toContain("fetch(");
    expect(timeline).not.toContain("aria-live");
    expect(timeline).not.toContain("target=");
    expect(timeline).not.toContain("http");
    expect(timeline).not.toContain("hostName");
    expect(timeline).not.toContain("worktreePath");
    expect(timeline).not.toContain("data-contained-scroll");
    expect(timeline).not.toContain("passed");
  });

  it("links the attempt page's work-order card to the timeline", () => {
    expect(card).toContain("workOrderHref(panel.workOrder.id)");
  });
});
