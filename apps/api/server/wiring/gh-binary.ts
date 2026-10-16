/**
 * Pure resolution of the reviewed GitHub CLI binary (S4036): spawning `gh`
 * through PATH would let the environment choose the executable, so the wiring
 * resolves the binary itself from a fixed list of absolute locations and only
 * ever spawns an absolute path.
 */
export const GH_BINARY_CANDIDATES: readonly string[] = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

/**
 * Return the first candidate that is an executable regular file, else
 * `undefined`. Pure: the executable check is injected, so resolution is
 * deterministic and unit-testable without touching the filesystem.
 */
export function resolveGhBinary(
  candidates: readonly string[],
  isExecutable: (candidate: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
