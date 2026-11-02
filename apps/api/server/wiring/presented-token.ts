import type { H3Event } from "h3";
import { resolveSessionToken } from "./session-exchange.js";

/**
 * The id and scopes of the token that authenticated a request; never the token
 * itself, and never derived from its value.
 */
export interface PresentedToken {
  readonly tokenId: string;
  readonly scopes: readonly string[];
  /** The verified actor of a session-minted token; the shared bearer has none. */
  readonly actor?: string;
}

/** Until T3a: the one shared bearer, presented under a fixed id that is not derived from its value. */
export const SHARED_BEARER_TOKEN_ID = "shared-bearer";

export type PresentedTokenResolver = (event: H3Event) => PresentedToken;

/**
 * The default resolver: a session-minted token presents its own id, scopes and
 * verified actor; otherwise the shared bearer can do everything, but only
 * `orchestrate` is presented to the orchestrator routes. Session scopes are
 * descriptive and grant nothing; presenting `dispatch` or `verdict` would make
 * registration refuse. T3a replaces this resolver with the token record's own
 * id and scopes, after which `shared-bearer` sessions must re-register.
 */
const sharedBearerResolver: PresentedTokenResolver = (event) => {
  const session = resolveSessionToken(event);
  if (session) {
    return session;
  }
  return { tokenId: SHARED_BEARER_TOKEN_ID, scopes: ["orchestrate"] };
};

let resolver: PresentedTokenResolver | null = null;

/** T3a (and tests) replace the resolver; `null` restores the shared-bearer default. */
export function configurePresentedTokenResolver(next: PresentedTokenResolver | null): void {
  resolver = next;
}

/** Call only after the security middleware authenticated the request (every /v1 route). Fresh copy. */
export function presentedToken(event: H3Event): PresentedToken {
  const resolved = (resolver ?? sharedBearerResolver)(event);
  return {
    tokenId: resolved.tokenId,
    scopes: [...resolved.scopes],
    ...(resolved.actor !== undefined ? { actor: resolved.actor } : {}),
  };
}

export function holdsScope(token: PresentedToken, scope: string): boolean {
  return token.scopes.includes(scope);
}
