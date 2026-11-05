// Domain (pure): the gate receipt key of the speed plan §3.2.2 (D29, KS2).
// A receipt is reused only when every component of the key is equal, and an
// unreadable component is a miss, never a hit.
//
// Direction of failure: a miss never blocks a gate run — it only means "do not
// reuse", so the caller runs the predicate as usual. A hit is possible only
// when every component was readable and equal. No filesystem, no subprocess, no
// Node builtins, no console; this module never throws.

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
  | { readonly outcome: 'miss'; readonly reason: 'no-stored-receipt' | 'stored-key-unreadable' | 'stored-key-version-unknown' }
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
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength || hasControlCharacter(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isTreeHash(value: unknown): value is string {
  return typeof value === 'string' && TREE_HASH_PATTERN.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/**
 * Validate the five raw components (already read defensively by the caller) in
 * the fixed table order of the contract and build the key record. Returns the
 * first unreadable component as a miss; never throws.
 */
function validateGateReceiptKeyComponents(parts: GateReceiptKeyInput): GateReceiptKeyBuild {
  const predicateId = readTrimmedString(parts.predicateId, 128);
  if (predicateId === undefined) {
    return { ok: false, reason: 'predicate-id-unreadable' };
  }

  if (!isTreeHash(parts.treeHash)) {
    return { ok: false, reason: 'tree-hash-unreadable' };
  }

  if (!isSha256Hex(parts.predicateDefinitionDigest)) {
    return { ok: false, reason: 'predicate-definition-digest-unreadable' };
  }

  const toolchainVersions = parts.toolchainVersions;
  if (!isPlainRecordObject(toolchainVersions)) {
    return { ok: false, reason: 'toolchain-version-unreadable' };
  }
  const readToolchain = (name: string): unknown => {
    const descriptor = Reflect.getOwnPropertyDescriptor(toolchainVersions, name);
    return descriptor === undefined ? undefined : descriptor.value;
  };
  const node = readTrimmedString(readToolchain('node'), 64);
  const yarn = readTrimmedString(readToolchain('yarn'), 64);
  const hexagen = readTrimmedString(readToolchain('hexagen'), 64);
  const turbo = readTrimmedString(readToolchain('turbo'), 64);
  if (node === undefined || yarn === undefined || hexagen === undefined || turbo === undefined) {
    return { ok: false, reason: 'toolchain-version-unreadable' };
  }

  if (!isSha256Hex(parts.declaredEnvironmentDigest)) {
    return { ok: false, reason: 'declared-environment-digest-unreadable' };
  }

  return {
    ok: true,
    key: {
      schemaVersion: GATE_RECEIPT_KEY_SCHEMA_VERSION,
      predicateId,
      treeHash: parts.treeHash,
      predicateDefinitionDigest: parts.predicateDefinitionDigest,
      toolchainVersions: { node, yarn, hexagen, turbo },
      declaredEnvironmentDigest: parts.declaredEnvironmentDigest,
    },
  };
}

export function buildGateReceiptKey(input: GateReceiptKeyInput): GateReceiptKeyBuild {
  // Tracks which field's read is in flight, so a throw from Reflect (e.g. a
  // hostile proxy) is reported as THAT field's unreadable reason — the required
  // first-unreadable-field result — never as another field's reason.
  let currentReason: GateReceiptKeyMissReason = 'predicate-id-unreadable';
  try {
    // Read the expected own keys through their descriptors so no getter runs; a
    // throwing descriptor (or a non-object input) is caught below as a miss.
    const read = (key: string, reason: GateReceiptKeyMissReason): unknown => {
      currentReason = reason;
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      return descriptor === undefined ? undefined : descriptor.value;
    };
    return validateGateReceiptKeyComponents({
      predicateId: read('predicateId', 'predicate-id-unreadable'),
      treeHash: read('treeHash', 'tree-hash-unreadable'),
      predicateDefinitionDigest: read('predicateDefinitionDigest', 'predicate-definition-digest-unreadable'),
      toolchainVersions: read('toolchainVersions', 'toolchain-version-unreadable'),
      declaredEnvironmentDigest: read('declaredEnvironmentDigest', 'declared-environment-digest-unreadable'),
    });
  } catch {
    // A hostile getter or proxy trap must never escape: report the component
    // whose read threw, with a fixed reason that echoes no value.
    return { ok: false, reason: currentReason };
  }
}

export function gateReceiptKeysEqual(left: GateReceiptKey, right: GateReceiptKey): boolean {
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
  // readRecordSchemaVersion guarantees a plain record object; narrow `input` so
  // the defensive reads below can use Reflect on it.
  if (!isPlainRecordObject(input)) {
    return { ok: false, reason: 'stored-key-unreadable' };
  }
  try {
    const read = (key: string): unknown => {
      const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
      return descriptor === undefined ? undefined : descriptor.value;
    };
    const built = validateGateReceiptKeyComponents({
      predicateId: read('predicateId'),
      treeHash: read('treeHash'),
      predicateDefinitionDigest: read('predicateDefinitionDigest'),
      toolchainVersions: read('toolchainVersions'),
      declaredEnvironmentDigest: read('declaredEnvironmentDigest'),
    });
    if (!built.ok) {
      return { ok: false, reason: 'stored-key-unreadable' };
    }
    // Unknown extra fields in the stored object are ignored: the gate's result
    // lives beside the key in the same record.
    return { ok: true, record: built.key };
  } catch {
    return { ok: false, reason: 'stored-key-unreadable' };
  }
}

export function decideGateReceiptReuse(key: GateReceiptKey, stored: unknown): GateReceiptReuse {
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
