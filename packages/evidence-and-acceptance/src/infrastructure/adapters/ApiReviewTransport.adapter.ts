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
 * `native-json-schema` sends `response_format: {type: 'json_schema', ...}`;
 * `json-object` sends `{type: 'json_object'}`, where the endpoint promises
 * valid JSON and nothing about the shape, so the decoder below is the only
 * guarantee. It is allowed, and declared, never silently treated as equivalent.
 *
 * A `tool` level was offered until the pre-merge re-check established it was a
 * lie on the wire: this library has no tool mode for a typed object call, so a
 * seat declaring `tool` was sent `json_schema` anyway. An enforcement value the
 * library cannot deliver must not be declarable, so it was removed rather than
 * documented.
 */
export const API_SCHEMA_ENFORCEMENTS = ['native-json-schema', 'json-object'] as const;
export type ApiSchemaEnforcement = (typeof API_SCHEMA_ENFORCEMENTS)[number];

const API_SCHEMA_ENFORCEMENT_VALUES: readonly string[] = API_SCHEMA_ENFORCEMENTS;

/**
 * Bound on findings one answer may contribute. Enforced by the decoder, not by
 * the schema: `strict: true` plus validation keywords (`maxItems`, `minLength`,
 * `minimum`) is rejected by some endpoints' strict modes, and sending a schema
 * is new as of this change, so the keywords were dropped and the decoder keeps
 * the bound (pre-merge re-check, finding D).
 */
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
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary', 'filePath', 'line'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          summary: { type: 'string' },
          filePath: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'] },
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
  /**
   * The provider answered, but not with an object the library could parse at
   * all (a non-JSON reply). The provider module reports it here instead of
   * throwing, so it decodes as `unknown`/`unparseable-verdict` rather than
   * being misclassified as an unreachable endpoint (pre-merge finding 5).
   */
  readonly noObject?: boolean;
  /**
   * The call declared no tools and ran no process, so nothing could have
   * written. Only the caller that MADE the call can say this, which is why it
   * is reported here rather than assumed by the transport: `generate` is an
   * injected function and the transport cannot see what it does. Absent or
   * false means the transport reports `readOnlyVerified: false` (round 2,
   * finding 6).
   */
  readonly readOnly?: boolean;
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

/**
 * One own DATA property. An absent, inherited or accessor-backed field, or a
 * descriptor read that throws, is reported rather than read: a provider answer
 * must never be able to run code here or to decide a verdict through a getter.
 *
 * Luna and the pre-merge pass both found the previous version reading top-level
 * fields with `record['result']`, which ran accessors and could throw out of the
 * decoder. Every read now goes through this.
 */
type OwnRead =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' };

function readOwn(target: object, key: string): OwnRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) {
      return { kind: 'absent' };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { kind: 'unreadable' };
    }
    return { kind: 'value', value: descriptor.value };
  } catch {
    // A Proxy trap that throws is a malformed answer, not a crash.
    return { kind: 'unreadable' };
  }
}

/**
 * True when the object carries only the keys the schema declares. The schema
 * says `additionalProperties: false`, so an answer with extra keys is not
 * conforming; the previous version declared that and did not check it, which
 * also let unreviewed provider text reach the stored raw copy.
 */
function hasOnlyKeys(target: object, allowed: readonly string[]): boolean {
  try {
    const names = Object.getOwnPropertyNames(target);
    for (const name of names) {
      if (!allowed.includes(name)) {
        return false;
      }
    }
    return Object.getOwnPropertySymbols(target).length === 0;
  } catch {
    return false;
  }
}

/**
 * A line number that can actually identify a source line: a safe integer of 1
 * or more. `Number.isInteger(1e100)` is true, so the safe-integer check is the
 * one that matters.
 */
function readLine(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
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

const FINDING_KEYS = ['severity', 'summary', 'filePath', 'line'] as const;
const VERDICT_KEYS = ['result', 'findings'] as const;

/** A plain object: an `Object.prototype` or null prototype, and not an array. */
function isPlainish(raw: unknown): raw is object {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  try {
    if (Array.isArray(raw)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(raw);
    return prototype === Object.prototype || prototype === null;
  } catch {
    // A revoked Proxy throws here. Malformed, not a crash.
    return false;
  }
}

/**
 * Decode one finding. Returns `'invalid'` for anything the schema should have
 * excluded, because `json-object` enforcement cannot be trusted to have done so.
 */
function decodeFinding(raw: unknown, index: number): ReviewFindingRecord | 'invalid' {
  if (!isPlainish(raw)) {
    return 'invalid';
  }
  if (!hasOnlyKeys(raw, FINDING_KEYS)) {
    return 'invalid';
  }

  const severityRead = readOwn(raw, 'severity');
  const summaryRead = readOwn(raw, 'summary');
  const pathRead = readOwn(raw, 'filePath');
  const lineRead = readOwn(raw, 'line');
  if (severityRead.kind !== 'value' || summaryRead.kind !== 'value') {
    return 'invalid';
  }
  // The schema marks filePath and line REQUIRED (they may be null, but they may
  // not be absent). Round 2 found them defaulted to null when missing, which
  // accepted a finding the declared schema excludes.
  if (pathRead.kind !== 'value' || lineRead.kind !== 'value') {
    return 'invalid';
  }

  const severity = severityRead.value;
  const summary = summaryRead.value;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
    return 'invalid';
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    return 'invalid';
  }
  const decodedPath = readPath(pathRead.value);
  if (decodedPath === 'invalid') {
    return 'invalid';
  }
  const decodedLine = readLine(lineRead.value);
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
 * typed `unknown` with a fixed reason, NEVER a thrown error and never a pass:
 * that is the whole point of this transport over a text parser.
 *
 * The outer try is deliberate belt and braces. Every read below is already
 * descriptor-based, but a hostile object can throw from places that are easy to
 * miss, and a decoder that throws would break the contract this function exists
 * to provide.
 */
export function decodeApiVerdict(object: unknown): ApiParsedVerdict {
  try {
    return decodeChecked(object);
  } catch {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }
}

function decodeChecked(object: unknown): ApiParsedVerdict {
  if (object === null || object === undefined) {
    return { result: 'unknown', findings: [], unknownReason: 'empty' };
  }
  if (!isPlainish(object)) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }
  if (!hasOnlyKeys(object, VERDICT_KEYS)) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const resultRead = readOwn(object, 'result');
  const findingsRead = readOwn(object, 'findings');
  if (resultRead.kind !== 'value' || findingsRead.kind !== 'value') {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const result = resultRead.value;
  if (typeof result !== 'string' || !RESULTS.includes(result)) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const rawFindings = findingsRead.value;
  let length: number;
  try {
    if (!Array.isArray(rawFindings)) {
      return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
    }
    length = rawFindings.length;
  } catch {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }
  if (!Number.isSafeInteger(length) || length > MAX_API_REVIEW_FINDINGS) {
    return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
  }

  const findings: ReviewFindingRecord[] = [];
  for (let index = 0; index < length; index += 1) {
    // A hole in a sparse array is a malformed answer, checked by index because
    // `for...of` and `every` skip holes. The element itself is read as an own
    // data property so an index-level getter cannot run.
    const element = readOwn(rawFindings as unknown as object, String(index));
    if (element.kind !== 'value') {
      return { result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' };
    }
    const decoded = decodeFinding(element.value, findings.length);
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
/**
 * The HTTP status behind a provider failure, following the library's retry
 * wrapper.
 *
 * The pre-merge re-check established that `seat-busy` was unreachable: a 429 is
 * retryable, so the library absorbs the first and, when the next exceeds the
 * retry budget, throws a wrapper whose OWN object has no `statusCode` — the 429
 * sits in its `errors` array and `lastError`. Reading only the top-level field
 * classified every surfaced 429 as "could not be reached", which defeated the
 * stated reason for using a library at all. This walks the chain, by descriptor
 * only, to a bounded depth.
 */
function findStatusCode(error: unknown, depth: number): number | undefined {
  if (depth > 4 || typeof error !== 'object' || error === null) {
    return undefined;
  }

  const direct = readOwn(error, 'statusCode');
  if (direct.kind === 'value' && typeof direct.value === 'number') {
    return direct.value;
  }

  const last = readOwn(error, 'lastError');
  if (last.kind === 'value') {
    const found = findStatusCode(last.value, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }

  const nested = readOwn(error, 'errors');
  if (nested.kind === 'value') {
    const list = nested.value;
    let length = 0;
    try {
      length = Array.isArray(list) ? list.length : 0;
    } catch {
      length = 0;
    }
    if (!Number.isSafeInteger(length) || length > 16) {
      return undefined;
    }
    // Last first: the most recent attempt is the one that surfaced.
    for (let index = length - 1; index >= 0; index -= 1) {
      const element = readOwn(list as unknown as object, String(index));
      if (element.kind !== 'value') {
        continue;
      }
      const found = findStatusCode(element.value, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
  }

  const cause = readOwn(error, 'cause');
  if (cause.kind === 'value') {
    return findStatusCode(cause.value, depth + 1);
  }
  return undefined;
}

function classifyProviderFailure(error: unknown): { readonly reason: string; readonly code: 'timeout' | 'seat-busy' | 'transport-failed' | 'transport' } {
  // Round 2: these fields were read directly, so a provider-controlled getter
  // could run and throw, escaping the catch with the original error and its
  // text. Both reads now go through the descriptor helper, which cannot run a
  // getter, and an own `name`/`statusCode` that IS accessor-backed is simply
  // not classified rather than trusted.
  if (typeof error !== 'object' || error === null) {
    return { reason: 'the reviewer endpoint could not be reached', code: 'transport' };
  }

  const nameRead = readOwn(error, 'name');
  const name = nameRead.kind === 'value' ? nameRead.value : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { reason: 'the review call exceeded its time limit', code: 'timeout' };
  }

  const status = findStatusCode(error, 0);
  if (status === 429) {
    return { reason: 'the reviewer seat is rate limited', code: 'seat-busy' };
  }
  if (status === 402 || status === 401 || status === 403) {
    // The class only: a provider message may carry a key prefix or an account id.
    return { reason: 'the reviewer endpoint refused the request', code: 'transport-failed' };
  }
  return { reason: 'the reviewer endpoint could not be reached', code: 'transport' };
}

/**
 * Diff first, instructions last.
 *
 * Prompt caching covers a stable PREFIX. The diff is the one part two reviews
 * of the same head share, so it leads; the brief, the metadata and the
 * instruction text trail it (ADR-0002, action 1). Only the order changed: the
 * same sections are emitted, with the same `wrapUntrusted` calls and the same
 * caller-supplied nonce. The brief rule stays immediately above the brief block
 * because it says "below".
 */
function buildPrompt(request: RunIndependentReviewRequest, diff: string, nonce: string): string {
  const sections: string[] = [wrapUntrusted({ label: 'diff', text: diff, nonce })];
  if (request.briefText !== undefined && request.briefText.trim() !== '') {
    sections.push(BRIEF_INPUT_RULE, wrapUntrusted({ label: 'brief', text: request.briefText, nonce }));
  }
  sections.push(
    `Implementer model: ${request.implementerModel}`,
    `Head under review: ${request.candidateHeadSha}`,
  );
  if (request.kind !== undefined) {
    sections.push(`Review kind: ${request.kind}`);
  }
  if (request.diffSummary !== undefined && request.diffSummary.trim() !== '') {
    sections.push(`Scope: ${request.diffSummary.trim()}`);
  }
  return sections.join('\n\n');
}

/**
 * One single-turn, read-only, schema-checked review.
 *
 * `readOnlyVerified` is reported by the provider call, not assumed here. The
 * SDK binding declares no tools and runs no process, so it reports true; an
 * injected call that does not say so yields false. The transport cannot inspect
 * an arbitrary function, so it does not claim to (round 2, finding 6).
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
    if (diff.trim() === '') {
      // A blank diff is reachable in production: when the recorded base equals
      // the head under review, `git diff X X` prints nothing and exits 0, so the
      // locator returns '' rather than null. Sending it asks the model to judge
      // nothing, and the system prompt invites a "pass". The opencode transport
      // already refuses exactly this in `classifyDiffForEmbedding`; this follows it.
      throw new ReviewTransportError('The change under review could not be seen', 'transport-failed');
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

    // A TRIPWIRE, not the guarantee. The declaration is true by construction:
    // the provider module sets the library's structured-output flag from this
    // same value, so `native-json-schema` sends a schema and `json-object` does
    // not, and the library does not emit this warning on the path that reaches
    // here. The pre-merge re-check was right that an earlier commit message
    // overstated this as the mechanism catching a false declaration. It is kept
    // because it costs nothing and would fire if a library change broke that
    // correspondence.
    const warnings = answer.warnings ?? [];
    if (options.schemaEnforcement !== 'json-object' && warnings.includes('unsupported:responseFormat')) {
      throw new ReviewTransportError(
        'The endpoint did not enforce the declared response schema',
        'transport-failed',
      );
    }

    const parsed =
      answer.noObject === true
        ? ({ result: 'unknown', findings: [], unknownReason: 'unparseable-verdict' } as const)
        : decodeApiVerdict(answer.object);

    // The receipt copy is built from the DECODED verdict, never from the
    // provider's object: serialising the raw answer would persist any extra
    // property the model added, which is unreviewed provider text in a record
    // (review finding 3). Only fields this adapter validated are kept.
    let rawOutput: string;
    try {
      rawOutput =
        JSON.stringify({
          result: parsed.result,
          ...(parsed.unknownReason !== undefined ? { unknownReason: parsed.unknownReason } : {}),
          findings: parsed.findings.map((finding) => ({
            severity: finding.severity,
            summary: finding.summary,
            filePath: finding.filePath,
            line: finding.line,
          })),
        }) ?? 'null';
    } catch {
      rawOutput = 'null';
    }

    return {
      rawOutput: rawOutput.slice(0, MAX_RAW_OUTPUT_LENGTH),
      // Reported by the provider call, never assumed: see `readOnly` above.
      readOnlyVerified: answer.readOnly === true,
      result: parsed.result,
      findings: parsed.findings,
      completedAtIso: new Date().toISOString(),
      ...(parsed.unknownReason !== undefined ? { unknownReason: parsed.unknownReason } : {}),
    };
  };
}
