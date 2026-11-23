/**
 * Source-text assertions for the four attempt card components, in the style
 * of `../attempt-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS_DIR = join(import.meta.dirname, "..");

const readComponent = (file: string): string =>
  readFileSync(join(COMPONENTS_DIR, file), "utf8");

describe("attempt card components source contracts", () => {
  const header = readComponent("attempt-header.tsx");
  const receipts = readComponent("receipts-card.tsx");
  const worktree = readComponent("worktree-card.tsx");
  const sidebar = readComponent("work-order-sidebar.tsx");

  it("reads non-empty source for all four attempt card components", () => {
    for (const [file, source] of [
      ["attempt-header.tsx", header],
      ["receipts-card.tsx", receipts],
      ["worktree-card.tsx", worktree],
      ["work-order-sidebar.tsx", sidebar],
    ] as const) {
      expect(source, file).toBeTruthy();
      expect(source.length, file).toBeGreaterThan(0);
    }
    // Cost bound: O(N) file reads on 4 fixed small files (< 100 lines each).
  });

  it("forbids unconfirmed domain action controls and network/HTML sinks across all four components", () => {
    const all = [header, receipts, worktree, sidebar].join("\n");
    expect(all).not.toContain("AlertBox");
    expect(all).not.toContain("onConfirm");
    expect(all).not.toContain("<Button");
    expect(all).not.toContain("fetch(");
    expect(all).not.toContain("dangerouslySetInnerHTML");
    for (const [file, source] of [
      ["receipts-card.tsx", receipts],
      ["worktree-card.tsx", worktree],
      ["work-order-sidebar.tsx", sidebar],
    ] as const) {
      expect(source, file).not.toContain("<button");
      expect(source, file).not.toContain("onClick");
    }
    // Cost bound: O(total source bytes) linear substring checks.
  });

  it("pins attempt-header copy button and status/metadata labels", () => {
    expect(header).toContain("<button");
    expect(header).toContain('type="button"');
    expect(header).toContain('data-action="copy"');
    expect(header).toContain("title={`copy ${attempt.id}`}");
    expect(header).toContain("first attempt");
    expect(header).toContain("work order");
    expect(header).toContain("session");
    expect(header).toContain("none yet");
    expect(header).toContain("port");
    expect(header).toContain("slot");
    expect(header).toContain("queue");
    expect(header).toContain("waiting");
    expect(header).toContain("slot released");
    expect(header).toContain("fix of");
  });

  it("pins receipts-card header, route chip, slot names, and awaited labels", () => {
    expect(receipts).toContain('title="Receipts"');
    expect(receipts).toContain("GET /v1/heads/:sha/evidence");
    for (const slot of [
      "completion",
      "verification",
      "review",
      "acceptance",
      "merge",
    ] as const) {
      expect(receipts).toContain(slot);
    }
    expect(receipts).toContain("awaited");
    expect(receipts).toContain("no completion receipt yet");
    expect(receipts).toContain("the verification host has not spoken");
    expect(receipts).toContain("the reviewer seat has not spoken");
    expect(receipts).toContain("no acceptance binds this head yet");
    expect(receipts).toContain("not merged");
  });

  it("pins worktree-card header, key-value terms, empty fallback, and stale banner", () => {
    expect(worktree).toContain('title="Worktree inspection"');
    for (const term of [
      "checked out",
      "uncommitted",
      "untracked",
      "residue",
      "expected artifacts",
      "none",
    ] as const) {
      expect(worktree).toContain(term);
    }
    expect(worktree).toContain("This inspection is stale");
  });

  it("pins work-order-sidebar header, key-value terms, sibling labels, and cost fallback", () => {
    expect(sidebar).toContain('title="Work order"');
    for (const term of [
      "project",
      "task",
      "lane",
      "base commit",
      "policy revision",
    ] as const) {
      expect(sidebar).toContain(term);
    }
    expect(sidebar).toContain("Attempts on this order");
    expect(sidebar).toContain('data-action="open"');
    expect(sidebar).toContain("first");
    expect(sidebar).toContain("not started · no cost yet");
  });
});
