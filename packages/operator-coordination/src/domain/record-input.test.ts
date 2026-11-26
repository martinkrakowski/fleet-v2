import { describe, expect, it } from 'vitest';

import { describeRejectedValue } from './record-input.js';

describe('describeRejectedValue', () => {
  it('reports null as <null>', () => {
    expect(describeRejectedValue(null)).toBe('<null>');
  });

  it('reports an array as <array>', () => {
    expect(describeRejectedValue([1, 2])).toBe('<array>');
  });

  it('reports a revoked Proxy as <object> without throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeRejectedValue(proxy)).toBe('<object>');
  });

  it('reports a number as <number>', () => {
    expect(describeRejectedValue(7)).toBe('<number>');
  });

  it('reports a runtime-built token-shaped string as <string> without echoing it', () => {
    const token = ['tok', 'live', 'secret99'].join('_');
    expect(describeRejectedValue(token)).toBe('<string>');
    expect(describeRejectedValue(token)).not.toContain(token);
  });

  it('reports a plain object as <object>', () => {
    expect(describeRejectedValue({ a: 1 })).toBe('<object>');
  });

  it('reports a throwing-toString object as <object> without invoking toString', () => {
    const hostile = {
      toString() {
        throw new Error('coerced');
      },
      valueOf() {
        throw new Error('coerced');
      },
    };
    expect(describeRejectedValue(hostile)).toBe('<object>');
  });

  it('reports a function as <function>', () => {
    expect(describeRejectedValue(() => {})).toBe('<function>');
  });

  it('reports a symbol as <symbol>', () => {
    expect(describeRejectedValue(Symbol('s'))).toBe('<symbol>');
  });

  it('reports undefined as <undefined>', () => {
    expect(describeRejectedValue(undefined)).toBe('<undefined>');
  });
});
