import { describe, expect, it } from 'vitest';
import {
  consumptionId,
  forgeActionScope,
  observationEventKind,
  type ForgeActionKind,
} from './coordination-keys.js';

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
