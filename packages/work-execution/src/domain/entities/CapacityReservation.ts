// @generated entity stub — refined for migration step 1.
/**
 * CapacityReservation is a child entity of Attempt: one physical slot held
 * for one attempt on one host until the attempt ends. Releasing is a
 * one-way transition; a released slot is never re-held by the same record.
 */

import type { CapacityReservationRecord } from '../execution-records.js';

export class CapacityReservation {
  private constructor(private record: CapacityReservationRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: CapacityReservationRecord): CapacityReservation {
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new Error('CapacityReservation requires a non-empty id');
    }
    if (typeof record.attemptId !== 'string' || record.attemptId.trim().length === 0) {
      throw new Error('CapacityReservation requires a non-empty attemptId');
    }
    if (typeof record.hostId !== 'string' || record.hostId.trim().length === 0) {
      throw new Error('CapacityReservation requires a non-empty hostId');
    }
    if (Number.isInteger(record.slotIndex) === false || record.slotIndex < 0) {
      throw new Error('CapacityReservation requires a non-negative integer slotIndex');
    }
    if (typeof record.reservedAtIso !== 'string' || record.reservedAtIso.trim().length === 0) {
      throw new Error('CapacityReservation requires a non-empty reservedAtIso');
    }
    if (record.releasedAtIso !== null && record.held) {
      throw new Error('A held reservation cannot carry a releasedAtIso');
    }
    return new CapacityReservation({ ...record });
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): CapacityReservationRecord {
    return { ...this.record };
  }

  getAttemptId(): string {
    return this.record.attemptId;
  }

  getHostId(): string {
    return this.record.hostId;
  }

  isHeld(): boolean {
    return this.record.held;
  }

  isReleased(): boolean {
    return !this.record.held && this.record.releasedAtIso !== null;
  }

  /**
   * Release is one-way: a released reservation is never re-held, and only a
   * held reservation may be released.
   */
  release(releasedAtIso: string): CapacityReservationRecord {
    if (this.record.held === false) {
      throw new Error('Only a held reservation can be released');
    }
    const released: CapacityReservationRecord = {
      ...this.record,
      held: false,
      releasedAtIso,
    };
    this.record = released;
    return released;
  }
}
