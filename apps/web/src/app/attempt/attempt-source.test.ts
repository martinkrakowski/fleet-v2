/**
 * Source-text assertions for the live attempt page, in the style of
 * `lanes/lanes-client.test.tsx`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ATTEMPT_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(ATTEMPT_DIR, ...parts), "utf8");

describe("AttemptPage live-source wiring", () => {
  const page = read("page.tsx");
  const client = read("attempt-client.tsx");
  const record = read("components", "live-attempt-record.tsx");
  const operations = read("components", "live-operations-card.tsx");
  const refresh = read("../lanes/use-auto-refresh.ts");

  it("is a dynamic server page that loads the live attempt", () => {
    expect(page).toContain('export const dynamic = "force-dynamic";');
    expect(page).toContain("loadAttemptPage(");
    expect(page).not.toContain("Suspense");
  });

  it("keeps the loader's values out of the client bundle", () => {
    expect(client).not.toMatch(/^import\s+(?!type)[^;]*from\s+"\.\/live"/m);
    expect(client).toContain(
      "useAutoRefresh(data.source, data.fallbackReason, ATTEMPT_REFRESH_MS)",
    );
    expect(client).not.toContain("useSearchParams");
  });

  it("labels the sample and unknown banners", () => {
    expect(client).toContain("Sample data, not this station");
    expect(client).toContain("Recorded host cannot be resolved: holds its slot");
  });

  it("keeps one live region and no mutating paths", () => {
    const all = [client, record, operations].join("\n");
    expect(all.match(/aria-live=/g)).toHaveLength(1);
    expect(operations).toContain('aria-disabled="true"');
    expect(operations).toContain("disabled=");
    expect(all).not.toContain("AlertBox");
    expect(all).not.toContain("onConfirm");
    expect(all).not.toContain("fetch(");
    expect(all).not.toContain("dangerouslySetInnerHTML");
    expect(all).not.toContain("remotePort");
    expect(all).not.toContain("hostName");
  });

  it("moves the attempt page to a 10-second visible-tab poll", () => {
    expect(refresh).toContain("ATTEMPT_REFRESH_MS = 10_000");
    expect(refresh).toContain("intervalMs = 30_000");
  });
});
