export type SemanticTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'decision';

/** Maps a semantic tone onto a CSS-module class key (`toneAccent`, ...). */
export function toneClassKey(tone: SemanticTone): string {
  return `tone${tone.charAt(0).toUpperCase()}${tone.slice(1)}`;
}