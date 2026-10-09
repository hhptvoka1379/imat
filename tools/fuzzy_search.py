#!/usr/bin/env python3
"""fuzzy_search.py — typo-tolerant search over the IMAT 2026 anonymous results.

Understands free text mixing seat names, bar codes and scores:

    python3 tools/fuzzy_search.py pavia 65.5
    python3 tools/fuzzy_search.py bologna
    python3 tools/fuzzy_search.py 5113 3555 7351        # bar code bits, typos ok
    python3 tools/fuzzy_search.py "sedi estere" 77.5

Or use explicit flags (also fuzzy):

    python3 tools/fuzzy_search.py --sede bicoca
    python3 tools/fuzzy_search.py --code 511315355735116
    python3 tools/fuzzy_search.py --sede torino --vector 4.5,6,32.6,18.7,12.3
    python3 tools/fuzzy_search.py --sede pavia --near 65.5

Ranking: every query token must match something on the row (seat name, bar
code, or one of the six scores). Tokens match fuzzily — prefixes, small
typos and out-of-order digit groups all work. Results are best-first.

Pure stdlib. Reads data/results.csv (rebuild it with tools/extract_results.py).
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "results.csv"

NUM_RE = re.compile(r"^[+-]?\d+(?:[.,]\d+)?$")


# ---------------------------------------------------------------- scoring --

def edit_distance(a: str, b: str, cap: int | None = None) -> int:
    """Classic Levenshtein, with optional early-exit cap."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if abs(la - lb) > (cap if cap is not None else 99):
        return 99
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        row_min = i
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            row_min = min(row_min, cur[j])
        if cap is not None and row_min > cap:
            return 99
        prev = cur
    return prev[lb]


def fuzzy_score(query: str, target: str) -> float:
    """0..1 likeness of query against target (smaller strings = the query)."""
    if not query or not target:
        return 0.0
    if query == target:
        return 1.0
    t = target.lower()
    if t.startswith(query) or query in t:
        return 0.85 + 0.15 * (len(query) / len(t))
    words = re.split(r"[\s,.\-\"'()]+", t)
    for w in words:
        if not w:
            continue
        if w.startswith(query):
            return 0.8
        d = edit_distance(query, w, cap=3)
        if d <= 2:
            return 0.72 - 0.12 * d
    dist = edit_distance(query, t, cap=3)
    if dist <= 2:
        return 0.75 - 0.12 * dist
    return 0.0


def code_frags(query: str) -> list[str]:
    """Split a bar-code query into digit runs ('5113 3555' -> ['5113','3555'])."""
    return re.findall(r"\d+", query)


def code_score(query: str, code: str) -> float:
    """Fuzzy bar-code score: every digit run must land in the code (typos ok)."""
    if not code:
        return 0.0
    frags = code_frags(query)
    if not frags:
        return 0.0
    scores = []
    for frag in frags:
        if frag in code:
            scores.append(1.0 if code.startswith(frag) else 0.9)
            continue
        # sliding-window edit distance against the code
        best = 99
        fl = len(frag)
        for i in range(len(code)):
            for wlen in (fl - 1, fl, fl + 1):
                if wlen <= 0 or i + wlen > len(code):
                    continue
                best = min(best, edit_distance(frag, code[i : i + wlen], cap=3))
        if best <= 2:
            scores.append(0.7 - 0.2 * best)
        else:
            return 0.0
    return sum(scores) / len(scores)


def number_score(value: float, row: dict) -> float:
    """1.0 if value hits any of the six scores exactly (0.05 slack)."""
    cols = ("s1", "s2", "s3", "s4", "s5", "total")
    best = min(abs(value - float(row[c])) for c in cols)
    return 1.0 if best <= 0.05 else max(0.0, 1.0 - best / 2.0)


# ---------------------------------------------------------------- search --

def load_rows() -> list[dict]:
    with CSV_PATH.open() as f:
        return list(csv.DictReader(f))


def row_vector(row: dict) -> list[float]:
    return [float(row[c]) for c in ("s1", "s2", "s3", "s4", "s5")]


def search(
    rows: list[dict],
    tokens: list[str],
    sede: str | None = None,
    code: str | None = None,
    vector: list[float] | None = None,
    near: float | None = None,
    tol: float = 0.05,
    limit: int = 20,
) -> list[tuple[float, dict]]:
    """Return (score, row) best-first. Every token must score > 0."""
    hits: list[tuple[float, dict]] = []
    for row in rows:
        total_score = 0.0
        ok = True
        for tok in tokens:
            if re.fullmatch(r"\d{3,}", tok):
                s = code_score(tok, row["barcode"])  # bar-code fragment(s)
            elif NUM_RE.match(tok):
                s = number_score(float(tok.replace(",", ".")), row)
            elif re.fullmatch(r"[\d\s\-]+", tok):
                s = code_score(tok, row["barcode"])
            else:
                s = max(
                    fuzzy_score(tok, row["sede_name"]),
                    fuzzy_score(tok, row["sede"]),
                    code_score(tok, row["barcode"]),
                )
            if s <= 0.0:
                ok = False
                break
            total_score += s
        if not ok:
            continue
        n = max(1, len(tokens))
        hits.append((total_score / n, row))

    if sede is not None:
        scored = [(fuzzy_score(sede, r["sede_name"]) + fuzzy_score(sede, r["sede"]), r) for _, r in hits]
        hits = [(s, r) for s, r in scored if s > 0]

    if code is not None:
        hits = [(code_score(code, r["barcode"]), r) for _, r in hits]
        hits = [(s, r) for s, r in hits if s > 0]

    if vector is not None:
        def vdist(row: dict) -> float:
            return sum(abs(a - b) for a, b in zip(vector, row_vector(row)))

        scored = []
        for s, r in hits:
            d = vdist(r)
            scored.append((s + max(0.0, 1.0 - d / 10.0), r))
        hits = scored

    if near is not None:
        hits = [
            (s, r) for s, r in hits
            if abs(float(r["total"]) - near) <= 0.05 + tol
        ]

    hits.sort(key=lambda t: (-t[0], t[1]["sede"], t[1]["barcode"]))
    return hits[:limit]


def fmt_row(score: float, row: dict) -> str:
    vec = " ".join(f"{float(row[c]):5.1f}" for c in ("s1", "s2", "s3", "s4", "s5"))
    code = row["barcode"] or "(no code)"
    return (
        f"{score:4.2f}  {row['sede_name']:<32.32} {code:>15}  "
        f"{vec}  tot {float(row['total']):5.1f}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tokens", nargs="*", help="free-text query tokens")
    ap.add_argument("--sede", help="fuzzy seat filter (e.g. 'bicoca')")
    ap.add_argument("--code", help="fuzzy bar-code filter")
    ap.add_argument("--vector", help="exact/near score vector 's1,s2,s3,s4,s5'")
    ap.add_argument("--near", type=float, help="keep rows with this total (within --tol)")
    ap.add_argument("--tol", type=float, default=0.05, help="tolerance for --near")
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()

    if not (args.tokens or args.sede or args.code or args.vector or args.near is not None):
        ap.print_help()
        return 2

    vector = None
    if args.vector:
        vector = [float(x.replace(",", ".")) for x in re.split(r"[;\s]+", args.vector) if x]

    rows = load_rows()
    hits = search(
        rows,
        args.tokens,
        sede=args.sede,
        code=args.code,
        vector=vector,
        near=args.near,
        tol=args.tol,
        limit=args.limit,
    )

    if not hits:
        print("no matches (…deep breath… try fewer or shorter tokens)")
        return 1
    print(f"{len(hits)} match(es) — best first\n")
    for s, r in hits:
        print(fmt_row(s, r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
