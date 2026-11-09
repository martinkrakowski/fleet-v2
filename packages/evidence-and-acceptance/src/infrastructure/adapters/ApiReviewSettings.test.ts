import { describe, expect, it } from 'vitest';

import {
  API_REVIEW_BASE_URL_VAR,
  API_REVIEW_SCHEMA_VAR,
  resolveApiReviewSettings,
} from './ApiReviewSettings.js';

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
});
