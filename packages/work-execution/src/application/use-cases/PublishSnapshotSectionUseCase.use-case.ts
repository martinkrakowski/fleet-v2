// @generated use-case scaffold — refined for lane LB2-1.
import { snapshotPlainData } from '@fleet/shared';
import type { IsProxy } from '@fleet/shared';
import {
  buildParksSnapshotPush,
  buildRunningSnapshotPush,
  buildTrainSnapshotPush,
  PUBLISHER_SECTIONS,
  SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS,
} from '../../domain/snapshot-publishers.js';
import type { PublisherSection, SnapshotBuildResult } from '../../domain/snapshot-publishers.js';
import { MERGE_QUEUE_ENTRY_STATES, MERGE_QUEUE_TERMINAL_STATES } from '../../domain/merge-queue-records.js';
import { readBoundedDenseArray } from '../../domain/plain-record-reads.js';
import type { SectionSnapshotPush } from '../../domain/snapshot-sections.js';
import type {
  PublishSnapshotSectionPort,
  PublishSnapshotSectionRequest,
  PublishSnapshotSectionResult,
} from '../ports/in/PublishSnapshotSectionPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneServerSessionReadPort } from '../ports/out/LaneServerSessionReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { SnapshotPushPort } from '../ports/out/SnapshotPushPort.out-port.js';

/** The most records read from one owning store before projection (the merge queue's own order cap). */
const MAX_SOURCE_RECORDS = 5000;

const SESSION_UNAVAILABLE_REASONS: readonly string[] = ['transport-error', 'timeout', 'not-configured', 'unreadable'];
const PUSH_REFUSAL_REASONS: readonly string[] = ['non-increasing-revision', 'invalid', 'unauthorized'];
const PUSH_UNAVAILABLE_REASONS: readonly string[] = ['transport-error', 'timeout', 'not-configured'];

export interface PublishSnapshotSectionDeps {
  readonly sessions: LaneServerSessionReadPort;
  readonly laneRuns: LaneRunRepositoryPort;
  readonly mergeQueue: MergeQueueRepositoryPort;
  readonly snapshotPush: SnapshotPushPort;
  /** The trusted Proxy detector (`types.isProxy` in production); required, never defaulted. */
  readonly isProxy: IsProxy;
}

interface ParsedRequest {
  readonly section: PublisherSection;
  readonly revision: number;
  readonly pushedAtIso: string;
  readonly deadlineIso: string;
}

type Built =
  | { readonly kind: 'push'; readonly push: SectionSnapshotPush }
  | { readonly kind: 'result'; readonly result: PublishSnapshotSectionResult };

const UNREADABLE_SOURCE: Built = {
  kind: 'result',
  result: { outcome: 'unavailable', reason: 'source-unreadable' },
};

function refusedResult(reason: 'invalid-input' | 'invalid' | 'budget-exhausted'): PublishSnapshotSectionResult {
  return { outcome: 'refused', reason };
}

function isRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownData(value: unknown, key: string): unknown {
  return isRecordValue(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Publish one token-only section; reads owning state, never writes any of it. */
export class PublishSnapshotSectionUseCase implements PublishSnapshotSectionPort {
  constructor(private readonly deps: PublishSnapshotSectionDeps) {}

  async publish(request: PublishSnapshotSectionRequest): Promise<PublishSnapshotSectionResult> {
    try {
      const parsed = this.readRequest(request);
      if (parsed === null) {
        return refusedResult('invalid-input');
      }
      const built = await this.build(parsed);
      if (built.kind === 'result') {
        return built.result;
      }
      return await this.push(built.push);
    } catch {
      return { outcome: 'unavailable', reason: 'source-unreadable' };
    }
  }

  /** One own data property by descriptor: no getter runs, no Proxy is read, anything else is `undefined`. */
  private field(source: unknown, key: string): unknown {
    try {
      if (typeof source !== 'object' || source === null || this.deps.isProxy(source) !== false) {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  }

  private readRequest(request: unknown): ParsedRequest | null {
    try {
      if (
        typeof request !== 'object' ||
        request === null ||
        this.deps.isProxy(request) !== false ||
        Reflect.ownKeys(request).some((key) => key === 'constructor' || key === 'prototype' || key === '__proto__')
      ) {
        return null;
      }
    } catch {
      return null;
    }
    const section = this.field(request, 'section');
    const revision = this.field(request, 'revision');
    const pushedAtIso = this.field(request, 'pushedAtIso');
    const deadlineIso = this.field(request, 'deadlineIso');
    if (
      typeof section !== 'string' ||
      !(PUBLISHER_SECTIONS as readonly string[]).includes(section) ||
      typeof revision !== 'number' ||
      typeof pushedAtIso !== 'string' ||
      (deadlineIso !== undefined && typeof deadlineIso !== 'string')
    ) {
      return null;
    }
    return {
      section: section as PublisherSection,
      revision,
      pushedAtIso,
      deadlineIso: deadlineIso ?? pushedAtIso,
    };
  }

  /** A dense copy of one store's answer, or null when the read threw or the answer is not a bounded dense array. */
  private async readList(read: () => Promise<unknown>): Promise<readonly unknown[] | null> {
    try {
      const answer = await read();
      if (this.deps.isProxy(answer) !== false) {
        return null;
      }
      const dense = readBoundedDenseArray(answer, MAX_SOURCE_RECORDS);
      return dense === null ? null : dense.array;
    } catch {
      return null;
    }
  }

  private async build(request: ParsedRequest): Promise<Built> {
    switch (request.section) {
      case 'running':
        return this.buildRunning(request);
      case 'train':
        return this.buildTrain(request);
      case 'parks':
        return this.buildParks(request);
    }
  }

  private fromBuild(result: SnapshotBuildResult, unreadableReason: 'unreadable' | 'source-unreadable'): Built {
    if (result.ok) {
      return { kind: 'push', push: result.push };
    }
    // A malformed source answer is unavailable; every other refusal is the builder's own typed reason.
    if (result.reason === 'invalid-input') {
      return { kind: 'result', result: { outcome: 'unavailable', reason: unreadableReason } };
    }
    return { kind: 'result', result: { outcome: 'refused', reason: result.reason } };
  }

  private async buildRunning(request: ParsedRequest): Promise<Built> {
    let response: unknown;
    try {
      // The ONLY read for `running`: the lane-server session list, never a lane-run record.
      response = await this.deps.sessions.listRunningSessions();
    } catch {
      return UNREADABLE_SOURCE;
    }
    const snapshot = snapshotPlainData(response, this.deps.isProxy, SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS);
    if (!snapshot.ok) {
      const budget = snapshot.reason === 'too-many-items' || snapshot.reason === 'too-many-nodes';
      return budget
        ? { kind: 'result', result: refusedResult('budget-exhausted') }
        : { kind: 'result', result: { outcome: 'unavailable', reason: 'unreadable' } };
    }
    const outcome = ownData(snapshot.value, 'outcome');
    if (outcome === 'unavailable') {
      const reason = ownData(snapshot.value, 'reason');
      return {
        kind: 'result',
        result: {
          outcome: 'unavailable',
          reason:
            typeof reason === 'string' && SESSION_UNAVAILABLE_REASONS.includes(reason)
              ? (reason as 'transport-error' | 'timeout' | 'not-configured' | 'unreadable')
              : 'unreadable',
        },
      };
    }
    if (outcome !== 'ok') {
      return { kind: 'result', result: { outcome: 'unavailable', reason: 'unreadable' } };
    }
    return this.fromBuild(
      buildRunningSnapshotPush(
        {
          revision: request.revision,
          pushedAtIso: request.pushedAtIso,
          sessions: ownData(snapshot.value, 'sessions'),
        },
        this.deps.isProxy,
      ),
      'unreadable',
    );
  }

  private async buildTrain(request: ParsedRequest): Promise<Built> {
    const entries = await this.readList(() =>
      this.deps.mergeQueue.listMergeEntries({ deadlineIso: request.deadlineIso }),
    );
    if (entries === null) {
      return UNREADABLE_SOURCE;
    }
    const live: unknown[] = [];
    for (const entry of entries) {
      const state = this.field(entry, 'state');
      if (typeof state === 'string' && (MERGE_QUEUE_TERMINAL_STATES as readonly string[]).includes(state)) {
        continue;
      }
      live.push({
        repository: this.projectRepository(entry),
        pullRequest: this.field(entry, 'pullRequest'),
        state,
      });
    }
    return this.fromBuild(
      buildTrainSnapshotPush(
        { revision: request.revision, pushedAtIso: request.pushedAtIso, entries: live },
        this.deps.isProxy,
      ),
      'source-unreadable',
    );
  }

  private async buildParks(request: ParsedRequest): Promise<Built> {
    const runs = await this.readList(() => this.deps.laneRuns.list());
    if (runs === null) {
      return UNREADABLE_SOURCE;
    }
    const entries = await this.readList(() =>
      this.deps.mergeQueue.listMergeEntries({ deadlineIso: request.deadlineIso }),
    );
    if (entries === null) {
      return UNREADABLE_SOURCE;
    }
    const parkedRuns: unknown[] = [];
    for (const run of runs) {
      const parked = this.field(run, 'parked');
      if (parked === null) {
        continue;
      }
      // A missing `parked` key reads as `undefined` and reaches the builder as malformed.
      parkedRuns.push({ runId: this.field(run, 'runId'), reason: this.field(parked, 'reason') });
    }
    const parkedEntries: unknown[] = [];
    for (const entry of entries) {
      const state = this.field(entry, 'state');
      // A missing, non-string or unknown state is a malformed record: never read as "not parked".
      if (typeof state !== 'string' || !(MERGE_QUEUE_ENTRY_STATES as readonly string[]).includes(state)) {
        return UNREADABLE_SOURCE;
      }
      if (state !== 'parked') {
        continue;
      }
      parkedEntries.push({
        repository: this.projectRepository(entry),
        pullRequest: this.field(entry, 'pullRequest'),
        reason: this.field(entry, 'reason'),
      });
    }
    return this.fromBuild(
      buildParksSnapshotPush(
        { revision: request.revision, pushedAtIso: request.pushedAtIso, parkedRuns, parkedEntries },
        this.deps.isProxy,
      ),
      'source-unreadable',
    );
  }

  private projectRepository(entry: unknown): unknown {
    const repository = this.field(entry, 'repository');
    return { owner: this.field(repository, 'owner'), repo: this.field(repository, 'repo') };
  }

  private async push(push: SectionSnapshotPush): Promise<PublishSnapshotSectionResult> {
    let response: unknown;
    try {
      response = await this.deps.snapshotPush.push(push);
    } catch {
      return { outcome: 'unavailable', reason: 'transport-error' };
    }
    // Anything but an exact, known answer is a refusal: an unknown answer is never success.
    const snapshot = snapshotPlainData(response, this.deps.isProxy, SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS);
    if (!snapshot.ok || !isRecordValue(snapshot.value)) {
      return refusedResult('invalid');
    }
    const outcome = ownData(snapshot.value, 'outcome');
    const reason = ownData(snapshot.value, 'reason');
    if (outcome === 'pushed') {
      // `pushed` carries no other field: a reason or any extra key is a contradictory answer.
      if (Reflect.ownKeys(snapshot.value).length !== 1) {
        return refusedResult('invalid');
      }
      return {
        outcome: 'published',
        section: push.section as PublisherSection,
        revision: push.revision,
        tokenCount: push.tokens.length,
      };
    }
    if (outcome === 'refused' && typeof reason === 'string' && PUSH_REFUSAL_REASONS.includes(reason)) {
      return { outcome: 'refused', reason: reason as 'non-increasing-revision' | 'invalid' | 'unauthorized' };
    }
    if (outcome === 'unavailable' && typeof reason === 'string' && PUSH_UNAVAILABLE_REASONS.includes(reason)) {
      return { outcome: 'unavailable', reason: reason as 'transport-error' | 'timeout' | 'not-configured' };
    }
    return refusedResult('invalid');
  }
}
