#!/bin/sh
# Tests for scripts/check-public-safety.mjs (OG-18). Each case builds a fresh
# temp git repo, plants a public-safety list (outside the repo unless the case
# says otherwise) and tracked fixtures, and checks the match, skip and refusal
# rules. No output may ever name a list entry, its pattern or matched text.
# Skips (exit 0) when node is missing.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$here/scripts/check-public-safety.mjs
if ! command -v node >/dev/null 2>&1; then
  echo 'skip check-public-safety tests: node is not installed'
  exit 0
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/check-public-safety-test.XXXXXX") || exit 1
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
finish() { rm -rf "$T"; }
trap finish EXIT

new_repo() { # $1 = directory: a fresh repo with one committed clean file
  mkdir -p "$1/src"
  (
    cd "$1" &&
      git init -q &&
      git config user.name 'Test' &&
      git config user.email 'test@example.invalid' &&
      printf 'hello\n' >src/plain.txt &&
      git add -A &&
      git commit -qm base
  )
}

track() { # $1 = repo, $2 = message: commit everything in the working tree
  git -C "$1" add -A >/dev/null &&
    git -C "$1" commit -qm "$2" >/dev/null
}

check() { # remaining args = script args; sets rc, stdout, stderr
  out_file=$T/check.out
  err_file=$T/check.err
  (
    unset FLEET_PUBLIC_SAFETY_LIST
    node "$SCRIPT" "$@"
  ) >"$out_file" 2>"$err_file"
  rc=$?
  stdout=$(cat "$out_file")
  stderr=$(cat "$err_file")
}

check_t() { # like check, but bounded: an attempted read of a FIFO hangs and times out (rc 124)
  out_file=$T/check.out
  err_file=$T/check.err
  (
    unset FLEET_PUBLIC_SAFETY_LIST
    timeout 10 node "$SCRIPT" "$@"
  ) >"$out_file" 2>"$err_file"
  rc=$?
  stdout=$(cat "$out_file")
  stderr=$(cat "$err_file")
}

check_env() { # $1 = list path, remaining args = script args; sets rc, stdout, stderr
  list_env=$1
  shift
  out_file=$T/check.out
  err_file=$T/check.err
  (
    unset FLEET_PUBLIC_SAFETY_LIST
    FLEET_PUBLIC_SAFETY_LIST=$list_env node "$SCRIPT" "$@"
  ) >"$out_file" 2>"$err_file"
  rc=$?
  stdout=$(cat "$out_file")
  stderr=$(cat "$err_file")
}

clean_stderr() { # $1 = stderr stream to inspect
  case $1 in
  *TypeError*) bad 'stderr has no TypeError' ;;
  *'    at '*) bad 'stderr has no stack trace' ;;
  *) ok 'stderr has no TypeError or stack trace' ;;
  esac
}

finding_format() { # $1 = stream to inspect
  if printf '%s\n' "$1" |
    grep -Eq '^check-public-safety: .+:[0-9]+ entry #[0-9]+$'; then
    ok 'stdout has the finding line format'
  else
    bad 'stdout has the finding line format'
  fi
}

no_leak() { # $1 = stream, $2 = secret text: the stream must not name it
  case $1 in
  *"$2"*) bad "no output names the entry or matched text ($2)" ;;
  *) ok "no output names the entry or matched text ($2)" ;;
  esac
}

# --- a clean tree passes with the exact ok line.
R=$T/clean
new_repo "$R"
printf 'supersecrettoken\n' >"$T/clean.list"
check --root "$R" --list "$T/clean.list"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: ok, 1 files, 1 entries' ]; then
  ok 'a clean tree passes with the ok line'
else
  bad "a clean tree passes with the ok line (rc $rc: $stdout $stderr)"
fi
clean_stderr "$stderr"

# --- a literal substring match fails and never names the entry or the line.
R=$T/literal
new_repo "$R"
printf 'supersecrettoken\n' >"$T/lit.list"
printf 'token=supersecrettoken here\n' >"$R/src/a.txt"
track "$R" leak
check --root "$R" --list "$T/lit.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/a.txt:1 entry #1' ]; then
  ok 'a literal match fails with the finding line'
else
  bad "a literal match fails with the finding line (rc $rc: $stdout $stderr)"
fi
finding_format "$stdout"
no_leak "$stdout" 'supersecrettoken'
no_leak "$stdout" 'token='
no_leak "$stderr" 'supersecrettoken'
clean_stderr "$stderr"

# --- a literal entry matches case-insensitively.
R=$T/case
new_repo "$R"
printf 'supersecrettoken\n' >"$T/case.list"
printf 'SuperSecretToken in the middle\n' >"$R/src/a.txt"
track "$R" leak
check --root "$R" --list "$T/case.list"
if [ $rc -eq 1 ] && printf '%s\n' "$stdout" | grep -q 'check-public-safety: src/a.txt:1 entry #1'; then
  ok 'a literal entry matches case-insensitively'
else
  bad "a literal entry matches case-insensitively (rc $rc: $stdout $stderr)"
fi
no_leak "$stdout" 'SuperSecretToken'
no_leak "$stdout" 'supersecrettoken'

# --- a re: entry matches and never prints the pattern or matched text.
R=$T/regex
new_repo "$R"
printf 're:sk-[0-9]{4}\n' >"$T/re.list"
printf 'key sk-1234 end\n' >"$R/src/a.txt"
track "$R" leak
check --root "$R" --list "$T/re.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/a.txt:1 entry #1' ]; then
  ok 'a re: entry matches with the finding line'
else
  bad "a re: entry matches with the finding line (rc $rc: $stdout $stderr)"
fi
no_leak "$stdout" 'sk-[0-9]'
no_leak "$stdout" 'sk-1234'
no_leak "$stdout" 'key '
no_leak "$stderr" 'sk-[0-9]'
clean_stderr "$stderr"

# --- comments and blank lines are ignored; numbering counts active entries.
R=$T/numbering
new_repo "$R"
printf '# heading comment\n\nfirstneedle\n\n# another comment\nre:second-[0-9]+\n' \
  >"$T/num.list"
printf 'value second-99 here\n' >"$R/src/a.txt"
printf 'heading word\n' >"$R/src/b.txt"
track "$R" leak
check --root "$R" --list "$T/num.list"
if [ $rc -eq 1 ] &&
  [ "$stdout" = 'check-public-safety: src/a.txt:1 entry #2' ]; then
  ok 'comments and blank lines are ignored and entries keep their numbers'
else
  bad "comments and blank lines are ignored and entries keep their numbers (rc $rc: $stdout $stderr)"
fi
no_leak "$stdout" 'second-99'
no_leak "$stdout" 'second-[0-9]'
no_leak "$stdout" 'firstneedle'
clean_stderr "$stderr"

# --- a binary file (NUL in the first 8 KiB) is skipped.
R=$T/binary
new_repo "$R"
printf 'supersecrettoken\n' >"$T/bin.list"
printf 'supersecrettoken\n' >"$R/src/bin.dat"
printf 'x' | tr 'x' '\000' >>"$R/src/bin.dat"
track "$R" leak
check --root "$R" --list "$T/bin.list"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: ok, 1 files, 1 entries' ]; then
  ok 'a binary file is skipped'
else
  bad "a binary file is skipped (rc $rc: $stdout $stderr)"
fi
case $stderr in
*'skipped 1 binary file'*) ok 'a skipped binary file is counted on stderr, not silent' ;;
*) bad "a skipped binary file is counted on stderr, not silent ($stderr)" ;;
esac

# --- an oversized file (> 1 MiB) is scanned, never skipped.
R=$T/oversized
new_repo "$R"
printf 'supersecrettoken\n' >"$T/big.list"
{
  printf 'supersecrettoken\n'
  yes x | head -c 1048577
} >"$R/src/big.txt"
track "$R" leak
check --root "$R" --list "$T/big.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/big.txt:1 entry #1' ]; then
  ok 'an oversized file is scanned'
else
  bad "an oversized file is scanned (rc $rc: $stdout $stderr)"
fi
no_leak "$stdout" 'supersecrettoken'
clean_stderr "$stderr"

# --- a needle after the first read chunk is found with the right line number.
R=$T/late
new_repo "$R"
printf 'supersecrettoken\n' >"$T/late.list"
{
  yes x | head -c 70000
  printf 'supersecrettoken\n'
} >"$R/src/late.txt"
track "$R" leak
check --root "$R" --list "$T/late.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/late.txt:35001 entry #1' ]; then
  ok 'a needle after the first chunk is found with its line number'
else
  bad "a needle after the first chunk is found with its line number (rc $rc: $stdout $stderr)"
fi

# --- a needle spanning the 64 KiB chunk boundary is found.
R=$T/span
new_repo "$R"
printf 'supersecrettoken\n' >"$T/span.list"
{
  head -c 65529 /dev/zero | tr '\000' a
  printf '\n'
  printf 'xxsupersecrettoken\n'
} >"$R/src/span.txt"
track "$R" leak
check --root "$R" --list "$T/span.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/span.txt:2 entry #1' ]; then
  ok 'a needle spanning a chunk boundary is found'
else
  bad "a needle spanning a chunk boundary is found (rc $rc: $stdout $stderr)"
fi

# --- CRLF line endings: the right line number, and a $-anchored regex still matches.
R=$T/crlf
new_repo "$R"
printf 're:^supersecrettoken$\n' >"$T/crlf.list"
printf 'one\r\ntwo\r\nsupersecrettoken\r\nfour\r\n' >"$R/src/crlf.txt"
track "$R" leak
check --root "$R" --list "$T/crlf.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/crlf.txt:3 entry #1' ]; then
  ok 'CRLF lines report the correct line number'
else
  bad "CRLF lines report the correct line number (rc $rc: $stdout $stderr)"
fi

# --- tracked path names are matched: file name, directory component, symlink name.
printf 'forbiddenname\n' >"$T/path.list"
R=$T/pathfile
new_repo "$R"
printf 'clean\n' >"$R/src/forbiddenname.txt"
track "$R" pathfile
check --root "$R" --list "$T/path.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/forbiddenname.txt:0 entry #1' ]; then
  ok 'a private name in a tracked file name is a finding'
else
  bad "a private name in a tracked file name is a finding (rc $rc: $stdout $stderr)"
fi
R=$T/pathdir
new_repo "$R"
mkdir -p "$R/forbiddenname"
printf 'clean\n' >"$R/forbiddenname/ok.txt"
track "$R" pathdir
check --root "$R" --list "$T/path.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: forbiddenname/ok.txt:0 entry #1' ]; then
  ok 'a private name in a directory component is a finding'
else
  bad "a private name in a directory component is a finding (rc $rc: $stdout $stderr)"
fi
R=$T/pathlink
new_repo "$R"
ln -s plain.txt "$R/src/forbiddenname"
track "$R" pathlink
check --root "$R" --list "$T/path.list"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/forbiddenname:0 entry #1' ]; then
  ok 'a private name in a symlink own name is a finding'
else
  bad "a private name in a symlink own name is a finding (rc $rc: $stdout $stderr)"
fi

# --- a tracked file missing from the working tree is refused, not skipped.
R=$T/gone
new_repo "$R"
printf 'supersecrettoken\n' >"$T/gone.list"
printf 'clean\n' >"$R/src/gone.txt"
track "$R" gone
rm "$R/src/gone.txt"
check --root "$R" --list "$T/gone.list"
if [ $rc -eq 2 ] && [ -z "$stdout" ] &&
  case $stderr in *'src/gone.txt'*) true ;; *) false ;; esac; then
  ok 'a tracked file missing from the working tree is refused naming the path'
else
  bad "a tracked file missing from the working tree is refused naming the path (rc $rc: $stdout $stderr)"
fi

# --- a tracked list file inside the repository never scans itself.
R=$T/selfscan
new_repo "$R"
printf 'supersecrettoken\n' >"$R/.public-safety-list"
track "$R" list
check --root "$R" --list "$R/.public-safety-list"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: ok, 1 files, 1 entries' ]; then
  ok 'a tracked list file inside the repo does not flag itself'
else
  bad "a tracked list file inside the repo does not flag itself (rc $rc: $stdout $stderr)"
fi

# --- an untracked file is never scanned.
R=$T/untracked
new_repo "$R"
printf 'supersecrettoken\n' >"$T/un.list"
printf 'supersecrettoken\n' >"$R/src/untracked.txt"
check --root "$R" --list "$T/un.list"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: ok, 1 files, 1 entries' ]; then
  ok 'an untracked file is not scanned'
else
  bad "an untracked file is not scanned (rc $rc: $stdout $stderr)"
fi

# --- no list configured and no --require-list: explicit no-op, exit 0.
check
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: no list configured, nothing checked' ]; then
  ok 'no list configured without --require-list is an explicit no-op'
else
  bad "no list configured without --require-list is an explicit no-op (rc $rc: $stdout $stderr)"
fi
case $stderr in
*'NO LIST CONFIGURED, NOTHING WAS CHECKED'*) ok 'no list prints an unmistakable stderr warning' ;;
*) bad "no list prints an unmistakable stderr warning ($stderr)" ;;
esac
clean_stderr "$stderr"

# --- no list configured with --require-list: exit 2.
check --require-list
if [ $rc -eq 2 ] && [ -n "$stderr" ] && [ -z "$stdout" ]; then
  ok '--require-list without a list is refused'
else
  bad "--require-list without a list is refused (rc $rc: $stdout $stderr)"
fi

# --- the list can come from FLEET_PUBLIC_SAFETY_LIST.
R=$T/env
new_repo "$R"
printf 'supersecrettoken\n' >"$T/env.list"
printf 'value supersecrettoken\n' >"$R/src/a.txt"
track "$R" leak
check_env "$T/env.list" --root "$R"
if [ $rc -eq 1 ] && [ "$stdout" = 'check-public-safety: src/a.txt:1 entry #1' ]; then
  ok 'the list resolves from FLEET_PUBLIC_SAFETY_LIST'
else
  bad "the list resolves from FLEET_PUBLIC_SAFETY_LIST (rc $rc: $stdout $stderr)"
fi
check_env "$T/missing-env.list" --root "$R"
if [ $rc -eq 2 ] && case $stderr in *'missing-env.list'*) true ;; *) false ;; esac; then
  ok 'a missing FLEET_PUBLIC_SAFETY_LIST file is refused naming the path'
else
  bad "a missing FLEET_PUBLIC_SAFETY_LIST file is refused naming the path (rc $rc: $stdout $stderr)"
fi
clean_stderr "$stderr"

# --- a missing list file is refused naming the path, never the contents.
R=$T/missing
new_repo "$R"
check --root "$R" --list "$T/does-not-exist.list"
if [ $rc -eq 2 ] &&
  case $stderr in *'does-not-exist.list'*) true ;; *) false ;; esac &&
  [ -z "$stdout" ]; then
  ok 'a missing list file is refused naming the path'
else
  bad "a missing list file is refused naming the path (rc $rc: $stdout $stderr)"
fi
clean_stderr "$stderr"

# --- an invalid or empty re: entry is refused naming the entry number only.
R=$T/badre
new_repo "$R"
printf 're:[unclosed\n' >"$T/badre.list"
check --root "$R" --list "$T/badre.list"
if [ $rc -eq 2 ] &&
  case $stderr in *'entry #1'*) true ;; *) false ;; esac &&
  [ -z "$stdout" ]; then
  ok 'an invalid re: entry is refused naming entry #1'
else
  bad "an invalid re: entry is refused naming entry #1 (rc $rc: $stdout $stderr)"
fi
no_leak "$stderr" '[unclosed'
clean_stderr "$stderr"
printf 're:\n' >"$T/emptyre.list"
check --root "$R" --list "$T/emptyre.list"
if [ $rc -eq 2 ] &&
  case $stderr in *'entry #1'*) true ;; *) false ;; esac &&
  [ -z "$stdout" ]; then
  ok 'an empty re: entry is refused naming entry #1'
else
  bad "an empty re: entry is refused naming entry #1 (rc $rc: $stdout $stderr)"
fi
clean_stderr "$stderr"

# --- usage errors exit 2.
R=$T/usage
new_repo "$R"
printf 'supersecrettoken\n' >"$T/usage.list"
check --bogus
if [ $rc -eq 2 ] && [ -n "$stderr" ] && [ -z "$stdout" ]; then
  ok 'an unknown flag is a usage error'
else
  bad "an unknown flag is a usage error (rc $rc: $stdout $stderr)"
fi
check --root
if [ $rc -eq 2 ] && [ -n "$stderr" ]; then
  ok 'a missing --root value is a usage error'
else
  bad "a missing --root value is a usage error (rc $rc: $stdout $stderr)"
fi
check --list
if [ $rc -eq 2 ] && [ -n "$stderr" ]; then
  ok 'a missing --list value is a usage error'
else
  bad "a missing --list value is a usage error (rc $rc: $stdout $stderr)"
fi
mkdir -p "$T/notarepo"
check --root "$T/notarepo" --list "$T/usage.list"
if [ $rc -eq 2 ] && [ -n "$stderr" ] && [ -z "$stdout" ]; then
  ok 'a --root that is not a git worktree is refused'
else
  bad "a --root that is not a git worktree is refused (rc $rc: $stdout $stderr)"
fi
case $stderr in
*'git rev-parse failed under'*) ok 'a non-git --root reports the failed git command' ;;
*) bad "a non-git --root reports the failed git command ($stderr)" ;;
esac
clean_stderr "$stderr"

# Shared assertion: exit 2, stderr names the path, stdout empty, no secret printed.
expect_refused() { # $1 = title, $2 = path that must be named
  if [ $rc -eq 2 ] && [ -z "$stdout" ] &&
    case $stderr in *"$2"*) true ;; *) false ;; esac; then
    ok "$1"
  else
    bad "$1 (rc $rc: $stdout $stderr)"
  fi
  no_leak "$stdout$stderr" 'supersecrettoken'
}

# --- a symlink pointing outside the repository is refused and never read.
R=$T/link
new_repo "$R"
printf 'supersecrettoken\n' >"$T/link.list"
mkfifo "$T/outside.txt"
ln -s "$T/outside.txt" "$R/src/link"
track "$R" link
check_t --root "$R" --list "$T/link.list"
expect_refused 'a tracked symlink to a file outside the repository is refused, not read' 'src/link'

# --- a parent directory replaced by a symlink is refused before any open (the external regular file holds the needle: a read would exit 1).
R=$T/parentlink
new_repo "$R"
printf 'supersecrettoken\n' >"$T/parentlink.list"
printf 'clean\n' >"$R/src/file.txt"
track "$R" file
rm -rf "$R/src"
mkdir -p "$T/ext1"
printf 'supersecrettoken\n' >"$T/ext1/file.txt"
ln -s "$T/ext1" "$R/src"
check_t --root "$R" --list "$T/parentlink.list"
expect_refused 'a tracked file under a parent replaced by a symlink is refused, never opened' 'src/file.txt'

# --- a deeper ancestor replaced by a symlink is refused too.
R=$T/deeplink
new_repo "$R"
printf 'supersecrettoken\n' >"$T/deeplink.list"
mkdir -p "$R/src/a/b"
printf 'clean\n' >"$R/src/a/b/file.txt"
track "$R" deep
rm -rf "$R/src/a"
mkdir -p "$T/ext2/b"
printf 'supersecrettoken\n' >"$T/ext2/b/file.txt"
ln -s "$T/ext2" "$R/src/a"
check_t --root "$R" --list "$T/deeplink.list"
expect_refused 'a tracked file under a deeper ancestor replaced by a symlink is refused, never opened' 'src/a/b/file.txt'

# --- a dangling tracked symlink is refused naming the path, even when its text matches.
R=$T/dangling
new_repo "$R"
printf 'supersecrettoken\n' >"$T/dangling.list"
ln -s ../../outside/forbidden-supersecrettoken "$R/src/dangling"
track "$R" dangling
check --root "$R" --list "$T/dangling.list"
expect_refused 'a dangling tracked symlink is refused naming the path' 'src/dangling'

# --- a symlink loop is refused.
R=$T/loop
new_repo "$R"
printf 'supersecrettoken\n' >"$T/loop.list"
ln -s b "$R/src/a"
ln -s a "$R/src/b"
track "$R" loop
check --root "$R" --list "$T/loop.list"
expect_refused 'a tracked symlink loop is refused naming the path' 'src/a'

# --- a symlink to a directory is refused.
R=$T/dirlink
new_repo "$R"
printf 'supersecrettoken\n' >"$T/dirlink.list"
ln -s . "$R/src/dirlink"
track "$R" dirlink
check --root "$R" --list "$T/dirlink.list"
expect_refused 'a tracked symlink to a directory is refused naming the path' 'src/dirlink'

# --- a symlink to a file outside the repository is refused because it is outside, even when that file is the list.
R=$T/listlink
new_repo "$R"
printf 'supersecrettoken\n' >"$T/listlink.list"
ln -s "$T/listlink.list" "$R/src/listlink"
track "$R" listlink
check --root "$R" --list "$T/listlink.list"
expect_refused 'a tracked symlink to an outside-repo file (the list) is refused because it leaves the repository' 'src/listlink'

# --- a symlink to an in-repo list file is scanned as a link, never skipped as the list.
R=$T/listlink2
new_repo "$R"
printf 'supersecrettoken\n' >"$R/.public-safety-list"
ln -s ../.public-safety-list "$R/src/listalias"
track "$R" listalias
check --root "$R" --list "$R/.public-safety-list"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: ok, 2 files, 1 entries' ]; then
  ok 'a tracked symlink to the in-repo list is scanned as a link, not skipped as the list'
else
  bad "a tracked symlink to the in-repo list is scanned as a link, not skipped as the list (rc $rc: $stdout $stderr)"
fi

# --- a gitlink (submodule) entry is refused naming the path.
R=$T/sub
new_repo "$R"
printf 'supersecrettoken\n' >"$T/sub.list"
mkdir -p "$R/vendor/mod"
(
  cd "$R/vendor/mod" && git init -q && git config user.name T &&
    git config user.email t@example.invalid && printf 'x\n' >f &&
    git add f && git commit -qm m
)
git -C "$R" add vendor/mod >/dev/null 2>&1
git -C "$R" commit -qm gitlink >/dev/null
check --root "$R" --list "$T/sub.list"
expect_refused 'a tracked submodule entry is refused naming the path' 'vendor/mod'

# --- an in-repo symlink to a regular file is accepted and scanned by its link text only.
R=$T/inrepo
new_repo "$R"
printf 'supersecrettoken\n' >"$T/inrepo.list"
ln -s plain.txt "$R/src/alias"
track "$R" alias
check --root "$R" --list "$T/inrepo.list"
if [ $rc -eq 0 ] && [ "$stdout" = 'check-public-safety: ok, 2 files, 1 entries' ]; then
  ok 'an in-repo symlink to a regular file is accepted'
else
  bad "an in-repo symlink to a regular file is accepted (rc $rc: $stdout $stderr)"
fi
clean_stderr "$stderr"

# --- an in-repo symlink whose link text matches is reported.
R=$T/linktext
new_repo "$R"
printf 'supersecrettoken\n' >"$T/linktext.list"
printf 'x\n' >"$R/src/forbidden-supersecrettoken"
ln -s forbidden-supersecrettoken "$R/src/link"
track "$R" linktext
check --root "$R" --list "$T/linktext.list"
# The target's own path name matches too (line 0); the link-text hit is line 1.
if [ $rc -eq 1 ] && printf '%s\n' "$stdout" | grep -qx 'check-public-safety: src/link:1 entry #1'; then
  ok 'an in-repo symlink matching by its link text is reported'
else
  bad "an in-repo symlink matching by its link text is reported (rc $rc: $stdout $stderr)"
fi
clean_stderr "$stderr"

# --- an unreadable tracked file is refused naming the path.
R=$T/noaccess
new_repo "$R"
printf 'supersecrettoken\n' >"$T/noaccess.list"
printf 'x\n' >"$R/src/locked.txt"
track "$R" locked
if [ "$(id -u)" = 0 ]; then
  ok 'an unreadable tracked file is refused (skipped: running as root)'
else
  chmod 000 "$R/src/locked.txt"
  check --root "$R" --list "$T/noaccess.list"
  chmod 600 "$R/src/locked.txt"
  if [ $rc -eq 2 ] &&
    case $stderr in *'src/locked.txt'*) true ;; *) false ;; esac &&
    [ -z "$stdout" ]; then
    ok 'an unreadable tracked file is refused naming the relative path'
  else
    bad "an unreadable tracked file is refused naming the relative path (rc $rc: $stdout $stderr)"
  fi
  clean_stderr "$stderr"
fi

[ "$fails" -eq 0 ] && echo 'check-public-safety: all tests passed' || echo "check-public-safety: $fails failure(s)"
[ "$fails" -eq 0 ]
