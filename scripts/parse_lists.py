#!/usr/bin/env python3
"""Parse every IMAT 2026 anonymous-results PDF in this repo into one row per candidate.

Each published row is:  Bar Code | Score 1 | Score 2 | Score 3 | Score 4 | Score 5 | Total Score

Usage:
    python3 scripts/parse_lists.py [-o work/all_results.json] [--csv all_results.csv]

The university names come from the download links on the saved CINECA page
"MEDICINA, ODONTOIATRIA E VETERINARIA IN LINGUA INGLESE.html".
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
from collections import defaultdict

try:
    import pymupdf  # pip install pymupdf
except ImportError:  # pragma: no cover
    raise SystemExit("pymupdf is required:  pip install --break-system-packages pymupdf")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# code -> university, in the order the download links appear on the CINECA page
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

NUM_RE = re.compile(r"^-?\d+(?:\.\d+)?$")
BARCODE_RE = re.compile(r"^(\*|\d{10,20})$")
FIELDS = ["file", "university", "page", "barcode", "s1", "s2", "s3", "s4", "s5", "total"]


def parse_pdf(path: str, code: str, university: str):
    """Rows of one PDF. Each score row is paired with the bar-code cell beside it;
    a handful of rows in MU.pdf have an empty or '*' code cell."""
    doc = pymupdf.open(path)
    rows, strays = [], []
    for pno, page in enumerate(doc, 1):
        by_row = defaultdict(list)
        for w in page.get_text("words"):
            by_row[round(((w[1] + w[3]) / 2) / 4)].append(w)
        # merge buckets within ~4 pt: the bar-code cell and the six score cells are
        # on the same table row but not on an identical baseline
        merged: list = []
        for k in sorted(by_row):
            if merged and k - merged[-1][0] <= 1:
                merged[-1][1].extend(by_row[k])
            else:
                merged.append([k, list(by_row[k])])
        for _, line in merged:
            line.sort(key=lambda w: w[0])
            toks = [w[4] for w in line]
            if toks[:2] == ["Bar", "Code"] or toks == ["2026"] or toks[:1] == ["Pag."]:
                continue
            left = [t for w, t in zip(line, toks) if w[0] < 150]
            right = [t for w, t in zip(line, toks) if w[0] >= 150]
            nums = [t for t in right if NUM_RE.match(t)]
            codes = [t for t in left if BARCODE_RE.match(t)]
            if len(nums) == 6:
                rows.append([pno, codes[0] if codes else None, nums])
            elif codes:  # a code left alone on its line (page break)
                strays.append(codes[0])
    for row in rows:  # give orphan codes to the code-less rows that follow
        if row[1] is None and strays:
            row[1] = strays.pop(0)
    out = []
    for pno, barcode, nums in rows:
        out.append({
            "file": os.path.basename(path),
            "university": university,
            "page": pno,
            "barcode": barcode,
            "s1": float(nums[0]), "s2": float(nums[1]), "s3": float(nums[2]),
            "s4": float(nums[3]), "s5": float(nums[4]), "total": float(nums[5]),
        })
    return out


def parse_all(root: str):
    rows = []
    for code, university in UNIVERSITIES.items():
        rows.extend(parse_pdf(os.path.join(root, f"{code}.pdf"), code, university))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--json", default=os.path.join(ROOT, "work", "all_results.json"))
    ap.add_argument("--csv", default=os.path.join(ROOT, "all_results.csv"))
    ap.add_argument("--root", default=ROOT)
    args = ap.parse_args()

    rows = parse_all(args.root)
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as f:
        json.dump(rows, f)
    with open(args.csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    per_file = defaultdict(int)
    for r in rows:
        per_file[r["file"]] += 1
    print(f"{len(rows)} rows")
    for k in sorted(per_file):
        print(f"  {k:8s} {UNIVERSITIES[k[:-4]]:30s} {per_file[k]:5d}")
    bad = [r for r in rows if abs(sum(r[f"s{i}"] for i in range(1, 6)) - r["total"]) > 0.051]
    print("rows where the five sections do not sum to the total:", len(bad))
    print("rows with no bar code in the PDF:", sum(1 for r in rows if not r["barcode"]))
    print("rows whose bar code is '*':", sum(1 for r in rows if r["barcode"] == "*"))


if __name__ == "__main__":
    main()
