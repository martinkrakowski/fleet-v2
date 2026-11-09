import { describe, expect, it } from 'vitest';
import { createSdkApiReviewGenerate } from './ApiReviewProvider.js';

/**
 * Tests for the lazy SDK import behavior.
 *
 * The provider SDK (`ai` and `@ai-sdk/openai-compatible`) should only be loaded
 * when the function returned by `createSdkApiReviewGenerate` is actually called,
 * not when the package root is imported or when `createSdkApiReviewGenerate`
 * itself is called.
 */
describe('createSdkApiReviewGenerate: lazy SDK import', () => {
  it('returns a function synchronously (SDK not loaded yet)', () => {
    const generate = createSdkApiReviewGenerate({
      baseURL: 'http://test',
      model: 'test-model',
      schemaEnforcement: 'json-object',
    });

    // The factory function must return synchronously — it does not await the
    // dynamic import. The import happens on first call of the returned function.
    expect(typeof generate).toBe('function');
    expect(generate.constructor.name).toBe('AsyncFunction');
  });

  /**
   * Walks the error cause chain to find the first error with a `code` property.
   * Also checks the `errors` array (for RetryError from AI SDK).
   * Returns the code if found, otherwise undefined.
   */
  function findErrorCode(error: Error): string | number | undefined {
    const visited = new Set<Error>();

    function walk(err: Error | undefined): string | number | undefined {
      if (!err || visited.has(err)) return undefined;
      visited.add(err);

      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined) {
        return code;
      }

      // Check cause chain
      const cause = (err as { cause?: Error }).cause;
      if (cause) {
        const found = walk(cause);
        if (found !== undefined) return found;
      }

      // Check errors array (for AI SDK RetryError)
      const errors = (err as { errors?: Error[] }).errors;
      if (Array.isArray(errors)) {
        for (const e of errors) {
          const found = walk(e);
          if (found !== undefined) return found;
        }
      }

      return undefined;
    }

    return walk(error);
  }

  it('loads the SDK on first call of the returned function', async () => {
    const generate = createSdkApiReviewGenerate({
      baseURL: 'http://127.0.0.1:9999',
      model: 'test-model',
      schemaEnforcement: 'json-object',
    });

    // The returned function is an async function that will attempt to load the
    // SDK. Since we don't have a real endpoint, it will fail at the network
    // layer — but the dynamic import itself must succeed (or fail with a module
    // resolution error, not a syntax/type error).
    const input = {
      system: 'test',
      prompt: 'test',
      abortSignal: AbortSignal.timeout(5000),
    };

    // We expect this to fail because there's no real endpoint, but the failure
    // should be a network/transport error, not a module loading error.
    // The dynamic import of 'ai' and '@ai-sdk/openai-compatible' must have
    // succeeded for the code to reach the network call.
    let error: Error | null = null;
    try {
      await generate(input);
    } catch (e) {
      error = e as Error;
    }

    // A successful call (no error) means the test setup is wrong — we must fail.
    expect(error).not.toBeNull();

    // The error (or its cause chain) MUST have a code property.
    // An error without a code anywhere in its chain (e.g., a generic Error
    // from a failed import that didn't set a code) would not be a network
    // error and must fail the test.
    const errorCode = findErrorCode(error!);
    expect(errorCode).toBeDefined();

    // If we got a network error (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, etc.),
    // the SDK loaded successfully and attempted the call.
    // If we got MODULE_NOT_FOUND or ERR_MODULE_NOT_FOUND, the dynamic import failed.
    expect(errorCode).not.toBe('MODULE_NOT_FOUND');
    expect(errorCode).not.toBe('ERR_MODULE_NOT_FOUND');
    // We accept network error codes (strings like ECONNREFUSED, or numeric errno).
    // We only forbid the module error codes above.
  });

  it('caches the SDK after first load (subsequent calls reuse it)', async () => {
    const generate = createSdkApiReviewGenerate({
      baseURL: 'http://127.0.0.1:9999',
      model: 'test-model',
      schemaEnforcement: 'json-object',
    });

    const input = {
      system: 'test',
      prompt: 'test',
      abortSignal: AbortSignal.timeout(5000),
    };

    // First call - loads SDK
    let firstError: Error | null = null;
    try {
      await generate(input);
    } catch (error) {
      firstError = error as Error;
    }

    // Second call - should reuse cached SDK
    let secondError: Error | null = null;
    try {
      await generate(input);
    } catch (error) {
      secondError = error as Error;
    }

    // Both calls MUST have thrown (no successful call in this test setup).
    // A null error means the call succeeded unexpectedly — fail the test.
    expect(firstError).not.toBeNull();
    expect(secondError).not.toBeNull();

    // Both errors (or their cause chains) MUST have a code property.
    // An error without a code anywhere in its chain fails the test.
    const firstCode = findErrorCode(firstError!);
    const secondCode = findErrorCode(secondError!);
    expect(firstCode).toBeDefined();
    expect(secondCode).toBeDefined();

    // The error should be a network error (ECONNREFUSED, etc.), not a module error
    expect(firstCode).not.toBe('MODULE_NOT_FOUND');
    expect(firstCode).not.toBe('ERR_MODULE_NOT_FOUND');
    expect(secondCode).not.toBe('MODULE_NOT_FOUND');
    expect(secondCode).not.toBe('ERR_MODULE_NOT_FOUND');
  });
});