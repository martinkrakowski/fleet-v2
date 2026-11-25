// FVM5: MCP-to-API mutation route parity test. The MCP tool surface may not
// silently drift from apps/api: every /v1 route whose required scope is
// `message` or `operate` must be called by a registered MCP tool or sit on
// the explicit exclusion list with a non-empty reason. Nothing here touches a
// live server, persists any record or imports anything from apps/api — the
// private API mapping is read as text.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import {
  buildRegistry,
  FLEET_TOOL_NAMES,
  type FleetRegistry,
} from "./registry.js";
import {
  checkRouteParity,
  MAX_FILE_BYTES,
  normalizeRoutePattern,
  PARITY_EXCLUSIONS,
  parseMutationRouteRules,
  type ParsedRouteRule,
  type RouteKey,
} from "./parity-exclusions.js";

/** Resolve the API wiring file as text; no cross-app import, no export reuse. */
const ROUTE_SCOPES_PATH = path.resolve(
  decodeURIComponent(
    import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]*$/, ""),
  ),
  "../../../apps/api/server/wiring/route-scopes.ts",
);

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
}

/** In-memory recording client: records every /v1 call, answers with a refusal. */
function recordingClient(): FleetApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return {
        ok: false,
        code: "parity-recording",
        message: "recorded by the parity test.",
      } satisfies ApiClientResult;
    },
    post: async (path: string) => {
      calls.push({ method: "POST", path });
      return {
        ok: false,
        code: "parity-recording",
        message: "recorded by the parity test.",
      } satisfies ApiClientResult;
    },
  };
}

function toolNamed(registry: FleetRegistry, name: string) {
  const tool = registry.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`registry is missing tool ${name}`);
  }
  return tool;
}

// Runtime-built 40-character sha; never a literal token-shaped value.
const TEST_SHA = "0".repeat(40);

/** Minimal valid input per tool, matching each strict Zod schema. */
const TOOL_INPUTS: Record<string, unknown> = {
  fleet_coordination: {},
  fleet_attempt: { attemptId: "att-1" },
  fleet_attempt_list: {},
  fleet_attempt_journal: { attemptId: "att-1" },
  fleet_work_order: { workOrderId: "wo-1" },
  fleet_head_evidence: { headSha: TEST_SHA },
  fleet_question_list: {},
  fleet_question: { questionId: "q-1" },
  fleet_project_list: {},
  fleet_lane_run_list: {},
  fleet_conductor_status: {},
  fleet_brief_preview: {
    workOrderId: "wo-1",
    projectId: "proj-1",
    taskId: "task-1",
    laneId: "lane-1",
    repository: "fleet",
    baseCommit: TEST_SHA,
    policyRevision: "rev-1",
    worktreePath: "/tmp/worktrees/att-1",
    modelAssignment: {
      model: "seat-model",
      variant: "seat-variant",
      fallbackModel: "fallback-model",
      seatTool: "opencode",
    },
    independentReviewer: "reviewer-seat",
    ownedPaths: ["src/example.ts"],
    permissions: ["read"],
    acceptanceChecks: ["yarn typecheck"],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ["yarn", "typecheck"] }],
    },
    stepLimit: 10,
    timeLimitSeconds: 60,
    resourceBounds: { cpus: "1" },
    expectedArtifacts: [],
    ownerDecisionReferences: [],
    contextDecisions: [],
  },
  fleet_telemetry_status: {},
};

/** The exact route each registered tool must call, in `:param` form. */
const EXPECTED_ROUTES: Record<string, { method: string; path: string }> = {
  fleet_coordination: { method: "GET", path: "/v1/coordination" },
  fleet_attempt: { method: "GET", path: "/v1/attempts/:param" },
  fleet_attempt_list: { method: "GET", path: "/v1/attempts" },
  fleet_attempt_journal: { method: "GET", path: "/v1/attempts/:param/journal" },
  fleet_work_order: { method: "GET", path: "/v1/work-orders/:param" },
  fleet_head_evidence: { method: "GET", path: "/v1/heads/:param/evidence" },
  fleet_question_list: { method: "GET", path: "/v1/questions" },
  fleet_question: { method: "GET", path: "/v1/questions/:param" },
  fleet_project_list: { method: "GET", path: "/v1/projects" },
  fleet_lane_run_list: { method: "GET", path: "/v1/runs" },
  fleet_conductor_status: { method: "GET", path: "/v1/runs" },
  fleet_brief_preview: { method: "POST", path: "/v1/briefs/preview" },
  fleet_telemetry_status: { method: "GET", path: "/v1/telemetry/status" },
};

/** Concrete id segments used by the minimal tool inputs, for normalization. */
const CONCRETE_IDS = new Set(["att-1", "wo-1", "q-1", TEST_SHA]);

function toPatternForm(recordedPath: string): string {
  return `/${recordedPath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (CONCRETE_IDS.has(segment) ? ":param" : segment))
    .join("/")}`;
}

function makeRule(
  method: string,
  pattern: string,
  scope: string,
): ParsedRouteRule {
  return { method, pattern, scope };
}

/** Build a synthetic route-scopes source from raw rule lines. */
function makeSourceLines(lines: readonly string[]): string {
  return `const MUTATION_ROUTE_RULES = [\n${lines.join("\n")}\n];\n`;
}

/** Build a synthetic route-scopes source with the given rule triples. */
function makeSource(rules: ReadonlyArray<readonly [string, string, string]>): string {
  return makeSourceLines(
    rules.map(
      ([method, pattern, scope]) => `  ["${method}", "${pattern}", "${scope}"],`,
    ),
  );
}

/** 45 synthetic rules so fixture sources clear the MIN_RULES floor. */
function syntheticRules(
  scope: string,
  count = 45,
): ReadonlyArray<readonly [string, string, string]> {
  return Array.from(
    { length: count },
    (_, i) => ["POST", `/v1/fixtures/rule-${i}`, scope] as const,
  );
}

describe("MCP-to-API mutation route parity", () => {
  const client = recordingClient();
  const registry = buildRegistry(client);

  it("every registered tool calls exactly one /v1 route and the recorded set matches the fixed read surface", async () => {
    expect([...registry.tools.map((tool) => tool.name)]).toEqual([
      ...FLEET_TOOL_NAMES,
    ]);
    const callsByName = new Map<string, RecordedCall>();
    for (const name of FLEET_TOOL_NAMES) {
      const before = client.calls.length;
      const result = await toolNamed(registry, name).handler(TOOL_INPUTS[name]);
      const made = client.calls.slice(before);
      expect(
        made,
        `${name} must call exactly one /v1 route`,
      ).toHaveLength(1);
      const call = made[0];
      expect(call.path.startsWith("/v1/")).toBe(true);
      expect(result.isError).toBe(true);
      callsByName.set(name, call);
    }
    expect(client.calls).toHaveLength(FLEET_TOOL_NAMES.length);
    for (const name of FLEET_TOOL_NAMES) {
      const call = callsByName.get(name);
      if (!call) {
        throw new Error(`${name} was not recorded during the first pass`);
      }
      const expected = EXPECTED_ROUTES[name];
      expect(`${call.method} ${toPatternForm(call.path)}`).toBe(
        `${expected.method} ${expected.path}`,
      );
    }
  });

  const parsed = parseMutationRouteRules(readFileSync(ROUTE_SCOPES_PATH, "utf8"));
  const toolRoutes: RouteKey[] = registry.tools.map((tool) => ({
    method: EXPECTED_ROUTES[tool.name].method,
    path: EXPECTED_ROUTES[tool.name].path,
  }));

  it("parseMutationRouteRules extracts 48 rules with 7 message and 27 operate routes from the live route-scopes file", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.rules.length).toBe(48);
    expect(parsed.rules.filter((rule) => rule.scope === "message")).toHaveLength(7);
    expect(parsed.rules.filter((rule) => rule.scope === "operate")).toHaveLength(27);
  });

  it("checkRouteParity passes for the live registry, live rules and the published exclusion list", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const result = checkRouteParity(parsed.rules, toolRoutes, PARITY_EXCLUSIONS);
    expect(result).toEqual({ ok: true });
  });

  it("checkRouteParity ignores read, orchestrate, verdict and hook routes", () => {
    const nonParityRules: ParsedRouteRule[] = [
      makeRule("POST", "/v1/briefs/preview", "read"),
      makeRule("POST", "/v1/orchestrators", "orchestrate"),
      makeRule("POST", "/v1/reviews", "verdict"),
      makeRule("POST", "/v1/forge", "hook"),
    ];
    expect(
      checkRouteParity(nonParityRules, [], []),
    ).toEqual({ ok: true });
  });

  it("refuses null, undefined, and non-string route-scopes source", () => {
    for (const source of [null, undefined, 42, true, [], {}]) {
      const result = parseMutationRouteRules(source);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid-source");
      }
    }
    expect(parseMutationRouteRules("").ok).toBe(false);
  });

  it("refuses oversized route-scopes source beyond MAX_FILE_BYTES", () => {
    const oversized = `x`.repeat(MAX_FILE_BYTES + 1);
    const result = parseMutationRouteRules(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("source-too-large");
    }
  });

  it("refuses source with missing block or fewer than 40 rules", () => {
    const missing = "export const FROZEN_SCOPES = ['read'];\n";
    const missingResult = parseMutationRouteRules(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.code).toBe("insufficient-rules");
    }
    const truncated = makeSource(syntheticRules("message", 39));
    const truncatedResult = parseMutationRouteRules(truncated);
    expect(truncatedResult.ok).toBe(false);
    if (!truncatedResult.ok) {
      expect(truncatedResult.code).toBe("insufficient-rules");
    }
  });

  it("refuses any quoted rule line that fails the strict triple pattern", () => {
    const lines = syntheticRules("message", 40).map(
      ([method, pattern, scope]) => `  ["${method}", "${pattern}", "${scope}"],`,
    );
    // A quoted line inside the array body with a lowercase method is refused.
    lines[39] = `  ["post", "/v1/broken", "message"],`;
    const result = parseMutationRouteRules(makeSourceLines(lines));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("malformed-rule-line");
    }
  });

  it("refuses null, undefined, non-array, array-like, hole, getter, oversized, and prototype-polluting exclusion inputs", () => {
    const validEntry = { method: "POST", pattern: "/v1/x", reason: "FVM1" };
    let getterInvoked = false;
    const getterEntry = Object.defineProperty(
      { method: "POST", pattern: "/v1/x", reason: "FVM1" },
      "reason",
      {
        get: () => {
          getterInvoked = true;
          return "FVM1";
        },
        enumerable: true,
      },
    );
    const polluting = { method: "POST", pattern: "/v1/x", reason: "FVM1" };
    Object.defineProperty(polluting, "__proto__", {
      value: {},
      enumerable: true,
    });
    const oversized = Array.from({ length: 2001 }, () => validEntry);
    const sparse = new Array(2);
    sparse[0] = validEntry;
    const cases: ReadonlyArray<[unknown, string]> = [
      [null, "invalid-exclusions"],
      [undefined, "invalid-exclusions"],
      [42, "invalid-exclusions"],
      ["nope", "invalid-exclusions"],
      [{ length: 1, 0: validEntry }, "invalid-exclusions"],
      [sparse, "invalid-exclusions"],
      [getterEntry, "invalid-exclusions"],
      [oversized, "invalid-exclusions"],
      [polluting, "invalid-exclusions"],
    ];
    for (const [input, code] of cases) {
      const result = checkRouteParity(
        [makeRule("POST", "/v1/x", "message")],
        [],
        input,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
      }
    }
    expect(getterInvoked).toBe(false);
  });

  it("refuses an exclusion entry with an empty or whitespace reason", () => {
    for (const reason of ["", "   ", "\t\n"]) {
      const result = checkRouteParity(
        [makeRule("POST", "/v1/x", "message")],
        [],
        [{ method: "POST", pattern: "/v1/x", reason }],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("empty-reason");
      }
    }
  });

  it("refuses an unlisted message or operate route with the required guidance message", () => {
    const result = checkRouteParity(
      [makeRule("POST", "/v1/questions", "message")],
      [],
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing-parity");
      expect(result.message).toContain("POST /v1/questions");
      expect(result.message).toBe(
        "Missing MCP parity for POST /v1/questions: add an MCP tool or an exclusion with a reason",
      );
    }
  });

  it("refuses a stale exclusion naming a route that does not exist", () => {
    const result = checkRouteParity(
      [makeRule("POST", "/v1/questions", "message")],
      [],
      [
        {
          method: "POST",
          pattern: "/v1/reviews",
          reason: "FVM4 owns the review tool.",
        },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("stale-exclusion");
    }
  });

  it("refuses a redundant exclusion for a route already covered by an MCP tool", () => {
    const result = checkRouteParity(
      [makeRule("POST", "/v1/runs/halt", "operate")],
      [{ method: "POST", path: "/v1/runs/halt" }],
      [
        {
          method: "POST",
          pattern: "/v1/runs/halt",
          reason: "FVM3 owns the halt tool.",
        },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("redundant-exclusion");
    }
  });

  it("refuses matching when about 2000 tool paths plus repeated wildcard rules exhaust the match budget", () => {
    const wildcardRules: ParsedRouteRule[] = Array.from(
      { length: 2000 },
      (_, i) => makeRule("POST", `/v1/t/:branch-${i}/leaf`, "operate"),
    );
    const manyPaths: RouteKey[] = Array.from(
      { length: 2000 },
      (_, i) => ({ method: "POST", path: `/v1/t/x-${i}/leaf` }),
    );
    const result = checkRouteParity(wildcardRules, manyPaths, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("match-budget-exceeded");
    }
  });

  it("parses only the real declaration when a comment holds a fake MUTATION_ROUTE_RULES assignment", () => {
    const realRules = syntheticRules("message", 45);
    const spoofed =
      "// const MUTATION_ROUTE_RULES = [[\"POST\", \"/v1/fake\", \"hook\"]];\n" +
      makeSource(realRules);
    const result = parseMutationRouteRules(spoofed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(45);
      expect(result.rules[0].pattern).toBe("/v1/fixtures/rule-0");
      expect(result.rules.every((rule) => rule.scope === "message")).toBe(true);
    }
  });

  it("refuses a declaration whose initializer is not the rules array literal", () => {
    const decoy =
      "const OTHER_THING = [\"POST\", \"/v1/decoy\", \"message\"];\n";
    const source =
      "const MUTATION_ROUTE_RULES = undefined;\n" + decoy;
    const result = parseMutationRouteRules(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing-array-initializer");
    }
  });

  it("refuses zero or multiple MUTATION_ROUTE_RULES declarations loudly", () => {
    const none = parseMutationRouteRules("const OTHER = 1;\n");
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.code).toBe("insufficient-rules");
    }
    const twice =
      makeSource(syntheticRules("message", 45)) +
      makeSource(syntheticRules("operate", 45));
    const duplicated = parseMutationRouteRules(twice);
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.code).toBe("ambiguous-declaration");
    }
  });

  it("normalizeRoutePattern refuses the __proto__, constructor and prototype segments", () => {
    for (const segment of ["__proto__", "constructor", "prototype"]) {
      let thrown: unknown;
      try {
        normalizeRoutePattern(`/v1/${segment}/x`);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("PathRefusalError");
      expect((thrown as { code?: string }).code).toBe(
        "prototype-polluting-path",
      );
    }
  });

  it("normalizeRoutePattern strips queries, unifies param names and rejects non /v1 values", () => {
    expect(normalizeRoutePattern("/v1/attempts/a-1?since=x")).toBe(
      "/v1/attempts/a-1",
    );
    expect(normalizeRoutePattern("/v1/attempts/:id/stop")).toBe(
      "/v1/attempts/:param/stop",
    );
    expect(normalizeRoutePattern("/v1/heads/:sha/assessment")).toBe(
      "/v1/heads/:param/assessment",
    );
    expect(normalizeRoutePattern("/v1/questions/:id/acknowledgement")).toBe(
      "/v1/questions/:param/acknowledgement",
    );
    for (const bad of [null, undefined, 7, "", "v1/x", "/api/x", "/v2/x"]) {
      expect(normalizeRoutePattern(bad)).toBeNull();
    }
  });
});
