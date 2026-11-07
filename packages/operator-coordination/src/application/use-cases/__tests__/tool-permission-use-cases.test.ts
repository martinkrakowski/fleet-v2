/**
 * Lane T2c unit tests for the tool-permission use cases.
 *
 * Every refusal path never throws, the request id is API-issued, the tool
 * input is stored verbatim and never returned, the 540 s explicit deny is
 * bounded and leaves the pending request recorded, and the first verdict wins
 * (same decision unchanged, different decision a conflict). The clock and
 * "now" are always injected where a deadline matters.
 */

import { describe, expect, it } from 'vitest';

import { PermissionRequestRepositoryAdapter } from '../../../infrastructure/adapters/PermissionRequestRepositoryAdapter.adapter.js';
import type {
  PermissionRequestRecord,
  PermissionVerdictRecord,
  ToolPermissionDecision,
} from '../../../domain/entities/PermissionRequest.js';
import type { PermissionRequestRepositoryPort } from '../../ports/out/PermissionRequestRepositoryPort.out-port.js';
import { GiveToolPermissionVerdictUseCase } from '../GiveToolPermissionVerdictUseCase.use-case.js';
import { RequestToolPermissionUseCase } from '../RequestToolPermissionUseCase.use-case.js';

const NOW_ISO = '2026-11-07T12:00:00.000Z';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';

/** A clock the composition root supplies; returns a fixed moment. */
function fixedClock(): { nowIso: () => string } {
  return { nowIso: () => NOW_ISO };
}

/**
 * A "now" that advances far past any small deadline after the first read, so
 * a request that reaches its deadline denies without real waiting.
 */
function advancingNow(start = 1_000_000, step = 1_000_000): () => number {
  let current = start;
  return () => {
    const value = current;
    current += step;
    return value;
  };
}

function pendingRecord(overrides: Partial<PermissionRequestRecord> = {}): PermissionRequestRecord {
  return {
    requestId: 'req-1',
    threadId: 'thread-1',
    toolName: 'bash',
    toolInput: {},
    requestedAtIso: NOW_ISO,
    deadlineAtIso: FUTURE_ISO,
    state: 'pending',
    ...overrides,
  };
}

function requestUseCase(
  repository: PermissionRequestRepositoryPort,
  overrides: Partial<ConstructorParameters<typeof RequestToolPermissionUseCase>[0]> = {},
): RequestToolPermissionUseCase {
  return new RequestToolPermissionUseCase({
    repository,
    deadlineMs: 50,
    pollIntervalMs: 5,
    now: advancingNow(),
    ...overrides,
  });
}

/**
 * A repository that records a verdict as soon as a request is stored, so a
 * waiting request resolves on its very first poll.
 */
class AutoVerdictRepo implements PermissionRequestRepositoryPort {
  private readonly inner = new PermissionRequestRepositoryAdapter();
  constructor(
    private readonly decision: ToolPermissionDecision,
    private readonly actorId = 'owner-1',
  ) {}

  record(request: PermissionRequestRecord): {
    readonly stored: boolean;
    readonly reason?: 'too-many-pending-requests';
  } {
    const result = this.inner.record(request);
    if (result.stored) {
      this.inner.recordVerdict(request.requestId, {
        decision: this.decision,
        actorId: this.actorId,
        decidedAtIso: NOW_ISO,
      });
    }
    return result;
  }

  find(requestId: string): PermissionRequestRecord | undefined {
    return this.inner.find(requestId);
  }

  listPending(): readonly PermissionRequestRecord[] {
    return this.inner.listPending();
  }

  recordVerdict(
    requestId: string,
    verdict: PermissionVerdictRecord,
  ): { readonly outcome: 'recorded' | 'unchanged' | 'conflict' | 'unknown' } {
    return this.inner.recordVerdict(requestId, verdict);
  }
}

/** A repository whose `find` throws once, cutting a wait short after record. */
class FindThrowsOnceRepo implements PermissionRequestRepositoryPort {
  private readonly inner = new PermissionRequestRepositoryAdapter();
  private threw = false;

  record(request: PermissionRequestRecord): {
    readonly stored: boolean;
    readonly reason?: 'too-many-pending-requests';
  } {
    return this.inner.record(request);
  }

  find(requestId: string): PermissionRequestRecord | undefined {
    if (!this.threw) {
      this.threw = true;
      throw new Error('simulated cut-short wait');
    }
    return this.inner.find(requestId);
  }

  listPending(): readonly PermissionRequestRecord[] {
    return this.inner.listPending();
  }

  recordVerdict(
    requestId: string,
    verdict: PermissionVerdictRecord,
  ): { readonly outcome: 'recorded' | 'unchanged' | 'conflict' | 'unknown' } {
    return this.inner.recordVerdict(requestId, verdict);
  }
}

describe('RequestToolPermissionUseCase', () => {
  it('refuses a null body without throwing', async () => {
    const uc = requestUseCase(new PermissionRequestRepositoryAdapter());
    const result = await uc.requestToolPermission(null, 'thread-1');
    expect(result).toEqual({ outcome: 'refused', reason: 'body-not-an-object' });
  });

  it('refuses a non-object body: a primitive, an array and a sparse array', async () => {
    const uc = requestUseCase(new PermissionRequestRepositoryAdapter());
    for (const body of [42, 'a string', true, [], Array(3)]) {
      const result = await uc.requestToolPermission(body, 'thread-1');
      expect(result).toEqual({ outcome: 'refused', reason: 'body-not-an-object' });
    }
  });

  it('refuses a body whose getter throws, without throwing', async () => {
    const uc = requestUseCase(new PermissionRequestRepositoryAdapter());
    const body: Record<string, unknown> = {};
    Object.defineProperty(body, 'tool_name', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const result = await uc.requestToolPermission(body, 'thread-1');
    expect(result).toEqual({ outcome: 'refused', reason: 'body-not-an-object' });
  });

  it('refuses a missing or wrong-typed tool name', async () => {
    const uc = requestUseCase(new PermissionRequestRepositoryAdapter());
    expect(await uc.requestToolPermission({}, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-name-missing',
    });
    expect(await uc.requestToolPermission({ tool_name: 42 }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-name-missing',
    });
    expect(await uc.requestToolPermission({ tool_name: '' }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-name-invalid',
    });
    expect(await uc.requestToolPermission({ tool_name: '   ' }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-name-invalid',
    });
    expect(await uc.requestToolPermission({ tool_name: 'x'.repeat(201) }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-name-invalid',
    });
    expect(await uc.requestToolPermission({ tool_name: 'bash\x00' }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-name-invalid',
    });
  });

  it('refuses a missing tool input, an over-large tool input and a tool input that is not serialisable', async () => {
    const uc = requestUseCase(new PermissionRequestRepositoryAdapter());
    expect(await uc.requestToolPermission({ tool_name: 'bash' }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-input-missing',
    });
    const overLarge = { payload: 'x'.repeat(32769) };
    expect(await uc.requestToolPermission({ tool_name: 'bash', tool_input: overLarge }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-input-too-large',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await uc.requestToolPermission({ tool_name: 'bash', tool_input: cyclic }, 'thread-1')).toEqual({
      outcome: 'refused',
      reason: 'tool-input-not-serialisable',
    });
  });

  it('issues its own request id and ignores an id named in the body', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    const uc = new RequestToolPermissionUseCase({
      repository: repo,
      deadlineMs: 50,
      pollIntervalMs: 5,
      now: advancingNow(),
      idSource: () => 'req-api-issued',
    });
    const result = await uc.requestToolPermission(
      { tool_name: 'bash', tool_input: {}, requestId: 'client-chosen', id: 'other' },
      'thread-1',
    );
    expect(result).toEqual({
      outcome: 'denied',
      requestId: 'req-api-issued',
      reason: 'no-verdict',
      message: 'no verdict in 50 ms',
    });
    expect(repo.find('req-api-issued')).toBeDefined();
    expect(repo.find('client-chosen')).toBeUndefined();
  });

  it('stores the tool input verbatim and never returns it in the outcome', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    const uc = requestUseCase(repo);
    const toolInput = { nested: { arr: [1, 2, 3] }, text: 'verbatim-tool-input' };
    const result = await uc.requestToolPermission(
      { tool_name: 'bash', tool_input: toolInput },
      'thread-1',
    );
    expect(result).not.toHaveProperty('toolInput');
    expect(result).not.toHaveProperty('tool_input');
    expect(JSON.stringify(result)).not.toContain('verbatim-tool-input');
    const pending = repo.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].toolInput).toEqual(toolInput);
  });

  it('denies explicitly when no verdict arrives before the deadline and leaves the request pending', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    const uc = new RequestToolPermissionUseCase({
      repository: repo,
      deadlineMs: 80,
      pollIntervalMs: 5,
      now: advancingNow(),
    });
    const result = await uc.requestToolPermission({ tool_name: 'bash', tool_input: {} }, 'thread-1');
    expect(result).toEqual({
      outcome: 'denied',
      requestId: expect.any(String),
      reason: 'no-verdict',
      message: 'no verdict in 80 ms',
    });
    if (result.outcome !== 'denied') {
      throw new Error('expected a denied outcome');
    }
    const pending = repo.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe(result.requestId);
    expect(pending[0].verdict).toBeUndefined();
  });

  it('returns the owner\u2019s allow once the first verdict arrives', async () => {
    const uc = requestUseCase(new AutoVerdictRepo('allow'));
    const result = await uc.requestToolPermission({ tool_name: 'bash', tool_input: {} }, 'thread-1');
    expect(result).toEqual({ outcome: 'allowed', requestId: expect.any(String) });
  });

  it('refuses a new request when the pending cap is reached', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    for (let i = 0; i < 128; i += 1) {
      expect(repo.record(pendingRecord({ requestId: `pending-${i}` })).stored).toBe(true);
    }
    const uc = requestUseCase(repo);
    const result = await uc.requestToolPermission({ tool_name: 'bash', tool_input: {} }, 'thread-1');
    expect(result).toEqual({ outcome: 'refused', reason: 'too-many-pending-requests' });
  });

  it('the request is recorded before the wait, so a cut-short wait leaves state the next pass can complete', async () => {
    const repo = new FindThrowsOnceRepo();
    // A far-future deadline so the recorded request is not expired when a
    // later pass completes it; the cut-short wait comes from `find` throwing.
    const uc = requestUseCase(repo, { now: () => 4_100_000_000_000 });
    const crashed = await uc.requestToolPermission({ tool_name: 'bash', tool_input: {} }, 'thread-1');
    expect(crashed).toEqual({ outcome: 'refused', reason: 'internal-error' });
    const pending = repo.listPending();
    expect(pending).toHaveLength(1);
    const requestId = pending[0].requestId;
    // The pending record survives the cut-short wait and can be completed by
    // the verdict use case.
    const verdictUc = new GiveToolPermissionVerdictUseCase({
      repository: repo,
      clock: fixedClock(),
    });
    const verdictResult = await verdictUc.giveToolPermissionVerdict(
      { decision: 'allow' },
      requestId,
      'owner',
    );
    expect(verdictResult).toEqual({
      outcome: 'recorded',
      verdict: { decision: 'allow', actorId: 'owner', decidedAtIso: NOW_ISO },
    });
  });
});

describe('GiveToolPermissionVerdictUseCase', () => {
  function verdictUseCase(repository: PermissionRequestRepositoryPort): GiveToolPermissionVerdictUseCase {
    return new GiveToolPermissionVerdictUseCase({ repository, clock: fixedClock() });
  }

  it('the first verdict wins: the same decision again is unchanged and the stored actor is still the first', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    repo.record(pendingRecord());
    const uc = verdictUseCase(repo);
    const first = await uc.giveToolPermissionVerdict({ decision: 'allow' }, 'req-1', 'actor-one');
    expect(first).toEqual({
      outcome: 'recorded',
      verdict: { decision: 'allow', actorId: 'actor-one', decidedAtIso: NOW_ISO },
    });
    const second = await uc.giveToolPermissionVerdict({ decision: 'allow' }, 'req-1', 'actor-two');
    expect(second).toEqual({
      outcome: 'unchanged',
      verdict: { decision: 'allow', actorId: 'actor-one', decidedAtIso: NOW_ISO },
    });
    expect(repo.find('req-1')?.verdict).toEqual({
      decision: 'allow',
      actorId: 'actor-one',
      decidedAtIso: NOW_ISO,
    });
  });

  it('a different second decision is a conflict and the stored verdict is still the first', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    repo.record(pendingRecord());
    const uc = verdictUseCase(repo);
    await uc.giveToolPermissionVerdict({ decision: 'allow' }, 'req-1', 'actor-one');
    const conflict = await uc.giveToolPermissionVerdict({ decision: 'deny' }, 'req-1', 'actor-two');
    expect(conflict).toEqual({
      outcome: 'conflict',
      verdict: { decision: 'allow', actorId: 'actor-one', decidedAtIso: NOW_ISO },
    });
    expect(repo.find('req-1')?.verdict).toEqual({
      decision: 'allow',
      actorId: 'actor-one',
      decidedAtIso: NOW_ISO,
    });
  });

  it('a verdict for an unknown request id is unknown, never allowed', async () => {
    const uc = verdictUseCase(new PermissionRequestRepositoryAdapter());
    const result = await uc.giveToolPermissionVerdict({ decision: 'allow' }, 'no-such', 'actor');
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('a verdict after the deadline is expired, never allowed', async () => {
    const repo = new PermissionRequestRepositoryAdapter();
    repo.record(
      pendingRecord({ requestId: 'req-expired', deadlineAtIso: '2020-01-01T00:00:00.000Z' }),
    );
    const uc = new GiveToolPermissionVerdictUseCase({
      repository: repo,
      clock: fixedClock(),
      now: () => Date.now(),
    });
    const result = await uc.giveToolPermissionVerdict({ decision: 'allow' }, 'req-expired', 'actor');
    expect(result).toEqual({ outcome: 'expired' });
    expect(repo.find('req-expired')?.verdict).toBeUndefined();
  });
});
