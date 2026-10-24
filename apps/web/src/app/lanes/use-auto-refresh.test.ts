import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { shouldRefresh } from "./use-auto-refresh";

describe("shouldRefresh", () => {
  it("refreshes only the live API source while the tab is visible", () => {
    expect(shouldRefresh("api", "visible")).toBe(true);
    expect(shouldRefresh("api", "hidden")).toBe(false);
    expect(shouldRefresh("fixture-fallback", "visible")).toBe(false);
    expect(shouldRefresh("fixture-fallback", "hidden")).toBe(false);
  });
});
