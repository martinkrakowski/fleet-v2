/**
 * The pure mapper of a conducted run's telemetry trace (plan §3.1, §3.3,
 * §3.4; OT1b-1): `laneRunSpans(hmac, facts)` maps a `LaneRunRecord` and its
 * keyed journal to closed `TelemetrySpan`s only — the root when the run is
 * terminal, round spans once closed, one span per keyed step (intent → final
 * result), the stop request, and one ci-wait span per closed watching-ci
 * conduct entry. Never throws, never reads a clock: every time comes from a
 * record field, every id from the §3.4 identity functions. A span whose
 * identity, ids or digest cannot be built is dropped and counted in
 * `rejectedInvalid`, never emitted half-built.
 */

import { parseLaneRunKey, stopModeOfKey } from './lane-run-keys.js';
import { LANE_RUN_TERMINAL_STATES } from './value-objects/LaneRunState.vo.js';
import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import { LANE_RUN_MAX_ROUND, type LaneRunKeyStep, type LaneRunRecord } from './lane-run-records.js';
import {
  ciWaitIdentity,
  journalKeyIdentity,
  roundIdentity,
  runRootIdentity,
  runTraceRoot,
  telemetryDigest,
  telemetryHashInput,
  telemetrySpanId,
  telemetryTraceId,
  type TelemetryHmac,
  type TelemetrySpanIdentity,
  type TelemetryTraceRoot,
} from './run-telemetry-ids.js';
import { TELEMETRY_MAX_EVENTS, TelemetrySpan } from './run-telemetry.js';
import type { TelemetrySpanEvent, TelemetrySpanName, TelemetrySpanStatus } from './run-telemetry.js';
import type { TelemetrySpanKind } from './run-telemetry-attributes.js';

/** The plain input facts of the mapper (plan §3.3): no raw id leaves it. */
export interface LaneRunTelemetryFacts {
  readonly run: LaneRunRecord;
  readonly journal: readonly LaneRunJournalEntryRecord[];
  /** The project alias, if any (policy.telemetry.projectAliases). */
  readonly project: string | null;
  readonly tags: readonly string[];
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
        const final = finalResultOf(group.results);
        if (final === null) {
          // The round this intent belongs to stays withheld: no round span
          // while any round-step intent in it lacks a final result.
          pendingStepRounds.add(parsed.round);
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
        const underRound = (ROUND_STEPS as readonly string[]).includes(parsed.step);
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
