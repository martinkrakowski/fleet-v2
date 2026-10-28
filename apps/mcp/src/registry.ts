// Static registry of the MCP tools and resources this server exposes (work
// order item 1). The set is fixed here in code — nothing is registered
// dynamically from input — and every handler calls exactly one /v1 route
// through the /v1 client (never fetch directly). Each entry declares its
// kind, scope and (for tools) MCP annotations; the layout stays this one file
// until hexagen answers HM2 (plan D2).
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

/** What a tool does (MCP tooling plan §3.3): `read` reads; `mutating` creates one record that asks and never acts. */
export const FLEET_TOOL_KINDS = ["read", "mutating"] as const;
export type FleetToolKind = (typeof FLEET_TOOL_KINDS)[number];

/**
 * The scopes a registry entry may need (plan §3.3, §3.7). The MCP token holds `read` and `message`, never more;
 * the API enforces them once T3a lands. Until then only `read` tools ship (D10).
 */
export const FLEET_TOOL_SCOPES = ["read", "message"] as const;
export type FleetToolScope = (typeof FLEET_TOOL_SCOPES)[number];

/** MCP tool annotations as this server sets them. Hints for the client, never a control. */
export interface FleetToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

const READ_ANNOTATIONS: FleetToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const MUTATING_ANNOTATIONS: FleetToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * The annotations a kind implies (plan §3.3): reads are read-only; a mutating tool creates one record keyed by a
 * client-minted idempotency key, so it is idempotent and never destructive. Every tool reaches only fleet's own
 * /v1, so none is open-world.
 */
export function toolAnnotationsFor(kind: FleetToolKind): FleetToolAnnotations {
  if (kind === "read") {
    return READ_ANNOTATIONS;
  }
  return MUTATING_ANNOTATIONS;
}

export interface FleetToolDefinition {
  name: string;
  description: string;
  /** `read` or `mutating` (plan §3.3). */
  kind: FleetToolKind;
  /** The scope the token needs for this tool: `read` for reads, `message` for mutating tools. */
  scope: FleetToolScope;
  /** Derived from `kind` by `toolAnnotationsFor`; passed to the MCP client as tool annotations. */
  annotations: FleetToolAnnotations;
  /** Zod input schema; strict, so any extra key (a path, a URL) is rejected. */
  inputSchema: z.ZodType;
  handler: () => Promise<McpToolResult>;
}

export interface FleetResourceDefinition {
  name: string;
  uri: string;
  description: string;
  /** Resources are reads: always `read`. */
  scope: FleetToolScope;
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
      kind: "read",
      scope: "read",
      annotations: toolAnnotationsFor("read"),
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
      scope: "read",
      handler: resourceFor(COORDINATION_ROUTE, "fleet://coordination"),
    },
    {
      name: "fleet_capabilities",
      uri: "fleet://capabilities",
      description:
        "The /v1 capabilities envelope: configured runner capabilities and their source.",
      scope: "read",
      handler: resourceFor(CAPABILITIES_ROUTE, "fleet://capabilities"),
    },
    {
      name: "fleet_attention",
      uri: "fleet://attention",
      description:
        'The /v1 attention envelope: project attention items. Answers "unavailable" until Waves is wired.',
      scope: "read",
      handler: resourceFor(ATTENTION_ROUTE, "fleet://attention"),
    },
  ];

  return { tools, resources };
}
