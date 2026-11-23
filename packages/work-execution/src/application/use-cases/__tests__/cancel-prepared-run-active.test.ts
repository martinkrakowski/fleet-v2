import { describe, expect, it } from 'vitest';

import { findLiveRunForAttempt, MAX_LIVE_RUN_SCAN_RUNS, MAX_RUN_ATTEMPT_IDS } from '../cancel-prepared-run-active.js';
import { LANE_RUN_STATES, LANE_RUN_TERMINAL_STATES, type LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';

/** Test fixtures carry no hostnames, addresses, tokens or private details. */
const ATTEMPT_ID = 'attempt-1';
/** Run ids matching the domain's `LANE_RUN_ID_PATTERN` (`run-` + 26 base32 chars). */
const RUN_A = 'run-01ARZ3X0G2S7B4M9C5D8E3F6HA';
const RUN_B = 'run-01ARZ3X0G2S7B4M9C5D8E3F6HB';

function run(id: string, attemptIds: readonly string[]): LaneRunRecord {
  return { runId: id, attemptIds } as unknown as LaneRunRecord;
}

/** A minimal conduct entry: `laneRunJournalState` reads only kind, runId and state. */
function conduct(runId: string, state: LaneRunStateValue): LaneRunJournalEntryRecord {
  return { kind: 'conduct', runId, state } as unknown as LaneRunJournalEntryRecord;
}

function makeRepo(runs: unknown): Pick<LaneRunRepositoryPort, 'list'> {
  return { list: async () => runs as readonly LaneRunRecord[] };
}

function makeJournal(byRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>): Pick<LaneRunJournalPort, 'listForRun'> {
  return { listForRun: async (runId: string) => byRun.get(runId) ?? [] };
}

function liveJournal(state: LaneRunStateValue): ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]> {
  return new Map([[RUN_A, [conduct(RUN_A, state)]], [RUN_B, [conduct(RUN_B, state)]]]);
}

const NON_TERMINAL_STATES: readonly LaneRunStateValue[] = LANE_RUN_STATES.filter(
  (state) => !(LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state),
);
const TERMINAL_STATES: readonly LaneRunStateValue[] = LANE_RUN_TERMINAL_STATES;

describe('findLiveRunForAttempt', () => {
  it('returns null with no runs', async () => {
    await expect(
      findLiveRunForAttempt(makeRepo([]), makeJournal(new Map()), ATTEMPT_ID),
    ).resolves.toBeNull();
  });

  it('ignores a live run that does not list the attempt and returns null', async () => {
    await expect(
      findLiveRunForAttempt(
        makeRepo([run(RUN_A, ['attempt-other'])]),
        makeJournal(liveJournal('running')),
        ATTEMPT_ID,
      ),
    ).resolves.toBeNull();
  });

  it('returns null for a terminal run listing the attempt', async () => {
    for (const state of TERMINAL_STATES) {
      await expect(
        findLiveRunForAttempt(
          makeRepo([run(RUN_A, [ATTEMPT_ID])]),
          makeJournal(liveJournal(state)),
          ATTEMPT_ID,
        ),
      ).resolves.toBeNull();
    }
  });

  it('returns { runId } for every non-terminal state in LANE_RUN_STATES', async () => {
    for (const state of NON_TERMINAL_STATES) {
      await expect(
        findLiveRunForAttempt(
          makeRepo([run(RUN_A, [ATTEMPT_ID])]),
          makeJournal(liveJournal(state)),
          ATTEMPT_ID,
        ),
      ).resolves.toEqual({ runId: RUN_A });
    }
  });

  it('returns { runId } for a state unknown to LANE_RUN_STATES (never terminal)', async () => {
    // laneRunJournalState only moves on entries it believes; an entry carrying
    // a value outside LANE_RUN_STATES still lands in the computed state.
    const journal = makeJournal(
      new Map([[RUN_A, [conduct(RUN_A, 'not-a-state' as LaneRunStateValue)]]]),
    );
    await expect(
      findLiveRunForAttempt(makeRepo([run(RUN_A, [ATTEMPT_ID])]), journal, ATTEMPT_ID),
    ).resolves.toEqual({ runId: RUN_A });
  });

  it('returns the live run when a terminal run is listed first', async () => {
    await expect(
      findLiveRunForAttempt(
        makeRepo([run(RUN_A, [ATTEMPT_ID]), run(RUN_B, [ATTEMPT_ID])]),
        makeJournal(new Map([[RUN_A, [conduct(RUN_A, 'merged')]], [RUN_B, [conduct(RUN_B, 'running')]]])),
        ATTEMPT_ID,
      ),
    ).resolves.toEqual({ runId: RUN_B });
  });

  it('returns the first live run in list order when two are live', async () => {
    await expect(
      findLiveRunForAttempt(
        makeRepo([run(RUN_A, [ATTEMPT_ID]), run(RUN_B, [ATTEMPT_ID])]),
        makeJournal(new Map([[RUN_A, [conduct(RUN_A, 'running')]], [RUN_B, [conduct(RUN_B, 'gating')]]])),
        ATTEMPT_ID,
      ),
    ).resolves.toEqual({ runId: RUN_A });
  });

  it('propagates a rejection from runRepo.list()', async () => {
    const err = new Error('list refused');
    const repo = { list: () => Promise.reject(err) };
    await expect(findLiveRunForAttempt(repo, makeJournal(new Map()), ATTEMPT_ID)).rejects.toBe(err);
  });

  it('propagates a rejection from runJournal.listForRun()', async () => {
    const err = new Error('journal refused');
    const journal: Pick<LaneRunJournalPort, 'listForRun'> = {
      listForRun: () => Promise.reject(err),
    };
    await expect(
      findLiveRunForAttempt(makeRepo([run(RUN_A, [ATTEMPT_ID])]), journal, ATTEMPT_ID),
    ).rejects.toBe(err);
  });

  it('refuses null, undefined, or malformed repository/journal ports with TypeError', async () => {
    const journal = makeJournal(new Map());
    for (const repo of [null, undefined, 'repo', 7, {}, { list: 'not-a-function' }]) {
      await expect(
        findLiveRunForAttempt(repo as unknown as Pick<LaneRunRepositoryPort, 'list'>, journal, ATTEMPT_ID),
      ).rejects.toBeInstanceOf(TypeError);
    }
    const repo = makeRepo([]);
    for (const bad of [null, undefined, 'journal', 7, {}, { listForRun: 'not-a-function' }]) {
      await expect(
        findLiveRunForAttempt(repo, bad as unknown as Pick<LaneRunJournalPort, 'listForRun'>, ATTEMPT_ID),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('refuses invalid or prototype-polluting attemptId with TypeError', async () => {
    const repo = makeRepo([]);
    const journal = makeJournal(new Map());
    for (const bad of [null, undefined, 7, '', '__proto__', 'constructor', 'prototype']) {
      await expect(
        findLiveRunForAttempt(repo, journal, bad as unknown as string),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('refuses non-array, array-like, sparse hole, getter element, and oversized run list without invoking getters', async () => {
    const journal = makeJournal(new Map());
    // Non-array.
    await expect(
      findLiveRunForAttempt(makeRepo(null), journal, ATTEMPT_ID),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      findLiveRunForAttempt(makeRepo({ length: 1, 0: run(RUN_A, [ATTEMPT_ID]) }), journal, ATTEMPT_ID),
    ).rejects.toBeInstanceOf(TypeError);
    // Sparse hole.
    const sparse: unknown[] = new Array(2);
    sparse[0] = run(RUN_A, [ATTEMPT_ID]);
    await expect(findLiveRunForAttempt(makeRepo(sparse), journal, ATTEMPT_ID)).rejects.toBeInstanceOf(TypeError);
    // Getter element, never invoked: the returned runId would throw if read.
    let getterInvoked = false;
    const withGetter: unknown[] = [];
    Object.defineProperty(withGetter, 0, {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        throw new Error('getter must never run');
      },
    });
    withGetter.length = 1;
    await expect(findLiveRunForAttempt(makeRepo(withGetter), journal, ATTEMPT_ID)).rejects.toBeInstanceOf(TypeError);
    expect(getterInvoked).toBe(false);
    // Oversized.
    const oversized = new Array<unknown>(MAX_LIVE_RUN_SCAN_RUNS + 1).fill(run(RUN_A, []));
    await expect(findLiveRunForAttempt(makeRepo(oversized), journal, ATTEMPT_ID)).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses malformed run record, getter properties, and hostile attemptIds without invoking getters', async () => {
    const journal = makeJournal(new Map());
    const expectTypeRefusal = async (entry: unknown) => {
      await expect(findLiveRunForAttempt(makeRepo([entry]), journal, ATTEMPT_ID)).rejects.toBeInstanceOf(TypeError);
    };
    // Malformed records.
    await expectTypeRefusal(null);
    await expectTypeRefusal(undefined);
    await expectTypeRefusal('run');
    await expectTypeRefusal(7);
    await expectTypeRefusal([RUN_A]);
    await expectTypeRefusal({});
    await expectTypeRefusal(run('__proto__', [ATTEMPT_ID]));
    await expectTypeRefusal(run('constructor', [ATTEMPT_ID]));
    await expectTypeRefusal(run(RUN_A, 'not-an-array' as unknown as string[]));
    await expectTypeRefusal(run(RUN_A, ['ok', 7] as unknown as string[]));
    await expectTypeRefusal(run(RUN_A, ['__proto__']));
    await expectTypeRefusal(run(RUN_A, ['constructor']));
    await expectTypeRefusal(run(RUN_A, ['prototype']));
    // A hole in attemptIds.
    const holed: unknown[] = ['ok'];
    holed.length = 2;
    await expectTypeRefusal(run(RUN_A, holed as unknown as string[]));
    // Oversized attemptIds (a length refusal is a RangeError).
    await expect(
      findLiveRunForAttempt(
        makeRepo([run(RUN_A, new Array<string>(MAX_RUN_ATTEMPT_IDS + 1).fill('ok'))]),
        journal,
        ATTEMPT_ID,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    // Getter on runId — never invoked.
    let runIdGetterInvoked = false;
    const getterRun = {} as Record<string, unknown>;
    Object.defineProperty(getterRun, 'runId', {
      enumerable: true,
      get: () => {
        runIdGetterInvoked = true;
        throw new Error('runId getter must never run');
      },
    });
    getterRun.attemptIds = [ATTEMPT_ID];
    await expectTypeRefusal(getterRun);
    expect(runIdGetterInvoked).toBe(false);
    // Getter on attemptIds — never invoked.
    let attemptIdsGetterInvoked = false;
    const getterAttemptIdsRun = { runId: RUN_A } as Record<string, unknown>;
    Object.defineProperty(getterAttemptIdsRun, 'attemptIds', {
      enumerable: true,
      get: () => {
        attemptIdsGetterInvoked = true;
        throw new Error('attemptIds getter must never run');
      },
    });
    await expectTypeRefusal(getterAttemptIdsRun);
    expect(attemptIdsGetterInvoked).toBe(false);
    // A getter element inside attemptIds — never invoked.
    let elementGetterInvoked = false;
    const getterAttemptIds: unknown[] = [];
    Object.defineProperty(getterAttemptIds, 0, {
      enumerable: true,
      get: () => {
        elementGetterInvoked = true;
        throw new Error('attemptIds element getter must never run');
      },
    });
    getterAttemptIds.length = 1;
    await expectTypeRefusal(run(RUN_A, getterAttemptIds as unknown as string[]));
    expect(elementGetterInvoked).toBe(false);
  });
});
