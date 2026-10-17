// Composition root for the stdio MCP server. Everything is registered from
// the static registry; every tool and resource calls /v1 through the client
// built from FLEET_API_URL and FLEET_API_TOKEN_FILE below. Without both, the
// client answers "not configured" to every call.
import {
  createFleetApiClient,
  readApiTokenFromFile,
  type FleetApiClient,
} from "./client.js";
import { buildRegistry } from "./registry.js";
import { loadSdk } from "./sdk.js";

function clientFromEnv(): FleetApiClient {
  return createFleetApiClient({
    baseUrl: process.env.FLEET_API_URL ?? "",
    readToken: () =>
      readApiTokenFromFile(process.env.FLEET_API_TOKEN_FILE ?? ""),
  });
}

export async function startServer(): Promise<void> {
  const { McpServer, StdioServerTransport } = await loadSdk();
  const registry = buildRegistry(clientFromEnv());
  const server = new McpServer({ name: "fleet-v2", version: "0.1.0" });
  for (const tool of registry.tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async () => tool.handler(),
    );
  }
  for (const resource of registry.resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: "application/json" },
      async () => resource.handler(),
    );
  }
  await server.connect(new StdioServerTransport());
}
