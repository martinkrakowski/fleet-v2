import { describe, expect, it } from 'vitest';
import { isValidHostName } from '../index.js';

describe('isValidHostName (installation host-map key rule)', () => {
  it.each([
    ['solstice'],
    ['a'],
    ['A1'],
    ['host-1.lan'],
    ['h_2'],
    ['9host'],
    ['a'.repeat(128)],
  ])('accepts %j', (name) => {
    expect(isValidHostName(name)).toBe(true);
  });

  it.each([
    [''],
    ['a'.repeat(129)],
    ['-host'],
    ['.host'],
    ['_host'],
    ['host name'],
    ['host/x'],
    ['a..b'],
    ['host:22'],
    ['hôst'],
    ['constructor'],
    ['Prototype'],
    ['__proto__'],
    ['HasOwnProperty'],
  ])('refuses %j', (name) => {
    expect(isValidHostName(name)).toBe(false);
  });

  it('accepts names close to but not exactly the forbidden set', () => {
    expect(isValidHostName('proto')).toBe(true);
    expect(isValidHostName('constructors')).toBe(true);
  });
});
