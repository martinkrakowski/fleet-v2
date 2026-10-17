// Tests for lane Q0: every pattern family matches a fake value assembled at
// runtime from harmless parts, so this test file itself matches nothing; the
// helpers report whether or where a shape appears, never the matched text.
import { describe, expect, it } from 'vitest';
import { LANE_DIFF_SECRET_PATTERNS, SECRET_PATTERNS, containsSecretShape, findSecretShapeLines } from '../secret-patterns.js';

// Each fake value is built from fragments so no pattern literal ever appears
// contiguously in this file.
const pemHeader = ['-----BEGIN ', 'RSA', ' PRIVATE KEY-----'].join('');
const githubToken = ['gh', 'p_', 'a1B2c3D4'.repeat(4)].join('');
const apiKey = ['sk', '-', 'x9y8z7'.repeat(4)].join('');
const awsKey = ['AK', 'IA', 'B2C3D4F5G6H7J8K9'].join('');
const slackToken = ['xo', 'xb-', 'abcdefghij'].join('');
const jwt = ['ey', 'J', 'a'.repeat(12), '.', 'b'.repeat(12), '.', 'c'.repeat(12)].join('');

const fakeSecrets: Record<string, string> = {
  'PEM private key': pemHeader,
  'GitHub token': githubToken,
  'API key': apiKey,
  'AWS access key': awsKey,
  'Slack token': slackToken,
  JWT: jwt,
};

describe('SECRET_PATTERNS registry', () => {
  it('exports the six secret patterns without the g flag', () => {
    expect(SECRET_PATTERNS).toHaveLength(6);
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.global, pattern.source).toBe(false);
    }
  });
});

describe('containsSecretShape', () => {
  it('matches each pattern family against a fake value assembled at runtime', () => {
    for (const [name, fake] of Object.entries(fakeSecrets)) {
      expect(containsSecretShape(fake), name).toBe(true);
    }
  });

  it('does not match ordinary prose', () => {
    const prose = [
      'The orchestrator reviewed the keeper and accepted it.',
      'Plan the lane, freeze the brief, then dispatch the attempt.',
      'A discarded draft and an unfinished sketch are not findings.',
      ['-----BEGIN ', 'DRAFT', ' NOTES-----'].join(''),
      '',
    ];
    for (const text of prose) {
      expect(containsSecretShape(text), text).toBe(false);
    }
  });
});

describe('findSecretShapeLines', () => {
  it('returns the 1-based line numbers of the lines that contain a secret shape', () => {
    const text = [
      'An ordinary opening line.',
      ['relay log mentions ', slackToken, ' twice'].join(''),
      'An ordinary middle line.',
      pemHeader,
      'An ordinary closing line.',
    ].join('\n');
    expect(findSecretShapeLines(text)).toEqual([2, 4]);
  });

  it('counts the first line as 1', () => {
    const text = [apiKey, 'nothing suspicious here'].join('\n');
    expect(findSecretShapeLines(text)).toEqual([1]);
  });

  it('reports a line containing several shapes once', () => {
    const text = [['one line: ', awsKey, ' and ', jwt].join(''), 'tail'].join('\n');
    expect(findSecretShapeLines(text)).toEqual([1]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(findSecretShapeLines('ordinary prose\nmore ordinary prose')).toEqual([]);
    expect(findSecretShapeLines('')).toEqual([]);
  });

  it('returns numbers only, never the matched text', () => {
    const text = ['a leak below', githubToken].join('\n');
    const lines = findSecretShapeLines(text);
    expect(lines).toEqual([2]);
    expect(JSON.stringify(lines)).toMatch(/^\[[0-9,\s]*\]$/);
  });
});

describe('LANE_DIFF_SECRET_PATTERNS POSIX space parity (O14d1)', () => {
  it('the four assignment patterns use explicit [[:space:]]-equivalent classes, never \\s or \\S', () => {
    for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
      expect(pattern.regex.source, pattern.name).not.toContain('\\s');
      expect(pattern.regex.source, pattern.name).not.toContain('\\S');
    }
  });

  it('a tab-separated password assignment still matches like the POSIX classes', () => {
    const tab = String.fromCharCode(9);
    const entry = LANE_DIFF_SECRET_PATTERNS.find(
      (pattern) => pattern.name === 'opencode-server-password',
    );
    expect(entry).toBeDefined();
    const value = ['OPENCODE_SERVER_PASSWORD', '=', 'placeholder-value'].join(tab);
    expect(entry!.regex.test(value)).toBe(true);
  });
});
