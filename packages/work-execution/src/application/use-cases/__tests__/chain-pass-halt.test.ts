import { describe, expect, it, vi } from 'vitest';
import { isChainPassHalted } from '../chain-pass-halt.js';

const validRecord = () => ({
  version: 1,
  halted: false,
  changedAtIso: '2026-11-01T12:00:00.000Z',
});

describe('isChainPassHalted', () => {
  describe('absent dependency and invalid port shape', () => {
    it('returns false when halt dependency is undefined', async () => {
      // Guard: an absent dependency keeps the optional chain-pass semantics,
      // so only exactly `undefined` reads as not halted; `null` is not
      // excused (it is not callable and not undefined) and would fail here.
      expect(await isChainPassHalted(undefined)).toBe(false);
    });

    it('returns true when halt port has no callable read method', async () => {
      // Guard: the `typeof halt.read !== 'function'` branch; each of these
      // shapes misses it only if the implementation skips the check, in which
      // case `{}` throws instead of answering `true`.
      expect(await isChainPassHalted({} as never)).toBe(true);
      expect(await isChainPassHalted({ read: 1 } as never)).toBe(true);
      expect(await isChainPassHalted({ read: null } as never)).toBe(true);
    });
  });

  describe('clear answers', () => {
    it('returns false when clear answer has a null record', async () => {
      // Guard: the `record === null` short-circuit under `state: 'clear'`;
      // an implementation that runs the record validator on `null` answers
      // `true` and fails here.
      const read = vi.fn(async () => ({ state: 'clear', record: null }) as never);
      expect(await isChainPassHalted({ read } as never)).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns false when clear answer has an agreeing halted-false record', async () => {
      // Guard: the `read.ok && read.record.halted === false` verdict; an
      // implementation that answers a constant `false` passes only the false
      // cases and fails the halted/unreadable cases below.
      const read = vi.fn(async () => ({ state: 'clear', record: validRecord() }) as never);
      expect(await isChainPassHalted({ read } as never)).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-clear and invalid-record answers', () => {
    it('returns true when state is halted', async () => {
      // Guard: the `tag !== 'clear'` branch with the documented 'halted' tag.
      const read = vi.fn(async () => ({ state: 'halted', record: validRecord() }) as never);
      expect(await isChainPassHalted({ read } as never)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns true when state is an unknown tag', async () => {
      // Guard: any tag other than 'clear' fails closed; unknown is never success.
      expect(await isChainPassHalted({ read: async () => ({ state: 'garbage' }) } as never)).toBe(true);
    });

    it('returns true when state is unreadable', async () => {
      // Guard: `unreadable` is a halt (fail closed), never a success.
      expect(await isChainPassHalted({ read: async () => ({ state: 'unreadable' }) } as never)).toBe(true);
    });

    it('returns true when clear record has halted true', async () => {
      // Guard: a record may agree only with `halted: false`; `halted: true`
      // under 'clear' is a contradiction and fails closed.
      expect(
        await isChainPassHalted({
          read: async () => ({
            state: 'clear',
            record: { version: 1, halted: true, changedAtIso: '2026-11-01T12:00:00.000Z' },
          }),
        } as never),
      ).toBe(true);
    });

    it('returns true when clear answer omits record', async () => {
      // Guard: a missing `record` key reads as `undefined`, not `null`, so the
      // `record === null` excuse must not fire; an implementation that treats
      // any falsy record as null answers `false` and fails here.
      expect(await isChainPassHalted({ read: async () => ({ state: 'clear' }) } as never)).toBe(true);
    });

    it('returns true when clear record is an array', async () => {
      // Guard: `Array.isArray(record)` before the record validator; arrays are
      // not plain records even though `typeof [] === 'object'`.
      expect(await isChainPassHalted({ read: async () => ({ state: 'clear', record: [] }) } as never)).toBe(true);
    });

    it('returns true when clear record is an array with a hole', async () => {
      // Guard: the same array refusal covers a sparse array; a hole never
      // makes an array pass as a record.
      const holey = [undefined as unknown];
      delete holey[0];
      expect(
        await isChainPassHalted({ read: async () => ({ state: 'clear', record: holey }) } as never),
      ).toBe(true);
    });

    it('returns true when clear record is malformed', async () => {
      // Guard: readConductorHaltRecord refuses each malformed record, and
      // isChainPassHalted answers `true` for every refused record; each case
      // here breaks one of the three required fields' rules.
      const read = async (record: unknown) =>
        isChainPassHalted({ read: async () => ({ state: 'clear', record }) } as never);
      expect(await read({ halted: false, changedAtIso: '2026-11-01T12:00:00.000Z' })).toBe(true);
      expect(await read({ version: 1, changedAtIso: '2026-11-01T12:00:00.000Z' })).toBe(true);
      expect(await read({ version: 2, halted: false, changedAtIso: '2026-11-01T12:00:00.000Z' })).toBe(true);
      expect(await read({ version: 1, halted: 'false', changedAtIso: '2026-11-01T12:00:00.000Z' })).toBe(true);
      expect(await read({ version: 1, halted: false, changedAtIso: '2026-11-01T12:00:00' })).toBe(true);
      expect(await read({ version: 1, halted: false, changedAtIso: 12 })).toBe(true);
      expect(await read({ version: 1, halted: false, changedAtIso: '2026-13-45T99:00:00.000Z' })).toBe(true);
    });

    it('returns true when clear record has an extra key', async () => {
      // Guard: the record validator accepts exactly the three keys
      // (ownKeys.length !== 3 is refused); a fourth own key is a refusal.
      expect(
        await isChainPassHalted({
          read: async () => ({
            state: 'clear',
            record: { ...validRecord(), extra: 'k' },
          }),
        } as never),
      ).toBe(true);
    });
  });

  describe('hostile answers and throws', () => {
    it('returns true when read resolves to a non-object or boxed primitive', async () => {
      // Guard: the `typeof state !== 'object' || state === null ||
      // Array.isArray(state)` refusal; `new String('clear')` is boxed, not a
      // plain object, so a truthy-object shortcut fails this case.
      const read = async (answer: unknown) =>
        isChainPassHalted({ read: async () => answer } as never);
      expect(await read(null)).toBe(true);
      expect(await read(undefined)).toBe(true);
      expect(await read('clear')).toBe(true);
      expect(await read(1)).toBe(true);
      expect(await read([])).toBe(true);
      expect(await read(new String('clear'))).toBe(true);
    });

    it('returns true when state is an own throwing getter', async () => {
      // Guard: the getter error is caught and mapped to `true`; it never
      // escapes, so a getter that throws must not reject the promise.
      const answer: Record<string, unknown> = {};
      Object.defineProperty(answer, 'state', {
        get(): never {
          throw new Error('state getter threw');
        },
        enumerable: true,
        configurable: true,
      });
      const read = vi.fn(async () => answer as never);
      expect(await isChainPassHalted({ read } as never)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns true when record is an own throwing getter', async () => {
      // Guard: under a clear tag, touching a throwing `record` getter fails
      // closed inside the catch, never letting the error escape.
      const answer: Record<string, unknown> = { state: 'clear' };
      Object.defineProperty(answer, 'record', {
        get(): never {
          throw new Error('record getter threw');
        },
        enumerable: true,
        configurable: true,
      });
      expect(await isChainPassHalted({ read: async () => answer } as never)).toBe(true);
    });

    it('returns true when read throws synchronously', async () => {
      // Guard: a sync throw from `read` (a failed command or unreadable file
      // surfaced by the port) is caught and read as halted, never thrown.
      const read = vi.fn(() => {
        throw new Error('read threw');
      });
      expect(await isChainPassHalted({ read } as never)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns true when read returns a rejected promise', async () => {
      // Guard: a rejected promise from `read` (timeout, transport failure) is
      // caught and read as halted, never thrown.
      const read = vi.fn(async () => {
        throw new Error('read rejected');
      });
      expect(await isChainPassHalted({ read } as never)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('prototype-polluting key', () => {
    it('returns true when clear record has an own __proto__ key', async () => {
      // Guard: an own `__proto__` key is a fourth own key, so the record
      // validator refuses it (fail closed) and Object.prototype stays clean;
      // an implementation that writes through `record['__proto__']` would
      // pollute the prototype and this assertion would see `true` polluted.
      const record: Record<string, unknown> = { ...validRecord() };
      Object.defineProperty(record, '__proto__', {
        value: { polluted: 'k' },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(
        await isChainPassHalted({ read: async () => ({ state: 'clear', record }) } as never),
      ).toBe(true);
      expect(({} as { polluted?: string }).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    });
  });

  // Proxy residual: a Proxy that lies consistently in every trap is an
  // accepted residual of the snapshot read and is deliberately not tested.

  // Cost bound: no deadline applies here. isChainPassHalted performs O(1)
  // type and tag checks and delegates record validation to
  // readConductorHaltRecord, whose readExactPlainRecord costs one
  // Reflect.ownKeys and refuses a wrong key count before reading any
  // descriptor; no budget or timeout surface exists at this layer — those
  // failure modes arrive through the port's read.
});
