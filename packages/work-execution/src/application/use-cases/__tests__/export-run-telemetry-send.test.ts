/**
 * ExportRunTelemetryUseCase request-parse tests (OT2c-1 Luna fix): every
 * request field is read through its own property descriptor, so a getter is
 * never called during validation and a throwing getter cannot make
 * `execute()` reject. Refused requests reach no port.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ExportRunTelemetryUseCase } from '../ExportRunTelemetryUseCase.use-case.js';
import type { ExportRunTelemetryDependencies } from '../ExportRunTelemetryUseCase.use-case.js';
import type { ExportRunTelemetryResult } from '../../ports/in/ExportRunTelemetryPort.in-port.js';
import type { RunTelemetryPort, RunTelemetrySendResult } from '../../ports/out/RunTelemetryPort.out-port.js';
import type { TelemetryDispositionPort } from '../../ports/out/TelemetryDispositionPort.out-port.js';
import type { AcceptanceReceiptReadPort } from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { TelemetryHmac } from '../../../domain/run-telemetry-ids.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const HAND_ATTEMPT_ID = 'example-hand-attempt-1';
const NOW_ISO = '2026-10-29T10:05:00.000Z';

/** Minimal ports: a refused request must reach none of them. */
const noCalls = {
  runRepo: { get: async () => null, list: async () => [] } as Pick<LaneRunRepositoryPort, 'get' | 'list'>,
  journal: { listForRun: async () => [] } as Pick<LaneRunJournalPort, 'listForRun'>,
  attemptRepo: {
    findAttemptById: async () => null,
    listAttemptsByWorkOrder: async () => [],
    listAllAttempts: async () => [],
  } as Pick<AttemptRepositoryPort, 'findAttemptById' | 'listAttemptsByWorkOrder' | 'listAllAttempts'>,
  workOrderRepo: { findWorkOrderById: async () => null } as Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>,
  receipts: {
    readReceiptsForHead: async () => {
      throw new Error('must not be called');
    },
  } as AcceptanceReceiptReadPort,
  dispositions: {
    read: async () => {
      throw new Error('must not be called');
    },
    write: async () => {
      throw new Error('must not be called');
    },
  } as TelemetryDispositionPort,
  telemetry: {
    send: async (): Promise<RunTelemetrySendResult> => {
      throw new Error('must not be called');
    },
  } as RunTelemetryPort,
};

function makeDeps(): ExportRunTelemetryDependencies {
  return { ...noCalls, hmac };
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID },
    policy: {
      route: 'collector',
      sampleRatio: 1,
      sendCost: true,
      includeDryRun: true,
      projectAliases: {},
    },
    mode: 'send',
    deadline: null,
    retryRejected: false,
    nowIso: NOW_ISO,
    ...overrides,
  };
}

describe('ExportRunTelemetryUseCase request parse through own data descriptors (OT2c-1 Luna)', () => {
  it('a getter field is refused as invalid-request without ever calling the getter', async () => {
    const request = makeRequest() as Record<string, unknown>;
    let getterCalled = false;
    Object.defineProperty(request, 'mode', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'send';
      },
    });

    const result = await new ExportRunTelemetryUseCase(makeDeps()).execute(request);

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', counts: expect.anything(), counters: {} });
    expect((result as Extract<ExportRunTelemetryResult, { outcome: 'refused' }>).reason).toBe('invalid-request');
    expect(getterCalled).toBe(false);
  });

  it('a throwing getter reads as invalid-request and execute never rejects', async () => {
    const request = makeRequest() as Record<string, unknown>;
    Object.defineProperty(request, 'nowIso', {
      enumerable: true,
      get() {
        throw new Error('example-getter-failure');
      },
    });

    const result = await new ExportRunTelemetryUseCase(makeDeps()).execute(request);

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', counts: expect.anything(), counters: {} });
    expect((result as Extract<ExportRunTelemetryResult, { outcome: 'refused' }>).reason).toBe('invalid-request');
  });

  it('an accessor pair on a field is refused as invalid-request', async () => {
    const request = makeRequest() as Record<string, unknown>;
    Object.defineProperty(request, 'retryRejected', {
      enumerable: true,
      get() {
        return false;
      },
      set() {},
    });

    const result = await new ExportRunTelemetryUseCase(makeDeps()).execute(request);

    expect((result as Extract<ExportRunTelemetryResult, { outcome: 'refused' }>).reason).toBe('invalid-request');
  });
});
