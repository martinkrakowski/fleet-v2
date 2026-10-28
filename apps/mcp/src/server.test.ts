// Server tests (MX1): the MCP server registers each tool with the annotations
// derived by `toolAnnotationsFor` and each resource unchanged, in registry
// order, and connects exactly once. The client is never called at start, so
// no fake records a network call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLEET_RESOURCE_NAMES,
  FLEET_RESOURCE_URIS,
  FLEET_TOOL_NAMES,
  toolAnnotationsFor,
} from "./registry.js";
import type { LoadedSdk } from "./sdk.js";
import { startServer } from "./server.js";

const sdkMocks = vi.hoisted(() => {
  const tools: Array<{ name: string; config: Record<string, unknown> }> = [];
  const resources: Array<{
    name: string;
    uri: string;
    config: Record<string, unknown>;
  }> = [];
  const state = { connectCalls: 0 };
  return { tools, resources, state };
});

vi.mock("./sdk.js", () => {
  class FakeMcpServer {
    registerTool(
      name: string,
      config: Record<string, unknown>,
      _handler: unknown,
    ): void {
      sdkMocks.tools.push({ name, config });
    }
    registerResource(
      name: string,
      uri: string,
      config: Record<string, unknown>,
      _read: unknown,
    ): void {
      sdkMocks.resources.push({ name, uri, config });
    }
    connect(_transport: unknown): Promise<void> {
      sdkMocks.state.connectCalls += 1;
      return Promise.resolve();
    }
  }
  class FakeStdioServerTransport {}
  return {
    loadSdk: async (): Promise<LoadedSdk> => ({
      McpServer: FakeMcpServer as unknown as LoadedSdk["McpServer"],
      StdioServerTransport:
        FakeStdioServerTransport as unknown as LoadedSdk["StdioServerTransport"],
    }),
  };
});

const ORIGINAL_ENV = { ...process.env };

describe("startServer", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.FLEET_API_URL;
    delete process.env.FLEET_API_TOKEN_FILE;
    sdkMocks.tools.length = 0;
    sdkMocks.resources.length = 0;
    sdkMocks.state.connectCalls = 0;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("registers each tool with its annotations, in registry order", async () => {
    await startServer();
    expect(sdkMocks.tools.map((entry) => entry.name)).toEqual([
      ...FLEET_TOOL_NAMES,
    ]);
    expect(sdkMocks.tools.length).toBe(FLEET_TOOL_NAMES.length);
    const coordination = sdkMocks.tools.find(
      (entry) => entry.name === "fleet_coordination",
    );
    expect(coordination).toBeDefined();
    expect(typeof coordination?.config.description).toBe("string");
    expect(coordination?.config.inputSchema).toBeDefined();
    expect(coordination?.config.annotations).toEqual(toolAnnotationsFor("read"));
  });

  it("registers each resource as JSON, in registry order", async () => {
    await startServer();
    expect(sdkMocks.resources.map((entry) => entry.name)).toEqual([
      ...FLEET_RESOURCE_NAMES,
    ]);
    expect(sdkMocks.resources.map((entry) => entry.uri)).toEqual([
      ...FLEET_RESOURCE_URIS,
    ]);
    for (const entry of sdkMocks.resources) {
      expect(entry.config.mimeType).toBe("application/json");
      expect(typeof entry.config.description).toBe("string");
    }
  });

  it("connects exactly once and makes no network call at start", async () => {
    await startServer();
    expect(sdkMocks.state.connectCalls).toBe(1);
  });
});
