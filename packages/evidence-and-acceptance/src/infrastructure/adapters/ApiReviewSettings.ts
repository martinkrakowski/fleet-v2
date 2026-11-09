/**
 * The `api` review transport's operator-host configuration.
 *
 * It is environmental, following `FLEET_OCM_RUN_BIN`, which
 * `resolveWorkRunnerSettings` keeps environmental even for a v2 installation
 * because it names something about the host rather than routing. The endpoint
 * here is the host-side key proxy, which is exactly that.
 *
 * Nothing in this module reads `process.env`: the caller passes the record, so
 * the environment stays at the application boundary and the resolution is
 * testable without mutating the process.
 *
 * An invalid value is reported, never silently treated as unset. A typo that
 * read as "not configured" would be the same silent degradation this transport
 * exists to avoid: the problem string travels with the settings and the router
 * puts it in the refusal, so it surfaces the moment someone dispatches to an
 * `api` seat.
 */

import { API_SCHEMA_ENFORCEMENTS } from './ApiReviewTransport.adapter.js';
import type { ApiSchemaEnforcement } from './ApiReviewTransport.adapter.js';

/** The endpoint of the key proxy that adds the provider key on egress. */
export const API_REVIEW_BASE_URL_VAR = 'FLEET_REVIEW_API_BASE_URL';
/** Which response format that endpoint is declared to honour. */
export const API_REVIEW_SCHEMA_VAR = 'FLEET_REVIEW_API_SCHEMA';

/**
 * The closed set of api-configuration problems. A code is a typed token: it is
 * what crosses a trust boundary, because the text is generated from the table
 * below and never from a rejected value, a host, a path or a provider message.
 */
export const API_REVIEW_CONFIG_PROBLEM_CODES = [
  'base-url-not-a-url',
  'base-url-not-http',
  'base-url-embeds-credentials',
  'schema-not-allowed',
  'base-url-without-schema',
  'schema-without-base-url',
] as const;

export type ApiReviewConfigProblemCode = (typeof API_REVIEW_CONFIG_PROBLEM_CODES)[number];

export function isApiReviewConfigProblemCode(value: unknown): value is ApiReviewConfigProblemCode {
  return typeof value === 'string'
    && (API_REVIEW_CONFIG_PROBLEM_CODES as readonly string[]).includes(value);
}

/**
 * The operator-facing text of one problem code. Every branch is a literal
 * composed only of the two variable names and the compile-time list of allowed
 * enforcement values, so the result is safe to show an API caller of a public
 * repository: nothing here interpolates a runtime value.
 */
export function describeApiReviewConfigProblem(code: ApiReviewConfigProblemCode): string {
  switch (code) {
    case 'base-url-not-a-url':
      return `${API_REVIEW_BASE_URL_VAR} is not a URL`;
    case 'base-url-not-http':
      return `${API_REVIEW_BASE_URL_VAR} must be http or https`;
    case 'base-url-embeds-credentials':
      return `${API_REVIEW_BASE_URL_VAR} must not embed credentials`;
    case 'schema-not-allowed':
      return `${API_REVIEW_SCHEMA_VAR} must be one of ${API_SCHEMA_ENFORCEMENTS.join(', ')}`;
    case 'base-url-without-schema':
      return `${API_REVIEW_BASE_URL_VAR} is set without ${API_REVIEW_SCHEMA_VAR}`;
    case 'schema-without-base-url':
      return `${API_REVIEW_SCHEMA_VAR} is set without ${API_REVIEW_BASE_URL_VAR}`;
  }
}

export interface ResolvedApiReviewSettings {
  readonly apiBaseURL?: string;
  readonly apiSchemaEnforcement?: ApiSchemaEnforcement;
  /**
   * Why a set variable was not accepted. Names the variable and the rule, never
   * the value: an endpoint URL can carry a token in a path or a query.
   */
  readonly problem?: string;
  /**
   * The same refusal as `problem`, as a typed token from a closed set. This is
   * what may cross into a public API answer; `problem` is text for a log or a
   * CLI message.
   */
  readonly problemCode?: ApiReviewConfigProblemCode;
}

const ENFORCEMENT_VALUES: readonly string[] = API_SCHEMA_ENFORCEMENTS;

/**
 * A loopback or private endpoint is expected (the proxy runs on the host), but
 * the scheme is what matters here: a non-http(s) URL cannot be a proxy base,
 * and a bare host would be ambiguous.
 */
function readBaseURL(raw: string | undefined): { readonly value?: string; readonly problem?: ApiReviewConfigProblemCode } {
  if (raw === undefined) {
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {};
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { problem: 'base-url-not-a-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { problem: 'base-url-not-http' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Credentials belong in the proxy's key file, never in a configured URL,
    // and a URL with them would reach the provider library as given.
    return { problem: 'base-url-embeds-credentials' };
  }
  return { value: trimmed };
}

export function resolveApiReviewSettings(
  env: Record<string, string | undefined>,
): ResolvedApiReviewSettings {
  const base = readBaseURL(env[API_REVIEW_BASE_URL_VAR]);

  const rawSchema = env[API_REVIEW_SCHEMA_VAR];
  const schema = typeof rawSchema === 'string' ? rawSchema.trim() : '';
  let enforcement: ApiSchemaEnforcement | undefined;
  let schemaProblem: ApiReviewConfigProblemCode | undefined;
  if (schema !== '') {
    if (ENFORCEMENT_VALUES.includes(schema)) {
      enforcement = schema as ApiSchemaEnforcement;
    } else {
      schemaProblem = 'schema-not-allowed';
    }
  }

  // One endpoint without a declared enforcement is the case requirement 6 of
  // ADR-0001 is about: it is not configured, it is HALF configured, and the
  // difference matters because the half that is missing is the declaration.
  let pairProblem: ApiReviewConfigProblemCode | undefined;
  if (base.value !== undefined && enforcement === undefined && schemaProblem === undefined) {
    pairProblem = 'base-url-without-schema';
  } else if (base.value === undefined && enforcement !== undefined && base.problem === undefined) {
    pairProblem = 'schema-without-base-url';
  }

  const problemCode = base.problem ?? schemaProblem ?? pairProblem;

  // Both or neither: a half-configured transport never runs.
  if (problemCode !== undefined || base.value === undefined || enforcement === undefined) {
    return problemCode !== undefined
      ? { problem: describeApiReviewConfigProblem(problemCode), problemCode }
      : {};
  }
  return { apiBaseURL: base.value, apiSchemaEnforcement: enforcement };
}
