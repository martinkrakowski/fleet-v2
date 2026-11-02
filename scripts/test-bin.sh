#!/bin/sh
# Runs every tests/*.test.sh via `sh`, in sorted order, stopping at the first
# failure with that test's exit code. Exits 1 when no test file matches.
# Run from the repository root or anywhere.
#
#   sh scripts/test-bin.sh                  every test file (unchanged behaviour)
#   sh scripts/test-bin.sh --shard <i>/<n>  only shard i of n (1 <= i <= n): the
#                                           files sorted bytewise (LC_ALL=C),
#                                           then balanced across the n shards by
#                                           the recorded per-file times in
#                                           scripts/test-bin-timings.txt (a
#                                           greedy split: longest first, ties
#                                           bytewise, each file to the shard
#                                           with the smallest total so far), so
#                                           each file runs in exactly one shard
#                                           of the n; a file absent from the
#                                           timings table counts as 60 seconds
#   sh scripts/test-bin.sh --shard <i>/<n> --list
#                                           print that shard's files, run nothing
#
# The runner script pin checks run in every shard (they take milliseconds), so no
# shard passes with a broken pin. A shard that selects no file exits 1, so a
# matrix wider than the test list fails loudly. A usage error exits 2.
set -eu

usage() {
  echo "usage: sh scripts/test-bin.sh [--shard <i>/<n> [--list]]" >&2
  exit 2
}

shard_i=1
shard_n=1
sharded=0
list_only=0
while [ "$#" -gt 0 ]; do
  case $1 in
    --shard)
      [ "$#" -ge 2 ] || usage
      spec=$2
      shift 2
      ;;
    --shard=*)
      spec=${1#--shard=}
      shift
      ;;
    --list)
      list_only=1
      shift
      continue
      ;;
    *)
      usage
      ;;
  esac
  [ "$sharded" = 0 ] || usage
  case $spec in
    */*) ;;
    *) usage ;;
  esac
  shard_i=${spec%%/*}
  shard_n=${spec#*/}
  case $shard_i in '' | *[!0-9]*) usage ;; *) ;; esac
  case $shard_n in '' | *[!0-9]*) usage ;; *) ;; esac
  # Reject leading zeros so "01/4" and "1/04" are not silently accepted, and keep the
  # numbers small enough for sh arithmetic.
  case $shard_i in 0?*) usage ;; *) ;; esac
  case $shard_n in 0?*) usage ;; *) ;; esac
  [ "${#shard_i}" -le 4 ] && [ "${#shard_n}" -le 4 ] || usage
  [ "$shard_n" -ge 1 ] && [ "$shard_i" -ge 1 ] && [ "$shard_i" -le "$shard_n" ] || usage
  sharded=1
done
[ "$list_only" = 0 ] || [ "$sharded" = 1 ] || usage

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# --- runner script pins (M2): the bundled bin/ocm-run and bin/agy-run must
# --- match the hashes in scripts/*-hash.txt, or an unpinned runner ships and
# --- the onboarding doctor reports hash FAIL on every installation. The shape
# --- is the bootstrap suite's pin check: sha256 of the script compared with the
# --- first field of its hash file, and the hash file names the script.
check_pin() { # $1: script path, $2: hash file path
  script=$1
  pinfile=$2
  [ -f "$root/$pinfile" ] || { echo "test-bin: missing pin file $pinfile" >&2; return 1; }
  sum=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$root/$script" || shasum -a 256 "$root/$script") | cut -c1-64 )
  read -r want pinjunk < "$root/$pinfile" || true
  if [ -z "$want" ] || [ "$sum" != "$want" ]; then
    echo "test-bin: pin FAIL for $script (got ${sum:-<none>}, want ${want:-<empty>})" >&2
    return 1
  fi
  # The pin line's path field must be exactly the script, not merely contain it (Grok review of L2).
  awk -v f="$script" '$2 == f { found = 1 } END { exit !found }' "$root/$pinfile" || { echo "test-bin: pin file $pinfile does not name $script" >&2; return 1; }
  echo "test-bin: pin ok $script"
  return 0
}
if [ "$list_only" = 0 ]; then
  check_pin bin/ocm-run scripts/ocm-run-hash.txt
  check_pin bin/agy-run scripts/agy-run-hash.txt
  check_pin bin/gate-slot scripts/gate-slot-hash.txt
fi

# The test files, one per line. Unsharded: the glob's own order, as before. Sharded:
# sorted bytewise, so every shard of one run computes the same list on any locale.
files=$(for t in tests/*.test.sh; do
  if [ ! -e "$t" ]; then
    exit 0
  fi
  printf '%s\n' "$t"
done)
if [ -z "$files" ]; then
  echo "test-bin: no tests/*.test.sh found under $root/tests" >&2
  exit 1
fi
# Newlines separate entries; a blank inside a name would split it into two words.
if printf '%s\n' "$files" | grep -q '[[:blank:]]'; then
  echo "test-bin: a test file name contains whitespace" >&2
  exit 1
fi
if [ "$sharded" = 1 ]; then
  files=$(printf '%s\n' "$files" | LC_ALL=C sort)
fi

# --- shard assignment (CI1): balanced by recorded per-file times. The timings
# --- file is data, one `path linux-seconds macos-seconds` row per test file,
# --- with `#` comments and blank lines; FLEET_TEST_BIN_TIMINGS overrides its
# --- path so tests can point the reader at a temp file, and a missing file
# --- means every duration is unknown, never an error. The assignment is the
# --- pure greedy step below: files in descending Linux duration (ties bytewise
# --- ascending), each to the shard with the smallest total so far, ties to the
# --- lowest shard number; an unknown file falls back to 60 seconds.
timings_file=${FLEET_TEST_BIN_TIMINGS:-$root/scripts/test-bin-timings.txt}

assign_shards() {
  printf '%s\n' "$files" | awk -v timings="$timings_file" -v n="$shard_n" -v i_shard="$shard_i" '
    BEGIN {
      while ((getline line < timings) > 0) {
        sub(/\r$/, "", line)
        if (line ~ /^[ \t]*(#|$)/) continue
        split(line, row, " ")
        if (row[1] != "") linux_sec[row[1]] = row[2] + 0
      }
      close(timings)
    }
    { files[++fc] = $0 }
    function earlier(a, b) {
      if (ldur[a] != ldur[b]) return ldur[a] > ldur[b]
      return files[a] < files[b]
    }
    END {
      for (k = 1; k <= fc; k++) {
        ldur[k] = (files[k] in linux_sec) ? linux_sec[files[k]] : 60
        order[k] = k
      }
      for (k = 1; k <= fc; k++) {
        for (j = k + 1; j <= fc; j++) {
          if (earlier(order[j], order[k])) {
            tmp = order[k]; order[k] = order[j]; order[j] = tmp
          }
        }
      }
      for (k = 1; k <= fc; k++) {
        idx = order[k]
        best = 1
        for (s = 2; s <= n; s++) if (load[s] + 0 < load[best] + 0) best = s
        load[best] += ldur[idx]
        assign[files[idx]] = best
      }
      for (k = 1; k <= fc; k++) if (assign[files[k]] == i_shard) print files[k]
    }
  '
}

selected=""
index=0
if [ "$sharded" = 1 ]; then
  selected=$(assign_shards)
else
  selected=$files
fi
for t in $files; do
  index=$((index + 1))
done
if [ -z "$selected" ]; then
  echo "test-bin: shard $shard_i/$shard_n selects no test file ($index file(s) in total)" >&2
  exit 1
fi

if [ "$list_only" = 1 ]; then
  for t in $selected; do
    printf '%s\n' "$t"
  done
  exit 0
fi

count=0
for t in $selected; do
  echo "== $t"
  status=0
  sh "$t" || status=$?
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  count=$((count + 1))
done

if [ "$sharded" = 1 ]; then
  echo "test-bin: shard $shard_i/$shard_n: $count of $index test file(s) passed"
else
  echo "test-bin: $count test file(s) passed"
fi
