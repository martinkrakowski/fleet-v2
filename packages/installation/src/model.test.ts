import { describe, expect, it } from 'vitest';

import { deriveInstallationModel, V1_SHELF_IGNORED_WARNING } from './model.js';
import { parseInstallation } from './parse.js';
import { checkInstallationModel } from './load.js';
import type { FleetInstallation } from './types.js';

function v1WithReviewer(reviewer: unknown): FleetInstallation {
  return {
    schemaVersion: 1,
    runner: { agent: 'implementer', model: 'implementer-model' },
    reviewer,
  } as FleetInstallation;
}

describe('deriveInstallationModel reviewer.tool', () => {
  it('derives a reviewer seat with tool api and keeps the unprefixed model', () => {
    const outcome = deriveInstallationModel({
      schemaVersion: 1,
      runner: { agent: 'implementer', model: 'implementer-model' },
      reviewer: { agent: 'reviewer', model: 'openai/gpt-6-luna', tool: 'api' },
    });
    expect(outcome.errors).toBeUndefined();
    const seat = outcome.model.seats?.find((entry) => entry.id === 'reviewer');
    expect(seat).toEqual({
      id: 'reviewer',
      tool: 'api',
      model: 'openai/gpt-6-luna',
      agent: 'reviewer',
      roles: ['reviewer'],
    });
    expect(outcome.model.tools).toContain('api');
    expect(outcome.model.chains?.reviewer).toEqual([{ seatId: 'reviewer' }]);
  });

  it('defaults tool to opencode when reviewer.tool is absent', () => {
    const outcome = deriveInstallationModel({
      schemaVersion: 1,
      runner: { agent: 'implementer', model: 'implementer-model' },
      reviewer: { agent: 'reviewer', model: 'review-model' },
    });
    expect(outcome.errors).toBeUndefined();
    const seat = outcome.model.seats?.find((entry) => entry.id === 'reviewer');
    expect(seat?.tool).toBe('opencode');
    expect(outcome.model.tools).toContain('opencode');
  });

  it('keeps a prefixed model faithful to the configured value', () => {
    const outcome = deriveInstallationModel({
      schemaVersion: 1,
      runner: { agent: 'implementer', model: 'implementer-model' },
      reviewer: {
        agent: 'reviewer',
        model: 'openrouter/openai/gpt-6-luna',
        tool: 'api',
      },
    });
    expect(outcome.errors).toBeUndefined();
    const seat = outcome.model.seats?.find((entry) => entry.id === 'reviewer');
    expect(seat?.model).toBe('openrouter/openai/gpt-6-luna');
    expect(seat?.tool).toBe('api');
  });

  it('refuses unknown reviewer.tool without defaulting to opencode', () => {
    const outcome = deriveInstallationModel(
      v1WithReviewer({ agent: 'reviewer', model: 'review-model', tool: 'unknown' }),
    );
    expect(outcome.errors).toEqual(['reviewer.tool: must be a known review tool']);
    expect(outcome.model.seats?.some((entry) => entry.id === 'reviewer')).toBe(false);
    expect(outcome.model.chains?.reviewer).toBeUndefined();
  });

  it('refuses null and non-string reviewer.tool', () => {
    for (const tool of [null, 123, '']) {
      const outcome = deriveInstallationModel(
        v1WithReviewer({ agent: 'reviewer', model: 'review-model', tool }),
      );
      expect(outcome.errors).toEqual(['reviewer.tool: must be a known review tool']);
      expect(outcome.model.seats?.some((entry) => entry.id === 'reviewer')).toBe(false);
    }
  });

  it('refuses accessor or throwing getter on reviewer.tool without invoking it', () => {
    const reviewer: Record<string, unknown> = { agent: 'reviewer', model: 'review-model' };
    Object.defineProperty(reviewer, 'tool', {
      get() {
        throw new Error('getter must never run');
      },
      enumerable: true,
    });
    const outcome = deriveInstallationModel(v1WithReviewer(reviewer));
    expect(outcome.errors).toEqual(['reviewer.tool: must be a plain data property']);
    expect(outcome.model.seats?.some((entry) => entry.id === 'reviewer')).toBe(false);
    expect(outcome.model.chains?.reviewer).toBeUndefined();
  });

  it('refuses invalid reviewer.tool even when reviewer.model is undefined', () => {
    for (const tool of ['unknown', null, 123]) {
      const outcome = deriveInstallationModel(v1WithReviewer({ agent: 'reviewer', tool }));
      expect(outcome.errors).toEqual(['reviewer.tool: must be a known review tool']);
      expect(outcome.model.seats?.some((entry) => entry.id === 'reviewer')).toBe(false);
    }
    const accessor: Record<string, unknown> = { agent: 'reviewer' };
    Object.defineProperty(accessor, 'tool', {
      get() {
        throw new Error('getter must never run');
      },
      enumerable: true,
    });
    const accessorOutcome = deriveInstallationModel(v1WithReviewer(accessor));
    expect(accessorOutcome.errors).toEqual(['reviewer.tool: must be a plain data property']);
    expect(accessorOutcome.model.seats?.some((entry) => entry.id === 'reviewer')).toBe(false);
  });

  it('still reports the shelf warning alongside a derivation error', () => {
    const outcome = deriveInstallationModel({
      ...v1WithReviewer({ agent: 'reviewer', model: 'review-model', tool: 'nope' }),
      shelf: { baseUrl: 'https://shelf.internal', keyFile: 'key.pem' },
    });
    expect(outcome.warnings).toEqual([V1_SHELF_IGNORED_WARNING]);
    expect(outcome.errors).toEqual(['reviewer.tool: must be a known review tool']);
  });
});

describe('parseInstallation reviewer.tool', () => {
  it('accepts a known tool and returns the parsed section', () => {
    const result = parseInstallation(v1WithReviewer({
      agent: 'reviewer',
      model: 'openai/gpt-6-luna',
      tool: 'api',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const reviewer = (result.installation as { reviewer?: { tool?: string } }).reviewer;
      expect(reviewer?.tool).toBe('api');
    }
  });

  it('refuses unknown reviewer.tool without echoing the value', () => {
    for (const tool of ['openrouter', 'unknown']) {
      const result = parseInstallation(v1WithReviewer({
        agent: 'reviewer',
        model: 'review-model',
        tool,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['reviewer.tool: must be a known review tool']);
        expect(JSON.stringify(result.errors)).not.toContain(String(tool));
      }
    }
  });

  it('refuses null and non-string reviewer.tool', () => {
    for (const tool of [null, 123, '']) {
      const result = parseInstallation(v1WithReviewer({
        agent: 'reviewer',
        model: 'review-model',
        tool,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(['reviewer.tool: must be a known review tool']);
      }
    }
  });

  it('refuses accessor or throwing getter on reviewer.tool without invoking it', () => {
    const reviewer: Record<string, unknown> = { agent: 'reviewer', model: 'review-model' };
    Object.defineProperty(reviewer, 'tool', {
      get() {
        throw new Error('getter must never run');
      },
      enumerable: true,
    });
    const result = parseInstallation(v1WithReviewer(reviewer));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(['reviewer.tool: must be a plain data property']);
    }
  });

  it('refuses null, array, and unknown-key reviewer sections', () => {
    const nullResult = parseInstallation(v1WithReviewer(null));
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) {
      expect(nullResult.errors).toEqual(['reviewer: must be an object']);
    }

    const arrayResult = parseInstallation(v1WithReviewer([]));
    expect(arrayResult.ok).toBe(false);
    if (!arrayResult.ok) {
      expect(arrayResult.errors).toEqual(['reviewer: must be an object']);
    }

    const unknownKeyResult = parseInstallation(v1WithReviewer({
      agent: 'reviewer',
      model: 'review-model',
      transport: 'api',
    }));
    expect(unknownKeyResult.ok).toBe(false);
    if (!unknownKeyResult.ok) {
      expect(unknownKeyResult.errors).toEqual(['reviewer: unknown key']);
    }

    const missingAgentResult = parseInstallation(v1WithReviewer({ model: 'review-model' }));
    expect(missingAgentResult.ok).toBe(false);
    if (!missingAgentResult.ok) {
      expect(missingAgentResult.errors).toEqual(['reviewer.agent: required']);
    }

    const missingModelResult = parseInstallation(v1WithReviewer({ agent: 'reviewer' }));
    expect(missingModelResult.ok).toBe(false);
    if (!missingModelResult.ok) {
      expect(missingModelResult.errors).toEqual(['reviewer.model: required']);
    }
  });
});

describe('checkInstallationModel reviewer.tool', () => {
  it('propagates reviewer.tool derivation error in checkInstallationModel', () => {
    const checked = checkInstallationModel(
      v1WithReviewer({ agent: 'reviewer', model: 'review-model', tool: 'unknown' }),
    );
    expect(checked.errors).toEqual(['reviewer.tool: must be a known review tool']);
    expect(checked.model.seats?.some((entry) => entry.id === 'reviewer')).toBe(false);
  });
});
