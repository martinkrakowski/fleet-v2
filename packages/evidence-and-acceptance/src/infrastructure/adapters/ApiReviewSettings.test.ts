import { describe, expect, it } from 'vitest';

import {
  API_REVIEW_BASE_URL_VAR,
  API_REVIEW_SCHEMA_VAR,
  resolveApiReviewSettings,
  API_REVIEW_CONFIG_PROBLEM_CODES,
  describeApiReviewConfigProblem,
  isApiReviewConfigProblemCode,
} from './ApiReviewSettings.js';
import { API_SCHEMA_ENFORCEMENTS } from './ApiReviewTransport.adapter.js';

const URL_OK = 'http://10.60.0.1:4176/inception/v1';

function env(values: Record<string, string | undefined>): Record<string, string | undefined> {
  return values;
}

describe('resolveApiReviewSettings', () => {
  it('an empty environment configures nothing and reports no problem', () => {
    expect(resolveApiReviewSettings(env({}))).toEqual({});
  });

  it('both values together are accepted', () => {
    expect(
      resolveApiReviewSettings(
        env({ [API_REVIEW_BASE_URL_VAR]: URL_OK, [API_REVIEW_SCHEMA_VAR]: 'native-json-schema' }),
      ),
    ).toEqual({ apiBaseURL: URL_OK, apiSchemaEnforcement: 'native-json-schema' });
  });

  it('json-object is accepted as a declared level', () => {
    expect(
      resolveApiReviewSettings(env({ [API_REVIEW_BASE_URL_VAR]: URL_OK, [API_REVIEW_SCHEMA_VAR]: 'json-object' })),
    ).toMatchObject({ apiSchemaEnforcement: 'json-object' });
  });

  it('whitespace is trimmed, and a blank value counts as unset', () => {
    expect(
      resolveApiReviewSettings(
        env({ [API_REVIEW_BASE_URL_VAR]: `  ${URL_OK}  `, [API_REVIEW_SCHEMA_VAR]: ' json-object ' }),
      ),
    ).toEqual({ apiBaseURL: URL_OK, apiSchemaEnforcement: 'json-object' });
    expect(resolveApiReviewSettings(env({ [API_REVIEW_BASE_URL_VAR]: '   ' }))).toEqual({});
  });

  // Half configured is the case that matters: the half that goes missing is the
  // declaration, which is the whole point of declaring it.
  it('an endpoint without a declared enforcement is a reported problem, not a silent default', () => {
    const resolved = resolveApiReviewSettings(env({ [API_REVIEW_BASE_URL_VAR]: URL_OK }));
    expect(resolved.apiBaseURL).toBeUndefined();
    expect(resolved.problem).toContain(API_REVIEW_SCHEMA_VAR);
  });

  it('an enforcement without an endpoint is a reported problem', () => {
    const resolved = resolveApiReviewSettings(env({ [API_REVIEW_SCHEMA_VAR]: 'json-object' }));
    expect(resolved.apiSchemaEnforcement).toBeUndefined();
    expect(resolved.problem).toContain(API_REVIEW_BASE_URL_VAR);
  });

  it('an unrecognised enforcement is a problem naming the allowed values', () => {
    const resolved = resolveApiReviewSettings(
      env({ [API_REVIEW_BASE_URL_VAR]: URL_OK, [API_REVIEW_SCHEMA_VAR]: 'tool' }),
    );
    expect(resolved.apiSchemaEnforcement).toBeUndefined();
    expect(resolved.problem).toContain('native-json-schema');
    expect(resolved.problem).toContain('json-object');
  });

  it('a non-URL endpoint is a problem', () => {
    const resolved = resolveApiReviewSettings(
      env({ [API_REVIEW_BASE_URL_VAR]: 'not a url', [API_REVIEW_SCHEMA_VAR]: 'json-object' }),
    );
    expect(resolved.problem).toContain(API_REVIEW_BASE_URL_VAR);
    expect(resolved.apiBaseURL).toBeUndefined();
  });

  it('a non-http scheme is refused', () => {
    for (const bad of ['ftp://host/v1', 'file:///etc/passwd', 'ws://host/v1']) {
      const resolved = resolveApiReviewSettings(
        env({ [API_REVIEW_BASE_URL_VAR]: bad, [API_REVIEW_SCHEMA_VAR]: 'json-object' }),
      );
      expect(resolved.problem).toMatch(/http or https/);
    }
  });

  it('an endpoint embedding credentials is refused', () => {
    const resolved = resolveApiReviewSettings(
      env({ [API_REVIEW_BASE_URL_VAR]: 'http://user:secret@10.0.0.1:4176/v1', [API_REVIEW_SCHEMA_VAR]: 'json-object' }),
    );
    expect(resolved.problem).toMatch(/must not embed credentials/);
  });

  it('no problem message ever contains the rejected value', () => {
    const secrets = [
      'http://user:sk-super-secret@10.0.0.1/v1',
      'ftp://sk-also-secret@host/v1',
      'not a url sk-third-secret',
    ];
    for (const value of secrets) {
      const resolved = resolveApiReviewSettings(
        env({ [API_REVIEW_BASE_URL_VAR]: value, [API_REVIEW_SCHEMA_VAR]: 'json-object' }),
      );
      expect(resolved.problem).toBeDefined();
      expect(resolved.problem).not.toContain('secret');
      expect(resolved.problem).not.toContain(value);
    }
  });

  it('a rejected enforcement value is not echoed either', () => {
    const resolved = resolveApiReviewSettings(
      env({ [API_REVIEW_BASE_URL_VAR]: URL_OK, [API_REVIEW_SCHEMA_VAR]: 'sk-leak-me' }),
    );
    expect(resolved.problem).toBeDefined();
    expect(resolved.problem).not.toContain('sk-leak-me');
  });

  it('reads only its own two variables', () => {
    const resolved = resolveApiReviewSettings(
      env({
        [API_REVIEW_BASE_URL_VAR]: URL_OK,
        [API_REVIEW_SCHEMA_VAR]: 'json-object',
        FLEET_OCM_RUN_BIN: '/somewhere/ocm-run',
        OPENROUTER_API_KEY: 'sk-should-never-be-read',
      }),
    );
    expect(resolved).toEqual({ apiBaseURL: URL_OK, apiSchemaEnforcement: 'json-object' });
  });

  it('every problem carries a typed code whose fixed text is the problem', () => {
    const cases: Record<string, string | undefined>[] = [
      { [API_REVIEW_BASE_URL_VAR]: 'not a url', [API_REVIEW_SCHEMA_VAR]: 'json-object' },
      { [API_REVIEW_BASE_URL_VAR]: 'ftp://host/v1', [API_REVIEW_SCHEMA_VAR]: 'json-object' },
      { [API_REVIEW_BASE_URL_VAR]: 'http://user:secret@10.0.0.1/v1', [API_REVIEW_SCHEMA_VAR]: 'json-object' },
      { [API_REVIEW_BASE_URL_VAR]: URL_OK, [API_REVIEW_SCHEMA_VAR]: 'tool' },
      { [API_REVIEW_BASE_URL_VAR]: URL_OK },
      { [API_REVIEW_SCHEMA_VAR]: 'json-object' },
    ];
    const seen = new Set<string>();
    for (const values of cases) {
      const resolved = resolveApiReviewSettings(env(values));
      expect(resolved.problemCode).toBeDefined();
      expect(isApiReviewConfigProblemCode(resolved.problemCode)).toBe(true);
      expect(resolved.problem).toBe(describeApiReviewConfigProblem(resolved.problemCode!));
      seen.add(resolved.problemCode!);
    }
    expect(seen.size).toBe(API_REVIEW_CONFIG_PROBLEM_CODES.length);
  });

  it('no code text names anything but the two variables and the allowed values', () => {
    for (const code of API_REVIEW_CONFIG_PROBLEM_CODES) {
      const text = describeApiReviewConfigProblem(code);
      // Exact expected texts, composed only of the two variable names and the
      // compile-time allowed enforcement values.
      const expected: Record<string, string> = {
        'base-url-not-a-url': `${API_REVIEW_BASE_URL_VAR} is not a URL`,
        'base-url-not-http': `${API_REVIEW_BASE_URL_VAR} must be http or https`,
        'base-url-embeds-credentials': `${API_REVIEW_BASE_URL_VAR} must not embed credentials`,
        'schema-not-allowed': `${API_REVIEW_SCHEMA_VAR} must be one of ${API_SCHEMA_ENFORCEMENTS.join(', ')}`,
        'base-url-without-schema': `${API_REVIEW_BASE_URL_VAR} is set without ${API_REVIEW_SCHEMA_VAR}`,
        'schema-without-base-url': `${API_REVIEW_SCHEMA_VAR} is set without ${API_REVIEW_BASE_URL_VAR}`,
      };
      expect(text).toBe(expected[code]);
    }
  });
});
