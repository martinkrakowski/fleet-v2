/**
 * ObservationPublicationAdapter implements ObservationPublicationPort against
 * the existing Waves client boundary: a Waves HTTP client, an injected publisher,
 * a local outbox, or neither.
 *
 * A publication that fails is retained as an undelivered observation with its
 * reason, so `listUndeliveredObservations` still returns the fact instead of it
 * disappearing. An observation that later publishes successfully is released
 * from that list. When publication over HTTP fails (non-2xx, timeout or throw),
 * the outbox file is written as a retry queue and a delivery-gap outcome is returned.
 * A 401 is reported as such and never retried with another token. Nothing is
 * retried as a different fact, and no token is exposed to agents through this adapter.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ObservationEnvelopeProps } from '../../domain/value-objects/ObservationEnvelope.vo.js';
import { ObservationEnvelope } from '../../domain/value-objects/ObservationEnvelope.vo.js';
import type {
  ObservationPublicationOutcome,
  ObservationPublicationPort,
} from '../../application/ports/out/ObservationPublicationPort.out-port.js';
import type { WavesHttpClient } from './WavesHttpClient.adapter.js';
import { scrubAndTruncate } from './WavesHttpClient.adapter.js';

export type ObservationPublisher = (
  envelope: ObservationEnvelopeProps,
) => Promise<ObservationPublicationOutcome | void> | ObservationPublicationOutcome | void;

export interface ObservationPublicationAdapterOptions {
  /** Existing Waves client boundary; its successful return is the receipt. */
  readonly publish?: ObservationPublisher;
  /** Local outbox used when no publisher is configured, or as fallback on failure. */
  readonly outboxDir?: string;
  /** Waves HTTP client boundary for live observation publication. */
  readonly client?: WavesHttpClient;
}

const UNSAFE_ID = /[^A-Za-z0-9._-]/g;

/** A gap always carries a reason, even when the boundary omits one. */
function readReason(receipt: unknown, fallback: string): string {
  const reason = (receipt as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : fallback;
}

export class ObservationPublicationAdapter implements ObservationPublicationPort {
  private readonly undelivered = new Map<string, ObservationEnvelopeProps>();

  constructor(private readonly options: ObservationPublicationAdapterOptions = {}) {}

  async publishObservationSnapshot(
    envelope: ObservationEnvelopeProps,
  ): Promise<ObservationPublicationOutcome> {
    const created = ObservationEnvelope.create(envelope);
    if (!created.success || created.value === undefined) {
      return {
        outcome: 'delivery-gap',
        reason: created.error?.message ?? 'observation envelope is not publishable',
      };
    }
    const props = created.value.getProps();
    const published = await this.publishThroughBoundary(props);
    if (published.outcome === 'delivery-gap') {
      // The fact stays visible and undelivered instead of being dropped.
      this.undelivered.set(props.observationId, props);
      return published;
    }
    this.undelivered.delete(props.observationId);
    return published;
  }

  async listUndeliveredObservations(
    projectId?: string,
  ): Promise<readonly ObservationEnvelopeProps[]> {
    const wanted =
      typeof projectId === 'string' && projectId.trim().length > 0 ? projectId.trim() : undefined;
    return [...this.undelivered.values()]
      .filter((envelope) => wanted === undefined || envelope.projectId === wanted)
      .map((envelope) => ({ ...envelope }));
  }

  private async publishThroughBoundary(
    envelope: ObservationEnvelopeProps,
  ): Promise<ObservationPublicationOutcome> {
    const { client, publish, outboxDir } = this.options;
    if (client !== undefined) {
      let failureReason: string | undefined;
      try {
        const id = encodeURIComponent(envelope.observationId);
        const response = await client.put(`/api/v1/observations/${id}`, envelope);
        if (response.status < 200 || response.status >= 300) {
          if (response.status === 401) {
            failureReason = `observation publication failed: HTTP 401 unauthorized`;
          } else {
            const snippet = scrubAndTruncate(client.scrub(response.body));
            failureReason = `observation publication failed: HTTP ${response.status}${snippet ? ` - ${snippet}` : ''}`;
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failureReason = `observation publication failed: ${client.scrub(msg)}`;
      }

      if (failureReason !== undefined) {
        if (outboxDir !== undefined && outboxDir.trim().length > 0) {
          try {
            await this.writeOutboxFile(outboxDir, envelope);
          } catch (writeError) {
            failureReason = `${failureReason}; outbox write failed: ${
              writeError instanceof Error ? writeError.message : String(writeError)
            }`;
          }
        }
        return {
          outcome: 'delivery-gap',
          reason: failureReason,
        };
      }

      return { outcome: 'published' };
    }

    if (publish !== undefined) {
      try {
        const receipt = await publish(envelope);
        if (
          typeof receipt === 'object' &&
          receipt !== null &&
          (receipt as ObservationPublicationOutcome).outcome === 'delivery-gap'
        ) {
          const reason = readReason(receipt, 'publication boundary reported a delivery gap');
          if (outboxDir !== undefined && outboxDir.trim().length > 0) {
            try {
              await this.writeOutboxFile(outboxDir, envelope);
            } catch {
              // outbox write failure preserved
            }
          }
          return {
            outcome: 'delivery-gap',
            reason,
          };
        }
        return { outcome: 'published' };
      } catch (error) {
        const reason = `observation publication failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (outboxDir !== undefined && outboxDir.trim().length > 0) {
          try {
            await this.writeOutboxFile(outboxDir, envelope);
          } catch {
            // outbox write failure preserved
          }
        }
        return {
          outcome: 'delivery-gap',
          reason,
        };
      }
    }

    if (outboxDir !== undefined && outboxDir.trim().length > 0) {
      try {
        await this.writeOutboxFile(outboxDir, envelope);
        return { outcome: 'published' };
      } catch (error) {
        return {
          outcome: 'delivery-gap',
          reason: `observation outbox write failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    return {
      outcome: 'delivery-gap',
      reason: `no observation publication boundary is configured for ${envelope.observationId}`,
    };
  }

  private async writeOutboxFile(
    outboxDir: string,
    envelope: ObservationEnvelopeProps,
  ): Promise<void> {
    await mkdir(outboxDir, { recursive: true });
    const name = `${envelope.observationId.replace(UNSAFE_ID, '-')}.json`;
    await writeFile(
      join(outboxDir, name),
      `${JSON.stringify(envelope, null, 2)}\n`,
      'utf8',
    );
  }
}
