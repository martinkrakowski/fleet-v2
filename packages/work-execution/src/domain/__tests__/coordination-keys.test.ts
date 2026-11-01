import { describe, expect, it } from 'vitest';
import {
  consumptionId,
  forgeActionPushesBranch,
  forgeActionScope,
  observationEventKind,
  FORGE_ACTION_KINDS,
  FORGE_REFUSAL_KINDS,
  type ForgeActionKind,
  type ForgeRefusalKind,
} from '../coordination-keys.js';

describe('coordination-keys domain', () => {
  describe('forgeActionScope', () => {
    it('formats push-and-open-pr as forge:push-and-open-pr', () => {
      const kind: ForgeActionKind = 'push-and-open-pr';
      expect(forgeActionScope(kind)).toBe('forge:push-and-open-pr');
    });

    it('formats merge-pr as forge:merge-pr', () => {
      const kind: ForgeActionKind = 'merge-pr';
      expect(forgeActionScope(kind)).toBe('forge:merge-pr');
    });

    it('handles any string action kind deterministically', () => {
      expect(forgeActionScope('custom-action')).toBe('forge:custom-action');
    });
  });

  describe('consumptionId', () => {
    it('formats actionId as consumption-<actionId>', () => {
      expect(consumptionId('act-forge-42')).toBe('consumption-act-forge-42');
      expect(consumptionId('forge-att-123')).toBe('consumption-forge-att-123');
    });
  });

  describe('observationEventKind', () => {
    it('formats action and status as execution:<action>:<status>', () => {
      expect(observationEventKind('forge', 'completed')).toBe('execution:forge:completed');
      expect(observationEventKind('forge', 'refused')).toBe('execution:forge:refused');
      expect(observationEventKind('dispatch', 'started')).toBe('execution:dispatch:started');
    });
  });
});

describe('FORGE_REFUSAL_KINDS', () => {
  it('lists the four refusal kinds in conflict-first order', () => {
    expect(FORGE_REFUSAL_KINDS).toEqual(['conflict', 'protection', 'permission', 'other']);
  });

  it('accepts other as a ForgeRefusalKind', () => {
    const kind: ForgeRefusalKind = 'other';
    expect(kind).toBe('other');
  });
});

describe('FORGE_ACTION_KINDS', () => {
  it('lists all four forge action kinds and scopes post-status', () => {
    expect(FORGE_ACTION_KINDS).toEqual(['push-and-open-pr', 'push-to-pr', 'merge-pr', 'post-status']);
    expect(forgeActionScope('post-status')).toBe('forge:post-status');
  });

  it('reports which kinds push a branch', () => {
    expect(forgeActionPushesBranch('push-and-open-pr')).toBe(true);
    expect(forgeActionPushesBranch('push-to-pr')).toBe(true);
    expect(forgeActionPushesBranch('merge-pr')).toBe(false);
    expect(forgeActionPushesBranch('post-status')).toBe(false);
  });
});
