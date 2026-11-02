import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KILLALL_STOP_REPORT_RECORD_VERSION,
  type KillallStopAgentPort,
  type KillallStopReportRecord,
} from '@fleet/work-execution';

import { killallCommand } from './killall.js';
import type { CliIo } from '../index.js';

describe('killall command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-killall-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: (text: string) => {
          stdout.push(text);
        },
        stderr: (text: string) => {
          stderr.push(text);
        },
      },
      stdout,
      stderr,
    };
  }

  const MARKER_TIME = '2026-11-01T10:00:00.000Z';
  const DIFFERENT_TIME = '2026-11-01T10:00:01.000Z';

  function createConfirmedReport(haltedAtIso: string): KillallStopReportRecord {
    return {
      version: KILLALL_STOP_REPORT_RECORD_VERSION,
      haltedAtIso,
      marker: 'halted',
      cleanSweeps: 2,
      lanes: [
        {
          projectId: 'project-1',
          laneId: 'lane-1',
          confirmed: true,
          unconfirmedReason: null,
          cleanSweeps: 2,
          confirmedAtIso: '2026-11-01T10:05:00.000Z',
          sessionResults: [],
        },
      ],
      train: {
        paused: true,
        acknowledged: true,
        unconfirmedReason: null,
      },
    };
  }

  it('refuses an otherwise confirmed report whose haltedAtIso differs from the marker changedAtIso and exits 1', async () => {
    const fakeAgent: KillallStopAgentPort = {
      stop: async () => ({
        ok: true,
        payload: createConfirmedReport(DIFFERENT_TIME),
      }),
    };

    const { io, stdout } = createMockIo();
    const exitCode = await killallCommand([], io, {
      stateDir: tempDir,
      now: () => MARKER_TIME,
      stopAgent: fakeAgent,
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.confirmed).toBe(false);
    expect(parsed.unconfirmedReason).toBe('halted-at-mismatch');
    expect(parsed.reason).toBe('halted-at-mismatch');
  });

  it('completes with exit 0 when haltedAtIso matches the marker changedAtIso', async () => {
    const fakeAgent: KillallStopAgentPort = {
      stop: async () => ({
        ok: true,
        payload: createConfirmedReport(MARKER_TIME),
      }),
    };

    const { io, stdout } = createMockIo();
    const exitCode = await killallCommand([], io, {
      stateDir: tempDir,
      now: () => MARKER_TIME,
      stopAgent: fakeAgent,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.confirmed).toBe(true);
    expect(parsed.outcome).toBe('completed');
  });

  it('refuses with exit 2 when state directory is missing', async () => {
    const { io, stderr } = createMockIo();
    const exitCode = await killallCommand([], io, {});
    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('durable state directory');
  });

  it('prints help with exit 0 when --help is supplied', async () => {
    const { io, stdout } = createMockIo();
    const exitCode = await killallCommand(['--help'], io);
    expect(exitCode).toBe(0);
    expect(stdout.join('')).toContain('Usage: fleet-v2 killall');
  });

  it('lifts a halt and train pause with exit 0', async () => {
    const { io: haltIo } = createMockIo();
    await killallCommand([], haltIo, {
      stateDir: tempDir,
      now: () => MARKER_TIME,
    });

    const { io: liftIo, stdout } = createMockIo();
    const exitCode = await killallCommand(['--lift'], liftIo, {
      stateDir: tempDir,
      now: () => MARKER_TIME,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.outcome).toBe('completed');
    expect(parsed.marker).toBe('clear');
    expect(parsed.train).toBe('clear');
  });
});
