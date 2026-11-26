/**
 * Shared in-memory fake of CloudProviderPort for contract tests. It is the
 * only implementation of the port (FC8E1): a real adapter does not exist yet.
 * It mirrors the semantics the later adapter must honour — injected quota,
 * availability and clock, own-descriptor request validation with no getter
 * ever invoked, and a typed refusal for every failure path.
 * This file holds no `describe`/`it`: vitest only collects `*.test.ts`.
 */

import { readExactPlainRecord } from '../../../../domain/plain-record-reads.js';
import type {
  CloudProviderPort,
  DrainHostRequest,
  DrainHostResult,
  HostClass,
  ProvisionHostRequest,
  ProvisionHostResult,
  TerminateHostRequest,
  TerminateHostResult,
} from '../CloudProviderPort.out-port.js';

/** Fake configuration: quota, availability and clock are injected, never inferred. */
export interface InMemoryCloudProviderOptions {
  readonly quota: number;
  readonly clock: () => string;
  readonly unavailable?: boolean;
}

/** One validated request as the fake recorded it, with its clock timestamp. */
export interface RecordedCloudProviderRequest {
  readonly kind: 'provision' | 'drain' | 'terminate';
  readonly requestId: string | null;
  readonly hostClass: HostClass | null;
  readonly hostId: string | null;
  readonly timestamp: string;
}

type HostState = 'ready' | 'draining';

interface StoredHost {
  readonly hostId: string;
  readonly hostClass: HostClass;
  readonly requestId: string;
  state: HostState;
}

/** Ids and host ids are fixed-shape: at most 128 characters of this class. O(1): a length check then a bounded scan. */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isValidHostClass(value: unknown): value is HostClass {
  return value === 'standard' || value === 'large';
}

/**
 * Read an untrusted request through its own property descriptors (no getter
 * ever runs) and refuse anything else. The whole read is wrapped in try/catch
 * so a revoked or throwing `Proxy` answers invalid-request instead of
 * throwing. O(1): the fixed key count is checked before any descriptor read.
 */
function readOwnKeys(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    return readExactPlainRecord(value, allowedKeys);
  } catch {
    // A revoked or throwing Proxy (or any hostile object that throws while
    // its own keys are enumerated) is refused, never propagated.
    return null;
  }
}

export class InMemoryCloudProvider implements CloudProviderPort {
  private readonly unavailable: boolean;
  private remaining: number;
  private readonly clock: () => string;
  private readonly recorded: RecordedCloudProviderRequest[] = [];
  private readonly provisionedByRequestId = new Map<string, StoredHost>();
  private readonly liveHosts = new Map<string, StoredHost>();
  private nextHostNumber = 1;

  constructor(options: InMemoryCloudProviderOptions) {
    // Non-finite, NaN or sub-1 quota floors to 0, so an exhausted or invalid
    // quota can never provision.
    this.remaining =
      Number.isFinite(options.quota) && options.quota >= 1 ? Math.floor(options.quota) : 0;
    this.unavailable = options.unavailable === true;
    this.clock = options.clock;
  }

  /** Fake-specific introspection: every validated request with its clock timestamp. */
  getRecordedRequests(): readonly RecordedCloudProviderRequest[] {
    return [...this.recorded];
  }

  async provision(request: ProvisionHostRequest): Promise<ProvisionHostResult> {
    const fields = readOwnKeys(request, ['requestId', 'hostClass']);
    if (fields === null || !isValidId(fields.requestId) || !isValidHostClass(fields.hostClass)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const requestId = fields.requestId;
    const hostClass = fields.hostClass;
    this.recorded.push({
      kind: 'provision',
      requestId,
      hostClass,
      hostId: null,
      timestamp: this.clock(),
    });

    if (this.unavailable) {
      return { ok: false, reason: 'unavailable' };
    }

    const stored = this.provisionedByRequestId.get(requestId);
    if (stored !== undefined) {
      // Idempotent replay: the same requestId with the same hostClass returns
      // the stored host without consuming additional quota, even at quota 0.
      if (stored.hostClass === hostClass) {
        return { ok: true, hostId: stored.hostId, hostClass: stored.hostClass };
      }
      return { ok: false, reason: 'invalid-request' };
    }

    if (this.remaining === 0) {
      // Refused before allocation: the requestId is not recorded as provisioned.
      return { ok: false, reason: 'quota' };
    }
    this.remaining -= 1;

    const hostId = this.allocateHostId();
    const host: StoredHost = { hostId, hostClass, requestId, state: 'ready' };
    this.provisionedByRequestId.set(requestId, host);
    this.liveHosts.set(hostId, host);
    return { ok: true, hostId, hostClass };
  }

  async drain(request: DrainHostRequest): Promise<DrainHostResult> {
    const host = this.readHost(request, 'drain');
    if (typeof host === 'string') {
      return { ok: false, reason: host };
    }
    if (host.state === 'ready') {
      host.state = 'draining';
    }
    // Already draining: idempotent.
    return { ok: true, hostId: host.hostId };
  }

  async terminate(request: TerminateHostRequest): Promise<TerminateHostResult> {
    const host = this.readHost(request, 'terminate');
    if (typeof host === 'string') {
      return { ok: false, reason: host };
    }
    if (host.state !== 'draining') {
      return { ok: false, reason: 'not-drained' };
    }
    // Terminated hosts leave the live map, so a later drain or terminate
    // answers unknown-host.
    this.liveHosts.delete(host.hostId);
    return { ok: true, hostId: host.hostId };
  }

  /**
   * Validate a hostId request and look the host up. Returns the stored host,
   * or a failure reason string ('invalid-request' | 'unknown-host').
   */
  private readHost(
    request: DrainHostRequest | TerminateHostRequest,
    kind: 'drain' | 'terminate',
  ): StoredHost | 'invalid-request' | 'unknown-host' {
    const fields = readOwnKeys(request, ['hostId']);
    if (fields === null || !isValidId(fields.hostId)) {
      return 'invalid-request';
    }
    const hostId = fields.hostId;
    this.recorded.push({
      kind,
      requestId: null,
      hostClass: null,
      hostId,
      timestamp: this.clock(),
    });
    return this.liveHosts.get(hostId) ?? 'unknown-host';
  }

  /** Allocate a host id in the fixed shape (deterministic, never random). */
  private allocateHostId(): string {
    const hostId = `host-${String(this.nextHostNumber).padStart(4, '0')}`;
    this.nextHostNumber += 1;
    return hostId;
  }
}
