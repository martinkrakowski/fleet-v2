// Lane D4 (decision port plan, 2026-10-16): receipt journal file adapter and
// budget ledger. Costs use binary-exact values (0.25, 0.5, 0.75, 1) so the
// budget comparisons never depend on floating-point rounding.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileDecisionReceiptJournalAdapter,
  MalformedReceiptLineError,
} from './FileDecisionReceiptJournalAdapter.adapter.js';
import { NotConfiguredReceiptJournal } from './NotConfiguredReceiptJournal.adapter.js';

/** The JSONL line shapes, as written by the adapter. */
interface ReservedLine {
  kind: 'reserved';
  id: string;
  assumedCostUsd: number;
  stateSha256: string;
  at: string;
}

interface SettledLine {
  kind: 'settled';
  reservationId: string;
  provider: string;
  model: string;
  requestId?: string;
  costUsd: number;
  estimated: boolean;
  lexicalOrder: string[];
  decidedOrder: string[];
  unknownReason?: string;
  at: string;
}

type JournalLine = ReservedLine | SettledLine;

async function readJournalLines(stateDir: string, month: string): Promise<JournalLine[]> {
  const raw = await fs.readFile(path.join(stateDir, 'decision-receipts', `${month}.jsonl`), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalLine);
}

describe('FileDecisionReceiptJournalAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-d4-receipts-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reserves below and exactly at budget and refuses above it', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );

    const below = await adapter.reserve({
      assumedCostUsd: 0.25,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha-below',
    });
    expect(below).toEqual({ ok: true, reservationId: expect.any(String) });

    const at = await adapter.reserve({
      assumedCostUsd: 0.75,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha-at',
    });
    expect(at.ok).toBe(true);

    const over = await adapter.reserve({
      assumedCostUsd: 0.25,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha-over',
    });
    expect(over).toEqual({ ok: false, reason: 'budget-exhausted' });

    // Only the two accepted reservations were appended; spend is unchanged.
    expect(await adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).toBe(1);
    const lines = await readJournalLines(tempDir, '2026-01');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.kind === 'reserved')).toBe(true);
  });

  it('lets a settled cost replace the reserved assumed cost in the budget ledger', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    const reserved = await adapter.reserve({
      assumedCostUsd: 0.5,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha',
    });
    if (!reserved.ok) throw new Error('reserve below budget must succeed');

    await adapter.settle(reserved.reservationId, {
      provider: 'jev',
      model: 'typesafe/jev-1.14',
      costUsd: 0.125,
      lexicalOrder: ['bk-1', 'bk-2'],
      decidedOrder: ['bk-2', 'bk-1'],
    });
    expect(await adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).toBe(0.125);

    // The settled cost freed budget: 0.125 + 0.875 = exactly 1 is allowed…
    const at = await adapter.reserve({ assumedCostUsd: 0.875, monthlyBudgetUsd: 1, stateSha256: 'sha' });
    expect(at.ok).toBe(true);
    // …and anything more is refused.
    const over = await adapter.reserve({ assumedCostUsd: 0.1, monthlyBudgetUsd: 1, stateSha256: 'sha' });
    expect(over).toEqual({ ok: false, reason: 'budget-exhausted' });
  });

  it('keeps the assumed cost and marks estimated when the receipt has no cost', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    const reserved = await adapter.reserve({
      assumedCostUsd: 0.5,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha',
    });
    if (!reserved.ok) throw new Error('reserve below budget must succeed');

    await adapter.settle(reserved.reservationId, {
      provider: 'jev',
      model: 'typesafe/jev-1.14',
      lexicalOrder: ['bk-1'],
      decidedOrder: ['bk-1'],
      unknownReason: 'timeout',
    });

    const lines = await readJournalLines(tempDir, '2026-01');
    expect(lines).toHaveLength(2);
    const settled = lines[1] as SettledLine;
    expect(settled.reservationId).toBe(reserved.reservationId);
    expect(settled.costUsd).toBe(0.5);
    expect(settled.estimated).toBe(true);
    expect(settled.unknownReason).toBe('timeout');
    expect(await adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).toBe(0.5);

    // A receipt that does report its cost is recorded with estimated: false.
    const second = await adapter.reserve({
      assumedCostUsd: 0.25,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha-2',
    });
    if (!second.ok) throw new Error('reserve below budget must succeed');
    await adapter.settle(second.reservationId, {
      provider: 'jev',
      model: 'typesafe/jev-1.14',
      costUsd: 0.125,
      lexicalOrder: ['bk-1'],
      decidedOrder: ['bk-1'],
    });
    const after = await readJournalLines(tempDir, '2026-01');
    const settledSecond = after[3] as SettledLine;
    expect(settledSecond.estimated).toBe(false);
    expect(settledSecond.costUsd).toBe(0.125);
  });

  it('keys months on UTC, so 23:30 on the last day stays in that UTC month', async () => {
    // A host running UTC+2 whose local clock reads 2026-01-31 23:30 (or even
    // 2026-02-01 00:30 local, i.e. 2026-01-31T22:30Z) is still inside UTC
    // January: the journal uses UTC getters only, never the local month.
    const lateJanuary = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-31T23:30:00.000Z'),
    );
    const beforeBoundary = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-31T22:30:00.000Z'),
    );

    const reserved = await lateJanuary.reserve({
      assumedCostUsd: 0.25,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha',
    });
    if (!reserved.ok) throw new Error('reserve must succeed');
    const reservedEarlier = await beforeBoundary.reserve({
      assumedCostUsd: 0.25,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha',
    });
    if (!reservedEarlier.ok) throw new Error('reserve must succeed');
    await lateJanuary.settle(reserved.reservationId, {
      provider: 'jev',
      model: 'typesafe/jev-1.14',
      costUsd: 0.125,
      lexicalOrder: ['bk-1'],
      decidedOrder: ['bk-1'],
    });
    await beforeBoundary.settle(reservedEarlier.reservationId, {
      provider: 'jev',
      model: 'typesafe/jev-1.14',
      lexicalOrder: ['bk-1'],
      decidedOrder: ['bk-1'],
    });

    const januaryPath = path.join(tempDir, 'decision-receipts', '2026-01.jsonl');
    await expect(fs.access(januaryPath)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempDir, 'decision-receipts', '2026-02.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readJournalLines(tempDir, '2026-01')).toHaveLength(4);

    // The next UTC month starts a fresh file and a fresh budget.
    const february = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-02-01T00:30:00.000Z'),
    );
    await february.reserve({ assumedCostUsd: 0.25, monthlyBudgetUsd: 1, stateSha256: 'sha' });
    expect(await readJournalLines(tempDir, '2026-02')).toHaveLength(1);
    expect(await february.monthSpendUsd(new Date('2026-02-15T00:00:00.000Z'))).toBe(0.25);
    // January: settled 0.125 (replaces its 0.25 reservation) + estimated 0.25.
    expect(await february.monthSpendUsd(new Date('2026-01-15T00:00:00.000Z'))).toBe(0.375);
  });

  it('throws on a corrupt line instead of skipping it, and preserves the file', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    await adapter.reserve({ assumedCostUsd: 0.25, monthlyBudgetUsd: 1, stateSha256: 'sha' });
    const filePath = path.join(tempDir, 'decision-receipts', '2026-01.jsonl');

    await fs.appendFile(filePath, '{"kind":"reser\n');
    const corrupted = await fs.readFile(filePath, 'utf8');

    await expect(adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).rejects.toThrow(
      MalformedReceiptLineError,
    );
    await expect(
      adapter.reserve({ assumedCostUsd: 0.25, monthlyBudgetUsd: 1, stateSha256: 'sha' }),
    ).rejects.toThrow(MalformedReceiptLineError);

    // The refused reserve appended nothing to the corrupt file.
    expect(await fs.readFile(filePath, 'utf8')).toBe(corrupted);
  });

  it('lets only one of two concurrent reserves succeed at the budget edge', async () => {
    const clock = () => new Date('2026-03-15T10:00:00.000Z');
    const adapterA = new FileDecisionReceiptJournalAdapter(tempDir, clock);
    const adapterB = new FileDecisionReceiptJournalAdapter(tempDir, clock);
    const query = {
      assumedCostUsd: 0.5,
      monthlyBudgetUsd: 0.5,
      stateSha256: 'sha',
    } as const;

    const results = await Promise.all([adapterA.reserve(query), adapterB.reserve(query)]);
    const accepted = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(1);
    expect(refused).toEqual([{ ok: false, reason: 'budget-exhausted' }]);

    expect(await adapterA.monthSpendUsd(new Date('2026-03-20T00:00:00.000Z'))).toBe(0.5);
    expect(await readJournalLines(tempDir, '2026-03')).toHaveLength(1);
  });

  it('never writes under the owner-decision inbox decisions/', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    const reserved = await adapter.reserve({
      assumedCostUsd: 0.25,
      monthlyBudgetUsd: 1,
      stateSha256: 'sha',
    });
    if (!reserved.ok) throw new Error('reserve must succeed');
    await adapter.settle(reserved.reservationId, {
      provider: 'jev',
      model: 'typesafe/jev-1.14',
      costUsd: 0.125,
      lexicalOrder: ['bk-1'],
      decidedOrder: ['bk-1'],
    });

    const created = await fs.readdir(tempDir, { recursive: true });
    expect(created.length).toBeGreaterThan(0);
    for (const entry of created) {
      expect(entry.split(path.sep)[0]).toBe('decision-receipts');
    }
    await expect(
      fs.access(path.join(tempDir, 'decision-receipts', '2026-01.jsonl')),
    ).resolves.toBeUndefined();
  });

  it('reports zero spend for a month with no journal file', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    expect(await adapter.monthSpendUsd(new Date('2026-03-01T00:00:00.000Z'))).toBe(0);
  });

  it('counts a settled entry whose reservation lives outside the month file', async () => {
    // Hand-written orphan settled line: a paid call is never invisible.
    const filePath = path.join(tempDir, 'decision-receipts', '2026-01.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        kind: 'settled',
        reservationId: 'orphan',
        provider: 'jev',
        model: 'typesafe/jev-1.14',
        costUsd: 0.25,
        estimated: false,
        lexicalOrder: ['bk-1'],
        decidedOrder: ['bk-1'],
        at: '2026-01-02T00:00:00.000Z',
      })}\n`,
      'utf8',
    );
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    expect(await adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).toBe(0.25);
  });

  it('refuses to settle a reservation it never reserved', async () => {
    const adapter = new FileDecisionReceiptJournalAdapter(
      tempDir,
      () => new Date('2026-01-15T10:00:00.000Z'),
    );
    await expect(
      adapter.settle('no-such-reservation', {
        provider: 'jev',
        model: 'typesafe/jev-1.14',
        lexicalOrder: ['bk-1'],
        decidedOrder: ['bk-1'],
      }),
    ).rejects.toThrow(/unknown reservation/);
  });
});

describe('NotConfiguredReceiptJournal', () => {
  it('refuses every reservation with not-configured and reports zero spend', async () => {
    const journal = new NotConfiguredReceiptJournal();
    expect(
      await journal.reserve({ assumedCostUsd: 0.25, monthlyBudgetUsd: 1, stateSha256: 'sha' }),
    ).toEqual({ ok: false, reason: 'not-configured' });
    expect(await journal.monthSpendUsd(new Date('2026-01-15T00:00:00.000Z'))).toBe(0);
    await expect(
      journal.settle('any', {
        provider: 'jev',
        model: 'typesafe/jev-1.14',
        lexicalOrder: ['bk-1'],
        decidedOrder: ['bk-1'],
      }),
    ).rejects.toThrow(/not configured/);
  });
});
