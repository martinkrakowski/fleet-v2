// Lane AT1: the owner attestation use case behind `cutover shadow attest`.
// One call records one sticky one-time shadow fact into the installation's
// attestation ledger by compare-and-set on the caller's expected revision,
// under a cutover-journal intent keyed `cutover/attest@<operationId>` so a
// replay with the same operation id and payload returns the stored record
// without writing again. `note`, `evidence` and `authority` are hashed into
// the canonical request digest and never stored in any file. `observedDay`
// and `recordedAtIso` come from the daemon clock, never from the request, so
// a fact cannot be backdated. Every failure path is a typed refusal or
// unknown; nothing is written on any refused or unknown outcome before the
// journal intent is durable. No path or raw input value is ever echoed.

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  parseShadowAttestationCommandInput,
  recordShadowAttestation,
  type ShadowAttestation,
  type ShadowAttestationLedger,
} from '../../domain/shadow-attestations.js';
import type {
  AttestShadowFactPort,
  AttestShadowFactRefusalReason,
  AttestShadowFactResult,
  AttestShadowFactUnknownReason,
} from '../ports/in/AttestShadowFactPort.in-port.js';
import type { CutoverJournalEntry, CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import type { ShadowAttestationPort } from '../ports/out/ShadowAttestationPort.out-port.js';

export interface AttestShadowFactDependencies {
  readonly attestations: ShadowAttestationPort;
  readonly cutoverJournal: CutoverJournalPort;
  /** The installed `current` verified release sha, or `null` when unpinned. */
  readonly releaseSha: () => Promise<string | null>;
  readonly computeDigest: (text: string) => string;
  readonly mintEntryId: () => string;
  /** The daemon clock; the only clock this use case trusts. */
  readonly nowIso: () => string;
}

/** The canonical payload the intent digest and the attestation digest hash. `note`, `evidence` and `authority` live here only. */
function canonicalAttestationPayload(input: {
  readonly fact: string;
  readonly note: string;
  readonly evidence?: string;
  readonly authority: string;
  readonly expectedRevision: number;
}): string {
  return JSON.stringify({
    fact: input.fact,
    note: input.note,
    evidence: input.evidence ?? null,
    authority: input.authority,
    expectedRevision: input.expectedRevision,
  });
}

function refuse(reason: AttestShadowFactRefusalReason): AttestShadowFactResult {
  return { outcome: 'refused', reason };
}

function unknown(reason: AttestShadowFactUnknownReason): AttestShadowFactResult {
  return { outcome: 'unknown', reason };
}

/** The outcome of one guarded outbound call. */
type Guarded<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'threw' };

export class AttestShadowFactUseCase implements AttestShadowFactPort {
  constructor(private readonly deps: AttestShadowFactDependencies) {}

  async execute(request: unknown): Promise<AttestShadowFactResult> {
    try {
      const parsed = parseShadowAttestationCommandInput(request);
      if (!parsed.ok) {
        return refuse(parsed.reason);
      }
      const input = parsed.value;
      // `--authority` is only a non-empty label (it is not an owner-only
      // gate: switch, rollback and retire take none), but it is required:
      // a missing or blank label is refused before anything is read.
      if (input.authority.trim() === '') {
        return refuse('authority-required');
      }
      // Every field, including the deadline, is read from the parsed
      // snapshot the domain parser produced, never from the raw request
      // object: a Proxy `get` trap on the caller's input must never run
      // after parsing.
      const deadlineIso = input.deadlineIso;
      const digest = this.deps.computeDigest(canonicalAttestationPayload(input));
      const key = `cutover/attest@${input.operationId}`;

      // Idempotency by operation id: the journal's exact-key view decides
      // between replay, crash recovery and a fresh attestation.
      const listed = await this.guarded(deadlineIso, () => this.deps.cutoverJournal.listByKeyPrefix(key));
      if (listed.kind === 'deadline') return unknown('deadline-exceeded');
      if (listed.kind === 'threw' || listed.value.outcome !== 'listed' || !Array.isArray(listed.value.entries)) {
        return unknown('journal-unreadable');
      }
      const entries = listed.value.entries.filter((entry) => entry.key === key);
      const intent = entries.find((entry) => entry.kind === 'intent') ?? null;
      const final = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous') ?? null;
      if (intent !== null && intent.digest !== digest) {
        return refuse('operation-id-conflict');
      }
      if (final !== null) {
        return this.replayFinal(final, input.fact, deadlineIso);
      }

      const current = await this.readLedger(deadlineIso);
      if ('stop' in current) {
        return current.stop;
      }

      const daemonNow = this.daemonNow();
      if (daemonNow === null) {
        return unknown('clock-unreadable');
      }
      const { recordedAtIso, observedDay } = daemonNow;

      const attestation: ShadowAttestation = {
        fact: input.fact,
        observedDay,
        releaseSha: await this.readReleaseSha(),
        reason: 'owner-attested',
        digest,
        recordedAtIso,
      };
      const written = recordShadowAttestation(current.ledger, attestation);
      if (!written.ok) {
        return unknown('attestations-unreadable');
      }

      const existing = current.ledger?.attestations.find((item) => item.fact === input.fact) ?? null;
      if (!written.changed) {
        // Crash recovery: this operation's intent is durable but has no
        // final result, and the ledger already holds this exact fact under
        // this exact payload digest — the compare-and-set landed before the
        // crash and only the result append was lost. The intent is completed
        // as `attested` (`recovered`) without comparing revisions: the
        // stored revision is the crashed call's own increment, not the
        // caller's expectation, and the fact is already durably recorded.
        if (intent !== null && existing !== null && existing.digest === digest) {
          const resultFailure = await this.appendCompletedResult(
            key,
            digest,
            'recovered',
            recordedAtIso,
            deadlineIso,
          );
          if (resultFailure !== null) {
            return resultFailure;
          }
          return { outcome: 'attested', ledger: written.ledger, attestation: existing };
        }
        // Sticky facts: a fact already recorded is never rewritten. The
        // caller's revision must still match the stored ledger (0 when
        // nothing is stored), exactly as a compare-and-set would demand; the
        // intent is durable first so the refused result always pairs with one.
        const intentFailure = await this.appendIntentUnlessRecorded(intent, key, digest, recordedAtIso, deadlineIso);
        if (intentFailure !== null) {
          return intentFailure;
        }
        if ((current.ledger?.revision ?? 0) !== input.expectedRevision) {
          return this.refusedOutcome(key, digest, 'revision-conflict', recordedAtIso, deadlineIso);
        }
        const resultFailure = await this.appendCompletedResult(
          key,
          digest,
          'unchanged',
          recordedAtIso,
          deadlineIso,
        );
        if (resultFailure !== null) {
          return resultFailure;
        }
        return {
          outcome: 'unchanged',
          ledger: written.ledger,
          attestation: existing ?? attestation,
        };
      }

      const intentFailure = await this.appendIntentUnlessRecorded(intent, key, digest, recordedAtIso, deadlineIso);
      if (intentFailure !== null) {
        return intentFailure;
      }

      const saved = await this.guarded(deadlineIso, () =>
        this.deps.attestations.compareAndSet({
          expectedRevision: input.expectedRevision,
          next: written.ledger,
          deadlineIso,
        }),
      );
      if (saved.kind === 'deadline') return unknown('deadline-exceeded');
      if (saved.kind === 'threw') return unknown('attestations-write-refused');
      if (saved.value.outcome === 'conflict') {
        return this.refusedOutcome(key, digest, 'revision-conflict', recordedAtIso, deadlineIso);
      }
      if (saved.value.outcome === 'refused') {
        return this.casRefusal(key, digest, saved.value.reason, recordedAtIso, deadlineIso);
      }
      const resultFailure = await this.appendCompletedResult(key, digest, 'attested', recordedAtIso, deadlineIso);
      if (resultFailure !== null) {
        return resultFailure;
      }
      return { outcome: 'attested', ledger: saved.value.ledger, attestation };
    } catch {
      return refuse('invalid-input');
    }
  }

  /** True once `deadlineIso` is reached; an unusable clock counts as reached (fail closed). */
  private deadlineReached(deadlineIso: string | undefined): boolean {
    if (deadlineIso === undefined) {
      return false;
    }
    try {
      return !(Date.parse(this.deps.nowIso()) < Date.parse(deadlineIso));
    } catch {
      return true;
    }
  }

  /** Every outbound call goes through here: deadline first, then the call, never a throw. */
  private async guarded<T>(deadlineIso: string | undefined, call: () => Promise<T>): Promise<Guarded<T>> {
    if (this.deadlineReached(deadlineIso)) {
      return { kind: 'deadline' };
    }
    try {
      return { kind: 'value', value: await call() };
    } catch {
      return { kind: 'threw' };
    }
  }

  /** The current ledger, or the `unknown` result that stops the attestation. */
  private async readLedger(
    deadlineIso: string | undefined,
  ): Promise<{ readonly ledger: ShadowAttestationLedger | null } | { readonly stop: AttestShadowFactResult }> {
    const read = await this.guarded(deadlineIso, () => this.deps.attestations.read({ deadlineIso }));
    if (read.kind === 'deadline') return { stop: unknown('deadline-exceeded') };
    if (read.kind === 'threw') return { stop: unknown('attestations-unreadable') };
    if (read.value.status === 'ok') return { ledger: read.value.ledger };
    if (read.value.status === 'missing') return { ledger: null };
    return {
      stop: unknown(
        read.value.status === 'unknown-version' ? 'attestations-unknown-version' : 'attestations-unreadable',
      ),
    };
  }

  /**
   * The daemon clock's UTC day and a UTC-normalized timestamp, or null when
   * the clock is unusable. The day is taken from the normalized UTC instant,
   * never from a `slice` of the raw offset timestamp.
   */
  private daemonNow(): { readonly observedDay: string; readonly recordedAtIso: string } | null {
    const raw = this.deps.nowIso();
    if (typeof raw !== 'string' || !isZonedIsoDateTime(raw) || !Number.isFinite(Date.parse(raw))) {
      return null;
    }
    const normalized = new Date(Date.parse(raw)).toISOString();
    return { recordedAtIso: normalized, observedDay: normalized.slice(0, 10) };
  }

  /** An unpinned release records `null`; a failing sha reader is not an attestation failure. */
  private async readReleaseSha(): Promise<string | null> {
    try {
      return await this.deps.releaseSha();
    } catch {
      return null;
    }
  }

  /** Appends the intent when this exact operation id has none yet; a recorded intent is a retry. */
  private async appendIntentUnlessRecorded(
    intent: CutoverJournalEntry | null,
    key: string,
    digest: string,
    recordedAtIso: string,
    deadlineIso: string | undefined,
  ): Promise<AttestShadowFactResult | null> {
    if (intent !== null) {
      return null;
    }
    const appended = await this.guarded(deadlineIso, () =>
      this.deps.cutoverJournal.append({
        key,
        kind: 'intent',
        entryId: this.deps.mintEntryId(),
        recordedAtIso,
        digest,
      }),
    );
    if (appended.kind === 'deadline') return unknown('deadline-exceeded');
    if (appended.kind === 'threw' || appended.value.outcome !== 'appended') {
      if (appended.kind === 'value' && appended.value.outcome === 'refused' && appended.value.reason === 'intent-after-result') {
        return refuse('journal-refused');
      }
      return unknown('journal-append-failed');
    }
    return null;
  }

  /** The final `completed` result append; a second final result is not a failure. */
  private async appendCompletedResult(
    key: string,
    digest: string,
    reasonCode: 'attested' | 'unchanged' | 'recovered',
    recordedAtIso: string,
    deadlineIso: string | undefined,
  ): Promise<AttestShadowFactResult | null> {
    const appended = await this.guarded(deadlineIso, () =>
      this.deps.cutoverJournal.append({
        key,
        kind: 'result',
        entryId: this.deps.mintEntryId(),
        recordedAtIso,
        outcome: 'completed',
        reasonCode,
        digest,
      }),
    );
    if (appended.kind === 'deadline') return unknown('deadline-exceeded');
    if (appended.kind === 'threw' || appended.value.outcome !== 'appended') {
      if (appended.kind === 'value' && appended.value.outcome === 'refused' && appended.value.reason === 'intent-after-result') {
        return refuse('journal-refused');
      }
      return unknown('journal-append-failed');
    }
    return null;
  }

  /** Appends the final `refused` result (when the journal still accepts it) and returns the refusal. */
  private async refusedOutcome(
    key: string,
    digest: string,
    reasonCode: string,
    recordedAtIso: string,
    deadlineIso: string | undefined,
  ): Promise<AttestShadowFactResult> {
    const appended = await this.guarded(deadlineIso, () =>
      this.deps.cutoverJournal.append({
        key,
        kind: 'result',
        entryId: this.deps.mintEntryId(),
        recordedAtIso,
        outcome: 'refused',
        reasonCode,
        digest,
      }),
    );
    if (appended.kind !== 'deadline' && appended.kind !== 'threw' && appended.value.outcome !== 'appended') {
      if (appended.kind === 'value' && appended.value.outcome === 'refused' && appended.value.reason === 'intent-after-result') {
        return refuse('journal-refused');
      }
      return unknown('journal-append-failed');
    }
    return refuse(reasonCode as AttestShadowFactRefusalReason);
  }

  /** A CAS refusal mapped to a typed result; a refused result is recorded when the journal still takes one. */
  private async casRefusal(
    key: string,
    digest: string,
    reason: 'invalid-request' | 'invalid-ledger' | 'unknown-version' | 'unreadable' | 'read-only' | 'deadline-exceeded',
    recordedAtIso: string,
    deadlineIso: string | undefined,
  ): Promise<AttestShadowFactResult> {
    switch (reason) {
      case 'read-only':
        return this.refusedOutcome(key, digest, 'read-only', recordedAtIso, deadlineIso);
      case 'deadline-exceeded':
        return unknown('deadline-exceeded');
      case 'unknown-version':
        return unknown('attestations-unknown-version');
      case 'unreadable':
        return unknown('attestations-unreadable');
      case 'invalid-ledger':
      case 'invalid-request':
        return unknown('attestations-write-refused');
    }
  }

  /**
   * A prior final result under this exact key: a `refused` result stays
   * refused (`journal-refused` — a retry needs a new operation id); a
   * `completed` result returns the stored record without writing, with the
   * stored outcome (`attested`, `unchanged` or a `recovered` crash
   * completion) carried through exactly as the journal recorded it. A
   * completed result whose fact is missing from the stored ledger is an
   * interrupted attestation this use case does not guess its way out of.
   */
  private async replayFinal(
    final: CutoverJournalEntry,
    fact: string,
    deadlineIso: string | undefined,
  ): Promise<AttestShadowFactResult> {
    if (final.outcome === 'refused') {
      return refuse('journal-refused');
    }
    const current = await this.readLedger(deadlineIso);
    if ('stop' in current) {
      return current.stop;
    }
    const ledger = current.ledger;
    if (ledger === null) {
      return refuse('journal-incomplete');
    }
    const attestation = ledger.attestations.find((item) => item.fact === fact) ?? null;
    if (attestation === null) {
      return refuse('journal-incomplete');
    }
    return { outcome: final.reasonCode === 'unchanged' ? 'unchanged' : 'attested', ledger, attestation };
  }
}
