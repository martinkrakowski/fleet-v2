/**
 * Shared in-memory fake of InstallationTokenBrokerPort for contract tests. It
 * is the only implementation of the port: a real adapter does not exist yet.
 * It mirrors the semantics the later adapter must honour — own-snapshot
 * request validation with no getter ever invoked and no Proxy trap ever
 * fired (`types.isProxy` from `node:util` is the detector), scope
 * enforcement against the credential, a 3600-second TTL ceiling, credential
 * expiry at the caller-supplied `nowIso`, and token-use verification — with
 * a typed refusal for every failure path.
 *
 * The fake's signing seed lives only in an ES `#private` field, so
 * `JSON.stringify(fake)` and `JSON.stringify(result)` never contain key
 * bytes. No network, no filesystem, no ambient clock, no randomness: tokens
 * are deterministic from the injected seed.
 *
 * This file holds no `describe`/`it`: vitest only collects `*.test.ts`.
 */

import { types } from 'node:util';

import type {
  BrokerResult,
  ForgeCredentialPermission,
  InstallationToken,
  InstallationTokenBrokerPort,
  IssueInstallationTokenRequest,
} from '../InstallationTokenBrokerPort.out-port.js';
import { isInstallationTokenExpired, validateBrokerRequest } from '../InstallationTokenBrokerPort.out-port.js';

/** Fake configuration: the signing seed is injected, never inferred. */
export interface InMemoryInstallationTokenBrokerOptions {
  /** Deterministic seed mixed into every issued token; never surfaced. */
  readonly seed?: string;
}

/** One issued token's stored scope and expiry; no secret lives here. */
interface IssuedToken {
  readonly repository: string;
  readonly permission: ForgeCredentialPermission;
  readonly expiresAtIso: string;
}

export type VerifyTokenUseResult =
  | { readonly ok: true; readonly repository: string; readonly permission: ForgeCredentialPermission }
  | { readonly ok: false; readonly reason: 'invalid-request' | 'token-expired' };

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

export class InMemoryInstallationTokenBroker implements InstallationTokenBrokerPort {
  readonly #seed: string;
  readonly #issued = new Map<string, IssuedToken>();
  #nextTokenNumber = 1;

  constructor(options: InMemoryInstallationTokenBrokerOptions = {}) {
    this.#seed = options.seed ?? 'in-memory-installation-token-broker-seed';
  }

  async issue(request: IssueInstallationTokenRequest): Promise<BrokerResult> {
    const validated = validateBrokerRequest(request, types.isProxy);
    if (!validated.ok) {
      return { ok: false, reason: validated.reason };
    }
    const { organization, repository, permission, ttlSeconds, nowIso, credential } = validated.request;

    // Scope enforcement: the request must name exactly the credential's
    // organization (the repository's owner segment), repository and single
    // permission. O(1): fixed-length comparisons over length-capped strings.
    const owner = repository.slice(0, repository.indexOf('/'));
    if (organization !== owner || repository !== credential.repository) {
      return { ok: false, reason: 'scope-denied' };
    }
    if (permission !== credential.permission) {
      return { ok: false, reason: 'scope-denied' };
    }

    // The credential must still be valid at the caller-supplied nowIso; the
    // check is fail-closed.
    if (isInstallationTokenExpired(credential.expiresAtIso, nowIso)) {
      return { ok: false, reason: 'credential-expired' };
    }

    const expiresAtMs = Date.parse(nowIso) + ttlSeconds * 1000;
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    const tokenNumber = this.#nextTokenNumber;
    this.#nextTokenNumber += 1;
    // Deterministic: seed + scope + expiry + sequence, never random.
    const token = `itk-${digest([
      this.#seed,
      repository,
      permission,
      expiresAtIso,
      String(tokenNumber),
    ])}` as InstallationToken;
    this.#issued.set(token, { repository, permission, expiresAtIso });
    return { ok: true, token, expiresAtIso, repository, permission };
  }

  /**
   * Fake-specific token-use verification: an unknown or malformed token is
   * `invalid-request`; an issued token whose `expiresAtIso` has passed
   * `nowIso` is `token-expired` (and `isInstallationTokenExpired` returns
   * `true` for the same pair). Fail-closed on every malformed input.
   */
  verifyTokenUse(token: unknown, nowIso: unknown): VerifyTokenUseResult {
    if (typeof token !== 'string' || !token.startsWith('itk-')) {
      return { ok: false, reason: 'invalid-request' };
    }
    const issued = this.#issued.get(token);
    if (issued === undefined) {
      return { ok: false, reason: 'invalid-request' };
    }
    if (isInstallationTokenExpired(issued.expiresAtIso, nowIso)) {
      return { ok: false, reason: 'token-expired' };
    }
    return { ok: true, repository: issued.repository, permission: issued.permission };
  }
}
