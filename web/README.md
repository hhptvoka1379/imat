# imat · find your line

Fuzzy search over a big table of per-question answers (the ~18,000-row IMAT anonymous
answer dataset, or any other table of the same shape). You paint what you remember —
**sure / unsure / wrong / blank** — pick the seat you sat in, and it tells you which row
in the whole dataset is yours, *and how sure that can be*.

Static folder. No build step, no bundler, no framework, no dependencies to run it.
Open `index.html`, or serve it, or push this whole folder to a repo and turn Pages on.

---

## 1 · using it

```bash
cd web && python3 -m http.server 8080      # or: npm run serve
```

Then <http://localhost:8080>. (Double-clicking `index.html` also works — the page detects
that `file://` has no workers and runs the same engine on the main thread instead.)

1. **Pick a brush** — `sure` (I'm sure that one landed), `unsure` (I answered, no idea if it
   hit), `wrong` (I'm sure I botched it), `blank` (never answered / never got there), `erase`.
2. **Paint the deck.** Click a square, or drag across a run of them, or use the keyboard:
   `s` `u` `w` `b` paint at the cursor and step forward, `←↑↓→` / `hjkl` move, digits then
   `↵` jump to `q37`, `Backspace` erases, `z` undoes, `Esc` cancels a pending jump.
   There are only 60 squares; the keyboard path takes about ten seconds.
3. **Type it instead**, if that is faster for you — the box under the deck takes
   `1-14=sure, 15-22=unsure, 23=wrong, 24=blank` or a packed run `ssuwwb…` (one char per
   question from q1). `apply` replaces the deck, `merge` only touches what you named.
4. **Say where you sat.** The field is a fuzzy match, not a dropdown you have to guess:
   `milan`, `roma sapienza`, `pado`, `bicoca` all land somewhere sensible, and it says out
   loud what it read. Leave it empty to search every sede at once.
5. Read the panel.

Fill in nothing and the pool is everyone. Fill in more and the pool collapses. The panel is
honest about where it stands the whole way.

## 2 · the panel, and what "sure" actually means

| field | meaning |
|---|---|
| **best cost** | how badly the winning row contradicts you. `0` = it agrees with every cell you filled. `6.0` = one cell clearly disagrees. Lower is better. |
| **indistinguishable** | how many rows sit within 2.0 of the best. `1` means *nothing else in this pool can be you*. This is the number that matters. |
| **pattern entropy** | `-Σ log₂ p` of your cells within this pool: how many bits your pattern is worth. `log₂(pool)` is what you need to be alone, so 947 rows in Milano ⇒ ~10 bits is the bar, ~25 bits is comfortable. |
| **look-alikes expected** | `(pool − 1) · 2^−bits`. Assumes the questions are independent, which they are *not* — strong candidates look alike, so treat this as optimistic and trust **indistinguishable** more. |
| **your score band** | `+1.5` per `sure`, `−0.4` per `wrong`, `0` per `blank`, and *both ends* for `unsure` — that is the score range your own memory allows. |
| **how sure can I be?** | Monte-Carlo, no model: takes real rows out of this pool, blurs them with *your* fill ratio and *your* share of `unsure`, reruns the whole search, and reports how often it lands on exactly one row and whether that row was the right one. The only number here that is measured rather than assumed. |

Measured on the demo set (synthetic, 947 rows/sede, 40 of 60 cells filled, 25 % forgotten,
30 % downgraded to *unsure*, 6 % misremembered): **87 % of the time you get exactly one row
and it is the right one**, 95 % of the time it is in the top 3. Without the sede filter —
18,000 rows — it is 73 %. The location filter is not cosmetic.

## 3 · your data

Two shapes are auto-detected; nothing is configured unless you want to override it.

**A · compact** — one column holds the whole row, one character per question:

```csv
code,sede,answers,total score
7F21A0,Milano,cwcwwdccdb…,68.4
```

**B · wide** — one column per question (header `q1…q60`, or `1…60`, or `section1…`):

```csv
code,sede,q1,q2,q3,…
7F21A0,Milano,correct,wrong,blank,…
```

Cells may say anything recognisable — `correct/right/c/s/1/true`, `wrong/incorrect/w/x/2/n`,
`blank/skip/-/0/""`, `unseen/notseen/3/exit` — or an **A–E letter**, in which case pass
`--key` and it becomes correct/wrong against the key. Column mapping is detected by name;
`--answers-col`, `--sede-col`, `--chars`, `--nq` override it.

Extra columns are carried along and displayed (a `code`-ish column becomes the label of a
hit, a `score`-ish one its right-hand side), so you can find your answer-sheet code and your
sections in one look.

### bake it

```bash
tools/build_site.sh path/to/your.csv
# or directly:
python3 tools/imat_fuzzy.py build --csv your.csv --out web/data/imat.bin \
  --sections "General Knowledge=1-6,Logical Reasoning=7-19,Biology=20-37,Chemistry=38-50,Physics & Mathematics=51-60"
```

`web/data/imat.bin` is the whole index: 2 bits per question per row (18,000 × 60 = 270 KB),
one byte per row for the sede, and your numeric/string columns. `--no-extra` ships just the
answer core. That file is the only thing the page needs at startup, and it is small enough
that a repo is a fine place for it.

**You never have to commit your data.** Drop the `.csv` (or a `.bin`) onto the page and it is
parsed in the worker in that tab and never leaves the device; the packed result is kept in
IndexedDB so the next load is instant. Clearing site data clears it.

### from the terminal

```bash
python3 tools/imat_fuzzy.py search --bin web/data/imat.bin --sede milano \
    --answers "1-14=sure,15-22=unsure,23=w,24=b" --diff --top 5
python3 tools/imat_fuzzy.py score  --bin web/data/imat.bin --answers "1-40=sure,41-50=u"
python3 tools/imat_fuzzy.py info   web/data/imat.bin      # geometry, per-sede counts, which questions discriminate
python3 tools/imat_fuzzy.py locate web/data/imat.bin "tor vergatta"
python3 tools/imat_fuzzy.py validate --bin web/data/imat.bin --sede Milano --trials 300
```

Same cost table, same blob format, both directions verified against each other.

## 4 · push it as a website

```bash
cd web
git init -b main && git add -A && git commit -m "find your line"
gh repo create imat-line --public --source=. --push     # or: gh repo create imat-line --private ...
gh api -X POST repos/:owner/imat-line/pages
```

Pages serves the folder as-is (`.nojekyll` is there so it does not try to build Jekyll).
`.github/workflows/pages.yml` is included for the case where this folder *is* the repo root:
it deploys with zero configuration. Settings → Pages → Source: GitHub Actions.
A custom domain is a `CNAME` file here plus the DNS record.

If your dataset is private, keep it out of git: commit everything except `data/imat.bin`,
and paste your CSV into the page on each visit (or serve the folder some other way).

## 5 · why it is fast

| | |
|---|---|
| cold search, 18,000 × 40 filled cells | **1.2 ms** |
| rank + count (histogram, no sort) | **0.07 ms** |
| painting one cell (what you feel per keystroke) | **9 µs** |
| dataset in memory | 270 KB of codes for 18k×60 |
| JS ↔ data | typed arrays only; `Uint8Array` planes, `Int32Array` costs, `Int32Array` row lists |
| main thread | untouched — everything above happens in a worker |

Four ideas, nothing exotic:

1. **2 bits per question** so 36 rows fit in one cache line; the whole dataset is resident.
2. **Question-major planes** (`planes[q][row]`) so scoring one question is a straight-line
   pass over a `Uint8Array`, and the cost is a 4-entry LUT — no branches, no allocation.
3. **The cost array is kept alive.** Painting cell *q* folds
   `COST[new][state] − COST[old][state]` into it, so an edit is O(pool) instead of O(pool × 60).
   That is why live feedback while you paint is free.
4. **Ranking is a counting sort** over the cost histogram (costs are small integers), and the
   "indistinguishable" count is just a sum of adjacent buckets.

The search therefore runs on every keystroke rather than on a button, and the number you see
in the corner is the measured time of that search.

## 6 · files

```
index.html      the page
app.js          UI: brush, deck, keyboard, drop, persistence, panel
core.js         the message protocol (shared by worker and inline fallback)
engine.js       the algorithm: parse, index, score, rank, entropy, Monte-Carlo, CSV, blob
worker.js       4 lines: importScripts(core) + onmessage
style.css       the chill part
data/imat.bin   the index the page loads at boot (synthetic demo — replace me)
tests/          engine.test.js (71, no deps) · parity.js (20, needs python3) · ui.test.js (39, needs jsdom)
```

```bash
npm i -D jsdom && npm run test:all     # 130 assertions across all three
```

## 7 · a note on what this is

The dataset is anonymous because people handed over their answers expecting that to hold.
This tool does not de-anonymise anyone by itself — it can only tell you which row *your own*
memory matches, and to match somebody else's row you would already need their exact answer
sheet in hand, which is not something you can get from here. Nothing is uploaded, nothing is
logged, no request leaves the page but the two files it loads from its own folder.

Be decent about what you do with the row you find. And if you ship this to your course-mates,
keep the "how sure can I be?" panel in: it exists so that nobody mistakes a plausible
match for a proven one.
