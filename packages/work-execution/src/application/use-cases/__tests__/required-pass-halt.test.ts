import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isRequiredPassHalted } from '../chain-pass-halt.js';

describe('isRequiredPassHalted', () => {
  it('undefined is halted', async () => {
    expect(await isRequiredPassHalted(undefined, types.isProxy)).toBe(true);
  });

  it('null is halted and nothing is thrown', async () => {
    expect(await isRequiredPassHalted(null, types.isProxy)).toBe(true);
  });

  it('a port object without read is halted', async () => {
    expect(await isRequiredPassHalted({} as never, types.isProxy)).toBe(true);
  });

  it('a throwing read getter is halted and nothing is thrown', async () => {
    const halt = {
      get read(): never {
        throw new Error('getter threw');
      },
    } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a read that rejects is halted', async () => {
    const halt = {
      read: async () => {
        throw new Error('read rejected');
      },
    } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a read that answers null is halted', async () => {
    const halt = { read: async () => null } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a read that answers an array is halted', async () => {
    const halt = { read: async () => [] } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a state of garbage is halted', async () => {
    const halt = { read: async () => ({ state: 'garbage' }) } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a state of unreadable is halted', async () => {
    const halt = { read: async () => ({ state: 'unreadable' }) } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a clear answer with a halted true record is halted', async () => {
    const halt = {
      read: async () => ({
        state: 'clear',
        record: { version: 1, halted: true, changedAtIso: '2026-11-01T12:00:00.000Z' },
      }),
    } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(true);
  });

  it('a clear answer with a null record is not halted', async () => {
    const halt = { read: async () => ({ state: 'clear', record: null }) } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(false);
  });

  it('a clear answer with a halted false record is not halted', async () => {
    const halt = {
      read: async () => ({
        state: 'clear',
        record: { version: 1, halted: false, changedAtIso: '2026-11-01T12:00:00.000Z' },
      }),
    } as never;
    expect(await isRequiredPassHalted(halt, types.isProxy)).toBe(false);
  });
});
