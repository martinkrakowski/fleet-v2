/**
 * `fleet-v2 telemetry record-seat-call` CLI tests: usage refusals, the
 * not-configured path, a dry-run with the redaction canary over a temp state
 * dir, and a real send through an in-process stub OTLP endpoint (a raw
 * label, a token, an endpoint and a salt never appear anywhere). Nothing
 * here touches the network beyond the loopback stub.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import { seatCallSpan, type RecordSeatCallResult } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from './composition.js';
import { composeTelemetry } from './composition/telemetry.js';
import { runCli, type CliIo } from './index.js';
import { telemetryCommand } from './telemetry.js';

const SALT = '0123456789abcdef'.repeat(4);
const EXAMPLE_TOKEN = 'example-token';
const RAW_LABEL = 'example-seat-label-lane-a';
const NOW = new Date('2026-10-30T12:00:00.000Z');

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

async function runRecordSeatCall(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(['telemetry', 'record-seat-call', ...args], io, runtime);
  const result = { code, stdout: io.outLines, stderr: io.errLines };
  const printed = JSON.stringify(result);
  expect(printed).not.toContain(SALT);
  expect(printed).not.toContain(EXAMPLE_TOKEN);
  return result;
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

const HOSTS = {
  local: {
    transport: 'local' as const,
    worktreeRoot: '/tmp/fleet-record-seat-call-worktrees',
    roles: ['orchestrator', 'lane-runner'] as ('orchestrator' | 'lane-runner')[],
    runner: {
      kind: 'opencode' as const,
      port: 46000,
      capabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        filesystemScope: 'scoped-worktree' as const,
      },
      maxLanes: 2,
    },
  },
};

function makeInstallation(): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: HOSTS,
    forge: { mode: 'none' },
    policy: {
      telemetry: { enabled: true, salt: SALT },
    },
  };
}

/** A fake runtime for the refusals that must not reach the use case. */
interface FakeTelemetryOverrides {
  readonly recordSeatCall?: { execute: (request: unknown) => Promise<RecordSeatCallResult> } | null;
  readonly configured?: FleetCliRuntime['telemetry']['configured'];
}

function fakeRuntime(overrides: FakeTelemetryOverrides = {}): FleetCliRuntime {
  return {
    telemetry: {
      acceptanceReceiptRead: {},
      dispositions: { read: async () => ({ outcome: 'unreadable' }) },
      exportTelemetry: null,
      recordSeatCall: overrides.recordSeatCall ?? null,
      configured: overrides.configured ?? 'configured',
      saltFingerprint: null,
      policy: {
        enabled: true,
        projectName: 'fleet-lanes',
        route: 'collector',
        sampleRatio: 1,
        sendCost: true,
        includeDryRun: true,
        projectAliases: {},
      },
      resource: { serviceVersion: '0.0.0', projectName: 'fleet-lanes' },
      canaryValues: async () => [],
    },
  } as unknown as FleetCliRuntime;
}

describe('telemetry record-seat-call usage refusals', () => {
  it('rejects unknown or metered --tool with exit 2', async () => {
    let called = 0;
    const runtime = fakeRuntime({
      recordSeatCall: {
        execute: async () => {
          called += 1;
          return { outcome: 'refused', reason: 'invalid-request' };
        },
      },
    });
    for (const args of [
      ['--tool', 'opencode', '--outcome', 'ok', '--wall-seconds', '1'],
      ['--tool', 'review-cli', '--outcome', 'ok', '--wall-seconds', '1'],
      ['--tool', 'openrouter/example', '--outcome', 'ok', '--wall-seconds', '1'],
      ['--tool', 'example-mistake', '--outcome', 'ok', '--wall-seconds', '1'],
      ['--outcome', 'ok', '--wall-seconds', '1'],
      ['--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', '--tool', 'grok'],
    ]) {
      const result = await runRecordSeatCall(runtime, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stdout, args.join(' ')).toEqual([]);
      expect(result.stderr, args.join(' ')).toHaveLength(1);
      expect(result.stderr.join(''), args.join(' ')).toContain('--tool');
      expect(result.stderr.join(''), args.join(' ')).not.toContain('example-mistake');
      expect(result.stderr.join(''), args.join(' ')).not.toContain('openrouter');
    }
    expect(called).toBe(0);
  });

  it('rejects invalid outcome, wall-seconds, deadline, label, and flag combinations with exit 2', async () => {
    let called = 0;
    const runtime = fakeRuntime({
      recordSeatCall: {
        execute: async () => {
          called += 1;
          return { outcome: 'refused', reason: 'invalid-request' };
        },
      },
    });
    const base = ['--tool', 'agy'];
    const cases: Array<[readonly string[], string]> = [
      [['--outcome', 'done', '--wall-seconds', '1'], '--outcome'],
      [['--outcome', 'completed', '--wall-seconds', '1'], '--outcome'],
      [['--outcome', 'ok'], '--wall-seconds'],
      [['--outcome', 'ok', '--wall-seconds', '-1'], '--wall-seconds'],
      [['--outcome', 'ok', '--wall-seconds', 'abc'], '--wall-seconds'],
      [['--outcome', 'ok', '--wall-seconds', 'NaN'], '--wall-seconds'],
      [['--outcome', 'ok', '--wall-seconds', 'Infinity'], '--wall-seconds'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--deadline', '0'], '--deadline'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--deadline', '601'], '--deadline'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--deadline', '1.5'], '--deadline'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--label', ''], '--label'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--label', 'x'.repeat(1025)], '--label'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--label', 'lane\u{D800}'], '--label'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--canary'], '--canary requires --dry-run'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--frob'], 'Unknown telemetry record-seat-call option'],
      [['--outcome', 'ok', '--wall-seconds', '1', '--json', '--json'], 'Repeated flag'],
      [['--outcome', 'ok', '--wall-seconds', '1', 'stray'], 'Unknown telemetry record-seat-call option'],
    ];
    for (const [extra, fragment] of cases) {
      const result = await runRecordSeatCall(runtime, [...base, ...extra]);
      expect(result.code, extra.join(' ')).toBe(2);
      expect(result.stdout, extra.join(' ')).toEqual([]);
      expect(result.stderr, extra.join(' ')).toHaveLength(1);
      expect(result.stderr.join(''), extra.join(' ')).toContain(fragment);
    }
    expect(called).toBe(0);
  });

  it('usage errors never echo a caller value', async () => {
    const runtime = fakeRuntime();
    for (const args of [
      ['--tool', 'example-mistake', '--outcome', 'ok', '--wall-seconds', '1'],
      ['--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', '--label='],
    ]) {
      const result = await runRecordSeatCall(runtime, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr.join(''), args.join(' ')).not.toContain('example-mistake');
      expect(result.stderr.join(''), args.join(' ')).not.toContain('example-token');
    }
  });

  it('exits 1 with not-configured when endpoint or token file is missing in send mode', async () => {
    let called = 0;
    const runtime = fakeRuntime({
      recordSeatCall: {
        execute: async () => {
          called += 1;
          return { outcome: 'exported', spanId: 'span-example-1' };
        },
      },
      configured: 'no-endpoint',
    });
    const result = await runRecordSeatCall(runtime, ['--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1']);
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([]);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('not-configured');
    expect(document.configured).toBe('no-endpoint');
    expect(called).toBe(0);
  });

  it('not-configured without a use case exits 1 before send mode', async () => {
    const runtime = fakeRuntime({ recordSeatCall: null });
    for (const dryRun of [[], ['--dry-run']]) {
      const result = await runRecordSeatCall(runtime, ['--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', ...dryRun]);
      expect(result.code).toBe(1);
      const document = parseDocument(result.stdout);
      expect(document.outcome).toBe('not-configured');
    }
  });

  it('dry-run works without a configured endpoint', async () => {
    let called = 0;
    const runtime = fakeRuntime({
      recordSeatCall: {
        execute: async () => {
          called += 1;
          return { outcome: 'dry-run', span: FIXTURE_SPAN };
        },
      },
      configured: 'no-endpoint',
    });
    const result = await runRecordSeatCall(runtime, [
      '--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', '--dry-run',
    ]);
    expect(result.code).toBe(0);
    expect(called).toBe(1);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('dry-run');
    expect(document.encodeRefused).toBe(0);
  });
});

/** A real span built through the domain, for the fake dry-run above. */
const FIXTURE_SPAN = seatCallSpan(
  (message) => new Uint8Array(createHash('sha256').update(message, 'utf8').digest()),
  {
    callId: 'call-example-1',
    tool: 'agy',
    outcome: 'ok',
    wallSeconds: 1,
    nowIso: '2026-10-30T12:00:00.000Z',
    label: null,
  },
)!;

describe('telemetry record-seat-call end to end', () => {
  let server: Server;
  let bodies: string[];
  let endpoint: string;
  let tokenFile: string;
  let stateDir: string;
  let previousEndpoint: string | undefined;
  let previousTokenFile: string | undefined;
  let hangForever = false;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        if (hangForever) {
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ partialSuccess: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
    tokenFile = join(mkdtempSync(join(tmpdir(), 'fleet-seat-call-token-')), 'token');
    await fs.writeFile(tokenFile, EXAMPLE_TOKEN, 'utf8');
    previousEndpoint = process.env.FLEET_TELEMETRY_ENDPOINT;
    previousTokenFile = process.env.FLEET_TELEMETRY_TOKEN_FILE;
  });

  afterAll(async () => {
    if (previousEndpoint === undefined) {
      delete process.env.FLEET_TELEMETRY_ENDPOINT;
    } else {
      process.env.FLEET_TELEMETRY_ENDPOINT = previousEndpoint;
    }
    if (previousTokenFile === undefined) {
      delete process.env.FLEET_TELEMETRY_TOKEN_FILE;
    } else {
      process.env.FLEET_TELEMETRY_TOKEN_FILE = previousTokenFile;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    bodies = [];
    hangForever = false;
    process.env.FLEET_TELEMETRY_ENDPOINT = endpoint;
    process.env.FLEET_TELEMETRY_TOKEN_FILE = tokenFile;
    stateDir = mkdtempSync(join(tmpdir(), 'fleet-seat-call-state-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function makeRuntime(): FleetCliRuntime {
    return createFleetCliRuntime({ stateDir, installation: makeInstallation() });
  }

  it('a dry-run with --canary passes redactionChecks with billing=plan, a hashed label, no raw label and no forbidden attributes', async () => {
    const runtime = makeRuntime();
    const result = await runRecordSeatCall(runtime, [
      '--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '12.5',
      '--label', RAW_LABEL, '--dry-run', '--canary',
    ]);
    expect(result.code).toBe(0);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('dry-run');
    expect(document.encodeRefused).toBe(0);
    const printed = JSON.stringify(result.stdout);
    expect(printed).not.toContain(RAW_LABEL);
    const span = document.span as Record<string, unknown>;
    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes['fleet.seat.billing']).toBe('plan');
    expect(attributes['fleet.seat.tool']).toBe('agy');
    expect(attributes['fleet.outcome']).toBe('ok');
    expect(attributes['fleet.usage.wall_seconds']).toBe(12.5);
    expect(attributes['fleet.seat.label_digest']).toMatch(/^[0-9a-f]{16}$/);
    expect(attributes['openinference.span.kind']).toBe('AGENT');
    expect(span.name).toBe('seat-call');
    // No forbidden attribute is present.
    for (const key of Object.keys(attributes)) {
      expect(key.startsWith('llm.')).toBe(false);
      expect(key.startsWith('fleet.cost.')).toBe(false);
      expect(key).not.toBe('llm.provider');
      expect(key).not.toBe('llm.model_name');
      expect(key).not.toBe('session.id');
    }
    const canary = document.canary as { pass: boolean };
    expect(canary.pass).toBe(true);
  });

  it('a send over the stub endpoint exports and never carries the raw label or token', async () => {
    const runtime = makeRuntime();
    const result = await runRecordSeatCall(runtime, [
      '--tool', 'grok', '--outcome', 'error', '--wall-seconds', '3',
      '--label', RAW_LABEL,
    ]);
    expect(result.code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(RAW_LABEL);
    expect(bodies[0]).not.toContain(EXAMPLE_TOKEN);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('exported');
    expect(document.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a wrong-label digest is not derivable by a caller and the send stays exported', async () => {
    const runtime = makeRuntime();
    const result = await runRecordSeatCall(runtime, ['--tool', 'claude', '--outcome', 'empty', '--wall-seconds', '0']);
    expect(result.code).toBe(0);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('exported');
    // No label was given, so the span carries no label digest.
    const io = captureIo();
    await telemetryCommand(['record-seat-call', '--tool', 'claude', '--outcome', 'empty', '--wall-seconds', '0', '--dry-run'], io, runtime, {});
    const dryRun = parseDocument(io.outLines);
    const attributes = (dryRun.span as Record<string, unknown>).attributes as Record<string, unknown>;
    expect('fleet.seat.label_digest' in attributes).toBe(false);
  });

  it('endpoint down or slow exits 1 within bounded deadline without hanging', async () => {
    hangForever = true;
    const runtime = makeRuntime();
    const startedAt = Date.now();
    const result = await runRecordSeatCall(runtime, [
      '--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', '--deadline', '1',
    ]);
    const elapsed = Date.now() - startedAt;
    expect(result.code).toBe(1);
    expect(elapsed).toBeLessThan(30_000);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('send-failed');
    const printed = JSON.stringify(result.stdout);
    expect(printed).not.toContain(endpoint);
    expect(printed).not.toContain(EXAMPLE_TOKEN);
  });

  it('send-failed from a missing or rejecting send exits 1 echoing no value', async () => {
    const runtime = fakeRuntime({
      recordSeatCall: {
        execute: async () => ({ outcome: 'send-failed', errorKind: 'unknown' }),
      },
    });
    const result = await runRecordSeatCall(runtime, [
      '--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1',
    ]);
    expect(result.code).toBe(1);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('send-failed');
    expect(document.errorKind).toBe('unknown');
    expect(result.stderr).toEqual([]);
  });

  it('dry-run encoding refuses a span the encoder cannot carry, and the canary is a pass when the payload is empty', async () => {
    const runtime = fakeRuntime({
      recordSeatCall: {
        execute: async () => {
          // A dry-run whose span is not the domain's own span: the encoder
          // refuses it whole and the exit is 1.
          return { outcome: 'dry-run', span: { name: 'seat-call' } as never };
        },
      },
    });
    const result = await runRecordSeatCall(runtime, [
      '--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', '--dry-run',
    ]);
    expect(result.code).toBe(1);
    const document = parseDocument(result.stdout);
    expect(document.encodeRefused).toBe(1);
  });

  it('the composed runtime always exposes a null record-seat-call without a salt', async () => {
    const composeResult = composeTelemetry({
      policy: {
        enabled: true,
        salt: null,
        projectName: 'fleet-lanes',
        route: 'collector',
        sampleRatio: 1,
        sendCost: false,
        includeDryRun: true,
        projectAliases: {},
      },
      env: {},
    });
    expect(composeResult.telemetry.recordSeatCall).toBeNull();
  });

  it('a dry-run with a label prints the span with the plan billing class and no raw label', async () => {
    const runtime = makeRuntime();
    const io = captureIo();
    await telemetryCommand(
      ['record-seat-call', '--tool', 'agy', '--outcome', 'ok', '--wall-seconds', '1', '--label', RAW_LABEL, '--dry-run'],
      io,
      runtime,
      { now: () => NOW },
    );
    expect(io.outLines).toHaveLength(1);
    const printed = io.outLines.join('');
    expect(printed).not.toContain(RAW_LABEL);
    expect(printed).not.toContain(EXAMPLE_TOKEN);
    const document = JSON.parse(printed) as Record<string, unknown>;
    const span = document.span as Record<string, unknown>;
    const attributes = span.attributes as Record<string, unknown>;
    expect(attributes['fleet.seat.billing']).toBe('plan');
    expect(attributes['fleet.seat.label_digest']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(attributes)).not.toContain(RAW_LABEL);
  });
});
