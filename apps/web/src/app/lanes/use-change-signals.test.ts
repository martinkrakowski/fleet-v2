import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  CHANGE_SIGNAL_DEBOUNCE_MS,
  CHANGE_SIGNAL_PATH,
  CHANGE_SIGNAL_RETRY_MS,
  parseSignalData,
  refreshDelayMs,
} from "./use-change-signals";

describe("change-signal helpers", () => {
  it("parses an SSE data payload and rejects garbage", () => {
    expect(parseSignalData('{"seq":3,"kind":"attempt","id":"att_1"}')).toEqual({
      seq: 3,
      kind: "attempt",
      id: "att_1",
    });
    expect(parseSignalData("not json")).toBeNull();
    expect(parseSignalData("")).toBeNull();
  });

  it("refreshes a resync immediately and everything else after the debounce", () => {
    expect(refreshDelayMs("resync")).toBe(0);
    expect(refreshDelayMs("attempt")).toBe(CHANGE_SIGNAL_DEBOUNCE_MS);
  });
});

describe("change-signal source wiring", () => {
  const LANES_DIR = join(import.meta.dirname);
  const read = (...parts: string[]) =>
    readFileSync(join(LANES_DIR, ...parts), "utf8");

  const hook = read("use-change-signals.ts");
  const client = read("lanes-client.tsx");

  it("subscribes to the same-origin relay and refreshes debounced", () => {
    expect(hook).toContain("new EventSource(CHANGE_SIGNAL_PATH)");
    expect(hook).toContain("router.refresh()");
    expect(hook).toContain("document.visibilityState");
    expect(hook).toContain("CHANGE_SIGNAL_RETRY_MS");
    expect(hook).toContain(".close()");
  });

  it("adds signals next to the kept 30 s poll", () => {
    expect(client).toContain("useChangeSignals(");
    expect(client).toContain("useAutoRefresh(data.source, data.fallbackReason)");
    expect(client).toContain("refreshes on change signals");
    expect(client).toContain("30 s poll as fallback");
  });

  it("keeps the declared constants", () => {
    expect(CHANGE_SIGNAL_PATH).toBe("/live/changes");
    expect(CHANGE_SIGNAL_RETRY_MS).toBe(5_000);
  });
});
