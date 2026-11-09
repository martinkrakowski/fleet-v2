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

import type { ApiReviewGenerate, ApiReviewGenerateResult, ApiSchemaEnforcement } from './ApiReviewTransport.adapter.js';
import { API_REVIEW_VERDICT_SCHEMA } from './ApiReviewTransport.adapter.js';

export interface SdkApiReviewGenerateOptions {
  /** The key proxy's base URL. */
  readonly baseURL: string;
  readonly model: string;
  /**
   * Which response format this seat's endpoint is declared to honour, and it
   * DOES reach the wire.
   *
   * Corrected 2026-11-08 after the pre-merge pass: an earlier version of this
   * comment said the library exposes no knob to pin the strategy. That was
   * wrong. `createOpenAICompatible` defaults `supportsStructuredOutputs` to
   * false, and with it false `generateObject` sends
   * `response_format: {type: 'json_object'}` and NO schema — so a seat declared
   * `native-json-schema` was in fact getting json-mode, which is the
   * "capability declared but not real" failure the transport header forbids.
   * The flag is set from this value below, and the transport refuses the review
   * when the endpoint reports that it ignored the format anyway.
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
  // The provider library is imported lazily, on first call of the returned
  // function. This prevents loading the SDK when the package root is imported
  // but no API review is ever performed.
  let generateObject: typeof import('ai').generateObject | null = null;
  let jsonSchema: typeof import('ai').jsonSchema | null = null;
  let NoObjectGeneratedError: typeof import('ai').NoObjectGeneratedError | null = null;
  let createOpenAICompatible: typeof import('@ai-sdk/openai-compatible').createOpenAICompatible | null = null;

  // json-object wants json-mode; native-json-schema needs the schema on the
  // wire, which this flag enables. There are only those two levels: a `tool`
  // level was removed because this library has no tool mode for a typed object
  // call, so declaring it would not have matched the wire.
  const structured = options.schemaEnforcement !== 'json-object';

  return async (input): Promise<ApiReviewGenerateResult> => {
    // Lazy-load the provider SDK on first call.
    if (generateObject === null) {
      const [aiModule, openaiCompatibleModule] = await Promise.all([
        import('ai'),
        import('@ai-sdk/openai-compatible'),
      ]);
      generateObject = aiModule.generateObject;
      jsonSchema = aiModule.jsonSchema;
      NoObjectGeneratedError = aiModule.NoObjectGeneratedError;
      createOpenAICompatible = openaiCompatibleModule.createOpenAICompatible;
    }

    const provider = createOpenAICompatible!({
      name: options.providerName ?? 'fleet-key-proxy',
      baseURL: options.baseURL,
      apiKey: PROXY_INJECTS_THE_KEY,
      supportsStructuredOutputs: structured,
    });

    let generated;
    try {
      generated = await generateObject!({
        model: provider.chatModel(options.model),
        schema: jsonSchema!(API_REVIEW_VERDICT_SCHEMA),
        schemaName: 'review_verdict',
        system: input.system,
        prompt: input.prompt,
        abortSignal: input.abortSignal,
        maxRetries: options.maxRetries ?? 1,
      });
    } catch (error) {
      // A reply the library could not parse into an object at all is a
      // malformed VERDICT, not an unreachable endpoint. Reporting it as such
      // keeps it on the `unknown`/`unparseable-verdict` path instead of being
      // classified as a transport failure (pre-merge finding 5). Every other
      // error keeps propagating so the transport can classify it.
      if (NoObjectGeneratedError!.isInstance(error)) {
        return { object: undefined, noObject: true };
      }
      throw error;
    }

    // Warnings are the library's own diagnostics. Only `type:feature` is kept —
    // never `details`, which carries request text — and the transport ACTS on
    // `unsupported:responseFormat`, which is how a false enforcement
    // declaration is caught rather than discarded as it was before.
    const warnings = (generated.warnings ?? []).map((warning) => {
      if (typeof warning !== 'object' || warning === null) {
        return 'unknown';
      }
      const record = warning as { readonly type?: unknown; readonly feature?: unknown };
      const type = typeof record.type === 'string' ? record.type : 'unknown';
      const feature = typeof record.feature === 'string' ? record.feature : '';
      return feature === '' ? type : `${type}:${feature}`;
    });

    return {
      object: generated.object,
      // This call declares no tools and spawns no process, so nothing it did
      // could have written. The transport reports read-only only on this.
      readOnly: true,
      warnings,
      usage: {
        ...(typeof generated.usage?.inputTokens === 'number' ? { inputTokens: generated.usage.inputTokens } : {}),
        ...(typeof generated.usage?.outputTokens === 'number' ? { outputTokens: generated.usage.outputTokens } : {}),
      },
    };
  };
}