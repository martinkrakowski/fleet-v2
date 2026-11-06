import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  StateFileUnknownVersionError,
} from '../file-store.js';
import { SeatTicketRepositoryAdapter } from '../SeatTicketRepositoryAdapter.adapter.js';
import { SEAT_TICKET_ROLES, type SeatTicketRecord } from '../../../domain/execution-records.js';

function ticket(
  projectId: string,
  role: SeatTicketRecord['role'],
  overrides: Partial<SeatTicketRecord> = {},
): SeatTicketRecord {
  return {
    version: 1,
    projectId,
    role,
    ticket: 1,
    revision: 1,
    updatedAtIso: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('SeatTicketRepositoryAdapter (memory mode)', () => {
  let adapter: SeatTicketRepositoryAdapter;

  beforeEach(() => {
    adapter = new SeatTicketRepositoryAdapter();
  });

  it('finds nothing for an unknown (project, role)', async () => {
    expect(await adapter.findSeatTicket('project-a', 'first-pass')).toBeNull();
    expect(await adapter.listSeatTickets()).toEqual([]);
  });

  it('isolates a saved record from a caller-retained mutable alias', async () => {
    const record = ticket('project-a', 'first-pass');
    expect(await adapter.saveSeatTicket(record)).toBe('saved');
    const alias = { ...record } as {
      -readonly [K in keyof SeatTicketRecord]: SeatTicketRecord[K];
    };
    alias.ticket = 0;
    alias.revision = 99;
    const stored = await adapter.findSeatTicket('project-a', 'first-pass');
    expect(stored).toEqual({ ...ticket('project-a', 'first-pass') });
    expect(await adapter.listSeatTickets()).toEqual([{ ...ticket('project-a', 'first-pass') }]);
    // A lower ticket through the port itself still conflicts.
    expect(
      await adapter.saveSeatTicket(ticket('project-a', 'first-pass', { ticket: 0, revision: 5 })),
    ).toBe('conflict');
  });

  it('reads back a saved ticket and narrows lists by project', async () => {
    const record = ticket('project-a', 'first-pass');
    expect(await adapter.saveSeatTicket(record)).toBe('saved');
    expect(await adapter.findSeatTicket('project-a', 'first-pass')).toEqual(record);
    expect(await adapter.listSeatTickets()).toHaveLength(1);
    expect(await adapter.listSeatTickets('other-project')).toEqual([]);
  });

  it('keeps the same role under two projects as two records', async () => {
    await adapter.saveSeatTicket(ticket('project-a', 'first-pass'));
    await adapter.saveSeatTicket(ticket('project-b', 'first-pass'));
    const list = await adapter.listSeatTickets();
    expect(list).toHaveLength(2);
    expect(await adapter.findSeatTicket('project-a', 'first-pass')).toEqual(ticket('project-a', 'first-pass'));
    expect(await adapter.findSeatTicket('project-b', 'first-pass')).toEqual(ticket('project-b', 'first-pass'));
  });

  it('compare-and-swaps on revision: a stale save conflicts and changes nothing', async () => {
    const first = ticket('project-a', 'first-pass', { ticket: 1, revision: 1 });
    expect(await adapter.saveSeatTicket(first)).toBe('saved');
    expect(await adapter.saveSeatTicket(ticket('project-a', 'first-pass', { ticket: 2, revision: 1 }))).toBe('conflict');
    expect(await adapter.findSeatTicket('project-a', 'first-pass')).toEqual(first);
    const next = ticket('project-a', 'first-pass', { ticket: 2, revision: 2 });
    expect(await adapter.saveSeatTicket(next)).toBe('saved');
    expect(await adapter.findSeatTicket('project-a', 'first-pass')).toEqual(next);
  });

  it('refuses a save whose ticket is lower than the stored one', async () => {
    const stored = ticket('project-a', 'first-pass', { ticket: 3, revision: 1 });
    await adapter.saveSeatTicket(stored);
    const lowerTicket = ticket('project-a', 'first-pass', { ticket: 2, revision: 2 });
    expect(await adapter.saveSeatTicket(lowerTicket)).toBe('conflict');
    expect(await adapter.findSeatTicket('project-a', 'first-pass')).toEqual(stored);
  });

  it('refuses a malformed record (negative ticket, bad date) without storing it', async () => {
    await expect(
      adapter.saveSeatTicket(ticket('project-a', 'first-pass', { ticket: -1, revision: -1, updatedAtIso: 'bad' })),
    ).rejects.toThrow();
    expect(await adapter.listSeatTickets()).toEqual([]);
  });

  it('refuses an unsafe project id or role', async () => {
    await expect(adapter.saveSeatTicket(ticket('.', 'first-pass'))).rejects.toThrow(
      'SeatTicketRepositoryAdapter refuses an unsafe project id or role',
    );
    await expect(adapter.saveSeatTicket(ticket('..', 'first-pass'))).rejects.toThrow(
      'SeatTicketRepositoryAdapter refuses an unsafe project id or role',
    );
    await expect(adapter.saveSeatTicket(ticket('', 'first-pass'))).rejects.toThrow(
      'SeatTicketRepositoryAdapter refuses an unsafe project id or role',
    );
    for (const role of ['bogus-role', '']) {
      await expect(
        adapter.saveSeatTicket({ ...ticket('project-a', 'first-pass'), role: role as SeatTicketRecord['role'] }),
      ).rejects.toThrow('SeatTicketRepositoryAdapter refuses an unsafe project id or role');
    }
    expect(SEAT_TICKET_ROLES.length).toBeGreaterThan(0);
  });
});

describe('SeatTicketRepositoryAdapter (file mode)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-sr3-seat-tickets-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('persists to seat-tickets.json with schemaVersion 1 and re-reads from a second adapter', async () => {
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    const record = ticket('project-a', 'first-pass', { ticket: 4, revision: 1 });
    expect(await adapter.saveSeatTicket(record)).toBe('saved');
    const bytes = await fs.readFile(path.join(stateDir, 'seat-tickets.json'), 'utf8');
    const onDisk: unknown[] = JSON.parse(bytes);
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toHaveLength(1);
    expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);

    const second = new SeatTicketRepositoryAdapter({ stateDir });
    expect(await second.findSeatTicket('project-a', 'first-pass')).toEqual(record);
    expect(await second.listSeatTickets()).toHaveLength(1);
  });

  it('reads a record written without schemaVersion (absent reads as 1)', async () => {
    const raw = ticket('project-a', 'fix', { ticket: 2, revision: 1 });
    await fs.writeFile(path.join(stateDir, 'seat-tickets.json'), JSON.stringify([raw]));
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    expect(await adapter.findSeatTicket('project-a', 'fix')).toEqual(raw);
  });

  it('does not write a malformed record to disk', async () => {
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    await expect(
      adapter.saveSeatTicket(ticket('project-a', 'first-pass', { ticket: -1 })),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(stateDir, 'seat-tickets.json'))).rejects.toThrow();
  });

  it('treats duplicate (project, role) records as unreadable instead of letting the last win', async () => {
    const target = path.join(stateDir, 'seat-tickets.json');
    await fs.writeFile(
      target,
      JSON.stringify([
        { ...ticket('project-a', 'first-pass', { ticket: 10, revision: 1 }), schemaVersion: 1 },
        { ...ticket('project-a', 'first-pass', { ticket: 5, revision: 2 }), schemaVersion: 1 },
      ]),
    );
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    await expect(
      adapter.saveSeatTicket(ticket('project-a', 'first-pass', { ticket: 6, revision: 3 })),
    ).rejects.toBeInstanceOf(StateFileUnreadableError);
  });

  it('refuses a symlinked store file, dangling or not, instead of reading it or calling it absent', async () => {
    const outside = path.join(stateDir, 'outside.json');
    await fs.writeFile(outside, JSON.stringify([]));
    const target = path.join(stateDir, 'seat-tickets.json');
    await fs.symlink(outside, target);
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    await expect(adapter.listSeatTickets()).rejects.toThrow(/regular file/);
    await fs.unlink(target);
    await fs.symlink(path.join(stateDir, 'nowhere.json'), target);
    await expect(adapter.findSeatTicket('project-a', 'first-pass')).rejects.toThrow(/regular file/);
  });

  it('refuses an oversized store file', async () => {
    await fs.writeFile(path.join(stateDir, 'seat-tickets.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    await expect(adapter.listSeatTickets()).rejects.toThrow(/bytes/);
  });

  it('throws StateFileUnknownVersionError on schemaVersion 2 and writes no quarantine copy', async () => {
    await fs.writeFile(
      path.join(stateDir, 'seat-tickets.json'),
      JSON.stringify([{ ...ticket('project-a', 'first-pass'), schemaVersion: 2 }]),
    );
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    await expect(adapter.findSeatTicket('project-a', 'first-pass')).rejects.toBeInstanceOf(
      StateFileUnknownVersionError,
    );
    await expect(fs.readdir(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('throws StateFileUnreadableError on invalid JSON and keeps a quarantine copy', async () => {
    await fs.writeFile(path.join(stateDir, 'seat-tickets.json'), '{ not json');
    const adapter = new SeatTicketRepositoryAdapter({ stateDir });
    await expect(adapter.findSeatTicket('project-a', 'first-pass')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    const quarantine = await fs.readdir(path.join(stateDir, 'quarantine'));
    expect(quarantine.length).toBeGreaterThan(0);
  });

  it('serialize two adapters over one stateDir: one saves, the other conflicts', async () => {
    const first = new SeatTicketRepositoryAdapter({ stateDir });
    const second = new SeatTicketRepositoryAdapter({ stateDir });
    const record = ticket('project-a', 'review', { ticket: 1, revision: 1 });
    expect(await first.saveSeatTicket(record)).toBe('saved');
    expect(await second.saveSeatTicket(record)).toBe('conflict');
    expect(await second.saveSeatTicket(ticket('project-a', 'review', { ticket: 2, revision: 2 }))).toBe('saved');
    expect(await first.findSeatTicket('project-a', 'review')).toEqual(
      ticket('project-a', 'review', { ticket: 2, revision: 2 }),
    );
  });
});
