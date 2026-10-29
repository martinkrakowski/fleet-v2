/**
 * Source-text assertions for the mobile sidebar backdrop's semantics, in the
 * style of `view-nav-source.test.ts`. There is no DOM testing library; the
 * web suite reads component source as text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_DIR = join(import.meta.dirname);

const read = (base: string, ...parts: string[]) =>
  readFileSync(join(base, ...parts), "utf8");

/** The `sidebar-backdrop` element's JSX opening tag, as written in source. */
function backdropTag(sidebar: string): string {
  const start = sidebar.indexOf('className="sidebar-backdrop"');
  const end = sidebar.indexOf("/>", start);
  return start >= 0 && end > start ? sidebar.slice(start, end) : "";
}

describe("Sidebar backdrop", () => {
  const sidebar = read(SHELL_DIR, "sidebar.tsx");

  it("gives the backdrop a presentation role and a keyboard path", () => {
    const backdrop = backdropTag(sidebar);
    expect(backdrop).toContain('role="presentation"');
    expect(backdrop).toContain("onClick={closeDrawer}");
    expect(backdrop).toContain(
      'onKeyDown={(event) => { if (event.key === "Escape") closeDrawer(); }}',
    );
  });
});
