/**
 * FVM5: MCP-to-API mutation route parity.
 *
 * `apps/api` keeps the route -> scope mapping module-private (it must never be
 * imported across apps), so this module re-derives what it needs by reading
 * `route-scopes.ts` as text in the test that uses these helpers. Every `/v1`
 * route whose required scope is `message` or `operate` must either be called
 * by a registered MCP tool or sit on the explicit exclusion list below with a
 * non-empty reason naming the owning follow-up unit.
 *
 * Every helper here is pure, refuses hostile input with a typed result or a
 * named error, and states its cost bound. Nothing in this module persists
 * anything: there are no stored records, no schemaVersion and no I/O.
 */

/** Upper bound on the `route-scopes.ts` source accepted for parsing (256 KiB). */
export const MAX_FILE_BYTES = 262_144;

/** Upper bound on rule and exclusion collection sizes. */
export const MAX_RULES = 2000;

/** Upper bound on trie-visit steps spent matching tool routes against rules. */
export const MAX_MATCH_STEPS = 100_000;

/** Fewer rules than this means the file was truncated or reformatted. */
const MIN_RULES = 40;

/** Prototype-polluting keys are refused wherever a key or segment is read. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** One route rule re-derived from the API's private mapping (as text). */
export interface ParsedRouteRule {
  readonly method: string;
  readonly pattern: string;
  readonly scope: string;
}

/** One documented exclusion from MCP tool coverage. */
export interface ParityExclusion {
  readonly method: string;
  readonly pattern: string;
  readonly reason: string;
}

/** A typed refusal: an unknown or malformed state is never a success. */
export interface ParityRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type ParityCheckResult = { readonly ok: true } | ParityRefusal;

export type ExclusionValidationResult =
  | { readonly ok: true; readonly entries: readonly ParityExclusion[] }
  | ParityRefusal;

export type RuleParseResult =
  | { readonly ok: true; readonly rules: readonly ParsedRouteRule[] }
  | ParityRefusal;

/** One recorded tool call: concrete method and path (query stripped later). */
export interface RouteKey {
  readonly method: string;
  readonly path: string;
}

/** Named error for a refused route pattern segment. */
export class PathRefusalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PathRefusalError";
    this.code = code;
  }
}

/** Named error raised when matching exhausts its step budget. */
export class MatchBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchBudgetError";
  }
}

function refuse(code: string, message: string): ParityRefusal {
  return { ok: false, code, message };
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments while preserving
 * newlines, so a fake assignment inside a comment can never spoof a
 * declaration. Cost: O(n) in file bytes, bounded by MAX_FILE_BYTES. String
 * literals are respected so a comment marker inside a string survives.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out.push(ch);
      } else {
        out.push(" ");
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        out.push("  ");
        i++;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }
    if (inString !== null) {
      out.push(ch);
      if (ch === "\\") {
        out.push(next);
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out.push(ch);
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      out.push("  ");
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      out.push("  ");
      i++;
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

const DECLARATION_PATTERN = /^(?:export\s+)?const\s+MUTATION_ROUTE_RULES\b/;

/**
 * The only accepted rule-line shape. Cost: O(lines) regex applications, each
 * O(line length), bounded by MAX_FILE_BYTES.
 */
const RULE_LINE_PATTERN =
  /^\s*\["(GET|POST|PUT|PATCH|DELETE)",\s*"(\/v1\/[^"]+)",\s*"([a-z]+)"\],?\s*$/;

/**
 * Parse the private API mapping out of the `route-scopes.ts` text.
 *
 * Cost: O(n) comment stripping plus O(lines) rule-line matches, bounded by
 * MAX_FILE_BYTES. Refuses (typed result, never silent): a non-string, empty
 * or oversized source; a missing, duplicated or non-array-initialized
 * declaration; any quoted rule line that fails the strict triple pattern;
 * fewer than MIN_RULES or more than MAX_RULES rules.
 */
export function parseMutationRouteRules(source: unknown): RuleParseResult {
  if (typeof source !== "string" || source.trim().length === 0) {
    return refuse(
      "invalid-source",
      "route-scopes source must be a non-empty string.",
    );
  }
  if (new TextEncoder().encode(source).length > MAX_FILE_BYTES) {
    return refuse(
      "source-too-large",
      `route-scopes source exceeds MAX_FILE_BYTES (${MAX_FILE_BYTES}).`,
    );
  }
  const stripped = stripComments(source);
  const lines = stripped.split(/\r?\n/);

  // Exactly one real declaration may exist; a comment can never produce one.
  // Offsets are tracked per line so the initializer search is byte-accurate.
  const declarations: Array<{ line: string; nameEnd: number; offset: number }> = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = DECLARATION_PATTERN.exec(line);
    if (match) {
      declarations.push({ line, nameEnd: match.index + match[0].length, offset });
    }
    offset += line.length + 1;
  }
  if (declarations.length === 0) {
    return refuse(
      "insufficient-rules",
      "No MUTATION_ROUTE_RULES declaration found in the source.",
    );
  }
  if (declarations.length > 1) {
    return refuse(
      "ambiguous-declaration",
      `Expected exactly one MUTATION_ROUTE_RULES declaration, found ${declarations.length}.`,
    );
  }

  // Locate the array literal only as the initializer of THAT declaration: the
  // token right after its `=`, never the first `[` anywhere later in the file.
  const declaration = declarations[0];
  const equalsIndex = declaration.line.indexOf("=", declaration.nameEnd);
  if (equalsIndex === -1) {
    return refuse(
      "missing-array-initializer",
      "The MUTATION_ROUTE_RULES declaration has no initializer.",
    );
  }
  let cursor = declaration.offset + equalsIndex + 1;
  while (cursor < stripped.length && /\s/.test(stripped[cursor])) {
    cursor++;
  }
  if (cursor >= stripped.length || stripped[cursor] !== "[") {
    return refuse(
      "missing-array-initializer",
      "The MUTATION_ROUTE_RULES initializer is not an array literal.",
    );
  }

  // Scan to the matching closing bracket, respecting string literals.
  let depth = 1;
  let end = -1;
  for (let i = cursor + 1; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < stripped.length && stripped[i] !== ch) {
        if (stripped[i] === "\\") {
          i++;
        }
        i++;
      }
      continue;
    }
    if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return refuse(
      "unterminated-rules-array",
      "The MUTATION_ROUTE_RULES array literal is never closed.",
    );
  }

  const rules: ParsedRouteRule[] = [];
  const bodyLines = stripped.slice(cursor + 1, end).split(/\r?\n/);
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.trim().length === 0) {
      continue;
    }
    const match = RULE_LINE_PATTERN.exec(line);
    if (!match) {
      return refuse(
        "malformed-rule-line",
        `Rule line ${i + 1} inside MUTATION_ROUTE_RULES does not match the strict [method, pattern, scope] shape.`,
      );
    }
    rules.push({
      method: match[1],
      pattern: match[2],
      scope: match[3],
    });
  }
  if (rules.length < MIN_RULES) {
    return refuse(
      "insufficient-rules",
      `Only ${rules.length} rules extracted; at least ${MIN_RULES} are required.`,
    );
  }
  if (rules.length > MAX_RULES) {
    return refuse(
      "too-many-rules",
      `${rules.length} rules exceed MAX_RULES (${MAX_RULES}).`,
    );
  }
  return { ok: true, rules };
}

/**
 * Normalize a `/v1/` route pattern for comparison: strip the query string and
 * reduce every `:name` segment to `:param` so `:id`, `:sha`, `:section` and
 * `:requestId` compare uniformly.
 *
 * Cost: O(pattern length). Returns null for a non-string, empty or non-`/v1/`
 * value, and throws PathRefusalError for a prototype-polluting segment
 * (`__proto__`, `constructor`, `prototype`) — never invoked silently.
 */
export function normalizeRoutePattern(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    return null;
  }
  const queryIndex = pattern.indexOf("?");
  const withoutQuery = queryIndex === -1 ? pattern : pattern.slice(0, queryIndex);
  if (!withoutQuery.startsWith("/v1/") && withoutQuery !== "/v1") {
    return null;
  }
  const rawSegments = withoutQuery.split("/");
  const normalized: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "") {
      continue;
    }
    if (POLLUTING_KEYS.has(segment)) {
      throw new PathRefusalError(
        "prototype-polluting-path",
        `Route pattern segment "${segment}" is refused.`,
      );
    }
    normalized.push(segment.startsWith(":") ? ":param" : segment);
  }
  if (normalized.length === 0) {
    return null;
  }
  return `/${normalized.join("/")}`;
}

/**
 * Validate the exclusion list against hostile input.
 *
 * Cost: O(n) in entry count, bounded by MAX_RULES. Refuses (invalid-exclusions):
 * null, undefined, non-arrays (including array-likes and wrong primitives),
 * sparse holes, getter properties (verified never invoked via
 * Object.getOwnPropertyDescriptor), oversized lists, prototype-polluting keys
 * and missing/non-string fields. A blank reason gets its own empty-reason
 * refusal.
 */
export function validateExclusions(exclusions: unknown): ExclusionValidationResult {
  if (!Array.isArray(exclusions)) {
    return refuse(
      "invalid-exclusions",
      "Exclusions must be a real array, not null, a primitive or an array-like.",
    );
  }
  if (exclusions.length > MAX_RULES) {
    return refuse(
      "invalid-exclusions",
      `Exclusion list length ${exclusions.length} exceeds MAX_RULES (${MAX_RULES}).`,
    );
  }
  const entries: ParityExclusion[] = [];
  for (let i = 0; i < exclusions.length; i++) {
    if (!(i in exclusions)) {
      return refuse(
        "invalid-exclusions",
        `Exclusion list has a hole at index ${i}.`,
      );
    }
    // Inspect the descriptor, never invoke a getter.
    const slot = Object.getOwnPropertyDescriptor(exclusions, i);
    if (!slot || slot.get !== undefined) {
      return refuse(
        "invalid-exclusions",
        `Exclusion at index ${i} is missing or served by a getter.`,
      );
    }
    const entry: unknown = slot.value;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return refuse(
        "invalid-exclusions",
        `Exclusion at index ${i} is not a plain object.`,
      );
    }
    const keys = Object.getOwnPropertyNames(entry);
    if (keys.some((key) => POLLUTING_KEYS.has(key))) {
      return refuse(
        "invalid-exclusions",
        `Exclusion at index ${i} carries a prototype-polluting key.`,
      );
    }
    const values: Record<string, string> = {};
    for (const field of ["method", "pattern", "reason"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, field);
      if (!descriptor || descriptor.get !== undefined) {
        return refuse(
          "invalid-exclusions",
          `Exclusion at index ${i} is missing the "${field}" field or serves it through a getter.`,
        );
      }
      if (typeof descriptor.value !== "string") {
        return refuse(
          "invalid-exclusions",
          `Exclusion at index ${i} has a non-string "${field}" field.`,
        );
      }
      values[field] = descriptor.value;
    }
    if (!HTTP_METHODS.has(values.method)) {
      return refuse(
        "invalid-exclusions",
        `Exclusion at index ${i} has an unsupported method "${values.method}".`,
      );
    }
    if (values.reason.trim().length === 0) {
      return refuse(
        "empty-reason",
        `Exclusion ${values.method} ${values.pattern} has an empty reason.`,
      );
    }
    let normalizedPattern: string | null;
    try {
      normalizedPattern = normalizeRoutePattern(values.pattern);
    } catch (error) {
      if (error instanceof PathRefusalError) {
        return refuse(
          "invalid-exclusions",
          `Exclusion at index ${i} has a refused pattern: ${error.message}`,
        );
      }
      throw error;
    }
    if (normalizedPattern === null) {
      return refuse(
        "invalid-exclusions",
        `Exclusion at index ${i} has a pattern that is not a /v1/ path.`,
      );
    }
    entries.push({
      method: values.method,
      pattern: values.pattern,
      reason: values.reason,
    });
  }
  return { ok: true, entries };
}

interface TrieNode {
  readonly literal: Map<string, TrieNode>;
  readonly params: Map<string, TrieNode>;
  readonly patterns: Set<string>;
}

function newTrieNode(): TrieNode {
  return { literal: new Map(), params: new Map(), patterns: new Set() };
}

function insertPattern(root: TrieNode, method: string, pattern: string): void {
  const segments = pattern.split("/").filter((segment) => segment !== "");
  let node = root;
  for (const segment of segments) {
    const isParam = segment.startsWith(":");
    const map = isParam ? node.params : node.literal;
    const key = segment;
    let child = map.get(key);
    if (!child) {
      child = newTrieNode();
      map.set(key, child);
    }
    node = child;
  }
  node.patterns.add(`${method} ${pattern}`);
}

/**
 * Walk the trie collecting every rule pattern the concrete segment list
 * matches. The step budget is charged on EVERY visit — including the visit at
 * `index === segments.length`, before returning — so an adversarial rule set
 * cannot walk unbounded. Cost per query: O(visited nodes), globally bounded by
 * MAX_MATCH_STEPS; exceeding it raises MatchBudgetError.
 */
function collectMatches(
  node: TrieNode,
  segments: readonly string[],
  index: number,
  method: string,
  out: Set<string>,
  budget: { steps: number },
): void {
  budget.steps++;
  if (budget.steps > MAX_MATCH_STEPS) {
    throw new MatchBudgetError(
      `Route matching exceeded MAX_MATCH_STEPS (${MAX_MATCH_STEPS}).`,
    );
  }
  if (index === segments.length) {
    if (node.patterns.size > 0) {
      for (const pattern of node.patterns) {
        const [ruleMethod] = pattern.split(" ", 1);
        if (ruleMethod === method) {
          out.add(pattern);
        }
      }
    }
    return;
  }
  const segment = segments[index];
  const literalChild = node.literal.get(segment);
  if (literalChild) {
    collectMatches(literalChild, segments, index + 1, method, out, budget);
  }
  for (const paramChild of node.params.values()) {
    collectMatches(paramChild, segments, index + 1, method, out, budget);
  }
}

function ruleKey(method: string, pattern: string): string {
  return `${method.toUpperCase()} ${pattern}`;
}

/**
 * Check that every `message`/`operate` route is covered either by a recorded
 * MCP tool call or by a validated exclusion.
 *
 * Cost: O(rules + toolRoutes + exclusions) with trie matching bounded by
 * MAX_MATCH_STEPS and collection sizes bounded by MAX_RULES. Refuses:
 * invalid rules or tool routes, invalid exclusion lists, a stale exclusion
 * (route no longer message/operate), a redundant exclusion (route also called
 * by a registered MCP tool), an uncovered message/operate route, and an
 * exhausted match budget.
 */
export function checkRouteParity(
  rules: readonly ParsedRouteRule[],
  toolRoutes: readonly RouteKey[],
  exclusions: unknown,
): ParityCheckResult {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES) {
    return refuse(
      "invalid-rules",
      "Rules must be a non-empty array bounded by MAX_RULES.",
    );
  }
  for (let i = 0; i < rules.length; i++) {
    if (!(i in rules)) {
      return refuse("invalid-rules", `Rules has a hole at index ${i}.`);
    }
    const rule: unknown = rules[i];
    if (
      typeof rule !== "object" ||
      rule === null ||
      typeof (rule as ParsedRouteRule).method !== "string" ||
      typeof (rule as ParsedRouteRule).pattern !== "string" ||
      typeof (rule as ParsedRouteRule).scope !== "string"
    ) {
      return refuse(
        "invalid-rules",
        `Rule at index ${i} is not a [method, pattern, scope] triple.`,
      );
    }
  }
  if (!Array.isArray(toolRoutes) || toolRoutes.length > MAX_RULES) {
    return refuse(
      "invalid-tool-routes",
      "Tool routes must be an array bounded by MAX_RULES.",
    );
  }
  for (let i = 0; i < toolRoutes.length; i++) {
    if (!(i in toolRoutes)) {
      return refuse(
        "invalid-tool-routes",
        `Tool routes has a hole at index ${i}.`,
      );
    }
    const route: unknown = toolRoutes[i];
    if (
      typeof route !== "object" ||
      route === null ||
      typeof (route as RouteKey).method !== "string" ||
      typeof (route as RouteKey).path !== "string"
    ) {
      return refuse(
        "invalid-tool-routes",
        `Tool route at index ${i} is not a {method, path} pair.`,
      );
    }
  }

  const mutationRules = rules.filter(
    (rule) => rule.scope === "message" || rule.scope === "operate",
  );
  const mutationPatterns = new Set(
    mutationRules.map((rule) =>
      ruleKey(rule.method, normalizeRoutePattern(rule.pattern) ?? rule.pattern),
    ),
  );

  // Which message/operate patterns does the live tool surface already reach?
  // The trie stores the NORMALIZED pattern (`:param` form) so a concrete tool
  // path that matches a parameterized rule yields exactly the same key the
  // mutationPatterns set and the exclusion keys use — a raw `:id` pattern
  // stored here would never equal a normalized `:param` key.
  const trie = newTrieNode();
  for (const rule of mutationRules) {
    insertPattern(
      trie,
      rule.method.toUpperCase(),
      normalizeRoutePattern(rule.pattern) ?? rule.pattern,
    );
  }
  const covered = new Set<string>();
  const budget = { steps: 0 };
  try {
    for (const route of toolRoutes) {
      let normalizedPath: string | null;
      try {
        normalizedPath = normalizeRoutePattern(route.path);
      } catch (error) {
        if (error instanceof PathRefusalError) {
          return refuse(
            "invalid-tool-routes",
            `Tool route ${route.method} ${route.path} is refused: ${error.message}`,
          );
        }
        throw error;
      }
      if (normalizedPath === null) {
        return refuse(
          "invalid-tool-routes",
          `Tool route ${route.method} ${route.path} is not a /v1/ path.`,
        );
      }
      const matched = new Set<string>();
      collectMatches(
        trie,
        normalizedPath.split("/").filter((segment) => segment !== ""),
        0,
        route.method.toUpperCase(),
        matched,
        budget,
      );
      for (const pattern of matched) {
        covered.add(pattern);
      }
    }
  } catch (error) {
    if (error instanceof MatchBudgetError) {
      return refuse("match-budget-exceeded", error.message);
    }
    throw error;
  }

  const validated = validateExclusions(exclusions);
  if (!validated.ok) {
    return validated;
  }
  const excluded = new Set<string>();
  for (const entry of validated.entries) {
    const normalizedPattern = normalizeRoutePattern(entry.pattern);
    if (normalizedPattern === null) {
      return refuse(
        "invalid-exclusions",
        `Exclusion ${entry.method} ${entry.pattern} is not a /v1/ path.`,
      );
    }
    const key = ruleKey(entry.method, normalizedPattern);
    if (!mutationPatterns.has(key)) {
      return refuse(
        "stale-exclusion",
        `Exclusion ${entry.method} ${entry.pattern} names a route that is no longer a message or operate route.`,
      );
    }
    if (covered.has(key)) {
      return refuse(
        "redundant-exclusion",
        `Exclusion ${entry.method} ${entry.pattern} is redundant: a registered MCP tool already calls that route.`,
      );
    }
    excluded.add(key);
  }

  for (const rule of mutationRules) {
    const key = ruleKey(
      rule.method,
      normalizeRoutePattern(rule.pattern) ?? rule.pattern,
    );
    if (!covered.has(key) && !excluded.has(key)) {
      return refuse(
        "missing-parity",
        `Missing MCP parity for ${rule.method.toUpperCase()} ${rule.pattern}: add an MCP tool or an exclusion with a reason`,
      );
    }
  }
  return { ok: true };
}

function excluded(
  method: string,
  pattern: string,
  followUp: string,
  tool: string,
): ParityExclusion {
  return {
    method,
    pattern,
    reason: `Excluded until ${followUp} lands the ${tool} MCP tool; the MCP surface stays read-only today.`,
  };
}

/**
 * The explicit exclusion list. On the base revision every mutating route is
 * uncovered: the MCP surface ships read tools only, so all 34 `message` (7)
 * and `operate` (27) routes are excluded with the follow-up unit that owns
 * each tool landing. The list is validated by the parity test; a stale,
 * redundant or reason-less entry fails the suite loudly.
 */
export const PARITY_EXCLUSIONS: readonly ParityExclusion[] = [
  // message scope — owner questions and relays; tools land with FVM1.
  excluded("POST", "/v1/questions", "FVM1", "owner-question"),
  excluded("POST", "/v1/questions/:id/answers", "FVM1", "answer"),
  excluded("POST", "/v1/questions/:id/acknowledgement", "FVM1", "acknowledgement"),
  excluded("POST", "/v1/questions/sync", "FVM1", "question-sync"),
  excluded("POST", "/v1/questions/expire", "FVM1", "question-expiry"),
  excluded("POST", "/v1/relays", "FVM1", "relay"),
  excluded("POST", "/v1/relays/:id/acknowledgement", "FVM1", "relay-acknowledgement"),
  // operate scope — conductor run control; tools land with FVM3.
  excluded("POST", "/v1/attempts/:id/stop", "FVM3", "attempt-stop"),
  excluded("POST", "/v1/runs/halt", "FVM3", "run-halt"),
  excluded("POST", "/v1/runs/:id/stop", "FVM3", "run-stop"),
  excluded("POST", "/v1/attempts/:id/reconcile", "FVM3", "attempt-reconcile"),
  excluded("POST", "/v1/attempts/:id/fix", "FVM3", "attempt-fix"),
  excluded("POST", "/v1/attempts/:id/acceptance", "FVM3", "acceptance"),
  excluded("POST", "/v1/attempts/:id/cancel-prepared", "FVM3", "cancel-prepared"),
  // operate scope — stewardship writes; tools land with FVM4.
  excluded("POST", "/v1/attempts/:id/artifacts", "FVM4", "artifact"),
  excluded("POST", "/v1/attempts/:id/notes", "FVM4", "attempt-note"),
  excluded("POST", "/v1/owner-items/:id/resolution", "FVM4", "owner-item"),
  excluded("POST", "/v1/verifications", "FVM4", "verification"),
  excluded("POST", "/v1/verifications/:id/receipt", "FVM4", "verification-receipt"),
  excluded("POST", "/v1/observations", "FVM4", "observation"),
  excluded("POST", "/v1/findings/:id/disposition", "FVM4", "finding-disposition"),
  excluded("POST", "/v1/work-orders", "FVM4", "work-order"),
  excluded("POST", "/v1/heads/:sha/assessment", "FVM4", "head-assessment"),
  excluded("POST", "/v1/knowledge/checks", "FVM4", "knowledge-check"),
  excluded("POST", "/v1/knowledge/:id/disposition", "FVM4", "knowledge-disposition"),
  excluded("POST", "/v1/knowledge/:id/publish", "FVM4", "knowledge-publish"),
  excluded("POST", "/v1/knowledge/:id/reuse", "FVM4", "knowledge-reuse"),
  excluded("POST", "/v1/knowledge/:id/supersede", "FVM4", "knowledge-supersede"),
  excluded("POST", "/v1/knowledge/proposals", "FVM4", "knowledge-proposal"),
  excluded("POST", "/v1/knowledge/selections", "FVM4", "knowledge-selection"),
  excluded("POST", "/v1/projects", "FVM4", "project"),
  excluded("POST", "/v1/projects/:id/retire", "FVM4", "project-retire"),
  excluded("POST", "/v1/projects/:id/probe", "FVM4", "project-probe"),
  excluded("PATCH", "/v1/projects/:id", "FVM4", "project-update"),
];
