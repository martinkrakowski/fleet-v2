import { describe, expect, it } from 'vitest';
import { isValidBriefProjectId } from '../evidence-records.js';

describe('isValidBriefProjectId', () => {
  it('accepts an ordinary id, an id with an inner space, a non-ASCII id and one of exactly 200 characters', () => {
    expect(isValidBriefProjectId('proj-1')).toBe(true);
    expect(isValidBriefProjectId('my project')).toBe(true);
    expect(isValidBriefProjectId('projekt-ł')).toBe(true);
    expect(isValidBriefProjectId('p'.repeat(200))).toBe(true);
  });

  it('refuses an empty id and one of 201 characters', () => {
    expect(isValidBriefProjectId('')).toBe(false);
    expect(isValidBriefProjectId('p'.repeat(201))).toBe(false);
  });

  it.each([
    ['a leading space', ' proj-1'],
    ['a trailing space', 'proj-1 '],
    ['a leading tab', '\tproj-1'],
    ['a trailing newline', 'proj-1\n'],
    ['only whitespace', '   '],
  ])('refuses an id with %s', (_title, value) => {
    expect(isValidBriefProjectId(value)).toBe(false);
  });

  it.each([
    ['a colon', 'proj:1'],
    ['a slash', 'proj/1'],
    ['a NUL character', 'proj\u00001'],
    ['a newline inside', 'proj\n1'],
    ['a tab inside', 'proj\t1'],
    ['the last C0 control character (0x1f)', 'proj\u001f1'],
    ['DEL (0x7f)', 'proj\u007f1'],
  ])('refuses an id containing %s', (_title, value) => {
    expect(isValidBriefProjectId(value)).toBe(false);
  });

  it('accepts the characters next to the refused ones: space (0x20), tilde (0x7e) and a backslash', () => {
    expect(isValidBriefProjectId('a b')).toBe(true);
    expect(isValidBriefProjectId('a~b')).toBe(true);
    expect(isValidBriefProjectId('a\\b')).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an array holding a valid id', ['proj-1']],
    ['an object', { toString: () => 'proj-1' }],
    ['a symbol', Symbol('proj-1')],
  ])('refuses %s, which is not a string', (_title, value) => {
    expect(isValidBriefProjectId(value)).toBe(false);
  });
});
