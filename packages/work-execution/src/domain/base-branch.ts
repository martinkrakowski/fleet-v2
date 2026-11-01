/**
 * The base branch a work order and its lane run work against (lane CB1).
 * The only accepted values are the string `main` or a `chain/<name>` where
 * the name is one or more segments of `[a-z0-9]+` separated by a single `-`,
 * at most 200 characters in total. Parsing is strict: no trim, no case fold,
 * no extra slash, no leading, trailing or doubled dash. An unparsable value
 * is `undefined`, never a default; the resolvers, not the parser, substitute
 * `main` for an absent key.
 */

export const DEFAULT_BASE_BRANCH = 'main' as const;

/** A declared base branch: `main`, or a chain name under `chain/`. */
export type BaseBranchValue = typeof DEFAULT_BASE_BRANCH | `chain/${string}`;

/**
 * The fixed sentence every refusing caller uses (the entity name prefixes it);
 * the supplied value is never echoed.
 */
export const BASE_BRANCH_INVALID_MESSAGE = 'baseBranch must be main or chain/<lowercase-dashes>';

const MAIN_PATTERN = /^main$/;
const CHAIN_PATTERN = /^chain\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LENGTH = 200;

/**
 * Classify a value as a declared base branch; anything else — a non-string,
 * an empty string, a wrong case, a doubled or trailing dash, a second slash,
 * an over-long name — is `undefined`, never a default.
 */
export function parseBaseBranch(value: unknown): BaseBranchValue | undefined {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) {
    return undefined;
  }
  if (MAIN_PATTERN.test(value) || CHAIN_PATTERN.test(value)) {
    return value as BaseBranchValue;
  }
  return undefined;
}

/**
 * The resolved base branch of a stored record: its own `baseBranch` when it
 * parses, `main` otherwise. Own property only: an inherited `baseBranch` (a
 * polluted prototype) never labels a record.
 */
function resolveBaseBranchOf(record: { readonly baseBranch?: unknown }): BaseBranchValue {
  if (!Object.hasOwn(record, 'baseBranch')) {
    return DEFAULT_BASE_BRANCH;
  }
  return parseBaseBranch(record.baseBranch) ?? DEFAULT_BASE_BRANCH;
}

/** The work order's resolved base branch; absent or unparsable reads as `main`. */
export function resolveWorkOrderBaseBranch(record: { readonly baseBranch?: unknown }): BaseBranchValue {
  return resolveBaseBranchOf(record);
}

/** The lane run's resolved base branch; absent or unparsable reads as `main`. */
export function resolveLaneRunBaseBranch(record: { readonly baseBranch?: unknown }): BaseBranchValue {
  return resolveBaseBranchOf(record);
}
