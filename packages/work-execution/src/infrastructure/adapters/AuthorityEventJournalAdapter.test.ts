import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StopAuthorityEvent } from '../../domain/authority-event-mapping.js';
import {
  AuthorityEventJournalAdapter,
  MAX_AUTHORITY_JOURNAL_EVENTS,
} from './AuthorityEventJournalAdapter.adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** Journal files in a state dir, sorted, without the lock file. */
async function journalFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => !name.endsWith('.lock')).sort();
}

/** Every non-empty line across the live journal, its archives and any staged file. */
async function allJournalLines(dir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const name of await journalFiles(dir)) {
    const content = await fs.readFile(path.join(dir, name), 'utf8');
    lines.push(...content.split('\n').filter((line) => line.length > 0));
  }
  return lines;
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

  it('falls back to MAX_AUTHORITY_JOURNAL_EVENTS for invalid maxEvents options', async () => {
    const invalid: unknown[] = [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, '5'];
    for (const maxEvents of invalid) {
      const journal = new AuthorityEventJournalAdapter({ maxEvents } as never);
      expect((journal as unknown as { maxEvents: number }).maxEvents).toBe(
        MAX_AUTHORITY_JOURNAL_EVENTS,
      );
    }
    // A valid small value is honoured, so the fallback is not a constant.
    const small = new AuthorityEventJournalAdapter({ maxEvents: 2 });
    expect((small as unknown as { maxEvents: number }).maxEvents).toBe(2);
  });

  it('refuses in-memory journal at maxEvents cap with unavailable', async () => {
    const journal = new AuthorityEventJournalAdapter({ maxEvents: 2 });
    await expect(journal.record(stopEvent())).resolves.toEqual({ outcome: 'recorded' });
    await expect(journal.record(stopEvent())).resolves.toEqual({ outcome: 'recorded' });
    await expect(journal.record(stopEvent())).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
  });

  it('rotates the durable journal at maxEvents cap into <stem>.1.jsonl and starts a fresh live file', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const prior = `${JSON.stringify(stopEvent('first'))}\n`;
    await fs.writeFile(filePath, prior, 'utf8');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    const next = stopEvent('second');
    await expect(journal.record(next)).resolves.toEqual({ outcome: 'recorded' });
    // The archive carries every prior line byte-identical.
    expect(await fs.readFile(path.join(stateDir, 'authority-events.1.jsonl'), 'utf8')).toBe(prior);
    // The live file now holds only the new event.
    const fresh = await fs.readFile(filePath, 'utf8');
    expect(fresh).toBe(`${JSON.stringify(next)}\n`);
  });

  it('numbers successive rotations: a second rotation creates <stem>.2.jsonl and leaves <stem>.1.jsonl untouched', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const archive1Path = path.join(stateDir, 'authority-events.1.jsonl');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await fs.writeFile(filePath, `${JSON.stringify(stopEvent('first'))}\n`, 'utf8');
    await expect(journal.record(stopEvent('second'))).resolves.toEqual({ outcome: 'recorded' });
    const archive1Before = await fs.readFile(archive1Path, 'utf8');
    // The live file now holds 'second' only; recording a third rotates again.
    await expect(journal.record(stopEvent('third'))).resolves.toEqual({ outcome: 'recorded' });
    expect(await fs.readFile(archive1Path, 'utf8')).toBe(archive1Before);
    expect(await fs.readFile(path.join(stateDir, 'authority-events.2.jsonl'), 'utf8')).toBe(
      `${JSON.stringify(stopEvent('second'))}\n`,
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(stopEvent('third'))}\n`);
  });

  it('never overwrites pre-existing archives and picks the next unused positive integer', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const archives: Record<string, string> = {
      'authority-events.1.jsonl': `${JSON.stringify(stopEvent('a1'))}\n`,
      'authority-events.2.jsonl': `${JSON.stringify(stopEvent('a2'))}\n`,
      'authority-events.bak.jsonl': 'not an archive\n',
      'authority-events.0.jsonl': 'zero is not positive\n',
      // Beyond Number.MAX_SAFE_INTEGER: not a safe integer, ignored.
      'authority-events.99999999999999999999.jsonl': 'too large\n',
    };
    for (const [name, content] of Object.entries(archives)) {
      await fs.writeFile(path.join(stateDir, name), content, 'utf8');
    }
    await fs.writeFile(filePath, `${JSON.stringify(stopEvent('old'))}\n`, 'utf8');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(stopEvent('new'))).resolves.toEqual({ outcome: 'recorded' });
    for (const [name, content] of Object.entries(archives)) {
      expect(await fs.readFile(path.join(stateDir, name), 'utf8')).toBe(content);
    }
    expect(await fs.readFile(path.join(stateDir, 'authority-events.3.jsonl'), 'utf8')).toBe(
      `${JSON.stringify(stopEvent('old'))}\n`,
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(stopEvent('new'))}\n`);
  });

  it('refuses with unavailable when link fails with EACCES and leaves live file and archives untouched', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const live = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, live, 'utf8');
    const eacces = Object.assign(new Error('link denied'), { code: 'EACCES' });
    const link = vi.spyOn(fs, 'link').mockRejectedValue(eacces);
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(stopEvent('fresh'))).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    expect(link).toHaveBeenCalled();
    expect(await fs.readFile(filePath, 'utf8')).toBe(live);
    expect(await fs.readdir(stateDir)).toEqual(['authority-events.jsonl']);
  });

  it('refuses with unavailable when link keeps failing with EEXIST past the bounded retry limit', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const live = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, live, 'utf8');
    const eexist = Object.assign(new Error('link exists'), { code: 'EEXIST' });
    const link = vi.spyOn(fs, 'link').mockRejectedValue(eexist);
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(stopEvent('fresh'))).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    // The retry budget is bounded, not an infinite loop.
    expect(link.mock.calls.length).toBeGreaterThan(1);
    expect(link.mock.calls.length).toBeLessThanOrEqual(32);
    expect(await fs.readFile(filePath, 'utf8')).toBe(live);
    expect(await fs.readdir(stateDir)).toEqual(['authority-events.jsonl']);
  });

  it('answers recorded without rotating for a retry of an eventId still in the full live file', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const kept = stopEvent('kept');
    const live = `${JSON.stringify(kept)}\n`;
    await fs.writeFile(filePath, live, 'utf8');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(kept)).resolves.toEqual({ outcome: 'recorded' });
    // No rotation happened: the live file is unchanged and no archive exists.
    expect(await fs.readFile(filePath, 'utf8')).toBe(live);
    expect(await fs.readdir(stateDir)).toEqual(['authority-events.jsonl']);
  });

  it('appends a rotated eventId to the fresh live file, since archives are not re-read for idempotency', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const rotated = stopEvent('rotated');
    await fs.writeFile(
      path.join(stateDir, 'authority-events.1.jsonl'),
      `${JSON.stringify(rotated)}\n`,
      'utf8',
    );
    await fs.writeFile(filePath, `${JSON.stringify(stopEvent('old'))}\n`, 'utf8');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(rotated)).resolves.toEqual({ outcome: 'recorded' });
    // The archive is untouched and the event appears once in the fresh live file.
    expect(await fs.readFile(path.join(stateDir, 'authority-events.1.jsonl'), 'utf8')).toBe(
      `${JSON.stringify(rotated)}\n`,
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(rotated)}\n`);
  });

  it('stays bounded and refuses when an archive name is Number.MAX_SAFE_INTEGER, instead of spinning on n += 1', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const live = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, live, 'utf8');
    // An archive at the top of the safe-integer range makes maxExisting
    // equal Number.MAX_SAFE_INTEGER; incrementing past it loses precision.
    const topArchive = 'authority-events.9007199254740991.jsonl';
    await fs.writeFile(path.join(stateDir, topArchive), 'prior\n', 'utf8');
    const link = vi.spyOn(fs, 'link');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(stopEvent('fresh'))).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    // Bounded: no attempt is made to link a non-safe-integer archive name.
    expect(link).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, 'utf8')).toBe(live);
    expect(await fs.readFile(path.join(stateDir, topArchive), 'utf8')).toBe('prior\n');
  });

  it('leaves the live journal whole and no staged residue when staging the fresh live file fails', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const prior = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, prior, 'utf8');
    const write = vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('write denied'));
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    await expect(journal.record(stopEvent('fresh'))).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    expect(write).toHaveBeenCalled();
    expect(await fs.readFile(filePath, 'utf8')).toBe(prior);
    expect(await journalFiles(stateDir)).toEqual(['authority-events.jsonl']);
  });

  it('heals a partial write whose cleanup also fails: the next record leaves no partial line and loses no event', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const kept = stopEvent('kept');
    const prior = `${JSON.stringify(kept)}\n`;
    await fs.writeFile(filePath, prior, 'utf8');
    const realAppend = fs.appendFile.bind(fs);
    const realWrite = fs.writeFile.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    const isLock = (target: unknown): boolean => String(target).endsWith('.lock');
    // Every journal write lands half its bytes and then fails, and every
    // journal unlink fails: the worst case for any best-effort restore.
    vi.spyOn(fs, 'appendFile').mockImplementation(async (target, data, options) => {
      await realAppend(target, String(data).slice(0, 12), options as never);
      throw new Error('disk full');
    });
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, data, options) => {
      if (isLock(target)) {
        return realWrite(target, data, options as never);
      }
      await realWrite(target, String(data).slice(0, 12), options as never);
      throw new Error('disk full');
    });
    vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (isLock(target)) {
        return realUnlink(target);
      }
      throw new Error('unlink denied');
    });
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    const fresh = stopEvent('fresh');
    await expect(journal.record(fresh)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    vi.restoreAllMocks();
    // The faults are gone: the very next call recovers and records.
    await expect(journal.record(fresh)).resolves.toEqual({ outcome: 'recorded' });
    const lines = await allJournalLines(stateDir);
    // No partial line survives anywhere: every line parses as a whole event.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(lines.filter((line) => line === JSON.stringify(kept))).toHaveLength(1);
    expect(lines.filter((line) => line === JSON.stringify(fresh))).toHaveLength(1);
    expect(await journalFiles(stateDir)).not.toContain('authority-events.jsonl.next');
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(fresh)}\n`);
  });

  it('reuses the archive an interrupted rotation already linked instead of archiving the same journal twice', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const prior = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, prior, 'utf8');
    const realUnlink = fs.unlink.bind(fs);
    // The archive link succeeds, then retiring the live path fails.
    vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (String(target).endsWith('.lock')) {
        return realUnlink(target);
      }
      throw new Error('unlink denied');
    });
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    const fresh = stopEvent('fresh');
    await expect(journal.record(fresh)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    vi.restoreAllMocks();
    await expect(journal.record(fresh)).resolves.toEqual({ outcome: 'recorded' });
    expect(await journalFiles(stateDir)).toEqual(['authority-events.1.jsonl', 'authority-events.jsonl']);
    expect(await fs.readFile(path.join(stateDir, 'authority-events.1.jsonl'), 'utf8')).toBe(prior);
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(fresh)}\n`);
  });

  it('promotes a staged journal when a rotation stopped after retiring the live file', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const prior = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, prior, 'utf8');
    const realLink = fs.link.bind(fs);
    // Promotion of the staged file into the live path fails once.
    vi.spyOn(fs, 'link').mockImplementation(async (existing, target) => {
      if (String(target) === filePath) {
        throw new Error('link denied');
      }
      return realLink(existing, target);
    });
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    const fresh = stopEvent('fresh');
    await expect(journal.record(fresh)).resolves.toEqual({
      outcome: 'refused',
      reason: 'unavailable',
    });
    vi.restoreAllMocks();
    // Live is absent, the archive holds the prior journal, the staged file holds the new one.
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // The retry heals by promotion and reports the event as already recorded.
    await expect(journal.record(fresh)).resolves.toEqual({ outcome: 'recorded' });
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(fresh)}\n`);
    expect(await fs.readFile(path.join(stateDir, 'authority-events.1.jsonl'), 'utf8')).toBe(prior);
    expect(await journalFiles(stateDir)).toEqual(['authority-events.1.jsonl', 'authority-events.jsonl']);
  });

  it('discards an incomplete staged file beside a live journal and rotates normally', async () => {
    const stateDir = await tempStateDir();
    const filePath = path.join(stateDir, 'authority-events.jsonl');
    const prior = `${JSON.stringify(stopEvent('kept'))}\n`;
    await fs.writeFile(filePath, prior, 'utf8');
    await fs.writeFile(`${filePath}.next`, '{"eventId":"half', 'utf8');
    const journal = new AuthorityEventJournalAdapter({ stateDir, maxEvents: 1 });
    const fresh = stopEvent('fresh');
    await expect(journal.record(fresh)).resolves.toEqual({ outcome: 'recorded' });
    expect(await fs.readFile(path.join(stateDir, 'authority-events.1.jsonl'), 'utf8')).toBe(prior);
    expect(await fs.readFile(filePath, 'utf8')).toBe(`${JSON.stringify(fresh)}\n`);
    expect(await journalFiles(stateDir)).toEqual(['authority-events.1.jsonl', 'authority-events.jsonl']);
  });
});
