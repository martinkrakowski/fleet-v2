#!/bin/sh
# Tests that tests/seams.txt (the seam path list of production-quality plan
# §4.9, D3) stays truthful: every non-blank, non-comment line must name a path
# that exists under the repository root (a directory when it ends with "/", a
# file otherwise), entries must be repository-relative (no leading "/", no
# "..", no whitespace), the list must not repeat a line, and it holds at least
# one entry. The orchestrator's PR script reads this list, so a rotting path
# would silently exempt a seam PR from its review rule.
# Run it as `sh`, `dash` or `zsh tests/seams.test.sh`.
set -u
[ -n "${ZSH_VERSION:-}" ] && emulate sh
here=$(cd "$(dirname "$0")/.." && pwd)
fails=0
ok() { name=$1; printf 'ok   %s\n' "$name"; return 0; }
bad() { name=$1; printf 'FAIL %s\n' "$name"; fails=$((fails + 1)); return 0; }
check() { name=$1; expr=$2; if eval "$expr"; then ok "$name"; else bad "$name"; fi; return 0; }

list="$here/tests/seams.txt"
[ -r "$list" ] || { echo "seams: no readable $list" >&2; exit 1; }

# The list has at least one entry.
check "seams: list is not empty" '[ -s "$list" ]'

# Every entry is a single repository-relative path that exists today.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  check "seams: $line is repository-relative" 'case "$line" in /*|*..*|*[[:blank:]]*) false ;; *) true ;; esac'
  case "$line" in
    */) check "seams: $line exists" '[ -d "$here/$line" ]' ;;
    *) check "seams: $line exists" '[ -f "$here/$line" ]' ;;
  esac
done < "$list"

# No line repeats.
total=$(grep -v '^#' "$list" | grep -v '^$' | wc -l)
uniq=$(grep -v '^#' "$list" | grep -v '^$' | LC_ALL=C sort | LC_ALL=C uniq | wc -l)
check "seams: no line repeats" '[ "$uniq" = "$total" ]'

printf '\n'
if [ "$fails" -eq 0 ]; then printf '0 failed\n'; else printf '%d failed\n' "$fails"; exit 1; fi
