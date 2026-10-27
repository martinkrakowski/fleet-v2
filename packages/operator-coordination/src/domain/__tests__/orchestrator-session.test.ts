import { describe, expect, it } from 'vitest';

import { COORDINATION_KINDS } from '../value-objects/CoordinationKind.vo.js';
import { ORCHESTRATOR_REQUEST_KINDS } from '../orchestrator-session-records.js';
import {
  OrchestratorSession,
  isOrchestratorAttached,
  isOrchestratorAttentive,
} from '../entities/OrchestratorSession.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const VALID = {
  orchestratorId: 'orch-example-1',
  cliKind: 'claude-code',
  model: 'example-provider/example-model',
  host: 'example-host',
  projects: ['example-project'],
  claims: ['dispatch-attempt', 'prepare-fix'],
  scopes: ['message', 'orchestrate'],
  startedAtIso: '2026-10-27T10:00:00.000Z',
  lastHeartbeatIso: '2026-10-27T10:00:30.000Z',
  leaseUntilIso: '2026-10-27T10:02:00.000Z',
  lastPolledRequestsAtIso: null,
  status: 'active',
};

describe('OrchestratorSession.create', () => {
  it('creates from VALID and round-trips', () => {
    const result = OrchestratorSession.create(VALID);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.value.toRecord()).toEqual(VALID);
    const roundTripped = OrchestratorSession.create(
      JSON.parse(JSON.stringify(result.value.toRecord())),
    );
    expect(roundTripped.success).toBe(true);
    if (!roundTripped.success) {
      return;
    }
    expect(roundTripped.value.toRecord()).toEqual(result.value.toRecord());
  });

  it('normalises timestamps and sorts claims', () => {
    const result = OrchestratorSession.create({
      ...VALID,
      startedAtIso: '2026-10-27T10:00:00Z',
      claims: ['prepare-fix', 'dispatch-attempt'],
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const record = result.value.toRecord();
    expect(record.startedAtIso).toBe('2026-10-27T10:00:00.000Z');
    expect(record.claims).toEqual(['dispatch-attempt', 'prepare-fix']);
  });

  it.each([
    [null, 'OrchestratorSession requires a record'],
    [[], 'OrchestratorSession requires a record'],
    [{ ...VALID, note: 'x' }, 'OrchestratorSession has an unknown key'],
    [{ ...VALID, host: undefined }, 'OrchestratorSession host must be a non-empty id of at most 256 bytes'],
    [{ ...VALID, orchestratorId: '  ' }, 'OrchestratorSession orchestratorId must be a non-empty id of at most 256 bytes'],
    [{ ...VALID, orchestratorId: 'é'.repeat(129) }, 'OrchestratorSession orchestratorId must be a non-empty id of at most 256 bytes'],
    [{ ...VALID, cliKind: 'cursor' }, 'OrchestratorSession cliKind is not one of claude-code, agy, opencode, codex, conductor, other'],
    [{ ...VALID, model: '' }, 'OrchestratorSession model must be null or a non-empty string of at most 256 bytes'],
    [{ ...VALID, host: 42 }, 'OrchestratorSession host must be a non-empty id of at most 256 bytes'],
    [{ ...VALID, projects: ['a', 'a'] }, 'OrchestratorSession projects must be an array of at most 64 distinct ids'],
    [{ ...VALID, projects: Array.from({ length: 65 }, (_, i) => `p${i}`) }, 'OrchestratorSession projects must be an array of at most 64 distinct ids'],
    [{ ...VALID, claims: ['merge'] }, 'OrchestratorSession claims must be distinct request kinds'],
    [{ ...VALID, claims: ['open-pr'] }, 'OrchestratorSession claims must be distinct request kinds'],
    [{ ...VALID, claims: ['halt'] }, 'OrchestratorSession claims must be distinct request kinds'],
    [{ ...VALID, scopes: ['dispatch'] }, 'OrchestratorSession scopes must be distinct session scopes'],
    [{ ...VALID, scopes: ['verdict'] }, 'OrchestratorSession scopes must be distinct session scopes'],
    [{ ...VALID, scopes: ['read', 'read'] }, 'OrchestratorSession scopes must be distinct session scopes'],
    [{ ...VALID, leaseUntilIso: 'soon' }, 'OrchestratorSession leaseUntilIso must be a valid timestamp'],
    [{ ...VALID, lastHeartbeatIso: '2026-10-27T10:03:00.000Z', leaseUntilIso: '2026-10-27T10:02:00.000Z' }, 'OrchestratorSession times must satisfy startedAt <= lastHeartbeat < leaseUntil'],
    [{ ...VALID, lastHeartbeatIso: '2026-10-27T10:01:00.000Z', leaseUntilIso: '2026-10-27T10:06:01.000Z' }, 'OrchestratorSession lease exceeds 300 seconds past the last heartbeat'],
    [{ ...VALID, lastPolledRequestsAtIso: '2026-10-27T09:59:00.000Z' }, 'OrchestratorSession lastPolledRequestsAtIso precedes startedAtIso'],
    [{ ...VALID, status: 'expired' }, 'OrchestratorSession status is not one of active, retired'],
  ])('refuses %# with the exact message', (input, expected) => {
    const result = OrchestratorSession.create(input);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).toBe(expected);
  });

  it('never echoes a value in an error message', () => {
    const inputs = [
      { ...VALID, cliKind: 'cursor-XYZZY' },
      { ...VALID, scopes: ['dispatch-XYZZY'] },
      { ...VALID, note: 'XYZZY-key' },
      { ...VALID, status: 'XYZZY' },
    ];
    for (const input of inputs) {
      const result = OrchestratorSession.create(input);
      expect(result.success).toBe(false);
      if (result.success) {
        continue;
      }
      expect(result.error.message).not.toContain('XYZZY');
    }
  });

  it('refuses secret-shaped text without echoing it', () => {
    const secret = fakeSecretShape();
    const inputs = [
      { ...VALID, host: secret },
      { ...VALID, model: secret },
      { ...VALID, projects: ['example-project', secret] },
      { ...VALID, orchestratorId: secret },
    ];
    const messages = [
      'OrchestratorSession host contains a secret-shaped value and was refused',
      'OrchestratorSession model contains a secret-shaped value and was refused',
      'OrchestratorSession projects contains a secret-shaped value and was refused',
      'OrchestratorSession orchestratorId contains a secret-shaped value and was refused',
    ];
    for (let i = 0; i < inputs.length; i += 1) {
      const result = OrchestratorSession.create(inputs[i]);
      expect(result.success).toBe(false);
      if (result.success) {
        continue;
      }
      expect(result.error.message).toBe(messages[i]);
      expect(result.error.message).not.toContain(secret);
    }
  });

  it('never throws on malformed input', () => {
    const inputs = [
      undefined,
      42,
      'text',
      Object.create(null),
      { ...VALID, projects: 'not-an-array' },
    ];
    for (const input of inputs) {
      expect(() => OrchestratorSession.create(input)).not.toThrow();
      expect(OrchestratorSession.create(input).success).toBe(false);
    }
  });
});

describe('OrchestratorSession hostile and boundary input', () => {
  it('returns a failure result when a field getter throws', () => {
    const hostile: Record<string, unknown> = { ...VALID };
    Object.defineProperty(hostile, 'host', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('host getter exploded');
      },
    });
    expect(() => OrchestratorSession.create(hostile)).not.toThrow();
    const result = OrchestratorSession.create(hostile);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).not.toContain('exploded');
  });

  it('returns a failure result when a proxy ownKeys trap throws', () => {
    const proxy = new Proxy({ ...VALID }, {
      ownKeys() {
        throw new Error('ownKeys trap exploded');
      },
    });
    expect(() => OrchestratorSession.create(proxy)).not.toThrow();
    const result = OrchestratorSession.create(proxy);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).toBe('OrchestratorSession input could not be read');
  });

  it('refuses inherited fields', () => {
    const inherited = Object.create(VALID);
    expect(() => OrchestratorSession.create(inherited)).not.toThrow();
    expect(OrchestratorSession.create(inherited).success).toBe(false);
  });

  it('refuses a missing key', () => {
    const missing: Record<string, unknown> = { ...VALID };
    delete missing.host;
    expect(OrchestratorSession.create(missing).success).toBe(false);
  });

  it('refuses an extra symbol key', () => {
    const withSymbol: Record<PropertyKey, unknown> = { ...VALID };
    withSymbol[Symbol.for('orchestrator-session-extra-key')] = 'extra';
    expect(() => OrchestratorSession.create(withSymbol)).not.toThrow();
    expect(OrchestratorSession.create(withSymbol).success).toBe(false);
  });

  it('refuses a non-enumerable own key', () => {
    const hidden: Record<string, unknown> = { ...VALID };
    Object.defineProperty(hidden, 'host', { enumerable: false, value: 'example-host' });
    expect(() => OrchestratorSession.create(hidden)).not.toThrow();
    expect(OrchestratorSession.create(hidden).success).toBe(false);
  });

  it('refuses a lease end past the maximum date without throwing', () => {
    const session = OrchestratorSession.create(VALID);
    if (!session.success) {
      throw new Error('VALID must construct');
    }
    const nearMaxIso = new Date(8.64e15 - 1).toISOString();
    expect(() => session.value.renewLease(nearMaxIso)).not.toThrow();
    const result = session.value.renewLease(nearMaxIso);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).toBe('lease end is out of range');
  });
});

describe('isOrchestratorAttached', () => {
  const session = OrchestratorSession.create(VALID);
  if (!session.success) {
    throw new Error('VALID must construct');
  }
  const record = session.value.toRecord();

  it('follows the lease strictly', () => {
    expect(isOrchestratorAttached(record, '2026-10-27T10:01:59.999Z')).toBe(true);
    expect(isOrchestratorAttached(record, '2026-10-27T10:02:00.000Z')).toBe(false);
    expect(isOrchestratorAttached(record, 'not-a-time')).toBe(false);
  });

  it('is false for a retired session', () => {
    const retired = OrchestratorSession.create({ ...VALID, status: 'retired' });
    if (!retired.success) {
      throw new Error('retired must construct');
    }
    expect(isOrchestratorAttached(retired.value.toRecord(), '2026-10-27T10:00:31.000Z')).toBe(false);
  });
});

describe('isOrchestratorAttentive', () => {
  it('is false when never polled', () => {
    const session = OrchestratorSession.create(VALID);
    if (!session.success) {
      throw new Error('VALID must construct');
    }
    expect(isOrchestratorAttentive(session.value.toRecord(), '2026-10-27T10:01:00.000Z')).toBe(false);
  });

  it('requires a previous poll within the window', () => {
    const session = OrchestratorSession.create({
      ...VALID,
      lastPolledRequestsAtIso: '2026-10-27T10:00:40.000Z',
    });
    if (!session.success) {
      throw new Error('polled must construct');
    }
    const record = session.value.toRecord();
    expect(isOrchestratorAttentive(record, '2026-10-27T10:05:40.000Z')).toBe(true);
    expect(isOrchestratorAttentive(record, '2026-10-27T10:05:40.001Z')).toBe(false);
    expect(isOrchestratorAttentive(record, 'not-a-time')).toBe(false);
  });

  it('does not depend on the lease', () => {
    const session = OrchestratorSession.create({
      ...VALID,
      lastPolledRequestsAtIso: '2026-10-27T10:04:00.000Z',
    });
    if (!session.success) {
      throw new Error('polled must construct');
    }
    const record = session.value.toRecord();
    expect(isOrchestratorAttentive(record, '2026-10-27T10:05:00.000Z')).toBe(true);
    expect(isOrchestratorAttached(record, '2026-10-27T10:05:00.000Z')).toBe(false);
  });
});

describe('renewLease', () => {
  const session = OrchestratorSession.create(VALID);
  if (!session.success) {
    throw new Error('VALID must construct');
  }

  it('moves the heartbeat and lease forward', () => {
    const renewed = session.value.renewLease('2026-10-27T10:01:00.000Z');
    expect(renewed.success).toBe(true);
    if (!renewed.success) {
      return;
    }
    const record = renewed.value.toRecord();
    expect(record.lastHeartbeatIso).toBe('2026-10-27T10:01:00.000Z');
    expect(record.leaseUntilIso).toBe('2026-10-27T10:02:30.000Z');
  });

  it('refuses an out-of-range lease', () => {
    expect(session.value.renewLease('2026-10-27T10:01:00.000Z', 301).success).toBe(false);
    expect(session.value.renewLease('2026-10-27T10:01:00.000Z', 0).success).toBe(false);
  });

  it('refuses renewal on a retired session', () => {
    const retired = OrchestratorSession.create({ ...VALID, status: 'retired' });
    if (!retired.success) {
      throw new Error('retired must construct');
    }
    const result = retired.value.renewLease('2026-10-27T10:01:00.000Z');
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).toBe('OrchestratorSession is retired and cannot renew its lease');
  });

  it('refuses a heartbeat that moves backwards', () => {
    const result = session.value.renewLease('2026-10-27T10:00:10.000Z');
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).toBe('OrchestratorSession heartbeat must not move backwards');
  });
});

describe('recordRequestsPoll', () => {
  it('records the poll time', () => {
    const session = OrchestratorSession.create(VALID);
    if (!session.success) {
      throw new Error('VALID must construct');
    }
    const polled = session.value.recordRequestsPoll('2026-10-27T10:03:00.000Z');
    expect(polled.success).toBe(true);
    if (!polled.success) {
      return;
    }
    expect(polled.value.toRecord().lastPolledRequestsAtIso).toBe('2026-10-27T10:03:00.000Z');
  });

  it('refuses polling on a retired session', () => {
    const retired = OrchestratorSession.create({ ...VALID, status: 'retired' });
    if (!retired.success) {
      throw new Error('retired must construct');
    }
    const result = retired.value.recordRequestsPoll('2026-10-27T10:03:00.000Z');
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.message).toBe('OrchestratorSession is retired and cannot poll');
  });
});

describe('retire', () => {
  it('retires and shortens the lease', () => {
    const session = OrchestratorSession.create(VALID);
    if (!session.success) {
      throw new Error('VALID must construct');
    }
    const retired = session.value.retire('2026-10-27T10:01:00.000Z');
    expect(retired.success).toBe(true);
    if (!retired.success) {
      return;
    }
    const record = retired.value.toRecord();
    expect(record.status).toBe('retired');
    expect(record.leaseUntilIso).toBe('2026-10-27T10:01:00.000Z');
    expect(isOrchestratorAttached(record, '2026-10-27T10:01:00.000Z')).toBe(false);
    expect(isOrchestratorAttached(record, '2026-10-27T10:02:00.000Z')).toBe(false);
  });

  it('retiring twice returns an equal record', () => {
    const session = OrchestratorSession.create(VALID);
    if (!session.success) {
      throw new Error('VALID must construct');
    }
    const retired = session.value.retire('2026-10-27T10:01:00.000Z');
    if (!retired.success) {
      throw new Error('retire must succeed');
    }
    const again = retired.value.retire('2026-10-27T10:02:00.000Z');
    expect(again.success).toBe(true);
    if (!again.success) {
      return;
    }
    expect(again.value.toRecord()).toEqual(retired.value.toRecord());
  });
});

describe('canClaim', () => {
  it('answers for declared kinds only', () => {
    const session = OrchestratorSession.create(VALID);
    if (!session.success) {
      throw new Error('VALID must construct');
    }
    expect(session.value.canClaim('dispatch-attempt')).toBe(true);
    expect(session.value.canClaim('start-lane-run')).toBe(false);
    expect(session.value.canClaim('merge')).toBe(false);
  });
});

describe('aggregate boundary', () => {
  it('is not a coordination kind', () => {
    for (const kind of ORCHESTRATOR_REQUEST_KINDS) {
      expect(COORDINATION_KINDS).not.toContain(kind);
    }
    expect(COORDINATION_KINDS).not.toContain('orchestrator-session');
  });

  it('validates and stores the same array: an own iterator cannot hide a refused value', () => {
    const scopes: string[] = ['dispatch'];
    Object.defineProperty(scopes, Symbol.iterator, {
      value: function* fakeIterator() {
        yield 'read';
      },
    });
    const result = OrchestratorSession.create({ ...VALID, scopes });
    expect(result.success).toBe(false);
  });
});
