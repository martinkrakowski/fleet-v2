import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { NOT_CONFIGURED_REASON, shouldRefresh } from "./use-auto-refresh";

describe("shouldRefresh", () => {
  it("refreshes the live API or a failed configured API while the tab is visible", () => {
    expect(shouldRefresh("api", null, "visible")).toBe(true);
    expect(shouldRefresh("api", null, "hidden")).toBe(false);
    expect(
      shouldRefresh("fixture-fallback", NOT_CONFIGURED_REASON, "visible"),
    ).toBe(false);
    expect(
      shouldRefresh(
        "fixture-fallback",
        "api boundary is unreachable: ECONNREFUSED",
        "visible",
      ),
    ).toBe(true);
    expect(
      shouldRefresh(
        "fixture-fallback",
        "api boundary is unreachable: ECONNREFUSED",
        "hidden",
      ),
    ).toBe(false);
  });
});
