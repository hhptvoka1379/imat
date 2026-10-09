#!/usr/bin/env python3
"""match_answers.py — locate yourself in the IMAT 2026 anonymous results.

Give the 60 answers as one character per question, in section order
(General Knowledge x4, Logical Reasoning x5, Biology x23, Chemistry x15,
Physics & Mathematics x13):

    S  sure    — you answered and you're confident it's correct  (+1.5)
    U  unsure  — you answered but you don't know if it's right    (+1.5 or -0.4)
    W  wrong   — you know you got it wrong                        (-0.4)
    B  blank   — you left it empty                                (0)

Example (all sure except a few):

    python3 tools/match_answers.py --sede bologna \
        SSSSUUUWWBBSSSSSSSSSSSSS...60 chars total...

The tool recomputes every score vector your answer sheet could produce and
looks for it in the published anonymous results — filtered to the seat where
you sat the test. Verdicts:

    UNIQUE     exactly one person at that seat matches: that's you
    AMBIGUOUS  several people share your result vector (bar codes listed)
    NONE       nobody matches: check your seat / your memory of the answers

Matching is exact integer arithmetic on tenths of points, in pure stdlib.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "results.csv"

SECTIONS = [
    ("General Knowledge", 4),
    ("Logical Reasoning", 5),
    ("Biology", 23),
    ("Chemistry", 15),
    ("Physics & Math", 13),
]
N_QUESTIONS = sum(n for _, n in SECTIONS)  # 60

# marking scheme, in tenths of a point
CORRECT, WRONG = 15, -4
GAP = CORRECT - WRONG  # 19 tenths between "right" and "wrong" for an unsure

STATE_CHARS = {"S": "sure", "U": "unsure", "W": "wrong", "B": "blank"}
ALIASES = {"S": "S", "U": "U", "W": "W", "B": "B", "1": "S", "2": "U", "3": "W", "4": "B", ".": "B", "-": "B"}


def parse_answers(s: str) -> list[str]:
    out = []
    for ch in s.upper():
        if ch.isspace() or ch in ",;|":
            continue
        if ch not in ALIASES:
            sys.exit(f"bad answer char {ch!r} — use S/U/W/B (or 1/2/3/4)")
        out.append(ALIASES[ch])
    if len(out) != N_QUESTIONS:
        sys.exit(f"need {N_QUESTIONS} answers, got {len(out)}")
    return out


def section_stats(answers: list[str]) -> list[dict]:
    stats = []
    i = 0
    for name, n in SECTIONS:
        chunk = answers[i : i + n]
        i += n
        sure = chunk.count("S")
        wrong = chunk.count("W")
        unsure = chunk.count("U")
        fixed = sure * CORRECT + wrong * WRONG
        stats.append(
            {
                "name": name,
                "n": n,
                "sure": sure,
                "wrong": wrong,
                "unsure": unsure,
                "blank": chunk.count("B"),
                "fixed": fixed,  # tenths, from the certain answers
                "lo": fixed + unsure * WRONG,
                "hi": fixed + unsure * CORRECT,
            }
        )
    return stats


def row_matches(target: list[int], stats: list[dict]) -> list[int] | None:
    """If the row's section scores (tenths) fit, return unsure-right counts."""
    resolved = []
    for t, st in zip(target, stats):
        num = t - st["fixed"] + (-WRONG) * st["unsure"]  # tenths
        if num % GAP:
            return None
        a = num // GAP  # how many of the unsure must have been right
        if a < 0 or a > st["unsure"]:
            return None
        resolved.append(a)
    return resolved


def load_rows() -> list[dict]:
    rows = []
    with CSV_PATH.open() as f:
        for r in csv.DictReader(f):
            tenths = [round(float(r[c]) * 10) for c in ("s1", "s2", "s3", "s4", "s5")]
            rows.append(
                {
                    "sede": r["sede"],
                    "sede_name": r["sede_name"],
                    "barcode": r["barcode"],
                    "vec": tenths,
                    "total": round(float(r["total"]) * 10),
                }
            )
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("answers", help=f"{N_QUESTIONS} chars of S/U/W/B")
    ap.add_argument("--sede", required=True, help="seat name or code (fuzzy ok)")
    ap.add_argument("--all-sedi", action="store_true", help="also search every other seat")
    args = ap.parse_args()

    answers = parse_answers(args.answers)
    stats = section_stats(answers)

    print("your section ranges (tenths shown as points):")
    for st in stats:
        print(
            f"  {st['name']:<20} n={st['n']:>2}  "
            f"sure {st['sure']} · unsure {st['unsure']} · wrong {st['wrong']} · blank {st['blank']}   "
            f"score {st['lo']/10:.1f} … {st['hi']/10:.1f}"
        )

    q = args.sede.lower()
    rows = load_rows()
    sedi = sorted({(r["sede"], r["sede_name"]) for r in rows})
    pick = [(c, n) for c, n in sedi if q in n.lower() or q == c.lower()]
    if len(pick) != 1:
        print(f"\nseat {args.sede!r} matches {len(pick)} seats: {pick}", file=sys.stderr)
        return 2
    code, name = pick[0]

    local = [r for r in rows if r["sede"] == code]
    others = [r for r in rows if r["sede"] != code] if args.all_sedi else []

    hits = []
    for r in local:
        res = row_matches(r["vec"], stats)
        if res is not None:
            hits.append((r, res))

    print(f"\nseat: {name} ({len(local)} candidates)")
    if len(hits) == 1:
        r, res = hits[0]
        print("verdict: UNIQUE — exactly one person at this seat can be you.")
    elif not hits:
        print("verdict: NONE — nobody at this seat matches this answer sheet.")
    else:
        print(f"verdict: AMBIGUOUS — {len(hits)} people share this result vector here.")

    for r, res in hits:
        code_s = r["barcode"] or "(no code)"
        vec_s = " ".join(f"{v/10:5.1f}" for v in r["vec"])
        print(f"\n  bar code {code_s}   vector {vec_s}   total {r['total']/10:.1f}")
        for st, a in zip(stats, res):
            if st["unsure"]:
                print(f"    {st['name']:<20} unsure → {a} right, {st['unsure'] - a} wrong")

    if others:
        extra = [(r, res) for r in others if (res := row_matches(r["vec"], stats)) is not None]
        if extra:
            print(f"\n  (for the record: {len(extra)} more match(es) at other seats)")
            for r, res in extra[:5]:
                print(f"    {r['sede_name']:<32} {r['barcode'] or '(no code)'}")

    if not hits:
        print("\n  closest vectors at your seat (L1 distance in tenths):")
        def dist(r: dict) -> int:
            return sum(min(abs(v - st["lo"]), abs(v - st["hi"])) if st["unsure"] else abs(v - st["fixed"])
                       for v, st in zip(r["vec"], stats))
        for r in sorted(local, key=dist)[:5]:
            vec_s = " ".join(f"{v/10:5.1f}" for v in r["vec"])
            print(f"    d={dist(r):>4}  {r['barcode'] or '(no code)'}  {vec_s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
