# Closest match to the answer sheet in this repo

## Answer

| | |
|---|---|
| **File** | **`49.pdf` — Campania "L. Vanvitelli" (Napoli)**, page 5 |
| **Bar code** | **`733115117953111`** |
| **Scores** | Score 1 **4.1** · Score 2 **4.1** · Score 3 **34.5** · Score 4 **12.7** · Score 5 **10.1** = **65.5** |
| **Distance from the sheet** | **2 of 60 cells** (the only row in all 18,368 that is within 2) |
| Sections identical to the sheet | General Knowledge (4.1), Biology (34.5), Chemistry (12.7) — 3 of 5 |
| What would have to be misread | Q5–Q9: one ✗ read as ✓ (+1.9) · Q48–Q60: one ✗ is really a blank (+0.4) → 63.2 + 1.9 + 0.4 = **65.5** |

**No row in the corpus carries the sheet's own vector (4.1 / 2.2 / 34.5 / 12.7 / 9.7 = 63.2), so
"closest" is necessarily a fuzzy match.** 0 rows match on 5 sections, 0 on 4, 19 match on 3, and
`733115117953111` is the closest of those 19 — and of the whole corpus — by the number of cells
that would have to be misread.

### Runner-ups

| cells | sections = | \|Δ total\| | file / university | bar code | scores |
|---|---|---|---|---|---|
| **2** | 3 | 2.3 | `49.pdf` Campania "L. Vanvitelli" | `733115117953111` | 4.1 / 4.1 / 34.5 / 12.7 / 10.1 = 65.5 |
| 3 | 3 | 2.7 | `MU.pdf` Sedi estere | `513555335515313` | 4.5 / 4.5 / 34.5 / 12.7 / 9.7 = 65.9 |
| 3 | 3 | 5.3 | `15.pdf` **Milano** | `551131517753135` | 4.1 / 4.1 / 34.5 / 12.7 / 13.1 = 68.5 |
| 3 | 2 | 0.7 | `30.pdf` Siena Odontoiatria | `915553557913111` | 4.5 / 2.6 / 33.0 / 12.7 / 9.7 = 62.5 |
| 3 | 2 | 1.5 | `MU.pdf` Sedi estere | `933113135755133` | 2.6 / 4.1 / 32.6 / 12.7 / 9.7 = 61.7 |
| 3 | 2 | 3.0 | `02.pdf` Bari Aldo Moro | `951335315513335` | 4.1 / 2.6 / 33.0 / 10.8 / 9.7 = 60.2 |

Two rows worth naming because of *how* they differ:

* `513555335515313` (Sedi estere) matches **51 of the 60 questions exactly** — Biology 34.5,
  Chemistry 12.7 and Physics & Maths 9.7 are all perfect, and only the two small sections differ
  (4.5 vs 4.1, 4.5 vs 2.2). If the top of the sheet is the part that is hard to read, this is the
  more likely candidate.
* `551131517753135` (Milano) is the best row for a Milano candidate (3 cells, 68.5).

**Best row per university** is printed by `python3 scripts/match_sheet.py --per-university`
(`49.pdf` 2 cells · `MU.pdf` 3 · `15.pdf` 3 · `30.pdf` 3 · `02.pdf` 3 · `31.pdf` 4 · `03.pdf` 4 ·
`21.pdf` 4 · `26.pdf` 5 · `27.pdf` 5 · `08.pdf` 5 · `18.pdf` 5 · `C6.pdf` 5 · `04.pdf` 6 ·
`19.pdf` 6 · `22.pdf` 6 · `01.pdf` 6 · `10.pdf` 6 · `14.pdf` 8).

If instead the hand-written **63.2** is treated as authoritative, the 60 rows that total exactly
63.2 are the only possible ones, and the closest of those is
`MU.pdf` **`555331115755333`** (2.6 / 2.2 / 33.0 / 15.7 / 9.7, 4 cells, Logical Reasoning and
Physics & Maths identical); in `15.pdf` the four 63.2 rows are `551535135535333`,
`713111117713315`, `751111335733331`, `951555157935531` (8–13 cells away).

---

### The 63.5 alternative: `15.pdf` bar code `955135117755115` (Milano, page 32)

Worth separating out, because it is **the only row in all 18,368 with the vector
4.5 / 2.2 / 34.5 / 13.0 / 9.3 = 63.5** — a unique exact hit on its own numbers.

Against the sheet *as transcribed* (63.2) it is **6 cells** away (rank 94 of 18,362; 89 rows are
closer; 6 rows inside `15.pdf` alone are closer), so it is not the closest match:

| | sheet | `955135117755115` | cells that must change |
|---|---|---|---|
| General Knowledge | 3C 1W 0B = 4.1 | 3C 0W 1B = 4.5 | 1 (Q4 ✗ → blank, +0.4) |
| Logical Reasoning | 2C 2W 1B = 2.2 | 2C 2W 1B = 2.2 | 0 |
| Biology | 23C = 34.5 | 23C = 34.5 | 0 |
| Chemistry | 9C 2W 4B = 12.7 | 10C 5W 0B = 13.0 | **4** (all blanks answered: 1 ✓ + 3 ✗, +0.3) |
| Physics & Maths | 7C 2W 4B = 9.7 | 7C 3W 3B = 9.3 | 1 (one blank → ✗, −0.4) |
| total | 63.2 | 63.5 | **6 of 60** (63.2 + 0.4 + 0.3 − 0.4 = 63.5) |

So it is an all-or-nothing rival hypothesis, not a near miss: the two readings differ only in how
the *empty-looking* cells are read.
* If the sheet really is 44C / 7W / 9B = 63.2 (which is what the hand-written score on it says),
  `733115117953111` wins at 2 cells and this row is 6 cells off.
* If instead the four chemistry blanks (**Q37, Q38, Q41, Q45**) are actually answered — 1 ✓ and
  3 ✗ — and Q4 is blank rather than ✗, the sheet is 45C / 10W / 5B = **63.5** and
  `955135117755115` is the **unique exact match** in the whole corpus.

The two things that settle it: the hand-written total on the sheet (**63.2 or 63.5?**) and whether
Q37/Q38/Q41/Q45 are truly empty or carry faint marks.

## What the answer sheet says

Transcription in `patterns/sheet.txt` (✓ correct, ✗ wrong, · blank), 60 questions:

```
Q1–4   ✓✓✓✗   3C 1W 0B   ->  4.1   (General Knowledge)
Q5–9   ·✗✓✓✗   2C 2W 1B   ->  2.2   (Logical Reasoning)
Q10–32  ✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓✓   23C 0W 0B   ->  34.5   (Biology)
Q33–47  ✓✓✗✗··✓✓·✓✓✓·✓✓   9C 2W 4B   ->  12.7   (Chemistry)
Q48–60  ✗·✓·✓✗·✓✓✓·✓✓   7C 2W 4B   ->  9.7   (Physics & Maths)
```

44 correct × 1.5 − 7 wrong × 0.4 = **63.2**, which is the score written on the sheet, so the
transcription is internally consistent.

## What the files in the repo are

The HTML is the CINECA IMAT portal page *Anonymous Results 2026/2027*
(`/studente/2026/download-risultati-anonimi-universita/<code>`). Each of the 19 PDFs is one
university's anonymous score list — 8 numbers per candidate: bar code, five section scores, total.
**(No PDF contains any answer sheet, per-question data or answer key: the only images in them are
the MUR/CINECA logos.)**

| code | university | candidates | | code | university | candidates |
|---|---|---|---|---|---|---|
| `MU` | Sedi estere | 9,660 | | `18` | Napoli "Federico II" | 391 |
| `02` | Bari Aldo Moro | 429 | | `19` | Padova | 728 |
| `03` | Bologna | 1,295 | | `21` | Parma (sede di Piacenza) | 208 |
| `04` | Cagliari | 226 | | `22` | Pavia | 647 |
| `49` | Campania "L. Vanvitelli" (Napoli) | 282 | | `01` | Politecnica delle Marche | 208 |
| `08` | Catania | 201 | | `26` | Roma "La Sapienza" | 967 |
| `10` | Firenze | 240 | | `27` | Roma "Tor Vergata" | 537 |
| `14` | Messina | 174 | | `30` | Siena Odontoiatria | 96 |
| `15` | Milano | 1,012 | | `31` | Torino (sede di Orbassano) | 728 |
| `C6` | Milano Bicocca (Bergamo) | 339 | | | **total** | **18,368** |

## How the comparison is done

1. **Scoring model, derived from the corpus, not assumed.** Column maxima over all 18,368 rows are
   6.0 / 7.5 / 34.5 / 22.5 / 19.5 = 1.5 × (4, 5, 23, 15, 13) = 60 questions, and the minima are
   −1.6 / −2.0 / −8.8 / −6.0 / −5.2 = −0.4 × (4, 5, 22, 15, 13): **+1.5 correct, −0.4 wrong, 0 blank**
   (the legend on the portal page names the sections General Knowledge, Logical Reasoning, Biology,
   Chemistry, Physics & Mathematics). Every row satisfies s1+…+s5 = total exactly, which is the
   parse-audit used here.
2. **The lists only carry six numbers per candidate** — five section scores and a total. There is no
   per-question data and no answer key published with them, so a 60-cell sheet can only be compared
   through those five numbers. The score of a section admits several (correct, wrong, blank)
   splits; the **cost** of a row is the minimum number of individual question cells that would have
   to have been read differently for that row to be the sheet (all splits are tried, per section).
3. **Result:** cost distribution over the 18,368 rows is 1 row at 2 cells, 6 rows at 3, 16 at 4,
   66 at 5 … — so the top of the ranking is unambiguous.

## Caveats

* An answer-level ("same 60 answers") match is impossible from these files; anything claiming more
  than a match on the five section scores is not verifiable here.
* The published lists are for the **English-language** session (the page title says *IN LINGUA
  INGLESE*). A sheet from the Italian-language session would not be in these files at all, which is
  one possible reason no row matches exactly.
* The three rows above require 2–3 of the 60 marks to have been misread. If the sheet belongs to a
  candidate who sat in a particular seat/university, use the per-university line for that seat: for
  **Milano** it is `551131517753135`.

## Reproduce

```bash
pip install --break-system-packages pymupdf
python3 scripts/parse_lists.py                       # 19 PDFs -> 18,368 rows (all_results.csv)
python3 scripts/match_sheet.py --top 12 --per-university
python3 scripts/match_sheet.py --file patterns/sheet.txt --university 15 --university C6
```

Files added: `scripts/parse_lists.py`, `scripts/match_sheet.py`, `patterns/sheet.txt`,
`all_results.csv` (the full parsed score board, one row per candidate).
