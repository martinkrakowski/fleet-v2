/**
 * Source-text assertions for the proposal table card's kind mapping, in the
 * style of `view-nav-source.test.ts`. There is no DOM testing library; the
 * web suite reads component source as text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS_DIR = join(import.meta.dirname);

const read = (base: string, ...parts: string[]) =>
  readFileSync(join(base, ...parts), "utf8");

describe("Proposal table card kind mapping", () => {
  const source = read(COMPONENTS_DIR, "proposal-table-card.tsx");

  it("does not repeat the candidate branch", () => {
    expect(source).not.toContain(': "candidate" : "candidate"');
  });

  it("maps keeper to keeper and everything else to candidate", () => {
    expect(source).toContain('kind === "keeper" ? "keeper" : "candidate"');
  });
});
