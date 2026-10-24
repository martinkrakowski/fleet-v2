import { describe, expect, it } from 'vitest';

import { detailNamesSession } from '../ReconcileAttemptUseCase.use-case.js';

describe('detailNamesSession', () => {
  it.each(['ses_ab', '', 'x', 'dispatch ambiguous: ses_1 maybe'])(
    'never names an empty session id (detail %j) and terminates',
    (detail) => {
      expect(detailNamesSession(detail, '')).toBe(false);
    },
  );

  it('names a whole-token id and not a prefix of a longer id', () => {
    expect(detailNamesSession('started ses_a, exit unknown', 'ses_a')).toBe(true);
    expect(detailNamesSession('started ses_ab, exit unknown', 'ses_a')).toBe(false);
  });
});
