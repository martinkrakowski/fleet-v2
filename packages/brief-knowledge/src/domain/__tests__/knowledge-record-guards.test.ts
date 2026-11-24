import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_KNOWLEDGE_CLAIM_KIND,
  KNOWLEDGE_CLAIM_KINDS,
  KNOWLEDGE_TRIAGE_FLAGS,
  MAX_FAILED_CLAIM_TEXT_CHARS,
  MAX_OVERRIDE_REASON_CHARS,
  isKnowledgeClaimKind,
  isKnowledgeTriageFlag,
} from '../knowledge-records.js';

const throwingGetterObject = (): unknown => {
  const holder: Record<PropertyKey, unknown> = {};
  Object.defineProperty(holder, '0', {
    get() {
      throw new Error('getter invoked');
    },
    enumerable: true,
  });
  return holder;
};

describe('isKnowledgeTriageFlag', () => {
  it('accepts every declared triage flag value', () => {
    for (const flag of KNOWLEDGE_TRIAGE_FLAGS) {
      expect(isKnowledgeTriageFlag(flag)).toBe(true);
    }
  });

  it('refuses near-miss strings, null, undefined, and non-string primitives', () => {
    expect(isKnowledgeTriageFlag('Policy-Like')).toBe(false);
    expect(isKnowledgeTriageFlag('policy-like ')).toBe(false);
    expect(isKnowledgeTriageFlag('')).toBe(false);
    expect(isKnowledgeTriageFlag('none')).toBe(false);
    expect(isKnowledgeTriageFlag(null)).toBe(false);
    expect(isKnowledgeTriageFlag(undefined)).toBe(false);
    expect(isKnowledgeTriageFlag(1)).toBe(false);
  });

  it('refuses members of the claim-kind set', () => {
    for (const kind of KNOWLEDGE_CLAIM_KINDS) {
      expect(isKnowledgeTriageFlag(kind)).toBe(false);
    }
  });

  it('refuses arrays, sparse arrays, array-likes, and plain objects', () => {
    expect(isKnowledgeTriageFlag(['policy-like'])).toBe(false);
    const sparseWithFlag = [] as string[];
    sparseWithFlag[1] = 'policy-like';
    expect(isKnowledgeTriageFlag(sparseWithFlag)).toBe(false);
    expect(isKnowledgeTriageFlag({ 0: 'policy-like', length: 1 })).toBe(false);
    expect(isKnowledgeTriageFlag({ 0: 'policy-like', length: 1_000_000_000 })).toBe(false);
    expect(isKnowledgeTriageFlag({})).toBe(false);
  });

  it('refuses inherited and prototype-polluting property names', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'prototype', 'length']) {
      expect(isKnowledgeTriageFlag(key)).toBe(false);
    }
  });

  it('refuses objects with toString or throwing getters without invoking them', () => {
    const toStringSpy = vi.fn(() => 'policy-like');
    expect(isKnowledgeTriageFlag({ toString: toStringSpy })).toBe(false);
    expect(toStringSpy).toHaveBeenCalledTimes(0);

    const getter = vi.fn(() => 'policy-like');
    const holder: Record<PropertyKey, unknown> = {};
    Object.defineProperty(holder, '0', { get: getter, enumerable: true });
    expect(isKnowledgeTriageFlag(holder)).toBe(false);
    expect(getter).toHaveBeenCalledTimes(0);

    expect(() => isKnowledgeTriageFlag(throwingGetterObject())).not.toThrow();
  });

  it('refuses Proxy objects without throwing', () => {
    expect(() => isKnowledgeTriageFlag(new Proxy({ toString: () => 'policy-like' }, {}))).not.toThrow();
    expect(isKnowledgeTriageFlag(new Proxy({ toString: () => 'policy-like' }, {}))).toBe(false);
    expect(() => isKnowledgeTriageFlag(new Proxy(new String('policy-like'), {}))).not.toThrow();
    expect(isKnowledgeTriageFlag(new Proxy(new String('policy-like'), {}))).toBe(false);
  });
});

describe('isKnowledgeClaimKind', () => {
  it('accepts every declared claim kind', () => {
    for (const kind of KNOWLEDGE_CLAIM_KINDS) {
      expect(isKnowledgeClaimKind(kind)).toBe(true);
    }
  });

  it('refuses near-miss strings, null, undefined, and non-string primitives', () => {
    expect(isKnowledgeClaimKind('Fact')).toBe(false);
    expect(isKnowledgeClaimKind('failed ')).toBe(false);
    expect(isKnowledgeClaimKind('')).toBe(false);
    expect(isKnowledgeClaimKind(null)).toBe(false);
    expect(isKnowledgeClaimKind(undefined)).toBe(false);
    expect(isKnowledgeClaimKind(0)).toBe(false);
  });

  it('refuses members of the triage-flag set', () => {
    for (const flag of KNOWLEDGE_TRIAGE_FLAGS) {
      expect(isKnowledgeClaimKind(flag)).toBe(false);
    }
  });

  it('refuses arrays, sparse arrays, array-likes, and plain objects', () => {
    expect(isKnowledgeClaimKind(['fact'])).toBe(false);
    const sparseWithKind = [] as string[];
    sparseWithKind[1] = 'fact';
    expect(isKnowledgeClaimKind(sparseWithKind)).toBe(false);
    expect(isKnowledgeClaimKind({ 0: 'fact', length: 1 })).toBe(false);
    expect(isKnowledgeClaimKind({ 0: 'fact', length: 1_000_000_000 })).toBe(false);
    expect(isKnowledgeClaimKind({})).toBe(false);
  });

  it('refuses inherited and prototype-polluting property names', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'prototype', 'length']) {
      expect(isKnowledgeClaimKind(key)).toBe(false);
    }
  });

  it('refuses objects with toString or throwing getters without invoking them', () => {
    const toStringSpy = vi.fn(() => 'fact');
    expect(isKnowledgeClaimKind({ toString: toStringSpy })).toBe(false);
    expect(toStringSpy).toHaveBeenCalledTimes(0);

    const getter = vi.fn(() => 'fact');
    const holder: Record<PropertyKey, unknown> = {};
    Object.defineProperty(holder, '0', { get: getter, enumerable: true });
    expect(isKnowledgeClaimKind(holder)).toBe(false);
    expect(getter).toHaveBeenCalledTimes(0);

    expect(() => isKnowledgeClaimKind(throwingGetterObject())).not.toThrow();
  });

  it('refuses Proxy objects without throwing', () => {
    expect(() => isKnowledgeClaimKind(new Proxy({ toString: () => 'fact' }, {}))).not.toThrow();
    expect(isKnowledgeClaimKind(new Proxy({ toString: () => 'fact' }, {}))).toBe(false);
    expect(() => isKnowledgeClaimKind(new Proxy(new String('fact'), {}))).not.toThrow();
    expect(isKnowledgeClaimKind(new Proxy(new String('fact'), {}))).toBe(false);
  });
});

describe('guard and constant agreement', () => {
  it('accepts every triage flag with the triage guard and refuses it with the claim-kind guard', () => {
    for (const flag of KNOWLEDGE_TRIAGE_FLAGS) {
      expect(isKnowledgeTriageFlag(flag)).toBe(true);
      expect(isKnowledgeClaimKind(flag)).toBe(false);
    }
  });

  it('accepts every claim kind with the claim-kind guard and refuses it with the triage guard', () => {
    for (const kind of KNOWLEDGE_CLAIM_KINDS) {
      expect(isKnowledgeClaimKind(kind)).toBe(true);
      expect(isKnowledgeTriageFlag(kind)).toBe(false);
    }
  });
});

describe('exported constants', () => {
  it('declares the exact triage flag set', () => {
    expect([...KNOWLEDGE_TRIAGE_FLAGS]).toEqual(['policy-like', 'instruction-like']);
  });

  it('declares the exact claim kind set', () => {
    expect([...KNOWLEDGE_CLAIM_KINDS]).toEqual(['fact', 'observed', 'failed']);
  });

  it('defaults the claim kind to a value the claim-kind guard accepts', () => {
    expect(DEFAULT_KNOWLEDGE_CLAIM_KIND).toBe('fact');
    expect(isKnowledgeClaimKind(DEFAULT_KNOWLEDGE_CLAIM_KIND)).toBe(true);
  });

  it('declares the character bounds as exact numbers', () => {
    expect(MAX_FAILED_CLAIM_TEXT_CHARS).toBe(300);
    expect(MAX_OVERRIDE_REASON_CHARS).toBe(1024);
  });
});
