// Implemented for lane D4 (decision port plan, 2026-10-16).
/**
 * FileDecisionReceiptJournalAdapter implements DecisionReceiptJournalPort
 * (local-jsonl-receipt-journal): one append-only JSONL file per UTC month at
 * `<stateDir>/decision-receipts/<YYYY-MM>.jsonl`, never under the signed
 * owner-decision inbox `<stateDir>/decisions/`. Every append and every
 * read-then-append runs under the brief-knowledge `withFileLock`. A malformed
 * line throws (fail closed): spend is never understated or silently skipped.
 * Settling is once only per reservation id, so spend is monotone there.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  DecisionCallReceipt,
  DecisionReceiptJournalPort,
  ReserveDecisionQuery,
  ReserveDecisionResult,
} from '../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import { withFileLock } from './file-store.js';

/** Own receipts directory; distinct from the owner-decision inbox `decisions/`. */
const RECEIPTS_DIRNAME = 'decision-receipts';

/** A stateSha256 is always a lowercase hex SHA-256 digest. */
const STATE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Appended before a call: `{kind:'reserved', id, assumedCostUsd, stateSha256, at}`. */
interface ReservedEntry {
  readonly kind: 'reserved';
  readonly id: string;
  readonly assumedCostUsd: number;
  readonly stateSha256: string;
  readonly at: string;
}

/** Appended after a call: `{kind:'settled', reservationId, ...receipt}` with the cost resolved. */
interface SettledEntry {
  readonly kind: 'settled';
  readonly reservationId: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly costUsd: number;
  readonly estimated: boolean;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
  readonly unknownReason?: string;
  readonly at: string;
}

type JournalEntry = ReservedEntry | SettledEntry;

export class MalformedReceiptLineError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;

  constructor(filePath: string, lineNumber: number, detail: string) {
    super(`Malformed decision receipt line at ${filePath}:${lineNumber}: ${detail}`);
    this.name = 'MalformedReceiptLineError';
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `YYYY-MM` for the UTC month containing `date`; never a local month. */
function utcMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` for the UTC month before the one containing `date`. */
function previousUtcMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** Location of a JSONL line, for fail-closed error reporting. */
interface ParseContext {
  readonly filePath: string;
  readonly lineNumber: number;
}

/** A malformed line always throws; spend is never computed from skipped input. */
function malformed(context: ParseContext, detail: string): never {
  throw new MalformedReceiptLineError(context.filePath, context.lineNumber, detail);
}

function requireNonEmptyString(context: ParseContext, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    malformed(context, `${field} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeNumber(context: ParseContext, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    malformed(context, `${field} must be a finite non-negative number`);
  }
  return value;
}

function requireStringArray(context: ParseContext, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    malformed(context, `${field} must be an array of strings`);
  }
  return [...value];
}

function requireStateSha256(context: ParseContext, value: unknown): string {
  if (typeof value !== 'string' || !STATE_SHA256_PATTERN.test(value)) {
    malformed(context, 'stateSha256 must match /^[0-9a-f]{64}$/');
  }
  return value;
}

function parseEntry(line: string, filePath: string, lineNumber: number): JournalEntry {
  const context: ParseContext = { filePath, lineNumber };
  if (line.trim().length === 0) {
    malformed(context, 'blank line');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    malformed(context, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(context, 'entry is not a JSON object');
  }
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'reserved') {
    return {
      kind: 'reserved',
      id: requireNonEmptyString(context, entry.id, 'id'),
      assumedCostUsd: requireNonNegativeNumber(context, entry.assumedCostUsd, 'assumedCostUsd'),
      stateSha256: requireStateSha256(context, entry.stateSha256),
      at: requireNonEmptyString(context, entry.at, 'at'),
    };
  }
  if (entry.kind === 'settled') {
    return {
      kind: 'settled',
      reservationId: requireNonEmptyString(context, entry.reservationId, 'reservationId'),
      provider: requireNonEmptyString(context, entry.provider, 'provider'),
      model: requireNonEmptyString(context, entry.model, 'model'),
      requestId:
        entry.requestId === undefined
          ? undefined
          : requireNonEmptyString(context, entry.requestId, 'requestId'),
      costUsd: requireNonNegativeNumber(context, entry.costUsd, 'costUsd'),
      estimated:
        typeof entry.estimated === 'boolean'
          ? entry.estimated
          : malformed(context, 'estimated must be a boolean'),
      lexicalOrder: requireStringArray(context, entry.lexicalOrder, 'lexicalOrder'),
      decidedOrder: requireStringArray(context, entry.decidedOrder, 'decidedOrder'),
      unknownReason:
        entry.unknownReason === undefined
          ? undefined
          : requireNonEmptyString(context, entry.unknownReason, 'unknownReason'),
      at: requireNonEmptyString(context, entry.at, 'at'),
    };
  }
  malformed(context, `unknown kind ${JSON.stringify(entry.kind)}`);
}

/**
 * Month-to-date spend: the settled cost where a settled entry exists for a
 * reservation id, otherwise the reserved assumed cost. A settled entry whose
 * reservation lives in an earlier month's file still counts here, so a paid
 * call is never invisible to the budget.
 */
function monthSpendFromEntries(entries: readonly JournalEntry[]): number {
  const reservedCostById = new Map<string, number>();
  const settledCostByReservationId = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'reserved') {
      reservedCostById.set(entry.id, entry.assumedCostUsd);
    } else {
      settledCostByReservationId.set(entry.reservationId, entry.costUsd);
    }
  }
  let sum = 0;
  for (const [id, assumedCostUsd] of reservedCostById) {
    sum += settledCostByReservationId.get(id) ?? assumedCostUsd;
  }
  for (const [id, costUsd] of settledCostByReservationId) {
    if (!reservedCostById.has(id)) {
      sum += costUsd;
    }
  }
  return sum;
}

function requireValidatedQuery(query: ReserveDecisionQuery): {
  assumedCostUsd: number;
  monthlyBudgetUsd: number;
  stateSha256: string;
} {
  if (!query || typeof query !== 'object') {
    throw new Error('FileDecisionReceiptJournalAdapter requires a reserve query');
  }
  const { assumedCostUsd, monthlyBudgetUsd, stateSha256 } = query;
  if (typeof assumedCostUsd !== 'number' || !Number.isFinite(assumedCostUsd) || assumedCostUsd < 0) {
    throw new Error('FileDecisionReceiptJournalAdapter requires a finite non-negative assumedCostUsd');
  }
  if (
    typeof monthlyBudgetUsd !== 'number' ||
    !Number.isFinite(monthlyBudgetUsd) ||
    monthlyBudgetUsd < 0
  ) {
    throw new Error('FileDecisionReceiptJournalAdapter requires a finite non-negative monthlyBudgetUsd');
  }
  if (typeof stateSha256 !== 'string' || !STATE_SHA256_PATTERN.test(stateSha256)) {
    throw new Error(
      'FileDecisionReceiptJournalAdapter requires stateSha256 to match /^[0-9a-f]{64}$/',
    );
  }
  return { assumedCostUsd, monthlyBudgetUsd, stateSha256 };
}

/** A caller receipt with its declared fields validated; `costUsd` stays optional. */
interface ValidatedReceipt {
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly costUsd?: number;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
  readonly unknownReason?: string;
}

function requireValidatedReceipt(
  reservationId: string,
  receipt: DecisionCallReceipt,
): ValidatedReceipt {
  if (typeof reservationId !== 'string' || reservationId.trim().length === 0) {
    throw new Error('FileDecisionReceiptJournalAdapter requires a non-empty reservationId');
  }
  if (!receipt || typeof receipt !== 'object') {
    throw new Error(`FileDecisionReceiptJournalAdapter requires a receipt for reservation ${reservationId}`);
  }
  const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`FileDecisionReceiptJournalAdapter requires a non-empty ${field}`);
    }
    return value;
  };
  const failField = (detail: string): never => {
    throw new Error(`FileDecisionReceiptJournalAdapter ${detail}`);
  };
  const optionalText = (value: unknown, field: string): string | undefined =>
    value === undefined ? undefined : requireText(value, field);
  const optionalCost =
    receipt.costUsd === undefined
      ? undefined
      : typeof receipt.costUsd === 'number' && Number.isFinite(receipt.costUsd) && receipt.costUsd >= 0
        ? receipt.costUsd
        : failField('costUsd must be a finite non-negative number');
  const requireIds = (value: readonly string[], field: string): readonly string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`FileDecisionReceiptJournalAdapter requires ${field} to be an array of strings`);
    }
    return value;
  };
  return {
    provider: requireText(receipt.provider, 'provider'),
    model: requireText(receipt.model, 'model'),
    requestId: optionalText(receipt.requestId, 'requestId'),
    costUsd: optionalCost,
    lexicalOrder: requireIds(receipt.lexicalOrder, 'lexicalOrder'),
    decidedOrder: requireIds(receipt.decidedOrder, 'decidedOrder'),
    unknownReason: optionalText(receipt.unknownReason, 'unknownReason'),
  };
}

export class FileDecisionReceiptJournalAdapter implements DecisionReceiptJournalPort {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number | undefined;

  constructor(
    stateDir: string,
    now: () => Date = () => new Date(),
    options: { readonly lockTimeoutMs?: number } = {},
  ) {
    if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
      throw new Error('FileDecisionReceiptJournalAdapter requires a non-empty stateDir');
    }
    if (typeof now !== 'function') {
      throw new Error('FileDecisionReceiptJournalAdapter requires a now() clock');
    }
    if (
      options.lockTimeoutMs !== undefined &&
      (typeof options.lockTimeoutMs !== 'number' ||
        !Number.isFinite(options.lockTimeoutMs) ||
        options.lockTimeoutMs <= 0)
    ) {
      throw new Error('FileDecisionReceiptJournalAdapter requires a positive finite lockTimeoutMs');
    }
    this.stateDir = stateDir;
    this.now = now;
    // undefined keeps withFileLock's own default timeout.
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  private lockOptions(): { readonly timeoutMs: number } | undefined {
    return this.lockTimeoutMs === undefined ? undefined : { timeoutMs: this.lockTimeoutMs };
  }

  async reserve(query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    const { assumedCostUsd, monthlyBudgetUsd, stateSha256 } = requireValidatedQuery(query);
    const atDate = this.now();
    const monthKey = utcMonthKey(atDate);
    const reservationId = randomUUID();
    return withFileLock(
      this.monthLockPath(monthKey),
      async () => {
        const entries = await this.readMonthEntries(monthKey);
        const monthSpend = monthSpendFromEntries(entries);
        // Refuse at or above the cap (owner, 2026-10-16): spend never reaches the budget exactly.
        if (monthSpend + assumedCostUsd >= monthlyBudgetUsd) {
          return { ok: false as const, reason: 'budget-exhausted' as const };
        }
        const entry: ReservedEntry = {
          kind: 'reserved',
          id: reservationId,
          assumedCostUsd,
          stateSha256,
          at: atDate.toISOString(),
        };
        await this.appendEntry(monthKey, entry);
        return { ok: true as const, reservationId };
      },
      this.lockOptions(),
    );
  }

  async settle(reservationId: string, receipt: DecisionCallReceipt): Promise<void> {
    const validated = requireValidatedReceipt(reservationId, receipt);
    const atDate = this.now();
    const monthKey = utcMonthKey(atDate);
    await withFileLock(
      this.monthLockPath(monthKey),
      async () => {
      // The reservation is always resolved, whether or not the receipt
      // reports a cost: the current month's file first, then the previous
      // month's (a call may cross a UTC month boundary between reserve and
      // settle).
      const monthEntries = await this.readMonthEntries(monthKey);
      let previousEntries: JournalEntry[] = [];
      let reservation: ReservedEntry | undefined = findReservedEntry(monthEntries, reservationId);
      if (!reservation) {
        previousEntries = await this.readMonthEntries(previousUtcMonthKey(atDate));
        reservation = findReservedEntry(previousEntries, reservationId);
      }
      if (!reservation) {
        throw new Error(
          `FileDecisionReceiptJournalAdapter cannot settle unknown reservation ${reservationId}`,
        );
      }
      // Settling is once only: spend stays monotone per reservation.
      if (
        findSettledEntry(monthEntries, reservationId) !== undefined ||
        findSettledEntry(previousEntries, reservationId) !== undefined
      ) {
        throw new Error(
          `FileDecisionReceiptJournalAdapter reservation ${reservationId} is already settled`,
        );
      }
      // No reported cost: record the reservation's assumed cost, marked
      // estimated. The check-and-append above runs inside this month's lock.
      const costUsd = validated.costUsd ?? reservation.assumedCostUsd;
      const estimated = validated.costUsd === undefined;
      const entry: SettledEntry = {
        kind: 'settled',
        reservationId,
        provider: validated.provider,
        model: validated.model,
        requestId: validated.requestId,
        costUsd,
        estimated,
        lexicalOrder: [...validated.lexicalOrder],
        decidedOrder: [...validated.decidedOrder],
        unknownReason: validated.unknownReason,
        at: atDate.toISOString(),
      };
      await this.appendEntry(monthKey, entry);
      },
      this.lockOptions(),
    );
  }

  async monthSpendUsd(monthUtc: Date): Promise<number> {
    if (!(monthUtc instanceof Date) || Number.isNaN(monthUtc.getTime())) {
      throw new Error('FileDecisionReceiptJournalAdapter requires a valid monthUtc Date');
    }
    const monthKey = utcMonthKey(monthUtc);
    // Lock the pure read too: a concurrent append must never be observed as a
    // torn (malformed) line, and malformed lines fail closed.
    return withFileLock(
      this.monthLockPath(monthKey),
      async () => {
        const entries = await this.readMonthEntries(monthKey);
        return monthSpendFromEntries(entries);
      },
      this.lockOptions(),
    );
  }

  /** `<stateDir>/decision-receipts/<YYYY-MM>.jsonl` — never the owner-decision inbox. */
  private monthFilePath(monthKey: string): string {
    return path.join(this.stateDir, RECEIPTS_DIRNAME, `${monthKey}.jsonl`);
  }

  private monthLockPath(monthKey: string): string {
    return `${this.monthFilePath(monthKey)}.lock`;
  }

  private async readMonthEntries(monthKey: string): Promise<JournalEntry[]> {
    const filePath = this.monthFilePath(monthKey);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const lines = raw.split('\n');
    // A single trailing '' is the file's final newline, not a blank line.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.map((line, index) => parseEntry(line, filePath, index + 1));
  }

  private async appendEntry(monthKey: string, entry: JournalEntry): Promise<void> {
    // The receipts directory exists by the time this runs: acquiring the lock
    // creates it (withFileLock mkdirs the lock file's directory).
    await fs.appendFile(this.monthFilePath(monthKey), `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

function findReservedEntry(
  entries: readonly JournalEntry[],
  reservationId: string,
): ReservedEntry | undefined {
  let found: ReservedEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === 'reserved' && entry.id === reservationId) {
      found = entry;
    }
  }
  return found;
}

function findSettledEntry(
  entries: readonly JournalEntry[],
  reservationId: string,
): SettledEntry | undefined {
  let found: SettledEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === 'settled' && entry.reservationId === reservationId) {
      found = entry;
    }
  }
  return found;
}
