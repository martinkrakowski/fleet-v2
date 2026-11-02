/**
 * The reviewed GitHub CLI binary's fixed absolute candidate paths. The CLI
 * composition root re-exports this constant, so doctor and the forge adapters
 * name the same list; `gh` is never spawned through PATH (S4036).
 */
export const GH_BINARY_CANDIDATES: readonly string[] = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
];
