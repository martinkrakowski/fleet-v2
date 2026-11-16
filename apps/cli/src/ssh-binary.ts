/**
 * Pure resolution of the reviewed ssh client binary (S4036): spawning `ssh`
 * through PATH would let the environment choose the executable, so the
 * composition root resolves the binary itself from a fixed list of absolute
 * locations and only ever spawns an absolute path. Mirrors `gh-binary.ts`.
 */
export const SSH_BINARY_CANDIDATES: readonly string[] = [
  '/usr/bin/ssh',
  '/bin/ssh',
  '/usr/local/bin/ssh',
  '/opt/homebrew/bin/ssh',
];

/**
 * Return the first candidate that is an executable regular file, else
 * `undefined`. Pure: the executable check is injected, so resolution is
 * deterministic and unit-testable without touching the filesystem.
 */
export function resolveSshBinary(
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
