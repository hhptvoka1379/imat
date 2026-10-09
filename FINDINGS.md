# Fuzzy search of a hand-written 60-question grid against the IMAT 2026 lists

**Grid:** 44 correct / 7 wrong / 9 blank → `44 × 1.5 − 7 × 0.4 = 63.2` (matches the
hand-written "Punteggio 63.2", so the transcription is internally consistent).

**Data:** all 19 published lists in this repo — 18,360 rows, every barcode unique
(no candidate appears twice, so the lists are disjoint).
Milano = `15.pdf` (1,012 rows), Milano Bicocca (Bergamo) = `C6.pdf` (339 rows),
`MU.pdf` = "Sedi estere" (9,658 rows).

Reproduce with:

```bash
python3 scripts/find_pattern.py --file patterns/grid_63.2.txt --university 15 --top 12
```

## Section model (verified from the data, not assumed)

The results page legend gives the section names; the sizes come from the maximum
value seen in each column over all 18,360 rows (`max = 1.5 × n`), and every
observed value is reachable with that `n`:

| Section | Questions | Max seen | n |
|---|---|---|---|
| Score 1 — General Knowledge | 1–4 | 6.0 | 4 |
| Score 2 — Logical Reasoning | 5–9 | 7.5 | 5 |
| Score 3 — Biology | 10–32 | 34.5 | 23 |
| Score 4 — Chemistry | 33–47 | 22.5 | 15 |
| Score 5 — Physics & Mathematics | 48–60 | 19.5 | 13 |

4 + 5 + 23 + 15 + 13 = 60 ✓. Folding the grid through this model gives

| Section | C/W/B | Score |
|---|---|---|
| General Knowledge | 3/1/0 | 4.1 |
| Logical Reasoning | 2/2/1 | 2.2 |
| Biology | 23/0/0 | 34.5 |
| Chemistry | 9/2/4 | 12.7 |
| Physics & Maths | 7/2/4 | 9.7 |
| **Total** | 44/7/9 | **63.2** |

## Result

**The exact vector `4.1 / 2.2 / 34.5 / 12.7 / 9.7` appears in none of the 18,360
rows.** No row anywhere matches 4 of the 5 sections; only 19 rows in the whole
corpus match 3 of 5 — and exactly one of those is in Milano.

**Best match in Milano (`15.pdf`), and the strongest candidate overall:**

| | |
|---|---|
| Barcode | **551131517753135** |
| Scores | 4.1 · **4.1** · 34.5 · 12.7 · **13.1** = **68.5** |
| Implied marks | GK 3C/1W/0B · LR **3C/1W/1B** · Bio 23C/0W/0B · Chem 9C/2W/4B · P&M **9C/1W/3B** |
| Distance from the grid | 3 cells |

Score 1, Score 3 and Score 4 are *identical* to the grid. It is the **only** row
of the 1,012 in Milano with `Score 1 = 4.1` **and** `Score 3 = 34.5` **and**
`Score 4 = 12.7` (63 rows have a perfect biology section; 8 of those also have
`Score 1 = 4.1`; only this one adds `Score 4 = 12.7`).

The three cells that would have to be misread, all in the two mismatching
sections:

* one of the two crosses in **Q5–Q9** (Logical Reasoning) is actually a tick → +1.9
* in **Q48–Q60** (Physics & Maths): one blank → tick (+1.5) and one cross → tick (+1.9)

63.2 + 1.9 + 1.5 + 1.9 = **68.5** ✓ — the row is reachable from the grid with
three single-cell corrections and nothing else.

## Runners-up

Milano, next best (cells off / exact sections / scores):

| Cells | Exact | Barcode | Scores |
|---|---|---|---|
| 4 | 2/5 | 953355317713115 | 4.1 · 6.0 · 34.5 · 12.3 · 11.2 = 68.1 |
| 4 | 2/5 | 533513115713111 | 4.1 · 2.2 · 32.6 · 11.2 · 7.4 = 57.5 |
| 6 | 2/5 | 955135117755115 | 4.5 · 2.2 · 34.5 · 13.0 · 9.3 = 63.5 |

Closest anywhere in the corpus is a *Campania "L. Vanvitelli"* row,
`733115117953111` (4.1 · 4.1 · 34.5 · 12.7 · 10.1 = 65.5), 2 cells off — but it
is not in a Milan list.

## The four Milano rows that total exactly 63.2

None is remotely close to the grid's section split (8–13 cells off), which argues
against the total being right and the split wrong:

| Barcode | Scores | Cells off |
|---|---|---|
| 551535135535333 | 1.5 · 2.6 · 34.5 · 15.3 · 9.3 = 63.2 | 8 |
| 951555157935531 | 1.1 · 2.6 · 31.5 · 15.7 · 12.3 = 63.2 | 10 |
| 751111335733331 | 6.0 · 7.5 · 34.5 · 11.5 · 3.7 = 63.2 | 11 |
| 713111117713315 | 3.0 · 1.1 · 33.0 · 8.5 · 17.6 = 63.2 | 13 |

## Position in the list (approximate)

Sorting Milano's 1,012 rows by total: 63.2 → 224th; 68.5 → 104th.
Sorting all 18,360 rows together: 63.2 → 3,880th; 68.5 → 2,020th.
*The combined figure assumes the 19 lists together are the whole cohort — that
is not verified from inside this repo.*

## Files

* `scripts/find_pattern.py` — parser + exact/fuzzy search (auto-detects section
  sizes, caches parsed rows to `work/scores.csv`).
* `patterns/grid_63.2.txt` — the 60 marks of the grid.
