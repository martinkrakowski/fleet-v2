import { describe, expect, it } from 'vitest';
import { types } from 'node:util';

import type { LaneDeclarationRecord } from '../../../domain/lane-activity-records.js';
import type {
  AppendDeclarationResult,
  DeclarationRepositoryPort,
} from '../../ports/out/DeclarationRepositoryPort.out-port.js';
import { DeclareLaneActivityUseCase } from '../DeclareLaneActivityUseCase.use-case.js';

const LANE = { kind: 'plan', projectId: 'example-project', planId: 'plan-1', laneId: 'lane-1' } as const;

class RecordingDeclarations implements DeclarationRepositoryPort {
  readonly appended: LaneDeclarationRecord[] = [];

  async list(): Promise<readonly LaneDeclarationRecord[]> {
    return [...this.appended];
  }

  async append(record: LaneDeclarationRecord): Promise<AppendDeclarationResult> {
    this.appended.push(record);
    return { outcome: 'saved', revision: this.appended.length };
  }
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lane: LANE, step: 'gate', seatRole: 'builder', model: 'example-model', ...overrides };
}

function makeUseCase(
  declarations: DeclarationRepositoryPort,
  nowIso: () => string,
  ttlMinutes?: number,
): DeclareLaneActivityUseCase {
  return new DeclareLaneActivityUseCase({
    declarations,
    nowIso,
    ttlMinutes,
    isProxy: types.isProxy,
  });
}

describe('DeclareLaneActivityUseCase', () => {
  it('two calls with an advancing clock store two distinct time pairs', async () => {
    const declarations = new RecordingDeclarations();
    let tick = 0;
    const useCase = new DeclareLaneActivityUseCase({
      declarations,
      nowIso: () => (tick++ === 0 ? '2026-10-27T10:00:00.000Z' : '2026-10-27T10:05:00.000Z'),
      isProxy: types.isProxy,
    });

    const first = await useCase.execute(body(), 'operator');
    const second = await useCase.execute(body(), 'operator');

    expect(first.outcome).toBe('declared');
    expect(second.outcome).toBe('declared');
    if (first.outcome !== 'declared' || second.outcome !== 'declared') return;
    expect(first.declaration.declaredAtIso).toBe('2026-10-27T10:00:00.000Z');
    expect(first.lapsesAtIso).toBe('2026-10-27T11:30:00.000Z');
    expect(second.declaration.declaredAtIso).toBe('2026-10-27T10:05:00.000Z');
    expect(second.lapsesAtIso).toBe('2026-10-27T11:35:00.000Z');
    expect(declarations.appended).toHaveLength(2);
  });

  it('a non-canonical clock answers refused/clock and the store receives nothing', async () => {
    const declarations = new RecordingDeclarations();
    const useCase = new DeclareLaneActivityUseCase({ declarations, nowIso: () => 'nope', isProxy: types.isProxy });
    const result = await useCase.execute(body(), 'operator');
    expect(result).toEqual({ outcome: 'refused', code: 'clock', reason: 'the clock returned a non-canonical time' });
    expect(declarations.appended).toHaveLength(0);
  });

  it('absent ttlMinutes lapses at 90 minutes; a passed ttlMinutes is honored', async () => {
    const defaultedDeclarations = new RecordingDeclarations();
    const defaultedUseCase = makeUseCase(defaultedDeclarations, () => '2026-10-27T10:00:00.000Z');
    const shortenedDeclarations = new RecordingDeclarations();
    const shortenedUseCase = makeUseCase(shortenedDeclarations, () => '2026-10-27T10:00:00.000Z', 45);
    const defaulted = await defaultedUseCase.execute(body(), 'operator');
    const shortened = await shortenedUseCase.execute(body(), 'operator');
    if (defaulted.outcome !== 'declared' || shortened.outcome !== 'declared') {
      throw new Error('both declarations should have been saved');
    }
    expect(defaulted.declaration.lapsesAtIso).toBe('2026-10-27T11:30:00.000Z');
    expect(shortened.declaration.lapsesAtIso).toBe('2026-10-27T10:45:00.000Z');
  });

  it('an unknown step answers refused/unknown-step and nothing is stored', async () => {
    const declarations = new RecordingDeclarations();
    const useCase = makeUseCase(declarations, () => '2026-10-27T10:00:00.000Z');
    const result = await useCase.execute(body({ step: 'merge' }), 'operator');
    expect(result).toEqual({ outcome: 'refused', code: 'unknown-step', reason: 'unknown declaration step' });
    expect(declarations.appended).toHaveLength(0);
  });

  it('an unknown outcome answers refused/unknown-outcome and nothing is stored', async () => {
    const declarations = new RecordingDeclarations();
    const useCase = makeUseCase(declarations, () => '2026-10-27T10:00:00.000Z');
    const unknownToken = await useCase.execute(body({ step: 'brief', outcome: 'shipped' }), 'operator');
    expect(unknownToken).toEqual({
      outcome: 'refused',
      code: 'unknown-outcome',
      reason: 'unknown or disallowed declaration outcome',
    });
    const disallowedStep = await useCase.execute(body({ step: 'gate', outcome: 'reviewed' }), 'operator');
    expect(disallowedStep).toEqual({
      outcome: 'refused',
      code: 'unknown-outcome',
      reason: 'unknown or disallowed declaration outcome',
    });
    expect(declarations.appended).toHaveLength(0);
  });

  it('an invalid body is refused with the fixed field error and nothing is stored', async () => {
    const declarations = new RecordingDeclarations();
    const useCase = makeUseCase(declarations, () => '2026-10-27T10:00:00.000Z');
    const result = await useCase.execute({ ...body(), extra: 1 }, 'operator');
    expect(result).toEqual({
      outcome: 'refused',
      code: 'refused',
      reason: 'body must have the keys lane, step, seatRole and model, with an optional outcome',
    });
    expect(declarations.appended).toHaveLength(0);
  });

  it('a Proxy body is refused and nothing is stored', async () => {
    const declarations = new RecordingDeclarations();
    const useCase = makeUseCase(declarations, () => '2026-10-27T10:00:00.000Z');
    const result = await useCase.execute(new Proxy(body(), {}), 'operator');
    expect(result).toEqual({ outcome: 'refused', code: 'refused', reason: 'body must be plain data' });
    expect(declarations.appended).toHaveLength(0);
  });

  it('a declaration with an outcome token is stored with the token', async () => {
    const declarations = new RecordingDeclarations();
    const useCase = makeUseCase(declarations, () => '2026-10-27T10:00:00.000Z');
    const result = await useCase.execute(body({ step: 'brief', outcome: 'reviewed' }), 'operator');
    expect(result.outcome).toBe('declared');
    if (result.outcome !== 'declared') return;
    expect(result.declaration.step).toBe('brief');
    expect(result.declaration.outcome).toBe('reviewed');
  });

  it('a lapsed declaration stays in the store after a new one is appended', async () => {
    const declarations = new RecordingDeclarations();
    let tick = 0;
    const useCase = makeUseCase(
      declarations,
      () => (tick++ === 0 ? '2026-10-27T10:00:00.000Z' : '2026-10-27T12:00:00.000Z'),
    );
    await useCase.execute(body(), 'operator');
    const later = await useCase.execute(body(), 'operator');
    expect(later.outcome).toBe('declared');
    const listed = await declarations.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]!.declaredAtIso).toBe('2026-10-27T10:00:00.000Z');
  });
});
