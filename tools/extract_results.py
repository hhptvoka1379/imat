#!/usr/bin/env python3
"""Extract the IMAT 2026 anonymous results PDFs into data/results.csv.

Each PDF is one test location ("sede"). Every row is one candidate:
bar code (or '*'/missing) + Score 1..5 + Total Score.

Rows are validated with the identity  total ~= s1+s2+s3+s4+s5  (one decimal
places in the PDF, so allow tiny rounding slack) and by decomposing every
score into the official IMAT marking scheme (+1.5 correct, -0.4 wrong, 0
blank). Anything that fails is reported loudly instead of being silently
kept wrong.

Usage:
    python3 tools/extract_results.py            # writes data/results.csv
    python3 tools/extract_results.py --check    # stats only, no write
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# Sede code -> display name (from the official imat.cineca.it results page).
SEDI = {
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

NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?$")
BARCODE_RE = re.compile(r"^[0-9]{15}$")

CORRECT = 1.5
WRONG = -0.4


def decompose(score: float, size: int):
    """Return (correct, wrong) counts for a section score, or None.

    score = 1.5*c - 0.4*w with c, w >= 0 integers and c + w <= size.
    """
    tenths = round(score * 10)
    for c in range(size + 1):
        rem = tenths - round(c * 15)
        if rem % 4 == 0:
            w = -rem // 4
            if 0 <= w and c + w <= size:
                return c, w
    return None


def parse_page(page) -> list[list[str]]:
    """Group words into rows by vertical position, return token lists."""
    words = page.extract_words(x_tolerance=1.5, y_tolerance=2.0)
    rows: list[tuple[float, list[str]]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        top = w["top"]
        if rows and abs(rows[-1][0] - top) <= 2.5:
            rows[-1][1].append(w["text"])
        else:
            rows.append((top, [w["text"]]))
    out = []
    for top, toks in rows:
        if top < 92:  # year + column header band
            continue
        out.append(toks)
    return out


def parse_pdf(path: Path):
    password = "" if path.name == "MU.pdf" else None
    kwargs = {"password": password} if password is not None else {}
    raw: list[tuple[list[str], int]] = []
    with pdfplumber.open(path, **kwargs) as pdf:
        for pi, page in enumerate(pdf.pages, 1):
            for toks in parse_page(page):
                raw.append((toks, pi))

    rows = []
    pending_code = ""  # bar code stranded at the bottom of a page
    for toks, pi in raw:
        if not toks or toks[0] in ("Bar", "2026", "Pag."):
            continue  # header / footer furniture
        if toks[0] == "*" and not any(NUM_RE.match(t) for t in toks[1:]):
            continue  # "Punteggio in attesa..." note row: no score vector
        # bar codes are 15-digit (or '*') tokens; never scores
        code_tok = [t for t in toks if t == "*" or BARCODE_RE.match(t)]
        code_tok_set = set(code_tok)
        nums = [t for t in toks if t not in code_tok_set and NUM_RE.match(t)]
        if len(code_tok) == 1 and len(nums) == 0:
            pending_code = code_tok[0]  # row split across a page boundary
            continue
        if len(nums) == 6 and len(code_tok) <= 1:
            barcode = code_tok[0] if code_tok else pending_code
            pending_code = ""
            if barcode == "*":
                barcode = ""
            vals = [float(t) for t in nums]
            rows.append((barcode, vals, pi))
            continue
        print(f"  WARN {path.name} p{pi}: odd row {toks!r}", file=sys.stderr)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="print stats only")
    args = ap.parse_args()

    DATA_DIR.mkdir(exist_ok=True)
    out_path = DATA_DIR / "results.csv"

    all_rows: list[tuple[str, str, str, list[float], int]] = []
    problems = 0

    for code, name in SEDI.items():
        pdf = ROOT / f"{code}.pdf"
        if not pdf.exists():
            print(f"MISSING {pdf}", file=sys.stderr)
            problems += 1
            continue
        rows = parse_pdf(pdf)
        bad_sum = 0
        for barcode, vals, pi in rows:
            s1, s2, s3, s4, s5, total = vals
            if abs(total - (s1 + s2 + s3 + s4 + s5)) > 0.051:
                print(
                    f"  BADSUM {pdf.name} p{pi} {barcode or '*'}: {vals}",
                    file=sys.stderr,
                )
                bad_sum += 1
                problems += 1
        missing = sum(1 for b, _, _ in rows if not b)
        print(
            f"{code:>3}  {name:<34} rows={len(rows):>5}  no-barcode={missing}"
            + (f"  bad-sums={bad_sum}" if bad_sum else "")
        )
        for barcode, vals, pi in rows:
            all_rows.append((code, name, barcode, vals, pi))

    # ---- global statistics: figure out the section sizes -----------------
    maxima = [max(r[3][i] for r in all_rows) for i in range(5)]
    sizes = [round(m / CORRECT) for m in maxima]
    print(f"\nmaxima per section : {maxima}")
    print(f"section sizes (/1.5): {sizes}  sum={sum(sizes)}")

    # validate every score decomposes within its section size
    for code, name, barcode, vals, pi in all_rows:
        for i in range(5):
            if decompose(vals[i], sizes[i]) is None:
                print(
                    f"  BADSCORE {code} p{pi} {barcode or '*'} s{i+1}={vals[i]}",
                    file=sys.stderr,
                )
                problems += 1

    print(f"\ntotal rows = {len(all_rows)}")
    if problems:
        print(f"PROBLEMS: {problems}", file=sys.stderr)

    if args.check:
        return 1 if problems else 0

    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["sede", "sede_name", "barcode", "s1", "s2", "s3", "s4", "s5", "total"])
        for code, name, barcode, vals, _ in all_rows:
            w.writerow(
                [code, name, barcode]
                + [f"{v:g}" for v in vals]
            )
    print(f"wrote {out_path}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
