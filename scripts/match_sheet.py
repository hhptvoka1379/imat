#!/usr/bin/env python3
"""Match a marked 60-question answer sheet against the IMAT 2026 anonymous score lists.

The published lists only carry six numbers per candidate - five section scores and
a total - so the finest possible comparison against a 60-cell sheet is the number
of individual cells that would have to have been misread for a row to be that
sheet. That is the cost used below.

Scoring model (derived from the corpus, not assumed):
    +1.5 correct, -0.4 wrong, 0 blank
    section sizes from the column maxima 6.0 / 7.5 / 34.5 / 22.5 / 19.5
    -> 4 General Knowledge, 5 Logical Reasoning, 23 Biology, 15 Chemistry,
       13 Physics & Mathematics  (60 questions)

Usage:
    python3 scripts/match_sheet.py                       # the sheet transcribed in ANSWER.md
    python3 scripts/match_sheet.py --grid "CCCX- XCCX ..."   # C/X/W correct, -/. blank
    python3 scripts/match_sheet.py --file grid.txt --top 15 --university 15 --university C6
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "work", "all_results.json")

CORRECT, WRONG, BLANK = 1.5, -0.4, 0.0
SECTIONS = [("General Knowledge", 4), ("Logical Reasoning", 5), ("Biology", 23),
            ("Chemistry", 15), ("Physics & Mathematics", 13)]
SIZES = [n for _, n in SECTIONS]

# The sheet this task is about (44 correct / 7 wrong / 9 blank -> 63.2), section by
# section: (correct, wrong, blank).
DEFAULT_GRID = [(3, 1, 0), (2, 2, 1), (23, 0, 0), (9, 2, 4), (7, 2, 4)]


def load_rows():
    if os.path.exists(CACHE):
        with open(CACHE) as f:
            return json.load(f)
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from parse_lists import parse_all
    return parse_all(ROOT)


def decompose(score: float, n: int):
    """All (correct, wrong) pairs with 1.5c - 0.4w == score and c + w <= n."""
    out, target = [], int(round(score * 10))
    for w in range(n + 1):
        num = target + 4 * w
        if num % 15 == 0 and 0 <= num // 15 and num // 15 + w <= n:
            out.append((num // 15, w))
    return out


def cell_distance(cw, target_cw, n):
    """Minimum number of question cells that must differ between two sections,
    given only their (correct, wrong) counts."""
    c1, w1 = cw
    c2, w2 = target_cw
    b1, b2 = n - c1 - w1, n - c2 - w2
    return n - (min(c1, c2) + min(w1, w2) + min(b1, b2))


def fold_grid(marks):
    """marks: 60 items in {'C','W','B'} -> [(c,w,b) per section]."""
    grid, i = [], 0
    for n in SIZES:
        block = marks[i:i + n]
        grid.append((block.count("C"), block.count("W"), block.count("B")))
        i += n
    return grid


def section_scores(grid):
    return [round(1.5 * c - 0.4 * w, 10) for c, w, _ in grid]


def search(rows, grid, top=12, universities=None):
    target = section_scores(grid)
    total_target = round(sum(target), 10)
    ranked = []
    for r in rows:
        if universities and r["file"][:-4] not in universities:
            continue
        cost, sections_equal, detail = 0, 0, []
        for i in range(5):
            ds = decompose(r[f"s{i + 1}"], SIZES[i])
            if not ds:
                cost = -1
                break
            detail.append(min(cell_distance(cw, (grid[i][0], grid[i][1]), SIZES[i]) for cw in ds))
            cost += detail[-1]
            if abs(r[f"s{i + 1}"] - target[i]) < 1e-9:
                sections_equal += 1
        ranked.append((cost, -sections_equal, abs(r["total"] - total_target), r, detail))
    ranked.sort(key=lambda x: (x[0], x[1], x[2]))
    return ranked, target, total_target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", help="60-char pattern: C/W/X = correct, anything else blank")
    ap.add_argument("--file", help="file with one 'N: Correct|Incorrect|Blank' line per question")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--university", action="append", default=[],
                    help="restrict to file code(s), e.g. 15 or C6 (repeatable)")
    ap.add_argument("--per-university", action="store_true")
    args = ap.parse_args()

    if args.grid:
        marks = ["C" if ch in "Cc" else "W" if ch in "WwXx" else "B" for ch in args.grid if not ch.isspace()]
        grid = fold_grid(marks)
    elif args.file:
        marks = []
        for line in open(args.file):
            if ":" not in line:
                continue
            v = line.split(":", 1)[1].strip().lower()
            marks.append("C" if v.startswith("c") else "W" if v.startswith(("i", "w", "x")) else "B")
        grid = fold_grid(marks)
    else:
        grid = DEFAULT_GRID

    rows = load_rows()
    ranked, target, total_target = search(rows, grid, args.top, args.university)

    print(f"sheet -> section scores {target}  total {total_target}")
    exact = [r for r in rows if all(abs(r[f's{i+1}'] - target[i]) < 1e-9 for i in range(5))]
    print(f"exact matches on all five sections: {len(exact)}")
    if exact:
        for r in exact:
            print("  ", r)
        return
    print(f"rows whose total is exactly {total_target}: "
          f"{sum(1 for r in rows if abs(r['total'] - total_target) < 1e-9)}\n")

    print(f"=== closest {args.top} (cost = cells that would have to be misread) ===")
    for cost, neg_eq, dt, r, detail in ranked[:args.top]:
        print(f"{cost:2d} cells  sections-equal={-neg_eq}  |Δtotal|={dt:4.1f}  "
              f"{r['file']:8s} {r['university'][:26]:26s} {str(r['barcode']):16s} "
              f"{r['s1']:5}/{r['s2']:5}/{r['s3']:5}/{r['s4']:5}/{r['s5']:5} = {r['total']:5}  {detail}")

    if args.per_university:
        print("\n=== best per university ===")
        best = {}
        for item in ranked:
            best.setdefault(item[3]["university"], item)
        for u, (cost, neg_eq, dt, r, detail) in sorted(best.items(), key=lambda kv: (kv[1][0], kv[1][1], kv[1][2])):
            print(f"{cost:2d} cells sections-equal={-neg_eq} |Δtotal|={dt:4.1f} {r['file']:8s} "
                  f"{u[:26]:26s} {str(r['barcode']):16s} {r['s1']}/{r['s2']}/{r['s3']}/{r['s4']}/{r['s5']} = {r['total']}")


if __name__ == "__main__":
    main()
