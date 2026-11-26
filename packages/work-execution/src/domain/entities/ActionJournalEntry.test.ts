import { describe, expect, it } from 'vitest';
import { ActionJournalEntry } from './ActionJournalEntry.js';
import type { ActionJournalEntryRecord } from '../execution-records.js';

const TOKEN = 'ghp_' + 'a'.repeat(36);

function recordWithAction(action: unknown): ActionJournalEntryRecord {
  return {
    id: 'j1',
    attemptId: 'a1',
    workOrderId: 'w1',
    baseCommit: 'abc',
    recordedAtIso: '2026-01-01T00:00:00Z',
    action,
    status: 'intent-recorded',
  } as unknown as ActionJournalEntryRecord;
}

function recordWithStatus(status: unknown): ActionJournalEntryRecord {
  return {
    id: 'j1',
    attemptId: 'a1',
    workOrderId: 'w1',
    baseCommit: 'abc',
    recordedAtIso: '2026-01-01T00:00:00Z',
    action: 'dispatch',
    status,
  } as unknown as ActionJournalEntryRecord;
}

function actionMessage(action: unknown): string {
  try {
    ActionJournalEntry.fromRecord(recordWithAction(action));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected ActionJournalEntry.fromRecord to throw');
}

function statusMessage(status: unknown): string {
  try {
    ActionJournalEntry.fromRecord(recordWithStatus(status));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected ActionJournalEntry.fromRecord to throw');
}

describe('ActionJournalEntry.fromRecord refuses an invalid action without echoing it', () => {
  it('refuses a throwing-toString/valueOf action without invoking either, as <object>', () => {
    let calls = 0;
    const hostile = {
      toString() {
        calls += 1;
        throw new Error('toString ran');
      },
      valueOf() {
        calls += 1;
        throw new Error('valueOf ran');
      },
    };
    expect(actionMessage(hostile)).toBe('ActionJournalEntry has an invalid action: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy action as <object>', () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        get: () => (calls++, undefined),
        has: () => (calls++, false),
        ownKeys: () => (calls++, []),
        getPrototypeOf: () => (calls++, null),
        getOwnPropertyDescriptor: () => (calls++, undefined),
      },
    );
    expect(actionMessage(proxy)).toBe('ActionJournalEntry has an invalid action: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string action without echoing it, as <string>', () => {
    const message = actionMessage(TOKEN);
    expect(message).toBe('ActionJournalEntry has an invalid action: <string>');
    expect(message).not.toContain('ghp_');
  });
});

describe('ActionJournalEntry.fromRecord refuses an invalid status without echoing it', () => {
  it('refuses a throwing-toString/valueOf status without invoking either, as <object>', () => {
    let calls = 0;
    const hostile = {
      toString() {
        calls += 1;
        throw new Error('toString ran');
      },
      valueOf() {
        calls += 1;
        throw new Error('valueOf ran');
      },
    };
    expect(statusMessage(hostile)).toBe('ActionJournalEntry has an invalid status: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a throwing-trap Proxy status as <object>', () => {
    let calls = 0;
    const proxy = new Proxy(
      {},
      {
        get: () => (calls++, undefined),
        has: () => (calls++, false),
        ownKeys: () => (calls++, []),
        getPrototypeOf: () => (calls++, null),
        getOwnPropertyDescriptor: () => (calls++, undefined),
      },
    );
    expect(statusMessage(proxy)).toBe('ActionJournalEntry has an invalid status: <object>');
    expect(calls).toBe(0);
  });

  it('refuses a token-shaped string status without echoing it, as <string>', () => {
    const message = statusMessage(TOKEN);
    expect(message).toBe('ActionJournalEntry has an invalid status: <string>');
    expect(message).not.toContain('ghp_');
  });
});
