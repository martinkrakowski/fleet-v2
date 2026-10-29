// Dynamic-import wrapper for `@modelcontextprotocol/sdk` (ADR-0010).
//
// The SDK ships `node:`-scheme imports that break bundling when imported
// statically, so it is loaded at runtime via `import()` instead. A side
// benefit: a missing SDK fails here, with a clear install hint, rather than
// breaking the build.
//
// The SDK is loaded at runtime, so its types are not statically available
// here; callers treat the returned values structurally.

export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  /**
   * Register a tool. `inputSchema` is a zod schema (raw shape or object
   * schema); the handler receives the parsed tool arguments and returns a
   * CallToolResult-shaped object. `annotations` are MCP tool hints (read-only,
   * destructive, idempotent, open-world).
   */
  registerTool(
    name: string,
    config: {
      description?: string;
      inputSchema?: unknown;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    handler: (args: unknown) => Promise<unknown>,
  ): unknown;
  /** Register a static resource; the read callback returns a ReadResourceResult-shaped object. */
  registerResource(
    name: string,
    uri: string,
    config: {
      description?: string;
      mimeType?: string;
    },
    read: () => Promise<unknown>,
  ): unknown;
}

export type StdioTransportLike = object;

export interface LoadedSdk {
  McpServer: new (info: { name: string; version: string }, options?: unknown) => McpServerLike;
  StdioServerTransport: new () => StdioTransportLike;
}

let cached: Promise<LoadedSdk> | null = null;

export function loadSdk(): Promise<LoadedSdk> {
  cached ??= Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
  ])
    .then(([mod, stdio]) => ({
      McpServer: mod.McpServer as LoadedSdk["McpServer"],
      StdioServerTransport:
        stdio.StdioServerTransport as LoadedSdk["StdioServerTransport"],
    }))
    .catch((cause: unknown) => {
      cached = null;
      throw new Error(
        "Failed to load @modelcontextprotocol/sdk. Install it: `npm install @modelcontextprotocol/sdk zod`.",
        { cause },
      );
    });
  return cached;
}
