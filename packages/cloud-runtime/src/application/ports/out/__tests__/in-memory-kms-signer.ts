/**
 * Shared in-memory fake of KmsSignerPort for contract tests. It is the only
 * implementation of the port: a real adapter does not exist yet. It mirrors
 * the semantics the later adapter must honour — own-snapshot input
 * validation with no getter ever invoked and no Proxy trap ever fired
 * (`types.isProxy` from `node:util` is the detector), fail-closed health
 * handling, an exact registered-key check, and a `MAX_SIGN_PAYLOAD_BYTES`
 * payload ceiling — with a typed refusal for every failure path.
 *
 * The fake's signing seed lives only in an ES `#private` field, so
 * `JSON.stringify(fake)` and `JSON.stringify(result)` never contain key
 * bytes. No network, no filesystem, no ambient clock, no randomness:
 * signatures are deterministic from the injected seed.
 *
 * This file holds no `describe`/`it`: vitest only collects `*.test.ts`.
 */

import { types } from 'node:util';

import type {
  KmsHealth,
  KmsSignerPort,
  KmsKeyHandle,
  OpaqueSignature,
  SignResult,
} from '../KmsSignerPort.out-port.js';
import { validateSignInputs } from '../KmsSignerPort.out-port.js';

/** Fake configuration: registered keys, signer health and seed are injected, never inferred. */
export interface InMemoryKmsSignerOptions {
  /** The keys this fake knows; defaults to one `key-1` / `Ed25519` key. */
  readonly keys?: ReadonlyArray<{ readonly keyId: string; readonly algorithm: string }>;
  /** The signer's own health; anything other than `'healthy'` fails closed. */
  readonly health?: KmsHealth;
  /** Deterministic seed mixed into every signature; never surfaced. */
  readonly seed?: string;
}

/** FNV-1a over a string, hex-encoded. Deterministic; O(n) over the input only. */
function digest(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class InMemoryKmsSigner implements KmsSignerPort {
  readonly #seed: string;
  readonly #health: KmsHealth;
  readonly #keys: ReadonlyMap<string, string>;

  constructor(options: InMemoryKmsSignerOptions = {}) {
    this.#seed = options.seed ?? 'in-memory-kms-signer-seed';
    this.#health = options.health ?? 'healthy';
    const configured = options.keys ?? [{ keyId: 'key-1', algorithm: 'Ed25519' }];
    this.#keys = new Map(configured.map((key) => [key.keyId, key.algorithm]));
  }

  async sign(keyHandle: KmsKeyHandle, payload: { readonly content: string }): Promise<SignResult> {
    const validated = validateSignInputs(keyHandle, payload, types.isProxy);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason };
    }
    const { keyId, algorithm, health } = validated.keyHandle;
    // Fail closed on any handle health other than 'healthy' ('down',
    // 'degraded' or any unrecognised string); missing or non-string health
    // was already refused as invalid-request by validateSignInputs.
    if (health !== 'healthy') {
      return { ok: false, reason: 'unavailable' };
    }
    if (this.#health !== 'healthy') {
      return { ok: false, reason: 'unavailable' };
    }
    // Unknown or inactive handle: the keyId must be registered and the
    // algorithm must match the registration exactly.
    const registeredAlgorithm = this.#keys.get(keyId);
    if (registeredAlgorithm === undefined || registeredAlgorithm !== algorithm) {
      return { ok: false, reason: 'unknown-key' };
    }
    // Deterministic: seed + key identity + payload, never random. The
    // signature is opaque and carries no key bytes.
    const signature = `sig-${digest([this.#seed, keyId, algorithm, validated.payload.content])}` as OpaqueSignature;
    return { ok: true, signature, keyId, algorithm };
  }
}
