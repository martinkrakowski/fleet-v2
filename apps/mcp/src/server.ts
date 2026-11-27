// Composition root for the stdio MCP server. Everything is registered from
// the static registry; every tool and resource calls /v1 through the client
// built from FLEET_API_URL and FLEET_API_TOKEN_FILE below. Without both, the
// client answers "not configured" to every call.
import {
  createFleetApiClient,
  readApiTokenFromFile,
  type FleetApiClient,
} from "./client.js";
import {
  attachProcessLifecycleHooks,
  createOrchestratorLifecycle,
  parseOrchestratorCliArgs,
} from "./orchestrator-lifecycle.js";
import { buildRegistry } from "./registry.js";
import { loadSdk } from "./sdk.js";

function clientFromEnv(): FleetApiClient {
  return createFleetApiClient({
    baseUrl: process.env.FLEET_API_URL ?? "",
    readToken: () =>
      readApiTokenFromFile(process.env.FLEET_API_TOKEN_FILE ?? ""),
  });
}

export interface StartServerOptions {
  argv?: readonly string[];
  client?: FleetApiClient;
}

export async function startServer(options?: StartServerOptions): Promise<void> {
  // Orchestrator identity comes only from the CLI argv, never the environment.
  const parsed = parseOrchestratorCliArgs(options?.argv ?? []);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const client = options?.client ?? clientFromEnv();
  const { McpServer, StdioServerTransport } = await loadSdk();
  const registry = buildRegistry(client);
  const server = new McpServer({ name: "fleet-v2", version: "0.1.0" });
  for (const tool of registry.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown) => tool.handler(args),
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
  const lifecycle = createOrchestratorLifecycle({
    client,
    config: parsed.config,
  });
  // Hooks go on before registration so a shutdown signal or stdin close during
  // a slow register() is still caught and the session gets retired.
  attachProcessLifecycleHooks(lifecycle);
  // Non-fatal: registration refusal or failure never stops the stdio server.
  await lifecycle.start();
}
