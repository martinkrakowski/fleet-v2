/**
 * FC8B: pure fair-admission decider. Given waiting runs grouped by opaque
 * `groupId` and `repository`, per-group and per-repository caps, per-group
 * `lastServedAtIso`, `freeSlots` and `nowIso`, decide which waiting runs to
 * admit now and which to park with a typed reason. Domain-only: no port, no
 * adapter, no persistence, no clock read, no randomness, no I/O. Hostile
 * inputs are read through the shared descriptor-based readers, so no getter
 * and no Proxy `get` trap ever runs.
 */

import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  readBoundedDenseArray,
  readExactPlainRecord,
  snapshotPlainDataRecord,
} from './plain-record-reads.js';

/** A run waiting in one repository's queue, ordered by queue time. */
export interface AdmissionWaitingRun {
  readonly runId: string;
  readonly queuedAtIso: string;
}

/** One repository's queue state inside a group. */
export interface AdmissionRepositoryInput {
  readonly repository: string;
  readonly maxConcurrent: number;
  readonly running: number;
  readonly waiting: readonly AdmissionWaitingRun[];
}

/** One group's queue state across its repositories. */
export interface AdmissionGroupInput {
  readonly groupId: string;
  readonly groupCap: number;
  readonly running: number;
  readonly repositories: readonly AdmissionRepositoryInput[];
}

/** The whole decision input. */
export interface FairAdmissionInput {
  readonly groups: readonly AdmissionGroupInput[];
  readonly lastServedAtIso: Readonly<Record<string, string | null>>;
  readonly freeSlots: number;
  readonly nowIso: string;
}

/** Why a waiting run was not admitted now. */
export type AdmissionParkReason = 'no-capacity' | 'group-cap' | 'repository-cap';

/** A run admitted now. */
export interface AdmittedRun {
  readonly runId: string;
  readonly groupId: string;
  readonly repository: string;
}

/** A run parked now, with the typed reason. */
export interface ParkedRun {
  readonly runId: string;
  readonly reason: AdmissionParkReason;
}

/** Why the whole input was refused before any decision. */
export type FairAdmissionRefusalReason =
  | 'invalid-input'
  | 'duplicate-run'
  | 'duplicate-group'
  | 'duplicate-repository'
  | 'too-large';

/** Typed outcome: either the admission decision or a refusal reason. */
export type FairAdmissionResult =
  | { readonly ok: true; readonly admit: readonly AdmittedRun[]; readonly parked: readonly ParkedRun[] }
  | { readonly ok: false; readonly reason: FairAdmissionRefusalReason };

/** Budget: groups + repositories + waiting runs in total. */
const ELEMENT_BUDGET = 10_000;
/** Cap on any single array's `length` before the budget applies. */
const SINGLE_ARRAY_CAP = 10_000;

/** A validated waiting run: the run id plus its parsed queue instant. */
interface ValidatedWaitingRun {
  readonly runId: string;
  readonly queuedAtMs: number;
}

/** Internal validated shape of one repository queue. */
interface ValidatedRepository {
  readonly repository: string;
  readonly maxConcurrent: number;
  readonly running: number;
  readonly waiting: readonly ValidatedWaitingRun[];
}

/** Internal validated shape of one group. */
interface ValidatedGroup {
  readonly groupId: string;
  readonly groupCap: number;
  readonly running: number;
  readonly repositories: readonly ValidatedRepository[];
  readonly lastServedAtMs: number | null;
}

/** Everything validation proved about the input. */
interface ValidatedInput {
  readonly freeSlots: number;
  readonly groups: readonly ValidatedGroup[];
}

/** Code-unit string comparison; deterministic across engines. */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A safe non-negative integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * A zoned, calendar-valid ISO-8601 timestamp that parses to a finite number.
 * The offset is required: strings with no zone designator are refused.
 */
function readZonedTimestamp(value: unknown): number | null {
  if (!isZonedIsoDateTime(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Refusal outcome. */
function refused(reason: FairAdmissionRefusalReason): FairAdmissionResult {
  return { ok: false, reason };
}

/**
 * O(1) pre-gate: the raw array's `length` when it is a genuine array whose
 * `length` is a plain data property `<= cap`, null otherwise. Reads only the
 * `length` descriptor — no key enumeration, no per-element copy — so the
 * budget can be checked before `readBoundedDenseArray` copies anything. A
 * null here means the array is invalid (wrong shape or a forbidden length),
 * which is exactly what `readBoundedDenseArray` would refuse again.
 */
function peekBoundedArrayLength(value: unknown, cap: number): number | null {
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
  } catch {
    return null;
  }
  if (
    !isArray ||
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length >= 2 ** 32 - 1 || length > cap) {
    return null;
  }
  return length;
}

/**
 * Validate the whole hostile input through descriptor-based readers. Returns
 * the refusal reason on failure, or the validated internal shape. Never
 * invokes a getter or a Proxy `get` trap; any trap throw is caught by the
 * caller and mapped to `invalid-input`.
 */
function validateFairAdmission(
  input: unknown,
): { readonly ok: true; readonly value: ValidatedInput } | { readonly ok: false; readonly reason: FairAdmissionRefusalReason } {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const top = readExactPlainRecord(input, ['groups', 'lastServedAtIso', 'freeSlots', 'nowIso']);
  if (top === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (!isNonNegativeSafeInteger(top.freeSlots)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const nowMs = readZonedTimestamp(top.nowIso);
  if (nowMs === null) {
    return { ok: false, reason: 'invalid-input' };
  }

  // `lastServedAtIso`: refuse an over-budget key count before copying the
  // record (the single `Reflect.ownKeys` call is the accepted count bound).
  const rawLastServed = top.lastServedAtIso;
  if (rawLastServed === null || typeof rawLastServed !== 'object' || Array.isArray(rawLastServed)) {
    return { ok: false, reason: 'invalid-input' };
  }
  let lastServedKeyCount: number;
  try {
    lastServedKeyCount = Reflect.ownKeys(rawLastServed as object).length;
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
  if (lastServedKeyCount > ELEMENT_BUDGET) {
    return { ok: false, reason: 'too-large' };
  }
  const lastServedSnapshot = snapshotPlainDataRecord(rawLastServed);
  if (lastServedSnapshot === null) {
    // Includes an own `__proto__` key: refused without altering any prototype.
    return { ok: false, reason: 'invalid-input' };
  }
  // Copy into a Map so keys like `constructor` are ordinary keys and lookup
  // never touches `Object.prototype`.
  const lastServedAtMsByKey = new Map<string, number | null>();
  for (const key of Object.keys(lastServedSnapshot)) {
    const value = lastServedSnapshot[key];
    if (value === null) {
      lastServedAtMsByKey.set(key, null);
      continue;
    }
    const parsed = readZonedTimestamp(value);
    // No timestamp may sit later than `nowIso`.
    if (parsed === null || parsed > nowMs) {
      return { ok: false, reason: 'invalid-input' };
    }
    lastServedAtMsByKey.set(key, parsed);
  }

  // `groups`: a single bounded dense array; a length over the single-array
  // cap is `invalid-input`, a total over the budget is `too-large`. The
  // budget is checked against the peeked length before the array is copied.
  const rawGroupsLength = peekBoundedArrayLength(top.groups, SINGLE_ARRAY_CAP);
  if (rawGroupsLength === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  // The budget covers groups + repositories + waiting runs only; the
  // `lastServedAtIso` key count is a separate cap, checked above.
  let elementTotal = rawGroupsLength;
  // Over-budget inputs are refused as soon as the count exceeds the budget,
  // before any of the counted elements are traversed or copied.
  if (elementTotal > ELEMENT_BUDGET) {
    return { ok: false, reason: 'too-large' };
  }
  const rawGroups = readBoundedDenseArray(top.groups, SINGLE_ARRAY_CAP);
  if (rawGroups === null) {
    return { ok: false, reason: 'invalid-input' };
  }

  const groupIds = new Set<string>();
  const runIds = new Set<string>();
  const groups: ValidatedGroup[] = [];

  for (const rawGroup of rawGroups.array) {
    const groupRecord = readExactPlainRecord(rawGroup, ['groupId', 'groupCap', 'running', 'repositories']);
    if (groupRecord === null) {
      return { ok: false, reason: 'invalid-input' };
    }
    const groupId = groupRecord.groupId;
    if (typeof groupId !== 'string' || groupId.length === 0) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (groupIds.has(groupId)) {
      return { ok: false, reason: 'duplicate-group' };
    }
    groupIds.add(groupId);
    if (!isNonNegativeSafeInteger(groupRecord.groupCap) || !isNonNegativeSafeInteger(groupRecord.running)) {
      return { ok: false, reason: 'invalid-input' };
    }
    // Budget pre-gate on the repositories' length before the copy.
    const rawRepositoriesLength = peekBoundedArrayLength(groupRecord.repositories, SINGLE_ARRAY_CAP);
    if (rawRepositoriesLength === null) {
      return { ok: false, reason: 'invalid-input' };
    }
    elementTotal += rawRepositoriesLength;
    if (elementTotal > ELEMENT_BUDGET) {
      return { ok: false, reason: 'too-large' };
    }
    const rawRepositories = readBoundedDenseArray(groupRecord.repositories, SINGLE_ARRAY_CAP);
    if (rawRepositories === null) {
      return { ok: false, reason: 'invalid-input' };
    }

    const repositoryIds = new Set<string>();
    const repositories: ValidatedRepository[] = [];
    for (const rawRepository of rawRepositories.array) {
      const repositoryRecord = readExactPlainRecord(rawRepository, ['repository', 'maxConcurrent', 'running', 'waiting']);
      if (repositoryRecord === null) {
        return { ok: false, reason: 'invalid-input' };
      }
      const repository = repositoryRecord.repository;
      if (typeof repository !== 'string' || repository.length === 0) {
        return { ok: false, reason: 'invalid-input' };
      }
      if (repositoryIds.has(repository)) {
        return { ok: false, reason: 'duplicate-repository' };
      }
      repositoryIds.add(repository);
      if (!isNonNegativeSafeInteger(repositoryRecord.maxConcurrent) || !isNonNegativeSafeInteger(repositoryRecord.running)) {
        return { ok: false, reason: 'invalid-input' };
      }
      // Budget pre-gate on the waiting runs' length before the copy.
      const rawWaitingLength = peekBoundedArrayLength(repositoryRecord.waiting, SINGLE_ARRAY_CAP);
      if (rawWaitingLength === null) {
        return { ok: false, reason: 'invalid-input' };
      }
      elementTotal += rawWaitingLength;
      if (elementTotal > ELEMENT_BUDGET) {
        return { ok: false, reason: 'too-large' };
      }
      const rawWaiting = readBoundedDenseArray(repositoryRecord.waiting, SINGLE_ARRAY_CAP);
      if (rawWaiting === null) {
        return { ok: false, reason: 'invalid-input' };
      }

      const waiting: ValidatedWaitingRun[] = [];
      for (const rawRun of rawWaiting.array) {
        const runRecord = readExactPlainRecord(rawRun, ['runId', 'queuedAtIso']);
        if (runRecord === null) {
          return { ok: false, reason: 'invalid-input' };
        }
        const runId = runRecord.runId;
        if (typeof runId !== 'string' || runId.length === 0) {
          return { ok: false, reason: 'invalid-input' };
        }
        if (runIds.has(runId)) {
          return { ok: false, reason: 'duplicate-run' };
        }
        runIds.add(runId);
        const queuedAtMs = readZonedTimestamp(runRecord.queuedAtIso);
        // No timestamp may sit later than `nowIso`.
        if (queuedAtMs === null || queuedAtMs > nowMs) {
          return { ok: false, reason: 'invalid-input' };
        }
        waiting.push({ runId, queuedAtMs });
      }
      repositories.push({
        repository,
        maxConcurrent: repositoryRecord.maxConcurrent,
        running: repositoryRecord.running,
        waiting,
      });
    }
    const served = lastServedAtMsByKey.get(groupId);
    groups.push({
      groupId,
      groupCap: groupRecord.groupCap,
      running: groupRecord.running,
      repositories,
      lastServedAtMs: served === undefined ? null : served,
    });
  }

  // One budget over groups + repositories + waiting runs; the check above
  // fires as soon as the running total exceeds it, so this is a backstop.
  if (elementTotal > ELEMENT_BUDGET) {
    return { ok: false, reason: 'too-large' };
  }
  return { ok: true, value: { freeSlots: top.freeSlots, groups } };
}

/** Sort key for waiting runs: (queuedAtMs, runId). */
function compareWaiting(a: ValidatedWaitingRun, b: ValidatedWaitingRun): number {
  if (a.queuedAtMs !== b.queuedAtMs) {
    return a.queuedAtMs - b.queuedAtMs;
  }
  return compareCodeUnit(a.runId, b.runId);
}

/** One repository queue inside the rotation, with its admission counters. */
interface RotationRepository {
  readonly repository: string;
  readonly maxConcurrent: number;
  readonly running: number;
  readonly queue: readonly ValidatedWaitingRun[];
  /** Index of the next unconsumed waiting run; queues are never re-sliced. */
  head: number;
  admitted: number;
  /** Circular doubly-linked rotation links (-1 when the list is empty). */
  prev: number;
  next: number;
}

/** One group inside the rotation, with its admission counters. */
interface RotationGroup {
  readonly groupId: string;
  readonly groupCap: number;
  readonly lastServedAtMs: number | null;
  readonly running: number;
  readonly repositories: RotationRepository[];
  admitted: number;
  /** Waiting runs not yet consumed, maintained incrementally (O(1) read). */
  remaining: number;
  /** Index of the next repository the group will try. */
  repoCursor: number;
  /** How many repositories are still in the group's rotation. */
  repoLive: number;
  /** Circular doubly-linked rotation links (-1 when the list is empty). */
  prev: number;
  next: number;
}

/** The repository still has queue remaining and repo capacity. */
function repoCanAdmit(repo: RotationRepository): boolean {
  return repo.head < repo.queue.length && repo.running + repo.admitted < repo.maxConcurrent;
}

/** The group still has group capacity, waiting runs, and a live repository. */
function groupCanAdmit(group: RotationGroup): boolean {
  return (
    group.remaining > 0 && group.running + group.admitted < group.groupCap && group.repoLive > 0
  );
}

/** Wire an array into a circular doubly-linked list; returns the head index. */
function linkCircular(list: { prev: number; next: number }[]): number {
  const count = list.length;
  for (let index = 0; index < count; index += 1) {
    list[index].prev = (index - 1 + count) % count;
    list[index].next = (index + 1) % count;
  }
  return count === 0 ? -1 : 0;
}

/** Remove one repository from its group's circular rotation in O(1). */
function unlinkRepo(group: RotationGroup, index: number): void {
  const repositories = group.repositories;
  const node = repositories[index];
  repositories[node.prev].next = node.next;
  repositories[node.next].prev = node.prev;
  if (group.repoCursor === index) {
    group.repoCursor = node.next;
  }
  group.repoLive -= 1;
}

/** The group rotation: the linked nodes plus the cursor and live count. */
interface GroupRotation {
  readonly groups: RotationGroup[];
  cursor: number;
  live: number;
}

/** Remove one group from the circular rotation in O(1). */
function unlinkGroup(rotation: GroupRotation, index: number): void {
  const groups = rotation.groups;
  const node = groups[index];
  groups[node.prev].next = node.next;
  groups[node.next].prev = node.prev;
  if (rotation.cursor === index) {
    rotation.cursor = node.next;
  }
  rotation.live -= 1;
}

/**
 * Decide the fair admission for one instant. Hostile inputs are refused with
 * a typed reason; no getter or Proxy `get` trap ever runs; `input` is never
 * mutated. The decision is O(N log N) in the total waiting runs N.
 */
export function decideFairAdmission(input: unknown): FairAdmissionResult {
  try {
    const validated = validateFairAdmission(input);
    if (!validated.ok) {
      return refused(validated.reason);
    }
    return decideFromValidated(validated.value);
  } catch {
    // A revoked or lying Proxy that throws anywhere along the read path is
    // mapped to the typed refusal; a Proxy that lies consistently in every
    // trap is the accepted residual.
    return refused('invalid-input');
  }
}

/** The admission decision over validated groups. */
function decideFromValidated(validated: ValidatedInput): FairAdmissionResult {
  const rotationGroups: RotationGroup[] = [];
  for (const group of validated.groups) {
    // Only repositories with at least one waiting run enter the rotation.
    const repositories: RotationRepository[] = [];
    for (const repository of group.repositories) {
      if (repository.waiting.length === 0) {
        continue;
      }
      repositories.push({
        repository: repository.repository,
        maxConcurrent: repository.maxConcurrent,
        running: repository.running,
        queue: [...repository.waiting].sort(compareWaiting),
        head: 0,
        admitted: 0,
        prev: -1,
        next: -1,
      });
    }
    if (repositories.length === 0) {
      continue;
    }
    // Repositories ordered by their oldest waiting run's
    // (queuedAtMs, runId, repository).
    repositories.sort((a, b) => {
      const byOldest = compareWaiting(a.queue[0], b.queue[0]);
      return byOldest !== 0 ? byOldest : compareCodeUnit(a.repository, b.repository);
    });
    rotationGroups.push({
      groupId: group.groupId,
      groupCap: group.groupCap,
      lastServedAtMs: group.lastServedAtMs,
      running: group.running,
      repositories,
      admitted: 0,
      remaining: repositories.reduce((total, repository) => total + repository.queue.length, 0),
      repoCursor: 0,
      repoLive: repositories.length,
      prev: -1,
      next: -1,
    });
  }

  // Groups ordered by lastServedAtMs ascending (null first), ties by groupId.
  rotationGroups.sort((a, b) => {
    const aServed = a.lastServedAtMs ?? Number.NEGATIVE_INFINITY;
    const bServed = b.lastServedAtMs ?? Number.NEGATIVE_INFINITY;
    if (aServed !== bServed) {
      return aServed - bServed;
    }
    return compareCodeUnit(a.groupId, b.groupId);
  });

  const admit: AdmittedRun[] = [];

  // Round-robin across groups: a group cursor and a per-group repo cursor,
  // both circular doubly-linked lists so removal is O(1). Every walk step
  // either admits a run or removes a group or repository that can never
  // admit again, so the whole walk is O(N + G + R) on top of the O(N log N)
  // sort; no queue is ever re-sliced and no admission list is re-scanned.
  const rotation: GroupRotation = {
    groups: rotationGroups,
    cursor: linkCircular(rotationGroups),
    live: rotationGroups.length,
  };
  for (const group of rotationGroups) {
    group.repoCursor = linkCircular(group.repositories);
  }
  while (admit.length < validated.freeSlots && rotation.live > 0) {
    const liveBefore = rotation.live;
    let chosenGroup = -1;
    let chosenRepo = -1;
    let scanned = 0;
    let index = rotation.cursor;
    while (scanned < liveBefore && chosenGroup === -1) {
      const group = rotation.groups[index];
      const nextIndex = group.next;
      if (groupCanAdmit(group)) {
        // Advance from the group's repo cursor to the next eligible
        // repository, removing repositories that can never admit again.
        const repoLiveBefore = group.repoLive;
        let repoScanned = 0;
        let repoIndex = group.repoCursor;
        while (repoScanned < repoLiveBefore) {
          const repo = group.repositories[repoIndex];
          const repoNext = repo.next;
          if (repoCanAdmit(repo)) {
            chosenGroup = index;
            chosenRepo = repoIndex;
            break;
          }
          unlinkRepo(group, repoIndex);
          repoIndex = repoNext;
          repoScanned += 1;
        }
      }
      if (chosenGroup === -1) {
        // Capacity or waiting runs are gone for good: drop from the rotation.
        unlinkGroup(rotation, index);
        index = nextIndex;
        scanned += 1;
      }
    }
    if (chosenGroup === -1) {
      break;
    }
    const group = rotation.groups[chosenGroup];
    const repo = group.repositories[chosenRepo];
    const run = repo.queue[repo.head];
    admit.push({ runId: run.runId, groupId: group.groupId, repository: repo.repository });
    repo.head += 1;
    repo.admitted += 1;
    group.admitted += 1;
    group.remaining -= 1;
    group.repoCursor = repo.next;
    rotation.cursor = group.next;
  }

  // Per-group and per-repo admission counts for the park-reason classification.
  // The per-repo counts live in a nested Map (group -> repository -> count):
  // opaque group and repository strings are joined by structure, never by a
  // separator, so distinct pairs can never collide.
  const admittedRunIds = new Set<string>();
  const admittedByGroup = new Map<string, number>();
  const admittedByRepo = new Map<string, Map<string, number>>();
  for (const entry of admit) {
    admittedRunIds.add(entry.runId);
    admittedByGroup.set(entry.groupId, (admittedByGroup.get(entry.groupId) ?? 0) + 1);
    let perRepo = admittedByRepo.get(entry.groupId);
    if (perRepo === undefined) {
      perRepo = new Map<string, number>();
      admittedByRepo.set(entry.groupId, perRepo);
    }
    perRepo.set(entry.repository, (perRepo.get(entry.repository) ?? 0) + 1);
  }

  // All un-admitted runs, in deterministic (groupId, repository,
  // queuedAtMs, runId) order, each with its typed park reason.
  const parkedEntries: { readonly runId: string; readonly reason: AdmissionParkReason; readonly sortGroup: string; readonly sortRepository: string; readonly queuedAtMs: number }[] = [];
  for (const group of validated.groups) {
    const groupAdmitted = admittedByGroup.get(group.groupId) ?? 0;
    const groupExhausted = group.groupCap === 0 || group.running + groupAdmitted >= group.groupCap;
    for (const repository of group.repositories) {
      const repoAdmitted = admittedByRepo.get(group.groupId)?.get(repository.repository) ?? 0;
      const repoExhausted =
        repository.maxConcurrent === 0 || repository.running + repoAdmitted >= repository.maxConcurrent;
      let reason: AdmissionParkReason;
      if (groupExhausted) {
        reason = 'group-cap';
      } else if (repoExhausted) {
        reason = 'repository-cap';
      } else {
        // Capacity exists on both scopes, so only the free-slot budget ran out.
        reason = 'no-capacity';
      }
      for (const run of repository.waiting) {
        if (!admittedRunIds.has(run.runId)) {
          parkedEntries.push({
            runId: run.runId,
            reason,
            sortGroup: group.groupId,
            sortRepository: repository.repository,
            queuedAtMs: run.queuedAtMs,
          });
        }
      }
    }
  }
  parkedEntries.sort((a, b) => {
    if (a.sortGroup !== b.sortGroup) {
      return compareCodeUnit(a.sortGroup, b.sortGroup);
    }
    if (a.sortRepository !== b.sortRepository) {
      return compareCodeUnit(a.sortRepository, b.sortRepository);
    }
    if (a.queuedAtMs !== b.queuedAtMs) {
      return a.queuedAtMs - b.queuedAtMs;
    }
    return compareCodeUnit(a.runId, b.runId);
  });
  const parked: ParkedRun[] = parkedEntries.map((entry) => ({ runId: entry.runId, reason: entry.reason }));

  return { ok: true, admit, parked };
}
