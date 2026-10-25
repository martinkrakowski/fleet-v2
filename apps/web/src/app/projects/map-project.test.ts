import { describe, expect, it } from "vitest";
import {
  parseProjectEnvelope,
  parseProjectListEnvelope,
  worstProbeResult,
  type ProjectLastProbe,
} from "./map-project";

function projectWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "fleet-v2",
    displayName: "Fleet v2",
    repository: "https://example.com/fleet-v2.git",
    designatedDispatcherHost: "host-a",
    policyRevision: "pol-2026-10-11.3",
    maxConcurrentLanes: 4,
    runnerCapabilities: { networkEgressRestricted: true },
    status: "active",
    defaultBranch: "main",
    clones: {
      "host-a": {
        path: "/srv/clones/fleet-v2",
        worktreeRoot: "/srv/worktrees/fleet-v2",
      },
    },
    gateProcedures: ["typecheck", "lint"],
    defaultAllowedPathPrefixes: ["packages/**", "apps/**"],
    lastProbe: {
      probedAtIso: "2026-10-24T10:00:00Z",
      probedFrom: "host-a",
      checks: [
        {
          name: "repository reachable",
          host: "host-a",
          result: "pass",
          detail: "git ls-remote answered in 120 ms",
        },
      ],
    },
    revision: 12,
    updatedAtIso: "2026-10-24T09:55:00Z",
    ...overrides,
  };
}

function listEnvelope(profiles: unknown[]): Record<string, unknown> {
  return {
    operationId: "op-p1",
    code: "OK",
    result: { outcome: "listed", profiles },
  };
}

describe("parseProjectListEnvelope", () => {
  it("parses a valid list envelope", () => {
    const parsed = parseProjectListEnvelope(
      listEnvelope([projectWire(), projectWire({ projectId: "waves" })]),
    );

    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0].projectId).toBe("fleet-v2");
    expect(parsed?.[0].status).toBe("active");
    expect(parsed?.[0].clones["host-a"]).toEqual({
      path: "/srv/clones/fleet-v2",
      worktreeRoot: "/srv/worktrees/fleet-v2",
    });
    expect(parsed?.[0].lastProbe?.checks[0].result).toBe("pass");
    expect(parsed?.[1].projectId).toBe("waves");
  });

  it("returns null when code is not OK", () => {
    expect(
      parseProjectListEnvelope({
        operationId: "op-p1",
        code: "NOT_IMPLEMENTED",
        result: null,
      }),
    ).toBeNull();
  });

  it("returns null when a single profile is bad — the whole list is null", () => {
    const badProfile = projectWire({ projectId: 7 });
    expect(parseProjectListEnvelope(listEnvelope([projectWire(), badProfile]))).toBeNull();
  });

  it("returns null when a probe check result is not one of the three values", () => {
    const badProbe = projectWire({
      lastProbe: {
        probedAtIso: "2026-10-24T10:00:00Z",
        probedFrom: "host-a",
        checks: [{ name: "repository reachable", host: "host-a", result: "maybe", detail: "x" }],
      },
    });
    expect(parseProjectListEnvelope(listEnvelope([badProbe]))).toBeNull();
  });

  it("returns null when a clone path is not a string", () => {
    const badClone = projectWire({
      clones: {
        "host-a": { path: 42, worktreeRoot: "/srv/worktrees/fleet-v2" },
      },
    });
    expect(parseProjectListEnvelope(listEnvelope([badClone]))).toBeNull();
  });

  it("returns null for a prototype host key", () => {
    const protoKey = JSON.parse(
      '{"__proto__":{"path":"/srv/clones/x","worktreeRoot":"/srv/worktrees/x"}}',
    );
    expect(parseProjectListEnvelope(listEnvelope([projectWire({ clones: protoKey })]))).toBeNull();

    const constructorKey = projectWire({
      clones: {
        constructor: { path: "/srv/clones/x", worktreeRoot: "/srv/worktrees/x" },
      },
    });
    expect(parseProjectListEnvelope(listEnvelope([constructorKey]))).toBeNull();
  });

  it("returns null when a prompt is not a record", () => {
    expect(parseProjectListEnvelope(listEnvelope([42]))).toBeNull();
  });
});

describe("parseProjectEnvelope", () => {
  it("parses a valid found envelope", () => {
    const parsed = parseProjectEnvelope({
      operationId: "op-p2",
      code: "OK",
      result: { outcome: "found", profile: projectWire() },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.projectId).toBe("fleet-v2");
    expect(parsed?.policyRevision).toBe("pol-2026-10-11.3");
  });

  it("returns null when outcome is not found", () => {
    expect(
      parseProjectEnvelope({
        operationId: "op-p2",
        code: "OK",
        result: { outcome: "listed", profile: projectWire() },
      }),
    ).toBeNull();
  });

  it("returns null when the profile is missing", () => {
    expect(
      parseProjectEnvelope({
        operationId: "op-p2",
        code: "OK",
        result: { outcome: "found" },
      }),
    ).toBeNull();
  });
});

describe("worstProbeResult", () => {
  const probe = (checks: ProjectLastProbe["checks"]): ProjectLastProbe => ({
    probedAtIso: "2026-10-24T10:00:00Z",
    probedFrom: "host-a",
    checks,
  });

  it("maps a missing receipt to none", () => {
    expect(worstProbeResult(null)).toBe("none");
  });

  it("passes when every check passes or there are no checks", () => {
    expect(worstProbeResult(probe([]))).toBe("pass");
    expect(
      worstProbeResult(
        probe([
          { name: "a", host: "host-a", result: "pass", detail: "" },
          { name: "b", host: null, result: "pass", detail: "" },
        ]),
      ),
    ).toBe("pass");
  });

  it("unknown beats pass", () => {
    expect(
      worstProbeResult(
        probe([
          { name: "a", host: "host-a", result: "pass", detail: "" },
          { name: "b", host: null, result: "unknown", detail: "" },
        ]),
      ),
    ).toBe("unknown");
  });

  it("fail beats unknown and pass", () => {
    expect(
      worstProbeResult(
        probe([
          { name: "a", host: "host-a", result: "unknown", detail: "" },
          { name: "b", host: "host-a", result: "fail", detail: "" },
        ]),
      ),
    ).toBe("fail");
    expect(
      worstProbeResult(
        probe([
          { name: "a", host: "host-a", result: "pass", detail: "" },
          { name: "b", host: "host-a", result: "fail", detail: "" },
        ]),
      ),
    ).toBe("fail");
  });
});
