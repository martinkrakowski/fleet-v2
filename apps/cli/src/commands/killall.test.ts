import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  KILLALL_STOP_REPORT_RECORD_VERSION,
  type KillallStopAgentPort,
  type KillallStopReportRecord,
} from '@fleet/work-execution';

import { killallCommand, type KillallCliOptions } from './killall.js';
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
      io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
      stdout,
      stderr,
    };
  }

  const MARKER_TIME = '2026-11-01T10:00:00.000Z';
  const DIFFERENT_TIME = '2026-11-01T10:00:01.000Z';

  function createConfirmedReport(haltedAtIso: string): KillallStopReportRecord {
    const lane = {
      projectId: 'project-1',
      laneId: 'lane-1',
      confirmed: true,
      unconfirmedReason: null,
      cleanSweeps: 2,
      confirmedAtIso: '2026-11-01T10:05:00.000Z',
      sessionResults: [],
    };
    return {
      version: KILLALL_STOP_REPORT_RECORD_VERSION,
      haltedAtIso,
      marker: 'halted',
      cleanSweeps: 2,
      lanes: [lane],
      train: {
        paused: true,
        acknowledged: true,
        unconfirmedReason: null,
      },
    };
  }

  async function runKillall(argv: readonly string[] = [], extraOptions: KillallCliOptions = {}) {
    const { io, stdout, stderr } = createMockIo();
    const exitCode = await killallCommand(argv, io, {
      stateDir: tempDir,
      now: () => MARKER_TIME,
      ...extraOptions,
    });
    return { exitCode, stdout, stderr };
  }

  async function runHaltWithAgent(payload: KillallStopReportRecord) {
    const fakeAgent: KillallStopAgentPort = {
      stop: async () => ({
        ok: true,
        payload,
      }),
    };
    return runKillall([], { stopAgent: fakeAgent });
  }

  it('refuses an otherwise confirmed report whose haltedAtIso differs from the marker changedAtIso and exits 1', async () => {
    const { exitCode, stdout } = await runHaltWithAgent(createConfirmedReport(DIFFERENT_TIME));

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.confirmed).toBe(false);
    expect(parsed.unconfirmedReason).toBe('halted-at-mismatch');
    expect(parsed.reason).toBe('halted-at-mismatch');
  });

  it('completes with exit 0 when haltedAtIso matches the marker changedAtIso', async () => {
    const { exitCode, stdout } = await runHaltWithAgent(createConfirmedReport(MARKER_TIME));

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
    await runKillall();
    const { exitCode, stdout } = await runKillall(['--lift']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.outcome).toBe('completed');
    expect(parsed.marker).toBe('clear');
    expect(parsed.train).toBe('clear');
  });
});
