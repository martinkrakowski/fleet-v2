import type { ShadowShellHeadMove, ShadowShellMerge } from './shadow-day-conformance.js';
import { readShellEvent } from './shadow-day-merge-set.js';
import { SHELL_EVENTS_MAX_LINES } from './shell-train-events.js';
import type { ShellTrainEvent } from './shell-train-events.js';

/** The event-list cap for this extractor; a longer list is refused before any element is read. */
export const SHADOW_SHELL_FACTS_MAX_EVENTS = SHELL_EVENTS_MAX_LINES;

/** Anomalies this extractor reports about the shell's events log. */
export const SHADOW_SHELL_ANOMALY_CODES = ['unpaired-update', 'unclassified-update', 'unresolved-merge'] as const;

export type ShadowShellAnomalyCode = (typeof SHADOW_SHELL_ANOMALY_CODES)[number];

/** One premerge carry decision paired from the shell's intent/result update records. */
export interface ShadowShellCarryDecision {
  readonly pullRequest: number;
  readonly oldHeadOid: string;
  readonly newHeadOid: string;
  readonly atIso: string;
  readonly shellCarry: 'carried' | 'not-carried';
}

/** One anomaly with no detail text: only when it happened and why. */
export interface ShadowShellAnomaly {
  readonly atIso: string;
  readonly code: ShadowShellAnomalyCode;
}

/** Facts the shell train's events log carries, read for S6' and S5'. */
export interface ShadowShellFacts {
  readonly merges: readonly ShadowShellMerge[];
  readonly headMoves: readonly ShadowShellHeadMove[];
  readonly headMovesIncompleteFor: readonly number[];
  readonly carryDecisions: readonly ShadowShellCarryDecision[];
  readonly anomalies: readonly ShadowShellAnomaly[];
}

export type ShadowShellFactsExtraction =
  | { readonly ok: false; readonly reason: 'invalid-input' }
  | { readonly ok: true; readonly facts: ShadowShellFacts };

/**
 * Extract shell merges, head moves and premerge carry decisions from the
 * shell train's parsed events log. Cost: linear in the capped input —
 * O(SHADOW_SHELL_FACTS_MAX_EVENTS) element reads at worst, each element
 * validated by `readShellEvent`; the list cap is checked from the length
 * descriptor before any element is read. Sorting `headMovesIncompleteFor`
 * costs O(k log k) in the number of distinct incomplete pull requests, k
 * bounded by the event cap. Never throws; every refusal is the typed
 * `invalid-input` result. Reads only own data-property descriptors, so no
 * getter on the list root or on any element ever runs.
 */
export function extractShadowShellFacts(events: unknown): ShadowShellFactsExtraction {
  try {
    const read = readEventList(events);
    if (read === null) {
      return { ok: false, reason: 'invalid-input' };
    }
    return { ok: true, facts: extractFacts(read) };
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
}

/**
 * Validate the list as a real, dense array of `Array.prototype`, capped by
 * `SHADOW_SHELL_FACTS_MAX_EVENTS` from its own length descriptor with its own
 * key count confirmed, then every element via `readShellEvent`, with `line`
 * strictly ascending. Returns null on any refusal.
 */
function readEventList(events: unknown): readonly ShellTrainEvent[] | null {
  if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(events, 'length');
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > SHADOW_SHELL_FACTS_MAX_EVENTS
  ) {
    return null;
  }
  if (Reflect.ownKeys(events).length !== length + 1) {
    return null;
  }
  const out: ShellTrainEvent[] = [];
  let previousLine = -1;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    const event = readShellEvent(descriptor.value);
    if (event === null || event.line <= previousLine) {
      return null;
    }
    previousLine = event.line;
    out.push(event);
  }
  return out;
}

/** Pair the validated events into facts, in list order. */
function extractFacts(events: readonly ShellTrainEvent[]): ShadowShellFacts {
  const incomplete = new Set<number>();
  const merges: ShadowShellMerge[] = [];
  const headMoves: ShadowShellHeadMove[] = [];
  const carryDecisions: ShadowShellCarryDecision[] = [];
  const anomalies: ShadowShellAnomaly[] = [];
  const pendingUpdates = new Map<number, string>();
  for (const event of events) {
    if (event.kind === 'result' && event.pullRequest !== null && event.outcome !== 'updated') {
      pendingUpdates.delete(event.pullRequest);
    }
    if (event.kind === 'result' && event.outcome === 'merged') {
      readMergedEvent(event, merges, anomalies);
    } else if (event.kind === 'head-moved') {
      readHeadMovedEvent(event, headMoves, incomplete);
    } else if (event.kind === 'intent' && event.outcome === 'update-branch') {
      readUpdateIntentEvent(event, pendingUpdates);
    } else if (event.kind === 'result' && event.outcome === 'updated') {
      readUpdatedEvent(event, headMoves, carryDecisions, anomalies, incomplete, pendingUpdates);
    }
  }
  return {
    merges,
    headMoves,
    headMovesIncompleteFor: [...incomplete].sort((a, b) => a - b),
    carryDecisions,
    anomalies,
  };
}

/** A `result`/`merged` event: a merge when identified, an anomaly otherwise. */
function readMergedEvent(
  event: ShellTrainEvent,
  merges: ShadowShellMerge[],
  anomalies: ShadowShellAnomaly[],
): void {
  if (event.pullRequest !== null && event.headOid !== null) {
    merges.push({ pullRequest: event.pullRequest, headOid: event.headOid, atIso: event.atIso });
  } else {
    anomalies.push({ atIso: event.atIso, code: 'unresolved-merge' });
  }
}

/** A `head-moved` event: a pushed move when complete, an incomplete record otherwise. */
function readHeadMovedEvent(
  event: ShellTrainEvent,
  headMoves: ShadowShellHeadMove[],
  incomplete: Set<number>,
): void {
  if (
    event.detailCode === 'head-moved-from' &&
    event.pullRequest !== null &&
    event.fromHeadOid !== null &&
    event.headOid !== null
  ) {
    headMoves.push({
      pullRequest: event.pullRequest,
      fromHeadOid: event.fromHeadOid,
      toHeadOid: event.headOid,
      atIso: event.atIso,
    });
  } else if (event.pullRequest !== null) {
    incomplete.add(event.pullRequest);
  }
}

/** An `intent`/`update-branch` event: the newest intent per pull request is kept. */
function readUpdateIntentEvent(event: ShellTrainEvent, pendingUpdates: Map<number, string>): void {
  if (event.pullRequest !== null && event.headOid !== null) {
    pendingUpdates.set(event.pullRequest, event.headOid);
  }
}

/** A `result`/`updated` event: pairs with its pending intent or is unpaired. */
function readUpdatedEvent(
  event: ShellTrainEvent,
  headMoves: ShadowShellHeadMove[],
  carryDecisions: ShadowShellCarryDecision[],
  anomalies: ShadowShellAnomaly[],
  incomplete: Set<number>,
  pendingUpdates: Map<number, string>,
): void {
  if (event.pullRequest === null) {
    anomalies.push({ atIso: event.atIso, code: 'unpaired-update' });
    return;
  }
  const pendingHeadOid = pendingUpdates.get(event.pullRequest);
  pendingUpdates.delete(event.pullRequest);
  if (pendingHeadOid === undefined || event.headOid === null) {
    anomalies.push({ atIso: event.atIso, code: 'unpaired-update' });
    incomplete.add(event.pullRequest);
    return;
  }
  headMoves.push({
    pullRequest: event.pullRequest,
    fromHeadOid: pendingHeadOid,
    toHeadOid: event.headOid,
    atIso: event.atIso,
  });
  if (event.detailCode === 'premerge-carried' || event.detailCode === 'premerge-not-carried') {
    carryDecisions.push({
      pullRequest: event.pullRequest,
      oldHeadOid: pendingHeadOid,
      newHeadOid: event.headOid,
      atIso: event.atIso,
      shellCarry: event.detailCode === 'premerge-carried' ? 'carried' : 'not-carried',
    });
  } else if (event.detailCode !== 'premerge-reposted') {
    anomalies.push({ atIso: event.atIso, code: 'unclassified-update' });
  }
}
