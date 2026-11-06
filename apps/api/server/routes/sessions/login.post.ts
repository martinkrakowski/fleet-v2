// POST /sessions/login — establish an interactive session from the single-use
// web login code (T6a). The security middleware has already enforced that this
// is a server-side POST with a JSON Content-Type; this handler consumes the
// code and registers the session. The returned secret is the session credential
// the caller presents to POST /sessions/exchange; it never touches disk.
import {
  defineEventHandler,
  getRequestHeader,
  setResponseHeader,
  setResponseStatus,
} from "h3";
import { registerInteractiveSession } from "../../wiring/session-exchange.js";
import {
  consumeWebLoginCode,
  WEB_LOGIN_ACTOR,
  WEB_LOGIN_HEADER,
  WEB_LOGIN_SCOPES,
} from "../../wiring/web-login.js";

export default defineEventHandler((event) => {
  setResponseHeader(event, "cache-control", "no-store");

  let presented: unknown;
  try {
    presented = getRequestHeader(event, WEB_LOGIN_HEADER);
  } catch {
    // A hostile header getter must never crash the route: treat it as missing.
    presented = undefined;
  }

  const consumed = consumeWebLoginCode(presented);
  if (!consumed.ok) {
    setResponseStatus(event, 403);
    return { error: "Forbidden: the web login code was refused" };
  }

  const session = registerInteractiveSession({
    actor: WEB_LOGIN_ACTOR,
    scopes: WEB_LOGIN_SCOPES,
  });
  if (session === null) {
    setResponseStatus(event, 403);
    return { error: "Forbidden: no interactive session could be established" };
  }

  return {
    sessionId: session.sessionId,
    secret: session.secret,
    scopes: [...session.scopes],
    actor: session.actor,
  };
});
