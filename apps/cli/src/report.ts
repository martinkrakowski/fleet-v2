/**
 * `fleet-v2 report` (P1-12a): the read-only weekly run-journal service report.
 * One JSON document on stdout: the admission-wait and park-to-notify p95
 * latencies of the trailing 7 days, sampled from lane runs, the keyed run
 * journal and conductor park notices. The report stores nothing — it performs
 * no append, no save and adds no write of its own. A source that cannot be
 * read is reported `not-read`, never as zero samples, and the whole run exits
 * 1 with `outcome: "refused"`.
 */

import { parseLaneRunKey } from '@fleet/work-execution';
import type { LaneRunJournalEntryRecord } from '@fleet/work-execution';

import type { FleetCliRuntime } from './composition.js';
import type { CliIo } from './index.js';

export interface ReportCliOptions {
  /** Clock override for tests; production uses the system clock. */
  readonly now?: () => Date;
}

export const REPORT_HELP = `Usage: fleet-v2 report weekly

Weekly run-journal service report (read-only): reads the lane runs, the keyed
run journal and conductor park notices of the selected state directory and
prints one JSON document with the admission-wait and park-to-notify p95
latencies of the trailing 7 days. It writes nothing.

Exit codes: 0 completed, 1 a source could not be read (refused), 2 usage error.`;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type AdmissionWaitMetric =
  | { readonly status: 'measured'; readonly p95Ms: number | null; readonly samples: number }
  | { readonly status: 'not-read' };

type ParkToNotifyMetric =
  | { readonly status: 'measured'; readonly p95Ms: number | null; readonly samples: number }
  | { readonly status: 'not-read' };

interface Sample {
  readonly ms: number;
}

/** nearest-rank p95 over ascending-sorted whole-millisecond values (rank = ceil(0.95·n), 1-based); null when empty. */
function p95Ms(msValues: readonly number[]): number | null {
  if (msValues.length === 0) {
    return null;
  }
  const sorted = [...msValues].sort((left, right) => left - right);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1]!;
}

/** Non-negative interval in milliseconds between two ISO timestamps, or null if negative (clock skew). */
function nonNegativeIntervalMs(startIso: string, endIso: string): number | null {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (ms < 0) {
    return null;
  }
  return ms;
}

function stepForEntry(entry: LaneRunJournalEntryRecord, weekStartMs: number): string | null {
  if (entry.key === null) {
    return null;
  }
  if (Date.parse(entry.recordedAtIso) < weekStartMs) {
    return null;
  }
  const parsed = parseLaneRunKey(entry.key);
  if (parsed === null || parsed.kind !== 'step') {
    return null;
  }
  return parsed.step;
}

interface AdmissionTimestamps {
  readonly prepareAt: string | null;
  readonly dispatchAt: string | null;
}

function scanAdmissionTimestamps(
  entries: readonly LaneRunJournalEntryRecord[],
  weekStartMs: number,
): AdmissionTimestamps {
  let prepareAt: string | null = null;
  let dispatchAt: string | null = null;
  for (const entry of entries) {
    const step = stepForEntry(entry, weekStartMs);
    if (step === null) {
      continue;
    }
    if (prepareAt === null && step === 'prepare' && entry.kind === 'result' && entry.outcome !== 'ambiguous') {
      prepareAt = entry.recordedAtIso;
    }
    if (dispatchAt === null && step === 'dispatch' && entry.kind === 'intent') {
      dispatchAt = entry.recordedAtIso;
    }
  }
  return { prepareAt, dispatchAt };
}

function admissionSampleForRun(
  entries: readonly LaneRunJournalEntryRecord[],
  weekStartMs: number,
): Sample | null {
  const { prepareAt, dispatchAt } = scanAdmissionTimestamps(entries, weekStartMs);
  if (prepareAt === null || dispatchAt === null) {
    return null;
  }
  const ms = nonNegativeIntervalMs(prepareAt, dispatchAt);
  if (ms === null) {
    return null;
  }
  return { ms };
}

/**
 * Admission-wait samples: one per run that, in the window, has a prepare
 * result (the earliest non-ambiguous `prepare` result) and a dispatch intent
 * (the earliest `dispatch` intent). A negative interval is dropped (clock
 * skew), never clamped and never counted.
 */
function admissionWaitSamples(
  entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>,
  weekStartMs: number,
): Sample[] {
  const samples: Sample[] = [];
  for (const entries of entriesByRun.values()) {
    const sample = admissionSampleForRun(entries, weekStartMs);
    if (sample !== null) {
      samples.push(sample);
    }
  }
  return samples;
}

type AttentionItemEntry = Awaited<
  ReturnType<FleetCliRuntime['coordination']['listAttentionItems']['listAttentionItems']>
>['items'][number];

function parkNoticeIndex(items: readonly AttentionItemEntry[]): Map<string, string> {
  const noticedAt = new Map<string, string>();
  for (const entry of items) {
    if (entry.item.kind === 'conductor-park' && entry.item.subject.kind === 'run') {
      noticedAt.set(entry.item.subject.ref, entry.item.firstRaisedAtIso);
    }
  }
  return noticedAt;
}

function firstInWindowParkAt(
  entries: readonly LaneRunJournalEntryRecord[],
  weekStartMs: number,
): string | null {
  for (const entry of entries) {
    if (Date.parse(entry.recordedAtIso) < weekStartMs) {
      continue;
    }
    if (entry.kind === 'conduct' && entry.state === 'parked') {
      return entry.recordedAtIso;
    }
  }
  return null;
}

/**
 * Park-to-notify samples: one per run that, in the window, has a `parked`
 * conduct entry (its first in the window) and a matching conductor-park
 * notice; the notify time is the notice's first raise. A negative interval is
 * dropped the same way as an admission wait.
 */
function parkToNotifySamples(
  entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>,
  items: readonly AttentionItemEntry[],
  weekStartMs: number,
): Sample[] {
  const noticedAt = parkNoticeIndex(items);
  const samples: Sample[] = [];
  for (const [runId, entries] of entriesByRun) {
    const firstRaisedAtIso = noticedAt.get(runId);
    if (firstRaisedAtIso === undefined) {
      continue;
    }
    const parkAt = firstInWindowParkAt(entries, weekStartMs);
    if (parkAt === null) {
      continue;
    }
    const ms = nonNegativeIntervalMs(parkAt, firstRaisedAtIso);
    if (ms !== null) {
      samples.push({ ms });
    }
  }
  return samples;
}

/** The measured metric document for a source that was read; zero samples keep `p95Ms: null`. */
function measuredMetric(
  samples: readonly Sample[],
): { readonly status: 'measured'; readonly p95Ms: number | null; readonly samples: number } {
  return {
    status: 'measured',
    p95Ms: p95Ms(samples.map((sample) => sample.ms)),
    samples: samples.length,
  };
}

/** `fleet-v2 report weekly`: read both sources (fail closed) and print the one JSON document. */
async function weeklyCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ReportCliOptions,
): Promise<number> {
  if (argv.length > 0) {
    io.stderr(`Unknown report weekly option: ${argv[0]}\n`);
    return 2;
  }

  const now = options.now?.() ?? new Date();
  const weekEndIso = now.toISOString();
  const weekStartMs = now.getTime() - WEEK_MS;
  const weekStartIso = new Date(weekStartMs).toISOString();

  let journalRead = true;
  let attentionRead = true;
  let entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]> = new Map();
  let items: readonly AttentionItemEntry[] = [];

  try {
    const runs = await runtime.conductor.laneRunRepository.list();
    const runIds = runs.map((run) => run.runId);
    entriesByRun = await runtime.conductor.laneRunJournal.listForRuns(runIds);
  } catch {
    journalRead = false;
  }
  try {
    items = (await runtime.coordination.listAttentionItems.listAttentionItems({ kind: 'conductor-park' })).items;
  } catch {
    attentionRead = false;
  }

  const sources = {
    runJournal: journalRead ? 'read' : 'not-read',
    attentionItems: attentionRead ? 'read' : 'not-read',
  };
  const admissionWait: AdmissionWaitMetric = journalRead
    ? measuredMetric(admissionWaitSamples(entriesByRun, weekStartMs))
    : { status: 'not-read' };
  const parkToNotify: ParkToNotifyMetric = journalRead && attentionRead
    ? measuredMetric(parkToNotifySamples(entriesByRun, items, weekStartMs))
    : { status: 'not-read' };
  const output = {
    outcome: journalRead && attentionRead ? 'completed' : 'refused',
    weekStartIso,
    weekEndIso,
    admissionWait,
    parkToNotify,
    sources,
  };

  io.stdout(`${JSON.stringify(output)}\n`);
  return output.outcome === 'completed' ? 0 : 1;
}

/** `fleet-v2 report <subcommand>` dispatch. */
export async function reportCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ReportCliOptions,
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    argv[1] === '--help' ||
    argv[1] === '-h'
  ) {
    io.stdout(`${REPORT_HELP}\n`);
    return 0;
  }
  if (subcommand === 'weekly') {
    return await weeklyCommand(argv.slice(1), io, runtime, options);
  }
  io.stderr(`Unknown report subcommand\n`);
  return 2;
}
