// @generated adapter scaffold — refined for lane CO-WD8.
/**
 * SpdSayHostAudibleAlertAdapter: speak one validated sentence on the operator
 * host through `spd-say`. The sentence is untrusted input here: it is
 * validated (length and fixed character set) before anything is spawned, and
 * it reaches the child as ONE argv element with a fixed command and fixed
 * arguments — never through a shell, `PATH` lookup or string interpolation.
 * The adapter keeps no state between calls; whether to speak is decided by the
 * caller, never here.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { types } from 'node:util';

import type { SpawnRunOptions, SpawnRunOutcome } from './spawn-run.js';
import { allowListedChildEnv, runSpawnOutcome } from './spawn-run.js';
import { isPlainRecordObject } from '../../domain/record-schema-version.js';
import { TRAIN_HEALTH_SENTENCE_MAX_LENGTH } from '../../domain/train-health-announcements.js';
import type {
  HostAudibleAlertPort,
  HostAudibleAlertRequest,
  HostAudibleAlertResult,
} from '../../application/ports/out/HostAudibleAlertPort.out-port.js';

/** Fixed absolute candidate paths for the speech client binary. */
export const SPD_SAY_BINARY_CANDIDATES: readonly string[] = ['/usr/bin/spd-say', '/usr/local/bin/spd-say'];

/** Wall-clock budget for one `spd-say` run. */
export const SPD_SAY_TIMEOUT_MS = 10_000;

/** Named cap for the candidate list traversal. */
export const SPD_SAY_MAX_CANDIDATES = 16;

/** The only characters a sentence may carry; everything else is refused. */
const SENTENCE_CHARACTER_PATTERN = /^[A-Za-z0-9 .,#'-]+$/;

/** The only runtime directory shape forwarded to the child. */
const RUNTIME_DIR_PATTERN = /^\/run\/user\/[0-9]{1,10}$/;

/** Prototype-polluting keys are refused before any property read. */
const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export type SpdSaySentenceValidation =
  | { readonly ok: true; readonly sentence: string }
  | { readonly ok: false; reasonCode: 'invalid-request' };

export type SpdSayRequestParsing = SpdSaySentenceValidation;

export interface SpdSayHostAudibleAlertAdapterOptions {
  readonly candidates?: readonly string[];
  readonly isExecutable?: (candidate: string) => boolean;
  readonly run?: (file: string, args: readonly string[], options: SpawnRunOptions) => Promise<SpawnRunOutcome>;
  readonly timeoutMs?: number;
  readonly runtimeDir?: () => string | undefined;
}

/**
 * Validate one sentence. Total: it never throws. Cost is linear in the
 * sentence length, capped by `TRAIN_HEALTH_SENTENCE_MAX_LENGTH` (120); the
 * length is checked before any character scan.
 */
export function validateHostAudibleAlertSentence(sentence: unknown): SpdSaySentenceValidation {
  if (typeof sentence !== 'string') {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  if (sentence.length === 0 || sentence.length > TRAIN_HEALTH_SENTENCE_MAX_LENGTH) {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  if (sentence.trim().length === 0) {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  // Fixed set: ASCII letters, digits, space, and . , ' - #. This rejects
  // control characters (0x00-0x1F, 0x7F), newlines and every other character.
  if (!SENTENCE_CHARACTER_PATTERN.test(sentence)) {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  // Option injection: `-` is in the fixed set, but argv is exactly
  // `[sentence]` with no `--` separator, so a sentence starting with `-`
  // would reach the child as an option (`-h`, `-C`, `-S`, `-e`, `--help`).
  // Refuse any sentence whose FIRST character is `-`.
  if (sentence.startsWith('-')) {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  return { ok: true, sentence };
}

/** An own data property only: an accessor reads as undefined and never runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

/** True when the object carries a prototype-polluting own key. */
function hasPollutingKey(source: object): boolean {
  return POLLUTING_KEYS.some((key) => Object.getOwnPropertyDescriptor(source, key) !== undefined);
}

/**
 * Parse one request object. Total: it never throws — any throw while reading
 * the request (for example a revoked Proxy) reads as
 * `{ ok: false, reasonCode: 'invalid-request' }`. Cost is constant time
 * bounded by `TRAIN_HEALTH_SENTENCE_MAX_LENGTH` (the sentence validation cap).
 * The sentence is read through its own descriptor, so getters and Proxy
 * `get` traps never run.
 */
export function parseHostAudibleAlertRequest(request: unknown): SpdSayRequestParsing {
  try {
    if (isHostileRequestShape(request)) {
      return { ok: false, reasonCode: 'invalid-request' };
    }
    return validateHostAudibleAlertSentence(ownValue(request, 'sentence'));
  } catch {
    // A revoked (or otherwise hostile) Proxy may throw on any touch; refuse it
    // rather than letting the throw map onto `spawn-failed`.
    return { ok: false, reasonCode: 'invalid-request' };
  }
}

/**
 * The request must be a plain record (prototype `Object.prototype` or `null`,
 * non-array, non-Proxy) whose own keys are exactly `['sentence']` and without
 * a prototype-polluting own key. `isProxy` observes no trap and no getter.
 */
function isHostileRequestShape(request: unknown): boolean {
  // `isProxy` first: it observes no trap, while `isPlainRecordObject` reads the
  // prototype and would trigger a Proxy `getPrototypeOf` trap before the Proxy
  // is refused.
  if (types.isProxy(request)) {
    return true;
  }
  if (!isPlainRecordObject(request)) {
    return true;
  }
  if (hasPollutingKey(request)) {
    return true;
  }
  return Object.getOwnPropertyNames(request).some((key) => key !== 'sentence');
}

/**
 * The own `length` data value of the candidate array: a number when the
 * descriptor is a present data property, else null. Cost: one descriptor read.
 */
function candidateLengthValue(candidates: unknown[]): number | null {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(candidates, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
    return null;
  }
  return lengthDescriptor.value;
}

/**
 * Whether the own property at `key` is a present data property: a descriptor
 * with a value and no accessor pair. A hole (no descriptor), an accessor or a
 * throwing descriptor read is false. Cost: one descriptor read.
 */
function isOwnDataCandidateDescriptor(candidates: unknown[], key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(candidates, key);
  return descriptor !== undefined && 'value' in descriptor && !('get' in descriptor || 'set' in descriptor);
}

/**
 * Whether the object carries an own well-known symbol that could alter array
 * iteration or coercion. `for...in` never yields symbols, so these are
 * checked by named descriptor reads over a fixed list. Cost: one descriptor
 * read per listed symbol — constant.
 */
function hasForbiddenOwnSymbol(source: object): boolean {
  return FORBIDDEN_CANDIDATE_SYMBOLS.some((symbol) => Object.getOwnPropertyDescriptor(source, symbol) !== undefined);
}

/** Well-known symbols an own override of which is refused on the list. */
const FORBIDDEN_CANDIDATE_SYMBOLS: readonly symbol[] = [
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.isConcatSpreadable,
  Symbol.toPrimitive,
  Symbol.toStringTag,
];

/**
 * Whether every canonical index `0 .. length-1` holds an own data-property
 * string. Cost: linear in `length`, capped by `SPD_SAY_MAX_CANDIDATES` (16).
 */
function candidateElementsAreStrings(candidates: unknown[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (!isOwnDataCandidateDescriptor(candidates, index)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidates, index);
    if (descriptor === undefined || typeof descriptor.value !== 'string') {
      return false;
    }
  }
  return true;
}

/**
 * Whether the injected candidate list may be traversed: a plain (non-Proxy)
 * array within the cap whose length is read once from its own descriptor and
 * whose every entry is a string read from its own data descriptor, without a
 * polluting own key, hole, or accessor element. Own well-known symbols (whose
 * override could change iteration or coercion) are refused by name — this
 * covers an own `Symbol.iterator` override, whose getter or
 * data property would otherwise let iteration yield unvalidated paths). The
 * WHOLE list is validated before any entry is probed. `isProxy` observes no
 * trap and no getter.
 *
 * Cost: linear in the list length, capped by `SPD_SAY_MAX_CANDIDATES` (16),
 * plus constant named descriptor reads over the fixed `POLLUTING_KEYS` and
 * `FORBIDDEN_CANDIDATE_SYMBOLS` lists. The input is NEVER enumerated — no
 * `for...in`, `Object.keys`, `Object.entries`, `Reflect.ownKeys` or
 * `Object.getOwnPropertyNames` ever runs on it. Any check that refuses extra
 * own properties costs at least one step per own key (even `for...in`
 * materializes the object's own key list before its loop body can reject the
 * first extra key), and a hostile capped-length array can carry arbitrarily
 * many extra own properties, so such a check cannot be bounded. Instead the
 * extra properties — own or inherited — are tolerated and made unreachable:
 * only `length` and the indices `0 .. length-1` are ever read, each through
 * its own data descriptor, so an extra key can never be read, run a getter,
 * or reach a probe.
 */
function isTraversableCandidateList(candidates: unknown): boolean {
  try {
    if (!Array.isArray(candidates) || types.isProxy(candidates)) {
      return false;
    }
    const length = candidateLengthValue(candidates);
    if (length === null || length > SPD_SAY_MAX_CANDIDATES || hasPollutingKey(candidates)) {
      return false;
    }
    if (hasForbiddenOwnSymbol(candidates)) {
      return false;
    }
    return candidateElementsAreStrings(candidates, length);
  } catch {
    // A revoked (or otherwise hostile) Proxy may throw on any touch; refuse it.
    return false;
  }
}

/** True when the candidate may be probed: a plain string starting with `/`. */
function isAbsoluteCandidate(candidate: unknown): boolean {
  return typeof candidate === 'string' && candidate.startsWith('/');
}

/** Whether the candidate is an existing executable file; a throw is false. */
function defaultIsExecutable(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && isAccessible(candidate);
  } catch {
    return false;
  }
}

function isAccessible(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `isExecutable` with a throw counted as false. */
function probe(candidate: string, isExecutable: (candidate: string) => boolean): boolean {
  try {
    return isExecutable(candidate);
  } catch {
    return false;
  }
}

interface ResolvedBinary {
  readonly ok: true;
  readonly binary: string;
}

type BinaryResolution =
  | ResolvedBinary
  | { readonly ok: false; readonly reasonCode: 'invalid-request' | 'binary-missing' };

/**
 * Resolve the binary from the candidate list. The WHOLE list is validated
 * first (see `isTraversableCandidateList`), read only through own
 * descriptors (no getter runs, no Proxy trap runs); only then is any entry
 * probed. The caller's array is never iterated: each validated entry is
 * copied by own data descriptor (indices `0 .. length-1`, length captured
 * once) into a NEW local array, and only that copy is used, with an index
 * loop, for probing — so an own `Symbol.iterator` override can never yield a
 * path that was not validated. Cost is linear in the
 * list length, capped by `SPD_SAY_MAX_CANDIDATES` (16).
 */
function resolveBinary(candidates: unknown, isExecutable: (candidate: string) => boolean): BinaryResolution {
  if (!isTraversableCandidateList(candidates)) {
    return { ok: false, reasonCode: 'invalid-request' };
  }
  const length = (Object.getOwnPropertyDescriptor(candidates, 'length') as PropertyDescriptor).value as number;
  const validated: string[] = [];
  for (let index = 0; index < length; index += 1) {
    validated.push((Object.getOwnPropertyDescriptor(candidates, index) as PropertyDescriptor).value as string);
  }
  for (let index = 0; index < validated.length; index += 1) {
    const candidate = validated[index];
    // A relative candidate is ignored even when the probe would accept it.
    if (!isAbsoluteCandidate(candidate)) {
      continue;
    }
    if (probe(candidate, isExecutable)) {
      return { ok: true, binary: candidate };
    }
  }
  return { ok: false, reasonCode: 'binary-missing' };
}

/** The child environment: the allow list plus the one validated runtime dir. */
function childEnv(runtimeDir: string | undefined): Record<string, string> {
  const env = allowListedChildEnv('local');
  // `RegExp.test` coerces its argument to a string, so a non-string value
  // (for example an array like `['/run/user/1000']`) could pass the pattern
  // test; require a real string first.
  if (typeof runtimeDir === 'string' && RUNTIME_DIR_PATTERN.test(runtimeDir)) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }
  return env;
}

/** Clamp the caller's timeout into the accepted range, else the default. */
function resolvedTimeoutMs(timeoutMs: number | undefined): number {
  if (
    typeof timeoutMs === 'number' &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 100 &&
    timeoutMs <= 60_000
  ) {
    return timeoutMs;
  }
  return SPD_SAY_TIMEOUT_MS;
}

/** Map one spawn outcome onto the port's result, without echoing output. */
function mapOutcome(answer: unknown): HostAudibleAlertResult {
  if (typeof answer !== 'object' || answer === null) {
    return { outcome: 'failed', reasonCode: 'nonzero-exit' };
  }
  const error = ownValue(answer, 'error');
  const exitCode = ownValue(answer, 'exitCode');
  const signal = ownValue(answer, 'signal');
  if (error === undefined && exitCode === 0) {
    return { outcome: 'spoken' };
  }
  if (error !== undefined && signal !== null) {
    return { outcome: 'failed', reasonCode: 'killed' };
  }
  if (error !== undefined) {
    return { outcome: 'failed', reasonCode: 'spawn-failed' };
  }
  return { outcome: 'failed', reasonCode: 'nonzero-exit' };
}

export class SpdSayHostAudibleAlertAdapter implements HostAudibleAlertPort {
  private readonly options: SpdSayHostAudibleAlertAdapterOptions;

  constructor(options: SpdSayHostAudibleAlertAdapterOptions = {}) {
    this.options = options;
  }

  async speak(request: HostAudibleAlertRequest | unknown): Promise<HostAudibleAlertResult> {
    try {
      return await this.attemptSpeak(request);
    } catch {
      return { outcome: 'failed', reasonCode: 'spawn-failed' };
    }
  }

  private async attemptSpeak(request: unknown): Promise<HostAudibleAlertResult> {
    const parsed = parseHostAudibleAlertRequest(request);
    if (!parsed.ok) {
      return { outcome: 'refused', reasonCode: 'invalid-request' };
    }
    const candidates = this.options.candidates ?? SPD_SAY_BINARY_CANDIDATES;
    const binary = resolveBinary(candidates, this.options.isExecutable ?? defaultIsExecutable);
    if (!binary.ok) {
      return binary.reasonCode === 'invalid-request'
        ? { outcome: 'refused', reasonCode: 'invalid-request' }
        : { outcome: 'unavailable', reasonCode: 'binary-missing' };
    }
    const run = this.options.run ?? runSpawnOutcome;
    const answer = await run(binary.binary, [parsed.sentence], {
      env: childEnv(this.runtimeDirValue()),
      timeoutMs: resolvedTimeoutMs(this.options.timeoutMs),
      maxBufferBytes: 65_536,
    });
    return mapOutcome(answer);
  }

  private runtimeDirValue(): string | undefined {
    const runtimeDir = this.options.runtimeDir ?? (() => process.env.XDG_RUNTIME_DIR);
    return runtimeDir();
  }
}
