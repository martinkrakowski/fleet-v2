/**
 * RequestToolPermissionUseCase implements RequestToolPermissionPort. It
 * validates the hook body (never throwing), issues its own request id
 * (ignoring any id in the body), records one pending request, then waits for
 * the first verdict. No verdict before the deadline is an explicit deny; the
 * request never returns updatedInput and never echoes the stored tool input.
 * A wait cut short leaves the pending request recorded so the next pass can
 * complete it.
 */

import { PermissionRequest } from '../../domain/entities/PermissionRequest.js';
import type { PermissionRequestRepositoryPort } from '../ports/out/PermissionRequestRepositoryPort.out-port.js';
import type {
  RequestToolPermissionOutcome,
  RequestToolPermissionPort,
} from '../ports/in/RequestToolPermissionPort.in-port.js';

export interface RequestToolPermissionDependencies {
  readonly repository: PermissionRequestRepositoryPort;
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly idSource?: () => string;
  readonly clock?: { nowIso: () => string };
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DEADLINE_MS = 540_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const TOOL_NAME_MAX_CHARS = 200;
const THREAD_ID_MAX_CHARS = 200;
const TOOL_INPUT_MAX_BYTES = 32768;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** API-issued request ids come from the platform's global crypto UUIDs. */
function defaultIdSource(): string {
  return globalThis.crypto.randomUUID();
}

export class RequestToolPermissionUseCase implements RequestToolPermissionPort {
  private readonly repository: PermissionRequestRepositoryPort;
  private readonly deadlineMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly idSource: () => string;
  private readonly clock: { nowIso: () => string };
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: RequestToolPermissionDependencies) {
    this.repository = options.repository;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.idSource = options.idSource ?? defaultIdSource;
    this.clock = options.clock ?? { nowIso: () => new Date().toISOString() };
    this.sleepFn = options.sleep ?? sleep;
  }

  async requestToolPermission(body: unknown, threadId: string): Promise<RequestToolPermissionOutcome> {
    let recordedRequestId: string | undefined;
    try {
      return await this.execute(body, threadId, (id) => {
        recordedRequestId = id;
      });
    } catch {
      if (recordedRequestId !== undefined) {
        try {
          this.repository.expire(recordedRequestId, 'interrupted', this.clock.nowIso());
        } catch {
          // Ignore secondary failure on expire
        }
      }
      return { outcome: 'refused', reason: 'internal-error' };
    }
  }

  private async execute(
    body: unknown,
    threadId: string,
    onRecorded?: (id: string) => void,
  ): Promise<RequestToolPermissionOutcome> {
    if (!isPlainObject(body)) {
      return { outcome: 'refused', reason: 'body-not-an-object' };
    }

    // The API hands over a body it did not validate; a throwing property read
    // is a body refusal, never a fault.
    let toolName: unknown;
    let toolInput: unknown;
    try {
      toolName = body.tool_name;
      toolInput = body.tool_input;
    } catch {
      return { outcome: 'refused', reason: 'body-not-an-object' };
    }

    if (typeof toolName !== 'string') {
      return { outcome: 'refused', reason: 'tool-name-missing' };
    }
    const trimmedToolName = toolName.trim();
    if (trimmedToolName.length === 0) {
      return { outcome: 'refused', reason: 'tool-name-invalid' };
    }
    if (trimmedToolName.length > TOOL_NAME_MAX_CHARS || hasControlCharacter(trimmedToolName)) {
      return { outcome: 'refused', reason: 'tool-name-invalid' };
    }

    if (!('tool_input' in body)) {
      return { outcome: 'refused', reason: 'tool-input-missing' };
    }
    let serialised: string | undefined;
    try {
      serialised = JSON.stringify(toolInput);
    } catch {
      return { outcome: 'refused', reason: 'tool-input-not-serialisable' };
    }
    if (serialised === undefined) {
      return { outcome: 'refused', reason: 'tool-input-not-serialisable' };
    }
    if (Buffer.byteLength(serialised) > TOOL_INPUT_MAX_BYTES) {
      return { outcome: 'refused', reason: 'tool-input-too-large' };
    }

    if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > THREAD_ID_MAX_CHARS) {
      return { outcome: 'refused', reason: 'thread-id-invalid' };
    }

    // The id is ours: any requestId/id in the body is ignored.
    const requestId = this.idSource();
    const deadlineAt = this.now() + this.deadlineMs;
    const entity = new PermissionRequest({
      requestId,
      threadId,
      toolName: trimmedToolName,
      toolInput,
      requestedAtIso: this.clock.nowIso(),
      deadlineAtIso: new Date(deadlineAt).toISOString(),
    });

    // Record before waiting; a refusal (pending cap) never waits.
    const stored = this.repository.record(entity.toRecord());
    if (!stored.stored) {
      return { outcome: 'refused', reason: 'too-many-pending-requests' };
    }
    onRecorded?.(requestId);

    return this.waitForVerdict(requestId, deadlineAt);
  }

  private async waitForVerdict(
    requestId: string,
    deadlineAt: number,
  ): Promise<RequestToolPermissionOutcome> {
    while (true) {
      const record = this.repository.find(requestId);
      if (record !== undefined && record.verdict !== undefined) {
        if (record.verdict.decision === 'allow') {
          return { outcome: 'allowed', requestId };
        }
        return {
          outcome: 'denied',
          requestId,
          reason: 'owner-denied',
          message: 'the owner denied this tool call',
        };
      }
      const now = this.now();
      if (now >= deadlineAt) {
        this.repository.expire(requestId, 'timed-out', this.clock.nowIso());
        const message =
          this.deadlineMs % 1000 === 0
            ? `no verdict in ${this.deadlineMs / 1000} s`
            : `no verdict in ${this.deadlineMs} ms`;
        return { outcome: 'denied', requestId, reason: 'no-verdict', message };
      }
      const remainingMs = deadlineAt - now;
      const sleepMs = Math.max(0, Math.min(this.pollIntervalMs, remainingMs));
      await this.sleepFn(sleepMs);
    }
  }
}
