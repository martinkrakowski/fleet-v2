// Registry metadata tests (MX1; plan §3.3, §3.7, D10, D16): the tool names
// are exactly the registry's list and follow D16, kinds and scopes are within
// their allowed sets, scope follows kind, annotations follow kind, no tool is
// destructive, every tool is `read` until T3a, and every input schema is a
// strict object that refuses an extra key.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApiClientResult, FleetApiClient } from "./client.js";
import {
  buildRegistry,
  FLEET_TOOL_KINDS,
  FLEET_TOOL_NAMES,
  FLEET_TOOL_SCOPES,
  toolAnnotationsFor,
  type FleetRegistry,
} from "./registry.js";

interface RecordedCall {
  method: "GET" | "POST";
  path: string;
}

function fakeClient(
  responses: Record<string, ApiClientResult>,
): FleetApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const respond = (path: string): ApiClientResult =>
    responses[path] ?? {
      ok: false,
      code: "unmocked-route",
      message: `no canned response for ${path}`,
    };
  return {
    calls,
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return respond(path);
    },
    post: async (path: string, _body: unknown) => {
      calls.push({ method: "POST", path });
      return respond(path);
    },
  };
}

describe("registry metadata (MX1; plan §3.3, §3.7, D10, D16)", () => {
  const registry: FleetRegistry = buildRegistry(fakeClient({}));

  it("tool names are exactly the registry's list, unique, and follow D16", () => {
    const names = registry.tools.map((tool) => tool.name);
    expect(names).toEqual([...FLEET_TOOL_NAMES]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^fleet_[a-z0-9_]{1,58}$/);
      expect(name).not.toContain(".");
    }
    const resourceNames = registry.resources.map((resource) => resource.name);
    expect(new Set(resourceNames).size).toBe(resourceNames.length);
    const uris = registry.resources.map((resource) => resource.uri);
    expect(new Set(uris).size).toBe(uris.length);
  });

  it("kinds and scopes are within their allowed sets", () => {
    for (const tool of registry.tools) {
      expect(FLEET_TOOL_KINDS).toContain(tool.kind);
      expect(FLEET_TOOL_SCOPES).toContain(tool.scope);
    }
    const usedScopes = new Set(
      registry.tools
        .map((tool) => tool.scope)
        .concat(registry.resources.map((resource) => resource.scope)),
    );
    for (const scope of usedScopes) {
      expect(FLEET_TOOL_SCOPES).toContain(scope);
    }
    for (const resource of registry.resources) {
      expect(resource.scope).toBe("read");
    }
  });

  it("scope follows kind: read tools are read, mutating tools are message", () => {
    for (const tool of registry.tools) {
      if (tool.kind === "read") {
        expect(tool.scope).toBe("read");
      } else {
        expect(tool.scope).toBe("message");
      }
    }
  });

  it("annotations follow kind and match toolAnnotationsFor", () => {
    for (const tool of registry.tools) {
      expect(tool.annotations).toEqual(toolAnnotationsFor(tool.kind));
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.openWorldHint).toBe(false);
      if (tool.kind === "read") {
        expect(tool.annotations.readOnlyHint).toBe(true);
      }
    }
    const mutating = toolAnnotationsFor("mutating");
    expect(mutating.readOnlyHint).toBe(false);
    expect(mutating.destructiveHint).toBe(false);
    expect(mutating.idempotentHint).toBe(true);
    expect(Object.isFrozen(toolAnnotationsFor("read"))).toBe(true);
    expect(Object.isFrozen(mutating)).toBe(true);
  });

  it("ships only read tools until T3a (D10; MX6a changes this test)", () => {
    for (const tool of registry.tools) {
      expect(tool.kind).toBe("read");
    }
  });

  it("every input schema is a strict object that refuses an extra key", () => {
    for (const tool of registry.tools) {
      const schema = tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
      const def = schema.def as unknown as {
        catchall?: { def: { type: string } };
      };
      expect(def.catchall?.def.type).toBe("never");
      expect(tool.inputSchema.safeParse({ unexpected: "example" }).success).toBe(
        false,
      );
    }
    const coordination = registry.tools.find(
      (tool) => tool.name === "fleet_coordination",
    );
    expect(coordination?.inputSchema.safeParse({}).success).toBe(true);
  });
});
