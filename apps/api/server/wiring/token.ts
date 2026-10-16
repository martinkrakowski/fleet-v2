import { lstatSync, readFileSync } from "node:fs";

let activeToken: string | null = null;

export function setActiveApiToken(token: string | null): void {
  activeToken = token;
}

export function getActiveApiToken(): string | null {
  return activeToken;
}

export function readApiTokenFromFile(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string" || filePath.trim().length === 0) {
    return null;
  }
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    // Must have no group/other mode bits: (stats.mode & 0o077) === 0
    if ((stats.mode & 0o077) !== 0) {
      return null;
    }
    const content = readFileSync(filePath, "utf8");
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? "";
    if (firstLine.length < 32) {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{32,}$/.test(firstLine)) {
      return null;
    }
    return firstLine;
  } catch {
    return null;
  }
}
