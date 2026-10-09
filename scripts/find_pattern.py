#!/usr/bin/env python3
"""Fuzzy-search a hand-written 60-question result pattern against the IMAT 2026
anonymous score lists published on imat.cineca.it (the PDFs in this repo).

How it works
------------
Each published row is:  Bar Code | Score 1..5 | Total Score
  Score 1: General Knowledge      (4 questions)
  Score 2: Logical Reasoning      (5 questions)
  Score 3: Biology                (23 questions)
  Score 4: Chemistry              (15 questions)
  Score 5: Physics & Mathematics  (13 questions)
Scoring is +1.5 correct / -0.4 wrong / 0 blank.

The section sizes are *not* hard-coded: they are derived from the maximum value
seen in each column across every list (max = 1.5 x n_questions), which also makes
the script self-checking if a future year changes the structure.

A result pattern such as "correct, correct, wrong, blank, ..." is folded into a
5-element section-score vector. That vector is searched exactly first; when
nothing matches, every row is ranked by a fuzzy cost = the minimum number of
grid cells that would have to be misread for the row to be consistent with the
pattern (each section score admits several correct/wrong/blank combinations, all
of them are tried).

Usage
-----
  python3 scripts/find_pattern.py "CCCW-WCCWCCC...CC"
  python3 scripts/find_pattern.py --file pattern.txt --university 15 --top 20

Marks: C = correct, X/W = wrong, -/. /space = blank.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

try:
    import pymupdf  # pip install pymupdf
except ImportError:  # pragma: no cover
    sys.exit("pymupdf is required:  pip install --break-system-packages pymupdf")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "work", "scores.csv")

CORRECT, WRONG, BLANK = 1.5, -0.4, 0.0
SECTION_NAMES = [
    "General Knowledge",
    "Logical Reasoning",
    "Biology",
    "Chemistry",
    "Physics & Mathematics",
]

# University names, mapped from the download links on the CINECA results page
# ("MEDICINA, ODONTOIATRIA E VETERINARIA IN LINGUA INGLESE.html").
UNIVERSITIES = {
    "MU": "Sedi estere",
    "02": "Bari Aldo Moro",
    "03": "Bologna",
    "04": "Cagliari",
    "49": 'Campania "L. Vanvitelli" (Napoli)',
    "08": "Catania",
    "10": "Firenze",
    "14": "Messina",
    "15": "Milano",
    "C6": "Milano Bicocca (Bergamo)",
    "18": 'Napoli "Federico II"',
    "19": "Padova",
    "21": "Parma (sede di Piacenza)",
    "22": "Pavia",
    "01": "Politecnica delle Marche",
    "26": 'Roma "La Sapienza"',
    "27": 'Roma "Tor Vergata"',
    "30": "Siena Odontoiatria",
    "31": "Torino (sede di Orbassano)",
}

HEADER_TOKENS = {
    "Bar Code", "Score 1", "Score 2", "Score 3", "Score 4", "Score 5",
    "Total Score", "Total", "Question", "Score:",
}
NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?$")
BARCODE_RE = re.compile(r"^\d{10,20}$")
NOISE_RE = re.compile(r"^(?:2026|Pag\.\s*\d+|\*|.*Punteggio in attesa.*)$")


# --------------------------------------------------------------------------- #
# parsing
# --------------------------------------------------------------------------- #
def parse_pdf(path: str) -> list[tuple[str, list[float]]]:
    """Return [(barcode, [s1..s5, total])] for one published list."""
    doc = pymupdf.open(path)
    tokens: list[str] = []
    for page in doc:
        tokens += [t.strip() for t in page.get_text().split("\n") if t.strip()]

    rows, i, n = [], 0, len(tokens)
    while i < n:
        tok = tokens[i]
        if tok in HEADER_TOKENS or NOISE_RE.match(tok):
            i += 1
            continue
        if BARCODE_RE.match(tok) or tok == "*":
            vals: list[float] = []
            j = i + 1
            while j < n and len(vals) < 6 and NUM_RE.match(tokens[j]):
                vals.append(float(tokens[j]))
                j += 1
            if len(vals) == 6:
                rows.append((tok, vals))
                i = j
                continue
        i += 1
    return rows


def load_rows(force: bool = False) -> list[tuple[str, str, list[float]]]:
    """Parse every PDF in the repo (cached to work/scores.csv)."""
    if os.path.exists(CACHE) and not force:
        out = []
        with open(CACHE, newline="") as fh:
            for r in csv.DictReader(fh):
                vals = [float(r[f"s{k}"]) for k in range(1, 6)] + [float(r["total"])]
                out.append((r["file"], r["barcode"], vals))
        return out

    rows: list[tuple[str, str, list[float]]] = []
    for name in sorted(os.listdir(ROOT)):
        if not name.endswith(".pdf"):
            continue
        for barcode, vals in parse_pdf(os.path.join(ROOT, name)):
            rows.append((name[:-4], barcode, vals))

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["file", "barcode", "s1", "s2", "s3", "s4", "s5", "total"])
        for f, bc, v in rows:
            w.writerow([f, bc] + v)
    return rows


# --------------------------------------------------------------------------- #
# section model
# --------------------------------------------------------------------------- #
def detect_sizes(rows) -> list[int]:
    """Number of questions per section = max(column) / 1.5, validated."""
    sizes = []
    for col in range(5):
        top = max(round(v[col], 1) for _, _, v in rows)
        n = round(top / CORRECT)
        sizes.append(n)
    # every observed value must be reachable with that many questions
    for col, n in enumerate(sizes):
        reachable = {round(CORRECT * c + WRONG * w, 1)
                     for c in range(n + 1) for w in range(n - c + 1)}
        seen = {round(v[col], 1) for _, _, v in rows}
        assert seen <= reachable, f"Score {col + 1}: {sorted(seen - reachable)} unreachable with n={n}"
    return sizes


_ATT_CACHE: dict[tuple[int, float], set[tuple[int, int]]] = {}


def attainable(scores: list[float], sizes: list[int]) -> list[set[tuple[int, int]]]:
    """For each section score, every (correct, wrong) split that produces it."""
    out = []
    for s, n in enumerate(sizes):
        key = (s, round(scores[s], 1))
        if key in _ATT_CACHE:
            out.append(_ATT_CACHE[key])
            continue
        combos = {
            (c, w)
            for c in range(n + 1)
            for w in range(n - c + 1)
            if abs(round(CORRECT * c + WRONG * w, 1) - round(scores[s], 1)) < 1e-9
        }
        assert combos, f"score {scores[s]} not attainable for a {n}-question section"
        _ATT_CACHE[key] = combos
        out.append(combos)
    return out


# --------------------------------------------------------------------------- #
# pattern handling
# --------------------------------------------------------------------------- #
def parse_pattern(text: str) -> list[str]:
    """'1: Correct', '1 C', 'CCCW-' ... -> list of 60 marks in {C, W, B}."""
    text = text.replace("\\checkmark", "C").replace("\\text{X}", "X")
    lines = [ln for ln in re.split(r"[\n,;|]+", text) if ln.strip()]
    marks: list[str] = []
    if len(lines) == 60:  # one mark per line
        for ln in lines:
            marks.append(_mark(ln.split(":")[-1].strip()))
    else:  # a compact run of characters
        flat = re.sub(r"\s+", "", text)
        if len(flat) != 60:
            raise SystemExit(f"pattern must describe 60 questions, got {len(flat)}")
        marks = [_mark(ch) for ch in flat]
    return marks


def _mark(token: str) -> str:
    t = token.strip().lower()
    if "incorrect" in t or "wrong" in t or "sbagliat" in t:
        return "W"
    if "correct" in t or "giust" in t:
        return "C"
    if "blank" in t or "omit" in t or "omess" in t or "vuot" in t:
        return "B"
    t = re.sub(r"[^a-z✓✗x.\-_/]", "", t)
    if not t or t in {"-", ".", "_", "/", "b", "o"}:
        return "B"
    if t[0] in {"c", "✓", "v", "1"}:
        return "C"
    if t[0] in {"w", "x", "✗", "0"}:
        return "W"
    raise SystemExit(f"cannot read mark: {token!r}")


def section_profile(marks: list[str], sizes: list[int]):
    """Split the 60 marks into sections -> [(c, w, b), ...] and section scores."""
    prof, scores, i = [], [], 0
    for n in sizes:
        chunk = marks[i:i + n]
        i += n
        c, w, b = chunk.count("C"), chunk.count("W"), chunk.count("B")
        prof.append((c, w, b))
        scores.append(round(CORRECT * c + WRONG * w + BLANK * b, 1))
    return prof, scores


def fuzzy_cost(profile, scores, sizes) -> tuple[float, list[tuple[int, int, int]]]:
    """Minimum number of grid cells that must be misread for a row to fit.

    Each section score admits several (correct, wrong, blank) splits, so every
    split is tried and the cheapest one wins. Deltas sum to zero within a
    section, so half the L1 distance is the number of cells that change.
    """
    total, detail = 0.0, []
    for s, (combos, (pc, pw, pb)) in enumerate(zip(attainable(scores, sizes), profile)):
        n = sizes[s]
        best = None
        for (c, w) in combos:
            b = n - c - w
            # deltas sum to zero, so half the L1 distance is the number of cells
            d = (abs(c - pc) + abs(w - pw) + abs(b - pb)) / 2
            if best is None or d < best[0]:
                best = (d, c, w, b)
        total += best[0]
        detail.append(best[1:])
    return total, detail


# --------------------------------------------------------------------------- #
# search
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pattern", nargs="?", help="60 marks, e.g. CCCW-WCCW...")
    ap.add_argument("--file", help="read the pattern from a file instead")
    ap.add_argument("--university", action="append", default=[],
                    help="restrict/also report this list code, e.g. 15 (Milano)")
    ap.add_argument("--top", type=int, default=15, help="matches to show (default 15)")
    ap.add_argument("--reparse", action="store_true", help="ignore work/scores.csv cache")
    args = ap.parse_args()

    raw = open(args.file, encoding="utf-8").read() if args.file else args.pattern
    if not raw:
        ap.error("give a pattern or --file")
    marks = parse_pattern(raw)

    rows = load_rows(args.reparse)
    sizes = detect_sizes(rows)
    profile, target = section_profile(marks, sizes)

    print(f"parsed {len(rows)} rows from {len({f for f, _, _ in rows})} lists")
    print("section sizes (questions):", sizes, "=", sum(sizes), "questions")
    print()
    for s, n in enumerate(sizes):
        c, w, b = profile[s]
        print(f"  Score {s + 1} {SECTION_NAMES[s]:22s} Q{sum(sizes[:s]) + 1:>2}-"
              f"Q{sum(sizes[:s + 1]):>2}  {c:>2}C {w:>2}W {b:>2}B -> {target[s]:>6}")
    print(f"  {'TOTAL':29s} {sum(p[0] for p in profile):>2}C "
          f"{sum(p[1] for p in profile):>2}W {sum(p[2] for p in profile):>2}B "
          f"-> {round(sum(target), 1):>6}")
    print()

    exact = [(f, bc, v) for f, bc, v in rows
             if all(abs(v[i] - target[i]) < 0.05 for i in range(5))]
    print(f"EXACT match on all 5 section scores: {len(exact)}")
    for f, bc, v in exact:
        print(f"  {UNIVERSITIES.get(f, f):32s} ({f}) barcode {bc}  {v}")
    same_total = [(f, bc, v) for f, bc, v in rows if abs(v[5] - round(sum(target), 1)) < 0.05]
    print(f"rows with the same total score ({round(sum(target), 1)}): {len(same_total)}")
    print("  " + ", ".join(f"{UNIVERSITIES.get(f, f)}:{n}"
                           for f, n in Counter(f for f, _, _ in same_total).most_common()))
    print()

    ranked = sorted(rows, key=lambda r: (fuzzy_cost(profile, r[2], sizes)[0],
                                        abs(r[2][5] - round(sum(target), 1))))
    for code in (args.university or []):
        sub = [r for r in ranked if r[0] == code]
        print(f"--- best matches in {UNIVERSITIES.get(code, code)} ({code}.pdf, "
              f"{len(sub)} rows) ---")
        for f, bc, v in sub[:args.top]:
            cost, detail = fuzzy_cost(profile, v, sizes)
            hits = sum(1 for i in range(5) if abs(v[i] - target[i]) < 0.05)
            print(f"  {cost:>4.1f} cells off | {hits}/5 sections exact | barcode {bc:16s} "
                  f"{str(v):45s} implied C/W/B {detail}")
        print()

    print(f"--- best matches overall (all lists) ---")
    for f, bc, v in ranked[:args.top]:
        cost, detail = fuzzy_cost(profile, v, sizes)
        hits = sum(1 for i in range(5) if abs(v[i] - target[i]) < 0.05)
        print(f"  {cost:>4.1f} cells off | {hits}/5 sections exact | "
              f"{UNIVERSITIES.get(f, f):30s} ({f}) barcode {bc:16s} {v}")


if __name__ == "__main__":
    main()
