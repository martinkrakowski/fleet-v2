// CO24c: the repository the API's PR-feedback fix round is bound to.
import { describe, expect, it } from "vitest";

import { resolveBoundForgeRepository } from "./pr-feedback-fix";

const INSTALLATION = { owner: "org", repo: "repo" };

describe("resolveBoundForgeRepository", () => {
  it("returns a fresh copy of the forge repository when no installation repository is given", () => {
    const forgeRepository = { owner: "org", repo: "repo" };
    const result = resolveBoundForgeRepository({
      forgeRepository,
      forgeConfigured: true,
      installationRepository: undefined,
    });
    expect(result).toEqual({ owner: "org", repo: "repo" });
    expect(result).not.toBe(forgeRepository);
  });

  it("returns the forge repository's own spelling when the installation agrees without case", () => {
    const result = resolveBoundForgeRepository({
      forgeRepository: { owner: "Org", repo: "Repo" },
      forgeConfigured: true,
      installationRepository: INSTALLATION,
    });
    expect(result).toEqual({ owner: "Org", repo: "Repo" });
  });

  it("returns undefined when the forge repository and the installation repository differ", () => {
    for (const forgeRepository of [
      { owner: "other", repo: "repo" },
      { owner: "org", repo: "other" },
    ]) {
      expect(
        resolveBoundForgeRepository({
          forgeRepository,
          forgeConfigured: true,
          installationRepository: INSTALLATION,
        }),
      ).toBeUndefined();
    }
  });

  it("returns undefined for a malformed forge repository even when the installation names one", () => {
    const malformed: unknown[] = [
      null,
      "org/repo",
      7,
      [],
      {},
      { owner: "org" },
      { owner: "org", repo: 7 },
      { owner: "", repo: "repo" },
      { owner: "org", repo: "repo\n" },
      { owner: "org/evil", repo: "repo" },
    ];
    for (const forgeRepository of malformed) {
      expect(
        resolveBoundForgeRepository({
          forgeRepository,
          forgeConfigured: false,
          installationRepository: INSTALLATION,
        }),
      ).toBeUndefined();
    }
  });

  it("never invokes a getter on the forge repository and returns undefined for it", () => {
    let invoked = false;
    const forgeRepository = { repo: "repo" };
    Object.defineProperty(forgeRepository, "owner", {
      enumerable: true,
      get() {
        invoked = true;
        return "org";
      },
    });
    expect(
      resolveBoundForgeRepository({
        forgeRepository,
        forgeConfigured: true,
        installationRepository: undefined,
      }),
    ).toBeUndefined();
    expect(invoked).toBe(false);
  });

  it("returns undefined when the forge is configured but names no repository", () => {
    expect(
      resolveBoundForgeRepository({
        forgeRepository: undefined,
        forgeConfigured: true,
        installationRepository: INSTALLATION,
      }),
    ).toBeUndefined();
  });

  it("returns the installation repository when no forge is configured and none is named", () => {
    expect(
      resolveBoundForgeRepository({
        forgeRepository: undefined,
        forgeConfigured: false,
        installationRepository: INSTALLATION,
      }),
    ).toBe(INSTALLATION);
    expect(
      resolveBoundForgeRepository({
        forgeRepository: undefined,
        forgeConfigured: false,
        installationRepository: undefined,
      }),
    ).toBeUndefined();
  });
});
