# Owner key setup

*Date: 2026-11-18 · Status: operator runbook. Aligns with `docs/runbooks/cutover.md`, "Owner key pinning and rotation".*

This runbook covers generating and pinning the owner Ed25519 key that signs
coordination decisions. The authority for the owner public key is
`installation.owner.publicKey` in the trusted installation file — never an
environment variable.

## 1. Generate or derive the key

Generate a new keypair:

```text
fleet-v2 coordination owner-key init --out <path>
```

The command writes the PKCS#8 PEM private key to `<path>` (a new file, mode
`0600`, created atomically and refused if the file already exists) and prints
two lines to stdout: the canonical base64 encoding of the 32-byte raw public
key, and the exact `owner` section edit for the installation file. The private
key is never printed, logged, or returned anywhere.

Derive the public key from an existing Ed25519 private key instead:

```text
fleet-v2 coordination owner-key public --key <path>
```

This prints only the public key. The key file must be a regular file, mode
`0600` or `0400`, owned by the running user, not a symlink, and at most 16384
bytes; anything else is refused with exit 1.

## 2. Pin the public key in the trusted installation file

Edit the trusted installation file directly — no `hosts` or `policy`
subcommand writes the `owner` section. The file must live outside every git
checkout or worktree, for example `~/.config/fleet-v2/fleet.json` (`0600` in a
`0700` directory), pointed to by `FLEET_INSTALLATION_FILE` in the CLI shell
profile and the systemd user `EnvironmentFile` drop-in (KEY0a). Merge the
printed edit:

```json
{ "owner": { "publicKey": "<canonical base64 of the 32-byte raw public key>" } }
```

If the file also carries `waves.ownerPublicKey`, it must equal
`owner.publicKey` or the file is refused. Never paste a raw Ed25519 *seed*
into `owner.publicKey`: a seed is also 32 bytes and the parser cannot tell
them apart.

## 3. Key file location and permissions

Keep the private key file:

- outside `--state-dir` / `FLEET_STATE_DIR` — the `init` command refuses any
  output path inside the state directory, directly or through a symlinked
  parent;
- outside any git repository or worktree (any `.git` entry on the path, file
  or directory, direct or through a symlinked parent) — `init` refuses those
  too;
- at mode `0600`, owned by the running user;
- in a parent directory that is owned by you and not writable by group or
  others (`0700` recommended) — `init` refuses a parent that is group- or
  world-writable or owned by another user. `~/.config/fleet-v2` qualifies.

These checks protect the key only against other *users* on the host: every
process running as the same user — including any local agent the user starts —
can read the key regardless of its mode. The follow-up is to run local agents
under a separate system user, so the key file is not readable by them.

## 4. Sign a decision

Sign a pending one-way decision with the key:

```text
fleet-v2 coordination sign-decision --request <id> --answer yes --key <path> --yes
```

(KEY1a.) For the standing shadow import grant, pre-sign before
`request-decision`:

```text
fleet-v2 coordination sign-decision --pre-sign --action-scope merge:import-shadow --repository <owner>/<repo> --project <id> --expires-at <iso> --key <path> --yes
```

(KEY1c.) Use the identical `--expires-at` string that the matching
`request-decision` will carry: the pre-signature is bound to the grant's
derived request id, and a different expiry derives a different id.

## 5. Rotate the key

1. Generate a new keypair with `owner-key init --out <new path>` — outside the
   state directory and every git repo/worktree, as above.
2. Replace `owner.publicKey` in the trusted installation file with the new
   public key (and fix `waves.ownerPublicKey` to match, or remove it).
3. Restart the API and the daemon so every consumer re-pins the new key.
4. Destroy the old private key file — never archive it. Pending decisions
   signed under the old key fail verification and must be re-requested.

Rotation is a file edit plus a restart, not a command.

## 6. If the key is lost

A pending one-way decision cannot be signed with a lost key: there is no
recovery from the public key, and the pinned `owner.publicKey` will not accept
any signature the lost key would have produced. Generate a new keypair
(`owner-key init`), replace `owner.publicKey` in the trusted installation
file, restart the API and the daemon so every consumer re-pins, and
re-request and re-sign the affected decisions under the new key.

## Not this runbook

Printing or archiving private key material, pinning a key from inside a git
checkout, or treating a refused `owner-key` result as a partial success: every
refusal exits 1. A refusal raised before the key file was created changes
nothing on disk. A refusal raised after the file was created removes it when
its identity can be verified against the write (the dev/ino guard); when that
cannot be proven, the refusal names the leftover path instead, which the owner
should inspect and delete by hand.
