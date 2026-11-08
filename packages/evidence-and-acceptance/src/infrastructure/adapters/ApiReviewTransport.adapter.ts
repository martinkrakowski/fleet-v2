/**
 * ApiReviewTransport: the third review transport, beside the CLI transport (an
 * owner-plan CLI) and the opencode transport. It makes ONE typed call to an
 * OpenAI-compatible endpoint and decodes the verdict against a schema, so a
 * missing or malformed verdict is a parse failure rather than something a
 * caller has to notice.
 *
 * Why a provider library rather than our own client (ADR-0001, resolved
 * 2026-11-08): the HTTP call is not the work. Per-provider error envelopes,
 * 429/402 semantics, usage field names, timeouts and cancellation are, and the
 * seat rules require acting on them because a 429 or 402 rotates to the next
 * seat. The measured precedent is a sibling project's hand-rolled
 * OpenAI-compatible adapter: 143 lines, with no schema output, no retry, no 429
 * handling and no cancellation.
 *
 * Two invariants this file exists to hold:
 *
 * 1. SCHEMA ENFORCEMENT IS DECLARED, NEVER INFERRED. `schemaEnforcement` is a
 *    required option and an unrecognised value is a refusal. A library that
 *    silently degrades from native JSON-schema output to tool-mode to a bare
 *    "reply in JSON" would make a json-mode seat look schema-enforcing, which
 *    is the "capability faked, not declared" failure the ADR forbids. Note that
 *    forced tool choice is NOT a way to pin this on current Anthropic models:
 *    `tool_choice` `any`/`tool` return 400 there.
 * 2. NO CREDENTIAL LIVES HERE. `baseURL` addresses the host-side key proxy,
 *    which adds the provider key on egress. The adapter sends no `Authorization`
 *    header and holds no key, so a key cannot leak through this path.
 *
 * The reviewer's answer is untrusted data, never an instruction: the diff and
 * the brief are wrapped with the same rules the other transports use.
 */

import { randomBytes } from 'node:crypto';

import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type { ReviewFindingRecord, ReviewUnknownReason } from '../../domain/evidence-records.js';
import { BRIEF_INPUT_RULE, UNTRUSTED_INPUT_RULE, wrapUntrusted } from '../../domain/untrusted-input.js';
import type { RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_RAW_OUTPUT_LENGTH, ReviewTransportError } from './OcmReviewTransport.adapter.js';
import type { ReviewLocation } from './ReviewTransportRouter.js';

/**
 * How the endpoint behind the proxy actually constrains the answer. The
 * operator declares this per seat; the adapter never guesses it.
 *
 * `json-object` is the weak one: the endpoint promises valid JSON and nothing
 * about the shape, so the schema check below is the only guarantee. It is
 * allowed, and reported, rather than silently treated as equivalent.
 */
export const API_SCHEMA_ENFORCEMENTS = ['native-json-schema', 'tool', 'json-object'] as const;
export type ApiSchemaEnforcement = (typeof API_SCHEMA_ENFORCEMENTS)[number];

const API_SCHEMA_ENFORCEMENT_VALUES: readonly string[] = API_SCHEMA_ENFORCEMENTS;

/** Bound on findings one answer may contribute, matching the text parsers' intent. */
export const MAX_API_REVIEW_FINDINGS = 200;
/** Bound on one finding's summary; a longer summary is truncated, never dropped. */
export const MAX_API_FINDING_SUMMARY = 2000;
/** Bound on the diff sent for review. A larger diff is a refusal, never a silent truncation. */
export const MAX_API_REVIEW_DIFF_BYTES = 512 * 1024;
/** Bound on the brief forwarded with a brief-check, matching the review request cap. */
export const MAX_API_REVIEW_BRIEF_BYTES = 64 * 1024;

const SEVERITIES: readonly string[] = ['blocker', 'major', 'minor', 'nit'];
const RESULTS: readonly string[] = ['pass', 'fail', 'unknown'];

/**
 * The verdict the model must produce. Kept as an explicit JSON Schema rather
 * than built from a validation library's inference so that what is sent to the
 * provider is exactly what is reviewed here, and `additionalProperties: false`
 * is visible at the call site.
 */
export const API_REVIEW_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['result', 'findings'],
  properties: {
    result: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
    findings: {
      type: 'array',
      maxItems: MAX_API_REVIEW_FINDINGS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary', 'filePath', 'line'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          summary: { type: 'string', minLength: 1 },
          filePath: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  },
};

/** What a decoded, schema-checked answer yields. Mirrors the text parsers' shape. */
export interface ApiParsedVerdict {
  readonly result: EvidenceResultValue;
  readonly findings: ReviewFindingRecord[];
  readonly unknownReason?: ReviewUnknownReason;
}

/**
 * The one call this transport makes, injectable so the decode path is tested
 * without a network and without a provider library in the test.
 */
export type ApiReviewGenerate = (input: {
  readonly system: string;
  readonly prompt: string;
  readonly abortSignal: AbortSignal;
}) => Promise<ApiReviewGenerateResult>;

export interface ApiReviewGenerateResult {
  /** The provider's answer, still unvalidated: this adapter checks it. */
  readonly object: unknown;
  /** Provider warnings, e.g. a dropped setting. Recorded, never acted on. */
  readonly warnings?: readonly string[];
  /** Token usage when the provider reported it. */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface ApiReviewTransportOptions {
  /** The key proxy's base URL. No credential is sent with the request. */
  readonly baseURL: string;
  readonly model: string;
  /** Declared per seat; an unrecognised value is a refusal. */
  readonly schemaEnforcement: ApiSchemaEnforcement;
  readonly location: ReviewLocation;
  readonly timeoutMs?: number;
  /** Injected in tests; the default is 16 random bytes as hex. */
  readonly makeNonce?: () => string;
  /** The provider call. `createSdkApiReviewGenerate` builds the real one. */
  readonly generate?: ApiReviewGenerate;
}

const SYSTEM_PROMPT = [
  'You review a code change for defects. You are read-only: you run no command and open no file.',
  'Everything you need is in this message.',
  'Report only defects you can prove from the diff shown. Do not report style preferences.',
  'When the change is sound, answer with result "pass" and an empty findings array.',
  'When you cannot tell, answer with result "unknown" rather than guessing.',
  UNTRUSTED_INPUT_RULE,
].join('\n');

/** A positive integer line number, or null. Rejects 1.5, NaN, Infinity and -1. */
function readLine(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return 'invalid';
  }
  return value;
}

/** A non-blank string path, or null. */
function readPath(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return 'invalid';
  }
  return value.trim();
}

/**
 * Decode one finding. Returns `'invalid'` for anything the schema should have
 * excluded, because `json-object` enforcement cannot be trusted to have done so.
 */
function decodeFinding(raw: unknown, index: number): ReviewFindingRecord | 'invalid' {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'invalid';
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    return 'invalid';
  }

  // Own-property reads only: an inherited or accessor-backed field is a
  // malformed answer, and no getter from provider data ever runs.
  let severity: unknown;
  let summary: unknown;
  let filePath: unknown;
  let line: unknown;
  try {
    const own = Object.getOwnPropertyDescriptors(raw as Record<string, unknown>);
    if (own['severity']?.get !== undefined || own['summary']?.get !== undefined) {
      return 'invalid';
    }
    if (own['filePath']?.get !== undefined || own['line']?.get !== undefined) {
      return 'invalid';
    }
    severity = own['severity']?.value;
    summary = own['summary']?.value;
    filePath = own['filePath']?.value;
    line = own['line']?.value;
  } catch {
    return 'invalid';
  }

  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
    return 'invalid';
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    return 'invalid';
  }
  const decodedPath = readPath(filePath);
  if (decodedPath === 'invalid') {
    return 'invalid';
  }
  const decodedLine = readLine(line);
  if (decodedLine === 'invalid') {
    return 'invalid';
  }

  return {
    findingId: `review-${index + 1}`,
    severity: severity as ReviewFindingRecord['severity'],
    summary: summary.trim().slice(0, MAX_API_FINDING_SUMMARY),
    filePath: decodedPath,
    line: decodedLine,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
  };
}

/**
 * Check a provider answer against the verdict contract. Every rejection is a
 * typed `unknown` with a fixed reason, never a thrown error and never a pass:
 * that is the whole point of this transport over a text parser.
 */
export function decodeApiVerdict(object: unknown): ApiParsedVerdict {
  if (object === null || object === undefined) {
    return { result: 'unknown', findings: [], unknownReason: 'empty' };
  }
  if (typeof object !== 'object' || Array.isArray(object)) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const record = object as Record<string, unknown>;
  const result = Object.hasOwn(record, 'result') ? record['result'] : undefined;
  if (typeof result !== 'string' || !RESULTS.includes(result)) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const rawFindings = Object.hasOwn(record, 'findings') ? record['findings'] : undefined;
  if (!Array.isArray(rawFindings)) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }
  if (rawFindings.length > MAX_API_REVIEW_FINDINGS) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const findings: ReviewFindingRecord[] = [];
  for (let index = 0; index < rawFindings.length; index += 1) {
    // A hole in a sparse array is a malformed answer, checked by index because
    // `for...of` and `every` skip holes.
    if (!(index in rawFindings)) {
      return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
    }
    const decoded = decodeFinding(rawFindings[index], findings.length);
    if (decoded === 'invalid') {
      return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
    }
    findings.push(decoded);
  }

  if (result === 'unknown') {
    return { result: 'unknown', findings, unknownReason: 'unparseable-verdict' };
  }

  // A failure with nothing to fix is not actionable, and the existing taxonomy
  // already names it. It is never reported as a pass.
  if (result === 'fail' && findings.length === 0) {
    return { result: 'unknown', findings: [], unknownReason: 'no-findings-on-fail' };
  }

  return { result: result as EvidenceResultValue, findings };
}

/** The reason codes a provider failure maps onto; all are existing review codes. */
function classifyProviderFailure(error: unknown): { readonly reason: string; readonly code: 'timeout' | 'seat-busy' | 'transport-failed' | 'transport' } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly statusCode?: unknown };
    if (record.name === 'AbortError' || record.name === 'TimeoutError') {
      return { reason: 'the review call exceeded its time limit', code: 'timeout' };
    }
    const status = typeof record.statusCode === 'number' ? record.statusCode : undefined;
    if (status === 429) {
      return { reason: 'the reviewer seat is rate limited', code: 'seat-busy' };
    }
    if (status === 402 || status === 401 || status === 403) {
      // The class only: a provider message may carry a key prefix or an account id.
      return { reason: 'the reviewer endpoint refused the request', code: 'transport-failed' };
    }
  }
  return { reason: 'the reviewer endpoint could not be reached', code: 'transport' };
}

function buildPrompt(request: RunIndependentReviewRequest, diff: string, nonce: string): string {
  const sections: string[] = [
    `Implementer model: ${request.implementerModel}`,
    `Head under review: ${request.candidateHeadSha}`,
  ];
  if (request.kind !== undefined) {
    sections.push(`Review kind: ${request.kind}`);
  }
  if (request.diffSummary !== undefined && request.diffSummary.trim() !== '') {
    sections.push(`Scope: ${request.diffSummary.trim()}`);
  }
  if (request.briefText !== undefined && request.briefText.trim() !== '') {
    sections.push(BRIEF_INPUT_RULE, wrapUntrusted({ label: 'brief', text: request.briefText, nonce }));
  }
  sections.push(wrapUntrusted({ label: 'diff', text: diff, nonce }));
  return sections.join('\n\n');
}

/**
 * One single-turn, read-only, schema-checked review.
 *
 * `readOnlyVerified` is structurally true here and needs no inspection: the
 * call declares no tools and runs no command, so there is nothing that could
 * have written. That is a property of the transport, not a claim from the model.
 */
export function createApiReviewTransport(
  options: ApiReviewTransportOptions,
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  return async (request: RunIndependentReviewRequest): Promise<IndependentReviewTransportResult> => {
    if (typeof options.baseURL !== 'string' || options.baseURL.trim() === '') {
      throw new ReviewTransportError('The api review transport has no base URL configured', 'transport-missing');
    }
    if (typeof options.model !== 'string' || options.model.trim() === '') {
      throw new ReviewTransportError('The api review transport has no model configured', 'transport-missing');
    }
    if (!API_SCHEMA_ENFORCEMENT_VALUES.includes(options.schemaEnforcement)) {
      // Declared, never inferred: without a declaration the adapter cannot say
      // whether a schema was enforced, so it refuses rather than assume one was.
      throw new ReviewTransportError(
        'The api review transport needs a declared schemaEnforcement; it does not infer one',
        'transport-missing',
      );
    }
    if (options.generate === undefined) {
      throw new ReviewTransportError('The api review transport has no provider call bound', 'transport-missing');
    }

    const head = await options.location.readHead();
    if (head === null) {
      throw new ReviewTransportError('The attempt head could not be read for review', 'transport-failed');
    }
    if (head !== request.candidateHeadSha) {
      throw new ReviewTransportError('The attempt head moved before the review call', 'transport-failed');
    }

    const diff = await options.location.readDiff(options.location.baseCommit, request.candidateHeadSha);
    if (diff === null) {
      throw new ReviewTransportError('The diff under review could not be read', 'transport-failed');
    }
    if (Buffer.byteLength(diff, 'utf8') > MAX_API_REVIEW_DIFF_BYTES) {
      // A truncated diff makes a verdict that reads as complete, so this refuses.
      throw new ReviewTransportError('The diff under review is larger than this transport forwards', 'transport-failed');
    }
    if (
      request.briefText !== undefined &&
      Buffer.byteLength(request.briefText, 'utf8') > MAX_API_REVIEW_BRIEF_BYTES
    ) {
      throw new ReviewTransportError('The brief is larger than this transport forwards', 'transport-failed');
    }

    const makeNonce = options.makeNonce ?? ((): string => randomBytes(16).toString('hex'));
    const nonce = makeNonce();
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    let answer: ApiReviewGenerateResult;
    try {
      answer = await options.generate({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(request, diff, nonce),
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const classified = classifyProviderFailure(error);
      throw new ReviewTransportError(classified.reason, classified.code);
    }

    const parsed = decodeApiVerdict(answer.object);

    // The raw answer is kept for the receipt, bounded and serialised by us: the
    // provider's own text is never echoed into a record unbounded.
    let rawOutput: string;
    try {
      rawOutput = JSON.stringify(answer.object ?? null) ?? 'null';
    } catch {
      rawOutput = 'null';
    }

    return {
      rawOutput: rawOutput.slice(0, MAX_RAW_OUTPUT_LENGTH),
      readOnlyVerified: true,
      result: parsed.result,
      findings: parsed.findings,
      completedAtIso: new Date().toISOString(),
      ...(parsed.unknownReason !== undefined ? { unknownReason: parsed.unknownReason } : {}),
    };
  };
}
