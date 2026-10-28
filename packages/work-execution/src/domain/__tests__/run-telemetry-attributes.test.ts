import { describe, expect, it } from 'vitest';
import {
  RUN_TELEMETRY_ATTRIBUTES,
  RUN_TELEMETRY_RESOURCE_KEYS,
  TELEMETRY_BUILDER_OWNED_KEYS,
  TELEMETRY_NEVER_SENT_KEYS,
  TELEMETRY_SERVICE_NAME,
  filterTelemetryAttributes,
  isNeverSentTelemetryKey,
  isTelemetryInvocationParameters,
  isTelemetryModelId,
  isTelemetryParkQualifier,
  isTelemetryProjectAlias,
  isTelemetryProjectValue,
  isTelemetryServiceVersion,
  isTelemetryVariant,
  telemetryInvocationParameters,
  telemetryResourceAttributes,
} from '../run-telemetry-attributes.js';
import type { TelemetrySpanKind } from '../run-telemetry-attributes.js';
import { TELEMETRY_SCHEMA_VERSION } from '../run-telemetry-ids.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal (copied from lane-run.test.ts).
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const EXPECTED_KEYS = [
  'openinference.span.kind',
  'fleet.telemetry.schema',
  'tag.tags',
  'fleet.run.id',
  'fleet.work_order.digest',
  'session.id',
  'fleet.attempt.digest',
  'fleet.prior_attempt.digest',
  'fleet.project',
  'fleet.step',
  'fleet.state',
  'fleet.round',
  'fleet.seat.index',
  'fleet.seat.role',
  'fleet.tier',
  'fleet.attempt.kind',
  'fleet.fix_number',
  'fleet.outcome',
  'fleet.reason_code',
  'fleet.stop_reason',
  'fleet.park.reason',
  'fleet.park.qualifier',
  'fleet.gate.result',
  'fleet.review.kind',
  'fleet.review.result',
  'fleet.ci.result',
  'fleet.stop.mode',
  'fleet.review.findings.blocker',
  'fleet.review.findings.major',
  'fleet.review.findings.minor',
  'fleet.review.findings.nit',
  'fleet.gate.exit_code',
  'fleet.ambiguous_results',
  'fleet.usage.steps',
  'fleet.seat.model',
  'fleet.seat.provider',
  'agent.name',
  'fleet.seat.tool',
  'fleet.seat.billing',
  'llm.invocation_parameters',
  'llm.model_name',
  'llm.provider',
  'llm.token_count.prompt',
  'llm.token_count.completion',
  'llm.token_count.total',
  'llm.token_count.prompt_details.cache_read',
  'llm.token_count.prompt_details.cache_write',
  'llm.token_count.completion_details.reasoning',
  'fleet.usage.source',
  'fleet.usage.wall_seconds',
  'llm.cost.total',
  'fleet.cost.estimate_usd',
  'fleet.cost.basis',
  'fleet.pr.number',
  'fleet.head12',
] as const;

describe('RUN_TELEMETRY_ATTRIBUTES', () => {
  it('has exactly the 55 allow-listed keys in plan order', () => {
    expect(Object.keys(RUN_TELEMETRY_ATTRIBUTES)).toEqual([...EXPECTED_KEYS]);
  });

  it('never names a never-sent key and uses only dot/lowercase key text', () => {
    for (const key of Object.keys(RUN_TELEMETRY_ATTRIBUTES)) {
      expect(isNeverSentTelemetryKey(key)).toBe(false);
      expect(key).toMatch(/^[a-z][a-z0-9_.]*$/);
    }
  });

  it('declares the builder-owned keys', () => {
    expect(TELEMETRY_BUILDER_OWNED_KEYS).toEqual(['openinference.span.kind', 'fleet.telemetry.schema']);
  });
});

describe('validators', () => {
  it.each([
    ['fleet-lanes', true],
    ['Fleet', false],
    ['1abc', false],
    ['a'.repeat(33), false],
  ])('isTelemetryProjectAlias(%j) is %j', (value, expected) => {
    expect(isTelemetryProjectAlias(value)).toBe(expected);
  });

  it.each([
    ['0123456789abcdef', true],
    ['CANARY Client Ltd', false],
    ['feat/acme-billing-CANARY', false],
    [fakeSecretShape(), false],
  ])('isTelemetryProjectValue(%j) is %j', (value, expected) => {
    expect(isTelemetryProjectValue(value)).toBe(expected);
  });

  it.each([
    ['openrouter/z-ai/glm-5.3-flash', true],
    ['inception/mercury-3', true],
    ['a b', false],
    ['', false],
    ['/x', false],
    ['x'.repeat(129), false],
    [fakeSecretShape(), false],
  ])('isTelemetryModelId(%j) is %j', (value, expected) => {
    expect(isTelemetryModelId(value)).toBe(expected);
  });

  it.each([
    ['low', true],
    ['none', true],
    ['Low', false],
    ['-x', false],
    ['a'.repeat(33), false],
  ])('isTelemetryVariant(%j) is %j', (value, expected) => {
    expect(isTelemetryVariant(value)).toBe(expected);
  });

  it('builds the invocation parameters string or null', () => {
    expect(telemetryInvocationParameters('low')).toBe('{"variant":"low"}');
    expect(telemetryInvocationParameters('Low')).toBeNull();
  });

  it.each([
    ['{"variant":"low"}', true],
    ['{"variant":"low","x":1}', false],
    ['{ "variant": "low" }', false],
    ['{"variant":"Low"}', false],
    ['not json', false],
  ])('isTelemetryInvocationParameters(%j) is %j', (value, expected) => {
    expect(isTelemetryInvocationParameters(value)).toBe(expected);
  });

  it.each([
    ['0.1.0', true],
    ['1.2.3-rc.1', true],
    ['1.2', false],
    ['v1.2.3', false],
    ['1.2.3-', false],
    ['1.2.3-' + 'a'.repeat(33), false],
    ['CANARY-1', false],
  ])('isTelemetryServiceVersion(%j) is %j', (value, expected) => {
    expect(isTelemetryServiceVersion(value)).toBe(expected);
  });

  it.each([
    ['ambiguous', 'dispatch', true],
    ['step-refused', 'merge', true],
    ['stop-refused', 'runner-refused', true],
    ['stop-refused', 'dispatch', false],
    ['ambiguous', 'runner-refused', false],
    ['halted', 'dispatch', false],
    ['no-such-reason', 'dispatch', false],
  ])('isTelemetryParkQualifier(%j, %j) is %j', (reason, qualifier, expected) => {
    expect(isTelemetryParkQualifier(reason, qualifier)).toBe(expected);
  });
});

/** A full metered-LLM span attribute set (test 3 and 4 share it). */
function meteredLlmAttributes(): Record<string, unknown> {
  return {
    'fleet.run.id': 'run-001H9ABCDEFGHJKMNPQRSTVWXZ',
    'fleet.project': 'fleet-lanes',
    'fleet.seat.billing': 'metered',
    'fleet.seat.model': 'openrouter/z-ai/glm-5.3-flash',
    'fleet.seat.provider': 'openrouter',
    'llm.model_name': 'openrouter/z-ai/glm-5.3-flash',
    'llm.provider': 'openrouter',
    'llm.invocation_parameters': '{"variant":"low"}',
    'llm.token_count.prompt': 10,
    'llm.token_count.completion': 20,
    'llm.token_count.total': 30,
    'llm.token_count.prompt_details.cache_read': 1,
    'llm.token_count.prompt_details.cache_write': 2,
    'llm.token_count.completion_details.reasoning': 3,
    'fleet.usage.source': 'opencode-db',
    'fleet.usage.wall_seconds': 1.5,
    'llm.cost.total': 0.12,
    'fleet.cost.estimate_usd': 0,
    'fleet.cost.basis': 'metered',
  };
}

describe('filterTelemetryAttributes', () => {
  it('keeps every key of a full metered LLM span', () => {
    const input = meteredLlmAttributes();
    const kept = filterTelemetryAttributes(input, 'LLM');
    for (const key of Object.keys(input)) {
      expect(kept[key], key).toBeDefined();
    }
  });

  it('drops metered-only keys on a plan-billed LLM span, keeps the token counts', () => {
    const input = { ...meteredLlmAttributes(), 'fleet.seat.billing': 'plan' };
    const kept = filterTelemetryAttributes(input, 'LLM');
    expect(kept['llm.model_name']).toBeUndefined();
    expect(kept['llm.provider']).toBeUndefined();
    expect(kept['llm.cost.total']).toBeUndefined();
    expect(kept['llm.token_count.prompt']).toBe(10);
    expect(kept['llm.token_count.completion']).toBe(20);
    expect(kept['llm.token_count.total']).toBe(30);
    expect(kept['llm.token_count.prompt_details.cache_read']).toBe(1);
    expect(kept['llm.token_count.prompt_details.cache_write']).toBe(2);
    expect(kept['llm.token_count.completion_details.reasoning']).toBe(3);
  });

  it('drops the metered-only llm.* keys on an AGENT span but keeps fleet.seat.model', () => {
    const input = meteredLlmAttributes();
    const kept = filterTelemetryAttributes(input, 'AGENT');
    expect(kept['llm.model_name']).toBeUndefined();
    expect(kept['llm.provider']).toBeUndefined();
    expect(kept['llm.cost.total']).toBeUndefined();
    for (const key of Object.keys(kept)) {
      if (key.startsWith('llm.token_count.')) {
        throw new Error(`token counts must not be kept on an AGENT span: ${key}`);
      }
    }
    expect(kept['llm.invocation_parameters']).toBeUndefined();
    expect(kept['fleet.seat.model']).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(kept['fleet.seat.billing']).toBe('metered');
  });

  it('drops unknown and never-sent keys while valid siblings stay', () => {
    const kept = filterTelemetryAttributes(
      {
        'fleet.worktree': 'wt-abc',
        'fleet.brief.path': 'docs/brief.md',
        'input.value': 'raw',
        'http.url': 'http://example.test',
        'host.name': 'host',
        'exception.message': 'boom',
        metadata: 'meta',
        'user.id': 'u1',
        'fleet.gate.result': 'pass',
        'fleet.gate.exit_code': 0,
      },
      'CHAIN',
    );
    expect(Object.keys(kept)).toEqual(['fleet.gate.result', 'fleet.gate.exit_code']);
  });

  it.each([
    ['NaN prompt tokens', { 'llm.token_count.prompt': NaN }],
    ['infinite prompt tokens', { 'llm.token_count.prompt': Infinity }],
    ['negative round', { 'fleet.round': -1 }],
    ['fractional round', { 'fleet.round': 1.5 }],
    ['string count', { 'fleet.usage.steps': '7' }],
    ['duplicate tags', { 'tag.tags': ['conducted', 'conducted'] }],
    ['unknown tag', { 'tag.tags': ['other'] }],
    ['empty tags', { 'tag.tags': [] }],
    ['park qualifier without a matching reason', { 'fleet.park.reason': 'halted', 'fleet.park.qualifier': 'dispatch' }],
  ])('drops %s', (_name, input) => {
    const kept = filterTelemetryAttributes({ ...input, 'fleet.gate.result': 'pass' }, 'LLM');
    expect(kept['fleet.gate.result']).toBe('pass');
    expect(kept['fleet.park.qualifier']).toBeUndefined();
    for (const key of Object.keys(input)) {
      if (key === 'fleet.park.reason') {
        expect(kept[key]).toBe('halted');
      } else {
        expect(kept[key]).toBeUndefined();
      }
    }
  });

  it('keeps a valid tag list and the builder-owned keys of the input', () => {
    const kept = filterTelemetryAttributes(
      { 'tag.tags': ['conducted', 'tier-2'], 'openinference.span.kind': 'LLM', 'fleet.telemetry.schema': TELEMETRY_SCHEMA_VERSION },
      'LLM',
    );
    expect(kept['tag.tags']).toEqual(['conducted', 'tier-2']);
    expect(kept['openinference.span.kind']).toBeUndefined();
    expect(kept['fleet.telemetry.schema']).toBeUndefined();
  });

  it('orders output keys by the allow-list whatever the input order', () => {
    const a = filterTelemetryAttributes({ 'fleet.gate.result': 'pass', 'fleet.run.id': 'run-001H9ABCDEFGHJKMNPQRSTVWXZ' }, 'CHAIN');
    const b = filterTelemetryAttributes({ 'fleet.run.id': 'run-001H9ABCDEFGHJKMNPQRSTVWXZ', 'fleet.gate.result': 'pass' }, 'CHAIN');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('gives a frozen {} for hostile input without throwing', () => {
    const hostile = () => {
      throw new Error('ownKeys trap');
    };
    const throwingGetter = {} as Record<string, unknown>;
    Object.defineProperty(throwingGetter, 'fleet.gate.result', {
      enumerable: true,
      get: hostile,
    });
    const throwingProxy = new Proxy({}, { ownKeys: hostile });
    for (const input of [null, [], new Date(), throwingGetter, throwingProxy]) {
      const kept = filterTelemetryAttributes(input, 'LLM');
      expect(kept).toEqual({});
      expect(Object.isFrozen(kept)).toBe(true);
    }
    expect(Object.isFrozen(filterTelemetryAttributes({}, 'NOT-A-KIND' as TelemetrySpanKind))).toBe(true);
  });

  it('freezes copied string arrays', () => {
    const kept = filterTelemetryAttributes({ 'tag.tags': ['conducted'] }, 'AGENT');
    const tags = kept['tag.tags'] as readonly string[];
    expect(Object.isFrozen(tags)).toBe(true);
  });
});

describe('never-sent keys', () => {
  it('names the exact keys and prefixes', () => {
    expect(TELEMETRY_NEVER_SENT_KEYS).toEqual(['input.value', 'output.value', 'metadata', 'user.id']);
    expect(isNeverSentTelemetryKey('llm.input_messages.0.content')).toBe(true);
    expect(isNeverSentTelemetryKey('tool.name')).toBe(true);
    expect(isNeverSentTelemetryKey('fleet.gate.result')).toBe(false);
  });
});

describe('telemetryResourceAttributes', () => {
  it('builds exactly the three resource keys for valid input', () => {
    const resource = telemetryResourceAttributes({ serviceVersion: '0.1.0', projectName: 'fleet-lanes' });
    expect(Object.keys(resource)).toEqual([...RUN_TELEMETRY_RESOURCE_KEYS]);
    expect(resource['service.name']).toBe(TELEMETRY_SERVICE_NAME);
    expect(resource['service.version']).toBe('0.1.0');
    expect(resource['openinference.project.name']).toBe('fleet-lanes');
  });

  it.each([
    [{ serviceVersion: 'CANARY-1', projectName: 'fleet-lanes' }, ['service.name', 'openinference.project.name']],
    [{ serviceVersion: '0.1.0', projectName: 'CANARY Client' }, ['service.name', 'service.version']],
    [{ serviceVersion: 'CANARY-1', projectName: 'CANARY Client' }, ['service.name']],
    [{ serviceVersion: '0.1.0', projectName: fakeSecretShape() }, ['service.name', 'service.version']],
  ])('drops the invalid resource fields of %j', (input, expectedKeys) => {
    const resource = telemetryResourceAttributes(input);
    expect(Object.keys(resource)).toEqual(expectedKeys);
    expect(resource['service.name']).toBe(TELEMETRY_SERVICE_NAME);
  });

  it('an own __proto__ key never supplies an inherited billing class', () => {
    const input = JSON.parse('{"__proto__":{"fleet.seat.billing":"metered"},"llm.model_name":"openrouter/example"}') as Record<string, unknown>;
    const kept = filterTelemetryAttributes(input, 'LLM');
    expect(kept['llm.model_name']).toBeUndefined();
    expect(kept['fleet.seat.billing']).toBeUndefined();
  });

  it('a tag array is copied without running its iterator or getters', () => {
    const tags = ['dry-run'];
    Object.defineProperty(tags, Symbol.iterator, {
      value: function* () {
        yield 'injected text';
      },
    });
    const kept = filterTelemetryAttributes({ 'tag.tags': tags }, 'CHAIN');
    expect(kept['tag.tags'] === undefined || !(kept['tag.tags'] as readonly string[]).includes('injected text')).toBe(true);
    const withGetter: unknown[] = [];
    Object.defineProperty(withGetter, '0', { get: () => 'dry-run', enumerable: true });
    expect(filterTelemetryAttributes({ 'tag.tags': withGetter }, 'CHAIN')['tag.tags']).toBeUndefined();
  });

  it('reads resource fields once: a getter never supplies an unvalidated value', () => {
    let reads = 0;
    const input = {
      get serviceVersion(): string {
        reads += 1;
        return reads === 1 ? '0.1.0' : 'CANARY host:port';
      },
      projectName: 'fleet-lanes',
    };
    const resource = telemetryResourceAttributes(input);
    expect(resource['service.version']).toBeUndefined();
    expect(JSON.stringify(resource)).not.toContain('CANARY');
  });

  it('encodes -0 as 0 and emits tags in one order', () => {
    const negativeZero = filterTelemetryAttributes({ 'fleet.usage.wall_seconds': -0 }, 'CHAIN');
    expect(Object.is(negativeZero['fleet.usage.wall_seconds'], 0)).toBe(true);
    const first = filterTelemetryAttributes({ 'tag.tags': ['tier-2', 'conducted'] }, 'CHAIN');
    const second = filterTelemetryAttributes({ 'tag.tags': ['conducted', 'tier-2'] }, 'CHAIN');
    expect(first['tag.tags']).toEqual(second['tag.tags']);
  });

  it('refuses an array longer than the tag list without walking it', () => {
    const long = new Proxy(['conducted'], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') {
          return { value: Number.MAX_SAFE_INTEGER, writable: true, enumerable: false, configurable: false };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(filterTelemetryAttributes({ 'tag.tags': long }, 'CHAIN')['tag.tags']).toBeUndefined();
  });

  it('model ids refuse URLs, emails, hosts with ports and credentialed URLs; real ids pass', () => {
    for (const bad of [
      'https://user:secret@example.com',
      'https://phoenix.example.test:6006/v1/traces',
      'someone@example.com',
      'git@example.com:org/repo',
      'api.example.com:443',
      'a/b/c/d/e',
    ]) {
      const kept = filterTelemetryAttributes({ 'fleet.seat.model': bad }, 'AGENT');
      expect(kept['fleet.seat.model']).toBeUndefined();
    }
    for (const good of ['openrouter/z-ai/glm-5.3-flash', 'openrouter/poolside/laguna-s-2.1:free', 'gemini-4-argon-high', 'grok-4.7']) {
      expect(filterTelemetryAttributes({ 'fleet.seat.model': good }, 'AGENT')['fleet.seat.model']).toBe(good);
    }
  });
});
