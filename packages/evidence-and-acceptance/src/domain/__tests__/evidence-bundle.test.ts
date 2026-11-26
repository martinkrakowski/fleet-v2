import { describe, expect, it } from 'vitest';

import {
  BUNDLE_ENTRY_PATHS,
  EvidenceBundleFinding,
  EvidenceBundleGateOutput,
  EvidenceBundleInput,
  EvidenceBundleReceipt,
  EvidenceBundleSeat,
  MAX_AUTHORITY_EVENTS_JSONL_LENGTH,
  assembleEvidenceBundle,
} from '../evidence-bundle.js';

/** A fixed valid head sha (40 lowercase hex chars). */
const HEAD_SHA = 'a'.repeat(40);
const OTHER_HEAD_SHA = 'b'.repeat(40);
const AT_ISO = '2026-11-26T10:00:00Z';

/** Build a fully valid bundle input. */
function validInput(overrides: Partial<EvidenceBundleInput> = {}): EvidenceBundleInput {
  return {
    headSha: HEAD_SHA,
    organizationId: 'org-1',
    receipts: [
      { receiptId: 'r-1', kind: 'gate', atIso: AT_ISO, verdict: 'PASS' },
    ],
    findings: [
      { findingId: 'f-1', severity: 'major', disposition: 'fix-later' },
    ],
    gateOutput: [
      { command: 'yarn test', exitCode: 0, outputExcerpt: 'all green' },
    ],
    seats: [
      { role: 'implementer', seatId: 's-1' },
    ],
    policyRevision: 'policy-2026-11',
    authorityEventsJsonl: authorityLine('org-1'),
    ...overrides,
  };
}

/** One complete, valid `AuthorityEvent` JSONL line. */
function authorityLine(
  organizationId: string | null,
  overrides: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    eventId: 'ev-1',
    kind: 'dispatch',
    actor: 'operator@example.com',
    organizationId,
    atIso: AT_ISO,
    beforeRevision: null,
    afterRevision: null,
    ...overrides,
  })}`;
}

/** Deep-freeze an object graph, so any mutation of `input` throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** A valid receipt object. */
function receipt(): EvidenceBundleReceipt {
  return { receiptId: 'r-1', kind: 'gate', atIso: AT_ISO, verdict: 'PASS' };
}

describe('assembleEvidenceBundle', () => {
  it('assembles the seven entries in fixed order with canonical JSON ending in a newline', () => {
    const result = assembleEvidenceBundle(deepFreeze(validInput()));
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(result.entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'receipts.json',
      'findings.json',
      'gate-output.json',
      'seats.json',
      'policy.json',
      'authority-events.json',
    ]);
    expect(result.entries.map((entry) => entry.path)).toEqual([...BUNDLE_ENTRY_PATHS]);
    for (const entry of result.entries) {
      expect(entry.text.endsWith('\n')).toBe(true);
      expect(JSON.parse(entry.text)).toBeInstanceOf(Object);
    }
    expect(JSON.parse(result.entries[1]!.text)).toEqual({
      headSha: HEAD_SHA,
      receipts: [{ receiptId: 'r-1', kind: 'gate', atIso: AT_ISO, verdict: 'PASS' }],
    });
  });

  it('lists each payload entry path and UTF-8 byte length in the manifest, with no hashes', () => {
    const result = assembleEvidenceBundle(deepFreeze(validInput()));
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(result.manifestText).toBe(result.entries[0]!.text);
    const manifest = JSON.parse(result.manifestText) as {
      headSha: string;
      entries: { path: string; byteLength: number }[];
    };
    expect(manifest.headSha).toBe(HEAD_SHA);
    expect(manifest.entries).toEqual(
      result.entries.slice(1).map((entry) => ({
        path: entry.path,
        byteLength: Buffer.byteLength(entry.text, 'utf8'),
      })),
    );
    // No hashes anywhere: neither a sha256 field nor a 64-hex digest string.
    expect(result.manifestText.includes('sha256')).toBe(false);
    expect(result.manifestText.includes('digest')).toBe(false);
  });

  it('matches a line organizationId equal to the input organizationId and accepts null with no or null line ids', () => {
    const matching = assembleEvidenceBundle(deepFreeze(validInput()));
    expect(matching.ok).toBe(true);

    const withoutLineOrg = assembleEvidenceBundle(
      deepFreeze(validInput({
        organizationId: null,
        authorityEventsJsonl: `${authorityLine(null)}\n`,
      })),
    );
    expect(withoutLineOrg.ok).toBe(true);

    const withNullLineOrg = assembleEvidenceBundle(
      deepFreeze(validInput({
        organizationId: null,
        authorityEventsJsonl: `${authorityLine(null)}\n`,
      })),
    );
    expect(withNullLineOrg.ok).toBe(true);
  });

  it('refuses a JSONL line that is not a complete AuthorityEvent despite a matching organizationId', () => {
    // The reviewer-reported case: an object carrying only `organizationId`
    // used to pass and be archived as audit evidence.
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: '{"organizationId":"org-1"}\n' })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: '{"organizationId":"org-1","event":"dispatch"}\n' })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a JSONL line with an unknown kind, a bad actor, or an unparseable atIso', () => {
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: `${authorityLine('org-1', { kind: 'unknown-kind' })}\n` })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: `${authorityLine('org-1', { actor: 'bad actor!' })}\n` })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: `${authorityLine('org-1', { atIso: 'not-a-date' })}\n` })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: `${authorityLine('org-1', { beforeRevision: 5 })}\n` })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('produces byte-identical entries and manifest for reversed key order at root and in nested items', () => {
    const forward = validInput();
    const reversed: EvidenceBundleInput = {
      authorityEventsJsonl: forward.authorityEventsJsonl,
      policyRevision: forward.policyRevision,
      seats: [{ seatId: 's-1', role: 'implementer' }],
      gateOutput: [{ outputExcerpt: 'all green', exitCode: 0, command: 'yarn test' }],
      findings: [{ disposition: 'fix-later', severity: 'major', findingId: 'f-1' }],
      receipts: [{ verdict: 'PASS', atIso: AT_ISO, kind: 'gate', receiptId: 'r-1' }],
      organizationId: 'org-1',
      headSha: HEAD_SHA,
    };
    const a = assembleEvidenceBundle(deepFreeze(forward));
    const b = assembleEvidenceBundle(deepFreeze(reversed));
    if (!a.ok || !b.ok) {
      throw new Error('expected both ok');
    }
    expect(b.entries).toEqual(a.entries);
    expect(b.manifestText).toBe(a.manifestText);
  });

  it('emits empty lists as empty arrays', () => {
    const result = assembleEvidenceBundle(
      deepFreeze(validInput({
        receipts: [],
        findings: [],
        gateOutput: [],
        seats: [],
        authorityEventsJsonl: '',
      })),
    );
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(JSON.parse(result.entries[1]!.text)).toEqual({ headSha: HEAD_SHA, receipts: [] });
    expect(JSON.parse(result.entries[2]!.text)).toEqual({ headSha: HEAD_SHA, findings: [] });
    expect(JSON.parse(result.entries[3]!.text)).toEqual({ headSha: HEAD_SHA, gateOutput: [] });
    expect(JSON.parse(result.entries[4]!.text)).toEqual({ headSha: HEAD_SHA, seats: [] });
  });

  it('keeps the fixed entry paths even when IDs contain ../ or /etc/passwd', () => {
    const result = assembleEvidenceBundle(
      deepFreeze(validInput({
        receipts: [{ receiptId: '../../etc/passwd', kind: 'gate', atIso: AT_ISO, verdict: 'PASS' }],
        findings: [{ findingId: '/etc/passwd', severity: 'major', disposition: 'fix-later' }],
      })),
    );
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(result.entries.map((entry) => entry.path)).toEqual([...BUNDLE_ENTRY_PATHS]);
    // The hostile-looking IDs live inside the payload text, not the paths.
    expect(result.entries[1]!.text.includes('../../etc/passwd')).toBe(true);
    expect(result.entries[2]!.text.includes('/etc/passwd')).toBe(true);
  });

  it('returns different outputs for different headSha or receipts', () => {
    const a = assembleEvidenceBundle(deepFreeze(validInput()));
    const b = assembleEvidenceBundle(deepFreeze(validInput({ headSha: OTHER_HEAD_SHA })));
    const c = assembleEvidenceBundle(
      deepFreeze(validInput({ receipts: [receipt(), { receiptId: 'r-2', kind: 'gate', atIso: AT_ISO, verdict: 'FAIL' } as unknown as EvidenceBundleReceipt] })),
    );    if (!a.ok || !b.ok || !c.ok) {
      throw new Error('expected all ok');
    }
    expect(b.entries).not.toEqual(a.entries);
    expect(b.manifestText).not.toBe(a.manifestText);
    expect(c.entries).not.toEqual(a.entries);
  });

  it('never mutates a deep-frozen input', () => {
    const before = JSON.stringify(validInput());
    const result = assembleEvidenceBundle(deepFreeze(validInput()));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(validInput())).toBe(before);
  });

  it('refuses null, undefined, primitives, arrays, and class instances as root input', () => {
    class Wrapper {
      readonly headSha = HEAD_SHA;
    }
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      true,
      [],
      [validInput()],
      new Wrapper(),
    ]) {
      const result = assembleEvidenceBundle(bad);
      expect(result).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('refuses null or primitive items inside lists', () => {
    expect(assembleEvidenceBundle(deepFreeze(validInput({ receipts: [null] as unknown as EvidenceBundleReceipt[] }))))
      .toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(deepFreeze(validInput({ findings: ['x'] as unknown as EvidenceBundleFinding[] }))))
      .toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(deepFreeze(validInput({ seats: [42] as unknown as EvidenceBundleSeat[] }))))
      .toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses malformed non-empty JSONL lines', () => {
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: `${authorityLine('org-1')}\nnot json\n` })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: '[1,2]\n' })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses JSONL lines with duplicate keys before parsing them', () => {
    const line = '{"organizationId":"other","organizationId":"org-1"}';
    const result = assembleEvidenceBundle(deepFreeze(validInput({ authorityEventsJsonl: `${line}\n` })));
    // The duplicate-key refusal wins over the cross-organization check: the
    // last-write-wins value must never smuggle the line past the guard.
    expect(result).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses missing required top-level keys instead of defaulting them', () => {
    const missingOrg = validInput();
    delete (missingOrg as unknown as Record<string, unknown>).organizationId;
    expect(assembleEvidenceBundle(deepFreeze(missingOrg)))
      .toEqual({ ok: false, reason: 'invalid-input' });
    const missingPolicy = validInput();
    delete (missingPolicy as unknown as Record<string, unknown>).policyRevision;
    expect(assembleEvidenceBundle(deepFreeze(missingPolicy)))
      .toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses extra top-level and nested item keys', () => {
    expect(assembleEvidenceBundle(
      deepFreeze({ ...validInput(), extra: 1 } as unknown),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ receipts: [{ ...receipt(), extra: 1 }] as unknown as EvidenceBundleReceipt[] })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({
        gateOutput: [{ command: 'x', exitCode: 0, outputExcerpt: 'y', extra: 1 }] as unknown as EvidenceBundleGateOutput[],
      })),
    )).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a hidden non-enumerable extra key and a non-enumerable list element', () => {
    const hidden = validInput() as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, 'sneaky', { value: 1, enumerable: false });
    expect(assembleEvidenceBundle(hidden)).toEqual({ ok: false, reason: 'hostile-input' });

    const hiddenNested = validInput({
      receipts: [{ ...receipt(), hidden: 1 } as unknown as EvidenceBundleReceipt],
    }) as unknown as { receipts: Record<string, unknown>[] };
    Object.defineProperty(hiddenNested.receipts[0]!, 'sneaky', { value: 1, enumerable: false });
    expect(assembleEvidenceBundle(hiddenNested as unknown)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });

    const hiddenElement = validInput() as unknown as { receipts: unknown[] };
    Object.defineProperty(hiddenElement.receipts, 0, { value: receipt(), enumerable: false });
    expect(assembleEvidenceBundle(hiddenElement as unknown)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });

    const symbolKey = validInput() as unknown as Record<string, unknown>;
    Object.defineProperty(symbolKey, Symbol('extra'), { value: 1, enumerable: true });
    expect(assembleEvidenceBundle(symbolKey)).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a JSONL line carrying an own prototype-polluting key', () => {
    const result = assembleEvidenceBundle(deepFreeze(validInput({
      authorityEventsJsonl: `{"organizationId":"org-1","__proto__":{"x":1},"eventId":"ev-1","kind":"dispatch","actor":"operator@example.com","atIso":"${AT_ISO}","beforeRevision":null,"afterRevision":null}\n`,
    })));
    expect(result).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses prototype-polluting keys without polluting Object.prototype', () => {
    const before = JSON.stringify({ ...Object.prototype });
    const extra = validInput() as unknown as Record<string, unknown>;
    Object.defineProperty(extra, '__proto__', { value: { polluted: true }, enumerable: true });
    expect(assembleEvidenceBundle(extra)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(JSON.stringify({ ...Object.prototype })).toBe(before);
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();

    expect(assembleEvidenceBundle(
      deepFreeze({ ...validInput(), constructor: 1 } as unknown),
    )).toEqual({ ok: false, reason: 'invalid-input' });
    expect(assembleEvidenceBundle(
      deepFreeze({ ...validInput(), prototype: 1 } as unknown),
    )).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses getter properties without invoking them', () => {
    let getterRuns = 0;
    const input = { ...validInput() } as Record<string, unknown>;
    Object.defineProperty(input, 'policyRevision', {
      get() {
        getterRuns += 1;
        return 'policy-2026-11';
      },
      enumerable: true,
    });
    const result = assembleEvidenceBundle(input);
    expect(result).toEqual({ ok: false, reason: 'hostile-input' });
    expect(getterRuns).toBe(0);
  });

  it('refuses a hostile Proxy without throwing', () => {
    const target = validInput();
    const lying = new Proxy(target, {
      get() {
        throw new Error('no reads');
      },
      getOwnPropertyDescriptor() {
        throw new Error('no descriptors');
      },
      ownKeys() {
        throw new Error('no keys');
      },
      getPrototypeOf() {
        throw new Error('no prototype');
      },
    });
    expect(assembleEvidenceBundle(lying)).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses array-like objects and sparse arrays with holes', () => {
    const arrayLike = { length: 1, 0: receipt() };
    expect(assembleEvidenceBundle(deepFreeze({ ...validInput(), receipts: arrayLike })))
      .toEqual({ ok: false, reason: 'invalid-input' });

    const sparse: unknown[] = new Array(2);
    sparse[0] = receipt();
    expect(assembleEvidenceBundle(deepFreeze({ ...validInput(), receipts: sparse })))
      .toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses any list with more than 5000 items', () => {
    const tooLong: unknown[] = new Array(5001).fill(receipt());
    expect(assembleEvidenceBundle(deepFreeze({ ...validInput(), receipts: tooLong })))
      .toEqual({ ok: false, reason: 'list-too-large' });
    const exactlyMax: unknown[] = new Array(5000).fill(receipt());
    const atLimit = assembleEvidenceBundle(deepFreeze({ ...validInput(), receipts: exactlyMax }));
    expect(atLimit.ok).toBe(true);
  });

  it('refuses uppercase, non-hex, or wrong-length headSha', () => {
    expect(assembleEvidenceBundle(deepFreeze(validInput({ headSha: HEAD_SHA.toUpperCase() }))))
      .toEqual({ ok: false, reason: 'invalid-head-sha' });
    expect(assembleEvidenceBundle(deepFreeze(validInput({ headSha: 'z'.repeat(40) }))))
      .toEqual({ ok: false, reason: 'invalid-head-sha' });
    expect(assembleEvidenceBundle(deepFreeze(validInput({ headSha: 'a'.repeat(39) }))))
      .toEqual({ ok: false, reason: 'invalid-head-sha' });
    expect(assembleEvidenceBundle(deepFreeze(validInput({ headSha: 42 as unknown as string }))))
      .toEqual({ ok: false, reason: 'invalid-head-sha' });
  });

  it('refuses non-ISO and unparseable receipt timestamps', () => {
    for (const atIso of ['not-a-date', '2026-13-01T00:00:00Z', '2026-11-26T10:00:00', AT_ISO.toLowerCase()]) {
      expect(assembleEvidenceBundle(
        deepFreeze(validInput({ receipts: [{ receiptId: 'r-1', kind: 'gate', atIso, verdict: 'PASS' }] })),
      )).toEqual({ ok: false, reason: 'invalid-timestamp' });
    }
    const tooLong = 'x'.repeat(65);
    expect(tooLong.length).toBeGreaterThan(64);
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ receipts: [{ receiptId: 'r-1', kind: 'gate', atIso: tooLong, verdict: 'PASS' }] })),
    )).toEqual({ ok: false, reason: 'invalid-timestamp' });
  });

  it('refuses empty or over-128-char policyRevision', () => {
    expect(assembleEvidenceBundle(deepFreeze(validInput({ policyRevision: '' }))))
      .toEqual({ ok: false, reason: 'invalid-policy-revision' });
    expect(assembleEvidenceBundle(deepFreeze(validInput({ policyRevision: 'p'.repeat(129) }))))
      .toEqual({ ok: false, reason: 'invalid-policy-revision' });
  });

  it('refuses gateOutput.outputExcerpt over 4096 characters without truncating', () => {
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ gateOutput: [{ command: 'x', exitCode: 0, outputExcerpt: 'o'.repeat(4097) }] })),
    )).toEqual({ ok: false, reason: 'excerpt-too-long' });
    const atLimit = assembleEvidenceBundle(
      deepFreeze(validInput({ gateOutput: [{ command: 'x', exitCode: 0, outputExcerpt: 'o'.repeat(4096) }] })),
    );
    expect(atLimit.ok).toBe(true);
  });

  it('refuses over-long command, identifier, and authorityEventsJsonl strings', () => {
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ gateOutput: [{ command: 'c'.repeat(1025), exitCode: 0, outputExcerpt: 'o' }] })),
    )).toEqual({ ok: false, reason: 'string-too-long' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ receipts: [{ receiptId: 'r'.repeat(129), kind: 'gate', atIso: AT_ISO, verdict: 'PASS' }] })),
    )).toEqual({ ok: false, reason: 'string-too-long' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ seats: [{ role: 'r', seatId: 's'.repeat(129) }] })),
    )).toEqual({ ok: false, reason: 'string-too-long' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ organizationId: 'o'.repeat(129) })),
    )).toEqual({ ok: false, reason: 'string-too-long' });
    const oversizedJsonl = `{"organizationId":"${'o'.repeat(MAX_AUTHORITY_EVENTS_JSONL_LENGTH)}"}`;
    expect(oversizedJsonl.length).toBeGreaterThan(MAX_AUTHORITY_EVENTS_JSONL_LENGTH);
    expect(assembleEvidenceBundle(deepFreeze(validInput({ authorityEventsJsonl: oversizedJsonl }))))
      .toEqual({ ok: false, reason: 'string-too-long' });
  });

  it('refuses any authorityEventsJsonl line with a different organizationId', () => {
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ authorityEventsJsonl: `${authorityLine('org-2')}\n` })),
    )).toEqual({ ok: false, reason: 'cross-organization-event' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({
        authorityEventsJsonl: `${authorityLine('org-1')}\n${authorityLine('org-2')}\n`,
      })),
    )).toEqual({ ok: false, reason: 'cross-organization-event' });
    expect(assembleEvidenceBundle(
      deepFreeze(validInput({ organizationId: null, authorityEventsJsonl: `${authorityLine('org-2')}\n` })),
    )).toEqual({ ok: false, reason: 'cross-organization-event' });
  });

  it('refuses secret-shaped content naming only the entry path and never the matched value', () => {
    const token = 'sk-' + 'b'.repeat(24);
    const result = assembleEvidenceBundle(
      deepFreeze(validInput({ findings: [{ findingId: 'f-1', severity: token, disposition: 'fix' }] })),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'secret-shaped-content',
      path: 'findings.json',
    });
    expect(JSON.stringify(result).includes(token)).toBe(false);
  });

  it('refuses a secret token preceded by a newline in raw input', () => {
    const token = '\nghp_' + 'a'.repeat(24);
    const result = assembleEvidenceBundle(
      deepFreeze(validInput({
        gateOutput: [{ command: 'yarn test', exitCode: 1, outputExcerpt: token }],
      })),
    );
    expect(result).toEqual({
      ok: false,
      reason: 'secret-shaped-content',
      path: 'gate-output.json',
    });
    expect(JSON.stringify(result).includes(token.trim())).toBe(false);
  });
});
