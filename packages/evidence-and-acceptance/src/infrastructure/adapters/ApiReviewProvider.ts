/**
 * The one place the provider library is imported.
 *
 * `ApiReviewTransport` takes its provider call as an injected function, so the
 * decode path — which is where the reliability of a verdict is decided — is
 * tested without a network and without this library. This module builds the
 * real call and nothing else, which is what keeps replacing the library a local
 * change (ADR-0001: the library may be imported only inside the adapter, never
 * above a port).
 *
 * No credential is read, held or sent here. `baseURL` addresses the host-side
 * key proxy, which adds the provider key on egress, so the placeholder below is
 * never a secret and never reaches a provider. The library requires the field
 * to be present.
 */

import { generateObject, jsonSchema } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import type { ApiReviewGenerate, ApiReviewGenerateResult, ApiSchemaEnforcement } from './ApiReviewTransport.adapter.js';
import { API_REVIEW_VERDICT_SCHEMA } from './ApiReviewTransport.adapter.js';

export interface SdkApiReviewGenerateOptions {
  /** The key proxy's base URL. */
  readonly baseURL: string;
  readonly model: string;
  /**
   * Recorded for traceability. The library chooses its own strategy and does
   * not expose a knob to pin it, which is exactly why the transport validates
   * the answer itself rather than trusting that a schema was enforced.
   */
  readonly schemaEnforcement: ApiSchemaEnforcement;
  /** Provider name for the library's own error messages. */
  readonly providerName?: string;
  /**
   * Retries inside one call. The seat chain handles a seat that stays
   * unavailable; this only absorbs a transient blip, so it is deliberately low.
   */
  readonly maxRetries?: number;
}

/**
 * The placeholder the proxy replaces. It is not a credential: the proxy drops
 * any inbound Authorization header and sets the real one from its own key file.
 */
const PROXY_INJECTS_THE_KEY = 'proxy-injects-the-real-key';

export function createSdkApiReviewGenerate(options: SdkApiReviewGenerateOptions): ApiReviewGenerate {
  const provider = createOpenAICompatible({
    name: options.providerName ?? 'fleet-key-proxy',
    baseURL: options.baseURL,
    apiKey: PROXY_INJECTS_THE_KEY,
  });

  return async (input): Promise<ApiReviewGenerateResult> => {
    const generated = await generateObject({
      model: provider.chatModel(options.model),
      schema: jsonSchema(API_REVIEW_VERDICT_SCHEMA),
      schemaName: 'review_verdict',
      system: input.system,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
      maxRetries: options.maxRetries ?? 1,
    });

    const warnings = (generated.warnings ?? []).map((warning) => {
      // Warnings are the library's own diagnostics (a dropped setting, an
      // unsupported option). Only the type is kept: a message may carry request
      // detail, and nothing here is acted on.
      if (typeof warning === 'object' && warning !== null && 'type' in warning) {
        const type = (warning as { readonly type?: unknown }).type;
        return typeof type === 'string' ? type : 'unknown';
      }
      return 'unknown';
    });

    return {
      object: generated.object,
      warnings,
      usage: {
        ...(typeof generated.usage?.inputTokens === 'number' ? { inputTokens: generated.usage.inputTokens } : {}),
        ...(typeof generated.usage?.outputTokens === 'number' ? { outputTokens: generated.usage.outputTokens } : {}),
      },
    };
  };
}
