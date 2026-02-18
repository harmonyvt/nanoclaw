#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

required_files=(
  "00-index.md"
  "01-current-nanoclaw-boundaries.md"
  "02-daytona-patterns.md"
  "03-oss-sandbox-comparison.md"
  "04-hardening-control-matrix.md"
  "05-academic-findings-2020-2026.md"
  "06-claim-validation-ledger.md"
)

for f in "${required_files[@]}"; do
  path="$ROOT_DIR/$f"
  grep -q "Last verified: 2026-02-18" "$path"
  grep -q "Confidence:" "$path"
  grep -Eq "\[Direct evidence\]|\[Inference\]" "$path"
done

jq -e 'all(.[]; has("id") and has("title") and has("url") and has("source_type") and has("retrieved_at") and has("used_in_files") and has("evidence_strength"))' "$ROOT_DIR/sources.json" >/dev/null

jq -r '.[] | select(.url|startswith("http")) | .url' "$ROOT_DIR/sources.json" | while read -r url; do
  code=$(curl -L -s -o /dev/null -w '%{http_code}' "$url")
  if [[ "$code" != "200" ]]; then
    echo "URL check failed: $url (HTTP $code)" >&2
    exit 1
  fi
done

echo "research validation passed"
