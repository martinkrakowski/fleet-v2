// TUI shell pure-logic tests — P9.
import { describe, expect, it } from 'vitest';

import { frameLines, nextScreenId, tuiActionFor } from './shell.js';

describe('tuiActionFor', () => {
  it('maps n, p, r and q to the four actions', () => {
    expect(tuiActionFor('n')).toBe('next');
    expect(tuiActionFor('p')).toBe('prev');
    expect(tuiActionFor('r')).toBe('reload');
    expect(tuiActionFor('q')).toBe('quit');
  });

  it('maps every other input to none', () => {
    for (const input of ['x', 'j', 'k', '', '\u001b[B']) {
      expect(tuiActionFor(input)).toBe('none');
    }
  });
});

describe('nextScreenId', () => {
  const screens = [
    { id: 'runs', title: 'Runs', rows: [] },
    { id: 'board', title: 'Board', rows: [] },
  ];

  it('wraps forward', () => {
    expect(nextScreenId(screens, 'runs', 'next')).toBe('board');
    expect(nextScreenId(screens, 'board', 'next')).toBe('runs');
  });

  it('wraps backward', () => {
    expect(nextScreenId(screens, 'board', 'prev')).toBe('runs');
    expect(nextScreenId(screens, 'runs', 'prev')).toBe('board');
  });

  it('returns the first screen for an unknown current id', () => {
    expect(nextScreenId(screens, 'unknown', 'next')).toBe('runs');
    expect(nextScreenId(screens, 'unknown', 'prev')).toBe('runs');
  });

  it('returns the current id for an empty registry', () => {
    expect(nextScreenId([], 'runs', 'next')).toBe('runs');
  });
});

describe('frameLines', () => {
  it('frames header, rows and footer exactly', () => {
    const screen = { id: 'runs', title: 'Runs', rows: ['row one', 'row two'] };
    expect(frameLines(screen, '2026-11-03T10:04:00.000Z')).toEqual([
      'fleet-v2 tui - Runs - read 10:04',
      'row one',
      'row two',
      'n next screen   p prev screen   r re-read   q quit',
    ]);
  });
});
