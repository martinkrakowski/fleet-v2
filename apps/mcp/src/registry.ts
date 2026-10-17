// Static registry of the MCP tools and resources this server exposes (work
// order item 1). The set is fixed here in code — nothing is registered
// dynamically from input — and every handler calls exactly one /v1 route
// through the /v1 client (never fetch directly).
import { z } from "zod";
import type { FleetApiClient } from "./client.js";
import {
  toResourceResult,
  toToolResult,
  type McpResourceResult,
  type McpToolResult,
} from "./envelope.js";

/** The only tool names this server ever exposes. */
export const FLEET_TOOL_NAMES = ["fleet_coordination"] as const;

/** The only resource names this server ever exposes. */
export const FLEET_RESOURCE_NAMES = [
  "fleet_coordination",
  "fleet_capabilities",
  "fleet_attention",
] as const;

/** The only resource URIs this server ever exposes. */
export const FLEET_RESOURCE_URIS = [
  "fleet://coordination",
  "fleet://capabilities",
  "fleet://attention",
] as const;

export interface FleetToolDefinition {
  name: string;
  description: string;
  /** Zod input schema; strict, so any extra key (a path, a URL) is rejected. */
  inputSchema: z.ZodType;
  handler: () => Promise<McpToolResult>;
}

export interface FleetResourceDefinition {
  name: string;
  uri: string;
  description: string;
  handler: () => Promise<McpResourceResult>;
}

export interface FleetRegistry {
  tools: readonly FleetToolDefinition[];
  resources: readonly FleetResourceDefinition[];
}

const COORDINATION_ROUTE = "/v1/coordination";
const CAPABILITIES_ROUTE = "/v1/capabilities";
const ATTENTION_ROUTE = "/v1/attention";

/** Build the registry. The tool/resource set never depends on runtime input. */
export function buildRegistry(client: FleetApiClient): FleetRegistry {
  const toolFor = (route: string) => async () =>
    toToolResult(await client.get(route));
  const resourceFor = (route: string, uri: string) => async () =>
    toResourceResult(await client.get(route), uri);

  const tools: FleetToolDefinition[] = [
    {
      name: "fleet_coordination",
      description:
        "Outstanding fleet coordination: what currently needs the owner or the orchestrator. Takes no input.",
      inputSchema: z.strictObject({}),
      handler: toolFor(COORDINATION_ROUTE),
    },
  ];

  const resources: FleetResourceDefinition[] = [
    {
      name: "fleet_coordination",
      uri: "fleet://coordination",
      description:
        "The /v1 coordination envelope: outstanding coordination — what currently needs the owner or the orchestrator.",
      handler: resourceFor(COORDINATION_ROUTE, "fleet://coordination"),
    },
    {
      name: "fleet_capabilities",
      uri: "fleet://capabilities",
      description:
        "The /v1 capabilities envelope: configured runner capabilities and their source.",
      handler: resourceFor(CAPABILITIES_ROUTE, "fleet://capabilities"),
    },
    {
      name: "fleet_attention",
      uri: "fleet://attention",
      description:
        'The /v1 attention envelope: project attention items. Answers "unavailable" until Waves is wired.',
      handler: resourceFor(ATTENTION_ROUTE, "fleet://attention"),
    },
  ];

  return { tools, resources };
}
