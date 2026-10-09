# imat

IMAT 2026/2027 anonymous results — archived PDFs, extracted dataset, and a
very chill in-browser finder.

- `docs/` — **the website**. mark your 60 answers (sure / unsure / wrong /
  blank), it filters the published results to the location where you sat the
  test and tells you when your result vector can only be you. runs fully in the
  browser, on packed binary data. push the folder (or enable GitHub Pages with
  `main / docs`) and it's live.
- `data/results.csv` — all 17,350 answer sheets extracted and validated from
  the PDFs (bar code, five section scores, total, location).
- `tools/`
  - `fuzzy_search.py` — fuzzy search script over the dataset (seat names,
    bar-code fragments, scores — typos welcome).
  - `match_answers.py` — the "find me" matcher for the terminal.
  - `extract_results.py` — PDFs → CSV (checksum + marking-scheme validated).
  - `build_site_data.py` — CSV → `docs/data.bin`.
- `*.pdf` — the official per-location result lists, as published on
  `imat.cineca.it` (MU = sedi estere).
- `MEDICINA, ODONTOIATRIA E VETERINARIA IN LINGUA INGLESE.html` — saved page of
  the official anonymous-results portal (also the source of the location names).

quick start:

```sh
cd docs && python3 -m http.server 8000      # the website
python3 tools/fuzzy_search.py bicoca        # the fuzzy search script
```
