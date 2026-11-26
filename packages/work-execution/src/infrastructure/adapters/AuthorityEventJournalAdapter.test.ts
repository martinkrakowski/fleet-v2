import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StopAuthorityEvent } from '../../domain/authority-event-mapping.js';
import { AuthorityEventJournalAdapter } from './AuthorityEventJournalAdapter.adapter.js';

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});

afterEach(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-authority-events-'));
  dirs.push(dir);
  return dir;
}

let ulidCounter = 0;

/** A REQUEST_ID_PATTERN-conformant ULID-shaped value, built at runtime. */
function nextUlid(): string {
  ulidCounter += 1;
  return `0${String(ulidCounter).padStart(25, '0')}`;
}

/** A well-formed stop event with a unique event id, built at runtime. */
function stopEvent(eventId?: string): StopAuthorityEvent {
  return {
    eventId: eventId ?? `stop:run-${nextUlid()}/stop@cli`,
    kind: 'stop',
    actor: 'op.cli',
    organizationId: null,
    atIso: '2026-11-26T08:30:00Z',
    beforeRevision: null,
    afterRevision: null,
  };
}

describe('AuthorityEventJournalAdapter', () => {
  it('appends one JSONL line per recorded event and answers recorded', async () => {
    const stateDir = await tempStateDir();
    const journal = new AuthorityEventJournalAdapter({ stateDir });
    const event = stopEvent();
    await expect(journal.record(event)).resolves.toEqual({ outcome: 'recorded' });
    const content = await fs.readFile(path.join(stateDir, 'authority-events.jsonl'), 'utf8');
    const lines = content.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual(event);
  });

  it('is idempotent on eventId: a repeat writes nothing and answers recorded again', async () => {
    const stateDir = await tempStateDir();
    const journal = new AuthorityEventJournalAdapter({ stateDir });
    const event = stopEvent();
    await expect(journal.record(event)).resolves.toEqual({ outcome: 'recorded' });
    await expect(journal.record(event)).resolves.toEqual({ outcome: 'recorded' });
    // A fresh adapter over the same store dedups across processes too.
    const reopened = new AuthorityEventJournalAdapter({ stateDir });
    await expect(reopened.record(event)).resolves.toEqual({ outcome: 'recorded' });
    const content = await fs.readFile(path.join(stateDir, 'authority-events.jsonl'), 'utf8');
    expect(content.split('\n').filter((line) => line.length > 0).length).toBe(1);
  });

  it('refuses a structurally invalid event with invalid-event and writes nothing', async () => {
    const stateDir = await tempStateDir();
    const journal = new AuthorityEventJournalAdapter({ stateDir });
    const malformed = { ...stopEvent(), beforeRevision: 'r7' } as unknown as StopAuthorityEvent;
    await expect(journal.record(malformed)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-event',
    });
    // A getter-shaped event is refused without ever running the getter.
    let getterRan = false;
    const withGetter = {
      get kind(): string {
        getterRan = true;
        return 'stop';
      },
    } as unknown as StopAuthorityEvent;
    await expect(journal.record(withGetter)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-event',
    });
    expect(getterRan).toBe(false);
    await expect(fs.readFile(path.join(stateDir, 'authority-events.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('refuses with unavailable when the journal cannot be written', async () => {
    // A file where the state directory should be makes every write fail.
    const blocked = await tempStateDir();
    const filePath = path.join(blocked, 'authority-events.jsonl');
    await fs.writeFile(filePath, 'not a directory', 'utf8');
    const journal = new AuthorityEventJournalAdapter({ stateDir: filePath });
    await expect(journal.record(stopEvent())).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
  });

  it('records into process memory without a state dir and dedups there', async () => {
    const journal = new AuthorityEventJournalAdapter();
    const event = stopEvent();
    await expect(journal.record(event)).resolves.toEqual({ outcome: 'recorded' });
    await expect(journal.record(event)).resolves.toEqual({ outcome: 'recorded' });
    const other = stopEvent();
    await expect(journal.record(other)).resolves.toEqual({ outcome: 'recorded' });
    // A separate in-memory adapter shares nothing.
    const fresh = new AuthorityEventJournalAdapter();
    await expect(fresh.record(event)).resolves.toEqual({ outcome: 'recorded' });
  });

  it('refuses a non-ENOENT read failure with unavailable and appends nothing, instead of treating it as an empty journal', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const event = stopEvent();
    const existing = JSON.stringify(event);
    await fs.writeFile(filePath, `${existing}\n`, 'utf8');
    // Write-only: the read fails with EACCES while an append would succeed, so
    // only the read-failure guard stops a duplicate line being appended.
    await fs.chmod(filePath, 0o200);
    try {
      const journal = new AuthorityEventJournalAdapter({ stateDir });
      await expect(journal.record(event)).resolves.toEqual({
        outcome: 'refused',
        reason: 'unavailable',
      });
    } finally {
      await fs.chmod(filePath, 0o600);
    }
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${existing}\n`);
  });

  it('refuses events whose actor, organization id or time the mapper rejects with invalid-event and writes nothing', async () => {
    const stateDir = await tempStateDir();
    const journal = new AuthorityEventJournalAdapter({ stateDir });
    const bad: Partial<StopAuthorityEvent>[] = [
      { actor: 'op:cli' },
      { actor: 'op.cli' + String.fromCharCode(7) },
      { eventId: 'stop:' + String.fromCharCode(10) + 'x' },
      { organizationId: '' },
      { atIso: '2026-11-26T08:30:00' },
      { atIso: 'not a time' },
    ];
    for (const override of bad) {
      const event = { ...stopEvent(), ...override } as StopAuthorityEvent;
      await expect(journal.record(event)).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-event',
      });
    }
    await expect(fs.readFile(path.join(stateDir, 'authority-events.jsonl'), 'utf8')).rejects.toThrow();
  });
});
