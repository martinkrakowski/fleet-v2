/**
 * Role: the membership role value object and the pure action-permission
 * table for organization membership. Pure domain code: no Node, filesystem,
 * subprocess, network or vendor imports; nothing throws on hostile input.
 *
 * Hostile-input posture: `isValidRole` and `canActAs` treat their inputs as
 * untrusted. Non-strings, prototype-polluting keys and every unknown value
 * are refused with `false`, never a throw and never a pass. The permission
 * table is a `Map`, so prototype properties never resolve.
 */

/** The only roles a member may hold, in authority order. */
export const ROLES = ["owner", "maintainer", "viewer"] as const;

export type Role = (typeof ROLES)[number];

/** The only actions a membership role may permit. No `dispatch` action exists. */
export const MEMBERSHIP_ACTIONS = [
  "manage-members",
  "change-policy",
  "register-work",
  "start-stop-run",
  "grant",
  "read",
] as const;

export type MembershipAction = (typeof MEMBERSHIP_ACTIONS)[number];

/** Prototype-polluting keys, refused wherever a key-shaped string is read. */
export const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Whether `value` is one of the declared roles. A non-string or a
 * prototype-polluting key is refused.
 *
 * Cost bound: O(1) — one string type check and one bounded set membership
 * test over a 3-element array.
 */
export function isValidRole(value: unknown): value is Role {
  if (typeof value !== "string" || FORBIDDEN_KEY_SET.has(value)) {
    return false;
  }
  return (ROLES as readonly string[]).includes(value);
}

/**
 * The permission table, keyed by role. Built from `MEMBERSHIP_ACTIONS` so
 * the table and the action list can never drift; using a `Map` means
 * `Object.prototype` properties (`toString`, `constructor`, ...) can never
 * resolve as roles or actions.
 */
const PERMISSIONS: ReadonlyMap<Role, ReadonlySet<MembershipAction>> = new Map([
  ["viewer", new Set<MembershipAction>(["read"])],
  [
    "maintainer",
    new Set<MembershipAction>(["register-work", "start-stop-run", "read"]),
  ],
  [
    "owner",
    new Set<MembershipAction>([
      "manage-members",
      "change-policy",
      "register-work",
      "start-stop-run",
      "grant",
      "read",
    ]),
  ],
]);

/**
 * Whether a member holding `role` may perform `action`. A total function:
 * every unknown or hostile input (non-strings, prototype-polluting keys,
 * unknown roles or actions, and any action outside `MEMBERSHIP_ACTIONS`
 * such as `dispatch`) returns `false`, never a throw.
 *
 * Cost bound: O(1) — two type/guard checks and two bounded set lookups.
 */
export function canActAs(role: unknown, action: unknown): boolean {
  if (typeof role !== "string" || FORBIDDEN_KEY_SET.has(role)) {
    return false;
  }
  if (typeof action !== "string" || FORBIDDEN_KEY_SET.has(action)) {
    return false;
  }
  const allowed = PERMISSIONS.get(role as Role);
  if (allowed === undefined) {
    return false;
  }
  return allowed.has(action as MembershipAction);
}
