/**
 * Source-text assertions for the Lanes client component.
 *
 * Rendering the TSX under vitest needs a JSX/test transform configuration the
 * workspace does not provide (and this lane may not add), so the same
 * contracts are pinned against the component sources, in the style of
 * `scroll-containment.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LANES_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(LANES_DIR, ...parts), "utf8");

describe("LanesClient live-source wiring", () => {
  const client = read("lanes-client.tsx");
  const row = read("components", "lane-row.tsx");
  const capacity = read("components", "capacity-card.tsx");
  const kpi = read("components", "lanes-kpi-row.tsx");
  const attention = read("components", "attention-card.tsx");
  const refresh = read("use-auto-refresh.ts");

  it("labels live API rows and opens the attempt view for every row with an id", () => {
    expect(client).toContain("live · GET /v1/attempts");
    expect(client).not.toContain('import { attempts');
    expect(row).toMatch(
      /import\s*\{[^}]*\bliveViewHref\b[^}]*\}\s*from\s*"\.\.\/derive"/,
    );
    expect(row).toContain("liveViewHref(attempt)");
    expect(row).not.toContain("href={attemptHref(");
    expect(row).toContain("no live view");
    expect(row).toContain('aria-disabled="true"');
    expect(row).toContain("no attempt id recorded");
    expect(row).not.toContain("the attempt view does not read the API yet");
    expect(row).toContain("observedLine(attempt, note)");
    expect(capacity).toMatch(
      /import\s*\{[^}]*\bliveViewHref\b[^}]*\}\s*from\s*"\.\.\/derive"/,
    );
    expect(capacity).toContain("liveViewHref(a)");
    expect(capacity).not.toContain("href={attemptHref(");
    expect(capacity).toContain("no attempt id recorded");
  });

  it("reports that the API does not serve the slot budget", () => {
    expect(capacity).toContain("slot budget not served");
    expect(capacity).toContain('a.slot ?? "unrecorded"');
    expect(capacity).toContain("a.queueBound !== null");
    expect(kpi).toContain("slot budget not served by the API");
  });

  it("labels recorded rows without a slot", () => {
    // The wording itself is pinned by derive.test.ts (unknownAttention).
    expect(attention).toContain("unknownAttention(a, note)");
  });

  it("refreshes only the visible live source on a schedule", () => {
    expect(refresh).toContain("30_000");
    expect(refresh).toContain(
      "shouldRefresh(source, fallbackReason, document.visibilityState)",
    );
    expect(refresh).toContain("router.refresh()");
    expect(refresh).toContain("[source, fallbackReason, intervalMs, router]");
  });
});

describe("LanesClient fixture fallback wiring", () => {
  const client = read("lanes-client.tsx");
  const row = read("components", "lane-row.tsx");

  it("labels the fixture fallback with its reason", () => {
    expect(client).toContain('fixture · {data.fallbackReason}');
    expect(client).toContain('variant="gap"');
    expect(client).toContain("Sample data, not this station");
  });

  it("keeps the Open link for fixture rows", () => {
    expect(row).toContain("<Link className={styles.openLink} href={href}>");
    expect(row).toContain("Open");
  });
});
