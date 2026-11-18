// Lane AT1: the owner attestation use case behind `cutover shadow attest`.
// One call records one sticky one-time shadow fact into the installation's
// attestation ledger by compare-and-set on the caller's expected revision,
// under a cutover-journal intent keyed `cutover/attest@<operationId>` so a
// replay with the same operation id and payload returns the stored record
// without writing again. `note`, `evidence` and `authority` are hashed into
// the canonical request digest and never stored in any file. `observedDay`
// and `recordedAtIso` come from the daemon clock, never from the request, so
// a fact cannot be backdated. The ledger record also carries a digest of the
// attesting operation id, so crash recovery is bound to the operation that
// actually wrote the record. Every failure path is a typed refusal or
// unknown; nothing is written on any refused or unknown outcome before the
// journal intent is durable. No path or raw input value is ever echoed.

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  parseShadowAttestationCommandInput,
  recordShadowAttestation,
  type ShadowAttestation,
  type ShadowAttestationCommandInput,
  type ShadowAttestationLedger,
  type ShadowAttestationWrite,
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

/**
 * The ledger-side binding of an operation id: a digest over the id alone, so
 * a stored record can be attributed to the operation that wrote it even
 * though the request digest itself deliberately excludes the id.
 */
function operationDigestOf(computeDigest: (text: string) => string, operationId: string): string {
  return computeDigest(JSON.stringify({ operationId }));
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

/** The request as parsed, plus the derived values fixed before any outbound call. */
interface ParsedAttestation {
  readonly input: ShadowAttestationCommandInput;
  /** The canonical request digest (excludes the operation id by design). */
  readonly digest: string;
  /** The digest of the operation id alone: the ledger record's operation binding. */
  readonly operationDigest: string;
  readonly key: string;
}

/** The exact-key journal view taken before any write. */
interface ReplayLookup {
  readonly intent: CutoverJournalEntry | null;
  readonly final: CutoverJournalEntry | null;
}

/** Everything the write and settle helpers need, fixed after replay is ruled out. */
interface AttestationContext {
  readonly parsed: ParsedAttestation;
  readonly intent: CutoverJournalEntry | null;
  readonly ledger: ShadowAttestationLedger | null;
  readonly recordedAtIso: string;
  readonly existing: ShadowAttestation | null;
  /** The record this operation would write (the stored one when the fact is sticky). */
  readonly attestation: ShadowAttestation;
  readonly written: Extract<ShadowAttestationWrite, { readonly ok: true }>;
}

type Step<T> = { readonly value: T } | { readonly result: AttestShadowFactResult };

export class AttestShadowFactUseCase implements AttestShadowFactPort {
  constructor(private readonly deps: AttestShadowFactDependencies) {}

  async execute(request: unknown): Promise<AttestShadowFactResult> {
    try {
      const parsed = this.parseRequest(request);
      if ('result' in parsed) {
        return parsed.result;
      }
      const replay = await this.lookupReplay(parsed.value);
      if ('result' in replay) {
        return replay.result;
      }
      const context = await this.loadContext(parsed.value, replay.value.intent);
      if ('result' in context) {
        return context.result;
      }
      if (!context.value.written.changed) {
        return this.settleAlreadyRecorded(context.value);
      }
      return this.writeNewAttestation(context.value);
    } catch {
      return refuse('invalid-input');
    }
  }

  /** Parses and validates the request; nothing outbound has run yet. */
  private parseRequest(request: unknown): Step<ParsedAttestation> {
    const parsed = parseShadowAttestationCommandInput(request);
    if (!parsed.ok) {
      return { result: refuse(parsed.reason) };
    }
    // `--authority` is only a non-empty label (it is not an owner-only
    // gate: switch, rollback and retire take none), but it is required:
    // a missing or blank label is refused before anything is read.
    if (parsed.value.authority.trim() === '') {
      return { result: refuse('authority-required') };
    }
    return { value: this.withDerivedValues(parsed.value) };
  }

  /** Freezes the digest, operation binding and journal key from the parsed snapshot. */
  private withDerivedValues(input: ShadowAttestationCommandInput): ParsedAttestation {
    // Every field, including the deadline, is read from the parsed snapshot
    // the domain parser produced, never from the raw request object: a
    // Proxy `get` trap on the caller's input must never run after parsing.
    const digest = this.deps.computeDigest(canonicalAttestationPayload(input));
    return {
      input,
      digest,
      operationDigest: operationDigestOf(this.deps.computeDigest, input.operationId),
      key: `cutover/attest@${input.operationId}`,
    };
  }

  /**
   * Idempotency by operation id: the journal's exact-key view decides
   * between replay, crash recovery and a fresh attestation. A mismatching
   * intent digest under this operation's own key is a conflict; a final
   * result replays without writing.
   */
  private async lookupReplay(parsed: ParsedAttestation): Promise<Step<ReplayLookup>> {
    const listed = await this.guarded(parsed.input.deadlineIso, () =>
      this.deps.cutoverJournal.listByKeyPrefix(parsed.key),
    );
    if (listed.kind === 'deadline') return { result: unknown('deadline-exceeded') };
    if (listed.kind === 'threw' || listed.value.outcome !== 'listed' || !Array.isArray(listed.value.entries)) {
      return { result: unknown('journal-unreadable') };
    }
    const entries = listed.value.entries.filter((entry) => entry.key === parsed.key);
    const intent = entries.find((entry) => entry.kind === 'intent') ?? null;
    if (intent !== null && intent.digest !== parsed.digest) {
      return { result: refuse('operation-id-conflict') };
    }
    const final = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous') ?? null;
    if (final !== null) {
      return { result: await this.replayFinal(final, parsed.input.fact, parsed.input.deadlineIso) };
    }
    return { value: { intent, final: null } };
  }

  /** Reads the ledger and clock, and computes what this operation would write. */
  private async loadContext(parsed: ParsedAttestation, intent: CutoverJournalEntry | null): Promise<Step<AttestationContext>> {
    const current = await this.readLedger(parsed.input.deadlineIso);
    if ('stop' in current) {
      return { result: current.stop };
    }
    const clock = this.daemonNow();
    if (clock === null) {
      return { result: unknown('clock-unreadable') };
    }
    const attestation = await this.attestationFor(parsed, clock);
    const written = recordShadowAttestation(current.ledger, attestation);
    if (!written.ok) {
      return { result: unknown('attestations-unreadable') };
    }
    const existing = current.ledger?.attestations.find((item) => item.fact === parsed.input.fact) ?? null;
    return {
      value: {
        parsed,
        intent,
        ledger: current.ledger,
        recordedAtIso: clock.recordedAtIso,
        existing,
        attestation,
        written,
      },
    };
  }

  /**
   * The fact is already in the ledger. Crash recovery first: this
   * operation's own intent is durable but has no final result, AND the
   * stored record belongs to this very operation (its `operationDigest`
   * names it) under this exact payload digest — the compare-and-set landed
   * before the crash and only the result append was lost. The intent is
   * completed as `attested` (`recovered`) without comparing revisions. Any
   * other match — a record another operation wrote, or no intent of this
   * operation's own — is the normal attest path: the sticky `unchanged`, or
   * `revision-conflict` per the compare-and-set rules. Never `recovered`.
   */
  private async settleAlreadyRecorded(context: AttestationContext): Promise<AttestShadowFactResult> {
    const { parsed, intent, recordedAtIso, existing } = context;
    const deadlineIso = parsed.input.deadlineIso;
    if (
      intent !== null &&
      existing !== null &&
      existing.digest === parsed.digest &&
      existing.operationDigest === parsed.operationDigest
    ) {
      const resultFailure = await this.appendCompletedResult(parsed.key, parsed.digest, 'recovered', recordedAtIso, deadlineIso);
      if (resultFailure !== null) {
        return resultFailure;
      }
      return { outcome: 'attested', ledger: context.written.ledger, attestation: existing };
    }
    // Sticky facts: a fact already recorded is never rewritten. The caller's
    // revision must still match the stored ledger (0 when nothing is
    // stored), exactly as a compare-and-set would demand; the intent is
    // durable first so the refused result always pairs with one.
    const intentFailure = await this.appendIntentUnlessRecorded(intent, parsed.key, parsed.digest, recordedAtIso, deadlineIso);
    if (intentFailure !== null) {
      return intentFailure;
    }
    if ((context.ledger?.revision ?? 0) !== parsed.input.expectedRevision) {
      return this.refusedOutcome(parsed.key, parsed.digest, 'revision-conflict', recordedAtIso, deadlineIso);
    }
    const resultFailure = await this.appendCompletedResult(parsed.key, parsed.digest, 'unchanged', recordedAtIso, deadlineIso);
    if (resultFailure !== null) {
      return resultFailure;
    }
    return { outcome: 'unchanged', ledger: context.written.ledger, attestation: existing ?? context.attestation };
  }

  /** The compare-and-set write path for a fact not yet recorded. */
  private async writeNewAttestation(context: AttestationContext): Promise<AttestShadowFactResult> {
    const { parsed, recordedAtIso } = context;
    const deadlineIso = parsed.input.deadlineIso;
    const intentFailure = await this.appendIntentUnlessRecorded(context.intent, parsed.key, parsed.digest, recordedAtIso, deadlineIso);
    if (intentFailure !== null) {
      return intentFailure;
    }
    const saved = await this.guarded(deadlineIso, () =>
      this.deps.attestations.compareAndSet({
        expectedRevision: parsed.input.expectedRevision,
        next: context.written.ledger,
        deadlineIso,
      }),
    );
    if (saved.kind === 'deadline') return unknown('deadline-exceeded');
    if (saved.kind === 'threw') return unknown('attestations-write-refused');
    if (saved.value.outcome === 'conflict') {
      return this.refusedOutcome(parsed.key, parsed.digest, 'revision-conflict', recordedAtIso, deadlineIso);
    }
    if (saved.value.outcome === 'refused') {
      return this.casRefusal(parsed.key, parsed.digest, saved.value.reason, recordedAtIso, deadlineIso);
    }
    const resultFailure = await this.appendCompletedResult(parsed.key, parsed.digest, 'attested', recordedAtIso, deadlineIso);
    if (resultFailure !== null) {
      return resultFailure;
    }
    return { outcome: 'attested', ledger: saved.value.ledger, attestation: context.attestation };
  }

  /** The record this operation writes: the request digest plus this operation's binding. */
  private async attestationFor(
    parsed: ParsedAttestation,
    clock: { readonly recordedAtIso: string; readonly observedDay: string },
  ): Promise<ShadowAttestation> {
    return {
      fact: parsed.input.fact,
      observedDay: clock.observedDay,
      releaseSha: await this.readReleaseSha(),
      reason: 'owner-attested',
      digest: parsed.digest,
      recordedAtIso: clock.recordedAtIso,
      operationDigest: parsed.operationDigest,
    };
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
