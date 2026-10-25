/**
 * Source-text assertions for the sidebar project nav wiring.
 *
 * Rendering the TSX under vitest needs a JSX/test transform configuration the
 * workspace does not provide (and this lane may not add), so the same
 * contracts are pinned against the component sources, in the style of
 * `lanes-client.test.tsx`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHELL_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(SHELL_DIR, ...parts), "utf8");

/** Full import statements, one per match, including multiline ones. */
function importStatements(source: string): string[] {
  const re = /import\s+(?:type\s+)?[\s\S]*?from\s*["'][^"']+["']\s*;?/g;
  return source.match(re) ?? [];
}

/** Import statements that reference a specific module specifier. */
function importStatementsFor(source: string, moduleSpecifier: string): string[] {
  return importStatements(source).filter(
    (statement) =>
      statement.includes(`from "${moduleSpecifier}"`) ||
      statement.includes(`from '${moduleSpecifier}'`),
  );
}

describe("ProjectNav is fed by the server layout and stays client-bound", () => {
  const nav = read("project-nav.tsx");
  const sidebar = read("sidebar.tsx");
  const layout = read("..", "app", "layout.tsx");

  it("keeps project-nav a client component that renders from its data prop", () => {
    expect(nav).toContain('"use client"');
    expect(nav).toContain("export function ProjectNav({ data }");
    expect(nav).toContain("{ data: ProjectNavData }");
    expect(nav).toContain('className="sidebar-link-label"');
    expect(nav).toContain('className="sidebar-badge"');
  });

  it("links the URL filter to the project id and keeps All", () => {
    expect(nav).toContain('params.set("project", name)');
    expect(nav).toContain('params.delete("project")');
    expect(nav).toContain("choose(entry.projectId)");
    expect(nav).toContain('<span className="sidebar-link-label">All</span>');
  });

  it("renders the display name and the id as title", () => {
    expect(nav).toContain("title={entry.projectId}");
    expect(nav).toContain("{entry.label}");
  });

  it("renders no badge when a count is null", () => {
    expect(nav).toMatch(/entry\.attempts !== null/);
    expect(nav).toMatch(/data\.totalAttempts !== null/);
  });

  it("labels fixture fallback sections as sample with the reason as title", () => {
    expect(nav).toContain("Projects · sample");
    expect(nav).toContain("title={fallback ? (data.fallbackReason");
  });

  it("never imports a loader or the api client at runtime (type imports only)", () => {
    for (const mod of ["./project-nav-data", "../../lib/api-client", "./live"]) {
      for (const statement of importStatementsFor(nav, mod)) {
        expect(statement.trimStart()).toMatch(/^import\s+type\b/);
      }
    }
    expect(nav).toMatch(
      /import\s+type\s+\{[^}]*ProjectNavData[^}]*\}\s+from\s+"\.\/project-nav-data"/,
    );
  });

  it("imports the nav data type in the sidebar as a type only", () => {
    expect(sidebar).toMatch(
      /import\s+type\s+\{[^}]*ProjectNavData[^}]*\}\s+from\s+"\.\/project-nav-data"/,
    );
  });

  it("the layout is async, force-dynamic and passes nav to the sidebar", () => {
    expect(layout).toContain('export const dynamic = "force-dynamic"');
    expect(layout).toContain("export default async function RootLayout");
    expect(layout).toContain("loadProjectNav()");
    expect(layout).toContain("<Sidebar nav={nav} />");
  });
});
