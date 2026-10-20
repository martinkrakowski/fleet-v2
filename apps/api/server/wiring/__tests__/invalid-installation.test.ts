import { describe, expect, it } from "vitest";

import { InvalidInstallationError, type FleetInstallation } from "@fleet/installation";

import { createConfiguredEvidenceUseCases } from "../evidence/composition";
import { createConfiguredWorkComposition } from "../work/composition";

const hosts = {
  here: {
    transport: "local",
    worktreeRoot: "/tmp/wt",
    roles: ["orchestrator", "lane-runner", "verifier"],
    runner: { kind: "opencode", port: 4166 },
  },
} as const;

function v2(overrides: Partial<FleetInstallation> = {}): FleetInstallation {
  return { schemaVersion: 2, forge: { mode: "none" }, hosts, ...overrides };
}

const freeImplementer = {
  id: "free-impl",
  tool: "opencode",
  model: "provider-b/free-model",
  roles: ["implementer"],
  costClass: "free",
} as const;

const paidImplementer = {
  id: "paid-impl",
  tool: "opencode",
  model: "provider-a/glm-5.3",
  roles: ["implementer"],
  costClass: "paid",
} as const;

const allFreeV2 = v2({
  policy: { useFreeSeats: false },
  seats: [freeImplementer],
  chains: { implementer: [{ seatId: "free-impl" }] },
});

const singleFreeV2 = v2({
  seats: [freeImplementer],
  chains: { implementer: [{ seatId: "free-impl" }] },
});

const validV2 = v2({
  seats: [paidImplementer],
  chains: { implementer: [{ seatId: "paid-impl" }] },
});

describe("API compositions reject invalid installations", () => {
  const composes = [
    ["work", (installation: FleetInstallation) => createConfiguredWorkComposition({ installation })],
    ["evidence", (installation: FleetInstallation) => createConfiguredEvidenceUseCases({ installation })],
  ] as const;

  it("throws InvalidInstallationError for an all-free implementer chain when useFreeSeats is false", () => {
    for (const [, compose] of composes) {
      expect(() => compose(allFreeV2)).toThrow(InvalidInstallationError);
    }
  });

  it("throws InvalidInstallationError for a single free seat as the only seat of a role", () => {
    for (const [, compose] of composes) {
      expect(() => compose(singleFreeV2)).toThrow(InvalidInstallationError);
    }
  });

  it("does not throw for a valid installation", () => {
    for (const [, compose] of composes) {
      expect(() => compose(validV2)).not.toThrow();
    }
  });
});
