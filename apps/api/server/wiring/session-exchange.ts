import { randomBytes, timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";
import {
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
} from "h3";

/**
 * T3b: the session exchange mints in-memory, scope-bound tokens. It does not
 * read anything from disk: possession of a reusable file-backed bearer credential
 * is never treated as proof of an interactive session. Instead, an interactive
 * session is established server-side (by the TUI or web login lanes through
 * `registerInteractiveSession`), and the exchange authenticates the request by
 * the session's per-session secret. The minted token binds to the verified
 * actor and scopes, and never holds `orchestrate` or any dispatch authority.
 */

export const SESSION_EXCHANGE_PATH = "/sessions/exchange";
export const SESSION_EXCHANGE_HEADER = "x-fleet-session-exchange";

/** Everything mintable except `orchestrate` (D-R10; orchestrator-interaction-plan.md:206-207). */
export const MINTABLE_SESSION_SCOPES = [
  "read", "message", "hook", "verdict", "operate", "tail",
] as const;

const LIVE_SESSION_LIMIT = 16;

/**
 * A server-established interactive session: the login lane created it (in
 * memory only) and the client holds its `secret`, which the exchange verifies.
 * The actor and permitted scopes are established with the session and are never
 * supplied by the exchange caller.
 */
export interface InteractiveSession {
  readonly sessionId: string;
  readonly actor: string;
  readonly secret: string;
  readonly scopes: readonly string[];
}

interface MintedToken {
  readonly tokenId: string;
  readonly actor: string;
  readonly scopes: readonly string[];
}

const liveSessions = new Map<string, InteractiveSession>(); // sessionId -> session, memory only
const liveTokens = new Map<string, MintedToken>(); // token value -> record, memory only

/**
 * Reset the session exchange: forget every established session and every minted
 * token. Callers pass `null` (tests, operator reset). The exchange therefore
 * starts disabled — with no session registered every exchange request fails
 * closed. Login lanes establish sessions through `registerInteractiveSession`,
 * never from a file-backed credential.
 */
export function configureSessionExchange(_credential: string | null): void {
  liveSessions.clear();
  liveTokens.clear();
}

/**
 * Establish a server-side interactive session. Called by the TUI/web login lanes
 * after authenticating the owner; tests call it directly. Returns the per-session
 * secret the client presents to the exchange.
 */
export function registerInteractiveSession(input: {
  actor: string;
  scopes: readonly string[];
}): { sessionId: string; secret: string } {
  const actor = input.actor.trim();
  const scopes = [...input.scopes];
  if (
    actor.length === 0 ||
    scopes.length === 0 ||
    scopes.some((s) => typeof s !== "string" || s.length === 0)
  ) {
    throw new Error("invalid interactive session");
  }
  const sessionId = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  liveSessions.set(sessionId, { sessionId, actor, secret, scopes });
  return { sessionId, secret };
}

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function exchangeForbidden(event: H3Event): { error: string } {
  setResponseStatus(event, 403);
  setResponseHeader(event, "content-type", "application/json");
  setResponseHeader(event, "cache-control", "no-store");
  return { error: "Forbidden: session exchange requires the interactive session credential" };
}

function sessionBySecret(secret: string): InteractiveSession | null {
  for (const session of liveSessions.values()) {
    if (constantTimeMatch(session.secret, secret)) {
      return session;
    }
  }
  return null;
}

/**
 * Middleware-side gate for `SESSION_EXCHANGE_PATH`. Returns `undefined` when the
 * request presents the secret of an established interactive session; otherwise a
 * 403 body that never echoes the presented value. Fail closed.
 */
export function authenticateSessionExchange(event: H3Event): { error: string } | undefined {
  const secret = getRequestHeader(event, SESSION_EXCHANGE_HEADER);
  if (typeof secret !== "string" || secret.length === 0) {
    return exchangeForbidden(event);
  }
  if (sessionBySecret(secret) === null) {
    return exchangeForbidden(event);
  }
  return undefined;
}

/** The authenticated session for the current exchange request, or null. */
export function currentExchangeSession(event: H3Event): InteractiveSession | null {
  const secret = getRequestHeader(event, SESSION_EXCHANGE_HEADER);
  if (typeof secret !== "string") {
    return null;
  }
  return sessionBySecret(secret);
}

/**
 * Mint an in-memory token bound to the verified session actor and scopes. Fail
 * closed (return null) unless every requested scope is mintable and permitted for
 * the session; the live-token limit also refuses. The caller-supplied scopes are
 * never treated as proof: the session's permitted scopes gate them.
 */
export function mintSessionToken(
  session: InteractiveSession,
  requestedScopes: unknown,
): { tokenId: string; token: string; scopes: string[]; actor: string } | null {
  if (!Array.isArray(requestedScopes) || requestedScopes.length === 0) {
    return null;
  }
  const scopes: string[] = [];
  for (const requested of requestedScopes) {
    if (typeof requested !== "string") {
      return null;
    }
    if (!(MINTABLE_SESSION_SCOPES as readonly string[]).includes(requested)) {
      return null;
    }
    if (!session.scopes.includes(requested)) {
      return null;
    }
    if (!scopes.includes(requested)) {
      scopes.push(requested);
    }
  }
  if (liveTokens.size >= LIVE_SESSION_LIMIT) {
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  const tokenId = randomBytes(16).toString("hex");
  liveTokens.set(token, { tokenId, actor: session.actor, scopes });
  return { tokenId, token, scopes, actor: session.actor };
}

/**
 * Resolve an `Authorization: Bearer` value to the matching live session token, or
 * null. Fresh copies only (presented-token.ts:37-40 pattern).
 */
export function resolveSessionToken(
  event: H3Event,
): { tokenId: string; scopes: string[]; actor: string } | null {
  const authHeader = readAuthorizationHeader(event);
  if (authHeader === null || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const candidate = authHeader.slice("Bearer ".length).trim();
  const record = liveTokens.get(candidate);
  if (!record) {
    return null;
  }
  return { tokenId: record.tokenId, scopes: [...record.scopes], actor: record.actor };
}

function readAuthorizationHeader(event: H3Event): string | null {
  try {
    const value = getRequestHeader(event, "authorization");
    return typeof value === "string" ? value : null;
  } catch {
    // A non-HTTP event (unit callers) has no readable headers: no session token.
    return null;
  }
}

export function isSessionExchangePath(path: string): boolean {
  return path === SESSION_EXCHANGE_PATH;
}
