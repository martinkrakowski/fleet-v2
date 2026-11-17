import { describe, expect, it } from 'vitest';

import { CHAIN_RECORD_STATES } from '../chain-records.js';
import {
  evaluateShadowChainsRetired,
  SHADOW_CHAINS_MAX_ITEMS,
  SHADOW_CHAINS_POLICY,
  SHADOW_FLEET_ACTIVE_CHAIN_STATES,
} from '../shadow-day-chains-retired.js';

const INVALID = {
  status: 'unknown',
  reason: 'invalid-input',
  fleetActive: 0,
  shellActive: 0,
};
const KEPT = {
  status: 'unknown',
  reason: 'chains-kept-not-evaluable',
  fleetActive: 0,
  shellActive: 0,
};
const UNREADABLE = {
  status: 'unknown',
  reason: 'chain-state-unreadable',
  fleetActive: 0,
  shellActive: 0,
};

function retired(fleetChainStates: unknown, shellChainNames: unknown, chainsKept = false) {
  return { policy: { chainsKept }, fleetChainStates, shellChainNames };
}

function pass(fleetActive = 0, shellActive = 0) {
  return {
    status: 'pass',
    reason: 'chains-not-kept',
    fleetActive,
    shellActive,
  };
}

function fail(fleetActive: number, shellActive: number) {
  return {
    status: 'fail',
    reason: 'chain-active-while-retired',
    fleetActive,
    shellActive,
  };
}

describe('SHADOW_CHAINS_POLICY', () => {
  it('SHADOW_CHAINS_POLICY.chainsKept is false and the object is frozen', () => {
    expect(SHADOW_CHAINS_POLICY.chainsKept).toBe(false);
    expect(Object.isFrozen(SHADOW_CHAINS_POLICY)).toBe(true);
    expect(Object.keys(SHADOW_CHAINS_POLICY)).toEqual(['chainsKept']);
  });
});

describe('SHADOW_FLEET_ACTIVE_CHAIN_STATES', () => {
  it("SHADOW_FLEET_ACTIVE_CHAIN_STATES equals ['intent-recorded', 'started'] today", () => {
    expect([...SHADOW_FLEET_ACTIVE_CHAIN_STATES]).toEqual(['intent-recorded', 'started']);
    expect([...SHADOW_FLEET_ACTIVE_CHAIN_STATES]).toEqual(
      CHAIN_RECORD_STATES.filter((state) => state !== 'refused' && state !== 'landed'),
    );
  });
});

describe('evaluateShadowChainsRetired', () => {
  it('retired policy with [] and [] passes', () => {
    expect(
      evaluateShadowChainsRetired({
        policy: SHADOW_CHAINS_POLICY,
        fleetChainStates: [],
        shellChainNames: [],
      }),
    ).toEqual(pass());
  });

  it("['landed', 'refused'] and [] passes", () => {
    expect(evaluateShadowChainsRetired(retired(['landed', 'refused'], []))).toEqual(pass());
  });

  it('one started fleet chain fails with fleetActive 1', () => {
    expect(evaluateShadowChainsRetired(retired(['started'], []))).toEqual(fail(1, 0));
    expect(evaluateShadowChainsRetired(retired(['landed', 'started', 'refused'], []))).toEqual(
      fail(1, 0),
    );
  });

  it('two started fleet chains fail with fleetActive 2', () => {
    expect(evaluateShadowChainsRetired(retired(['started', 'started'], []))).toEqual(fail(2, 0));
  });

  it('one shell chain name fails with shellActive 1', () => {
    const name = 'zz-rv5-chain';
    const result = evaluateShadowChainsRetired(retired([], [name]));
    expect(result).toEqual(fail(0, 1));
    expect(JSON.stringify(result).includes(name)).toBe(false);
  });

  it('two shell chain names fail with shellActive 2', () => {
    const result = evaluateShadowChainsRetired(retired([], ['aa', 'bb']));
    expect(result).toEqual(fail(0, 2));
    expect(JSON.stringify(result).includes('aa')).toBe(false);
    expect(JSON.stringify(result).includes('bb')).toBe(false);
  });

  it('an intent-recorded chain fails', () => {
    const result = evaluateShadowChainsRetired(retired(['intent-recorded'], []));
    expect(result).toEqual(fail(1, 0));
    expect(JSON.stringify(result).includes('intent-recorded')).toBe(false);
  });

  it('chainsKept true is unknown/chains-kept-not-evaluable', () => {
    expect(evaluateShadowChainsRetired(retired([], [], true))).toEqual(KEPT);
    expect(evaluateShadowChainsRetired(retired(['started'], ['zz-rv5-chain'], true))).toEqual(KEPT);
    expect(evaluateShadowChainsRetired(retired(null, null, true))).toEqual(KEPT);
    const encoded = JSON.stringify(
      evaluateShadowChainsRetired(retired(['started'], ['zz-rv5-chain'], true)),
    );
    expect(encoded.includes('zz-rv5-chain')).toBe(false);
    expect(encoded.includes('started')).toBe(false);
  });

  it('either side null is unknown/chain-state-unreadable', () => {
    expect(evaluateShadowChainsRetired(retired(null, []))).toEqual(UNREADABLE);
    expect(evaluateShadowChainsRetired(retired([], null))).toEqual(UNREADABLE);
    expect(evaluateShadowChainsRetired(retired(null, null))).toEqual(UNREADABLE);
    expect(evaluateShadowChainsRetired(retired(null, ['zz-rv5-chain']))).toEqual(UNREADABLE);
    expect(evaluateShadowChainsRetired(retired(['started'], null))).toEqual(UNREADABLE);
    const encoded = JSON.stringify(evaluateShadowChainsRetired(retired(null, ['zz-rv5-chain'])));
    expect(encoded.includes('zz-rv5-chain')).toBe(false);
  });

  it("an unknown state string 'paused' is unknown/invalid-input", () => {
    const result = evaluateShadowChainsRetired(retired(['paused'], []));
    expect(result).toEqual(INVALID);
    expect(JSON.stringify(result).includes('paused')).toBe(false);
    expect(evaluateShadowChainsRetired(retired(['paused'], [], true))).toEqual(INVALID);
  });

  it('JSON.stringify(result) contains no chain name from the input', () => {
    const name = 'zz-rv5-chain';
    const result = evaluateShadowChainsRetired(retired(['intent-recorded'], [name]));
    expect(result).toEqual(fail(1, 1));
    const encoded = JSON.stringify(result);
    expect(encoded.includes(name)).toBe(false);
    expect(encoded.includes('intent-recorded')).toBe(false);
  });

  it('a shell name that is not a string of 1-128 characters is unknown/invalid-input', () => {
    expect(evaluateShadowChainsRetired(retired([], ['']))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], ['x'.repeat(129)]))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], [''], true))).toEqual(INVALID);
    const boundary = 'x'.repeat(128);
    const result = evaluateShadowChainsRetired(retired([], [boundary]));
    expect(result).toEqual(fail(0, 1));
    expect(JSON.stringify(result).includes(boundary)).toBe(false);
    expect(evaluateShadowChainsRetired(retired([], ['x']))).toEqual(fail(0, 1));
  });

  it('an over-cap list is unknown/invalid-input before any element is read', () => {
    const atCap = Array.from({ length: SHADOW_CHAINS_MAX_ITEMS }, () => 'landed');
    const names = Array.from({ length: SHADOW_CHAINS_MAX_ITEMS }, () => 'n');
    let calls = 0;
    const over: unknown[] = Array.from({ length: SHADOW_CHAINS_MAX_ITEMS + 1 }, () => 'landed');
    Object.defineProperty(over, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'started';
      },
    });
    expect(evaluateShadowChainsRetired(retired(atCap, []))).toEqual(pass());
    expect(evaluateShadowChainsRetired(retired(over, []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired(over, [], true))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], over))).toEqual(INVALID);
    expect(calls).toBe(0);
    expect(evaluateShadowChainsRetired(retired([], names))).toEqual(fail(0, SHADOW_CHAINS_MAX_ITEMS));
  });

  it('a record that is not the exact three keys is unknown/invalid-input', () => {
    expect(
      evaluateShadowChainsRetired({ policy: { chainsKept: false }, fleetChainStates: [] }),
    ).toEqual(INVALID);
    expect(
      evaluateShadowChainsRetired({
        policy: { chainsKept: false },
        fleetChainStates: [],
        shellChainNames: [],
        extra: true,
      }),
    ).toEqual(INVALID);
    expect(
      evaluateShadowChainsRetired({
        policy: { chainsKept: false, extra: true },
        fleetChainStates: [],
        shellChainNames: [],
      }),
    ).toEqual(INVALID);
    expect(
      evaluateShadowChainsRetired({
        policy: { chainsKept: 1 },
        fleetChainStates: [],
        shellChainNames: [],
      }),
    ).toEqual(INVALID);
  });
});

describe('evaluateShadowChainsRetired hostile input', () => {
  it('null is unknown/invalid-input', () => {
    expect(evaluateShadowChainsRetired(null)).toEqual(INVALID);
  });

  it('undefined is unknown/invalid-input', () => {
    expect(evaluateShadowChainsRetired(undefined)).toEqual(INVALID);
  });

  it('a wrong primitive (a number where a string is due, a string where a list is due) is unknown/invalid-input', () => {
    expect(evaluateShadowChainsRetired(retired([1], []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired('started', []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], 'zz-rv5-chain'))).toEqual(INVALID);
  });

  it('a non-iterable object where a list is due is unknown/invalid-input', () => {
    expect(evaluateShadowChainsRetired(retired({ state: 'started' }, []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], { name: 'zz-rv5-chain' }))).toEqual(INVALID);
  });

  it('an array hole (a sparse array) is unknown/invalid-input', () => {
    const fleet: unknown[] = ['started'];
    delete fleet[0];
    const shell: unknown[] = ['zz-rv5-chain'];
    delete shell[0];
    expect(evaluateShadowChainsRetired(retired(fleet, []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], shell))).toEqual(INVALID);
  });

  it('an array-like object { length: 1, 0: … } is unknown/invalid-input', () => {
    const arrayLike = { length: 1, 0: 'started' };
    expect(evaluateShadowChainsRetired(retired(arrayLike, []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], { length: 1, 0: 'zz-rv5-chain' }))).toEqual(
      INVALID,
    );
  });

  it('an enormous length (a sparse array of length 2**32 - 1) is refused before any traversal', () => {
    let calls = 0;
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'started';
      },
    });
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(evaluateShadowChainsRetired(retired(enormous, []))).toEqual(INVALID);
    expect(evaluateShadowChainsRetired(retired([], enormous))).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('a getter on an item never runs and is unknown/invalid-input', () => {
    let fleetCalls = 0;
    const states: unknown[] = [];
    Object.defineProperty(states, '0', {
      enumerable: true,
      configurable: true,
      get() {
        fleetCalls += 1;
        return 'landed';
      },
    });
    expect(evaluateShadowChainsRetired(retired(states, []))).toEqual(INVALID);
    expect(fleetCalls).toBe(0);

    let shellCalls = 0;
    const names: unknown[] = [];
    Object.defineProperty(names, '0', {
      enumerable: true,
      configurable: true,
      get() {
        shellCalls += 1;
        return 'zz-rv5-chain';
      },
    });
    expect(evaluateShadowChainsRetired(retired([], names))).toEqual(INVALID);
    expect(shellCalls).toBe(0);

    let policyCalls = 0;
    const policy: Record<string, unknown> = {};
    Object.defineProperty(policy, 'chainsKept', {
      enumerable: true,
      configurable: true,
      get() {
        policyCalls += 1;
        return false;
      },
    });
    expect(
      evaluateShadowChainsRetired({
        policy,
        fleetChainStates: [],
        shellChainNames: [],
      }),
    ).toEqual(INVALID);
    expect(policyCalls).toBe(0);
  });

  it('a getter on the root never runs and is unknown/invalid-input', () => {
    let calls = 0;
    const input: Record<string, unknown> = {
      policy: { chainsKept: false },
      fleetChainStates: [],
      shellChainNames: [],
    };
    Object.defineProperty(input, 'policy', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return { chainsKept: false };
      },
    });
    expect(evaluateShadowChainsRetired(input)).toEqual(INVALID);
    expect(calls).toBe(0);

    let listCalls = 0;
    const withListGetter: Record<string, unknown> = {
      policy: { chainsKept: false },
      shellChainNames: [],
    };
    Object.defineProperty(withListGetter, 'fleetChainStates', {
      enumerable: true,
      configurable: true,
      get() {
        listCalls += 1;
        return ['started'];
      },
    });
    expect(evaluateShadowChainsRetired(withListGetter)).toEqual(INVALID);
    expect(listCalls).toBe(0);
  });

  it('a Proxy over a valid input yields the plain result and runs no get trap', () => {
    const plain = retired([], []);
    const transparent = new Proxy(plain, {});
    expect(evaluateShadowChainsRetired(transparent)).toEqual(evaluateShadowChainsRetired(plain));

    let rootGets = 0;
    const proxied = new Proxy(plain, {
      get(target, property, receiver) {
        rootGets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const rootResult = evaluateShadowChainsRetired(proxied);
    expect(rootGets).toBe(0);
    expect(rootResult).toEqual(evaluateShadowChainsRetired(plain));

    let listGets = 0;
    const states = ['started'];
    const proxiedStates = new Proxy(states, {
      get(target, property, receiver) {
        listGets += 1;
        if (property === 'length') {
          return 0;
        }
        if (property === '0') {
          return 'landed';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const listResult = evaluateShadowChainsRetired(retired(proxiedStates, []));
    expect(listGets).toBe(0);
    expect(listResult).toEqual(evaluateShadowChainsRetired(retired(['started'], [])));
  });

  it('a prototype-polluting key (__proto__, constructor or prototype) from JSON.parse is unknown/invalid-input', () => {
    const keys = ['__proto__', 'constructor', 'prototype'] as const;
    for (const key of keys) {
      const parsed = JSON.parse(
        `{"${key}":{"polluted":true},"policy":{"chainsKept":false},"fleetChainStates":[],"shellChainNames":[]}`,
      ) as Record<string, unknown>;
      expect(Object.hasOwn(parsed, key)).toBe(true);
      expect(evaluateShadowChainsRetired(parsed)).toEqual(INVALID);
    }
    const nested = JSON.parse(
      '{"policy":{"__proto__":{"polluted":true},"chainsKept":false},"fleetChainStates":[],"shellChainNames":[]}',
    );
    expect(evaluateShadowChainsRetired(nested)).toEqual(INVALID);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('a function returning a constant verdict would fail', () => {
    const passing = evaluateShadowChainsRetired(retired([], []));
    const failing = evaluateShadowChainsRetired(retired(['started'], []));
    expect(passing).toEqual(pass());
    expect(failing).toEqual(fail(1, 0));
    expect(passing).not.toEqual(failing);
  });

  it('an identity echo of the input would fail', () => {
    const name = 'zz-rv5-chain';
    const input = retired(['started'], [name]);
    const result = evaluateShadowChainsRetired(input);
    expect(result).toEqual(fail(1, 1));
    expect(result).not.toBe(input);
    expect(result).not.toEqual(input);
    const encoded = JSON.stringify(result);
    expect(encoded.includes(name)).toBe(false);
    expect(encoded.includes('started')).toBe(false);
    expect(encoded.includes('fleetChainStates')).toBe(false);
  });
});
