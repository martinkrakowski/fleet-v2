/**
 * This file pins the *installed library's* error shape, not our handling of it.
 * If it fails after a dependency upgrade, findStatusCode in
 * ApiReviewTransport.adapter.ts must be re-checked before the upgrade lands.
 */

import { describe, expect, it } from 'vitest';
import { APICallError, RetryError, generateObject, jsonSchema } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { findStatusCode } from './ApiReviewTransport.adapter.js';

type OwnKind = 'absent' | 'accessor' | 'data';

function ownKind(target: object, key: string): OwnKind {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) {
    return 'absent';
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return 'accessor';
  }
  return 'data';
}

describe('the installed ai package still wraps a retried 429 as findStatusCode expects', () => {
  const apiError = new APICallError({
    message: 'rate limited',
    url: 'http://127.0.0.1:4176/inception/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  });

  const retryError = new RetryError({
    message: 'failed after 3 attempts',
    reason: 'maxRetriesExceeded',
    errors: [apiError, apiError],
  });

  describe('APICallError own data properties', () => {
    it('statusCode is an own data property with value 429', () => {
      expect(ownKind(apiError, 'statusCode')).toBe('data');
      expect(apiError.statusCode).toBe(429);
    });

    it('isRetryable is an own data property with value true', () => {
      expect(ownKind(apiError, 'isRetryable')).toBe('data');
      expect(apiError.isRetryable).toBe(true);
    });

    it('APICallError.isInstance identifies APICallError but not RetryError', () => {
      expect(APICallError.isInstance(apiError)).toBe(true);
      expect(APICallError.isInstance(retryError)).toBe(false);
    });
  });

  describe('RetryError wrapper shape — no own statusCode, lastError and errors carry the 429', () => {
    it('statusCode is absent on the wrapper — this is precisely why the walk is needed: the wrapper carries no status of its own', () => {
      expect(ownKind(retryError, 'statusCode')).toBe('absent');
    });

    it('lastError is an own data property referencing the same apiError', () => {
      expect(ownKind(retryError, 'lastError')).toBe('data');
      expect(retryError.lastError).toBe(apiError);
    });

    it('errors is an own data array of length 2', () => {
      expect(ownKind(retryError, 'errors')).toBe('data');
      expect(Array.isArray(retryError.errors)).toBe(true);
      expect(retryError.errors.length).toBe(2);
    });

    it('reason is an own data property with value maxRetriesExceeded', () => {
      expect(ownKind(retryError, 'reason')).toBe('data');
      expect(retryError.reason).toBe('maxRetriesExceeded');
    });

    it('RetryError.isInstance identifies RetryError but not APICallError', () => {
      expect(RetryError.isInstance(retryError)).toBe(true);
      expect(RetryError.isInstance(apiError)).toBe(false);
    });

    it('name is AI_RetryError — not AbortError or TimeoutError (which classifyProviderFailure treats as timeout)', () => {
      expect(retryError.name).toBe('AI_RetryError');
      expect(retryError.name).not.toBe('AbortError');
      expect(retryError.name).not.toBe('TimeoutError');
    });

    it('status 429 is reachable through lastError narrowed by APICallError.isInstance', () => {
      const lastError = retryError.lastError;
      expect(APICallError.isInstance(lastError)).toBe(true);
      // Narrowed by isInstance, statusCode is accessible as a data property
      const narrowed = lastError as APICallError;
      expect(narrowed.statusCode).toBe(429);
    });

    it('status 429 is reachable through errors[last] narrowed by APICallError.isInstance', () => {
      const errors = retryError.errors;
      const last = errors[errors.length - 1];
      expect(APICallError.isInstance(last)).toBe(true);
      // Narrowed by isInstance, statusCode is accessible as a data property
      const narrowed = last as APICallError;
      expect(narrowed.statusCode).toBe(429);
    });
  });
});

describe('end-to-end retry path surfaces a 429 through findStatusCode', () => {
  it('when the provider always returns 429, the library retries and throws an error where findStatusCode finds 429', async () => {
    let fetchCallCount = 0;

    const stubFetch = async (): Promise<Response> => {
      fetchCallCount += 1;
      return new Response(
        JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
        },
      );
    };

    const provider = createOpenAICompatible({
      name: 'test-provider',
      baseURL: 'http://127.0.0.1:4176',
      apiKey: 'test-key',
      fetch: stubFetch,
    });

    const schema = jsonSchema({
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: { result: { type: 'string', enum: ['pass', 'fail'] } },
    });

    let caughtError: unknown;
    try {
      await generateObject({
        model: provider.chatModel('test-model'),
        schema,
        schemaName: 'test_schema',
        system: 'test system',
        prompt: 'test prompt',
        maxRetries: 2,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    // findStatusCode is the exact walk the transport uses; it must reach 429
    const status = findStatusCode(caughtError, 0);
    expect(status).toBe(429);
    // Called more than once proves the retry path ran (default would be 3 total for maxRetries=2)
    expect(fetchCallCount).toBeGreaterThan(1);
  });
});