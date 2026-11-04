import { describe, expect, it } from 'vitest';

import { parseBriefAnswer, lintBrief } from '../brief-answer.js';

describe('parseBriefAnswer', () => {
  it('splits a well formed answer into its notes text and its dispatch text', () => {
    const answer = [
      '===NOTES===',
      'Candidate notes paragraph one.',
      '',
      'Candidate notes paragraph two.',
      '===DISPATCH===',
      '# CO15',
      '',
      'Tier 1. Size: about 45 minutes, one commit.',
    ].join('\n');

    expect(parseBriefAnswer(answer)).toEqual({
      ok: true,
      notes: 'Candidate notes paragraph one.\n\nCandidate notes paragraph two.',
      dispatch: '# CO15\n\nTier 1. Size: about 45 minutes, one commit.',
    });
  });

  it('never lets the notes text into the dispatch text', () => {
    const answer = [
      '===NOTES===',
      'Distinctive notes sentence xyzzy-frobnicate-thud.',
      '===DISPATCH===',
      'Dispatch body.',
    ].join('\n');

    const result = parseBriefAnswer(answer);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.dispatch).not.toContain('Distinctive');
    expect(result.dispatch).toBe('Dispatch body.');
  });

  it('refuses an answer without a notes marker', () => {
    expect(parseBriefAnswer('===DISPATCH===\ndispatch')).toEqual({
      ok: false,
      reason: 'missing-notes-marker',
    });
  });

  it('refuses an answer without a dispatch marker', () => {
    expect(parseBriefAnswer('===NOTES===\nnotes')).toEqual({
      ok: false,
      reason: 'missing-dispatch-marker',
    });
  });

  it('refuses a repeated notes marker', () => {
    const answer = ['===NOTES===', '===NOTES===', '===DISPATCH===', 'dispatch'].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'duplicate-notes-marker',
    });
  });

  it('refuses a repeated dispatch marker', () => {
    const answer = ['===NOTES===', '===DISPATCH===', '===DISPATCH===', 'dispatch'].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'duplicate-dispatch-marker',
    });
  });

  it('refuses text before the notes marker', () => {
    const answer = ['preamble', '===NOTES===', 'notes', '===DISPATCH===', 'dispatch'].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'text-before-notes-marker',
    });
  });

  it('refuses an answer that opens with the dispatch marker as text before the notes marker', () => {
    const answer = ['===DISPATCH===', 'dispatch', '===NOTES===', 'notes'].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'text-before-notes-marker',
    });
  });

  it('refuses a github_pat_ shaped answer (both secret registries are checked)', () => {
    const secret = `github${'_pat_'}${'A'.repeat(24)}`;
    const answer = ['===NOTES===', 'notes', '===DISPATCH===', `brief ${secret}`].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({ ok: false, reason: 'secret-shaped' });
  });

  it('refuses an empty dispatch', () => {
    const answer = ['===NOTES===', 'notes', '===DISPATCH==='].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'empty-dispatch',
    });
  });

  it('refuses an empty answer', () => {
    expect(parseBriefAnswer('   \n  ')).toEqual({
      ok: false,
      reason: 'empty-answer',
    });
  });

  it('refuses a value that is not a string', () => {
    expect(parseBriefAnswer({ nope: true })).toEqual({
      ok: false,
      reason: 'not-a-string',
    });
  });

  it('refuses a secret shaped answer', () => {
    const answer = ['===NOTES===', 'ghp_' + 'a'.repeat(30), '===DISPATCH===', 'dispatch'].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'secret-shaped',
    });
  });

  it('refuses a secret shape only in the broader lane-diff registry', () => {
    // A github fine-grained token matches `LANE_DIFF_SECRET_PATTERNS` but not
    // the narrower legacy `SECRET_PATTERNS` set the answer scan used before.
    const answer = [
      '===NOTES===',
      'notes',
      '===DISPATCH===',
      'token ' + 'github_pat_' + 'a'.repeat(24),
    ].join('\n');
    expect(parseBriefAnswer(answer)).toEqual({
      ok: false,
      reason: 'secret-shaped',
    });
  });
});

describe('lintBrief', () => {
  const fullBrief = [
    '# File list',
    '- packages/a.ts',
    '# Commands',
    'yarn build',
    '# Tier',
    '1',
    '# Size',
    'about 45 minutes',
    '# Commit',
    'one commit',
    '# Validity',
    'base branch: main',
    '## Hard to undo',
    'None',
    '## Assumptions',
    'Assume X',
    '## Challenge this',
    'Challenge Y',
  ].join('\n');

  it('accepts a brief with every required section', () => {
    const result = lintBrief(fullBrief);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('reports a missing D7 section', () => {
    const brief = fullBrief.replace('## Hard to undo\nNone\n', '');
    const result = lintBrief(brief);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ rule: 'missing-hard-to-undo', label: 'Hard to undo' }]);
  });

  it('reports every missing section in the fixed order', () => {
    const brief = fullBrief
      .replace('# File list\n- packages/a.ts\n', '')
      .replace('# Tier\n1\n', '')
      .replace('# Validity\nbase branch: main\n', '')
      .replace('## Assumptions\nAssume X\n', '');
    const result = lintBrief(brief);
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.rule)).toEqual([
      'missing-file-list',
      'missing-tier',
      'missing-validity-block',
      'missing-assumptions',
    ]);
  });

  it('reports a required heading with an empty body', () => {
    const brief = fullBrief.replace('# Tier\n1\n', '# Tier\n');
    const result = lintBrief(brief);
    expect(result.findings).toContainEqual({ rule: 'missing-tier', label: 'Tier' });
  });

  it('matches a heading case insensitively', () => {
    const brief = fullBrief.replace('## Hard to undo', '## hard to undo');
    const result = lintBrief(brief);
    expect(result.findings).not.toContainEqual({
      rule: 'missing-hard-to-undo',
      label: 'Hard to undo',
    });
  });

  it('refuses a value that is not a brief', () => {
    expect(lintBrief(42)).toEqual({
      ok: false,
      findings: [{ rule: 'not-a-brief', label: '' }],
    });
  });

  it('refuses a secret shaped brief', () => {
    const brief = fullBrief + '\nghp_' + 'a'.repeat(30);
    const result = lintBrief(brief);
    expect(result.findings[0]).toEqual({ rule: 'secret-shaped', label: '' });
  });

  it('accepts tier, size, and commit provided as inline lines', () => {
    const brief = [
      '# File list',
      '- packages/a.ts',
      '# Commands',
      'yarn build',
      'Tier: 1',
      'Size: about 45 minutes',
      'Commit: one commit',
      '# Validity',
      'base branch: main',
      '## Hard to undo',
      'None',
      '## Assumptions',
      'Assume X',
      '## Challenge this',
      'Challenge Y',
    ].join('\n');
    const result = lintBrief(brief);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('does not let prose ending in the label word satisfy the commit item', () => {
    const brief = [
      '# File list',
      '- packages/a.ts',
      '# Commands',
      'yarn build',
      '# Tier',
      '1',
      '# Size',
      'about 45 minutes',
      'Avoid commit.',
      '# Validity',
      'base branch: main',
      '## Hard to undo',
      'None',
      '## Assumptions',
      'Assume X',
      '## Challenge this',
      'Challenge Y',
    ].join('\n');
    const result = lintBrief(brief);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([{ rule: 'missing-commit-line', label: 'Commit' }]);
  });

  it('does not let imperative prose satisfy the commit item', () => {
    for (const prose of ['Please commit.', 'Don\'t commit.', 'Never commit.', 'Do not commit changes.', 'Commit early and often.']) {
      const brief = [
        '# File list',
        '- packages/a.ts',
        '# Commands',
        'yarn build',
        '# Tier',
        '1',
        '# Size',
        'about 45 minutes',
        prose,
        '# Validity',
        'base branch: main',
        '## Hard to undo',
        'None',
        '## Assumptions',
        'Assume X',
        '## Challenge this',
        'Challenge Y',
      ].join('\n');
      expect(lintBrief(brief).findings).toContainEqual({
        rule: 'missing-commit-line',
        label: 'Commit',
      });
    }
  });

  it('accepts the compact tier/size/commit authoring line', () => {
    const brief = [
      '# File list',
      '- packages/a.ts',
      '# Commands',
      'yarn build',
      'Tier 1. Size: about 45 minutes, one commit.',
      '# Validity',
      'base branch: main',
      '## Hard to undo',
      'None',
      '## Assumptions',
      'Assume X',
      '## Challenge this',
      'Challenge Y',
    ].join('\n');
    const result = lintBrief(brief);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
