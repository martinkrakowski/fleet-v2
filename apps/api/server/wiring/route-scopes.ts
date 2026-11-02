/**
 * T3a: the frozen seven scopes and the route -> scope mapping enforced by the
 * security middleware. Every existing /v1 route maps to exactly one of the
 * seven; any path without a mapping fails closed (null).
 */

export const FROZEN_SCOPES = [
  "read",
  "message",
  "hook",
  "verdict",
  "operate",
  "orchestrate",
  "tail",
] as const;

/** Existing GET routes under /v1 ([param] -> :param), each served with `read`. */
const GET_ROUTE_PATTERNS: readonly string[] = [
  "/v1/questions",
  "/v1/questions/:id",
  "/v1/attempts",
  "/v1/attempts/:id",
  "/v1/attempts/:id/journal",
  "/v1/runs",
  "/v1/runs/passes",
  "/v1/changes",
  "/v1/work-orders/:id",
  "/v1/coordination",
  "/v1/attention",
  "/v1/capabilities",
  "/v1/snapshots",
  "/v1/projects",
  "/v1/projects/unregistered",
  "/v1/projects/:id",
  "/v1/orchestrators",
  "/v1/heads/:sha/evidence",
];

/** Prefix -> scope for every mutation (non-GET) route under /v1. */
const MUTATION_PREFIX_SCOPES: ReadonlyArray<readonly [string, string]> = [
  ["/v1/orchestrators/", "orchestrate"],
  ["/v1/orchestrators", "orchestrate"],
  ["/v1/snapshots/", "orchestrate"],
  ["/v1/questions", "message"],
  ["/v1/relays", "message"],
  ["/v1/reviews", "verdict"],
  ["/v1/decisions", "verdict"],
  ["/v1/authorizations", "hook"],
  ["/v1/forge", "hook"],
  ["/v1/attempts", "operate"],
  ["/v1/verifications", "operate"],
  ["/v1/observations", "operate"],
  ["/v1/findings", "operate"],
  ["/v1/work-orders", "operate"],
  ["/v1/heads/", "operate"],
  ["/v1/knowledge", "operate"],
  ["/v1/projects", "operate"],
];

function isV1Path(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

function matchesSegmentPattern(path: string, pattern: string): boolean {
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  if (pathSegments.length !== patternSegments.length) {
    return false;
  }
  for (let i = 0; i < patternSegments.length; i++) {
    const expected = patternSegments[i];
    if (expected.startsWith(":")) {
      if (pathSegments[i] === "") {
        return false;
      }
      continue;
    }
    if (expected !== pathSegments[i]) {
      return false;
    }
  }
  return true;
}

function matchesPathPrefix(path: string, prefix: string): boolean {
  if (path === prefix) {
    return true;
  }
  if (prefix.endsWith("/")) {
    return path.startsWith(prefix);
  }
  return path.startsWith(`${prefix}/`);
}

export function requiredScope(method: string, requestPath: string): string | null {
  if (!isV1Path(requestPath)) {
    return null;
  }
  if (method.toUpperCase() === "GET") {
    for (const pattern of GET_ROUTE_PATTERNS) {
      if (matchesSegmentPattern(requestPath, pattern)) {
        return "read";
      }
    }
    return null;
  }
  for (const [prefix, scope] of MUTATION_PREFIX_SCOPES) {
    if (matchesPathPrefix(requestPath, prefix)) {
      return scope;
    }
  }
  return null;
}
