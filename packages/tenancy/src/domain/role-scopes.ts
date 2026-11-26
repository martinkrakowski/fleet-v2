/**
 * FC6B: the pure hosted-session role-to-scope table for deployments serving
 * more than one organisation. Pure domain data plus pure functions: no Node,
 * filesystem, subprocess, network, vendor or console imports; nothing throws
 * on hostile input.
 *
 * Hostile-input posture: `scopesForRole` and `extractScopeList` treat every
 * input as untrusted. The string type check short-circuits before any
 * property access, so getters, Proxies, array-likes and enormous lengths are
 * never read or iterated; the parser reads only the two string inputs it
 * already owns.
 */

/** The frozen seven scopes, pinned to `FROZEN_SCOPES` in the API wiring. */
export const HOSTED_SCOPES = [
  "read",
  "message",
  "hook",
  "verdict",
  "operate",
  "orchestrate",
  "tail",
] as const;

export type HostedScope = (typeof HOSTED_SCOPES)[number];

export type ExtractScopeListResult =
  | { readonly ok: true; readonly scopes: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Base scope list per role, as plain data so the switch stays total. */
const VIEWER_SCOPES: readonly HostedScope[] = ["read", "tail"];
const MAINTAINER_SCOPES: readonly HostedScope[] = [
  "read",
  "tail",
  "message",
  "verdict",
];
const OWNER_SCOPES: readonly HostedScope[] = [
  "read",
  "tail",
  "message",
  "verdict",
  "operate",
];

/**
 * The hosted-session scopes for a membership role. A total function: every
 * non-string, unknown role or hostile input returns a fresh frozen empty
 * array, never a throw and never a pass. `hook` guards agent routes only and
 * is dropped from every human role (least privilege); `orchestrate` is never
 * mintable for an interactive session.
 *
 * Cost bound: O(1) time and O(1) space — one `typeof` check, one switch and
 * at most 5 string references copied into the returned frozen array. No
 * property lookup on the role, so prototype keys never resolve, and no
 * iteration over untrusted input.
 */
export function scopesForRole(role: unknown): readonly HostedScope[] {
  if (typeof role !== "string") {
    return Object.freeze([]);
  }
  let scopes: readonly HostedScope[];
  switch (role) {
    case "viewer":
      scopes = VIEWER_SCOPES;
      break;
    case "maintainer":
      scopes = MAINTAINER_SCOPES;
      break;
    case "owner":
      scopes = OWNER_SCOPES;
      break;
    default:
      scopes = [];
  }
  return Object.freeze(scopes.slice());
}

/** A scope list name: an identifier of at most 128 characters. */
const SCOPE_LIST_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE_LIST_NAME_MAX_LENGTH = 128;
const SOURCE_TEXT_MAX_LENGTH = 1_000_000;

/**
 * Extracts the string elements of an `export const ${name} = [ ... ];`
 * declaration from source text. Returns a typed refusal for every invalid
 * or unparseable input; nothing throws.
 *
 * Cost bound: O(L) time in the source length for two `indexOf` scans and
 * one bounded slice — never a nested-quantifier regex on untrusted input —
 * and O(k) space for the k extracted scope strings.
 */
export function extractScopeList(
  text: unknown,
  name: unknown,
): ExtractScopeListResult {
  if (typeof text !== "string" || typeof name !== "string") {
    return { ok: false, reason: "invalid input" };
  }
  if (
    name.length === 0 ||
    name.length > SCOPE_LIST_NAME_MAX_LENGTH ||
    !SCOPE_LIST_NAME_PATTERN.test(name)
  ) {
    return { ok: false, reason: "invalid scope list name" };
  }
  if (text.length > SOURCE_TEXT_MAX_LENGTH) {
    return { ok: false, reason: "source text exceeds size bound" };
  }
  const declaration = `export const ${name} = [`;
  const start = text.indexOf(declaration);
  if (start === -1) {
    return { ok: false, reason: "could not parse scope list" };
  }
  const elementsStart = start + declaration.length;
  const end = text.indexOf("]", elementsStart);
  if (end === -1 || text.indexOf(";", end) === -1) {
    return { ok: false, reason: "could not parse scope list" };
  }
  const body = text.slice(elementsStart, end);
  const scopes: string[] = [];
  // Element scan: at most one pass over the bounded body, no regex.
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === "," || char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === '"') {
      const closing = body.indexOf('"', index + 1);
      if (closing === -1) {
        return { ok: false, reason: "could not parse scope list" };
      }
      scopes.push(body.slice(index + 1, closing));
      index = closing + 1;
      continue;
    }
    // Anything else (bare words, digits, nested brackets) is a non-string
    // element: refused.
    return { ok: false, reason: "could not parse scope list" };
  }
  if (scopes.length === 0) {
    return { ok: false, reason: "could not parse scope list" };
  }
  return { ok: true, scopes: Object.freeze(scopes) };
}
