import { describe, expect, it } from "vitest";

import { listenHostRefusal } from "../server/wiring/listen-host.js";

describe("listenHostRefusal", () => {
  it("refuses when the listen host is unset", () => {
    const reason = listenHostRefusal({});
    expect(reason).not.toBeNull();
    expect(reason).toContain("unset");
  });

  it("refuses when HOST is a non-loopback interface", () => {
    const reason = listenHostRefusal({ HOST: "0.0.0.0" });
    expect(reason).not.toBeNull();
    expect(reason).toContain("0.0.0.0");
  });

  it("allows a non-loopback HOST with FLEET_API_ALLOW_REMOTE=1", () => {
    expect(
      listenHostRefusal({ HOST: "0.0.0.0", FLEET_API_ALLOW_REMOTE: "1" }),
    ).toBeNull();
  });

  it("refuses non-loopback HOST when FLEET_API_ALLOW_REMOTE is 'true'", () => {
    expect(
      listenHostRefusal({ HOST: "0.0.0.0", FLEET_API_ALLOW_REMOTE: "true" }),
    ).not.toBeNull();
  });

  it("refuses non-loopback HOST when FLEET_API_ALLOW_REMOTE is 'yes'", () => {
    expect(
      listenHostRefusal({ HOST: "0.0.0.0", FLEET_API_ALLOW_REMOTE: "yes" }),
    ).not.toBeNull();
  });

  it.each(["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"])(
    "allows loopback host %s",
    (host) => {
      expect(listenHostRefusal({ HOST: host })).toBeNull();
    },
  );

  it("prefers NITRO_HOST over HOST when NITRO_HOST is loopback", () => {
    expect(
      listenHostRefusal({ NITRO_HOST: "127.0.0.1", HOST: "0.0.0.0" }),
    ).toBeNull();
  });

  it("prefers NITRO_HOST over HOST when NITRO_HOST is non-loopback", () => {
    expect(
      listenHostRefusal({ NITRO_HOST: "0.0.0.0", HOST: "127.0.0.1" }),
    ).not.toBeNull();
  });

  it("lets whitespace-only NITRO_HOST fall through to HOST", () => {
    expect(
      listenHostRefusal({ NITRO_HOST: "   ", HOST: "127.0.0.1" }),
    ).toBeNull();
  });

  it("does not leak unrelated env values into the refusal message", () => {
    const reason = listenHostRefusal({
      HOST: "0.0.0.0",
      FLEET_API_TOKEN_FILE: "fake-super-secret-token",
    });
    expect(reason).not.toContain("fake-super-secret-token");
  });
});
