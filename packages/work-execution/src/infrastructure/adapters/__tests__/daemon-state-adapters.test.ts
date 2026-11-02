/**
 * Daemon state adapter tests (lane DT3): kill mid-write, fence never goes
 * back, state check over all four kinds, fail-closed reads that echo no
 * supplied value, and projection cursor rules delegated to the domain. Real
 * temp state directories; no external commands; fresh clock per call.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDaemonStatusRecord,
  type BuildDaemonStatusInput,
} from '../../../domain/daemon-tick.js';
import {
  projectJobOutcomeToDaemonEvent,
  type DaemonEventRecord,
} from '../../../domain/daemon-events.js';
import { DaemonStatusFileAdapter } from '../DaemonStatusFileAdapter.adapter.js';
import { DaemonPauseAdapter } from '../DaemonPauseAdapter.adapter.js';
import { DaemonLeaseAdapter } from '../DaemonLeaseAdapter.adapter.js';
import { DaemonEventProjectionAdapter } from '../DaemonEventProjectionAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from '../state-files.js';

const TICK_ID = 'tick-0AAAAAAAAAAAAAAAAAAAAAAAAA';
const SECOND_TICK_ID = 'tick-1AAAAAAAAAAAAAAAAAAAAAAAAA';

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function statusInput(tickId: string = TICK_ID): BuildDaemonStatusInput {
  const now = nowIso();
  return {
    tickId,
    startedAtIso: now,
    finishedAtIso: now,
    paused: false,
    halted: false,
    forgeReachable: null,
    jobs: [
      {
        jobId: 'notifier',
        outcome: 'completed',
        reasonCode: null,
        leaseFence: null,
        durationMs: 0,
        nextNotBeforeIso: null,
        consecutiveBudgetExhausted: 0,
      },
    ],
    repositories: [],
    notifierCursor: null,
  };
}

function buildStatusRecord(tickId: string = TICK_ID): { readonly tickId: string; readonly bytes: Buffer } {
  const built = buildDaemonStatusRecord(statusInput(tickId));
  if (!built.ok) {
    throw new Error('invalid status fixture');
  }
  return { tickId: built.record.tickId, bytes: Buffer.from(JSON.stringify(built.record)) };
}

function eventFixture(n: number): DaemonEventRecord {
  const read = projectJobOutcomeToDaemonEvent({
    eventId: `01JB00000000000000000000${String(n).padStart(2, '0')}`,
    tickId: TICK_ID,
    jobId: 'notifier',
    jobOutcome: { outcome: 'completed', progressed: true },
    recordedAtIso: nowIso(),
  });
  if (!read.ok) {
    throw new Error('invalid event fixture');
  }
  return read.record;
}

describe('daemon state adapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-daemon-adapters-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a failed rename mid-write leaves the original status and lease bytes intact', async () => {
    const stateDir = tempDir;

    const statusAdapter = new DaemonStatusFileAdapter({ stateDir });
    await statusAdapter.write(statusInput(TICK_ID));
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('kill mid-write'));
    await expect(statusAdapter.write(statusInput(SECOND_TICK_ID))).rejects.toThrow('kill mid-write');
    renameSpy.mockRestore();
    const statusRead = await statusAdapter.read();
    expect(statusRead.status).toBe('ok');
    expect(statusRead.status === 'ok' ? statusRead.record.tickId : null).toBe(TICK_ID);

    const leaseAdapter = new DaemonLeaseAdapter({ stateDir });
    const acquired = await leaseAdapter.acquire({
      scope: 'notifier',
      holderId: TICK_ID,
      observedFence: 0,
      leaseUntilIso: futureIso(),
      nowIso: nowIso(),
    });
    expect(acquired.outcome).toBe('ok');

    const leaseRenameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('kill mid-write'));
    const renewed = leaseAdapter.renew({
      scope: 'notifier',
      holderId: TICK_ID,
      fence: 1,
      leaseUntilIso: futureIso(),
      nowIso: nowIso(),
    });
    await expect(renewed).rejects.toThrow('kill mid-write');
    leaseRenameSpy.mockRestore();

    const leaseRead = await leaseAdapter.read('notifier');
    expect(leaseRead).not.toBeNull();
    expect(leaseRead?.fence).toBe(1);
  });

  it('the lease fence never goes back and stale fences are refused', async () => {
    const adapter = new DaemonLeaseAdapter({ stateDir: tempDir });
    const now = nowIso();
    const later = futureIso();

    const acquire = await adapter.acquire({
      scope: 'notifier',
      holderId: TICK_ID,
      observedFence: 0,
      leaseUntilIso: later,
      nowIso: now,
    });
    expect(acquire.outcome).toBe('ok');
    expect(acquire.outcome === 'ok' ? acquire.lease.fence : -1).toBe(1);

    const release = await adapter.release({ scope: 'notifier', holderId: TICK_ID, fence: 1, nowIso: now });
    expect(release.outcome).toBe('ok');

    const reacquire = await adapter.acquire({
      scope: 'notifier',
      holderId: TICK_ID,
      observedFence: 1,
      leaseUntilIso: later,
      nowIso: now,
    });
    expect(reacquire.outcome).toBe('ok');
    expect(reacquire.outcome === 'ok' ? reacquire.lease.fence : -1).toBe(2);

    await expect(
      adapter.renew({ scope: 'notifier', holderId: TICK_ID, fence: 1, leaseUntilIso: later, nowIso: now }),
    ).resolves.toEqual({ outcome: 'refused', reason: 'lease-not-held' });
    await expect(
      adapter.release({ scope: 'notifier', holderId: TICK_ID, fence: 1, nowIso: now }),
    ).resolves.toEqual({ outcome: 'refused', reason: 'lease-not-held' });

    const read = await adapter.read('notifier');
    expect(read?.fence).toBe(2);

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tempDir, 'daemon', 'leases', 'notifier.json'), 'utf8'),
    ) as { fence?: number };
    expect(onDisk.fence).toBe(2);
  });

  it('state check reads all four daemon kinds and reports expected counts', async () => {
    const stateDir = tempDir;

    await new DaemonStatusFileAdapter({ stateDir }).write(statusInput());
    await new DaemonPauseAdapter({ stateDir }).write(true, nowIso());
    const acquired = await new DaemonLeaseAdapter({ stateDir }).acquire({
      scope: 'notifier',
      holderId: TICK_ID,
      observedFence: 0,
      leaseUntilIso: futureIso(),
      nowIso: nowIso(),
    });
    expect(acquired.outcome).toBe('ok');
    const appended = await new DaemonEventProjectionAdapter({ stateDir }).append([eventFixture(1), eventFixture(2)]);
    expect(appended.appended).toBe(2);

    for (const descriptor of WORK_EXECUTION_STATE_FILES) {
      const check = await descriptor.check(stateDir);
      if (descriptor.basename === 'daemon/status.json') {
        expect(check.result).toEqual({ status: 'ok', recordCount: 1 });
      } else if (descriptor.basename === 'daemon/paused.json') {
        expect(check.result).toEqual({ status: 'ok', recordCount: 1 });
      } else if (descriptor.basename === 'daemon/leases') {
        expect(check.result).toEqual({ status: 'ok', recordCount: 1 });
      } else if (descriptor.basename === 'daemon/events.jsonl') {
        expect(check.result).toEqual({ status: 'ok', recordCount: 2 });
      }
    }

    const eventsDescriptor = WORK_EXECUTION_STATE_FILES.find((d) => d.basename === 'daemon/events.jsonl')!;
    expect(eventsDescriptor.inspect(Buffer.from('garbage header\n'))).toEqual({
      status: 'ok',
      recordCount: 0,
      detail: 'projection header missing or malformed',
    });

    const statusDescriptor = WORK_EXECUTION_STATE_FILES.find((d) => d.basename === 'daemon/status.json')!;
    const badStatus = JSON.parse(buildStatusRecord().bytes.toString('utf8')) as Record<string, unknown>;
    badStatus.version = 2;
    expect(statusDescriptor.inspect(Buffer.from(JSON.stringify(badStatus)))).toEqual({
      status: 'unknown-version',
      detail: 'DaemonStatus version is not supported',
      recordIndex: 0,
    });
  });

  it('fail closed and echoes no supplied value', async () => {
    const stateDir = tempDir;
    const garbage = Buffer.from('paused: {{SECRET}} not json');
    await fs.mkdir(path.join(stateDir, 'daemon', 'leases'), { recursive: true });

    const pauseAdapter = new DaemonPauseAdapter({ stateDir });
    await fs.writeFile(path.join(stateDir, 'daemon', 'paused.json'), garbage);
    await expect(pauseAdapter.read()).resolves.toEqual({ state: 'unreadable' });

    const pauseDescriptor = WORK_EXECUTION_STATE_FILES.find((d) => d.basename === 'daemon/paused.json')!;
    const inspection = pauseDescriptor.inspect(garbage);
    expect(inspection.status).toBe('unreadable');
    expect(inspection.status === 'unreadable' ? inspection.detail : '').not.toContain('{{SECRET}}');

    const leaseAdapter = new DaemonLeaseAdapter({ stateDir });
    await fs.writeFile(path.join(stateDir, 'daemon', 'leases', 'notifier.json'), garbage);
    const refused = await leaseAdapter.acquire({
      scope: 'notifier',
      holderId: TICK_ID,
      observedFence: 0,
      leaseUntilIso: futureIso(),
      nowIso: nowIso(),
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'lease-unreadable' });
    expect(refused.outcome === 'refused' ? refused.reason : '').not.toContain('{{SECRET}}');
  });

  it('projection cursor rules come from the domain', async () => {
    const adapter = new DaemonEventProjectionAdapter({ stateDir: tempDir });
    const e1 = eventFixture(1);
    const e2 = eventFixture(2);
    const e3 = eventFixture(3);
    await adapter.append([e1, e2, e3]);

    const all = await adapter.readAfterCursor(null);
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.events).toEqual([e1, e2, e3]);
      expect(all.nextCursor).toBe(e3.eventId);
    }

    const fromSecond = await adapter.readAfterCursor(e2.eventId);
    expect(fromSecond.ok).toBe(true);
    if (fromSecond.ok) {
      expect(fromSecond.events).toEqual([e3]);
      expect(fromSecond.nextCursor).toBe(e3.eventId);
    }

    await expect(adapter.readAfterCursor('bogus-cursor')).resolves.toEqual({
      ok: false,
      reason: 'invalid-cursor',
    });
    await expect(adapter.readAfterCursor('01JB0000000000000000000009')).resolves.toEqual({
      ok: false,
      reason: 'cursor-not-found',
    });
  });
});
