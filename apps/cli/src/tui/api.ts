/**
 * The TUI's HTTP client for the owner-question and tool-permission screens.
 * It talks to the `/v1` boundary with an in-memory bearer token only: a token
 * is never read from disk, never taken from argv and never put in a URL. Every
 * function answers `{ ok: false, reason }` on any failure and never throws;
 * every wire value is read through own-property descriptors, so a getter is
 * refused without running.
 */

export const MAX_QUESTIONS = 128;
export const MAX_PERMISSIONS = 128;
export const MAX_INPUT_TEXT_CHARS = 1024;
export const MAX_RESPONSE_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_FIELD_CHARS = 4096;
const MAX_OPTIONS = 32;
const RESERVED_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export interface TuiApiClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export type TuiApiFailure = { readonly ok: false; readonly reason: string };

export interface TuiQuestionOption {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
}

export interface TuiQuestion {
  readonly questionId: string;
  readonly revision: number;
  readonly title: string;
  readonly body: string;
  readonly options: readonly TuiQuestionOption[];
  readonly recommendationOptionId: string;
  readonly recommendationBecause: string;
  readonly doorKind: 'one-way' | 'two-way';
}

export interface TuiPermissionRequest {
  readonly requestId: string;
  readonly toolCode: string;
  readonly deadlineAt: string;
}

export interface TuiAnswerInput {
  readonly questionId: string;
  readonly questionRevision: number;
  readonly shape: 'accept' | 'reject' | 'answer';
  readonly optionId?: string;
  readonly text?: string;
  readonly reason?: string;
}

export type TuiVerdictDecision = 'allow' | 'deny';

export type ExchangeResult =
  | { readonly ok: true; readonly token: string; readonly scopes: readonly string[] }
  | TuiApiFailure;
export type ListQuestionsResult =
  | { readonly ok: true; readonly questions: readonly TuiQuestion[]; readonly truncated: boolean }
  | TuiApiFailure;
export type AnswerQuestionResult =
  | { readonly ok: true; readonly outcome: 'answered'; readonly replayed: boolean }
  | TuiApiFailure;
export type ListPermissionsResult =
  | { readonly ok: true; readonly requests: readonly TuiPermissionRequest[]; readonly truncated: boolean }
  | TuiApiFailure;
export type VerdictResult =
  | { readonly ok: true; readonly decision: TuiVerdictDecision; readonly conflict: boolean }
  | TuiApiFailure;

export interface TuiApiClient {
  readonly listOpenQuestions: () => Promise<ListQuestionsResult>;
  readonly answerQuestion: (input: TuiAnswerInput) => Promise<AnswerQuestionResult>;
  readonly listPendingPermissions: (threadId: string) => Promise<ListPermissionsResult>;
  readonly givePermissionVerdict: (
    threadId: string,
    requestId: string,
    decision: TuiVerdictDecision,
  ) => Promise<VerdictResult>;
}

const fail = (reason: string): TuiApiFailure => ({ ok: false, reason });

/** `encodeURIComponent` that never throws (an unpaired surrogate throws a URIError); `null` when unencodable. */
function encodeId(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  try {
    return encodeURIComponent(id);
  } catch {
    return null;
  }
}

/** Reads one own data property; a getter, a missing key or a non-record is `undefined`. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || RESERVED_KEYS.includes(key)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    return undefined;
  }
  return descriptor.value;
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_FIELD_CHARS ? value : null;
}

interface RawResponse {
  readonly status: number;
  readonly json: unknown;
}

type RawResult = { readonly ok: true; readonly response: RawResponse } | TuiApiFailure;

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

interface BoundedText {
  readonly text: string;
  readonly tooLarge: boolean;
}

/** Reads the body at most `MAX_RESPONSE_BYTES` deep: a larger body is cancelled, never buffered whole. */
async function readBoundedText(response: Response): Promise<BoundedText> {
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    return typeof text === 'string' && new TextEncoder().encode(text).length <= MAX_RESPONSE_BYTES
      ? { text, tooLarge: false }
      : { text: '', tooLarge: typeof text === 'string' };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { text: '', tooLarge: true };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), tooLarge: false };
}

async function send(
  options: TuiApiClientOptions,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<RawResult> {
  const base = typeof options.baseUrl === 'string' ? options.baseUrl.trim().replace(/\/+$/, '') : '';
  if (base.length === 0) {
    return fail('api-not-configured');
  }
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(`${base}${path}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    clearTimeout(timer);
    return fail(isAbort(error) || controller.signal.aborted ? 'request-timeout' : 'network-error');
  }
  let status: unknown;
  try {
    status = response.status;
  } catch {
    clearTimeout(timer);
    return fail('malformed-envelope');
  }
  let read: BoundedText;
  try {
    read = await readBoundedText(response);
  } catch (error) {
    return fail(isAbort(error) || controller.signal.aborted ? 'request-timeout' : 'network-error');
  } finally {
    clearTimeout(timer);
  }
  if (typeof status !== 'number') {
    return fail('invalid-response');
  }
  if (read.tooLarge) {
    return fail('response-too-large');
  }
  const text = read.text;
  if (text.trim().length === 0) {
    return fail('invalid-response');
  }
  try {
    return { ok: true, response: { status, json: JSON.parse(text) as unknown } };
  } catch {
    return fail('invalid-response');
  }
}

/** The refusal for a non-success status; `null` when the status is a success or a verdict conflict to read. */
function statusFailure(response: RawResponse, allowConflict: boolean): string | null {
  const { status, json } = response;
  if (status >= 200 && status < 300) {
    return null;
  }
  const code = own(json, 'code');
  const reasonValue = own(own(json, 'result'), 'reason');
  const reason = typeof reasonValue === 'string' && reasonValue.length > 0 && reasonValue.length <= 256 ? reasonValue : null;
  switch (status) {
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 409:
      if (code === 'EXPIRED') {
        return 'expired';
      }
      return allowConflict && code === 'OK' ? null : (reason ?? 'conflict');
    case 400:
    case 422:
      return reason ?? 'refused';
    case 500:
      return 'server-error';
    case 501:
      return 'not-implemented';
    case 503:
      return 'store-unavailable';
    default:
      return 'unexpected-status';
  }
}

function okResult(json: unknown): object | null {
  if (!isRecord(json) || own(json, 'code') !== 'OK') {
    return null;
  }
  const result = own(json, 'result');
  return isRecord(result) ? result : null;
}

function parseQuestion(value: unknown): TuiQuestion | null {
  if (!isRecord(value)) {
    return null;
  }
  const questionId = boundedString(own(value, 'questionId'));
  const revision = own(value, 'revision');
  const title = boundedString(own(value, 'title'));
  const body = boundedString(own(value, 'body'));
  const doorKind = own(value, 'doorKind');
  const rawOptions = own(value, 'options');
  const recommendation = own(value, 'recommendation');
  if (
    questionId === null || questionId.length === 0 || title === null || body === null ||
    typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1 ||
    (doorKind !== 'one-way' && doorKind !== 'two-way') ||
    !Array.isArray(rawOptions) || rawOptions.length > MAX_OPTIONS || !isRecord(recommendation)
  ) {
    return null;
  }
  const options: TuiQuestionOption[] = [];
  for (let i = 0; i < rawOptions.length; i += 1) {
    const raw: unknown = Object.hasOwn(rawOptions, i) ? rawOptions[i] : undefined;
    const id = boundedString(own(raw, 'id'));
    const label = boundedString(own(raw, 'label'));
    const consequence = boundedString(own(raw, 'consequence'));
    if (id === null || id.length === 0 || label === null || consequence === null) {
      return null;
    }
    options.push({ id, label, consequence });
  }
  const optionId = boundedString(own(recommendation, 'optionId'));
  const because = boundedString(own(recommendation, 'because'));
  if (optionId === null || because === null) {
    return null;
  }
  return { questionId, revision, title, body, options, recommendationOptionId: optionId, recommendationBecause: because, doorKind };
}

function parsePermission(value: unknown): TuiPermissionRequest | null {
  const requestId = boundedString(own(value, 'requestId'));
  const toolCode = boundedString(own(value, 'toolCode'));
  const deadlineAt = boundedString(own(value, 'deadlineAt'));
  if (requestId === null || requestId.length === 0 || toolCode === null || deadlineAt === null) {
    return null;
  }
  return { requestId, toolCode, deadlineAt };
}

function readList<T>(
  result: object,
  key: string,
  max: number,
  parse: (value: unknown) => T | null,
): { readonly items: readonly T[]; readonly truncated: boolean } | null {
  const raw = own(result, key);
  if (!Array.isArray(raw)) {
    return null;
  }
  const items: T[] = [];
  for (let i = 0; i < Math.min(raw.length, max); i += 1) {
    const parsed = parse(Object.hasOwn(raw, i) ? raw[i] : undefined);
    if (parsed === null) {
      return null;
    }
    items.push(parsed);
  }
  return { items, truncated: raw.length > max };
}

function authHeaders(token: string | undefined, json: boolean): Record<string, string> | null {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  return { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) };
}

/** Exchanges the interactive session secret once for an in-memory scoped token. */
export async function exchangeSessionToken(
  baseUrl: string,
  sessionSecret: string,
  scopes: readonly string[],
  options?: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<ExchangeResult> {
  if (typeof sessionSecret !== 'string' || sessionSecret.length === 0) {
    return fail('session-exchange-refused');
  }
  const raw = await send(
    { baseUrl, ...(options ?? {}) },
    'POST',
    '/sessions/exchange',
    { 'x-fleet-session-exchange': sessionSecret, 'content-type': 'application/json' },
    { scopes },
  );
  if (!raw.ok) {
    return raw.reason === 'api-not-configured' ? raw : fail('session-exchange-refused');
  }
  try {
    const token = own(raw.response.json, 'token');
    const granted = own(raw.response.json, 'scopes');
    if (raw.response.status !== 200 || typeof token !== 'string' || token.length === 0 || !Array.isArray(granted)) {
      return fail('session-exchange-refused');
    }
    return { ok: true, token, scopes: granted.filter((s): s is string => typeof s === 'string') };
  } catch {
    return fail('session-exchange-refused');
  }
}

export function createTuiApiClient(options: TuiApiClientOptions): TuiApiClient {
  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    allowConflict: boolean,
  ): Promise<{ readonly ok: true; readonly status: number; readonly json: unknown } | TuiApiFailure> {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim().length === 0) {
      return fail('api-not-configured');
    }
    const headers = authHeaders(options.token, body !== undefined);
    if (headers === null) {
      return fail('missing-token');
    }
    const raw = await send(options, method, path, headers, body);
    if (!raw.ok) {
      return raw;
    }
    try {
      const failure = statusFailure(raw.response, allowConflict);
      if (failure !== null) {
        return fail(failure);
      }
      return { ok: true, status: raw.response.status, json: raw.response.json };
    } catch {
      return fail('malformed-envelope');
    }
  }

  return {
    listOpenQuestions: async () => {
      const res = await call('GET', '/v1/questions?state=open', undefined, false);
      if (!res.ok) {
        return res;
      }
      try {
        const result = okResult(res.json);
        if (result === null) {
          return fail('malformed-envelope');
        }
        const list = readList(result, 'questions', MAX_QUESTIONS, parseQuestion);
        return list === null ? fail('malformed-list') : { ok: true, questions: list.items, truncated: list.truncated };
      } catch {
        return fail('malformed-envelope');
      }
    },
    answerQuestion: async (input) => {
      const body: Record<string, unknown> = { questionRevision: input.questionRevision, shape: input.shape };
      if (input.optionId !== undefined) {
        body.optionId = input.optionId;
      }
      if (input.text !== undefined) {
        body.text = input.text.slice(0, MAX_INPUT_TEXT_CHARS);
      }
      if (input.reason !== undefined) {
        body.reason = input.reason.slice(0, MAX_INPUT_TEXT_CHARS);
      }
      const id = encodeId(input.questionId);
      if (id === null) {
        return fail('invalid-id');
      }
      const res = await call('POST', `/v1/questions/${id}/answers`, body, false);
      if (!res.ok) {
        return res;
      }
      try {
        const result = okResult(res.json);
        const outcome = own(result, 'outcome');
        const replayed = own(result, 'replayed');
        if (result === null || outcome !== 'answered' || typeof replayed !== 'boolean') {
          return fail('malformed-envelope');
        }
        return { ok: true, outcome: 'answered', replayed };
      } catch {
        return fail('malformed-envelope');
      }
    },
    listPendingPermissions: async (threadId) => {
      const thread = encodeId(threadId);
      if (thread === null) {
        return fail('invalid-id');
      }
      const res = await call('GET', `/v1/threads/${thread}/permissions?state=pending`, undefined, false);
      if (!res.ok) {
        return res;
      }
      try {
        const result = okResult(res.json);
        if (result === null) {
          return fail('malformed-envelope');
        }
        const list = readList(result, 'requests', MAX_PERMISSIONS, parsePermission);
        return list === null ? fail('malformed-list') : { ok: true, requests: list.items, truncated: list.truncated };
      } catch {
        return fail('malformed-envelope');
      }
    },
    givePermissionVerdict: async (threadId, requestId, decision) => {
      const thread = encodeId(threadId);
      const request = encodeId(requestId);
      if (thread === null || request === null) {
        return fail('invalid-id');
      }
      const res = await call('POST', `/v1/threads/${thread}/permissions/${request}/verdict`, { decision }, true);
      if (!res.ok) {
        return res;
      }
      try {
        const result = okResult(res.json);
        const first = own(result, 'decision');
        if (result === null || (first !== 'allow' && first !== 'deny')) {
          return fail('malformed-envelope');
        }
        return { ok: true, decision: first, conflict: res.status === 409 };
      } catch {
        return fail('malformed-envelope');
      }
    },
  };
}
