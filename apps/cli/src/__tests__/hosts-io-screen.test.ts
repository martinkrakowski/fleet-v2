/**
 * The hosts command's one output wrapper (HN1b): `screenedHostsIo` is the only
 * place raw stdout/stderr is written, and no hosts subcommand echoes a
 * token-shaped argument or host key, in any argument or file position.
 *
 * The architecture test reads `hosts.ts` as text. The leak test drives the
 * real CLI entry (`runCli`) with a 36-character alphanumeric token in each
 * position and checks every 20-character window of that token against stdout
 * and stderr.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DoctorCommandRunResult,
  HostProbeExecutor,
} from "@fleet/onboarding";

import { runCli, type CliIo } from "../index.js";

const HOSTS_SOURCE = readFileSync(
  path.join(import.meta.dirname, "..", "hosts.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Architecture: raw io is written only inside screenedHostsIo
// ---------------------------------------------------------------------------

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** The text of one top-level function: from its signature to its closing `}`. */
function functionText(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is in hosts.ts`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

describe("hosts.ts output architecture", () => {
  const code = withoutComments(HOSTS_SOURCE);
  const wrapper = functionText(code, "export function screenedHostsIo(");
  const rest = code.replace(wrapper, "");

  it("writes the raw streams only inside screenedHostsIo", () => {
    expect(wrapper).toMatch(/\bio\.stdout\(/);
    expect(wrapper).toMatch(/\bio\.stderr\(/);
    expect(rest).not.toMatch(/\bio\.(?:stdout|stderr)\b/);
    expect(rest).not.toMatch(/\bprocess\.(?:stdout|stderr)\b/);
    expect(rest).not.toMatch(/\bconsole\./);
    expect(wrapper).not.toMatch(/\bprocess\.(?:stdout|stderr)\b|\bconsole\./);
  });

  it("holds the raw io only in hostsCommand and the wrapper", () => {
    const entry = functionText(code, "export async function hostsCommand(");
    expect(rest.match(/\brawIo\b/g)?.length).toBe(
      (entry.match(/\brawIo\b/g) ?? []).length,
    );
    expect(entry.match(/\brawIo\b/g)).toHaveLength(2);
    expect(entry).toContain("screenedHostsIo(rawIo,");
    const wrapAt = entry.indexOf("screenedHostsIo(rawIo,");
    for (const handler of [
      "daemonCommand(",
      "parseHostsArgs(",
      "listHosts(",
      "removeHost(",
      "renameHost(",
      "writeHost(",
    ]) {
      const at = entry.indexOf(handler);
      expect(at, `${handler} is called from hostsCommand`).toBeGreaterThan(wrapAt);
    }
    expect(entry).not.toMatch(/\b(?:daemonCommand|listHosts|removeHost|renameHost|writeHost)\([^)]*rawIo/);
  });
});

// ---------------------------------------------------------------------------
// Exhaustive leak test through the real CLI entry
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fleet-hosts-io-"));
  createdDirs.push(directory);
  return directory;
}

/** A deterministic 36-character alphanumeric token, distinct per seed. */
function token(seed: string): string {
  const text = createHash("sha256")
    .update(seed)
    .digest("base64")
    .replace(/[^A-Za-z0-9]/g, "");
  expect(text.length).toBeGreaterThanOrEqual(36);
  return text.slice(0, 36);
}

function windows(value: string): string[] {
  const found: string[] = [];
  for (let index = 0; index + 20 <= value.length; index += 1) {
    found.push(value.slice(index, index + 20));
  }
  return found;
}

function leakedWindows(output: string, tokens: readonly string[]): string[] {
  return tokens.flatMap((value) =>
    windows(value).filter((window) => output.includes(window)),
  );
}

const T = token("primary");
const T2 = token("secondary");
const T3 = token("tertiary");

interface Fixture {
  readonly dir: string;
  readonly file: string;
  readonly root: string;
}

function baseHosts(root: string): Record<string, unknown> {
  return {
    mac: {
      transport: "local",
      worktreeRoot: root,
      roles: ["orchestrator", "verifier"],
    },
    lanehost: {
      transport: "ssh",
      sshAlias: "m",
      worktreeRoot: `${root}/lanehost`,
      roles: ["lane-runner"],
      runner: { kind: "opencode", port: 4166 },
    },
  };
}

type FileKind = "plain" | "token-key" | "malformed";

function fixture(kind: FileKind): Fixture {
  const dir = makeTempDir();
  const file = path.join(dir, "fleet.json");
  const root = path.join(dir, "worktrees");
  const hosts = baseHosts(root);
  if (kind === "token-key") {
    hosts[T] = {
      transport: "local",
      worktreeRoot: `${root}/${"k"}`,
      roles: ["verifier"],
    };
  }
  if (kind === "malformed") {
    hosts[T] = { transport: "carrier-pigeon", worktreeRoot: 5, [T2]: true };
  }
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 2, forge: { mode: "none" }, hosts }, null, 2)}\n`,
    "utf8",
  );
  return { dir, file, root };
}

const probeExecutor: HostProbeExecutor = {
  async run(argv): Promise<DoctorCommandRunResult> {
    const template = argv.find((part) => part.includes(".fleet-probe.XXXXXX"));
    return {
      exitCode: 0,
      signal: null,
      stdout:
        template !== undefined
          ? template.replace("XXXXXX", "probe1")
          : "tool 1.0.0",
      stderr: "",
    };
  },
};

type Answer = "yes-flag" | "prompt-y" | "prompt-n";

let stdinAnswer = "y\n";

beforeEach(() => {
  vi.spyOn(process, "stdin", "get").mockImplementation(() => {
    const stream = new PassThrough();
    stream.write(stdinAnswer);
    return stream as unknown as typeof process.stdin;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(
  argv: readonly string[],
  file: string,
  answer: Answer,
  confirm?: (question: string) => Promise<boolean>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  stdinAnswer = answer === "prompt-n" ? "n\n" : "y\n";
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  const code = await runCli(
    ["hosts", ...argv, ...(answer === "yes-flag" ? ["--yes"] : [])],
    io,
    undefined,
    undefined,
    {
      installationFile: file,
      probeExecutor,
      ...(confirm !== undefined ? { confirm } : {}),
    },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

interface LeakCase {
  readonly name: string;
  readonly file: FileKind;
  /** Builds argv from the fixture; the tokens appear in argv and/or the file. */
  readonly argv: (fixture: Fixture) => readonly string[];
  readonly tokens: readonly string[];
  /** Subcommands whose flags refuse `--yes` run once, without the answer modes. */
  readonly writes: boolean;
}

function writeCase(
  name: string,
  file: FileKind,
  argv: (fixture: Fixture) => readonly string[],
  tokens: readonly string[] = [T],
): LeakCase {
  return { name, file, argv, tokens, writes: true };
}

function readCase(
  name: string,
  file: FileKind,
  argv: (fixture: Fixture) => readonly string[],
  tokens: readonly string[] = [T],
): LeakCase {
  return { name, file, argv, tokens, writes: false };
}

const VERIFIER = ["--role", "verifier"] as const;

const CASES: readonly LeakCase[] = [
  // list
  readCase("list: token host key in the file", "token-key", () => ["list"]),
  readCase("list: malformed entry under a token key", "malformed", () => ["list"], [T, T2]),
  readCase("list: extra positional argument", "plain", () => ["list", T]),
  readCase("list: unknown flag named by a token", "plain", () => ["list", `--${T}`]),
  readCase("list: token flag value", "plain", () => ["list", `--${T}=${T2}`], [T, T2]),
  readCase("unknown subcommand", "plain", () => [T]),
  readCase("no subcommand with a token host key", "token-key", () => []),
  readCase("help with a token host key", "token-key", () => ["--help"]),

  // add
  writeCase("add: token host name", "plain", ({ root }) => ["add", T, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: token host name that exists", "token-key", ({ root }) => ["add", T, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: token --ssh value", "plain", ({ root }) => ["add", "newhost", "--ssh", T, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: token --ssh=value", "plain", ({ root }) => ["add", "newhost", `--ssh=${T}`, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: refused --ssh value", "plain", ({ root }) => ["add", "newhost", "--ssh", `-${T}`, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: token --worktree-root value", "plain", ({ root }) => ["add", "newhost", "--worktree-root", `${root}/${T}`, ...VERIFIER]),
  writeCase("add: token relative --worktree-root", "plain", () => ["add", "newhost", "--worktree-root", T, ...VERIFIER]),
  writeCase("add: token --worktree-root=value", "plain", ({ root }) => ["add", "newhost", `--worktree-root=${root}/${T}`, ...VERIFIER]),
  writeCase("add: extra positional argument", "plain", ({ root }) => ["add", "newhost", T, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: token --from-descriptor path", "plain", () => ["add", "newhost", "--from-descriptor", `/nowhere/${T}.json`, ...VERIFIER]),
  writeCase("add: token --role value", "plain", ({ root }) => ["add", "newhost", "--role", T, "--worktree-root", root]),
  writeCase("add: token --port value", "plain", ({ root }) => ["add", "newhost", "--port", T, "--worktree-root", root, ...VERIFIER]),
  writeCase("add: token host key in the file", "token-key", ({ root }) => ["add", "newhost", "--worktree-root", root, ...VERIFIER]),
  writeCase("add: malformed entry under a token key", "malformed", ({ root }) => ["add", "newhost", "--worktree-root", root, ...VERIFIER], [T, T2]),
  writeCase("add: token name and token ssh and token root", "plain", ({ root }) => ["add", T, "--ssh", T2, "--worktree-root", `${root}/${T3}`, ...VERIFIER], [T, T2, T3]),

  // edit
  writeCase("edit: token host name that is a file key", "token-key", () => ["edit", T, "--port", "4170"]),
  writeCase("edit: token host name that is absent", "plain", () => ["edit", T, "--port", "4170"]),
  writeCase("edit: token --ssh value", "plain", () => ["edit", "lanehost", "--ssh", T]),
  writeCase("edit: token --ssh value on a local host", "plain", () => ["edit", "mac", "--ssh", T]),
  writeCase("edit: token --worktree-root value", "plain", ({ root }) => ["edit", "lanehost", "--worktree-root", `${root}/${T}`]),
  writeCase("edit: extra positional argument", "plain", () => ["edit", "lanehost", T, "--port", "4170"]),
  writeCase("edit: token --role value", "plain", () => ["edit", "lanehost", "--role", T]),
  writeCase("edit: token --port value", "plain", () => ["edit", "lanehost", "--port", T]),
  writeCase("edit: token host key in the file", "token-key", () => ["edit", "lanehost", "--port", "4170"]),
  writeCase("edit: malformed entry under a token key", "malformed", () => ["edit", "lanehost", "--port", "4170"], [T, T2]),

  // remove
  writeCase("remove: token host name that is a file key", "token-key", () => ["remove", T]),
  writeCase("remove: token host name that is absent", "plain", () => ["remove", T]),
  writeCase("remove: extra positional argument", "plain", () => ["remove", "lanehost", T]),
  writeCase("remove: token host key in the file", "token-key", () => ["remove", "lanehost"]),
  writeCase("remove: malformed entry under a token key", "malformed", () => ["remove", "lanehost"], [T, T2]),
  writeCase("remove: malformed token key by name", "malformed", () => ["remove", T], [T, T2]),

  // rename
  writeCase("rename: token current name that is a file key", "token-key", () => ["rename", T, "renamed"]),
  writeCase("rename: token current name that is absent", "plain", () => ["rename", T, "renamed"]),
  writeCase("rename: token new name", "plain", () => ["rename", "lanehost", T]),
  writeCase("rename: token current and new name", "token-key", () => ["rename", T, T2], [T, T2]),
  writeCase("rename: extra positional argument", "plain", () => ["rename", "lanehost", "renamed", T]),
  writeCase("rename: token host key in the file", "token-key", () => ["rename", "lanehost", "renamed"]),
  writeCase("rename: token key in the file, new name token", "token-key", () => ["rename", "lanehost", T2], [T, T2]),
  writeCase("rename: malformed entry under a token key", "malformed", () => ["rename", T, "renamed"], [T, T2]),
  writeCase("rename: malformed file, other host", "malformed", () => ["rename", "lanehost", "renamed"], [T, T2]),

  // daemon
  readCase("daemon: token action", "plain", () => ["daemon", T]),
  readCase("daemon: token scheduler", "plain", () => ["daemon", "show", "--scheduler", T]),
  readCase("daemon: token flag", "plain", () => ["daemon", "show", `--${T}`]),
  readCase("daemon: token key in a valid file", "token-key", () => ["daemon", "show", "--scheduler", "systemd"]),
  readCase("daemon: malformed entry under a token key", "malformed", () => ["daemon", "show", "--scheduler", "systemd"], [T, T2]),
];

const ANSWERS: readonly Answer[] = ["yes-flag", "prompt-y", "prompt-n"];

describe("hosts: no subcommand echoes a token in any position", () => {
  it("covers every subcommand the help lists", async () => {
    const { stdout } = await run(["--help"], fixture("plain").file, "prompt-n");
    const listed = [...stdout.matchAll(/^ {2}([a-z]+)(?: |$)/gm)].map(
      (match) => match[1],
    );
    expect(listed.sort()).toEqual(
      ["add", "daemon", "edit", "list", "remove", "rename"].sort(),
    );
    const covered = new Set(
      CASES.map((entry) => entry.name.split(":")[0].split(" ")[0]),
    );
    for (const subcommand of listed) {
      expect(covered.has(subcommand), `${subcommand} has leak cases`).toBe(true);
    }
  });

  it("reaches the command with the token (control: the file holds it)", async () => {
    const { file, root } = fixture("plain");
    const { code, stdout, stderr } = await run(
      ["add", T, "--worktree-root", root, ...VERIFIER],
      file,
      "yes-flag",
    );
    expect(code).toBe(0);
    expect(readFileSync(file, "utf8")).toContain(T);
    expect(leakedWindows(`${stdout}\n${stderr}`, [T])).toEqual([]);
  });

  for (const entry of CASES) {
    const modes: readonly Answer[] = entry.writes ? ANSWERS : ["prompt-y"];
    for (const answer of modes) {
      it(`${entry.name} [${answer}]`, async () => {
        const state = fixture(entry.file);
        const { code, stdout, stderr } = await run(
          entry.argv(state),
          state.file,
          answer,
        );
        expect([0, 1, 2]).toContain(code);
        expect(
          leakedWindows(stdout, entry.tokens),
          `stdout of exit ${code}`,
        ).toEqual([]);
        expect(
          leakedWindows(stderr, entry.tokens),
          `stderr of exit ${code}`,
        ).toEqual([]);
      });
    }
  }
});

describe("hosts: the confirmation prompt never carries a token", () => {
  it("the default stdin prompt of rename screens the new name", async () => {
    const { file } = fixture("plain");
    const { code, stdout, stderr } = await run(
      ["rename", "lanehost", T],
      file,
      "prompt-y",
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/rename host host:[0-9a-f]{12} to /);
    expect(leakedWindows(`${stdout}${stderr}`, [T])).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain(T);
  });

  it("the default stdin prompt of rename, declined, screens the new name", async () => {
    const { file } = fixture("plain");
    const { code, stdout, stderr } = await run(
      ["rename", "lanehost", T],
      file,
      "prompt-n",
    );
    expect(code).toBe(1);
    expect(stdout).toContain("rename host ");
    expect(stderr).toContain("not confirmed; nothing was written");
    expect(leakedWindows(`${stdout}${stderr}`, [T])).toEqual([]);
    expect(readFileSync(file, "utf8")).not.toContain(T);
  });

  it("an injected gate receives a screened question", async () => {
    const { file, root } = fixture("token-key");
    const questions: string[] = [];
    const renamed = await run(
      ["rename", T, T2],
      file,
      "prompt-y",
      async (question) => {
        questions.push(question);
        return false;
      },
    );
    const added = await run(
      ["add", T3, "--worktree-root", `${root}/${T3}`, ...VERIFIER],
      file,
      "prompt-y",
      async (question) => {
        questions.push(question);
        return false;
      },
    );
    expect(questions.length).toBe(2);
    expect(renamed.code).toBe(1);
    expect(added.code).toBe(1);
    expect(leakedWindows(questions.join("\n"), [T, T2, T3])).toEqual([]);
    expect(
      leakedWindows(
        `${renamed.stdout}${renamed.stderr}${added.stdout}${added.stderr}`,
        [T, T2, T3],
      ),
    ).toEqual([]);
  });

  it("a successful run with --yes prints no prompt and no token", async () => {
    const { file } = fixture("token-key");
    const { code, stdout, stderr } = await run(
      ["rename", T, T2],
      file,
      "yes-flag",
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain("[y/N]");
    expect(leakedWindows(`${stdout}${stderr}`, [T, T2])).toEqual([]);
  });
});
