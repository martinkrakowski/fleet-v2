/**
 * Pure merge-train announcement rule (CO-WD6). Given the attention targets the
 * watchdog is about to raise in this pass, the open attention items as they
 * were BEFORE this pass, and the current time, it answers the at most three
 * fixed sentences to speak aloud now. Every one of the seven train-health
 * attention codes has a sentence; none is silent. A refusal is never silence:
 * it carries one fixed fallback sentence.
 *
 * Pure domain module: no port, no use case, no adapter, no speech, no switch
 * that turns the alert on or off, no I/O, no clock read (`nowIso` is an
 * input), no randomness, never an exception.
 *
 * Cost bound: at most `TRAIN_HEALTH_ANNOUNCEMENT_TARGETS_MAX` (202) targets
 * and `TRAIN_HEALTH_OPEN_ITEMS_MAX` (1000) open items, each read once; one
 * `Map` is built from the open items so matching is one lookup per target;
 * one sort runs over at most 202 due targets.
 */

import { readPlainRecord } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  TRAIN_HEALTH_FINDINGS_MAX,
  TRAIN_HEALTH_RULES,
} from './train-health-rules.js';

/**
 * The seven attention codes CO-WD2 raises: the five CO-WD1 rules plus the two
 * watchdog-overrun codes. Declared here because domain code must not import
 * from the application layer.
 */
export const TRAIN_HEALTH_ANNOUNCEMENT_CODES = [
  ...TRAIN_HEALTH_RULES,
  'findings-truncated',
  'queue-too-large',
] as const;
export type TrainHealthAnnouncementCode = (typeof TRAIN_HEALTH_ANNOUNCEMENT_CODES)[number];

/** Most severe first: the three codes that mean "the watchdog cannot see everything" come before any single finding. */
export const TRAIN_HEALTH_ANNOUNCEMENT_PRIORITY: readonly TrainHealthAnnouncementCode[] = Object.freeze([
  'watchdog-blind',
  'findings-truncated',
  'queue-too-large',
  'tick-stale',
  'stalled-head',
  'stale-queue-entry',
  'repeated-park',
]);

/** Default cooldown between two speakings of the same condition. */
export const DEFAULT_TRAIN_HEALTH_RESPEAK_MINUTES = 10;
/** At most this many sentences are spoken in one pass. */
export const TRAIN_HEALTH_ANNOUNCE_MAX = 3;
/** At most this many targets are read from one input. */
export const TRAIN_HEALTH_ANNOUNCEMENT_TARGETS_MAX = TRAIN_HEALTH_FINDINGS_MAX + 2;
/** At most this many open items are read from one input. */
export const TRAIN_HEALTH_OPEN_ITEMS_MAX = 1000;
/** Every sentence is at most this many characters. */
export const TRAIN_HEALTH_SENTENCE_MAX_LENGTH = 120;
/** The one sentence every refusal carries: a refusal is never silence. */
export const TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE =
  'The merge train watchdog cannot decide what to announce.';

/**
 * One attention target the watchdog is about to raise. A train-wide code
 * carries NO `pullRequest` key (never `null`); the caller maps a `null` pull
 * request to an absent key.
 */
export interface TrainHealthAnnouncementTarget {
  readonly rule: TrainHealthAnnouncementCode;
  readonly pullRequest?: number;
}

/** One open attention item as it stood before this pass. */
export interface TrainHealthAnnouncementOpenItem {
  readonly rule: string;
  readonly pullRequest?: number;
  readonly lastRaisedAtIso?: string;
}

export interface TrainHealthAnnouncementInput {
  readonly targets: readonly TrainHealthAnnouncementTarget[];
  readonly openItemsKnown: boolean;
  readonly openItems: readonly TrainHealthAnnouncementOpenItem[];
  readonly nowIso: string;
  readonly respeakMinutes?: number;
}

export type TrainHealthAnnouncementDecision =
  | {
      readonly outcome: 'decided';
      readonly sentences: readonly string[];
      readonly due: number;
      readonly suppressed: number;
    }
  | {
      readonly outcome: 'refused';
      readonly reasonCode: 'invalid-clock' | 'invalid-input';
      readonly sentences: readonly string[];
    };

/** The runtime schema of one target. */
const TARGET_SCHEMA = {
  rule: { kind: 'literal', values: TRAIN_HEALTH_ANNOUNCEMENT_CODES },
  pullRequest: { kind: 'integer', min: 1, max: 2147483647, optional: true },
} as const;

/** The runtime schema of one open item. */
const OPEN_ITEM_SCHEMA = {
  rule: { kind: 'string', maxLength: 40 },
  pullRequest: { kind: 'integer', min: 1, optional: true },
  lastRaisedAtIso: { kind: 'string', maxLength: 40, optional: true },
} as const;

/** The runtime schema of the whole input (depth 2, within MAX_DEPTH). */
const INPUT_SCHEMA = {
  targets: {
    kind: 'array',
    maxLength: TRAIN_HEALTH_ANNOUNCEMENT_TARGETS_MAX,
    items: { kind: 'record', schema: TARGET_SCHEMA },
  },
  openItemsKnown: { kind: 'boolean' },
  openItems: {
    kind: 'array',
    maxLength: TRAIN_HEALTH_OPEN_ITEMS_MAX,
    items: { kind: 'record', schema: OPEN_ITEM_SCHEMA },
  },
  nowIso: { kind: 'string', maxLength: 40 },
  respeakMinutes: { kind: 'integer', min: 1, max: 1440, optional: true },
} as const;

/** The five train-wide sentences, keyed by code, so a code without a sentence is a compile error. */
const TRAIN_WIDE_SENTENCES: Readonly<
  Record<Exclude<TrainHealthAnnouncementCode, 'stale-queue-entry' | 'repeated-park'>, string>
> = Object.freeze({
  'tick-stale': 'The merge train has stopped ticking.',
  'stalled-head': 'The head of the merge train is stalled.',
  'watchdog-blind': 'The merge train watchdog cannot read the train state.',
  'findings-truncated': 'The merge train has more problems than the watchdog can list.',
  'queue-too-large': 'The merge train queue is too long to check completely.',
});

/** The two codes whose sentence names one pull request. */
const PER_ENTRY_RULES: readonly TrainHealthAnnouncementCode[] = ['stale-queue-entry', 'repeated-park'];

const REFUSED_INPUT: TrainHealthAnnouncementDecision = Object.freeze({
  outcome: 'refused',
  reasonCode: 'invalid-input',
  sentences: Object.freeze([TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE]),
});

const REFUSED_CLOCK: TrainHealthAnnouncementDecision = Object.freeze({
  outcome: 'refused',
  reasonCode: 'invalid-clock',
  sentences: Object.freeze([TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE]),
});

/** The sentence for one code; built only from fixed text plus a validated integer. */
function sentenceFor(rule: TrainHealthAnnouncementCode, pullRequest: number | undefined): string {
  if (rule === 'stale-queue-entry') {
    return `Pull request ${String(pullRequest)} is closed or merged but still on the merge train.`;
  }
  if (rule === 'repeated-park') {
    return `Pull request ${String(pullRequest)} keeps being parked on the merge train.`;
  }
  return TRAIN_WIDE_SENTENCES[rule];
}

/** The identity of a target or an open item. */
function identityOf(rule: string, pullRequest: number | undefined): string {
  return `${rule}#${pullRequest ?? 0}`;
}

interface ParsedInput {
  readonly targets: readonly TrainHealthAnnouncementTarget[];
  readonly openItemsKnown: boolean;
  readonly openItems: readonly TrainHealthAnnouncementOpenItem[];
  readonly nowIso: string;
  readonly respeakMinutes: number | undefined;
}

/** One `readPlainRecord` call; `null` means the `invalid-input` refusal. */
function readInput(input: unknown): ParsedInput | null {
  const read = readPlainRecord(input, INPUT_SCHEMA);
  if (!read.ok) {
    return null;
  }
  const value = read.value as unknown as {
    targets: TrainHealthAnnouncementTarget[];
    openItemsKnown: boolean;
    openItems: TrainHealthAnnouncementOpenItem[];
    nowIso: string;
    respeakMinutes?: number;
  };
  return {
    targets: value.targets,
    openItemsKnown: value.openItemsKnown,
    openItems: value.openItems,
    nowIso: value.nowIso,
    respeakMinutes: value.respeakMinutes,
  };
}

/**
 * A per-entry rule must carry a pull request and a train-wide rule must carry
 * none. Open items are NOT checked this way: an open item that matches no
 * target simply silences nothing.
 */
function targetsAreConsistent(targets: readonly TrainHealthAnnouncementTarget[]): boolean {
  return targets.every((target) => {
    const perEntry = PER_ENTRY_RULES.includes(target.rule);
    return perEntry ? target.pullRequest !== undefined : target.pullRequest === undefined;
  });
}

/**
 * One `Map` from identity to the latest raised instant, or `null` for "time
 * unknown". An item of an unknown rule is skipped. An absent, unparseable or
 * future `lastRaisedAtIso` sets `null`, and `null` is never overwritten by
 * another item of the same identity.
 */
function latestRaisedByIdentity(
  openItems: readonly TrainHealthAnnouncementOpenItem[],
  nowMs: number,
): Map<string, number | null> {
  const raised = new Map<string, number | null>();
  for (const item of openItems) {
    if (!(TRAIN_HEALTH_ANNOUNCEMENT_CODES as readonly string[]).includes(item.rule)) {
      continue;
    }
    const identity = identityOf(item.rule, item.pullRequest);
    const raw = item.lastRaisedAtIso;
    if (raw === undefined || !isZonedIsoDateTime(raw)) {
      raised.set(identity, null);
      continue;
    }
    const parsed = Date.parse(raw);
    if (parsed > nowMs) {
      raised.set(identity, null);
      continue;
    }
    const existing = raised.get(identity);
    if (existing === undefined) {
      raised.set(identity, parsed);
    } else if (existing !== null) {
      raised.set(identity, Math.max(existing, parsed));
    }
  }
  return raised;
}

/**
 * Whether one target may be spoken now. When the open items are unknown they
 * are not consulted at all. Otherwise the target is due when nothing was
 * raised for it, or its raised time is unknown, or the epoch bucket of now is
 * past the epoch bucket of the last raise. Buckets (not elapsed time) are
 * compared because the watchdog refreshes every open item on every pass, so
 * `lastRaisedAtIso` is always the time of the previous pass and an
 * elapsed-time rule would never speak twice.
 */
function isDue(
  identity: string,
  openItemsKnown: boolean,
  raised: Map<string, number | null>,
  nowMs: number,
  periodMs: number,
): boolean {
  if (!openItemsKnown) {
    return true;
  }
  const last = raised.get(identity);
  if (last === undefined || last === null) {
    return true;
  }
  return Math.floor(nowMs / periodMs) > Math.floor(last / periodMs);
}

/** One due target, carrying its priority index for the sort. */
interface DueTarget {
  readonly rule: TrainHealthAnnouncementCode;
  readonly pullRequest: number | undefined;
  readonly priorityIndex: number;
}

/** Priority first, then pull request ascending (absent counts as 0). */
function compareTargets(a: DueTarget, b: DueTarget): number {
  if (a.priorityIndex !== b.priorityIndex) {
    return a.priorityIndex - b.priorityIndex;
  }
  return (a.pullRequest ?? 0) - (b.pullRequest ?? 0);
}

/** The sentences and suppressed count for the sorted due targets. */
function sentencesForDue(due: readonly DueTarget[]): { sentences: string[]; suppressed: number } {
  if (due.length <= TRAIN_HEALTH_ANNOUNCE_MAX) {
    return { sentences: due.map((target) => sentenceFor(target.rule, target.pullRequest)), suppressed: 0 };
  }
  const kept = due.length - (TRAIN_HEALTH_ANNOUNCE_MAX - 1);
  const sentences = due
    .slice(0, TRAIN_HEALTH_ANNOUNCE_MAX - 1)
    .map((target) => sentenceFor(target.rule, target.pullRequest));
  sentences.push(`${String(kept)} more merge train problems are not announced.`);
  return { sentences, suppressed: kept };
}

/** The inner body of `decideTrainHealthAnnouncements`; its caller owns the try/catch. */
function decideInner(input: unknown): TrainHealthAnnouncementDecision {
  const parsed = readInput(input);
  if (parsed === null) {
    return REFUSED_INPUT;
  }
  if (!isZonedIsoDateTime(parsed.nowIso)) {
    return REFUSED_CLOCK;
  }
  if (!targetsAreConsistent(parsed.targets)) {
    return REFUSED_INPUT;
  }
  const nowMs = Date.parse(parsed.nowIso);
  const periodMs = (parsed.respeakMinutes ?? DEFAULT_TRAIN_HEALTH_RESPEAK_MINUTES) * 60_000;
  const raised = latestRaisedByIdentity(parsed.openItems, nowMs);
  const seen = new Set<string>();
  const due: DueTarget[] = [];
  for (const target of parsed.targets) {
    const identity = identityOf(target.rule, target.pullRequest);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    if (isDue(identity, parsed.openItemsKnown, raised, nowMs, periodMs)) {
      due.push({
        rule: target.rule,
        pullRequest: target.pullRequest,
        priorityIndex: TRAIN_HEALTH_ANNOUNCEMENT_PRIORITY.indexOf(target.rule),
      });
    }
  }
  due.sort(compareTargets);
  const spoken = sentencesForDue(due);
  return Object.freeze({
    outcome: 'decided' as const,
    sentences: Object.freeze(spoken.sentences),
    due: due.length,
    suppressed: spoken.suppressed,
  });
}

/**
 * The one entry point: the deterministic announcement decision of one pass.
 * Never throws. A malformed or hostile input of any shape answers a typed
 * refusal carrying the fallback sentence, never silence and never an
 * exception.
 */
export function decideTrainHealthAnnouncements(input: unknown): TrainHealthAnnouncementDecision {
  try {
    return decideInner(input);
  } catch {
    return REFUSED_INPUT;
  }
}
