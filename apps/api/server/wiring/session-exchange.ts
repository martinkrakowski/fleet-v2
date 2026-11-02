import { randomBytes, timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";
import {
  getMethod,
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
} from "h3";

/**
 * T3b: the session exchange mints in-memory, scope-bound tokens for a
 * server-established interactive session. It does not read anything from disk:
 * possession of a reusable file-backed bearer credential — including the active
 * API bearer — is never treated as proof of an interactive session. Sessions
 * are established server-side by the login lanes (the TUI/web logins) through
 * `registerInteractiveSession`, which records the verified actor and the
 * permitted scopes the login granted. The exchange authenticates a request by
 * the session's per-session secret, never by a caller-supplied actor or scope
 * list. The minted token binds to the session's verified actor and scopes, and
 * never holds `orchestrate` or any dispatch authority.
 */

export const SESSION_EXCHANGE_PATH = "/sessions/exchange";
export const SESSION_EXCHANGE_HEADER = "x-fleet-session-exchange";

/** Everything mintable except `orchestrate` (D-R10; orchestrator-interaction-plan.md:206-207). */
export const MINTABLE_SESSION_SCOPES = [
  "read", "message", "hook", "verdict", "operate", "tail",
] as const;

export const LIVE_SESSION_LIMIT = 16;
export const TOKENS_PER_SESSION_LIMIT = 16;

/** An actor: at most 128 characters of [A-Za-z0-9._@-]. */
export const ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;
export const ACTOR_REFUSAL_REASON = "actor must be at most 128 characters of [A-Za-z0-9._@-]";

export function isValidActor(actor: unknown): actor is string {
  return typeof actor === "string" && ACTOR_PATTERN.test(actor);
}

export function validateActor(actor: unknown): { ok: true; actor: string } | { ok: false; reason: string } {
  if (!isValidActor(actor)) {
    return { ok: false, reason: ACTOR_REFUSAL_REASON };
  }
  return { ok: true, actor };
}

/**
 * A server-established interactive session: the login lane created it (in
 * memory only) after authenticating the owner, and the client holds its
 * `secret`, which the exchange verifies. The actor and permitted scopes are
 * established with the session by the login lane; the exchange never accepts
 * either from an HTTP caller.
 */
export interface InteractiveSession {
  readonly sessionId: string;
  readonly actor: string;
  readonly secret: string;
  readonly scopes: readonly string[];
}

interface MintedToken {
  readonly tokenId: string;
  readonly sessionId: string;
  readonly actor: string;
  readonly scopes: readonly string[];
}

const liveSessions = new Map<string, InteractiveSession>(); // sessionId -> session, memory only
const liveTokens = new Map<string, MintedToken>(); // token value -> record, memory only

/**
 * Reset the session exchange: forget every established session and every minted
 * token. With no session registered every exchange request fails closed. Login
 * lanes establish sessions through `registerInteractiveSession`, never from a
 * file-backed credential.
 */
export function configureSessionExchange(): void {
  liveSessions.clear();
  liveTokens.clear();
}

/**
 * Establish a server-side interactive session for a verified actor. Called by
 * the login lanes (TUI/web logins) after they authenticate the owner; the actor
 * and permitted scopes are facts of that login, never proof a caller presents to
 * the exchange. The scopes are accepted only when every one is mintable (never
 * `orchestrate` or `dispatch`), and the actor must be at most 128 characters of
 * `[A-Za-z0-9._@-]`; the returned `secret` is the per-session credential the
 * client presents to the exchange. Returns `{ sessionId, secret, scopes, actor }`,
 * or `null` when the actor or scopes fail (fail closed; the reason is never echoed).
 */
// Seam that T6's login calls; nothing calls it yet, so no session can exist until then.
export function registerInteractiveSession(input: {
  actor: string;
  scopes: readonly string[];
}): { sessionId: string; secret: string; scopes: readonly string[]; actor: string } | null {
  if (liveSessions.size >= LIVE_SESSION_LIMIT) {
    return null;
  }
  if (!isValidActor(input.actor)) {
    return null;
  }
  const actor = input.actor;
  if (!Array.isArray(input.scopes)) {
    return null;
  }
  const scopes: string[] = [];
  for (const scope of input.scopes) {
    if (
      typeof scope !== "string" ||
      scope.length === 0 ||
      !(MINTABLE_SESSION_SCOPES as readonly string[]).includes(scope)
    ) {
      return null;
    }
    if (!scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  if (scopes.length === 0) {
    return null;
  }
  const sessionId = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const session: InteractiveSession = { sessionId, actor, secret, scopes };
  liveSessions.set(sessionId, session);
  return { sessionId, secret, scopes, actor };
}

/**
 * Remove an established interactive session and every token minted for it.
 * Subsequent exchange requests for this session and requests presenting any of
 * its minted tokens fail closed.
 */
export function dropInteractiveSession(sessionId: string): boolean {
  const sessionExisted = liveSessions.delete(sessionId);
  for (const [token, record] of liveTokens.entries()) {
    if (record.sessionId === sessionId) {
      liveTokens.delete(token);
    }
  }
  return sessionExisted;
}

export function getInteractiveSession(sessionId: string): InteractiveSession | null {
  const session = liveSessions.get(sessionId);
  if (!session) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    actor: session.actor,
    secret: session.secret,
    scopes: [...session.scopes],
  };
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

function isPostMethod(event: H3Event): boolean {
  try {
    return getMethod(event).toUpperCase() === "POST";
  } catch {
    return false;
  }
}

/**
 * Middleware-side gate for `SESSION_EXCHANGE_PATH`. Returns `undefined` when the
 * request presents the secret of an established interactive session; otherwise a
 * 403 body that never echoes the presented value. Fail closed.
 */
export function authenticateSessionExchange(event: H3Event): { error: string } | undefined {
  if (!isPostMethod(event)) {
    return exchangeForbidden(event);
  }
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
  if (!isPostMethod(event)) {
    return null;
  }
  const secret = getRequestHeader(event, SESSION_EXCHANGE_HEADER);
  if (typeof secret !== "string") {
    return null;
  }
  return sessionBySecret(secret);
}

function countTokensForSession(sessionId: string): number {
  let count = 0;
  for (const record of liveTokens.values()) {
    if (record.sessionId === sessionId) {
      count += 1;
    }
  }
  return count;
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
): { tokenId: string; token: string; scopes: string[]; actor: string; sessionId: string } | null {
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
  if (countTokensForSession(session.sessionId) >= TOKENS_PER_SESSION_LIMIT) {
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  const tokenId = randomBytes(16).toString("hex");
  liveTokens.set(token, { tokenId, sessionId: session.sessionId, actor: session.actor, scopes });
  return { tokenId, token, scopes, actor: session.actor, sessionId: session.sessionId };
}

/**
 * Resolve an `Authorization: Bearer` value to the matching live session token, or
 * null. Fresh copies only (presented-token.ts:37-40 pattern).
 */
export function resolveSessionToken(
  event: H3Event,
): { tokenId: string; sessionId: string; scopes: string[]; actor: string } | null {
  const authHeader = readAuthorizationHeader(event);
  if (authHeader === null || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const candidate = authHeader.slice("Bearer ".length).trim();
  const record = liveTokens.get(candidate);
  if (!record) {
    return null;
  }
  return {
    tokenId: record.tokenId,
    sessionId: record.sessionId,
    scopes: [...record.scopes],
    actor: record.actor,
  };
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
