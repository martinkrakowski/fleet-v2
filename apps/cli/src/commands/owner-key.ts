/**
 * The `coordination owner-key` subcommands (KEY1b): `init` generates a new
 * Ed25519 owner keypair and writes the private key to a new `0600` file
 * outside the state directory and any git repository, printing the public
 * key and the exact installation edit; `public` derives the public key from
 * an existing `0600`/`0400` Ed25519 private key file. Both run before any
 * installation is loaded, so key generation works on a machine that has no
 * installation file yet. Every output goes through `CliIo` — no `console`.
 */

import {
  deriveOwnerPublicKeyFromFile,
  generateOwnerKeyFile,
} from '@fleet/operator-coordination';

import { CliUsageError } from './payload.js';
import type { CliIo } from '../index.js';

/** One strict `--flag <value>` extraction: anything else is a usage error. */
function requireFlag(args: readonly string[], flag: string, label: string): string {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === `--${flag}`) {
      if (value !== undefined) {
        throw new CliUsageError(`${label}: --${flag} given more than once`);
      }
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliUsageError(`${label}: --${flag} requires a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (token.startsWith(`--${flag}=`)) {
      if (value !== undefined) {
        throw new CliUsageError(`${label}: --${flag} given more than once`);
      }
      value = token.slice(flag.length + 3);
      continue;
    }
    throw new CliUsageError(`${label}: unexpected argument '${token}'`);
  }
  if (value === undefined || value.trim() === '') {
    throw new CliUsageError(`${label}: --${flag} is required`);
  }
  return value;
}

/**
 * The `coordination owner-key <init|public>` entry. Exit codes: 0 completed,
 * 1 refused (typed adapter refusal, never echoing private key material),
 * 2 usage error (thrown `CliUsageError`).
 */
export async function ownerKeyCommand(args: readonly string[], io: CliIo, stateDir?: string): Promise<number> {
  const subcommand = args[0];
  if (subcommand === 'init') {
    const outPath = requireFlag(args.slice(1), 'out', 'owner-key init');
    const result = await generateOwnerKeyFile({
      outPath,
      ...(stateDir !== undefined ? { stateDir } : {}),
    });
    if (!result.ok) {
      io.stderr(`${result.message} (${result.code})\n`);
      return 1;
    }
    io.stdout(`${result.publicKey}\n`);
    io.stdout(`${result.installationEdit}\n`);
    return 0;
  }
  if (subcommand === 'public') {
    const keyPath = requireFlag(args.slice(1), 'key', 'owner-key public');
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    if (!result.ok) {
      io.stderr(`${result.message} (${result.code})\n`);
      return 1;
    }
    io.stdout(`${result.publicKey}\n`);
    return 0;
  }
  throw new CliUsageError(
    `Unknown coordination owner-key subcommand: ${subcommand ?? '(missing)'}\n` +
      'Usage: fleet-v2 coordination owner-key init --out <path>\n' +
      '       fleet-v2 coordination owner-key public --key <path>',
  );
}
