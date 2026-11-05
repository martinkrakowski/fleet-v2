// Domain (pure): the gate receipt key of the speed plan §3.2.2 (D29, KS2).
// A receipt is reused only when every component of the key is equal, and an
// unreadable component is a miss, never a hit.
//
// Direction of failure: a miss never blocks a gate run — it only means "do not
// reuse", so the caller runs the predicate as usual. A hit is possible only
// when every component was readable and equal. No filesystem, no subprocess, no
// Node builtins, no console; this module never throws.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import {
  isPlainRecordObject,
  readRecordSchemaVersion,
} from './record-schema-version.js';

export const GATE_RECEIPT_KEY_SCHEMA_VERSION = 1 as const;

export const GATE_RECEIPT_TOOLCHAIN_NAMES = ['node', 'yarn', 'hexagen', 'turbo'] as const;
export type GateReceiptToolchainName = (typeof GATE_RECEIPT_TOOLCHAIN_NAMES)[number];

export interface GateReceiptToolchainVersions {
  readonly node: string;
  readonly yarn: string;
  readonly hexagen: string;
  readonly turbo: string;
}

export interface GateReceiptKey {
  readonly schemaVersion: typeof GATE_RECEIPT_KEY_SCHEMA_VERSION;
  readonly predicateId: string;
  readonly treeHash: string;
  readonly predicateDefinitionDigest: string;
  readonly toolchainVersions: GateReceiptToolchainVersions;
  readonly declaredEnvironmentDigest: string;
}

export type GateReceiptKeyComponent =
  | 'predicate-id'
  | 'tree-hash'
  | 'predicate-definition-digest'
  | 'toolchain-version'
  | 'declared-environment-digest';

export type GateReceiptKeyMissReason =
  | 'predicate-id-unreadable'
  | 'tree-hash-unreadable'
  | 'predicate-definition-digest-unreadable'
  | 'toolchain-version-unreadable'
  | 'declared-environment-digest-unreadable';

export type GateReceiptKeyBuild =
  | { readonly ok: true; readonly key: GateReceiptKey }
  | { readonly ok: false; readonly reason: GateReceiptKeyMissReason };

export interface GateReceiptKeyInput {
  readonly predicateId: unknown;
  readonly treeHash: unknown;
  readonly predicateDefinitionDigest: unknown;
  readonly toolchainVersions: unknown;
  readonly declaredEnvironmentDigest: unknown;
}

export type GateReceiptStoredRead =
  | { readonly ok: true; readonly record: GateReceiptKey }
  | { readonly ok: false; readonly reason: 'stored-key-unreadable' | 'stored-key-version-unknown' };

export type GateReceiptReuse =
  | { readonly outcome: 'reuse'; readonly key: GateReceiptKey }
  | { readonly outcome: 'miss'; readonly reason: 'no-stored-receipt' | 'stored-key-unreadable' | 'stored-key-version-unknown' | 'supplied-key-unreadable' }
  | { readonly outcome: 'miss'; readonly reason: 'key-changed'; readonly changedComponent: GateReceiptKeyComponent };

const TREE_HASH_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** True when `value` contains a control character (C0 0x00–0x1f or DEL 0x7f). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** The trimmed string when `value` is a string of trimmed length 1..maxLength with no control characters; otherwise undefined. */
function readTrimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Control characters are refused before trimming, so a leading or trailing tab or newline is refused too.
  // A secret-shaped value never enters a key, which is stored data.
  if (hasControlCharacter(value) || isSecretShaped(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return undefined;
  }
  return trimmed;
}

/** True when a string matches containsSecretShape or any of the lane-diff secret patterns (the full registry). */
function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** A version string such as 22.11.0 or 4.12.0-rc.1: letters, digits and . + _ - only, at most 64 characters. */
const TOOLCHAIN_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function readToolchainVersion(value: unknown): string | undefined {
  const read = readTrimmedString(value, 64);
  return read !== undefined && TOOLCHAIN_VERSION_PATTERN.test(read) ? read : undefined;
}

/** The key, re-read and validated as stored data would be; null for anything unreadable, versioned otherwise or hostile. */
function readSuppliedKey(key: unknown): GateReceiptKey | null {
  try {
    const read = readGateReceiptKeyRecord(key);
    return read.ok ? read.record : null;
  } catch {
    return null;
  }
}

function isTreeHash(value: unknown): value is string {
  return typeof value === 'string' && TREE_HASH_PATTERN.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/** The raw value of an own property, read through its descriptor so no getter runs. */
function readOwnProperty(target: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

/**
 * Read the five key components in the fixed table order of the contract, each
 * through its own descriptor so no getter runs, and validate each before moving
 * to the next. The first unreadable component is returned as a miss; a throw
 * from any defensive read (e.g. a hostile proxy trap) is reported as the
 * component whose read was in flight, never as another component's reason.
 * Unknown extra fields are ignored. Never throws.
 */
function readGateReceiptKeyComponents(parts: GateReceiptKeyInput): GateReceiptKeyBuild {
  // Tracks which component's read is in flight, so a throw from Reflect (e.g.
  // a hostile proxy) is reported as THAT component's unreadable reason — the
  // required first-unreadable-field result — never as another component's after
  // it has already been checked.
  let currentReason: GateReceiptKeyMissReason = 'predicate-id-unreadable';
  try {
    // Read each expected own key through its descriptor so no getter runs; a
    // throwing descriptor (or a non-object input) is caught below as a miss.
    const read = (key: string, reason: GateReceiptKeyMissReason): unknown => {
      currentReason = reason;
      const descriptor = Reflect.getOwnPropertyDescriptor(parts, key);
      return descriptor === undefined ? undefined : descriptor.value;
    };

    const predicateId = readTrimmedString(read('predicateId', 'predicate-id-unreadable'), 128);
    if (predicateId === undefined) {
      return { ok: false, reason: 'predicate-id-unreadable' };
    }

    const treeHash = read('treeHash', 'tree-hash-unreadable');
    if (!isTreeHash(treeHash)) {
      return { ok: false, reason: 'tree-hash-unreadable' };
    }

    const predicateDefinitionDigest = read('predicateDefinitionDigest', 'predicate-definition-digest-unreadable');
    if (!isSha256Hex(predicateDefinitionDigest)) {
      return { ok: false, reason: 'predicate-definition-digest-unreadable' };
    }

    currentReason = 'toolchain-version-unreadable';
    const toolchainVersions = read('toolchainVersions', 'toolchain-version-unreadable');
    if (!isPlainRecordObject(toolchainVersions)) {
      return { ok: false, reason: 'toolchain-version-unreadable' };
    }
    const node = readToolchainVersion(readOwnProperty(toolchainVersions, 'node'));
    const yarn = readToolchainVersion(readOwnProperty(toolchainVersions, 'yarn'));
    const hexagen = readToolchainVersion(readOwnProperty(toolchainVersions, 'hexagen'));
    const turbo = readToolchainVersion(readOwnProperty(toolchainVersions, 'turbo'));
    if (node === undefined || yarn === undefined || hexagen === undefined || turbo === undefined) {
      return { ok: false, reason: 'toolchain-version-unreadable' };
    }

    const declaredEnvironmentDigest = read('declaredEnvironmentDigest', 'declared-environment-digest-unreadable');
    if (!isSha256Hex(declaredEnvironmentDigest)) {
      return { ok: false, reason: 'declared-environment-digest-unreadable' };
    }

    return {
      ok: true,
      key: {
        schemaVersion: GATE_RECEIPT_KEY_SCHEMA_VERSION,
        predicateId,
        treeHash,
        predicateDefinitionDigest,
        toolchainVersions: { node, yarn, hexagen, turbo },
        declaredEnvironmentDigest,
      },
    };
  } catch {
    // A hostile getter or proxy trap must never escape: report the component
    // whose read threw, with a fixed reason that echoes no value.
    return { ok: false, reason: currentReason };
  }
}

export function buildGateReceiptKey(input: GateReceiptKeyInput): GateReceiptKeyBuild {
  return readGateReceiptKeyComponents(input);
}

/** Whether two keys are equal on every component; anything that is not a readable key compares unequal, never throws. */
export function gateReceiptKeysEqual(left: GateReceiptKey, right: GateReceiptKey): boolean {
  try {
    return keyComponentsEqual(left, right);
  } catch {
    // A hostile accessor or a malformed value is a miss, never an exception.
    return false;
  }
}

function keyComponentsEqual(suppliedLeft: GateReceiptKey, suppliedRight: GateReceiptKey): boolean {
  // Only two readable keys can be equal: an unreadable component on either side is a miss.
  const left = readSuppliedKey(suppliedLeft);
  const right = readSuppliedKey(suppliedRight);
  if (left === null || right === null) {
    return false;
  }
  return (
    left.schemaVersion === right.schemaVersion &&
    left.predicateId === right.predicateId &&
    left.treeHash === right.treeHash &&
    left.predicateDefinitionDigest === right.predicateDefinitionDigest &&
    left.toolchainVersions.node === right.toolchainVersions.node &&
    left.toolchainVersions.yarn === right.toolchainVersions.yarn &&
    left.toolchainVersions.hexagen === right.toolchainVersions.hexagen &&
    left.toolchainVersions.turbo === right.toolchainVersions.turbo &&
    left.declaredEnvironmentDigest === right.declaredEnvironmentDigest
  );
}

export function readGateReceiptKeyRecord(input: unknown): GateReceiptStoredRead {
  const versionRead = readRecordSchemaVersion(input, GATE_RECEIPT_KEY_SCHEMA_VERSION);
  if (!versionRead.ok) {
    // An absent schemaVersion reads as 1 and is accepted; any other present
    // value outside the accepted window is refused as an unknown schema version.
    return versionRead.reason === 'unknown-schema-version'
      ? { ok: false, reason: 'stored-key-version-unknown' }
      : { ok: false, reason: 'stored-key-unreadable' };
  }
  // readRecordSchemaVersion guarantees a plain record object, so the record's
  // own fields can be read defensively below.
  const built = readGateReceiptKeyComponents(input as GateReceiptKeyInput);
  if (!built.ok) {
    // Any unreadable stored field is a single miss reason: the stored key is unusable.
    return { ok: false, reason: 'stored-key-unreadable' };
  }
  // Unknown extra fields in the stored object are ignored: the gate's result
  // lives beside the key in the same record.
  return { ok: true, record: built.key };
}

export function decideGateReceiptReuse(suppliedKey: GateReceiptKey, stored: unknown): GateReceiptReuse {
  // The supplied key is re-validated too: a hostile, malformed or other-version key is a miss, never a reuse.
  const key = readSuppliedKey(suppliedKey);
  if (key === null) {
    return { outcome: 'miss', reason: 'supplied-key-unreadable' };
  }
  if (stored === null || stored === undefined) {
    return { outcome: 'miss', reason: 'no-stored-receipt' };
  }
  const read = readGateReceiptKeyRecord(stored);
  if (!read.ok) {
    return { outcome: 'miss', reason: read.reason };
  }
  const record = read.record;
  if (record.predicateId !== key.predicateId) {
    return { outcome: 'miss', reason: 'key-changed', changedComponent: 'predicate-id' };
  }
  if (record.treeHash !== key.treeHash) {
    return { outcome: 'miss', reason: 'key-changed', changedComponent: 'tree-hash' };
  }
  if (record.predicateDefinitionDigest !== key.predicateDefinitionDigest) {
    return { outcome: 'miss', reason: 'key-changed', changedComponent: 'predicate-definition-digest' };
  }
  if (
    record.toolchainVersions.node !== key.toolchainVersions.node ||
    record.toolchainVersions.yarn !== key.toolchainVersions.yarn ||
    record.toolchainVersions.hexagen !== key.toolchainVersions.hexagen ||
    record.toolchainVersions.turbo !== key.toolchainVersions.turbo
  ) {
    return { outcome: 'miss', reason: 'key-changed', changedComponent: 'toolchain-version' };
  }
  if (record.declaredEnvironmentDigest !== key.declaredEnvironmentDigest) {
    return { outcome: 'miss', reason: 'key-changed', changedComponent: 'declared-environment-digest' };
  }
  return { outcome: 'reuse', key };
}
