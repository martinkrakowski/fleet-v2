/**
 * RelayTransportAdapter implements RelayTransportPort over the harness notice
 * channel, an injected deliverer, or a local outbox directory.
 *
 * The receipt returned here proves delivery only. A successful send is never
 * recorded as a recipient response: acceptance is a separate, recorded fact
 * that only the acknowledgement port establishes. A notice that cannot be
 * written or handed over returns a delivery gap with its reason rather than a
 * fabricated receipt.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  RelayDeliveryOutcome,
  RelayNoticeRequest,
  RelayTransportPort,
} from '../../application/ports/out/RelayTransportPort.out-port.js';

export type RelayDeliverer = (
  request: RelayNoticeRequest,
) => Promise<RelayDeliveryOutcome | void> | RelayDeliveryOutcome | void;

export interface RelayTransportAdapterOptions {
  /** Harness notice channel; its successful return is the transport receipt. */
  readonly deliver?: RelayDeliverer;
  /** Local outbox used when no deliverer is configured. */
  readonly outboxDir?: string;
}

const UNSAFE_ID = /[^A-Za-z0-9._-]/g;

function gap(reason: string): RelayDeliveryOutcome {
  return { outcome: 'delivery-gap', reason };
}

/** A gap always carries a reason, even when the channel omits one. */
function readReason(receipt: unknown, fallback: string): string {
  const reason = (receipt as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : fallback;
}

export class RelayTransportAdapter implements RelayTransportPort {
  constructor(private readonly options: RelayTransportAdapterOptions = {}) {}

  async deliverRelayNotice(request: RelayNoticeRequest): Promise<RelayDeliveryOutcome> {
    for (const field of ['requestId', 'projectId', 'recipientId', 'summary'] as const) {
      const value = request?.[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return gap(`a relay notice requires a non-empty ${field}`);
      }
    }
    const notice: RelayNoticeRequest = {
      requestId: request.requestId.trim(),
      projectId: request.projectId.trim(),
      recipientId: request.recipientId.trim(),
      summary: request.summary.trim(),
    };
    const { deliver, outboxDir } = this.options;
    if (deliver !== undefined) {
      try {
        const receipt = await deliver(notice);
        if (
          typeof receipt === 'object' &&
          receipt !== null &&
          (receipt as RelayDeliveryOutcome).outcome === 'delivery-gap'
        ) {
          return gap(readReason(receipt, 'relay channel reported a delivery gap'));
        }
        return { outcome: 'delivered' };
      } catch (error) {
        return gap(
          `relay delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (outboxDir !== undefined && outboxDir.trim().length > 0) {
      try {
        await mkdir(outboxDir, { recursive: true });
        const name = `${notice.requestId.replace(UNSAFE_ID, '-')}.json`;
        await writeFile(join(outboxDir, name), `${JSON.stringify(notice, null, 2)}\n`, 'utf8');
        return { outcome: 'delivered' };
      } catch (error) {
        return gap(
          `relay outbox write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return gap(`no relay transport boundary is configured for ${notice.requestId}`);
  }
}
