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
});
