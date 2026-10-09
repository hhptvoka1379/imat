# Fuzzy search of a hand-written 60-question grid against the IMAT 2026 lists

**Grid:** 44 correct / 7 wrong / 9 blank → `44 × 1.5 − 7 × 0.4 = 63.2`, which
matches the hand-written "Punteggio 63.2", so the transcription is internally
consistent.

Reproduce:

```bash
python3 scripts/find_pattern.py --file patterns/grid_full.txt --university 15 --university C6 --reparse
```

## Parse integrity (audited)

Every PDF is now checked with a hard invariant: *the number of numeric tokens in
the file, minus headers, must equal 6 × the number of rows parsed*. All 19 files
balance exactly.

An earlier version of the parser walked "bar code, then 6 numbers" and silently
dropped a row whenever the bar-code cell was empty (first row of page 1 in
`03, 08, 22, 26, 27, 31`) or was `*` (`MU.pdf`, 2 rows). Those **8 rows are now
recovered**: the corpus is **18,368 rows**, not 18,360. Milano (`15.pdf`,
1,012 rows) and Milano Bicocca (`C6.pdf`, 339 rows) were already complete and are
unchanged by the fix.

## Section model (derived, and cross-checked)

Column maxima over all 18,368 rows are 6.0 / 7.5 / 34.5 / 22.5 / 19.5 →
4 / 5 / 23 / 15 / 13 questions = 60. Column minima are −1.6 / −2.0 / −8.8 /
−6.0 / −5.2 = −0.4 × (4, 5, 22, 15, 13), confirming −0.4 for a wrong answer and
0 for a blank. Score 1 takes exactly 15 distinct values, which is precisely the
attainable set for a 4-question section; Score 2 takes 21 = the attainable set
for 5. Legend from the CINECA page: General Knowledge, Logical Reasoning,
Biology, Chemistry, Physics & Mathematics.

Folding the grid through it:

| Section | Questions | C/W/B | Score |
|---|---|---|---|
| General Knowledge | 1–4 | 3/1/0 | 4.1 |
| Logical Reasoning | 5–9 | 2/2/1 | 2.2 |
| Biology | 10–32 | 23/0/0 | 34.5 |
| Chemistry | 33–47 | 9/2/4 | 12.7 |
| Physics & Maths | 48–60 | 7/2/4 | 9.7 |
| **Total** | | 44/7/9 | **63.2** |

## Result

**No row in the corpus has the vector `4.1 / 2.2 / 34.5 / 12.7 / 9.7`.**
No row matches 4 of the 5 sections; 19 rows match 3 of 5, one of them in Milano.

**Best match in Milano (`15.pdf`), and the strongest candidate overall:**

| | |
|---|---|
| Bar code | **551131517753135** |
| Scores | 4.1 · **4.1** · 34.5 · 12.7 · **13.1** = **68.5** |
| Implied marks | GK 3C/1W/0B · LR **3C/1W/1B** · Bio 23C/0W/0B · Chem 9C/2W/4B · P&M **9C/1W/3B** |
| Distance from the grid | 3 cells |

Score 1, 3 and 4 are identical to the grid. It is the **only** row of the 1,012 in
Milano with `Score 1 = 4.1` and `Score 3 = 34.5` and `Score 4 = 12.7` (63 rows
have a perfect biology section; 8 of those also have `Score 1 = 4.1`).

The three cells that would have to be misread:
* one of the two crosses in **Q5–Q9** is a tick (+1.9)
* in **Q48–Q60**: one blank → tick (+1.5), one cross → tick (+1.9)

63.2 + 1.9 + 1.5 + 1.9 = **68.5**. Rank in Milano's list: 104th (63.2 would be 224th).

## Robustness checks that did not change the answer

* **All 120 orderings** of the five section blocks over questions 1–60: 0 exact
  hits; the same bar code still wins.
* **Grid shifted** by −3…+3 questions: shift 0 remains the best fit for Milano.
* **Alternative section models** — 7/4/23/15/11 (the classic pre-2025 split),
  4/7/23/15/11, 5/4/23/15/13, 7/5/23/15/10, 2/7/23/15/13 — every one folds to a
  different vector and **none** has an exact hit in any list. So a "match" found
  under a different model is not coming from these files either.

## Why an exact answer-level match is impossible here

The published lists contain **six numbers per candidate** — five section scores
and a total. They contain no per-question data and no answer key. The finest
comparison available against a 60-cell grid is therefore those five numbers.
Anything described as "the same answers" is either a match on the five section
scores (the row above), a match on the total alone (Milano has exactly four rows
totalling 63.2: `551535135535333`, `713111117713315`, `751111335733331`,
`951555157935531` — 8 to 13 cells away from this grid), or it is not verifiable
from these files.

## Files

* `scripts/find_pattern.py` — parser (with the row-completeness fix) + exact and
  fuzzy search; caches parsed rows to `work/scores.csv`.
* `patterns/grid_full.txt`, `patterns/grid_63.2.txt` — the 60 marks (identical).
