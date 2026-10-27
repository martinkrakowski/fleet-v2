/**
 * Source-text assertions for the work-order sidebar (W1b), in the style of
 * `attempt-source.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ATTEMPT_DIR = join(import.meta.dirname);

const read = (...parts: string[]) =>
  readFileSync(join(ATTEMPT_DIR, ...parts), "utf8");

describe("work-order sidebar wiring", () => {
  const page = read("page.tsx");
  const client = read("attempt-client.tsx");
  const context = read("live-context.ts");
  const card = read("components", "live-work-order-card.tsx");
  const record = read("components", "live-attempt-record.tsx");
  const operations = read("components", "live-operations-card.tsx");

  it("loads the work-order context server side and passes it to the client", () => {
    expect(page).toContain("loadAttemptContext(data)");
    expect(page).toContain("context={context}");
  });

  it("keeps the loader out of the client bundle and drops the placeholder", () => {
    expect(client).not.toMatch(
      /^import\s+(?!type)[^;]*from\s+"\.\/live-context"/m,
    );
    expect(client).not.toContain(
      "The work order's details are not read on this page yet.",
    );
  });

  it("keeps live-context.ts server-only", () => {
    expect(context).not.toContain('"use client"');
    expect(context).not.toContain("use-auto-refresh");
    expect(context).not.toContain("attempt-client");
  });

  it("keeps one live region and no mutating paths across the sidebar", () => {
    const all = [client, record, operations, card].join("\n");
    expect(all.match(/aria-live=/g)).toHaveLength(1);
    expect(all).not.toContain("AlertBox");
    expect(all).not.toContain("onConfirm");
    expect(all).not.toContain("fetch(");
    expect(all).not.toContain("dangerouslySetInnerHTML");
    expect(all).not.toContain("hostName");
    expect(all).not.toContain("sshAlias");
    expect(all).not.toContain("worktreePath");
    expect(all).not.toContain("repository");
  });

  it("marks the current attempt and renders recorded times", () => {
    expect(card).toContain('aria-current="true"');
    expect(card).toContain("<time");
  });
});
