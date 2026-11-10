import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for the lazy SDK import behavior.
 *
 * The provider SDK (`ai` and `@ai-sdk/openai-compatible`) should only be loaded
 * when the function returned by `createSdkApiReviewGenerate` is actually called,
 * not when the package root is imported or when `createSdkApiReviewGenerate`
 * itself is called.
 */

describe('createSdkApiReviewGenerate: lazy SDK import', () => {
  let aiModuleAccessCount: number;
  let openaiCompatibleModuleAccessCount: number;

  function createMockModules() {
    aiModuleAccessCount = 0;
    openaiCompatibleModuleAccessCount = 0;

    const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:9999');
    (connectionError as NodeJS.ErrnoException).code = 'ECONNREFUSED';

    vi.doMock('ai', () => {
      return {
        get generateObject() {
          aiModuleAccessCount++;
          const error = new Error('connect ECONNREFUSED 127.0.0.1:9999');
          (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';
          return vi.fn().mockRejectedValue(error);
        },
        get jsonSchema() {
          aiModuleAccessCount++;
          return vi.fn((schema) => schema);
        },
        get NoObjectGeneratedError() {
          aiModuleAccessCount++;
          return class NoObjectGeneratedError extends Error {
            static isInstance(error: unknown): error is NoObjectGeneratedError {
              return error instanceof NoObjectGeneratedError;
            }
          };
        },
      };
    });

    vi.doMock('@ai-sdk/openai-compatible', () => {
      return {
        get createOpenAICompatible() {
          openaiCompatibleModuleAccessCount++;
          return vi.fn(() => ({
            chatModel: vi.fn(),
          }));
        },
      };
    });
  }

  async function importModule() {
    vi.resetModules();
    createMockModules();
    const { createSdkApiReviewGenerate } = await import('./ApiReviewProvider.js');
    return createSdkApiReviewGenerate;
  }

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

  it('returns a function synchronously (SDK not loaded yet)', async () => {
    const createSdkApiReviewGenerate = await importModule();

    const generate = createSdkApiReviewGenerate({
      baseURL: 'http://test',
      model: 'test-model',
      schemaEnforcement: 'json-object',
    });

    // The factory function must return synchronously — it does not await the
    // dynamic import. The import happens on first call of the returned function.
    expect(typeof generate).toBe('function');
    expect(generate.constructor.name).toBe('AsyncFunction');

    // CRITICAL: The SDK modules must NOT have been accessed during factory creation.
    // An eager import would increment these counters.
    expect(aiModuleAccessCount).toBe(0);
    expect(openaiCompatibleModuleAccessCount).toBe(0);
  });

  it('loads the SDK on first call of the returned function', async () => {
    const createSdkApiReviewGenerate = await importModule();

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

    let error: Error | null = null;
    try {
      await generate(input);
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();

    const errorCode = findErrorCode(error!);
    expect(errorCode).toBeDefined();

    // The dynamic import must have succeeded for the code to reach the network call.
    // If we got a network error (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, etc.),
    // the SDK loaded successfully and attempted the call.
    // If we got MODULE_NOT_FOUND, ERR_MODULE_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED,
    // or any other ERR_* module error, the dynamic import failed.
    expect(errorCode).not.toBe('MODULE_NOT_FOUND');
    expect(errorCode).not.toBe('ERR_MODULE_NOT_FOUND');
    // Reject any ERR_* code — these are Node.js module resolution errors
    if (typeof errorCode === 'string' && errorCode.startsWith('ERR_')) {
      throw new Error(`Module loading error leaked: ${errorCode}`);
    }
    // We accept network error codes (strings like ECONNREFUSED, or numeric errno).
    // We only forbid the module error codes above.

    // CRITICAL: Each SDK module's exports must have been accessed exactly ONCE.
    // The implementation accesses 3 exports from 'ai' and 1 from '@ai-sdk/openai-compatible'.
    expect(aiModuleAccessCount).toBe(3);
    expect(openaiCompatibleModuleAccessCount).toBe(1);
  });

  it('caches the SDK after first load (subsequent calls reuse it)', async () => {
    const createSdkApiReviewGenerate = await importModule();

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
    if (typeof firstCode === 'string' && firstCode.startsWith('ERR_')) {
      throw new Error(`Module loading error leaked on first call: ${firstCode}`);
    }
    if (typeof secondCode === 'string' && secondCode.startsWith('ERR_')) {
      throw new Error(`Module loading error leaked on second call: ${secondCode}`);
    }

    // CRITICAL: Each SDK module's exports must have been accessed exactly ONCE total
    // across both calls. The implementation accesses 3 exports from 'ai' and 1 from
    // '@ai-sdk/openai-compatible' per dynamic import. If it re-imports on every call,
    // the counts would be 6 and 2 respectively.
    expect(aiModuleAccessCount).toBe(3);
    expect(openaiCompatibleModuleAccessCount).toBe(1);
  });
});