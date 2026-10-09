# imat

Scratch space for the IMAT (Medicine/Dentistry/Veterinary, English-language, Italy)
2026/2027 results season: the CINECA **Anonymous Results** pages and the per-sede
result PDFs that go with them.

```
MU.pdf, 01.pdf … 49.pdf, C6.pdf   one per test sede (image-only PDFs, ~7 pages each)
MEDICINA, …html                   the saved imat.cineca.it anonymous-results page
tools/imat_fuzzy.py               the fuzzy search engine + dataset packer (python, stdlib only)
web/                              the site: paint your answers, find your row, see how sure it is
```

## the tool

**[`web/`](web/README.md)** is a self-contained, no-build static page: you paint
`sure / unsure / wrong / blank` over the 60 questions, say which sede you sat in, and it
searches ~18,000 rows of answers in your browser — 1.2 ms for a cold search, 9 µs per
keystroke — and reports the best row, how many rows are indistinguishable from it, how many
bits your pattern is worth, and a Monte-Carlo estimate of how reliable a recall like yours
actually is. Push that folder to a repo and turn on Pages: it needs nothing else.

```bash
tools/build_site.sh                      # synthetic 18k demo -> web/data/imat.bin, then preview
tools/build_site.sh path/to/your.csv     # your real table instead
cd web && python3 -m http.server 8080    # http://localhost:8080
```

**[`tools/imat_fuzzy.py`](tools/imat_fuzzy.py)** is the same algorithm as a CLI, and also the
reference implementation the browser engine is parity-tested against:

```bash
python3 tools/imat_fuzzy.py demo      --rows 18000 --out data/imat-demo.csv
python3 tools/imat_fuzzy.py build     --csv data/imat-demo.csv --out web/data/imat.bin
python3 tools/imat_fuzzy.py search    --bin web/data/imat.bin --sede milano \
                                        --answers "1-14=sure,15-22=unsure,23=w,24=b" --diff
python3 tools/imat_fuzzy.py validate  --bin web/data/imat.bin --sede Milano --trials 300
python3 tools/imat_fuzzy.py info      web/data/imat.bin
python3 tools/imat_fuzzy.py score     --bin web/data/imat.bin --answers "1-40=sure,41-50=u"
```

Everything runs locally. No dataset is committed; the one in `web/data/` is synthetic.
