// SDK loader tests (VB23): `loadSdk()` memoises the loading promise so both
// SDK specifiers are imported exactly once per module instance, maps a failed
// dynamic import to a clear install-hint error preserving the original cause,
// and clears the memo on failure so a later call recovers without a module
// reset.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  class FakeMcpServer {}
  class FakeStdioServerTransport {}
  return { FakeMcpServer, FakeStdioServerTransport };
});
const { FakeMcpServer, FakeStdioServerTransport } = fakes;

const MCP_SPECIFIER = "@modelcontextprotocol/sdk/server/mcp.js";
const STDIO_SPECIFIER = "@modelcontextprotocol/sdk/server/stdio.js";

describe("loadSdk", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock(MCP_SPECIFIER);
    vi.doUnmock(STDIO_SPECIFIER);
  });

  it("memoises the loading promise so repeated calls reuse one load and each SDK specifier is imported exactly once", async () => {
    const calls = { mcp: 0, stdio: 0 };
    vi.doMock(MCP_SPECIFIER, () => {
      calls.mcp += 1;
      return { McpServer: FakeMcpServer };
    });
    vi.doMock(STDIO_SPECIFIER, () => {
      calls.stdio += 1;
      return { StdioServerTransport: FakeStdioServerTransport };
    });
    const { loadSdk } = await import("./sdk.js");

    const first = loadSdk();
    const second = loadSdk();

    expect(second).toBe(first);
    const loaded = await first;
    const awaited = await second;
    expect(loaded).toEqual({
      McpServer: FakeMcpServer,
      StdioServerTransport: FakeStdioServerTransport,
    });
    expect(awaited).toEqual({
      McpServer: FakeMcpServer,
      StdioServerTransport: FakeStdioServerTransport,
    });
    expect(calls.mcp).toBe(1);
    expect(calls.stdio).toBe(1);
  });

  it("rejects with the install-hint error preserving the original cause when the mcp.js specifier fails to load", async () => {
    const originalError = new Error("missing mcp");
    // A throwing getter instead of a throwing factory: vitest wraps factory
    // errors into its own error, while the getter throws exactly when `sdk.ts`
    // reads the binding, so the original error object reaches `.catch` intact.
    vi.doMock(MCP_SPECIFIER, () => ({
      get McpServer(): unknown {
        throw originalError;
      },
    }));
    vi.doMock(STDIO_SPECIFIER, () => ({
      StdioServerTransport: FakeStdioServerTransport,
    }));
    const { loadSdk } = await import("./sdk.js");

    await expect(loadSdk()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const failure = error as Error & { cause?: unknown };
      expect(failure.message.startsWith("Failed to load @modelcontextprotocol/sdk")).toBe(true);
      expect(failure.message.includes("npm install @modelcontextprotocol/sdk zod")).toBe(true);
      expect(failure.cause).toBe(originalError);
      return true;
    });
  });

  it("rejects with the install-hint error preserving the original cause when the stdio.js specifier fails to load", async () => {
    const originalError = new Error("missing stdio");
    vi.doMock(MCP_SPECIFIER, () => ({ McpServer: FakeMcpServer }));
    // A throwing getter instead of a throwing factory, for the same reason as
    // in the mcp.js failure test.
    vi.doMock(STDIO_SPECIFIER, () => ({
      get StdioServerTransport(): unknown {
        throw originalError;
      },
    }));
    const { loadSdk } = await import("./sdk.js");

    await expect(loadSdk()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const failure = error as Error & { cause?: unknown };
      expect(failure.message.startsWith("Failed to load @modelcontextprotocol/sdk")).toBe(true);
      expect(failure.message.includes("npm install @modelcontextprotocol/sdk zod")).toBe(true);
      expect(failure.cause).toBe(originalError);
      return true;
    });
  });

  it("clears the memo after a rejection so a subsequent call on the same loadSdk retries and resolves without a module reset", async () => {
    vi.doMock(MCP_SPECIFIER, () => {
      throw new Error("temporary failure");
    });
    vi.doMock(STDIO_SPECIFIER, () => ({
      StdioServerTransport: FakeStdioServerTransport,
    }));
    const { loadSdk } = await import("./sdk.js");

    await expect(loadSdk()).rejects.toThrow(
      "Failed to load @modelcontextprotocol/sdk",
    );

    vi.doMock(MCP_SPECIFIER, () => ({ McpServer: FakeMcpServer }));

    await expect(loadSdk()).resolves.toEqual({
      McpServer: FakeMcpServer,
      StdioServerTransport: FakeStdioServerTransport,
    });
  });
});
