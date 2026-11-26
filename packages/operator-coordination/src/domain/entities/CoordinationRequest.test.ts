import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../coordination-records.js';
import { CoordinationRequest } from './CoordinationRequest.js';

function allTrapsThrowingProxy(): unknown {
  const handler: ProxyHandler<object> = {
    getPrototypeOf() {
      throw new Error('trap');
    },
    setPrototypeOf() {
      throw new Error('trap');
    },
    isExtensible() {
      throw new Error('trap');
    },
    preventExtensions() {
      throw new Error('trap');
    },
    getOwnPropertyDescriptor() {
      throw new Error('trap');
    },
    defineProperty() {
      throw new Error('trap');
    },
    has() {
      throw new Error('trap');
    },
    get() {
      throw new Error('trap');
    },
    set() {
      throw new Error('trap');
    },
    deleteProperty() {
      throw new Error('trap');
    },
    ownKeys() {
      throw new Error('trap');
    },
  };
  return new Proxy({}, handler);
}

function throwingToStringObject(): unknown {
  return {
    toString() {
      throw new Error('coerced');
    },
    valueOf() {
      throw new Error('coerced');
    },
  };
}

function baseRecord(): Record<string, unknown> {
  return {
    id: 'req-1',
    projectId: 'project-1',
    actionScope: 'merge:main',
    proposalDigest: 'digest-1',
    policyRevision: 'rev-1',
    createdAtIso: '2026-11-26T00:00:00.000Z',
    updatedAtIso: '2026-11-26T00:00:00.000Z',
    expectedHeadSha: null,
    decisionRevision: null,
    grantId: null,
    kind: 'action-decision',
    state: 'proposed',
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 0,
    consumptions: [],
    acknowledgements: [],
  };
}

function recordWith(patch: Record<string, unknown>): CoordinationRequestRecord {
  return { ...baseRecord(), ...patch } as unknown as CoordinationRequestRecord;
}

describe('CoordinationRequest.fromRecord', () => {
  it('refuses a null record', () => {
    expect(() => CoordinationRequest.fromRecord(null as unknown as CoordinationRequestRecord)).toThrow(
      'CoordinationRequest requires a record',
    );
  });

  it('refuses an accessor property on kind with a named error and never runs the getter', () => {
    const record = baseRecord() as Record<string, unknown>;
    let getterRuns = 0;
    Object.defineProperty(record, 'kind', {
      get() {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    let message = '';
    try {
      CoordinationRequest.fromRecord(record as unknown as CoordinationRequestRecord);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(getterRuns).toBe(0);
    expect(message).toBe('CoordinationRequest kind cannot be an accessor property.');
  });

  it('refuses an accessor property on state with a named error and never runs the getter', () => {
    const record = baseRecord() as Record<string, unknown>;
    let getterRuns = 0;
    Object.defineProperty(record, 'state', {
      get() {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    let message = '';
    try {
      CoordinationRequest.fromRecord(record as unknown as CoordinationRequestRecord);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(getterRuns).toBe(0);
    expect(message).toBe('CoordinationRequest state cannot be an accessor property.');
  });

  it('refuses an accessor property on deliveryStatus with a named error and never runs the getter', () => {
    const record = baseRecord() as Record<string, unknown>;
    let getterRuns = 0;
    Object.defineProperty(record, 'deliveryStatus', {
      get() {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    let message = '';
    try {
      CoordinationRequest.fromRecord(record as unknown as CoordinationRequestRecord);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(getterRuns).toBe(0);
    expect(message).toBe('CoordinationRequest deliveryStatus cannot be an accessor property.');
  });

  it('refuses a record Proxy whose getOwnPropertyDescriptor trap throws on kind with a named trap refusal', () => {
    // Only the descriptor trap throws: the plain get reads succeed through the
    // earlier field loops, then the descriptor snapshot itself is refused by
    // name instead of letting the trap escape.
    const target = baseRecord() as object;
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    let message = '';
    try {
      CoordinationRequest.fromRecord(hostile as unknown as CoordinationRequestRecord);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'CoordinationRequest kind validation failed due to a prohibited Proxy trap execution.',
    );
  });

  it('refuses a throwing-toString object on kind with a message ending in <object>', () => {
    expect(() => CoordinationRequest.fromRecord(recordWith({ kind: throwingToStringObject() }))).toThrow(
      'CoordinationRequest has an invalid kind: <object>',
    );
  });

  it('refuses an all-traps-throwing Proxy on kind with a message ending in <object>', () => {
    expect(() => CoordinationRequest.fromRecord(recordWith({ kind: allTrapsThrowingProxy() }))).toThrow(
      'CoordinationRequest has an invalid kind: <object>',
    );
  });

  it('refuses a runtime-built token-shaped string on kind without echoing the token', () => {
    const token = ['tok', 'live', 'secret99'].join('_');
    let message = '';
    try {
      CoordinationRequest.fromRecord(recordWith({ kind: token }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('CoordinationRequest has an invalid kind: <string>');
    expect(message).not.toContain(token);
  });

  it('refuses a throwing-toString object on state with a message ending in <object>', () => {
    expect(() => CoordinationRequest.fromRecord(recordWith({ state: throwingToStringObject() }))).toThrow(
      'CoordinationRequest has an invalid state: <object>',
    );
  });

  it('refuses an all-traps-throwing Proxy on state with a message ending in <object>', () => {
    expect(() => CoordinationRequest.fromRecord(recordWith({ state: allTrapsThrowingProxy() }))).toThrow(
      'CoordinationRequest has an invalid state: <object>',
    );
  });

  it('refuses a runtime-built token-shaped string on state without echoing the token', () => {
    const token = ['tok', 'live', 'secret99'].join('_');
    let message = '';
    try {
      CoordinationRequest.fromRecord(recordWith({ state: token }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('CoordinationRequest has an invalid state: <string>');
    expect(message).not.toContain(token);
  });

  it('refuses a throwing-toString object on deliveryStatus with a message ending in <object>', () => {
    expect(() =>
      CoordinationRequest.fromRecord(recordWith({ deliveryStatus: throwingToStringObject() })),
    ).toThrow('CoordinationRequest has an invalid delivery status: <object>');
  });

  it('refuses an all-traps-throwing Proxy on deliveryStatus with a message ending in <object>', () => {
    expect(() =>
      CoordinationRequest.fromRecord(recordWith({ deliveryStatus: allTrapsThrowingProxy() })),
    ).toThrow('CoordinationRequest has an invalid delivery status: <object>');
  });

  it('refuses a runtime-built token-shaped string on deliveryStatus without echoing the token', () => {
    const token = ['tok', 'live', 'secret99'].join('_');
    let message = '';
    try {
      CoordinationRequest.fromRecord(recordWith({ deliveryStatus: token }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('CoordinationRequest has an invalid delivery status: <string>');
    expect(message).not.toContain(token);
  });
  it('reads every field of a record Proxy exactly once through its descriptor and never through a get trap', () => {
    const target = baseRecord() as Record<string, unknown>;
    let getCalls = 0;
    const descriptorReads = new Map<string, number>();
    const hostile = new Proxy(target, {
      get() {
        getCalls += 1;
        throw new Error('get trap must never run');
      },
      getOwnPropertyDescriptor(t, key) {
        descriptorReads.set(String(key), (descriptorReads.get(String(key)) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    const request = CoordinationRequest.fromRecord(hostile as unknown as CoordinationRequestRecord);
    expect(getCalls).toBe(0);
    for (const key of ['kind', 'state', 'deliveryStatus', 'id', 'actionScope', 'revision']) {
      expect(descriptorReads.get(key)).toBe(1);
    }
    expect([...descriptorReads.values()].every((count) => count === 1)).toBe(true);
    expect(request.toRecord().kind).toBe('action-decision');
    expect(request.toRecord().state).toBe('proposed');
    expect(request.toRecord().deliveryStatus).toBe('pending');
    expect(request.getId()).toBe('req-1');
  });

  it('stores the descriptor snapshot, so a value that changes after the snapshot cannot reach the stored record', () => {
    const target = baseRecord() as Record<string, unknown>;
    const hostile = new Proxy(target, {
      get(t, key) {
        // A raw read would see a different, unvalidated value.
        return key === 'state' ? 'approved' : Reflect.get(t, key);
      },
    });
    const request = CoordinationRequest.fromRecord(hostile as unknown as CoordinationRequestRecord);
    expect(request.toRecord().state).toBe('proposed');
  });
});
