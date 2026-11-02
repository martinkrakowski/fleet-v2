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

/** Method and pattern -> scope for every mutation (non-GET) route under /v1. */
const MUTATION_ROUTE_RULES: ReadonlyArray<readonly [string, string, string]> = [
  ["POST", "/v1/orchestrators", "orchestrate"],
  ["POST", "/v1/orchestrators/:id/heartbeat", "orchestrate"],
  ["POST", "/v1/orchestrators/:id/retire", "orchestrate"],
  ["POST", "/v1/snapshots/:section", "orchestrate"],
  ["POST", "/v1/questions", "message"],
  ["POST", "/v1/questions/:id/answers", "message"],
  ["POST", "/v1/questions/:id/acknowledgement", "message"],
  ["POST", "/v1/questions/sync", "message"],
  ["POST", "/v1/questions/expire", "message"],
  ["POST", "/v1/relays", "message"],
  ["POST", "/v1/relays/:id/acknowledgement", "message"],
  ["POST", "/v1/reviews", "verdict"],
  ["POST", "/v1/reviews/:id/receipt", "verdict"],
  ["POST", "/v1/decisions", "verdict"],
  ["POST", "/v1/authorizations/resolve", "hook"],
  ["POST", "/v1/authorizations/:id/consume", "hook"],
  ["POST", "/v1/forge", "hook"],
  ["POST", "/v1/attempts/:id/stop", "operate"],
  ["POST", "/v1/attempts/:id/reconcile", "operate"],
  ["POST", "/v1/attempts/:id/fix", "operate"],
  ["POST", "/v1/attempts/:id/acceptance", "operate"],
  ["POST", "/v1/attempts/:id/cancel-prepared", "operate"],
  ["POST", "/v1/attempts/:id/artifacts", "operate"],
  ["POST", "/v1/attempts/:id/notes", "operate"],
  ["POST", "/v1/verifications", "operate"],
  ["POST", "/v1/verifications/:id/receipt", "operate"],
  ["POST", "/v1/observations", "operate"],
  ["POST", "/v1/findings/:id/disposition", "operate"],
  ["POST", "/v1/work-orders", "operate"],
  ["POST", "/v1/heads/:sha/assessment", "operate"],
  ["POST", "/v1/knowledge/checks", "operate"],
  ["POST", "/v1/knowledge/:id/disposition", "operate"],
  ["POST", "/v1/projects", "operate"],
  ["POST", "/v1/projects/:id/retire", "operate"],
  ["POST", "/v1/projects/:id/probe", "operate"],
  ["PATCH", "/v1/projects/:id", "operate"],
];

function isV1Path(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURI(segment);
  } catch {
    return segment;
  }
}

export function normalizePath(path: string): string {
  const qIndex = path.indexOf("?");
  let pathWithoutQuery = path;
  if (qIndex !== -1) {
    pathWithoutQuery = path.slice(0, qIndex);
  }
  const segments = pathWithoutQuery.split("/");
  const decoded = segments.map(decodeSegment).join("/");
  if (decoded.length > 1 && decoded.endsWith("/")) {
    return decoded.slice(0, -1);
  }
  return decoded;
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

export function requiredScope(method: string, requestPath: string): string | null {
  const normalized = normalizePath(requestPath);
  if (!isV1Path(normalized)) {
    return null;
  }
  const upperMethod = method.toUpperCase();
  if (upperMethod === "GET") {
    for (const pattern of GET_ROUTE_PATTERNS) {
      if (matchesSegmentPattern(normalized, pattern)) {
        return "read";
      }
    }
    return null;
  }
  for (const [m, pattern, scope] of MUTATION_ROUTE_RULES) {
    if (m === upperMethod && matchesSegmentPattern(normalized, pattern)) {
      return scope;
    }
  }
  return null;
}
