/**
 * Review transport router: picks the installation's reviewer seat for the
 * requested reviewer model and dispatches to the transport for that seat's
 * tool. opencode seats go through `ocm-run`; `grok` seats through the CLI
 * transport.
 *
 * A seat is chosen only from the reviewer and high-risk-reviewer chains, and
 * only by an exact model match. `--agent reviewer` is the default from
 * `docs/planning/2026-10-15_cutover-completion.md` station 5. Independence
 * (a different model family from the implementer) is enforced before the
 * router by `IndependentReviewAdapter` and `RequestIndependentReviewUseCase`.
 */

import type { ReviewUnavailableCode, RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import { CLI_REVIEW_ARGV_TEMPLATES, createCliReviewTransport } from './CliReviewTransport.adapter.js';
import type { CliReviewSpawn } from './CliReviewTransport.adapter.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import { createSdkApiReviewGenerate } from './ApiReviewProvider.js';
import { createApiReviewTransport } from './ApiReviewTransport.adapter.js';
import type { ApiReviewGenerate, ApiSchemaEnforcement } from './ApiReviewTransport.adapter.js';
import { createOcmReviewTransport, ReviewTransportError } from './OcmReviewTransport.adapter.js';
import type { OcmReviewTransportSpawn } from './OcmReviewTransport.adapter.js';
import { describeApiReviewConfigProblem, isApiReviewConfigProblemCode } from './ApiReviewSettings.js';
import type { ApiReviewConfigProblemCode } from './ApiReviewSettings.js';

export interface ReviewTransportSeat {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly roles: readonly string[];
}

export interface ReviewTransportChainStep {
  readonly seatId: string;
}

export interface ReviewTransportChains {
  readonly reviewer?: readonly ReviewTransportChainStep[];
  readonly 'high-risk-reviewer'?: readonly ReviewTransportChainStep[];
}

/** How an opencode review reaches the server that can see the attempt's worktree. */
export type ReviewRunnerRoute =
  | { readonly kind: 'installation'; readonly remotePort: number; readonly remoteHost: string; readonly authFile?: string }
  | { readonly kind: 'legacy'; readonly remotePort?: number; readonly remoteHost?: string }
  | { readonly kind: 'none'; readonly reason: string; readonly code?: 'route-host-changed' | 'route-not-opencode' | 'route-no-port' | 'route-no-auth-file' };

/** Where the attempt under review lives, and read-only git reads through its recorded host. */
export interface ReviewLocation {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly route: ReviewRunnerRoute;
  readHead(): Promise<string | null>;
  readStatus(): Promise<string | null>;
  readDiff(fromSha: string, toSha: string): Promise<string | null>;
}

/**
 * Hard caps on the untrusted shapes these boundary helpers accept. Every read
 * below is linear in the capped input: a chain is at most
 * `MAX_REVIEW_CHAIN_STEPS` steps, the seat list at most `MAX_REVIEW_SEATS`
 * entries, a seat's roles at most `MAX_SEAT_ROLES` strings, and the reviewer
 * model at most `MAX_REVIEWER_MODEL_BYTES` bytes. Anything over a cap is
 * refused before any traversal, so no hostile length can drive a long loop.
 */
export const MAX_REVIEW_CHAIN_STEPS = 64;
export const MAX_REVIEW_SEATS = 256;
export const MAX_SEAT_ROLES = 32;
export const MAX_REVIEWER_MODEL_BYTES = 256;

/** Keys that must never travel as a seat id, whatever produced the object. */
const PROTOTYPE_POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A plain data object: prototype `Object.prototype` or `null`, never an array.
 * A class instance, a Map, or anything exotic is refused rather than probed.
 */
function isPlainObject(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // A revoked Proxy throws on the internal [[IsArray]] probe, so the check
  // sits inside try/catch like every other probe on untrusted input.
  try {
    if (Array.isArray(value)) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/** One own data-property string, or null when absent, accessor-backed, or not a string. */
function ownString(target: object, key: string): string | null {
  const read = readOwn(target, key);
  if (read.kind !== 'value' || typeof read.value !== 'string') {
    return null;
  }
  return read.value;
}

/** A usable identifier: non-empty and not a prototype-polluting key. */
function cleanIdentifier(value: string): string | null {
  return value.length > 0 && !PROTOTYPE_POLLUTING_KEYS.has(value) ? value : null;
}

/**
 * The items of an own-data array: dense, bounded, accessor-free. Sparse
 * arrays (holes), accessor-backed indices, array-like objects, and any array
 * whose own `length` exceeds `cap` are refused — the length is read from its
 * own property descriptor and checked before any index is touched, so an
 * enormous `length` never drives a traversal. No getter and no Proxy `get`
 * trap is ever invoked.
 */
function ownArrayItems(value: unknown, cap: number): unknown[] | null {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return null;
  }
  if (!isArray) {
    return null;
  }
  const arr = value as unknown[];
  try {
    const lengthRead = readOwn(arr, 'length');
    if (lengthRead.kind !== 'value' || typeof lengthRead.value !== 'number') {
      return null;
    }
    const length = lengthRead.value;
    if (!Number.isSafeInteger(length) || length > cap) {
      return null;
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(arr, index);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

/** A seat parsed down to its own data properties, or null when malformed. */
interface ParsedSeat {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly roles: string[];
}

function parseSeat(value: unknown): ParsedSeat | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = ownString(value, 'id');
  const tool = ownString(value, 'tool');
  const model = ownString(value, 'model');
  if (id === null || tool === null || model === null) {
    return null;
  }
  const cleanId = cleanIdentifier(id);
  if (cleanId === null) {
    return null;
  }
  const readOptionalString = (key: string): string | undefined | null => {
    const read = readOwn(value, key);
    if (read.kind === 'absent') {
      return undefined;
    }
    return read.kind === 'value' && typeof read.value === 'string' ? read.value : null;
  };
  const variant = readOptionalString('variant');
  if (variant === null) {
    return null;
  }
  const agent = readOptionalString('agent');
  if (agent === null) {
    return null;
  }
  const rolesRead = readOwn(value, 'roles');
  if (rolesRead.kind !== 'value') {
    return null;
  }
  const roles = ownArrayItems(rolesRead.value, MAX_SEAT_ROLES);
  if (roles === null) {
    return null;
  }
  const roleStrings: string[] = [];
  for (const role of roles) {
    if (typeof role !== 'string') {
      return null;
    }
    roleStrings.push(role);
  }
  return {
    id: cleanId,
    tool,
    model,
    ...(variant !== undefined ? { variant } : {}),
    ...(agent !== undefined ? { agent } : {}),
    roles: roleStrings,
  };
}

/** The whole seat list, or null when it is not a dense bounded array of valid seats. */
function parseSeats(seats: unknown): ParsedSeat[] | null {
  const items = ownArrayItems(seats, MAX_REVIEW_SEATS);
  if (items === null) {
    return null;
  }
  const parsed: ParsedSeat[] = [];
  for (const item of items) {
    const seat = parseSeat(item);
    if (seat === null) {
      return null;
    }
    parsed.push(seat);
  }
  return parsed;
}

/** One chain step's seatId, or null when the step is malformed. */
function chainStepSeatId(step: unknown): string | null {
  if (!isPlainObject(step)) {
    return null;
  }
  const seatId = ownString(step, 'seatId');
  if (seatId === null) {
    return null;
  }
  return cleanIdentifier(seatId);
}

/**
 * The reviewer-chain seat ids, in order, duplicates dropped. Any malformed
 * chain (non-plain object, accessor-backed chain entry, non-array or
 * over-cap chain, sparse chain, malformed step) yields [].
 */
function parseReviewerChains(chains: unknown): string[] {
  if (chains === undefined) {
    return [];
  }
  if (!isPlainObject(chains)) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const key of ['reviewer', 'high-risk-reviewer'] as const) {
    const read = readOwn(chains, key);
    if (read.kind === 'absent') {
      continue;
    }
    if (read.kind !== 'value') {
      return [];
    }
    const steps = ownArrayItems(read.value, MAX_REVIEW_CHAIN_STEPS);
    if (steps === null) {
      return [];
    }
    for (const step of steps) {
      const seatId = chainStepSeatId(step);
      if (seatId === null) {
        return [];
      }
      if (!seen.has(seatId)) {
        seen.add(seatId);
        ids.push(seatId);
      }
    }
  }
  return ids;
}

/**
 * The reviewer-chain seat ids, in order, duplicates dropped.
 *
 * Cost: linear in the capped chain input (`MAX_REVIEW_CHAIN_STEPS`); an
 * over-cap length is refused before any traversal. Never throws: any
 * malformed `unknown` input — null, a primitive, a sparse or over-cap array,
 * an array-like object, a getter or Proxy `get` trap (which is never
 * invoked), a prototype-polluting seat id — yields [].
 */
export function reviewerChainSeatIds(chains?: unknown): string[] {
  if (chains === undefined) {
    return [];
  }
  return parseReviewerChains(chains);
}

/**
 * Whether any reviewer chain names a configured seat.
 *
 * Cost: linear in the capped inputs (`MAX_REVIEW_SEATS` seats plus
 * `MAX_REVIEW_CHAIN_STEPS` steps). Never throws: any malformed `unknown`
 * input yields false. No getter and no Proxy `get` trap is ever invoked: an
 * accessor-backed field is reported by `readOwn` and refused.
 */
export function hasReviewerSeat(seats?: unknown, chains?: unknown): boolean {
  if (seats === undefined) {
    return false;
  }
  const parsedSeats = parseSeats(seats);
  if (parsedSeats === null) {
    return false;
  }
  const seatIds = new Set(parsedSeats.map((seat) => seat.id));
  for (const id of parseReviewerChains(chains)) {
    if (seatIds.has(id)) {
      return true;
    }
  }
  return false;
}

/**
 * The one reviewer seat serving the requested model, or a typed refusal.
 *
 * Cost: linear in the capped inputs (`MAX_REVIEW_SEATS` seats, each with at
 * most `MAX_SEAT_ROLES` roles, plus `MAX_REVIEW_CHAIN_STEPS` chain steps; the
 * model is at most `MAX_REVIEWER_MODEL_BYTES` bytes). Never throws: any
 * malformed `unknown` input is a refusal, never a crash.
 */
export function selectReviewerSeat(
  seats: unknown,
  chains: unknown,
  reviewerModel: unknown,
): { ok: true; seat: ReviewTransportSeat } | { ok: false; reason: string; code: ReviewUnavailableCode } {
  if (typeof reviewerModel !== 'string') {
    return { ok: false, reason: 'Reviewer model must be a string', code: 'seat-none' };
  }
  // Every code unit costs at least one UTF-8 byte, so a string longer than the
  // cap cannot fit under it: refuse before `trim` or any encoding scan touches
  // an arbitrarily large string (bounded-input cost requirement).
  if (reviewerModel.length > MAX_REVIEWER_MODEL_BYTES) {
    return { ok: false, reason: 'Reviewer model must be a non-empty string within the length cap', code: 'seat-none' };
  }
  const model = reviewerModel.trim();
  if (model.length === 0 || new TextEncoder().encode(model).length > MAX_REVIEWER_MODEL_BYTES) {
    return { ok: false, reason: 'Reviewer model must be a non-empty string within the length cap', code: 'seat-none' };
  }
  const parsedSeats = parseSeats(seats);
  if (parsedSeats === null) {
    return { ok: false, reason: 'Reviewer seats must be a bounded array of seat objects', code: 'seat-none' };
  }
  const candidates: ParsedSeat[] = [];
  for (const id of parseReviewerChains(chains)) {
    const seat = parsedSeats.find((candidate) => candidate.id === id);
    if (seat !== undefined && seat.model === model) {
      candidates.push(seat);
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: `No reviewer seat in the installation serves model '${model}'`, code: 'seat-none' };
  }

  if (candidates.length > 1) {
    const ids = candidates.map((seat) => seat.id).join(', ');
    return {
      ok: false,
      reason: `Reviewer model '${model}' matches several reviewer seats (${ids}); refused as ambiguous`,
      code: 'seat-ambiguous',
    };
  }

  const seat = candidates[0];
  if (seat.roles.includes('implementer')) {
    return { ok: false, reason: `Reviewer seat '${seat.id}' also holds the implementer role`, code: 'seat-implementer' };
  }

  // A normalized copy of the seat's own data properties: the input object is
  // never echoed back, so an input shaped like a seat can never impersonate
  // the answer by identity.
  const normalized: ReviewTransportSeat = {
    id: seat.id,
    tool: seat.tool,
    model: seat.model,
    ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
    ...(seat.agent !== undefined ? { agent: seat.agent } : {}),
    roles: [...seat.roles],
  };
  return { ok: true, seat: normalized };
}

export interface ReviewTransportRouterOptions {
  readonly seats: readonly ReviewTransportSeat[];
  readonly chains?: ReviewTransportChains;
  /** Resolve the attempt's location; throws with a reason when it cannot. */
  readonly locate: (attemptId: string) => Promise<ReviewLocation>;
  /** Path of the ocm-run binary the opencode transport runs. */
  readonly ocmRunBin: string;
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly ocmSpawn?: OcmReviewTransportSpawn;
  readonly makeNonce?: () => string;
  readonly cliSpawn?: CliReviewSpawn;
  readonly makeScratchDir?: () => Promise<string>;
  /**
   * The `api` transport's endpoint: the host-side key proxy's base URL, which
   * adds the provider key on egress so no credential reaches this process.
   * Absent means the installation has no api reviewer configured, and an `api`
   * seat is then refused rather than attempted.
   */
  readonly apiBaseURL?: string;
  /**
   * How the endpoint behind the proxy constrains the answer, declared by the
   * operator per installation. The router does NOT infer it: an `api` seat
   * without it is refused, because a json-mode endpoint would otherwise look
   * schema-enforcing (ADR-0001, requirement 6).
   */
  readonly apiSchemaEnforcement?: ApiSchemaEnforcement;
  /**
   * Which api configuration variable was not accepted, from
   * `resolveApiReviewSettings`, as a typed code. It travels into the refusal so
   * an operator typo surfaces as a typo instead of looking like "not
   * configured". A code, not text, because the api composition root may pass
   * this one refusal through to a public caller.
   */
  readonly apiConfigProblemCode?: ApiReviewConfigProblemCode;
  /**
   * Test seam only. Absent binds the provider library through
   * `createSdkApiReviewGenerate`, which is what `runApi` now does: an earlier
   * version of this comment claimed that and the code did not do it, so an
   * `api` seat refused with `transport-missing` instead of calling anything.
   */
  readonly apiGenerate?: ApiReviewGenerate;
}

export const DEFAULT_REVIEW_AGENT = 'reviewer';

export function createReviewTransportRouter(
  options: ReviewTransportRouterOptions,
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  return async (request: RunIndependentReviewRequest): Promise<IndependentReviewTransportResult> => {
    const selected = selectReviewerSeat(options.seats, options.chains, request.reviewerModel);
    if (!selected.ok) {
      throw new ReviewTransportError(selected.reason, selected.code);
    }

    const seat = selected.seat;
    const location = await options.locate(request.attemptId);

    if (Object.hasOwn(CLI_REVIEW_ARGV_TEMPLATES, seat.tool)) {
      if (seat.variant !== undefined) {
        throw new ReviewTransportError(
          `Reviewer seat '${seat.id}' sets a variant, which the ${seat.tool} review transport does not support`,
          'seat-variant-unsupported',
        );
      }
      return runCli(options, seat, location, request);
    }

    switch (seat.tool) {
      case 'opencode':
        return runOpencode(options, seat, location, request);
      case 'api':
        return runApi(options, seat, location, request);
      default:
        throw new ReviewTransportError(
          `Reviewer seat '${seat.id}' uses tool '${seat.tool}', which has no review transport`,
          'seat-tool-no-transport',
        );
    }
  };
}

/**
 * The api transport's configuration refusal, marked as such by a typed code.
 *
 * `message` is for an operator and names the seat; the CODE is what a
 * composition root that answers a public caller is allowed to use, because
 * `describeApiReviewConfigProblem` composes its text from literals alone. A
 * reader must therefore never pass `message` on.
 */
export class ApiReviewConfigProblemError extends ReviewTransportError {
  readonly configProblemCode: ApiReviewConfigProblemCode;

  constructor(code: ApiReviewConfigProblemCode, seatId: string) {
    super(
      `Reviewer seat '${seatId}' uses the api transport and its configuration was refused: ${describeApiReviewConfigProblem(code)}`,
      'transport-missing',
    );
    this.name = 'ApiReviewConfigProblemError';
    this.configProblemCode = code;
  }
}

/**
 * One own DATA property. An absent, inherited or accessor-backed field, or a
 * descriptor read that throws, is reported rather than read: a thrown value
 * must never be able to run code here or to decide a code through a getter.
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
 * The api configuration problem code of a thrown value, or `undefined` for
 * every other failure. Structural and membership-checked rather than
 * `instanceof`: a duplicated module instance would defeat `instanceof`, and
 * only a member of the closed set may select a pass-through text.
 * An own data property is read; an accessor-backed property yields `undefined`;
 * a throwing trap yields `undefined`; the function never throws.
 */
export function apiReviewConfigProblemCodeOf(error: unknown): ApiReviewConfigProblemCode | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const read = readOwn(error, 'configProblemCode');
  if (read.kind !== 'value') {
    return undefined;
  }
  return isApiReviewConfigProblemCode(read.value) ? read.value : undefined;
}

/**
 * The `api` transport: one single-turn, read-only, schema-checked call to the
 * key proxy. A variant is meaningless for it (there is no agent and no server
 * profile to select), so a seat that sets one is refused rather than silently
 * ignored.
 */
function runApi(
  options: ReviewTransportRouterOptions,
  seat: ReviewTransportSeat,
  location: ReviewLocation,
  request: RunIndependentReviewRequest,
): Promise<IndependentReviewTransportResult> {
  if (seat.variant !== undefined) {
    throw new ReviewTransportError(
      `Reviewer seat '${seat.id}' sets a variant, which the api review transport does not support`,
      'seat-variant-unsupported',
    );
  }
  if (options.apiConfigProblemCode !== undefined) {
    // A set-but-rejected variable is an operator error, not an absent one.
    throw new ApiReviewConfigProblemError(options.apiConfigProblemCode, seat.id);
  }
  if (options.apiBaseURL === undefined || options.apiBaseURL.trim() === '') {
    throw new ReviewTransportError(
      `Reviewer seat '${seat.id}' uses the api transport, which has no endpoint configured`,
      'transport-missing',
    );
  }
  if (options.apiSchemaEnforcement === undefined) {
    throw new ReviewTransportError(
      `Reviewer seat '${seat.id}' uses the api transport with no declared schema enforcement`,
      'transport-missing',
    );
  }

  const generate =
    options.apiGenerate ??
    createSdkApiReviewGenerate({
      baseURL: options.apiBaseURL,
      model: seat.model,
      schemaEnforcement: options.apiSchemaEnforcement,
    });

  const transport = createApiReviewTransport({
    baseURL: options.apiBaseURL,
    model: seat.model,
    schemaEnforcement: options.apiSchemaEnforcement,
    location,
    generate,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.makeNonce !== undefined ? { makeNonce: options.makeNonce } : {}),
  });
  return transport(request);
}

function runCli(
  options: ReviewTransportRouterOptions,
  seat: ReviewTransportSeat,
  location: ReviewLocation,
  request: RunIndependentReviewRequest,
): Promise<IndependentReviewTransportResult> {
  const transport = createCliReviewTransport({
    argvTemplate: CLI_REVIEW_ARGV_TEMPLATES[seat.tool],
    model: seat.model,
    location,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.makeNonce !== undefined ? { makeNonce: options.makeNonce } : {}),
    ...(options.cliSpawn !== undefined ? { spawn: options.cliSpawn } : {}),
    ...(options.makeScratchDir !== undefined ? { makeScratchDir: options.makeScratchDir } : {}),
  });
  return transport(request);
}

function runOpencode(
  options: ReviewTransportRouterOptions,
  seat: ReviewTransportSeat,
  location: ReviewLocation,
  request: RunIndependentReviewRequest,
): Promise<IndependentReviewTransportResult> {
  const route = location.route;
  if (route.kind === 'none') {
    // The opencode transport owns the `none` route refusal (KF-14a): it throws
    // ReviewTransportError with the route's code before any spawn.
    const transport = createOcmReviewTransport({
      ocmRunBin: options.ocmRunBin,
      remotePort: 0,
      route,
      agent: seat.agent ?? DEFAULT_REVIEW_AGENT,
      model: seat.model,
      resolveReviewDir: () => location.worktreePath,
      readHead: () => location.readHead(),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.ocmSpawn !== undefined ? { spawn: options.ocmSpawn } : {}),
      ...(options.makeNonce !== undefined ? { makeNonce: options.makeNonce } : {}),
    });
    return transport(request);
  }

  let remotePort: number;
  if (route.kind === 'legacy') {
    if (typeof route.remotePort !== 'number') {
      throw new ReviewTransportError(
        `No runner port is configured for the review of attempt ${request.attemptId}`,
        'transport-failed',
      );
    }
    remotePort = route.remotePort;
  } else {
    remotePort = route.remotePort;
  }

  const transport = createOcmReviewTransport({
    ocmRunBin: options.ocmRunBin,
    remotePort,
    route,
    ...(route.remoteHost !== undefined ? { remoteHost: route.remoteHost } : {}),
    hostMode: route.kind,
    ...(route.kind === 'installation' && route.authFile !== undefined
      ? { authFile: route.authFile }
      : {}),
    agent: seat.agent ?? DEFAULT_REVIEW_AGENT,
    model: seat.model,
    ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
    resolveReviewDir: () => location.worktreePath,
    readHead: () => location.readHead(),
    // F68: a kind review judges the change, so the location supplies the
    // base..head diff; an unreadable or over-cap diff refuses the review.
    baseCommit: location.baseCommit,
    readDiff: (fromSha: string, toSha: string) => location.readDiff(fromSha, toSha),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.ocmSpawn !== undefined ? { spawn: options.ocmSpawn } : {}),
    ...(options.makeNonce !== undefined ? { makeNonce: options.makeNonce } : {}),
  });

  return transport(request);
}
