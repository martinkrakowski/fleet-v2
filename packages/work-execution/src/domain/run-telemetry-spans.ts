/**
 * The pure mapper of the run-telemetry traces (plan §3.1, §3.3, §3.4;
 * OT1b-1, OT1b-2): `laneRunSpans(hmac, facts)` maps a `LaneRunRecord`, its
 * keyed journal and its attempts to closed `TelemetrySpan`s only — the root
 * when the run is terminal, round spans once closed, one span per keyed step
 * (intent → final result), the stop request, one ci-wait span per closed
 * watching-ci conduct entry, the attempt and usage spans under their rounds,
 * and `attemptTraceSpans(hmac, facts)` maps a hand-run attempt's trace. Never
 * throws, never reads a clock: every time comes from a record field, every id
 * from the §3.4 identity functions. A span whose identity, ids or digest
 * cannot be built is dropped and counted in `rejectedInvalid`, never emitted
 * half-built.
 */

import { billingOf } from '@fleet/shared';
import { parseLaneRunKey, stopModeOfKey } from './lane-run-keys.js';
import { LANE_RUN_TERMINAL_STATES } from './value-objects/LaneRunState.vo.js';
import { CAPACITY_RELEASE_STATES } from './value-objects/AttemptState.vo.js';
import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import { LANE_RUN_MAX_ROUND, type LaneRunKeyStep, type LaneRunRecord } from './lane-run-records.js';
import type { AttemptRecord, AttemptUsageRecord } from './execution-records.js';
import {
  attemptIdentity,
  attemptTraceRoot,
  ciWaitIdentity,
  journalKeyIdentity,
  reviewReceiptIdentity,
  roundIdentity,
  runRootIdentity,
  runTraceRoot,
  telemetryDigest,
  telemetryHashInput,
  telemetrySpanId,
  telemetryTraceId,
  usageIdentity,
  verificationReceiptIdentity,
  type TelemetryHmac,
  type TelemetryHashInput,
  type TelemetrySpanIdentity,
  type TelemetryTraceRoot,
} from './run-telemetry-ids.js';
import { TELEMETRY_MAX_EVENTS, TelemetrySpan } from './run-telemetry.js';
import type { TelemetrySpanEvent, TelemetrySpanName, TelemetrySpanStatus } from './run-telemetry.js';
import type { TelemetrySpanKind } from './run-telemetry-attributes.js';

/** The plain input facts of the run mapper (plan §3.3): no raw id leaves it. */
export interface LaneRunTelemetryFacts {
  readonly run: LaneRunRecord;
  readonly journal: readonly LaneRunJournalEntryRecord[];
  /** The project alias, if any (policy.telemetry.projectAliases). */
  readonly project: string | null;
  readonly tags: readonly string[];
  /** The run's attempts (plan §3.1): their attempt and usage spans hang under the round of their dispatch key. */
  readonly attempts: readonly AttemptRecord[];
}

/** The mirror of the application's receipt projection (plan §3.1): the domain never imports an application port. */
export type TelemetryReceiptResult = 'pending' | 'pass' | 'fail' | 'unknown' | 'not-applicable';
export type TelemetryReviewReceiptKind = 'brief-check' | 'code-review' | 'pre-merge';

export interface TelemetryGateReceiptFact {
  readonly receiptId: TelemetryHashInput;
  readonly result: TelemetryReceiptResult;
  readonly exitCode: number | null;
  readonly completedAtIso: string;
}

export interface TelemetryReviewReceiptFact {
  readonly receiptId: TelemetryHashInput;
  readonly kind: TelemetryReviewReceiptKind;
  readonly result: TelemetryReceiptResult;
  readonly findings: { readonly blocker: number; readonly major: number; readonly minor: number; readonly nit: number };
  readonly completedAtIso: string;
}

export interface TelemetryReceiptFacts {
  readonly verification: readonly TelemetryGateReceiptFact[];
  readonly review: readonly TelemetryReviewReceiptFact[];
}

/** The plain input facts of the hand-run mapper (plan §3.1, §3.4): no raw id leaves it. */
export interface AttemptTraceTelemetryFacts {
  readonly attempt: AttemptRecord;
  readonly receipts: TelemetryReceiptFacts;
  /** Conducted attempt ids: an attempt that belongs to a run is never exported as a hand-run trace. */
  readonly conductedAttemptIds: ReadonlySet<string>;
}

/** The mapper's result: only closed spans, plus the dropped-and-counted ones. */
export interface LaneRunSpansResult {
  readonly spans: readonly TelemetrySpan[];
  readonly rejectedInvalid: number;
}

/** The span kind of each keyed step (plan §3.1). */
const STEP_SPAN_KINDS: Readonly<Record<LaneRunKeyStep, TelemetrySpanKind>> = Object.freeze({
  prepare: 'CHAIN',
  dispatch: 'CHAIN',
  stop: 'CHAIN',
  collect: 'CHAIN',
  reconcile: 'CHAIN',
  gate: 'GUARDRAIL',
  'brief-check': 'EVALUATOR',
  'code-review': 'EVALUATOR',
  'pre-merge': 'EVALUATOR',
  accept: 'DECISION',
  park: 'DECISION',
  'open-pr': 'TOOL',
  push: 'TOOL',
  merge: 'TOOL',
});

/** The steps whose span hangs under the round span; the rest hang under the root (plan §3.1). */
const ROUND_STEPS: readonly LaneRunKeyStep[] = [
  'prepare', 'dispatch', 'collect', 'reconcile', 'stop', 'gate', 'brief-check', 'code-review', 'pre-merge',
];

/** A span identity and its build input, once both are known. */
interface PendingSpan {
  readonly identity: TelemetrySpanIdentity;
  readonly name: TelemetrySpanName;
  readonly kind: TelemetrySpanKind;
  readonly startIso: string;
  readonly endIso: string;
  readonly status: TelemetrySpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly parentSpanId: string | null;
  readonly events: readonly TelemetrySpanEvent[];
}

/** One keyed journal group: its first intent, its final results, its ambiguous count. */
interface KeyGroup {
  readonly key: string;
  intent: LaneRunJournalEntryRecord | null;
  readonly results: LaneRunJournalEntryRecord[];
  ambiguous: number;
}

/** The final (non-`ambiguous`) result of a key's results: the last one, or null. */
function finalResultOf(results: readonly LaneRunJournalEntryRecord[]): LaneRunJournalEntryRecord | null {
  let final: LaneRunJournalEntryRecord | null = null;
  for (const entry of results) {
    if (entry.outcome !== 'ambiguous') {
      final = entry;
    }
  }
  return final;
}

/** A final result's status: `ok` for `completed`, `error` with its reason code otherwise (plan §3.1). */
function statusOfResult(result: LaneRunJournalEntryRecord): TelemetrySpanStatus {
  if (result.outcome === 'completed') {
    return { code: 'ok', reasonCode: null };
  }
  return { code: 'error', reasonCode: result.reasonCode };
}

/** The states in which an attempt is terminal and its spans may be emitted (plan §3.1). */
const TERMINAL_ATTEMPT_STATES: readonly string[] = CAPACITY_RELEASE_STATES;

/** The candidate attributes of an attempt span (both trace kinds); validated by `TelemetrySpan.build`. */
function attemptAttributes(hmac: TelemetryHmac, attempt: AttemptRecord, sessionDigest: string): Readonly<Record<string, unknown>> {
  const attributes: Record<string, unknown> = {
    'session.id': sessionDigest,
    'fleet.attempt.kind': attempt.kind,
    'fleet.fix_number': attempt.fixNumber,
  };
  const attemptInput = telemetryHashInput(attempt.id);
  if (attemptInput !== null) {
    const digest = telemetryDigest(hmac, 'attempt', attemptInput);
    if (digest !== null) {
      attributes['fleet.attempt.digest'] = digest;
    }
  }
  if (attempt.priorAttemptId !== null) {
    const priorInput = telemetryHashInput(attempt.priorAttemptId);
    if (priorInput !== null) {
      const digest = telemetryDigest(hmac, 'attempt', priorInput);
      if (digest !== null) {
        attributes['fleet.prior_attempt.digest'] = digest;
      }
    }
  }
  const seat = attempt.seatSelection;
  if (seat !== null && seat !== undefined) {
    attributes['agent.name'] = seat.role;
    attributes['fleet.seat.model'] = seat.model;
    if (seat.tool !== null) {
      attributes['fleet.seat.tool'] = seat.tool;
    }
  }
  attributes['fleet.seat.billing'] = billingOf(attempt.runner?.kind ?? attempt.seatSelection?.tool);
  if (attempt.outcome !== null) {
    attributes['fleet.outcome'] = attempt.outcome;
  }
  if (attempt.stopReason !== undefined && attempt.stopReason !== null) {
    attributes['fleet.stop_reason'] = attempt.stopReason;
  }
  return attributes;
}

/** The candidate attributes of an attempt's usage LLM span (plan §3.1, §3.6); validated by `TelemetrySpan.build`. */
function usageAttributes(attempt: AttemptRecord, usage: AttemptUsageRecord): Readonly<Record<string, unknown>> {
  const billing = billingOf(attempt.runner?.kind ?? attempt.seatSelection?.tool);
  const attributes: Record<string, unknown> = {
    'fleet.usage.steps': usage.steps,
    'fleet.usage.wall_seconds': usage.wallSeconds,
    'fleet.usage.source': usage.source,
    'fleet.seat.billing': billing,
  };
  if (usage.tokensInput !== null) {
    attributes['llm.token_count.prompt'] = usage.tokensInput;
  }
  if (usage.tokensOutput !== null) {
    attributes['llm.token_count.completion'] = usage.tokensOutput;
  }
  if (usage.tokensReasoning !== null) {
    attributes['llm.token_count.completion_details.reasoning'] = usage.tokensReasoning;
  }
  if (usage.tokensCacheRead !== null) {
    attributes['llm.token_count.prompt_details.cache_read'] = usage.tokensCacheRead;
  }
  if (usage.tokensCacheWrite !== null) {
    attributes['llm.token_count.prompt_details.cache_write'] = usage.tokensCacheWrite;
  }
  if (billing === 'metered') {
    if (usage.model !== null) {
      attributes['llm.model_name'] = usage.model;
    }
    if (usage.costUsd !== null) {
      attributes['llm.cost.total'] = usage.costUsd;
    }
  } else if (usage.costUsd !== null) {
    attributes['fleet.cost.estimate_usd'] = usage.costUsd;
    attributes['fleet.cost.basis'] = billing === 'plan' ? 'plan-estimate' : 'unknown';
  }
  return attributes;
}

/**
 * Map a conducted run to its closed telemetry spans (plan §3.1). Never throws;
 * a span whose identity, ids or build fails is counted in `rejectedInvalid`.
 */
export function laneRunSpans(hmac: TelemetryHmac, facts: LaneRunTelemetryFacts): LaneRunSpansResult {
  try {
    const root: TelemetryTraceRoot | null = runTraceRoot(facts.run?.runId);
    if (root === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const traceId = telemetryTraceId(hmac, root);
    if (traceId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const rootSpanId = telemetrySpanId(hmac, root, runRootIdentity());
    if (rootSpanId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderInput = telemetryHashInput(facts.run.workOrderId);
    if (workOrderInput === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderDigest = telemetryDigest(hmac, 'work-order', workOrderInput);
    if (workOrderDigest === null) {
      return { spans: [], rejectedInvalid: 1 };
    }

    // The journal scoped to this run (plan §3.1): step and stop keys whose
    // parsed runId is this run's, and this run's conduct entries with a state.
    // Request and reaper keys never belong to a run's trace; a conduct entry
    // without a state is skipped, as `laneRunJournalState` does. The root's
    // start comes from the first entry that survives this filter.
    const runId = facts.run.runId;
    const journal = facts.journal.filter((entry) => {
      if (entry.kind === 'conduct') {
        return entry.runId === runId && entry.state !== null;
      }
      if (entry.kind !== 'intent' && entry.kind !== 'result') {
        return false;
      }
      if (entry.key === null) {
        return false;
      }
      const parsed = parseLaneRunKey(entry.key);
      if (parsed === null || (parsed.kind !== 'step' && parsed.kind !== 'stop')) {
        return false;
      }
      return parsed.runId === runId;
    });

    // session.id and fleet.work_order.digest go on every span of the run's
    // work order (plan §3.1, §3.2): both are the work order's salted digest.
    const sharedAttributes: Record<string, unknown> = {
      'session.id': workOrderDigest,
      'fleet.work_order.digest': workOrderDigest,
    };

    // The keyed journal: one group per key, intents and results in journal order.
    const groups: KeyGroup[] = [];
    const byKey = new Map<string, KeyGroup>();
    for (const entry of journal) {
      if ((entry.kind !== 'intent' && entry.kind !== 'result') || entry.key === null) {
        continue;
      }
      let group = byKey.get(entry.key);
      if (group === undefined) {
        group = { key: entry.key, intent: null, results: [], ambiguous: 0 };
        byKey.set(entry.key, group);
        groups.push(group);
      }
      if (entry.kind === 'intent') {
        // A key carries one intent; a second one (which the journal refuses)
        // never replaces the first, so a prefix and the full journal agree.
        if (group.intent === null) {
          group.intent = entry;
        }
      } else if (entry.outcome === 'ambiguous') {
        group.ambiguous += 1;
      } else {
        group.results.push(entry);
      }
    }

    // The rounds an intent has started: a round span closes once any later
    // round has started or the run is terminal (plan §3.1).
    const roundsStarted = new Set<number>();
    for (const entry of journal) {
      if (entry.kind !== 'intent' || entry.key === null) {
        continue;
      }
      const parsed = parseLaneRunKey(entry.key);
      if (parsed !== null && parsed.kind === 'step') {
        roundsStarted.add(parsed.round);
      }
    }
    const maxRoundStarted = roundsStarted.size > 0 ? Math.max(...roundsStarted) : -1;
    const conduct = journal.filter((entry) => entry.kind === 'conduct');
    const lastConduct = conduct.length > 0 ? conduct[conduct.length - 1] : null;
    const terminal =
      lastConduct !== null &&
      lastConduct.state !== null &&
      (LANE_RUN_TERMINAL_STATES as readonly string[]).includes(lastConduct.state);

    // Build helper: a span whose ids, parent or build fail is dropped and
    // counted; a non-root span is never emitted without a parent span id.
    const spans: TelemetrySpan[] = [];
    const rejected = { count: 0 };
    const build = (span: PendingSpan): TelemetrySpan | null => {
      const spanId = telemetrySpanId(hmac, root, span.identity);
      if (spanId === null) {
        rejected.count += 1;
        return null;
      }
      if (span.parentSpanId === null && span.name !== 'lane-run') {
        rejected.count += 1;
        return null;
      }
      const built = TelemetrySpan.build({
        traceId,
        spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: span.kind,
        startIso: span.startIso,
        endIso: span.endIso,
        status: span.status,
        attributes: span.attributes,
        events: span.events,
      });
      if (built === null) {
        rejected.count += 1;
        return null;
      }
      spans.push(built);
      return built;
    };

    // The keyed step spans (and the stop requests), built as they are mapped;
    // a round's aggregate is updated only from steps that built.
    const pending: PendingSpan[] = [];
    const roundOf = new Map<number, { startIso: string; endIso: string; errored: TelemetrySpanStatus | null }>();
    const pendingStepRounds = new Set<number>();

    for (const group of groups) {
      const parsed = parseLaneRunKey(group.key);
      if (parsed === null || group.intent === null) {
        continue;
      }
      const hashInput = telemetryHashInput(group.key);
      if (hashInput === null) {
        rejected.count += 1;
        continue;
      }
      if (parsed.kind === 'step') {
        const underRound = (ROUND_STEPS as readonly string[]).includes(parsed.step);
        const final = finalResultOf(group.results);
        if (final === null) {
          // Only a round-parented step holds its round open: an unfinalized
          // root-parented key (accept, open-pr, push, merge, park) can never
          // withhold a completed round span.
          if (underRound) {
            pendingStepRounds.add(parsed.round);
          }
          continue;
        }
        const identity = journalKeyIdentity(hashInput);
        if (identity === null) {
          rejected.count += 1;
          continue;
        }
        const attributes: Record<string, unknown> = {
          'fleet.step': parsed.step,
          'fleet.round': parsed.round,
          ...sharedAttributes,
        };
        if (final.reasonCode !== null) {
          attributes['fleet.reason_code'] = final.reasonCode;
        }
        if (group.ambiguous > 0) {
          attributes['fleet.ambiguous_results'] = group.ambiguous;
        }
        const status = statusOfResult(final);
        const roundIdentityOf = underRound ? roundIdentity(parsed.round) : null;
        if (underRound && roundIdentityOf === null) {
          rejected.count += 1;
          continue;
        }
        const parentSpanId = underRound ? telemetrySpanId(hmac, root, roundIdentityOf!) : rootSpanId;
        const built = build({
          identity,
          name: parsed.step,
          kind: STEP_SPAN_KINDS[parsed.step],
          startIso: group.intent.recordedAtIso,
          endIso: final.recordedAtIso,
          status,
          attributes,
          parentSpanId,
          events: [],
        });
        if (built === null || !underRound) {
          continue;
        }
        const info = roundOf.get(parsed.round);
        if (info === undefined) {
          roundOf.set(parsed.round, {
            startIso: group.intent.recordedAtIso,
            endIso: final.recordedAtIso,
            errored: status.code === 'error' ? status : null,
          });
        } else {
          if (Date.parse(group.intent.recordedAtIso) < Date.parse(info.startIso)) {
            info.startIso = group.intent.recordedAtIso;
          }
          if (Date.parse(final.recordedAtIso) > Date.parse(info.endIso)) {
            info.endIso = final.recordedAtIso;
          }
          if (status.code === 'error') {
            info.errored = status;
          }
        }
      } else if (parsed.kind === 'stop') {
        const identity = journalKeyIdentity(hashInput);
        if (identity === null) {
          rejected.count += 1;
          continue;
        }
        const mode = stopModeOfKey(group.key);
        const attributes: Record<string, unknown> = { ...sharedAttributes };
        if (mode !== null) {
          attributes['fleet.stop.mode'] = mode;
        }
        // The stop request is the stop INTENT only: it never reads a stop
        // result, so a prefix (intent) and the full journal (intent + any
        // result, whatever its outcome) map to the identical span.
        pending.push({
          identity,
          name: 'stop-request',
          kind: 'DECISION',
          startIso: group.intent.recordedAtIso,
          endIso: group.intent.recordedAtIso,
          status: { code: 'unset', reasonCode: null },
          attributes,
          parentSpanId: rootSpanId,
          events: [],
        });
      }
    }

    // Root: only when the run is terminal (D2). Times and events come from the
    // record: the first surviving journal entry's start, the terminal conduct
    // entry's end.
    if (terminal && lastConduct !== null && lastConduct.state !== null && journal.length > 0) {
      const allEvents: TelemetrySpanEvent[] = [];
      for (const entry of conduct) {
        if (entry.state === null) {
          continue;
        }
        allEvents.push({ name: 'state.entered', timeIso: entry.recordedAtIso, state: entry.state });
      }
      const events =
        allEvents.length > TELEMETRY_MAX_EVENTS
          ? allEvents.slice(allEvents.length - TELEMETRY_MAX_EVENTS)
          : allEvents;
      const attributes: Record<string, unknown> = {
        'fleet.run.id': facts.run.runId,
        'fleet.tier': facts.run.tier,
        ...sharedAttributes,
      };
      if (facts.tags.length > 0) {
        attributes['tag.tags'] = facts.tags.slice();
      }
      if (facts.project !== null) {
        attributes['fleet.project'] = facts.project;
      }
      build({
        identity: runRootIdentity(),
        name: 'lane-run',
        kind: 'CHAIN',
        startIso: journal[0].recordedAtIso,
        endIso: lastConduct.recordedAtIso,
        status:
          lastConduct.state === 'merged'
            ? { code: 'ok', reasonCode: null }
            : { code: 'unset', reasonCode: 'stopped' },
        attributes,
        parentSpanId: null,
        events,
      });
    }

    // Round spans: one per round with at least one built step span, withheld
    // while any round-step intent in it still lacks a final result, emitted
    // only once any later round has started or the run is terminal.
    for (let round = 0; round <= LANE_RUN_MAX_ROUND; round += 1) {
      const info = roundOf.get(round);
      if (info === undefined) {
        continue;
      }
      if (pendingStepRounds.has(round)) {
        continue;
      }
      if (!terminal && !(roundsStarted.size > 0 && maxRoundStarted > round)) {
        continue;
      }
      const identity = roundIdentity(round);
      if (identity === null) {
        rejected.count += 1;
        continue;
      }
      build({
        identity,
        name: 'round',
        kind: 'CHAIN',
        startIso: info.startIso,
        endIso: info.endIso,
        status: info.errored ?? { code: 'ok', reasonCode: null },
        attributes: { ...sharedAttributes },
        parentSpanId: rootSpanId,
        events: [],
      });
    }

    // Attempt and usage spans (plan §3.1): an attempt's AGENT span runs from
    // its dispatch step's final result to its collect step's final result,
    // hangs under the round span of its dispatch key, and is emitted only once
    // the attempt is terminal; its usage LLM child only when opencode-db usage
    // was read. Ids come from the §3.4 table; the round span must already be
    // emitted, so a child never precedes its parent.
    for (const attempt of facts.attempts) {
      if (!(TERMINAL_ATTEMPT_STATES as readonly string[]).includes(attempt.state)) {
        continue;
      }
      const attemptInput = telemetryHashInput(attempt.id);
      if (attemptInput === null) {
        rejected.count += 1;
        continue;
      }
      const identity = attemptIdentity(attemptInput);
      if (identity === null) {
        rejected.count += 1;
        continue;
      }
      let dispatchGroup: KeyGroup | null = null;
      let round = 0;
      let seatIndex = 0;
      for (const group of groups) {
        const parsed = parseLaneRunKey(group.key);
        if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'dispatch') {
          continue;
        }
        if (group.intent !== null && group.intent.mintedId === attempt.id) {
          dispatchGroup = group;
          round = parsed.round;
          seatIndex = parsed.seatIndex;
          break;
        }
      }
      if (dispatchGroup === null) {
        continue;
      }
      const dispatchFinal = finalResultOf(dispatchGroup.results);
      if (dispatchFinal === null) {
        continue;
      }
      let collectGroup: KeyGroup | null = null;
      for (const group of groups) {
        const parsed = parseLaneRunKey(group.key);
        if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'collect') {
          continue;
        }
        if (parsed.round === round && parsed.seatIndex === seatIndex) {
          collectGroup = group;
          break;
        }
      }
      if (collectGroup === null) {
        continue;
      }
      const collectFinal = finalResultOf(collectGroup.results);
      if (collectFinal === null) {
        continue;
      }
      const roundIdentityOf = roundIdentity(round);
      if (roundIdentityOf === null) {
        rejected.count += 1;
        continue;
      }
      const roundSpanId = telemetrySpanId(hmac, root, roundIdentityOf);
      if (roundSpanId === null) {
        // The parent id could not be built: drop and count, never half-built.
        rejected.count += 1;
        continue;
      }
      if (!spans.some((span) => span.spanId === roundSpanId)) {
        // The round span is not closed yet; the attempt waits for it.
        continue;
      }
      const attemptBuilt = build({
        identity,
        name: 'attempt',
        kind: 'AGENT',
        startIso: dispatchFinal.recordedAtIso,
        endIso: collectFinal.recordedAtIso,
        status: { code: 'unset', reasonCode: null },
        attributes: attemptAttributes(hmac, attempt, workOrderDigest),
        parentSpanId: roundSpanId,
        events: [],
      });
      if (attemptBuilt === null) {
        continue;
      }
      const usage = attempt.usage;
      if (usage !== null && usage !== undefined && usage.source === 'opencode-db') {
        const usageInput = telemetryHashInput(attempt.id);
        const usageIdentityOf = usageInput === null ? null : usageIdentity(usageInput);
        if (usageIdentityOf === null) {
          rejected.count += 1;
        } else {
          build({
            identity: usageIdentityOf,
            name: 'usage',
            kind: 'LLM',
            startIso: dispatchFinal.recordedAtIso,
            endIso: collectFinal.recordedAtIso,
            status: { code: 'unset', reasonCode: null },
            attributes: usageAttributes(attempt, usage),
            parentSpanId: attemptBuilt.spanId,
            events: [],
          });
        }
      }
    }

    for (const span of pending) {
      build(span);
    }

    // CI wait: a watching-ci conduct entry opens a span ending at the next
    // conduct entry, emitted only once that next entry exists (plan §3.1).
    for (let index = 0; index < conduct.length; index += 1) {
      const entry = conduct[index];
      if (entry.state !== 'watching-ci') {
        continue;
      }
      const next = conduct[index + 1];
      if (next === undefined) {
        continue;
      }
      const identity = ciWaitIdentity(entry.entryId);
      if (identity === null) {
        rejected.count += 1;
        continue;
      }
      build({
        identity,
        name: 'ci-wait',
        kind: 'CHAIN',
        startIso: entry.recordedAtIso,
        endIso: next.recordedAtIso,
        status: { code: 'unset', reasonCode: null },
        attributes: { ...sharedAttributes },
        parentSpanId: rootSpanId,
        events: [],
      });
    }

    return { spans, rejectedInvalid: rejected.count };
  } catch {
    return { spans: [], rejectedInvalid: 1 };
  }
}

/**
 * Map a hand-run attempt to its trace (plan §3.1, §3.4): the `attempt` AGENT
 * span is the root, its usage LLM child, and its gate and review receipt spans
 * as children, each identified by its receipt id and instant at the receipt's
 * `completedAtIso`. Emitted only once the attempt is terminal; an attempt that
 * belongs to a run (`conductedAttemptIds`) is never a hand-run trace. Never
 * throws; a span whose identity, ids or build fails is counted in
 * `rejectedInvalid`.
 */
export function attemptTraceSpans(hmac: TelemetryHmac, facts: AttemptTraceTelemetryFacts): LaneRunSpansResult {
  try {
    if (facts.conductedAttemptIds.has(facts.attempt.id)) {
      return { spans: [], rejectedInvalid: 0 };
    }
    if (!(TERMINAL_ATTEMPT_STATES as readonly string[]).includes(facts.attempt.state)) {
      return { spans: [], rejectedInvalid: 0 };
    }
    const attemptInput = telemetryHashInput(facts.attempt.id);
    if (attemptInput === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const root = attemptTraceRoot(attemptInput);
    if (root === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const traceId = telemetryTraceId(hmac, root);
    if (traceId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const identity = attemptIdentity(attemptInput);
    if (identity === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const attemptSpanId = telemetrySpanId(hmac, root, identity);
    if (attemptSpanId === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderInput = telemetryHashInput(facts.attempt.workOrderId);
    if (workOrderInput === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const workOrderDigest = telemetryDigest(hmac, 'work-order', workOrderInput);
    if (workOrderDigest === null) {
      return { spans: [], rejectedInvalid: 1 };
    }
    const startIso = facts.attempt.createdAtIso;
    const endIso =
      facts.attempt.completionReceipt !== null
        ? facts.attempt.completionReceipt.endedAtIso
        : facts.attempt.updatedAtIso;

    const spans: TelemetrySpan[] = [];
    const rejected = { count: 0 };
    const build = (span: PendingSpan): TelemetrySpan | null => {
      const spanId = telemetrySpanId(hmac, root, span.identity);
      if (spanId === null) {
        rejected.count += 1;
        return null;
      }
      // The attempt span is this trace's root; every other span needs a parent.
      if (span.parentSpanId === null && span.name !== 'attempt') {
        rejected.count += 1;
        return null;
      }
      const built = TelemetrySpan.build({
        traceId,
        spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        kind: span.kind,
        startIso: span.startIso,
        endIso: span.endIso,
        status: span.status,
        attributes: span.attributes,
        events: span.events,
      });
      if (built === null) {
        rejected.count += 1;
        return null;
      }
      spans.push(built);
      return built;
    };

    const attemptBuilt = build({
      identity,
      name: 'attempt',
      kind: 'AGENT',
      startIso,
      endIso,
      status: { code: 'unset', reasonCode: null },
      attributes: attemptAttributes(hmac, facts.attempt, workOrderDigest),
      parentSpanId: null,
      events: [],
    });
    if (attemptBuilt === null) {
      return { spans, rejectedInvalid: rejected.count };
    }

    const usage = facts.attempt.usage;
    if (usage !== null && usage !== undefined && usage.source === 'opencode-db') {
      const usageInput = telemetryHashInput(facts.attempt.id);
      const usageIdentityOf = usageInput === null ? null : usageIdentity(usageInput);
      if (usageIdentityOf === null) {
        rejected.count += 1;
      } else {
        build({
          identity: usageIdentityOf,
          name: 'usage',
          kind: 'LLM',
          startIso,
          endIso,
          status: { code: 'unset', reasonCode: null },
          attributes: usageAttributes(facts.attempt, usage),
          parentSpanId: attemptBuilt.spanId,
          events: [],
        });
      }
    }

    for (const receipt of facts.receipts.verification) {
      const receiptIdentity = verificationReceiptIdentity(receipt.receiptId);
      if (receiptIdentity === null) {
        rejected.count += 1;
        continue;
      }
      const attributes: Record<string, unknown> = { 'fleet.gate.result': receipt.result };
      if (receipt.exitCode !== null) {
        attributes['fleet.gate.exit_code'] = receipt.exitCode;
      }
      build({
        identity: receiptIdentity,
        name: 'gate',
        kind: 'GUARDRAIL',
        startIso: receipt.completedAtIso,
        endIso: receipt.completedAtIso,
        status: { code: 'unset', reasonCode: null },
        attributes,
        parentSpanId: attemptBuilt.spanId,
        events: [],
      });
    }

    for (const receipt of facts.receipts.review) {
      const receiptIdentity = reviewReceiptIdentity(receipt.receiptId);
      if (receiptIdentity === null) {
        rejected.count += 1;
        continue;
      }
      build({
        identity: receiptIdentity,
        name: 'review',
        kind: 'EVALUATOR',
        startIso: receipt.completedAtIso,
        endIso: receipt.completedAtIso,
        status: { code: 'unset', reasonCode: null },
        attributes: {
          'fleet.review.kind': receipt.kind,
          'fleet.review.result': receipt.result,
          'fleet.review.findings.blocker': receipt.findings.blocker,
          'fleet.review.findings.major': receipt.findings.major,
          'fleet.review.findings.minor': receipt.findings.minor,
          'fleet.review.findings.nit': receipt.findings.nit,
        },
        parentSpanId: attemptBuilt.spanId,
        events: [],
      });
    }

    return { spans, rejectedInvalid: rejected.count };
  } catch {
    return { spans: [], rejectedInvalid: 1 };
  }
}
