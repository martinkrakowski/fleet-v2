// POST /sessions/exchange — mint an in-memory scoped token for an established
// interactive session (T3b). The security middleware has already authenticated
// the session credential and enforced Content-Type. The minted token never
// touches disk, and every response (success or error) is non-cacheable so a
// proxy or client cache cannot retain a minted token.
import { defineEventHandler, readBody, setResponseHeader, setResponseStatus } from "h3";
import {
  currentExchangeSession,
  MINTABLE_SESSION_SCOPES,
  mintSessionToken,
} from "../../wiring/session-exchange.js";

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "cache-control", "no-store");
  const session = currentExchangeSession(event);
  if (!session) {
    setResponseStatus(event, 403);
    return { error: "Forbidden: session exchange requires the interactive session credential" };
  }

  const body = (await readBody(event)) as { scopes?: unknown } | null;
  const requested = body?.scopes;
  const valid =
    Array.isArray(requested) &&
    requested.length > 0 &&
    requested.every((s) => (MINTABLE_SESSION_SCOPES as readonly string[]).includes(s as string));

  const minted = valid ? mintSessionToken(session, requested) : null;
  if (!minted) {
    setResponseStatus(event, 403);
    return { error: "Forbidden: scope requested is not mintable" };
  }
  return { tokenId: minted.tokenId, token: minted.token, scopes: minted.scopes, actor: minted.actor };
});
