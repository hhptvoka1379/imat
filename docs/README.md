# imat · find yourself in the anonymous results

A very chill, fully in-browser finder for the IMAT 2026 anonymous results.

You mark all 60 of your answers as **sure / unsure / wrong / blank**, the page
recomputes every score vector your answer sheet could possibly produce, and it
looks for that vector in the published results — **only at the location where
you sat the test**. If exactly one person at your location matches, that
person is you.

## using it

1. **pick your location** — the 19 published lists (18 Italian seats + esteri).
2. **mark your 60 answers**
   - `sure` — you answered and you're confident it's correct → **+1.5**
   - `unsure` — you answered but you don't know → **+1.5 or −0.4** (both are tried)
   - `wrong` — you know you got it wrong → **−0.4**
   - `blank` — you left it empty → **0**
3. the **verdict** updates live:
   - **unique** — one person at your location has this result vector: your bar code.
   - **ambiguous** — a few people share the vector; type the bar-code digits you
     remember (typos fine) and the list narrows.
   - **no match** — nobody matches; the closest answer sheets are listed so you
     can find the one mis-remembered state.

Keyboard: <kbd>s</kbd> <kbd>u</kbd> <kbd>w</kbd> <kbd>b</kbd> mark the current
question and move on, <kbd>↑</kbd>/<kbd>↓</kbd> move, <kbd>enter</kbd> jumps to
the verdict. There's also a paste box for all 60 at once.

Your marks autosave to `localStorage` and never leave the tab. There is no
backend, no analytics, no network calls except fetching this folder's own files.

## why “very sure to be the only person” works

Each candidate is published as a **result vector**: five section scores
(General Knowledge · Logical Reasoning · Biology · Chemistry · Physics & Math).
In the full 17,350-sheet dataset, **99.3 % of candidates are the only person at
their location with their exact vector** — and your unsure answers only make the
check stricter: a row must fit *every* score vector your answer sheet can still
produce. The verdict says `unique` only when the location-filtered match count
is exactly one.

## run it locally

It's a static site — any static server works:

```sh
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

## push it as a git website

This folder (`docs/`) is the whole website. Three easy options:

1. **GitHub Pages from this repo** — push the repo, then
   *Settings → Pages → Deploy from a branch → `main` → `/docs`*. Done.
2. **Its own repo** — copy `docs/` to a new repo's root, push, enable Pages.
3. **Any static host** — Netlify/Cloudflare/Vercel: publish directory `docs/`.

No build step, no dependencies, no environment variables.

## data

`data.bin` (458 KiB) holds all 17,350 answer sheets, packed:

```
15 bytes bar code (digit bytes, 255 = not published) + 6 × int16 section scores
```

in tenths of a point, grouped by location so filtering is a slice. It decodes
into typed arrays in well under a millisecond; matching 17k rows is ~10⁵
integer ops.

Rebuild pipeline (from the repo root):

```sh
python3 tools/extract_results.py     # PDFs → data/results.csv   (validated)
python3 tools/build_site_data.py     # CSV  → docs/data.bin       (round-trip checked)
```

Every extracted row is verified two ways: `total = s1+…+s5`, and each score must
decompose into the official +1.5 / −0.4 / 0 marking scheme.

## companion scripts (repo `tools/`)

- `fuzzy_search.py` — typo-tolerant search over the whole dataset:
  `python3 tools/fuzzy_search.py bicoca`, `… pavia 65.5`, `… 5111 5335 7351`
- `match_answers.py` — the same matcher from the terminal:
  `python3 tools/match_answers.py --sede bologna SSSU…(60 chars)`

## provenance

Anonymous results published by MUR / CINECA at `imat.cineca.it` for the
2026/2027 admission cycle (saved 8 Oct 2026), one PDF per location. Scores are
as published; bar codes are as published (some sheets carry no bar code).
