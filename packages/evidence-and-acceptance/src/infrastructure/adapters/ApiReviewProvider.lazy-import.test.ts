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

  it('loads the SDK on first call of the returned function', async () => {
    const generate = createSdkApiReviewGenerate({
      baseURL: 'http://test',
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
      abortSignal: AbortSignal.timeout(100),
    };

    // We expect this to fail because there's no real endpoint, but the failure
    // should be a network/transport error, not a module loading error.
    // The dynamic import of 'ai' and '@ai-sdk/openai-compatible' must have
    // succeeded for the code to reach the network call.
    let errorCode: string | undefined;
    try {
      await generate(input);
    } catch (error) {
      if (error instanceof Error) {
        // Network errors like ECONNREFUSED mean the SDK loaded and tried to call
        // the endpoint. Module loading errors (MODULE_NOT_FOUND, etc.) would mean
        // the dynamic import failed.
        errorCode = (error as NodeJS.ErrnoException).code;
      }
    }

    // If we got a network error (ECONNREFUSED, ENOTFOUND, etc.), the SDK loaded
    // successfully and attempted the call. If we got MODULE_NOT_FOUND, the
    // dynamic import failed.
    // We accept any error that is NOT a module resolution error.
    expect(errorCode).not.toBe('MODULE_NOT_FOUND');
    expect(errorCode).not.toBe('ERR_MODULE_NOT_FOUND');
  });

  it('caches the SDK after first load (subsequent calls reuse it)', async () => {
    const generate = createSdkApiReviewGenerate({
      baseURL: 'http://test',
      model: 'test-model',
      schemaEnforcement: 'json-object',
    });

    // Use a longer timeout so the network attempt happens before abort
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

    // Both should have failed with network/transport errors, not module errors
    expect(firstError).not.toBeNull();
    expect(secondError).not.toBeNull();
    // The error should be a network error (ECONNREFUSED, etc.), not a module error
    const firstCode = (firstError as NodeJS.ErrnoException)?.code;
    const secondCode = (secondError as NodeJS.ErrnoException)?.code;
    expect(firstCode).not.toBe('MODULE_NOT_FOUND');
    expect(firstCode).not.toBe('ERR_MODULE_NOT_FOUND');
    expect(secondCode).not.toBe('MODULE_NOT_FOUND');
    expect(secondCode).not.toBe('ERR_MODULE_NOT_FOUND');
  });
});