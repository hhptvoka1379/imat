#!/usr/bin/env bash
# One command: make sure there is a dataset, pack it, and put the blob where the site reads it.
#   tools/build_site.sh                      # synthetic 18k demo -> web/data/imat.bin
#   tools/build_site.sh path/to/your.csv     # your real table -> web/data/imat.bin
set -euo pipefail
cd "$(dirname "$0")/.."

CSV="${1:-data/imat-demo.csv}"
OUT="${2:-web/data/imat.bin}"
NQ="${NQ:-60}"
# IMAT 2026 sections, per the CINECA legend (General Knowledge / Logical Reasoning /
# Biology / Chemistry / Physics & Mathematics). Set SECTIONS="" to skip grouping in the UI.
SECTIONS="${SECTIONS:-General Knowledge=1-6,Logical Reasoning=7-19,Biology=20-37,Chemistry=38-50,Physics & Mathematics=51-60}"

PY="${PYTHON:-python3}"

if [ ! -f "$CSV" ]; then
  echo "· no $CSV — generating a synthetic stand-in (DEMO DATA, not real answers)"
  $PY tools/imat_fuzzy.py demo --rows 18000 --nq "$NQ" --out "$CSV"
fi

ARGS=(build --csv "$CSV" --out "$OUT")
[ -n "$SECTIONS" ] && ARGS+=(--sections "$SECTIONS")
[ -n "${ANSWER_COL:-}" ] && ARGS+=(--answers-col "$ANSWER_COL")
[ -n "${SEDE_COL:-}" ] && ARGS+=(--sede-col "$SEDE_COL")
[ -n "${KEY:-}" ] && ARGS+=(--key "$KEY")
[ -n "${NOTE:-}" ] && ARGS+=(--note "$NOTE")

$PY tools/imat_fuzzy.py "${ARGS[@]}"
$PY tools/imat_fuzzy.py info "$OUT" | sed -n '1,4p'

if [ "${RUN_TESTS:-1}" = "1" ]; then
  echo
  echo "· engine + parity tests"
  node web/tests/engine.test.js >/dev/null && echo "  ✓ engine (71)" || { echo "  ✗ engine"; exit 1; }
  node web/tests/parity.js >/dev/null 2>&1 && echo "  ✓ python/js parity (20)" || echo "  · parity skipped (needs python3 + node)"
fi

echo
echo "✔ ready.  preview:  cd web && python3 -m http.server 8080   → http://localhost:8080"
echo "  size: $(du -h "$OUT" | cut -f1) for $(wc -l < "$CSV") source rows"
