import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservationEnvelopeProps } from '../../../domain/value-objects/ObservationEnvelope.vo.js';
import { ObservationPublicationAdapter } from '../ObservationPublicationAdapter.adapter.js';
import { WavesHttpClient, type WavesRequestFn } from '../WavesHttpClient.adapter.js';

function makeObservation(overrides?: Partial<ObservationEnvelopeProps>): ObservationEnvelopeProps {
  return {
    observationId: 'obs-test-001',
    projectId: 'project-gamma',
    eventKind: 'execution:attempt:ended',
    sourceAttemptId: 'att-1234',
    payloadSummary: 'Execution attempt att-1234 ended',
    recordedAtIso: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('ObservationPublicationAdapter with WavesHttpClient', () => {
  let tempDir: string;
  let tokenFilePath: string;
  let outboxDir: string;
  const validToken = 'waves-pub-secret-token_789';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fleet-obs-pub-test-'));
    tokenFilePath = join(tempDir, 'valid.token');
    outboxDir = join(tempDir, 'outbox');
    await writeFile(tokenFilePath, `${validToken}\n`, 'utf8');
    await chmod(tokenFilePath, 0o600);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createClient(requestFn: WavesRequestFn): WavesHttpClient {
    return new WavesHttpClient({
      baseUrl: 'https://waves.internal:8443',
      tokenFile: tokenFilePath,
      request: requestFn,
    });
  }

  describe('happy path', () => {
    it('publishes observation snapshot via PUT to Waves endpoint and clears undelivered', async () => {
      let calledUrl: URL | undefined;
      let calledInit: Parameters<WavesRequestFn>[1] | undefined;

      const mockRequest: WavesRequestFn = async (url, init) => {
        calledUrl = url;
        calledInit = init;
        return {
          status: 200,
          body: JSON.stringify({ ok: true }),
        };
      };

      const adapter = new ObservationPublicationAdapter({
        client: createClient(mockRequest),
        outboxDir,
      });

      const envelope = makeObservation();
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result).toEqual({ outcome: 'published' });
      expect(calledUrl?.pathname).toBe('/api/v1/observations/obs-test-001');
      expect(calledInit?.method).toBe('PUT');
      expect(calledInit?.headers['content-type']).toBe('application/json');
      expect(calledInit?.headers['authorization']).toBe(`Bearer ${validToken}`);

      const bodyObj = JSON.parse(calledInit!.body!);
      expect(bodyObj.observationId).toBe('obs-test-001');
      expect(bodyObj.projectId).toBe('project-gamma');

      const undelivered = await adapter.listUndeliveredObservations();
      expect(undelivered).toHaveLength(0);
    });
  });

  describe('failures: write to outbox, return delivery-gap, scrub tokens', () => {
    it('on 401 reports as such, writes outbox file, records undelivered, and never leaks token', async () => {
      const mockRequest: WavesRequestFn = async () => ({
        status: 401,
        body: `Unauthorized bearer token ${validToken}`,
      });

      const adapter = new ObservationPublicationAdapter({
        client: createClient(mockRequest),
        outboxDir,
      });

      const envelope = makeObservation();
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result.outcome).toBe('delivery-gap');
      if (result.outcome === 'delivery-gap') {
        expect(result.reason).toContain('HTTP 401');
        expect(result.reason.includes(validToken)).toBe(false);
      }

      // Outbox file was written
      const outboxFilePath = join(outboxDir, 'obs-test-001.json');
      const savedContent = await readFile(outboxFilePath, 'utf8');
      const savedEnvelope = JSON.parse(savedContent);
      expect(savedEnvelope.observationId).toBe('obs-test-001');
      expect(savedContent.includes(validToken)).toBe(false);

      // Undelivered observations retained
      const undelivered = await adapter.listUndeliveredObservations('project-gamma');
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0]?.observationId).toBe('obs-test-001');
    });

    it('on timeout writes outbox file, returns delivery-gap, and never leaks token', async () => {
      const mockRequest: WavesRequestFn = async () => {
        const err = Object.assign(new Error(`Timeout with token ${validToken}`), {
          code: 'ETIMEDOUT',
        });
        throw err;
      };

      const adapter = new ObservationPublicationAdapter({
        client: createClient(mockRequest),
        outboxDir,
      });

      const envelope = makeObservation({ observationId: 'obs-timeout-002' });
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result.outcome).toBe('delivery-gap');
      if (result.outcome === 'delivery-gap') {
        expect(result.reason).toContain('ETIMEDOUT');
        expect(result.reason.includes(validToken)).toBe(false);
      }

      const outboxFilePath = join(outboxDir, 'obs-timeout-002.json');
      const savedContent = await readFile(outboxFilePath, 'utf8');
      const savedEnvelope = JSON.parse(savedContent);
      expect(savedEnvelope.observationId).toBe('obs-timeout-002');
    });

    it('on 500 error writes outbox file, returns delivery-gap, and never leaks token', async () => {
      const mockRequest: WavesRequestFn = async () => ({
        status: 500,
        body: `Server crash for token ${validToken}`,
      });

      const adapter = new ObservationPublicationAdapter({
        client: createClient(mockRequest),
        outboxDir,
      });

      const envelope = makeObservation({ observationId: 'obs-err-003' });
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result.outcome).toBe('delivery-gap');
      if (result.outcome === 'delivery-gap') {
        expect(result.reason).toContain('HTTP 500');
        expect(result.reason.includes(validToken)).toBe(false);
        expect(result.reason).toContain('[REDACTED]');
      }

      const outboxFilePath = join(outboxDir, 'obs-err-003.json');
      const savedContent = await readFile(outboxFilePath, 'utf8');
      expect(JSON.parse(savedContent).observationId).toBe('obs-err-003');
    });

    it('on request throw writes outbox file, returns delivery-gap, and never leaks token', async () => {
      const mockRequest: WavesRequestFn = async () => {
        throw new Error(`ECONNREFUSED while using token ${validToken}`);
      };

      const adapter = new ObservationPublicationAdapter({
        client: createClient(mockRequest),
        outboxDir,
      });

      const envelope = makeObservation({ observationId: 'obs-throw-004' });
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result.outcome).toBe('delivery-gap');
      if (result.outcome === 'delivery-gap') {
        expect(result.reason.includes(validToken)).toBe(false);
      }

      const outboxFilePath = join(outboxDir, 'obs-throw-004.json');
      const savedContent = await readFile(outboxFilePath, 'utf8');
      expect(JSON.parse(savedContent).observationId).toBe('obs-throw-004');
    });
  });

  describe('legacy fallback paths', () => {
    it('uses injected publisher when client is omitted', async () => {
      const mockPublish = vi.fn().mockResolvedValue({ outcome: 'published' });
      const adapter = new ObservationPublicationAdapter({ publish: mockPublish });

      const envelope = makeObservation();
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result).toEqual({ outcome: 'published' });
      expect(mockPublish).toHaveBeenCalled();
    });

    it('writes to outboxDir when neither client nor publish is configured', async () => {
      const adapter = new ObservationPublicationAdapter({ outboxDir });

      const envelope = makeObservation({ observationId: 'obs-direct-outbox' });
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result).toEqual({ outcome: 'published' });
      const outboxFilePath = join(outboxDir, 'obs-direct-outbox.json');
      const savedContent = await readFile(outboxFilePath, 'utf8');
      expect(JSON.parse(savedContent).observationId).toBe('obs-direct-outbox');
    });

    it('reports delivery-gap when nothing is configured', async () => {
      const adapter = new ObservationPublicationAdapter();
      const envelope = makeObservation({ observationId: 'obs-unconfigured' });
      const result = await adapter.publishObservationSnapshot(envelope);

      expect(result.outcome).toBe('delivery-gap');
      if (result.outcome === 'delivery-gap') {
        expect(result.reason).toContain('no observation publication boundary is configured');
      }
    });
  });
});
