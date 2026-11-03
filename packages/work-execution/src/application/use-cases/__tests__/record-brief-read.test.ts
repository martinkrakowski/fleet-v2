import { describe, expect, it } from 'vitest';

import type { BriefReadRecord } from '../../../domain/lane-activity-records.js';
import type {
  BriefReadRepositoryPort,
  PutBriefReadResult,
} from '../../ports/out/BriefReadRepositoryPort.out-port.js';
import { RecordBriefReadUseCase } from '../RecordBriefReadUseCase.use-case.js';

const LANE = { kind: 'plan', projectId: 'example-project', planId: 'plan-1', laneId: 'lane-1' } as const;

class RecordingBriefReads implements BriefReadRepositoryPort {
  readonly putRecords: BriefReadRecord[] = [];
  answer: PutBriefReadResult = { outcome: 'saved', revision: 1 };

  async latest(): Promise<BriefReadRecord | null> {
    return this.putRecords[this.putRecords.length - 1] ?? null;
  }

  async put(record: BriefReadRecord): Promise<PutBriefReadResult> {
    this.putRecords.push(record);
    return this.answer;
  }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane: LANE,
    path: 'docs/plans/plan-1/lane-1.brief.md',
    outcome: 'read',
    sha256: 'a'.repeat(64),
    bytes: 42,
    ...overrides,
  };
}

describe('RecordBriefReadUseCase', () => {
  it('records a successful read from the fresh clock', async () => {
    const briefReads = new RecordingBriefReads();
    const useCase = new RecordBriefReadUseCase({ briefReads, nowIso: () => '2026-10-27T10:00:00.000Z' });
    const result = await useCase.execute(body(), 'operator');
    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') return;
    expect(result.read).toEqual({
      version: 1,
      lane: LANE,
      path: 'docs/plans/plan-1/lane-1.brief.md',
      outcome: 'read',
      sha256: 'a'.repeat(64),
      bytes: 42,
      readAtIso: '2026-10-27T10:00:00.000Z',
    });
  });

  it('records a failed read as null digest and byte count, echoing nothing from the body', async () => {
    const briefReads = new RecordingBriefReads();
    const useCase = new RecordBriefReadUseCase({ briefReads, nowIso: () => '2026-10-27T10:00:00.000Z' });
    const result = await useCase.execute(body({ outcome: 'failed', sha256: 'b'.repeat(64), bytes: 9 }), 'operator');
    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') return;
    expect(result.read.sha256).toBeNull();
    expect(result.read.bytes).toBeNull();
    expect(JSON.stringify(result)).not.toContain('b'.repeat(64));
    expect(JSON.stringify(result)).not.toContain('"bytes":9');
  });

  it('a non-canonical clock answers refused/clock and the store receives nothing', async () => {
    const briefReads = new RecordingBriefReads();
    const useCase = new RecordBriefReadUseCase({ briefReads, nowIso: () => 'nope' });
    const result = await useCase.execute(body(), 'operator');
    expect(result).toEqual({ outcome: 'refused', code: 'clock', reason: 'the clock returned a non-canonical time' });
    expect(briefReads.putRecords).toHaveLength(0);
  });

  it('an invalid body is refused with the fixed field error', async () => {
    const briefReads = new RecordingBriefReads();
    const useCase = new RecordBriefReadUseCase({ briefReads, nowIso: () => '2026-10-27T10:00:00.000Z' });
    expect(await useCase.execute(body({ sha256: 'nothex' }), 'operator')).toEqual({
      outcome: 'refused',
      code: 'refused',
      reason: 'invalid sha256',
    });
    expect(briefReads.putRecords).toHaveLength(0);
  });

  it('a store refusal becomes refused/store', async () => {
    const briefReads = new RecordingBriefReads();
    briefReads.answer = { outcome: 'refused', reason: 'store unreadable' };
    const useCase = new RecordBriefReadUseCase({ briefReads, nowIso: () => '2026-10-27T10:00:00.000Z' });
    expect(await useCase.execute(body(), 'operator')).toEqual({
      outcome: 'refused',
      code: 'store',
      reason: 'store unreadable',
    });
  });
});
