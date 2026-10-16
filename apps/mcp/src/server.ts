// Composition root for the stdio MCP server. Tools arrive in M1b; the
// registry is intentionally empty for this lane.
import { loadSdk } from "./sdk.js";

export async function startServer(): Promise<void> {
  const { McpServer } = await loadSdk();
  const server = new McpServer({ name: "fleet-v2", version: "0.1.0" });
  // No tools registered yet (lane M1b registers the first ones).
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  await server.connect(new StdioServerTransport());
}
