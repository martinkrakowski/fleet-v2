import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * T6a: the server half of the web session — the interactive-session login.
 *
 * The API's on-disk bearer is never proof of an interactive session; a login
 * happens only with a single-use login code issued by this module at API
 * startup (`issueWebLoginCode`). The operator reads the code file from the
 * state directory; the browser posts the code to `POST /sessions/login`
 * (server-side only), which consumes it, removes the code file from the state
 * directory (the spent credential must never remain on disk), and establishes
 * an interactive session scoped to `read` and `message`.
 */

export const WEB_LOGIN_PATH = "/sessions/login";
export const WEB_LOGIN_HEADER = "x-fleet-session-login";
export const WEB_LOGIN_CODE_FILE = "web-login-code.json"; // inside the state directory
export const WEB_LOGIN_ACTOR = "owner"; // the fixed actor; owner identity is a later decision (brief §8)
export const WEB_LOGIN_SCOPES = ["read", "message"] as const;
export const WEB_LOGIN_CODE_MAX_LENGTH = 128;

let storedCode: string | null = null;
let consumed = false;
let codeFilePath: string | null = null;

export function isWebLoginPath(path: string): boolean {
  return path === WEB_LOGIN_PATH;
}

/** Remove the login code file from a state directory. Never throws. */
export function removeWebLoginCodeFile(stateDir: string): void {
  try {
    rmSync(join(stateDir, WEB_LOGIN_CODE_FILE), { force: true });
  } catch {
    // ignore removal failure
  }
}

/**
 * Issue a fresh single-use web login code and persist it to
 * `<stateDir>/web-login-code.json` as `{"code":...,"issuedAtIso":...}`. The
 * file is written through a temp file in the same directory (unpredictable
 * name, created exclusively with `wx` and mode `0o600`), renamed into place,
 * then chmod'ed to `0o600`. On any filesystem error (an existing temp path
 * included) the login stays closed: no code is stored, any earlier code file
 * is removed and `null` is returned; this function never throws.
 */
export function issueWebLoginCode(stateDir: string): string | null {
  const filePath = join(stateDir, WEB_LOGIN_CODE_FILE);
  codeFilePath = filePath;
  let tempPath: string | null = null;
  let code: string;
  try {
    code = randomBytes(32).toString("base64url");
    tempPath = `${filePath}.${randomBytes(16).toString("hex")}.tmp`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      tempPath,
      `${JSON.stringify({ code, issuedAtIso: new Date().toISOString() })}\n`,
      { flag: "wx", mode: 0o600, encoding: "utf8" },
    );
    renameSync(tempPath, filePath);
    chmodSync(filePath, 0o600);
  } catch {
    if (tempPath !== null) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // ignore cleanup failure
      }
    }
    try {
      rmSync(filePath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    storedCode = null;
    consumed = false;
    codeFilePath = null;
    return null;
  }
  storedCode = code;
  consumed = false;
  return code;
}

/**
 * Verify the presented code without spending it. Non-mutating: the issued code
 * stays usable until the caller commits to a login by calling
 * `consumeWebLoginCode`. Every refusal reason is a fixed, short, host-free
 * string; the presented value is never included.
 */
export function verifyWebLoginCode(presented: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof presented !== "string") {
    return { ok: false, reason: "web login code missing" };
  }
  if (presented.length > WEB_LOGIN_CODE_MAX_LENGTH) {
    return { ok: false, reason: "web login code invalid" };
  }
  if (consumed) {
    return { ok: false, reason: "web login code already used" };
  }
  if (storedCode === null) {
    return { ok: false, reason: "no web login code issued" };
  }
  const presentedBuf = Buffer.from(presented, "utf8");
  const storedBuf = Buffer.from(storedCode, "utf8");
  if (presentedBuf.length !== storedBuf.length || !timingSafeEqual(presentedBuf, storedBuf)) {
    return { ok: false, reason: "web login code refused" };
  }
  return { ok: true };
}

/**
 * Consume the issued login code: verify (see `verifyWebLoginCode`), then spend
 * it. The login route calls this only after the interactive session is
 * registered, so a refused registration never spends the code. Every refusal
 * reason is a fixed, short, host-free string; the presented value is never
 * included.
 */
export function consumeWebLoginCode(presented: unknown): { ok: true } | { ok: false; reason: string } {
  const check = verifyWebLoginCode(presented);
  if (!check.ok) {
    return check;
  }
  storedCode = null;
  consumed = true;
  if (codeFilePath !== null) {
    try {
      rmSync(codeFilePath, { force: true });
    } catch {
      // ignore removal failure; the code is still consumed in memory
    }
    codeFilePath = null;
  }
  return { ok: true };
}

/** Tests only: clear the stored code and the consumed flag. */
export function resetWebLogin(): void {
  storedCode = null;
  consumed = false;
}
