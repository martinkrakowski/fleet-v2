import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  isChainPassHalted,
  isKillallHalted,
  isKillallTrainPaused,
  isTrainStepBlocked,
} from '../chain-pass-halt.js';

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
      expect(await isChainPassHalted(undefined, types.isProxy)).toBe(false);
    });

    it('returns true when halt port has no callable read method', async () => {
      // Guard: the `typeof halt.read !== 'function'` branch; each of these
      // shapes misses it only if the implementation skips the check, in which
      // case `{}` throws instead of answering `true`.
      expect(await isChainPassHalted({} as never, types.isProxy)).toBe(true);
      expect(await isChainPassHalted({ read: 1 } as never, types.isProxy)).toBe(true);
      expect(await isChainPassHalted({ read: null } as never, types.isProxy)).toBe(true);
    });
  });

  describe('clear answers', () => {
    it('returns false when clear answer has a null record', async () => {
      // Guard: the `record === null` short-circuit under `state: 'clear'`;
      // an implementation that runs the record validator on `null` answers
      // `true` and fails here.
      const read = vi.fn(async () => ({ state: 'clear', record: null }) as never);
      expect(await isChainPassHalted({ read } as never, types.isProxy)).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns false when clear answer has an agreeing halted-false record', async () => {
      // Guard: the `read.ok && read.record.halted === false` verdict; an
      // implementation that answers a constant `false` passes only the false
      // cases and fails the halted/unreadable cases below.
      const read = vi.fn(async () => ({ state: 'clear', record: validRecord() }) as never);
      expect(await isChainPassHalted({ read } as never, types.isProxy)).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-clear and invalid-record answers', () => {
    it('returns true when state is halted', async () => {
      // Guard: the `tag !== 'clear'` branch with the documented 'halted' tag.
      const read = vi.fn(async () => ({ state: 'halted', record: validRecord() }) as never);
      expect(await isChainPassHalted({ read } as never, types.isProxy)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns true when state is an unknown tag', async () => {
      // Guard: any tag other than 'clear' fails closed; unknown is never success.
      expect(await isChainPassHalted({ read: async () => ({ state: 'garbage' }) } as never, types.isProxy)).toBe(true);
    });

    it('returns true when state is unreadable', async () => {
      // Guard: `unreadable` is a halt (fail closed), never a success.
      expect(await isChainPassHalted({ read: async () => ({ state: 'unreadable' }) } as never, types.isProxy)).toBe(true);
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
        } as never, types.isProxy),
      ).toBe(true);
    });

    it('returns true when clear answer omits record', async () => {
      // Guard: a missing `record` key reads as `undefined`, not `null`, so the
      // `record === null` excuse must not fire; an implementation that treats
      // any falsy record as null answers `false` and fails here.
      expect(await isChainPassHalted({ read: async () => ({ state: 'clear' }) } as never, types.isProxy)).toBe(true);
    });

    it('returns true when clear record is an array', async () => {
      // Guard: `Array.isArray(record)` before the record validator; arrays are
      // not plain records even though `typeof [] === 'object'`.
      expect(await isChainPassHalted({ read: async () => ({ state: 'clear', record: [] }) } as never, types.isProxy)).toBe(true);
    });

    it('returns true when clear record is an array with a hole', async () => {
      // Guard: the same array refusal covers a sparse array; a hole never
      // makes an array pass as a record.
      const holey = [undefined as unknown];
      delete holey[0];
      expect(
        await isChainPassHalted({ read: async () => ({ state: 'clear', record: holey }) } as never, types.isProxy),
      ).toBe(true);
    });

    it('returns true when clear record is malformed', async () => {
      // Guard: readConductorHaltRecord refuses each malformed record, and
      // isChainPassHalted answers `true` for every refused record; each case
      // here breaks one of the three required fields' rules.
      const read = async (record: unknown) =>
        isChainPassHalted({ read: async () => ({ state: 'clear', record }) } as never, types.isProxy);
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
        } as never, types.isProxy),
      ).toBe(true);
    });
  });

  describe('hostile answers and throws', () => {
    it('returns true when read resolves to a non-object or boxed primitive', async () => {
      // Guard: the `typeof state !== 'object' || state === null ||
      // Array.isArray(state)` refusal; `new String('clear')` is boxed, not a
      // plain object, so a truthy-object shortcut fails this case.
      const read = async (answer: unknown) =>
        isChainPassHalted({ read: async () => answer } as never, types.isProxy);
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
      expect(await isChainPassHalted({ read } as never, types.isProxy)).toBe(true);
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
      expect(await isChainPassHalted({ read: async () => answer } as never, types.isProxy)).toBe(true);
    });

    it('returns true when read throws synchronously', async () => {
      // Guard: a sync throw from `read` (a failed command or unreadable file
      // surfaced by the port) is caught and read as halted, never thrown.
      const read = vi.fn(() => {
        throw new Error('read threw');
      });
      expect(await isChainPassHalted({ read } as never, types.isProxy)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns true when read returns a rejected promise', async () => {
      // Guard: a rejected promise from `read` (timeout, transport failure) is
      // caught and read as halted, never thrown.
      const read = vi.fn(async () => {
        throw new Error('read rejected');
      });
      expect(await isChainPassHalted({ read } as never, types.isProxy)).toBe(true);
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
        await isChainPassHalted({ read: async () => ({ state: 'clear', record }) } as never, types.isProxy),
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

describe('KA3-1: null-safe chain pass and fail-closed killall reads', () => {
  const clearMarker = { state: 'clear' };
  const haltedMarker = { state: 'halted' };

  it('isChainPassHalted returns false without throwing when halt is null', async () => {
    // Guard: the `halt === null` arm of the absent-dependency check. The
    // pre-KA3-1 implementation read `halt.read` on `null` and threw a
    // TypeError, so a call without that arm throws instead of answering.
    await expect(isChainPassHalted(null, types.isProxy)).resolves.toBe(false);
  });

  it('isTrainStepBlocked treats null halt as not blocked when requireConductorHalt is false', async () => {
    // Guard: `isChainPassHalted(deps.halt, types.isProxy)` (the false branch) with a null
    // halt plus absent killall reads; every part answers false, so a
    // constant-true or required-pass (null = halted) implementation fails.
    await expect(isTrainStepBlocked({ halt: null }, false)).resolves.toBe(false);
  });

  it('isTrainStepBlocked treats null halt as blocked when requireConductorHalt is true', async () => {
    // Guard: `isRequiredPassHalted(deps.halt, types.isProxy)` (the true branch), whose
    // fail-closed contract answers halted for a null halt.
    await expect(isTrainStepBlocked({ halt: null }, true)).resolves.toBe(true);
  });

  it('isKillallHalted returns false for a clear marker', async () => {
    // Guard: the only not-halted answer, exactly `{ state: 'clear' }`, read
    // through the bounded snapshot and the exact-key record check.
    const read = vi.fn(async () => clearMarker as never);
    await expect(isKillallHalted({ read } as never, types.isProxy)).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('isKillallHalted returns false for an undefined marker read', async () => {
    // Guard: `killallHalt === undefined` is the NOT-halted case, so a
    // fail-closed-everything (constant true) implementation fails here.
    await expect(isKillallHalted(undefined, types.isProxy)).resolves.toBe(false);
  });

  it('isKillallHalted returns false when the read method is absent', async () => {
    // Guard: the `killallHalt.read === undefined` arm, distinct from a
    // non-callable read; `{}` keeps the absent-dependency behaviour.
    await expect(isKillallHalted({} as never, types.isProxy)).resolves.toBe(false);
  });

  it('isKillallHalted returns true for a halted marker', async () => {
    // Guard: a 'halted' state is a halt; an implementation that trusts only
    // 'clear' still passes this, so it pins nothing alone — it rules out a
    // constant-false implementation together with the clear cases.
    await expect(isKillallHalted({ read: async () => haltedMarker } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true when read returns null', async () => {
    // Guard: a `null` read answer is not a plain record, so the snapshot or
    // exact-key read refuses it and the verdict is halted.
    await expect(isKillallHalted({ read: async () => null } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true when read throws', async () => {
    // Guard: a synchronous throw from `read` is caught and read as halted.
    const read = vi.fn(() => {
      throw new Error('read threw');
    });
    await expect(isKillallHalted({ read } as never, types.isProxy)).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('isKillallHalted returns true when read rejects', async () => {
    // Guard: a rejected promise from `read` is caught and read as halted.
    await expect(
      isKillallHalted({
        read: async () => {
          throw new Error('read rejected');
        },
      } as never, types.isProxy),
    ).resolves.toBe(true);
  });

  it('isKillallHalted returns true when killallHalt.read resolves to undefined', async () => {
    // Guard: `undefined` as the read ANSWER is off-contract (distinct from an
    // undefined port or an absent read method) and fails closed.
    await expect(isKillallHalted({ read: async () => undefined } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true when killallHalt.read resolves to a non-iterable or wrong primitive', async () => {
    // Guard: wrong primitives are refused by the snapshot ('unsupported-type'
    // or not-plain) and never read as clear.
    for (const answer of [1, 'clear', true, Symbol.iterator, 1n, () => 'clear']) {
      await expect(isKillallHalted({ read: async () => answer } as never, types.isProxy)).resolves.toBe(true);
    }
  });

  it('isKillallHalted returns true when killallHalt.read resolves to an array or sparse array with a hole', async () => {
    // Guard: `maxArrayLength: 0` refuses a non-empty array and an array is
    // never a plain record; a hole cannot make an array pass.
    const holey: string[] = ['clear'];
    delete holey[0];
    await expect(isKillallHalted({ read: async () => ['clear'] } as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallHalted({ read: async () => holey } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true when killallHalt.read resolves to an array-like object', async () => {
    // Guard: an array-like has a numeric own key the exact-key read refuses
    // (exactly ['state']), so it never reads as clear.
    await expect(
      isKillallHalted({ read: async () => ({ length: 1, 0: 'clear', state: 'clear' }) } as never, types.isProxy),
    ).resolves.toBe(true);
  });

  it('isKillallHalted returns true without invoking own or inherited getters', async () => {
    // Guard: the snapshot reads every own property through its descriptor and
    // refuses accessors without firing them; an inherited getter is not an own
    // key, so the exact-key count refuses the answer either way. An
    // implementation that reads `answer.state` directly fires the getter.
    let ownFired = false;
    const ownGetter: Record<string, unknown> = {};
    Object.defineProperty(ownGetter, 'state', {
      get() {
        ownFired = true;
        return 'clear';
      },
      enumerable: true,
      configurable: true,
    });
    await expect(isKillallHalted({ read: async () => ownGetter } as never, types.isProxy)).resolves.toBe(true);
    expect(ownFired).toBe(false);

    let inheritedFired = false;
    const inheritedProto = {} as { state?: string };
    Object.defineProperty(inheritedProto, 'state', {
      get() {
        inheritedFired = true;
        return 'clear';
      },
      enumerable: true,
      configurable: true,
    });
    const inherited = Object.create(inheritedProto) as Record<string, unknown>;
    await expect(isKillallHalted({ read: async () => inherited } as never, types.isProxy)).resolves.toBe(true);
    expect(inheritedFired).toBe(false);
  });

  it('isKillallHalted refuses a Proxy answer via the injected detector including counting and throwing traps', async () => {
    // Guard: the snapshot runs the injected `types.isProxy` detector before
    // any reflection, so even a Proxy whose traps report a plain
    // `{ state: 'clear' }` never reads as clear and no field is read through a trap.
    const keysRead: PropertyKey[] = [];
    const counting = new Proxy({ state: 'clear' }, {
      get(target, key, receiver) {
        keysRead.push(key);
        if (keysRead.length > 2) {
          throw new Error('trap budget exhausted');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(isKillallHalted({ read: async () => counting } as never, types.isProxy)).resolves.toBe(true);
    // The only `get` the engine itself issues is the promise machinery's `then` lookup when an async
    // read resolves with the Proxy; the snapshot never reads `state` through a trap.
    expect(keysRead.filter((key) => key !== 'then')).toEqual([]);

    const throwing = new Proxy({ state: 'clear' }, {
      get(): never {
        throw new Error('get trap threw');
      },
    });
    await expect(isKillallHalted({ read: async () => throwing } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true for a revoked Proxy without throwing', async () => {
    // Guard: a revoked Proxy throws on the snapshot's first reflection
    // operation; `snapshotPlainData` catches it and the verdict fails closed
    // instead of rejecting the promise.
    const { proxy, revoke } = Proxy.revocable<{ state?: string }>({ state: 'clear' }, {});
    revoke();
    await expect(isKillallHalted({ read: async () => proxy } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true for an enormous key or string length within bounds', async () => {
    // Guard: `maxStringLength: 128` refuses a longer state value and a longer
    // own key ('too-long'), and the cost stays bounded because the refusal
    // never echoes the text.
    await expect(
      isKillallHalted({ read: async () => ({ state: 'c'.repeat(129) }) } as never, types.isProxy),
    ).resolves.toBe(true);
    const longKey: Record<string, unknown> = {};
    Object.defineProperty(longKey, 'x'.repeat(129), { value: 'clear', enumerable: true });
    await expect(isKillallHalted({ read: async () => longKey } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true for prototype-polluting own keys __proto__, constructor, and prototype', async () => {
    // Guard: an own reserved key is an extra own key the exact-key read
    // refuses, and the snapshot's defineProperty copy keeps Object.prototype
    // clean; a write-through-assignment implementation pollutes it.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const answer: Record<string, unknown> = { state: 'clear' };
      Object.defineProperty(answer, key, { value: 'clear', enumerable: true, writable: true, configurable: true });
      await expect(isKillallHalted({ read: async () => answer } as never, types.isProxy)).resolves.toBe(true);
    }
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it('isKillallHalted returns true when answer has a Symbol.iterator override', async () => {
    // Guard: a symbol own key ('symbol-key' in the snapshot, and the
    // exact-key count) refuses the answer, so an answer shaped to be iterable
    // never reads as clear.
    const answer: Record<string, unknown> = { state: 'clear' };
    Object.defineProperty(answer, Symbol.iterator, {
      value: function* () {
        yield 'clear';
      },
      enumerable: true,
      configurable: true,
    });
    await expect(isKillallHalted({ read: async () => answer } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isChainPassHalted returns true when clear record has invalid version, non-boolean halted, or invalid changedAtIso', async () => {
    // Guard: the exact-key snapshot plus readConductorHaltRecord keep the
    // fail-closed record agreement under a 'clear' tag.
    const read = async (record: unknown) =>
      isChainPassHalted({ read: async () => ({ state: 'clear', record }) } as never, types.isProxy);
    await expect(read({ version: 2, halted: false, changedAtIso: '2026-11-01T12:00:00.000Z' })).resolves.toBe(true);
    await expect(read({ version: 1, halted: 'false', changedAtIso: '2026-11-01T12:00:00.000Z' })).resolves.toBe(true);
    await expect(read({ version: 1, halted: false, changedAtIso: '2026-11-01T12:00:00' })).resolves.toBe(true);
  });

  it('isKillallTrainPaused returns false only for clear and true for paused, unreadable, null, throwing, and hostile answers', async () => {
    // Guard: the pause read mirrors the halt read over exactly
    // `{ status: 'clear' }`; everything else — 'paused', 'unreadable', a
    // null or missing port, a throw, a rejection, a wrong primitive, an
    // array, an accessor, an extra key — is a pause (fail closed).
    await expect(isKillallTrainPaused(undefined, types.isProxy)).resolves.toBe(false);
    await expect(isKillallTrainPaused({ read: async () => ({ status: 'clear' }) } as never, types.isProxy)).resolves.toBe(false);
    await expect(isKillallTrainPaused({ read: async () => ({ status: 'paused' }) } as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused({ read: async () => ({ status: 'unreadable' }) } as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused(null as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused({ read: 1 } as never, types.isProxy)).resolves.toBe(true);
    await expect(
      isKillallTrainPaused({
        read: () => {
          throw new Error('read threw');
        },
      } as never, types.isProxy),
    ).resolves.toBe(true);
    await expect(
      isKillallTrainPaused({
        read: async () => {
          throw new Error('read rejected');
        },
      } as never, types.isProxy),
    ).resolves.toBe(true);
    await expect(isKillallTrainPaused({ read: async () => null } as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused({ read: async () => ({ status: 'clear', extra: 1 }) } as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused({ read: async () => ({}) } as never, types.isProxy)).resolves.toBe(true);
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'status', {
      get: () => 'clear',
      enumerable: true,
      configurable: true,
    });
    await expect(isKillallTrainPaused({ read: async () => accessor } as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true for a port whose read accessor throws, without throwing', async () => {
    // Guard: a throwing read accessor on the port is caught by the method
    // lookup and read fail-closed, never rejecting the promise.
    const port: Record<string, unknown> = {};
    Object.defineProperty(port, 'read', {
      get(): never {
        throw new Error('port read accessor threw');
      },
      enumerable: true,
      configurable: true,
    });
    await expect(isKillallHalted(port as never, types.isProxy)).resolves.toBe(true);
    await expect(isChainPassHalted(port as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused(port as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true for a revoked Proxy port without throwing', async () => {
    // Guard: a revoked Proxy port throws on the method lookup; the refusal
    // is caught and read fail-closed instead of rejecting the promise.
    const { proxy, revoke } = Proxy.revocable<{ read?: unknown }>({ read: async () => ({ state: 'clear' }) }, {});
    revoke();
    await expect(isKillallHalted(proxy as never, types.isProxy)).resolves.toBe(true);
    await expect(isChainPassHalted(proxy as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused(proxy as never, types.isProxy)).resolves.toBe(true);
  });

  it('isKillallHalted returns true for a Proxy port with lying reflection traps without running any trap', async () => {
    // Guard: a Proxy port with a cyclic lying prototype and a throwing
    // descriptor trap is refused by the detector before any trap runs, never
    // answered as not halted.
    let descriptors = 0;
    const portRef: { current?: object } = {};
    const port: object = new Proxy(
      {},
      {
        // A cyclic lying prototype chain keeps every hop on the Proxy, so the
        // descriptor trap is hit again and its budget exhausts.
        getOwnPropertyDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
          descriptors += 1;
          if (descriptors > 1) {
            throw new Error('trap budget exhausted');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(): object {
          return portRef.current as object;
        },
      },
    );
    portRef.current = port;
    await expect(isKillallHalted(port as never, types.isProxy)).resolves.toBe(true);
    expect(descriptors).toBe(0);
  });

  it('isKillallHalted reads an inherited read method through the prototype chain', async () => {
    // Guard: a normal adapter whose `read` lives on its prototype still
    // answers: the Proxy refusal must not break ordinary ports.
    const proto = { read: async () => ({ state: 'clear' }) };
    await expect(isKillallHalted(Object.create(proto) as never, types.isProxy)).resolves.toBe(false);
  });

  it('isKillallHalted returns true for a Proxy port whose traps hide the read method, without running a trap', async () => {
    // Guard: fix round 2, item 1. A Proxy can hide its own `read` descriptor
    // and report a null prototype, which the descriptor walk alone would
    // misread as a genuinely absent method — and an absent read is the
    // NOT-halted case, so the halt guard was bypassed. The trusted detector
    // (`types.isProxy`, threaded from the composition) refuses the port
    // before any reflection, so the verdict fails closed to halted and no
    // descriptor or prototype trap ever runs.
    let descriptorTraps = 0;
    let prototypeTraps = 0;
    const hiding = new Proxy(
      { read: async () => ({ state: 'halted' }) },
      {
        getOwnPropertyDescriptor(): undefined {
          descriptorTraps += 1;
          return undefined;
        },
        getPrototypeOf(): null {
          prototypeTraps += 1;
          return null;
        },
      },
    );
    await expect(isKillallHalted(hiding as never, types.isProxy)).resolves.toBe(true);
    expect(descriptorTraps).toBe(0);
    expect(prototypeTraps).toBe(0);

    // The same hiding shape on the other two reads, fail closed as well.
    await expect(isChainPassHalted(hiding as never, types.isProxy)).resolves.toBe(true);
    await expect(isKillallTrainPaused(hiding as never, types.isProxy)).resolves.toBe(true);

    // A lying descriptor trap that reports a fake `read` data property is
    // refused the same way, and the trap still never runs.
    const lying = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): PropertyDescriptor {
          descriptorTraps += 1;
          return { value: async () => ({ state: 'clear' }), writable: true, enumerable: true, configurable: true };
        },
      },
    );
    await expect(isKillallHalted(lying as never, types.isProxy)).resolves.toBe(true);
    expect(descriptorTraps).toBe(0);

    // And the whole train-step guard blocks on a hiding Proxy port.
    await expect(
      isTrainStepBlocked({ killallHalt: hiding as never }, false, types.isProxy),
    ).resolves.toBe(true);
  });
});
