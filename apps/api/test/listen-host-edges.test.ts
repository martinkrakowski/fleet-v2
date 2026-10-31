import { describe, expect, it } from "vitest";

import { listenHostRefusal } from "../server/wiring/listen-host.js";

const refusal = (host: string) =>
  `listen host is \`${host}\`; set HOST=127.0.0.1 or FLEET_API_ALLOW_REMOTE=1`;

describe("listenHostRefusal edges", () => {
  it.each(["0.0.0.0", "127.0.0.2", "::ffff:127.0.0.1", "localhost.localdomain", "127.1"])(
    "refuses near-miss host %s",
    (host) => {
      expect(listenHostRefusal({ HOST: host })).toBe(refusal(host));
    },
  );

  it("allows HOST with surrounding whitespace after trimming", () => {
    expect(listenHostRefusal({ HOST: " 127.0.0.1 " })).toBeNull();
  });

  it("allows NITRO_HOST with surrounding whitespace after trimming", () => {
    expect(listenHostRefusal({ NITRO_HOST: " ::1 " })).toBeNull();
  });

  it("refuses an empty HOST as unset", () => {
    expect(listenHostRefusal({ HOST: "" })).toBe(
      "listen host is unset; set HOST=127.0.0.1 or FLEET_API_ALLOW_REMOTE=1",
    );
  });

  it.each([" 1", "1 "])(
    "does not trim FLEET_API_ALLOW_REMOTE value %s",
    (flag) => {
      expect(listenHostRefusal({ HOST: "0.0.0.0", FLEET_API_ALLOW_REMOTE: flag })).toBe(
        refusal("0.0.0.0"),
      );
    },
  );

  it("allows with FLEET_API_ALLOW_REMOTE=1 and no host", () => {
    expect(listenHostRefusal({ FLEET_API_ALLOW_REMOTE: "1" })).toBeNull();
  });
});
