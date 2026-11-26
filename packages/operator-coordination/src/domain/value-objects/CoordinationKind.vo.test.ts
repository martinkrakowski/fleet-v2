import { describe, expect, it } from 'vitest';

import { CoordinationKind } from './CoordinationKind.vo.js';

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

describe('CoordinationKind.create', () => {
  it('refuses a throwing-toString object with a message ending in <object>', () => {
    const hostile = {
      toString() {
        throw new Error('coerced');
      },
      valueOf() {
        throw new Error('coerced');
      },
    };
    const result = CoordinationKind.create(hostile);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid coordination kind: <object>');
  });

  it('refuses an all-traps-throwing Proxy over {} with a message ending in <object>', () => {
    const result = CoordinationKind.create(allTrapsThrowingProxy());
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid coordination kind: <object>');
  });

  it('refuses a runtime-built token-shaped string without echoing the token', () => {
    const token = ['tok', 'live', 'secret99'].join('_');
    const result = CoordinationKind.create(token);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid coordination kind: <string>');
    expect(result.error?.message).not.toContain(token);
  });
});
