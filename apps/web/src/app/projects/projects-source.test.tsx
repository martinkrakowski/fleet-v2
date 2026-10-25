/**
 * Source-text assertions for the Projects server pages and client components.
 *
 * Rendering the TSX under vitest needs a JSX/test transform configuration the
 * workspace does not provide (and this lane may not add), so the same
 * contracts are pinned against the component sources, in the style of
 * `lanes-client.test.tsx`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECTS_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(PROJECTS_DIR, ...parts), "utf8");

describe("Projects pages are dynamic server pages", () => {
  it("/projects is force-dynamic and not a client component", () => {
    const page = read("page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).not.toContain('"use client"');
  });

  it("/projects/[id] is force-dynamic and not a client component", () => {
    const page = read("[id]", "page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).not.toContain('"use client"');
  });
});

describe("ProjectsClient live-source wiring", () => {
  const client = read("projects-client.tsx");

  it("labels live API rows and the fixture fallback chip", () => {
    expect(client).toContain("live · GET /v1/projects");
    expect(client).toContain("fixture · {data.fallbackReason}");
    expect(client).toContain('variant="gap"');
    expect(client).toContain("Sample data, not this station");
    expect(client).toContain("refreshes every 30 s");
  });
});

describe("ProjectDetailClient live-source wiring", () => {
  const detail = read("[id]", "project-detail-client.tsx");

  it("labels live API rows and the fixture fallback chip", () => {
    expect(detail).toContain("live · GET /v1/projects/");
    expect(detail).toContain("fixture · {data.fallbackReason}");
    expect(detail).toContain('variant="gap"');
    expect(detail).toContain("Sample data, not this station");
    expect(detail).toContain("refreshes every 30 s");
  });

  it("lists CLI commands for probe, edit and retire with the web-write note", () => {
    expect(detail).toContain("fleet-v2 projects probe");
    expect(detail).toContain("fleet-v2 projects edit");
    expect(detail).toContain("fleet-v2 projects retire");
    expect(detail).toMatch(
      /Writes from the web arrive with the web write path; use the CLI\s+meanwhile\./,
    );
  });

  it("names the not-registered state with add and adopt", () => {
    expect(detail).toContain("not registered");
    expect(detail).toContain("fleet-v2 projects add");
    expect(detail).toContain("fleet-v2 projects adopt");
  });

  it("contains no fetch call and no method write call", () => {
    expect(detail).not.toMatch(/fetch\(/);
    expect(detail).not.toMatch(/method:/);
  });
});
