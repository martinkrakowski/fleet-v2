/**
 * Redaction tests (plan §3.2, OT1r): `redactionChecks` over a stub mapper and
 * a stub encoder that live in this file, because the nominal `TelemetrySpan`,
 * the mapper and the encoder are later lanes (OT1a-3, OT1b, OT3a). The stub
 * mapper builds attributes only from digests (`telemetryDigest`), enums,
 * counts and the run id, and passes each through `filterTelemetryAttributes`.
 * Names are `example` names only; the HMAC salt is an obvious fixture string,
 * never a real secret, and every secret-shaped test string is built by
 * concatenation at run time so no literal in this file matches a secret
 * pattern or the lane diff check.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  filterTelemetryAttributes,
  RUN_TELEMETRY_ATTRIBUTES,
  TELEMETRY_SERVICE_NAME,
  telemetryInvocationParameters,
  telemetryResourceAttributes,
  type TelemetryAttributeValue,
  type TelemetrySpanKind,
} from '../run-telemetry-attributes.js';
import {
  telemetryDigest,
  telemetryHashInput,
  type TelemetryHmac,
} from '../run-telemetry-ids.js';
import {
  redactionChecks,
  TELEMETRY_REDACTION_CHECKS,
  type TelemetryRedactionCheck,
  type TelemetryRedactionCheckResult,
  type TelemetryRedactionReport,
} from '../run-telemetry-redaction.js';

const SALT = 'example-telemetry-salt-fixture';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();

const RUN_ID = 'run-01JB0000000000000000000000';
const WORK_ORDER_ID = 'example-work-order-1';
const ATTEMPT_ID = 'example-attempt-1';

/** The salted digest of a fixture id (the domain's own digest path). */
function digestOf(kind: 'work-order' | 'attempt' | 'project', raw: string): string {
  const input = telemetryHashInput(raw);
  if (input === null) {
    throw new Error(`fixture hash input refused: ${kind}`);
  }
  const digest = telemetryDigest(hmac, kind, input);
  if (digest === null) {
    throw new Error(`fixture digest failed: ${kind}`);
  }
  return digest;
}

/** A fixture attempt, journal entry, receipt or run, as the mapper would see it. */
interface StubFixture {
  readonly spanKind: TelemetrySpanKind;
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly project: string;
  readonly step: string;
  readonly tags: readonly string[];
  readonly round: number;
  readonly seatIndex: number;
  readonly seatTool: string;
  readonly seatBilling: string;
  readonly seatModel: string;
  readonly seatProvider: string;
  readonly findingsBlocker: number;
  readonly findingsMajor: number;
  readonly findingsMinor: number;
  readonly findingsNit: number;
  readonly gateExitCode: number;
  readonly costBasis: string;
  readonly usageSource: string;
  readonly wallSeconds: number;
  readonly prNumber: number;
  readonly head12: string;
  readonly meteredLlm: boolean;
  /** Free text below: the mapper drops every one of these, never sent. */
  readonly worktreePath: string;
  readonly briefPath: string;
  readonly host: string;
  readonly hostId: string;
  readonly detail: string;
  readonly findingSummary: string;
  readonly findingPath: string;
  readonly dispositionReason: string;
  readonly procedureName: string;
  readonly evidenceRef: string;
  readonly branch: string;
  readonly receiptId: string;
}

const CANARY_TEXT_FIELDS = [
  'worktreePath', 'briefPath', 'host', 'hostId', 'detail', 'findingSummary', 'findingPath',
  'dispositionReason', 'procedureName', 'evidenceRef', 'branch', 'receiptId',
] as const;

function baseFixture(spanKind: TelemetrySpanKind, overrides: Partial<StubFixture> = {}): StubFixture {
  return {
    spanKind,
    runId: RUN_ID,
    workOrderId: WORK_ORDER_ID,
    attemptId: ATTEMPT_ID,
    project: 'example-project',
    step: 'dispatch',
    tags: ['conducted'],
    round: 0,
    seatIndex: 0,
    seatTool: 'opencode',
    seatBilling: 'metered',
    seatModel: 'example-model',
    seatProvider: 'example-provider',
    findingsBlocker: 0,
    findingsMajor: 1,
    findingsMinor: 2,
    findingsNit: 3,
    gateExitCode: 0,
    costBasis: 'metered',
    usageSource: 'opencode-db',
    wallSeconds: 12.5,
    prNumber: 42,
    head12: '0123456789ab',
    meteredLlm: false,
    worktreePath: '',
    briefPath: '',
    host: '',
    hostId: '',
    detail: '',
    findingSummary: '',
    findingPath: '',
    dispositionReason: '',
    procedureName: '',
    evidenceRef: '',
    branch: '',
    receiptId: '',
    ...overrides,
  };
}

/** Every free-text field and every operator id set to `CANARY-<field>` (plan test 1). */
function canaryOverrides(): Partial<StubFixture> {
  const overrides: Record<string, string> = { workOrderId: 'CANARY-work-order', attemptId: 'CANARY-attempt', project: 'CANARY-project' };
  for (const field of CANARY_TEXT_FIELDS) {
    overrides[field] = `CANARY-${field}`;
  }
  return overrides as Partial<StubFixture>;
}

/**
 * The stub mapper: only digests, enums, counts and the run id reach the
 * candidate attributes; everything free-text is dropped, and each survivor
 * passes `filterTelemetryAttributes`.
 */
function stubMap(fixture: StubFixture): Readonly<Record<string, TelemetryAttributeValue>> {
  const meteredLlm = fixture.meteredLlm
    ? {
        'llm.model_name': fixture.seatModel,
        'llm.provider': fixture.seatProvider,
        'llm.invocation_parameters': telemetryInvocationParameters('example-variant') ?? '',
        'llm.token_count.prompt': 120,
        'llm.token_count.completion': 80,
        'llm.token_count.total': 200,
        'llm.cost.total': 0.25,
      }
    : {};
  const candidate: Record<string, TelemetryAttributeValue | undefined> = {
    'fleet.run.id': fixture.runId,
    'fleet.work_order.digest': digestOf('work-order', fixture.workOrderId),
    'session.id': digestOf('work-order', fixture.workOrderId),
    'fleet.attempt.digest': digestOf('attempt', fixture.attemptId),
    'fleet.project': fixture.project,
    'fleet.step': fixture.step,
    'fleet.round': fixture.round,
    'fleet.seat.index': fixture.seatIndex,
    'fleet.seat.tool': fixture.seatTool,
    'fleet.seat.billing': fixture.seatBilling,
    'fleet.seat.model': fixture.seatModel,
    'fleet.seat.provider': fixture.seatProvider,
    'fleet.review.findings.blocker': fixture.findingsBlocker,
    'fleet.review.findings.major': fixture.findingsMajor,
    'fleet.review.findings.minor': fixture.findingsMinor,
    'fleet.review.findings.nit': fixture.findingsNit,
    'fleet.gate.exit_code': fixture.gateExitCode,
    'fleet.cost.basis': fixture.costBasis,
    'fleet.usage.source': fixture.usageSource,
    'fleet.usage.wall_seconds': fixture.wallSeconds,
    'fleet.pr.number': fixture.prNumber,
    'fleet.head12': fixture.head12,
    'tag.tags': fixture.tags,
    ...meteredLlm,
  };
  const present: Record<string, TelemetryAttributeValue> = {};
  for (const key of Object.keys(candidate)) {
    const value = candidate[key];
    if (value !== undefined) {
      present[key] = value;
    }
  }
  return filterTelemetryAttributes(present, fixture.spanKind);
}

interface StubSpan {
  readonly spanKind: TelemetrySpanKind;
  /** The fixed §3.1 name the stub encoder emits for the span's kind. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
}

/** The plan's fixed span name for each span kind, for the stub encoder (§3.1). */
const PLAN_SPAN_NAME_BY_KIND: Record<TelemetrySpanKind, string> = {
  CHAIN: 'lane-run',
  AGENT: 'attempt',
  LLM: 'usage',
  GUARDRAIL: 'gate',
  EVALUATOR: 'brief-check',
  DECISION: 'accept',
  TOOL: 'merge',
};

interface StubResource {
  readonly serviceVersion?: string;
  readonly projectName?: string;
}

/** The OTLP/JSON attribute value shape for one filtered attribute. */
function attributeValueToJson(key: string, value: TelemetryAttributeValue): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  const rule = RUN_TELEMETRY_ATTRIBUTES[key];
  if (rule !== undefined && rule.type === 'int') {
    return { intValue: value };
  }
  return { doubleValue: value };
}

/** The stub encoder: writes the OTLP/JSON shape the payload format defines. */
function stubEncode(spans: readonly StubSpan[], resource: StubResource): Uint8Array {
  const resourceAttributes = telemetryResourceAttributes({
    serviceVersion: resource.serviceVersion ?? '1.0.0',
    projectName: resource.projectName ?? 'example-project',
  });
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(resourceAttributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
        },
        scopeSpans: [
          {
            spans: spans.map((span) => ({
              name: span.name,
              attributes: [
                { key: 'openinference.span.kind', value: { stringValue: span.spanKind } },
                { key: 'fleet.telemetry.schema', value: { intValue: 1 } },
                ...Object.entries(span.attributes).map(([key, value]) => ({ key, value: attributeValueToJson(key, value) })),
              ],
            })),
          },
        ],
      },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function spanOf(fixture: StubFixture): StubSpan {
  return { spanKind: fixture.spanKind, name: PLAN_SPAN_NAME_BY_KIND[fixture.spanKind], attributes: stubMap(fixture) };
}

/** The stub payload: one span per kind, with a metered LLM span. */
function stubPayload(): Uint8Array {
  return stubEncode(
    [
      spanOf(baseFixture('AGENT')),
      spanOf(baseFixture('LLM', { meteredLlm: true })),
      spanOf(baseFixture('TOOL')),
      spanOf(baseFixture('CHAIN')),
    ],
    {},
  );
}

/** A hand-written attribute of a hand-built payload. */
interface HandAttribute {
  readonly key: string;
  readonly value: Record<string, unknown>;
}

/** Hand-built span attributes that pass every other check. */
function handSpanAttributes(extra: readonly HandAttribute[]): readonly HandAttribute[] {
  return [
    { key: 'fleet.telemetry.schema', value: { intValue: 1 } },
    { key: 'fleet.run.id', value: { stringValue: RUN_ID } },
    ...extra,
  ];
}

/** Extra span and scope shape knobs for hand-built payloads. */
interface HandSpanExtras {
  readonly name?: string;
  readonly status?: unknown;
  readonly events?: unknown;
  readonly links?: unknown;
  readonly scope?: { readonly name?: string; readonly attributes?: readonly HandAttribute[] };
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A hand-written OTLP/JSON payload with one resource and one span. */
function handPayload(
  resourceAttributes: readonly HandAttribute[],
  spanAttributes: readonly HandAttribute[],
  spanKind: string,
  extras: HandSpanExtras = {},
): Uint8Array {
  const span: Record<string, unknown> = {
    name: extras.name ?? 'attempt',
    attributes: [{ key: 'openinference.span.kind', value: { stringValue: spanKind } }, ...spanAttributes],
  };
  if (extras.status !== undefined) {
    span.status = extras.status;
  }
  if (extras.events !== undefined) {
    span.events = extras.events;
  }
  if (extras.links !== undefined) {
    span.links = extras.links;
  }
  if (extras.extra !== undefined) {
    Object.assign(span, extras.extra);
  }
  const scopeSpansItem: Record<string, unknown> = { spans: [span] };
  if (extras.scope !== undefined) {
    const scope: Record<string, unknown> = {};
    if (extras.scope.name !== undefined) {
      scope.name = extras.scope.name;
    }
    if (extras.scope.attributes !== undefined) {
      scope.attributes = extras.scope.attributes;
    }
    scopeSpansItem.scope = scope;
  }
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [scopeSpansItem],
      },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

const RESOURCE_NAME_ONLY: readonly HandAttribute[] = [{ key: 'service.name', value: { stringValue: TELEMETRY_SERVICE_NAME } }];

/** The report entry for one check name. */
function check(report: TelemetryRedactionReport, name: TelemetryRedactionCheck): TelemetryRedactionCheckResult {
  const found = report.checks.find((entry) => entry.check === name);
  if (found === undefined) {
    throw new Error(`missing check: ${name}`);
  }
  return found;
}

/** Report hygiene: the serialised report names no canary, key or value. */
function expectNoLeak(report: TelemetryRedactionReport, secrets: readonly string[]): void {
  const text = JSON.stringify(report);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

/** Fully escapes every code point as a `\u00XX` sequence, JSON-safe and literal-free. */
function escapeJsonUnicode(text: string): string {
  return Array.from(text)
    .map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
}

/** Re-writes the canonical text so one value object carries a duplicate JSON key (`intValue` twice). */
function withDuplicateJsonKey(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const replaced = text.replace('"intValue":1', '"intValue":1,"intValue":1');
  expect(replaced).not.toBe(text);
  return new TextEncoder().encode(replaced);
}

/** Re-writes the canonical text so the double 2.0251027e7 appears as the exponent literal. */
function withExponentNumber(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const replaced = text.replace('20251027', '2.0251027e7');
  expect(replaced).not.toBe(text);
  expect(replaced).not.toContain('20251027');
  return new TextEncoder().encode(replaced);
}

describe('redactionChecks (OT1r)', () => {
  it('drops every canary string field and passes (plan test 1)', () => {
    const fixtures = [
      baseFixture('AGENT', canaryOverrides()),
      baseFixture('LLM', { meteredLlm: true, ...canaryOverrides() }),
      baseFixture('TOOL', canaryOverrides()),
      baseFixture('CHAIN', canaryOverrides()),
    ];
    const bytes = stubEncode(fixtures.map(spanOf), { projectName: 'CANARY-project', serviceVersion: 'CANARY-version' });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('CANARY');

    const payload = JSON.parse(text) as { resourceSpans: [{ resource: { attributes: { key: string }[] } }] };
    const resourceKeys = payload.resourceSpans[0].resource.attributes.map((attribute) => attribute.key);
    // The invalid project alias and build version were dropped by the mapper.
    expect(resourceKeys).toEqual(['service.name']);

    const canaries = [
      ...CANARY_TEXT_FIELDS.map((field) => `CANARY-${field}`),
      'CANARY-work-order',
      'CANARY-attempt',
      'CANARY-project',
      'CANARY-version',
    ];
    const report = redactionChecks(bytes, canaries);
    expect(report.pass).toBe(true);
    expect(report.checks.every((entry) => entry.pass)).toBe(true);
  });

  it('sends operator ids only as their 16-hex digests (plan test 2)', () => {
    const workOrderBranch = 'feat/acme-billing-CANARY';
    const workOrderClient = 'CANARY Client Ltd';
    const attemptId = workOrderBranch + '#1';
    const bytes = stubEncode(
      [
        spanOf(baseFixture('AGENT', { workOrderId: workOrderBranch, attemptId })),
        spanOf(baseFixture('CHAIN', { workOrderId: workOrderClient })),
      ],
      {},
    );
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(workOrderBranch);
    expect(text).not.toContain(workOrderClient);
    expect(text).not.toContain(attemptId);
    expect(text).toContain(digestOf('work-order', workOrderBranch));
    expect(text).toContain(digestOf('work-order', workOrderClient));
    expect(text).toContain(digestOf('attempt', attemptId));
    const report = redactionChecks(bytes, [workOrderBranch, workOrderClient, attemptId]);
    expect(report.pass).toBe(true);
    expectNoLeak(report, [workOrderBranch, workOrderClient, attemptId]);
  });

  it('the stub payload passes every check (plan test 3)', () => {
    const report = redactionChecks(stubPayload(), []);
    expect(report.pass).toBe(true);
  });

  it('a span key outside the allow-list fails key-allow-list (plan test 3)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'example.not.allowed', value: { stringValue: 'example-value' } }]), 'AGENT');
    const report = redactionChecks(bytes, []);
    expect(report.pass).toBe(false);
    expect(check(report, 'key-allow-list').pass).toBe(false);
    expectNoLeak(report, ['example.not.allowed', 'example-value']);
  });

  it('a never-sent key fails key-allow-list (plan test 3)', () => {
    const inputValue = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'input.value', value: { stringValue: 'example-text' } }]), 'AGENT');
    const httpUrl = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'http.url', value: { stringValue: 'https://example.invalid' } }]), 'AGENT');
    const cases = [
      { bytes: inputValue, secrets: ['input.value', 'example-text'] },
      { bytes: httpUrl, secrets: ['http.url', 'https://example.invalid'] },
    ];
    for (const { bytes, secrets } of cases) {
      const report = redactionChecks(bytes, []);
      expect(check(report, 'key-allow-list').pass).toBe(false);
      expectNoLeak(report, secrets);
    }
  });

  it('an unknown resource key fails key-allow-list (plan test 3)', () => {
    const bytes = handPayload(
      [RESOURCE_NAME_ONLY[0], { key: 'host.name', value: { stringValue: 'example-host' } }],
      handSpanAttributes([]),
      'AGENT',
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'key-allow-list').pass).toBe(false);
    expectNoLeak(report, ['host.name', 'example-host']);
  });

  it('fleet.round as a string fails values (plan test 4)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.round', value: { stringValue: 'example-round-string' } }]), 'AGENT');
    const report = redactionChecks(bytes, []);
    expect(check(report, 'key-allow-list').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['fleet.round', 'example-round-string']);
  });

  it('a 15-hex digest fails values (plan test 4)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.work_order.digest', value: { stringValue: 'a'.repeat(15) } }]), 'AGENT');
    const report = redactionChecks(bytes, []);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['a'.repeat(15)]);
  });

  it('a NaN written as a string doubleValue fails values (plan test 4)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.usage.wall_seconds', value: { doubleValue: 'NaN' } }]), 'AGENT');
    const report = redactionChecks(bytes, []);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['NaN', 'fleet.usage.wall_seconds']);
  });

  it('llm.model_name on a non-LLM span fails values (plan test 4)', () => {
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([
        { key: 'fleet.seat.billing', value: { stringValue: 'metered' } },
        { key: 'llm.model_name', value: { stringValue: 'example-model' } },
      ]),
      'CHAIN',
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['llm.model_name', 'example-model']);
  });

  it('a value object with two fields fails values (plan test 4)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.round', value: { stringValue: 'example-two-field', intValue: 1 } }]), 'AGENT');
    const report = redactionChecks(bytes, []);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['fleet.round', 'example-two-field']);
  });

  it('a resource without service.name fails values (Luna review)', () => {
    const bytes = handPayload([], handSpanAttributes([]), 'AGENT');
    const report = redactionChecks(bytes, []);
    expect(check(report, 'values').pass).toBe(false);
  });

  it('fixtures seeded with secret shapes in every free-text field still encode to a passing payload (plan test 5)', () => {
    const githubToken = 'gh' + 'p_' + 'a'.repeat(36);
    const awsKey = 'AKIA' + 'A'.repeat(16);
    const overrides: Record<string, string> = { workOrderId: githubToken, attemptId: awsKey, project: githubToken };
    let index = 0;
    for (const field of CANARY_TEXT_FIELDS) {
      overrides[field] = index % 2 === 0 ? 'note ' + githubToken : 'note ' + awsKey;
      index += 1;
    }
    const bytes = stubEncode(
      [spanOf(baseFixture('AGENT', overrides as Partial<StubFixture>)), spanOf(baseFixture('LLM', { meteredLlm: true, ...overrides } as Partial<StubFixture>))],
      { projectName: githubToken, serviceVersion: awsKey },
    );
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(githubToken);
    expect(text).not.toContain(awsKey);
    const report = redactionChecks(bytes, [githubToken, awsKey]);
    expect(report.pass).toBe(true);
    expect(check(report, 'secret-shapes').pass).toBe(true);
  });

  it('a hand-written payload whose string value is secret-shaped fails secret-shapes (plan test 5)', () => {
    const githubToken = 'gh' + 'p_' + 'a'.repeat(36);
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.seat.model', value: { stringValue: githubToken } }]), 'AGENT');
    const report = redactionChecks(bytes, [githubToken]);
    expect(check(report, 'secret-shapes').pass).toBe(false);
    expectNoLeak(report, [githubToken, 'fleet.seat.model']);
  });

  it('a JSON-escaped secret-shaped decoded value fails secret-shapes (Luna review)', () => {
    const githubToken = 'gh' + 'p_' + 'a'.repeat(36);
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.seat.model', value: { stringValue: githubToken } }]), 'AGENT');
    const text = new TextDecoder().decode(bytes);
    const escapedText = text.replace(githubToken, escapeJsonUnicode(githubToken));
    expect(escapedText).not.toContain(githubToken);
    const report = redactionChecks(new TextEncoder().encode(escapedText), [githubToken]);
    expect(check(report, 'secret-shapes').pass).toBe(false);
    expectNoLeak(report, [githubToken, 'fleet.seat.model']);
  });

  it('refuses payloads that do not parse, with every check failed (robustness)', () => {
    const notUtf8 = new Uint8Array([0xff, 0xfe, 0x61, 0x62]);
    const reports = [
      redactionChecks(notUtf8, []),
      redactionChecks(new TextEncoder().encode('[]'), []),
      redactionChecks(new TextEncoder().encode('{}'), []),
      redactionChecks(new TextEncoder().encode('{"resourceSpans":"nope"}'), []),
    ];
    for (const report of reports) {
      expect(report.pass).toBe(false);
      expect(report.checks.every((entry) => !entry.pass && entry.offendingSpans === 0)).toBe(true);
    }
  });

  it('skips blank or very short canaries and counts them (robustness)', () => {
    const report = redactionChecks(stubPayload(), ['', '   ', 'ab']);
    expect(report.pass).toBe(true);
    expect(report.skippedCanaries).toBe(3);
  });

  it('counts the spans whose attributes contain a canary (robustness)', () => {
    const bytes = stubEncode([spanOf(baseFixture('AGENT')), spanOf(baseFixture('TOOL'))], {});
    const report = redactionChecks(bytes, ['example-model']);
    expect(report.pass).toBe(false);
    // Both fixture spans carry the model id, so both offend.
    expect(check(report, 'canaries').offendingSpans).toBe(2);
  });

  it('a JSON-escaped canary in a decoded value fails canaries (Luna review)', () => {
    const canary = 'example-model';
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.seat.model', value: { stringValue: canary } }]), 'AGENT');
    const text = new TextDecoder().decode(bytes);
    const escapedText = text.replace(canary, escapeJsonUnicode(canary));
    expect(escapedText).not.toContain(canary);
    const report = redactionChecks(new TextEncoder().encode(escapedText), [canary]);
    expect(check(report, 'canaries').pass).toBe(false);
    expectNoLeak(report, [canary]);
  });

  it('counts a span once however many canaries it carries (Luna review)', () => {
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([
        { key: 'fleet.seat.model', value: { stringValue: 'canary-one' } },
        { key: 'llm.model_name', value: { stringValue: 'canary-two' } },
      ]),
      'AGENT',
    );
    const report = redactionChecks(bytes, ['canary-one', 'canary-two']);
    expect(report.pass).toBe(false);
    expect(check(report, 'canaries').offendingSpans).toBe(1);
  });

  /** The stub payload with one extra string at a field the entry walk ignores, written JSON-escaped. */
  function withEscapedField(place: 'scope-name' | 'event-name' | 'span-name', value: string): Uint8Array {
    const parsed = JSON.parse(new TextDecoder().decode(stubPayload())) as {
      resourceSpans: { scopeSpans: { scope?: { name: string }; spans: { name?: string; events?: { name: string }[] }[] }[] }[];
    };
    const scope = parsed.resourceSpans[0].scopeSpans[0];
    const marker = 'MARKER-FIELD-VALUE';
    if (place === 'scope-name') {
      scope.scope = { name: marker };
    } else if (place === 'event-name') {
      scope.spans[0].events = [{ name: marker }];
    } else {
      scope.spans[0].name = marker;
    }
    const text = JSON.stringify(parsed).replace(marker, escapeJsonUnicode(value));
    expect(text).not.toContain(value);
    return new TextEncoder().encode(text);
  }

  it('a JSON-escaped canary in a field the walk ignores fails canaries (Luna re-review)', () => {
    const canary = 'canary-scope-value';
    for (const place of ['scope-name', 'event-name', 'span-name'] as const) {
      const report = redactionChecks(withEscapedField(place, canary), [canary]);
      expect(check(report, 'canaries').pass).toBe(false);
      expectNoLeak(report, [canary]);
    }
  });

  it('a JSON-escaped secret in a span name or an ignored field fails secret-shapes (Luna re-review)', () => {
    const githubToken = 'gh' + 'p_' + 'b'.repeat(36);
    for (const place of ['scope-name', 'event-name', 'span-name'] as const) {
      const report = redactionChecks(withEscapedField(place, githubToken), []);
      expect(check(report, 'secret-shapes').pass).toBe(false);
      expectNoLeak(report, [githubToken]);
    }
  });

  it('the report is frozen and lists the checks in order (robustness)', () => {
    const report = redactionChecks(stubPayload(), []);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
    for (const entry of report.checks) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(report.checks.map((entry) => entry.check)).toEqual([...TELEMETRY_REDACTION_CHECKS]);
  });

  it('prompt text in an event attribute fails key-allow-list and values (OT1r-2)', () => {
    const prompt = 'EXAMPLE PROMPT TEXT INSIDE AN EVENT ATTRIBUTE';
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([]),
      'AGENT',
      { events: [{ name: 'state.entered', attributes: [{ key: 'input.value', value: { stringValue: prompt } }] }] },
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'key-allow-list').pass).toBe(false);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, [prompt, 'input.value']);
  });

  it('a scope attribute fails key-allow-list and values (OT1r-2)', () => {
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([]),
      'AGENT',
      { scope: { attributes: [{ key: 'service.version', value: { stringValue: '1.0.0' } }] } },
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'key-allow-list').pass).toBe(false);
    expect(check(report, 'values').pass).toBe(false);
  });

  it('an unknown span name fails values (OT1r-2)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { name: 'not-a-plan-span-name' });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'key-allow-list').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['not-a-plan-span-name']);
  });

  it('a status.message fails values (OT1r-2)', () => {
    const message = 'EXAMPLE STATUS MESSAGE TEXT';
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { status: { code: 2, message } });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, [message]);
  });

  it('a links field fails payload-parses (OT1r-2)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { links: [] });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(false);
  });

  it('an unknown field on a span fails payload-parses (OT1r-2)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { extra: { unexpectedField: 'x' } });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(false);
    expectNoLeak(report, ['unexpectedField', 'x']);
  });

  it('a duplicate attribute key fails values (OT1r-2)', () => {
    const freeText = 'FREE TEXT FIRST VALUE OF THE DUPLICATE KEY';
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      [
        { key: 'fleet.telemetry.schema', value: { intValue: 1 } },
        { key: 'fleet.run.id', value: { stringValue: RUN_ID } },
        { key: 'fleet.seat.model', value: { stringValue: freeText } },
        { key: 'fleet.seat.model', value: { stringValue: 'example-model' } },
      ],
      'AGENT',
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'key-allow-list').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, [freeText]);
  });

  it('a duplicate JSON key inside a value object fails payload-parses (OT1r-2)', () => {
    const bytes = withDuplicateJsonKey(handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT'));
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(false);
  });

  it('a number written in non-canonical exponent form fails payload-parses (OT1r-2)', () => {
    const bytes = withExponentNumber(
      handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.usage.wall_seconds', value: { doubleValue: 2.0251027e7 } }]), 'AGENT'),
    );
    const report = redactionChecks(bytes, ['20251027']);
    expect(check(report, 'payload-parses').pass).toBe(false);
    expect(check(report, 'canaries').pass).toBe(false);
  });

  it('a canonical payload carrying a numeric canary parses and fails canaries (OT1r-2 Grok)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([{ key: 'fleet.usage.wall_seconds', value: { doubleValue: 2.0251027e7 } }]), 'AGENT');
    const report = redactionChecks(bytes, ['20251027']);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'canaries').pass).toBe(false);
  });

  it('a status carrying only a code passes (codes only, OT1r-2 Grok)', () => {
    const parsed = JSON.parse(new TextDecoder().decode(stubPayload())) as {
      resourceSpans: { scopeSpans: { spans: { status?: { code: number } }[] }[] }[];
    };
    parsed.resourceSpans[0].scopeSpans[0].spans[0].status = { code: 2 };
    const report = redactionChecks(new TextEncoder().encode(JSON.stringify(parsed)), []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(true);
  });

  it('a state.entered event with a valid fleet.state passes every check (OT1r-3)', () => {
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([]),
      'AGENT',
      {
        events: [
          {
            name: 'state.entered',
            timeUnixNano: '1735689600000000000',
            attributes: [{ key: 'fleet.state', value: { stringValue: 'running' } }],
          },
        ],
      },
    );
    const report = redactionChecks(bytes, []);
    expect(report.pass).toBe(true);
    expect(report.checks.every((entry) => entry.pass)).toBe(true);
  });

  it('an event attribute other than fleet.state fails key-allow-list (OT1r-3)', () => {
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([]),
      'AGENT',
      { events: [{ name: 'state.entered', attributes: [{ key: 'fleet.step', value: { stringValue: 'dispatch' } }] }] },
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'key-allow-list').pass).toBe(false);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['fleet.step', 'dispatch']);
  });

  it('an invalid fleet.state on an event fails values (OT1r-3)', () => {
    const state = 'not-a-lane-run-state';
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([]),
      'AGENT',
      { events: [{ name: 'state.entered', attributes: [{ key: 'fleet.state', value: { stringValue: state } }] }] },
    );
    const report = redactionChecks(bytes, []);
    expect(check(report, 'key-allow-list').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, [state]);
  });

  it('a span named review passes values (OT1r-3)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { name: 'review' });
    const report = redactionChecks(bytes, []);
    expect(report.pass).toBe(true);
    expect(check(report, 'values').pass).toBe(true);
  });

  it('a status message that is a reason code passes values (OT1r-3)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { status: { code: 2, message: 'example-reason-code' } });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(true);
  });

  it('a non-hex traceId fails values (OT1r-3)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { extra: { traceId: 'not-hex-trace-id' } });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'key-allow-list').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['not-hex-trace-id']);
  });

  it('a non-digit startTimeUnixNano fails values (OT1r-3)', () => {
    const bytes = handPayload(RESOURCE_NAME_ONLY, handSpanAttributes([]), 'AGENT', { extra: { startTimeUnixNano: '17:35:68.000' } });
    const report = redactionChecks(bytes, []);
    expect(check(report, 'payload-parses').pass).toBe(true);
    expect(check(report, 'key-allow-list').pass).toBe(true);
    expect(check(report, 'values').pass).toBe(false);
    expectNoLeak(report, ['17:35:68.000']);
  });

  it('a well-shaped span carries its ids, times and kind without failing (OT1r-3)', () => {
    const bytes = handPayload(
      RESOURCE_NAME_ONLY,
      handSpanAttributes([]),
      'AGENT',
      {
        extra: {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          parentSpanId: 'c'.repeat(16),
          kind: 1,
          startTimeUnixNano: '1735689600000000000',
          endTimeUnixNano: '1735689601000000000',
        },
      },
    );
    const report = redactionChecks(bytes, []);
    expect(report.pass).toBe(true);
  });

  it.todo('adapter errors name an error kind, never the endpoint, a header or a body (belongs with the sender, OT3b)');
  it.todo('a cast object literal is refused by the encoder (belongs with the encoder and the nominal span, OT3a and OT1a-3)');
});
