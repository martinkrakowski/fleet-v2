import { describe, expect, it } from 'vitest';

import { CoordinationState } from './CoordinationState.vo.js';

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

describe('CoordinationState.create', () => {
  it('refuses a throwing-toString object with a message ending in <object>', () => {
    const hostile = {
      toString() {
        throw new Error('coerced');
      },
      valueOf() {
        throw new Error('coerced');
      },
    };
    const result = CoordinationState.create(hostile);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid coordination state: <object>');
  });

  it('refuses an all-traps-throwing Proxy over {} with a message ending in <object>', () => {
    const result = CoordinationState.create(allTrapsThrowingProxy());
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid coordination state: <object>');
  });

  it('refuses a runtime-built token-shaped string without echoing the token', () => {
    const token = ['tok', 'live', 'secret99'].join('_');
    const result = CoordinationState.create(token);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Invalid coordination state: <string>');
    expect(result.error?.message).not.toContain(token);
  });

  it('constructs the declared unknown state but never grants authority', () => {
    const result = CoordinationState.create('unknown');
    expect(result.success).toBe(true);
    expect(result.value?.canAuthorizeExecution()).toBe(false);
  });
});
