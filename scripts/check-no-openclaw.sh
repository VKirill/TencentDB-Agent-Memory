#!/usr/bin/env bash
# check-no-openclaw.sh
# Grep gate enforcing the v0.1 invariant: no "openclaw" or "hermes" references
# outside the whitelisted files.
#
# Scope: src/, .github/, package.json, tsdown.config.ts, root index.ts.
# Whitelist: scripts/openclaw-whitelist.txt (one path per line, # comments allowed).
#
# Exit 0 on clean. Exit 1 on any non-whitelisted hit. Prints offending hits.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WHITELIST_FILE="$REPO_ROOT/scripts/openclaw-whitelist.txt"

cd "$REPO_ROOT"

# Build whitelist set (strip comments + blanks)
declare -A WHITELIST
if [[ -f "$WHITELIST_FILE" ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"               # strip inline/full-line comments
    line="${line#"${line%%[![:space:]]*}"}"  # ltrim
    line="${line%"${line##*[![:space:]]}"}"  # rtrim
    [[ -z "$line" ]] && continue
    WHITELIST["$line"]=1
  done < "$WHITELIST_FILE"
fi

# Targets to scan. Skip non-existent ones silently (deletions in progress).
TARGETS=()
for t in src .github package.json tsdown.config.ts index.ts; do
  [[ -e "$t" ]] && TARGETS+=("$t")
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "check-no-openclaw: no scan targets present, treating as clean."
  exit 0
fi

# grep -E with case-insensitive match for openclaw|hermes. -r recursive, -n line numbers.
# Use a temp file because piping to while-read loses parent shell state.
HITS_FILE="$(mktemp)"
trap 'rm -f "$HITS_FILE"' EXIT

# --include filters only for dirs; for explicit files grep them directly.
grep -rniE "openclaw|hermes" "${TARGETS[@]}" \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=.git \
  --exclude="check-no-openclaw.sh" \
  --exclude="openclaw-whitelist.txt" \
  > "$HITS_FILE.raw" 2>/dev/null || true

# Strip self-references to gate-script filenames (legitimate self-mentions
# in package.json scripts, README, etc. — not actual openclaw code refs).
grep -v "scripts/check-no-openclaw\.sh\|scripts/openclaw-whitelist\.txt" \
  "$HITS_FILE.raw" > "$HITS_FILE" 2>/dev/null || true
rm -f "$HITS_FILE.raw"

OFFENDERS=0
while IFS= read -r hit; do
  # hit format: "path:lineno:content"
  path="${hit%%:*}"
  if [[ -z "${WHITELIST[$path]:-}" ]]; then
    if [[ $OFFENDERS -eq 0 ]]; then
      echo "❌ Non-whitelisted openclaw/hermes references found:"
      echo
    fi
    echo "  $hit"
    OFFENDERS=$((OFFENDERS + 1))
  fi
done < "$HITS_FILE"

if [[ $OFFENDERS -gt 0 ]]; then
  echo
  echo "Total offenders: $OFFENDERS"
  echo "Whitelist: $WHITELIST_FILE"
  exit 1
fi

echo "✅ No non-whitelisted openclaw/hermes references."
exit 0
