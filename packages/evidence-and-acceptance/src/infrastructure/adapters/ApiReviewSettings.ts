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

export interface ResolvedApiReviewSettings {
  readonly apiBaseURL?: string;
  readonly apiSchemaEnforcement?: ApiSchemaEnforcement;
  /**
   * Why a set variable was not accepted. Names the variable and the rule, never
   * the value: an endpoint URL can carry a token in a path or a query.
   */
  readonly problem?: string;
}

const ENFORCEMENT_VALUES: readonly string[] = API_SCHEMA_ENFORCEMENTS;

/**
 * A loopback or private endpoint is expected (the proxy runs on the host), but
 * the scheme is what matters here: a non-http(s) URL cannot be a proxy base,
 * and a bare host would be ambiguous.
 */
function readBaseURL(raw: string | undefined): { readonly value?: string; readonly problem?: string } {
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
    return { problem: `${API_REVIEW_BASE_URL_VAR} is not a URL` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { problem: `${API_REVIEW_BASE_URL_VAR} must be http or https` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Credentials belong in the proxy's key file, never in a configured URL,
    // and a URL with them would reach the provider library as given.
    return { problem: `${API_REVIEW_BASE_URL_VAR} must not embed credentials` };
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
  let schemaProblem: string | undefined;
  if (schema !== '') {
    if (ENFORCEMENT_VALUES.includes(schema)) {
      enforcement = schema as ApiSchemaEnforcement;
    } else {
      schemaProblem = `${API_REVIEW_SCHEMA_VAR} must be one of ${API_SCHEMA_ENFORCEMENTS.join(', ')}`;
    }
  }

  // One endpoint without a declared enforcement is the case requirement 6 of
  // ADR-0001 is about: it is not configured, it is HALF configured, and the
  // difference matters because the half that is missing is the declaration.
  let pairProblem: string | undefined;
  if (base.value !== undefined && enforcement === undefined && schemaProblem === undefined) {
    pairProblem = `${API_REVIEW_BASE_URL_VAR} is set without ${API_REVIEW_SCHEMA_VAR}`;
  } else if (base.value === undefined && enforcement !== undefined && base.problem === undefined) {
    pairProblem = `${API_REVIEW_SCHEMA_VAR} is set without ${API_REVIEW_BASE_URL_VAR}`;
  }

  const problem = base.problem ?? schemaProblem ?? pairProblem;

  // Both or neither: a half-configured transport never runs.
  if (problem !== undefined || base.value === undefined || enforcement === undefined) {
    return problem !== undefined ? { problem } : {};
  }
  return { apiBaseURL: base.value, apiSchemaEnforcement: enforcement };
}
