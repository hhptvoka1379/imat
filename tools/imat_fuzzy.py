#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
imat_fuzzy.py — fuzzy search over a big "answer vector" dataset (e.g. the ~18k IMAT
anonymous / community-survey answers), plus the packer that turns the raw CSV into the
tiny binary blob the browser site reads.

Why "fuzzy": a candidate does not have their official per-question result in front of them.
They remember roughly: "q12 I was sure about", "q31 I guessed", "q44 definitely botched",
"q50 never got to it". So the query is not a vector, it's a *pattern with uncertainty*, and
the right answer is a ranked list plus an honest statement of how unique that pattern is.

Cost model (see COST below): every (query_state, data_state) pair has a cost; the best row is
the cheapest. Lower is better, 0 = perfect match on every question you filled in.

Commands
  demo      generate a synthetic dataset that looks like the real thing (default 18,000 rows)
  build     raw CSV/TSV  ->  web/data/imat.bin  (+ prints a summary)
  info      inspect a .bin (geometry, sedi, state histogram, how discriminating each question is)
  search    the fuzzy search itself (flags below, or --interactive)
  score     points from an answer pattern (IMAT marking: +1.5 right, -0.4 wrong, 0 blank)
  validate  how often a real row can be uniquely recovered from a fuzzy recall of itself
  locate    fuzzy string match a test-centre name against the sedi in a .bin

Examples
  python3 tools/imat_fuzzy.py demo --rows 18000 --out data/imat-demo.csv
  python3 tools/imat_fuzzy.py build --csv data/imat-demo.csv --out web/data/imat.bin
  python3 tools/imat_fuzzy.py search --bin web/data/imat.bin --sede Milano \\
      --answers "1-14=sure,15-22=unsure,23=w,24=b"
  python3 tools/imat_fuzzy.py validate --bin web/data/imat.bin --sede Milano --trials 400

Stdlib only. No deps, no network.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import random
import re
import struct
import sys
import tempfile
import time
from collections import Counter

# --------------------------------------------------------------------------- states & costs

# What a row of the dataset can say about one question. Four slots, always.
DATA_STATES = ("correct", "wrong", "blank", "unseen")
# What the human on the other end of the form can say about one question.
QUERY_STATES = ("unset", "sure", "unsure", "wrong", "blank")

# cost[query_state][data_state] — the whole "fuzzy" idea lives in this one table.
# Numbers are "surprise units"; only their ratios matter. ~6 = one clearly-wrong cell,
# which is worth roughly six softly-penalised cells.
COST = {
    "unset":  [0.0, 0.0, 0.0, 0.0],   # don't care, don't count it
    "sure":   [0.0, 6.0, 6.5, 6.5],   # you say right  -> row must say right
    "unsure": [0.5, 0.5, 4.5, 4.5],   # you answered, who knows if it landed
    "wrong":  [6.0, 0.0, 5.0, 5.0],   # you say missed -> row must have missed it
    "blank":  [6.0, 6.0, 0.0, 0.0],   # you say skipped -> row must have skipped it
}

# How much a "sure/unsure/wrong/blank" key is trusted when turning it into a query state.
STATE_CHARS = {
    "s": "sure", "c": "sure", "1": "sure", "sure": "sure", "ok": "sure", "right": "sure",
    "u": "unsure", "g": "unsure", "m": "unsure", "2": "unsure", "unsure": "unsure",
    "guess": "unsure", "maybe": "unsure", "w": "wrong", "x": "wrong", "3": "wrong",
    "wrong": "wrong", "bad": "wrong", "miss": "wrong",
    "b": "blank", "-": "blank", "_": "blank", "0": "blank", "blank": "blank",
    "skip": "blank", "none": "blank", "": "unset", "?": "unset", ".": "unset",
    "n": "unset", "unset": "unset",
}

# What one cell of the raw dataset can say. Anything recognisable maps into DATA_STATES.
DATA_CHARS = {
    "c": 0, "correct": 0, "right": 0, "s": 0, "sure": 0, "ok": 0, "1": 0, "y": 0, "true": 0,
    "w": 1, "wrong": 1, "x": 1, "incorrect": 1, "incorrecto": 1, "bad": 1, "2": 1, "n": 1,
    "false": 1, "u": 1, "unsure": 1, "guess": 1,
    "b": 2, "blank": 2, "": 2, "skip": 2, "-": 2, "_": 2, "0": 2, "none": 2,
    "unanswered": 2, "not answered": 2, "na": 2,
    "nseen": 3, "unseen": 3, "notseen": 3, "not_seen": 3, "ns": 3, "3": 3, "e": 3,
    "exit": 3, "not reached": 3, "did not see": 3,
}

MAGIC = b"IMATFSH1"
POINTS_CORRECT = 1.5
POINTS_WRONG = -0.4
POINTS_BLANK = 0.0


# --------------------------------------------------------------------------- tiny helpers

def die(msg: str, code: int = 2) -> "NoReturn":
    sys.stderr.write(f"error: {msg}\n")
    raise SystemExit(code)


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024
    return f"{n:.1f}TB"


deflev = None  # set lazily; used by the fuzzy string matcher


def edit_distance(a: str, b: str, cap: int = 3) -> int:
    """Bounded Levenshtein — just enough for 'did you mean' on a test-centre name."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        best = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            cur.append(v)
            best = v if v < best else best
        if best > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def fuzzy_locate(needle: str, choices: list[str], top: int = 5) -> list[tuple[int, str, int]]:
    """Rank `choices` by how well `needle` matches them.

    Subsequence-with-contiguity bonus (the fzf flavour) *and* edit distance (the typo flavour).
    Returns [(rank, choice, score)] best-first.
    """
    n = norm(needle)
    scored = []
    for i, c in enumerate(choices):
        cn = norm(c)
        if not n:
            scored.append((0, c, 0))
            continue
        score = 0
        if cn == n:
            score += 1000
        if cn.startswith(n) or cn.startswith(n + " "):
            score += 120
        if f" {n}" in f" {cn}":          # word-prefix hit
            score += 90
        if n in cn:
            score += 60
        # subsequence
        it = iter(cn)
        if all(ch in it for ch in n):
            score += 25
        d = edit_distance(n, cn, cap=max(4, len(n) // 2))
        score += max(0, 40 - 8 * d)
        scored.append((score, c, i))
    scored.sort(key=lambda t: (-t[0], t[2]))
    return [(i, c, s) for s, c, i in scored[:top]]


# --------------------------------------------------------------------------- blob format


class Dataset:
    """Packed answer dataset. 2 bits per question per row => the 18k x 60 core is ~280 KB."""

    __slots__ = ("nrows", "nq", "sedi", "state_names", "row_sede", "codes", "num", "strs",
                 "meta", "stride", "path")

    def __init__(self, **kw):
        self.path = ""
        for k in ("nrows", "nq", "sedi", "state_names", "row_sede", "codes", "num", "strs",
                  "meta", "stride"):
            setattr(self, k, kw.get(k))

    # ---- io

    def write(self, path: str) -> int:
        out = io.BytesIO()
        w = out.write
        num_names = [c["name"] for c in self.meta.get("num_cols", [])]
        str_names = [c["name"] for c in self.meta.get("str_cols", [])]
        w(MAGIC)
        head_fmt = "<IIHHHHHI"
        w(struct.pack(head_fmt, 1, self.nrows, self.nq, len(self.sedi), 4,
                      len(num_names), len(str_names), self.stride))
        for s in self.sedi + list(self.state_names) + num_names + str_names:
            b = s.encode("utf-8")
            w(struct.pack("<H", len(b)))
            w(b)
        w(bytes(self.row_sede))
        w(self.codes)                                   # bytes, row-major 2-bit
        for name in num_names:
            col = self.num[name]
            w(struct.pack(f"<{len(col)}f", *col))
        for name in str_names:
            col = self.strs[name]
            offs, acc = [], 0
            for v in col:
                offs.append(acc)
                acc += len(v.encode("utf-8"))
            w(struct.pack(f"<{len(offs) + 1}I", *offs, acc))
            w(b"".join(v.encode("utf-8") for v in col))
        mj = json.dumps(self.meta, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        w(struct.pack("<I", len(mj)))
        w(mj)
        data = out.getvalue()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return len(data)

    @classmethod
    def read(cls, path: str) -> "Dataset":
        with open(path, "rb") as fh:
            buf = fh.read()
        if buf[:8] != MAGIC:
            die(f"{path}: not an IMAT fuzzy blob (bad magic)")
        p = 8
        ver, nrows, nq, nsedi, nstates, nnum, nstr, stride = struct.unpack_from("<IIHHHHHI", buf, p)
        p += struct.calcsize("<IIHHHHHI")
        if ver != 1:
            die(f"{path}: blob version {ver} not supported")
        def name_list(k):
            nonlocal p
            out = []
            for _ in range(k):
                (ln,) = struct.unpack_from("<H", buf, p)
                p += 2
                out.append(buf[p:p + ln].decode("utf-8"))
                p += ln
            return out
        sedi = name_list(nsedi)
        state_names = name_list(nstates)
        num_names = name_list(nnum)
        str_names = name_list(nstr)
        row_sede = buf[p:p + nrows]
        p += nrows
        codes = buf[p:p + nrows * stride]
        p += nrows * stride
        num = {}
        for name in num_names:
            num[name] = list(struct.unpack_from(f"<{nrows}f", buf, p))
            p += 4 * nrows
        strs = {}
        for name in str_names:
            offs = struct.unpack_from(f"<{nrows + 1}I", buf, p)
            p += 4 * (nrows + 1)
            end = offs[-1]
            blob = buf[p:p + end]
            p += end
            strs[name] = [blob[offs[i]:offs[i + 1]].decode("utf-8") for i in range(nrows)]
        (mjlen,) = struct.unpack_from("<I", buf, p)
        p += 4
        meta = json.loads(buf[p:p + mjlen].decode("utf-8")) if mjlen else {}
        ds = cls(nrows=nrows, nq=nq, sedi=sedi, state_names=state_names, row_sede=row_sede,
                 codes=codes, num=num, strs=strs, meta=meta, stride=stride)
        ds.path = path
        return ds

    # ---- access

    def cell(self, row: int, q: int) -> int:
        return (self.codes[row * self.stride + (q >> 2)] >> ((q & 3) * 2)) & 3

    def row_cells(self, row: int) -> list[int]:
        base = row * self.stride
        c = self.codes
        out = []
        for q in range(self.nq):
            out.append((c[base + (q >> 2)] >> ((q & 3) * 2)) & 3)
        return out

    def rows_in_sede(self, sede_idx: int | None) -> list[int]:
        if sede_idx is None:
            return list(range(self.nrows))
        return [i for i, s in enumerate(self.row_sede) if s == sede_idx]

    def row_info(self, row: int) -> dict:
        d = {"i": row, "sede": self.sedi[self.row_sede[row]]}
        for name, col in self.num.items():
            d[name] = col[row]
        for name, col in self.strs.items():
            d[name] = col[row]
        return d

    # ---- stats used by the uniqueness estimate

    def sede_counts(self, sede_idx: int | None) -> list[Counter]:
        rows = self.rows_in_sede(sede_idx)
        counts = [Counter() for _ in range(self.nq)]
        for r in rows:
            cs = self.row_cells(r)
            for q in range(self.nq):
                counts[q][cs[q]] += 1
        return counts

    def bits_for(self, query: list[int], counts: list[Counter]) -> float:
        """Self-information of the answer pattern inside this sede: how much a match is worth.

        Naive (assumes questions are independent), so it is an *upper* bound on true
        uniqueness — real answers correlate (strong candidates agree with each other),
        which is exactly what `validate` measures instead.
        """
        tot = sum(counts[0].values()) or 1
        bits = 0.0
        for q, s in enumerate(query):
            if s == 0:
                continue
            # the pattern is a *set* of allowed data states; use their combined mass
            allowed = [d for d in range(4) if COST[QUERY_STATES[s]][d] <= 0.5]
            if not allowed:
                continue
            m = sum(counts[q][d] for d in allowed)
            p = (m + 1) / (tot + 4)
            if p > 0:
                bits += -math.log2(p)
        return bits


def expected_collisions(bits: float, pool: int) -> float:
    """Rough 'how many other humans in this pool look the same to you' figure."""
    if pool <= 1:
        return 0.0
    return (pool - 1) * 2.0 ** (-bits)


# --------------------------------------------------------------------------- query parsing

def parse_query(spec: str, nq: int, start: int = 1) -> list[int]:
    """'1-14=sure, 15 u, 23=wrong, 24=b'  ->  [0|1..4] * nq

    Accepted forms (comma / space / semicolon separated):
      Q=state            12=sure
      Q1-Q2=state        12-20=unsure
      Q state            12 sure
      bare states        s,u,u,w,b          (fills from the next free question on)
      packed string      "ssuwwwbb...."     (one char per question, in order)
    """
    q = [0] * nq
    if spec is None:
        return q
    spec = spec.strip()
    if not spec:
        return q
    # packed run: "suwbwuw..." with no separators -> positional
    if re.fullmatch(r"[sc1u2gwxb\-_?\.n ]+", spec) and len(spec.replace(" ", "")) > 6 \
            and "," not in spec and "=" not in spec and "-" not in spec:
        for i, ch in enumerate(spec.replace(" ", "")):
            if i >= nq:
                break
            st = STATE_CHARS.get(ch.lower())
            if st:
                q[i] = QUERY_STATES.index(st)
        return q
    auto = 0
    for tok in re.split(r"[,;\n]+", spec):
        tok = tok.strip()
        if not tok:
            continue
        m = re.fullmatch(r"(?:(\d+)(?:\s*[-:]\s*(\d+))?)\s*[= ]\s*(\w+)", tok, re.I)
        if m:
            a = int(m.group(1))
            b = int(m.group(2) or a)
            st = STATE_CHARS.get(m.group(3).lower())
            if not st:
                die(f"unknown state {m.group(3)!r} in {tok!r} (use sure/unsure/wrong/blank/? )")
            si = QUERY_STATES.index(st)
            for i in range(a - start, b - start + 1):
                if 0 <= i < nq:
                    q[i] = si
            continue
        m = re.fullmatch(r"(?:(\d+)(?:\s*[-:]\s*(\d+))?)\s*([sc1u2gwxb\-_?.])", tok)
        if m:
            a = int(m.group(1))
            b = int(m.group(2) or a)
            st = STATE_CHARS.get(m.group(3).lower())
            si = QUERY_STATES.index(st)
            for i in range(a - start, b - start + 1):
                if 0 <= i < nq:
                    q[i] = si
            continue
        m = re.fullmatch(r"(\d+)([sc1u2gwxb\-_?.])", tok)
        if m:
            i = int(m.group(1)) - start
            if 0 <= i < nq:
                q[i] = QUERY_STATES.index(STATE_CHARS[m.group(2).lower()])
            continue
        m = re.fullmatch(r"([sc1u2gwxb\-_?.])", tok)
        if m:
            if auto < nq:
                q[auto] = QUERY_STATES.index(STATE_CHARS[m.group(1).lower()])
                auto += 1
            continue
        die(f"can't parse answer token {tok!r}")
    return q


def load_query(args, nq: int) -> list[int]:
    parts = []
    if getattr(args, "answers", None):
        parts.append(args.answers)
    if getattr(args, "file", None):
        with open(args.file, encoding="utf-8") as fh:
            for line in fh:
                s = line.split("#", 1)[0].strip()
                if re.fullmatch(r"\d+\s*\S+", s):        # "12 sure" -> keep as token
                    parts.append(s)
                elif s and not s.isdigit():
                    parts.append(s)
                elif s:
                    parts.append(s)
    return parse_query(",".join(parts), nq, start=getattr(args, "start", 1) or 1)


# --------------------------------------------------------------------------- search core

def search(ds: Dataset, query: list[int], sede_idx: int | None = None, top: int = 10,
           tol: float = 2.0) -> dict:
    """Return the cheapest `top` rows in the pool, plus how alone at the top the winner is."""
    cost = {k: COST[k] for k in QUERY_STATES}
    used = [q for q in range(ds.nq) if query[q]]
    if not used:
        die("empty query — nothing to match on")
    rows = ds.rows_in_sede(sede_idx)
    codes, stride, nq = ds.codes, ds.stride, ds.nq
    costs = [0.0] * ds.nrows
    for q in used:
        lut = cost[QUERY_STATES[query[q]]]
        shift, mask = (q & 3) * 2, 3 << ((q & 3) * 2)
        byte_off = q >> 2
        for i in rows:                            # one sequential pass per answered question
            st = (codes[i * stride + byte_off] & mask) >> shift
            costs[i] += lut[st]
    order = sorted(rows, key=lambda i: costs[i])
    best = costs[order[0]]
    close = [i for i in order if costs[i] <= best + tol]
    counts = ds.sede_counts(sede_idx)
    bits = ds.bits_for(query, counts)
    pool = len(rows)
    win_cells = ds.row_cells(order[0])
    hard = sum(1 for q in used if COST[QUERY_STATES[query[q]]][win_cells[q]] >= 6.0)
    soft = sum(1 for q in used if 0.5 < COST[QUERY_STATES[query[q]]][win_cells[q]] < 6.0)
    # gap = how far until the *quality* drops (next distinct cost), not the next row,
    # so a pile of equal-cost rows does not make a strong hit look shaky. Same in JS.
    tie_gap = 0.0
    for i in order:
        if costs[i] > best + 1e-12:
            tie_gap = costs[i] - best
            break
    return {
        "pool": pool,
        "answered": len(used),
        "best": best,
        "hard": hard,
        "soft": soft,
        "gap": tie_gap,
        "ambiguous": len(close),
        "bits": bits,
        "expected_collisions": expected_collisions(bits, pool),
        "hits": [{"row": i, "cost": costs[i], **ds.row_info(i),
                  "cells": ds.row_cells(i)} for i in order[:top]],
    }


def verdict(res: dict) -> str:
    """Same wording rules as verdict() in web/engine.js."""
    if res["best"] == 0 and res["ambiguous"] == 1 and res["hard"] == 0:
        if res["bits"] >= 14 and res["expected_collisions"] < 0.05:
            return "ALONE — this pattern is effectively a fingerprint."
        return "only exact match, but not enough filled in to swear to it"
    if res["hard"] >= 2:
        return (f"no convincing match — the best row still flatly contradicts you on "
                f"{res['hard']} cells (see --diff)")
    if res["ambiguous"] == 1 and res["hard"] == 0:
        return "only compatible row in this pool"
    if res["ambiguous"] == 1:
        return "only near match, but it contradicts 1 cell — verify a section score"
    if res["ambiguous"] <= 3:
        return f"{res['ambiguous']} indistinguishable rows — ask one more question"
    return f"{res['ambiguous']} plausible rows — keep filling in"


# --------------------------------------------------------------------------- CSV ingestion

NUM_HINT = re.compile(r"(score|punteggio|total|logic|biolog|chemis|physic|math|general|"
                      r"knowledge|percentile|rank|n^|q[0-9])", re.I)
CODE_HINT = re.compile(r"(code|codice|id|anon|answer sheet|foglio)", re.I)
SEDE_HINT = re.compile(r"(sede|location|centre|center|univ|site|city|citt)", re.I)
STATE_HINT = re.compile(r"^(q\s*\.?\s*)?\d+$|^(?:section|subject)?[_.-]?\d+$", re.I)


def sniff(path: str, limit_rows: int | None = 400):
    """Peek at the top of a table: delimiter, header, a few rows. Detection only."""
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        head = fh.read(64 * 1024)
    fmt = "tsv" if head.count("\t") > head.count(",") else "csv"
    delim = "\t" if fmt == "tsv" else ","
    rows = read_table(path, delim, limit_rows)
    return fmt, delim, rows[0] if rows else [], rows[1:]


def read_table(path: str, delim: str = ",", limit_rows: int | None = None,
               skip_header: bool = False):
    """Stream every row of a csv/tsv (or a file of them). limit_rows=None -> everything."""
    out = []
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        rdr = csv.reader(fh, delimiter=delim)
        for i, row in enumerate(rdr):
            if limit_rows is not None and i >= limit_rows:
                break
            if row:
                out.append(row)
    if skip_header and out:
        out = out[1:]
    return out


def build_from_csv(path, out, answers_col=None, key=None, sede_col=None,
                   chars="cwdn", nq=None, sections=None, note="", limit=None, quiet=False,
                   no_extra=False):
    """Auto-detect the shape of the raw table and pack it. Two supported layouts:

    A) wide: one column per question, cells say correct/wrong/blank (or a letter, with --key)
    B) compact: one column holding all answers as a string, one char per question
                (default mapping c=correct w=wrong d=blank n=unseen; --chars to change)
    """
    fmt, delim, header, _sample = sniff(path, limit_rows=400)
    if not header:
        die(f"{path}: empty")
    # header sniffed from the first rows only; for the real thing stream the whole file
    body = read_table(path, delim, limit_rows=(limit + 1) if limit else None)
    if body and body[0] == header:
        body = body[1:]
    if not body:
        die(f"{path}: header only / no data rows")
    idx = {h.strip(): i for i, h in enumerate(header)}
    ncols = len(header)
    used_any = False

    # ---- which columns are the questions
    if answers_col and answers_col in idx:
        col = idx[answers_col]
        cand = None
        width = max(len(r[col].strip()) for r in body if len(r) > col)
        nq_eff = nq or width
        if width < 4:
            die(f"column {answers_col!r} looks numeric, not a packed answer string")
    else:
        cand = [i for i, h in enumerate(header) if STATE_HINT.match(h.strip())
                and i != 0]
        if nq:
            cand = cand[:nq]
        if not cand:
            die("no per-question columns found; pass --answers-col <compact column> "
                f"(columns: {', '.join(header[:12])}...)")
        nq_eff = nq or len(cand)
    used_any = True

    # ---- answer key (letters -> correct/wrong)
    key_states = None
    if key:
        key_states = parse_key(key, nq_eff)

    char_map = {}
    for i, ch in enumerate(chars):
        char_map[ch.lower()] = min(3, i if i < 3 else 2)
    # chars="cwdn" -> c:0(correct) w:1(wrong) d:2(blank) n:3(unseen)
    char_map = {}
    slots = [0, 1, 2, 3]
    for i, ch in enumerate(chars):
        char_map[ch.lower()] = slots[i] if i < 4 else 2

    # ---- sede column
    sede_col_i = None
    if sede_col and sede_col in idx:
        sede_col_i = idx[sede_col]
    else:
        for i, h in enumerate(header):
            if SEDE_HINT.search(h):
                sede_col_i = i
                break

    def cell_to_state(txt: str) -> int:
        t = (txt or "").strip()
        low = t.lower()
        if low in DATA_CHARS:
            return DATA_CHARS[low]
        if len(t) == 1:
            m = char_map.get(t.lower())
            if m is not None:
                return m
        if key_states is not None and re.fullmatch(r"[A-Ea-e]", t):
            return 0 if t.upper() == key_letters[ord(t.upper()) - 65] else 1
        nums = re.findall(r"-?\d+", t)
        if nums and len(nums) == 1 and 1 <= int(nums[0]) <= 5 and re.fullmatch(
                r"\s*[A-Ea-e]?\s*\d+\s*", t):
            return 0 if int(nums[0]) == 0 else 1
        raise ValueError(f"unmapped cell {txt!r}")

    if no_extra:
        extra_num, extra_str = [], []
    else:
        extra_num = [h for i, h in enumerate(header)
                     if NUM_HINT.search(h) and (cand is None or i not in cand)]
        extra_str = [h for i, h in enumerate(header)
                     if CODE_HINT.search(h) and (cand is None or i not in cand)]
        if sede_col_i is not None:
            drop = header[sede_col_i].strip()
            extra_num = [x for x in extra_num if x != drop]
            extra_str = [x for x in extra_str if x != drop]

    sede_names: list[str] = []
    sede_ix: dict[str, int] = {}
    rows_codes = bytearray()
    stride = (nq_eff + 3) // 4
    rows_sede = bytearray()
    nums = {h: [] for h in extra_num}
    strs = {h: [] for h in extra_str}
    bad = 0
    for r_i, row in enumerate(body):
        cells = [0] * nq_eff
        try:
            if answers_col:
                s = (row[idx[answers_col]] if len(row) > idx[answers_col] else "").strip()
                for q in range(nq_eff):
                    ch = s[q].lower() if q < len(s) else chars[2]
                    cells[q] = char_map.get(ch, 2)
            else:
                for q, ci in enumerate(cand[:nq_eff]):
                    t = (row[ci] if ci < len(row) else "").strip()
                    low = t.lower()
                    if key_states is not None and re.fullmatch(r"[A-Ea-e]", t):
                        # a real answer key means single letters are A-E choices, not state words
                        cells[q] = 0 if t.upper() == key_letters[q] else 1
                    elif low in DATA_CHARS:
                        cells[q] = DATA_CHARS[low]
                    elif key_states is not None and re.fullmatch(r"[A-Ea-e]", t):
                        cells[q] = 0 if key_states[q] == -1 or t.upper() == key_letters[q] else 1
                    elif len(t) == 1 and t.lower() in char_map:
                        cells[q] = char_map[t.lower()]
                    else:
                        cells[q] = 2
                        bad += 1
        except ValueError:
            bad += 1
            continue
        packed = 0
        for q in range(nq_eff):
            packed |= (cells[q] & 3) << (q * 2)
        # store little-endian by byte
        chunk = packed.to_bytes(stride, "little")
        rows_codes += chunk
        if sede_col_i is not None:
            sn = (row[sede_col_i] if sede_col_i < len(row) else "?").strip() or "?"
        else:
            sn = "all"
        if sn not in sede_ix:
            sede_ix[sn] = len(sede_names)
            sede_names.append(sn)
        rows_sede.append(sede_ix[sn])
        for h in extra_num:
            v = (row[idx[h]] if idx[h] < len(row) else "").strip().replace(",", ".")
            m = re.search(r"-?\d+(\.\d+)?", v)
            nums[h].append(float(m.group(0)) if m else float("nan"))
        for h in extra_str:
            strs[h].append((row[idx[h]] if idx[h] < len(row) else "").strip())

    n = len(rows_sede)
    meta = {
        "generator": "imat_fuzzy.py build",
        "source": os.path.basename(path),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": note,
        "sections": sections or [],
        "num_cols": [{"name": h, "label": h} for h in extra_num],
        "str_cols": [{"name": h, "label": h} for h in extra_str],
        "data_states": list(DATA_STATES),
    }
    ds = Dataset(nrows=n, nq=nq_eff, sedi=sede_names or ["all"], state_names=list(DATA_STATES),
                 row_sede=rows_sede, codes=bytes(rows_codes), num=nums, strs=strs, meta=meta,
                 stride=stride)
    size = ds.write(out)
    log = sys.stderr if quiet else sys.stdout
    hist = Counter()
    for i in range(min(n, 4000)):
        for q in range(nq_eff):
            hist[ds.cell(i, q)] += 1
    tot = sum(hist.values()) or 1
    print(f"✔ wrote {out}  {human(size)}  ({n} rows × {nq_eff} questions, "
          f"{len(sede_names)} sedi)", file=log)
    print("  state mix:", "  ".join(
        f"{DATA_STATES[k]} {100.0 * hist[k] / tot:.1f}%" for k in range(4)), file=log)
    if extra_num or extra_str:
        print("  carried along:", ", ".join(extra_num + extra_str) or "-", file=log)
    if bad:
        print(f"  ⚠ {bad} cells were unmapped → treated as blank", file=log)
    return ds


key_letters: list[str] = []


def parse_key(path_or_text: str, nq: int) -> list[int]:
    """Answer key: 'A C B E D ...' / '1:A,2:C' / one letter per line. Returns per-question index."""
    if os.path.exists(path_or_text):
        txt = open(path_or_text, encoding="utf-8").read()
    else:
        txt = path_or_text
    global key_letters
    letters = re.findall(r"[A-Ea-e]", txt)
    if len(letters) >= nq:
        key_letters = [l.upper() for l in letters[:nq]]
        return [ord(l) - 65 for l in key_letters]
    key_letters = ["A"] * nq
    return [-1] * nq


# --------------------------------------------------------------------------- commands

def cmd_demo(args):
    n, nq = args.rows, args.nq
    sedi = [
        "Bari Aldo Moro", "Bologna", "Cagliari", 'Campania "L. Vanvitelli" (Napoli)', "Catania",
        "Firenze", "Messina", "Milano", "Milano Bicocca (Bergamo)", 'Napoli "Federico II"',
        "Padova", "Parma (sede di Piacenza)", "Pavia", "Politecnica delle Marche",
        'Roma "La Sapienza"', 'Roma "Tor Vergata"', "Siena Odontoiatria",
        "Torino (sede di Orbassano)", "Sedi estere",
    ]
    secs = [("General Knowledge", 6), ("Logical Reasoning", 13), ("Biology", 18),
            ("Chemistry", 13), ("Physics & Mathematics", 10)]
    rng = random.Random(args.seed)
    ability = [max(0.15, min(0.95, rng.gauss(0.52, 0.17))) for _ in range(n)]
    luck = [max(0.0, min(1.0, rng.gauss(0.5, 0.25))) for _ in range(n)]
    sec_of = []
    for name, w in secs:
        for _ in range(w):
            sec_of.append(name)
    while len(sec_of) < nq:
        sec_of.append("Extra")
    hdr = ["code", "sede", "q_answers"] + [f"{s} score" for s, _ in secs] + ["total score"]
    d = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(d, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(hdr)
        for i in range(n):
            ab = ability[i]
            lk = luck[i]
            cells = []
            sec_scores = {s: 0.0 for s, _ in secs}
            for j in range(nq):
                p = max(0.02, min(0.97, ab * 0.75 + lk * 0.15 + rng.gauss(0, 0.09)
                                  - (0.04 if j > nq * 0.8 else 0)))
                r = rng.random()
                if r < p:
                    st = 0
                elif r < p + (1 - p) * (0.55 + 0.3 * (1 - lk)):
                    st = 1
                elif r < 0.995:
                    st = 2
                else:
                    st = 3
                cells.append("cwdn"[st])
                if j < nq:
                    pts = (POINTS_CORRECT if st == 0 else POINTS_WRONG if st == 1 else 0.0)
                    sec_scores[sec_of[j]] += pts
            code = f"{rng.randrange(16 ** 6):06X}"
            w.writerow([code, sedi[i % len(sedi)]] + ["".join(cells)] +
                       [f"{sec_scores[s]:.1f}" for s, _ in secs] +
                       [f"{sum(sec_scores.values()):.1f}"])
    print(f"✔ synthetic dataset → {args.out}  ({n} rows × {nq} questions)")
    print("  DEMO DATA ONLY — it is not the real survey; replace with your own CSV.")
    print(f"  next: python3 tools/imat_fuzzy.py build --csv {args.out} "
          f"--answers-col q_answers --out web/data/imat.bin")
    return 0


def cmd_build(args):
    secs = None
    if args.sections:
        secs = []
        for part in args.sections.split(","):
            m = re.fullmatch(r"\s*(.+?)\s*=\s*(\d+)\s*-\s*(\d+)\s*", part)
            if not m:
                die(f"--sections expects 'Name=1-6,Name2=7-19'")
            secs.append({"name": m.group(1), "from": int(m.group(2)), "to": int(m.group(3))})
    build_from_csv(args.csv, args.out, answers_col=answers_col_hint(args.csv, args),
                   key=args.key, sede_col=args.sede_col, chars=args.chars, nq=args.nq,
                   sections=secs, note=args.note, no_extra=args.no_extra)
    return 0


def answers_col_hint(path, args):
    if getattr(args, "answers_col", None):
        return args.answers_col
    fmt, delim, header, body = sniff(path)
    for i, h in enumerate(header):
        if re.search(r"(answer|risposte|answer_?sheet|pattern|choices)", h, re.I):
            vals = [r[i] for r in body[:50] if i < len(r)]
            if vals and min(len(v) for v in vals) >= 12:
                return h
    return None


def load_any(args) -> Dataset:
    if getattr(args, "bin", None):
        return Dataset.read(args.bin)
    csvp = getattr(args, "csv", None)
    if not csvp:
        for cand in ("web/data/imat.bin", "data/imat.bin"):
            if os.path.exists(cand):
                return Dataset.read(cand)
        die("no --bin and no --csv; run `demo` + `build` first, or point at your data")
    tmp = os.path.join(tempfile.gettempdir(), f"imat_fuzzy_{os.getpid()}.bin")
    build_from_csv(csvp, tmp, answers_col=answers_col_hint(csvp, args), key=getattr(args, "key", None),
                   sede_col=getattr(args, "sede_col", None), chars=getattr(args, "chars", "cwdn"),
                   nq=getattr(args, "nq", None), note="", limit=None, quiet=True)
    ds = Dataset.read(tmp)
    os.remove(tmp)
    return ds


def resolve_sede(ds: Dataset, name: str | None, quiet=False):
    if not name:
        return None
    ranked = fuzzy_locate(name, ds.sedi, top=3)
    if not ranked:
        return None
    i, best, score = ranked[0]
    exact = [k for k, v in enumerate(ds.sedi) if norm(v) == norm(name)]
    if exact:
        return exact[0]
    if not quiet:
        print(f"  (sede {name!r} → {best!r}; candidates: "
              + ", ".join(f"{b}" for _, b, _ in ranked[:3]) + ")", file=sys.stderr)
    return i


def cmd_search(args):
    ds = load_any(args)
    sede = resolve_sede(ds, args.sede)
    query = load_query(args, ds.nq)
    if args.interactive:
        query = ask_all(ds, query)
    t0 = time.perf_counter()
    res = search(ds, query, sede, top=args.top, tol=args.tol)
    dt = time.perf_counter() - t0
    if args.json:
        print(json.dumps({
            "pool": res["pool"], "answered": res["answered"], "best": res["best"],
            "gap": res["gap"], "ambiguous": res["ambiguous"], "bits": res["bits"],
            "hard": res["hard"], "soft": res["soft"],
            "collisions": res["expected_collisions"], "ms": dt, "sede": args.sede or "",
            "sedeIdx": -1 if sede is None else sede, "query": query,
            "sedi": ds.sedi, "nq": ds.nq, "nrows": ds.nrows,
            "hits": [{"row": h["row"], "cost": h["cost"], "cells": h["cells"]}
                     for h in res["hits"]],
            "cells": {"all": None},
        }))
        return 0
    print(f"\n  {res['answered']} questions filled · pool {res['pool']:,} rows "
          f"({ds.sedi[sede] if sede is not None else 'every sede'}) · {dt * 1000:.0f} ms")
    print(f"  best cost {res['best']:.2f} · {res['hard']} hard + {res['soft']} soft "
          f"disagreement(s) · next-gap {res['gap']:.2f} · "
          f"{res['ambiguous']} row(s) within ±{args.tol}")
    print(f"  pattern entropy ≈ {res['bits']:.1f} bits → "
          f"~{res['expected_collisions']:.3f} other look-alikes expected")
    print(f"  verdict: {verdict(res)}\n")
    hdr = "  rank cost   row  sede                             "
    if ds.num or ds.strs:
        hdr += "  " + "  ".join(f"{n:>13}" for n in list(ds.num) + list(ds.strs))
    print(hdr)
    for k, h in enumerate(res["hits"], 1):
        line = f"  {k:>4} {h['cost']:>5.2f} {h['i']:>6}  {h['sede'][:31]:<31}"
        vals = [f"{h[n]:>13.1f}" for n in ds.num] + [f"{h[n]:>13}" for n in ds.strs]
        if vals:
            line += "  " + "  ".join(vals)
        mark = " ★" if k == 1 and res["ambiguous"] == 1 and res["best"] <= args.tol else ""
        print(line + mark)
    if args.diff and res["hits"]:
        show_diff(ds, query, res["hits"][0]["row"])
    return 0


def show_diff(ds, query, row):
    cells = ds.row_cells(row)
    print("\n  where you and the top row disagree:")
    for q in range(ds.nq):
        qs = QUERY_STATES[query[q]]
        if qs == "unset":
            continue
        c = COST[qs][cells[q]]
        if c <= 0.5:
            continue
        print(f"    q{q + 1:<3} you={qs:<7} row={ds.state_names[cells[q]]:<7} cost {c:.1f}")


def ask_all(ds, query):
    print(f"Enter what you remember for {ds.nq} questions. "
          f"s=sure right · u=unsure/guessed · w=sure wrong · b=blank · ?=skip (blank=unset)")
    for q in range(ds.nq):
        prompt = f"  q{q + 1:>3} [{('u w b ?' if not query[q] else 's u w b ?')}]> "
        sys.stdout.write(prompt)
        line = sys.stdin.readline()
        if not line:
            break
        tok = line.strip().lower()[:1]
        st = STATE_CHARS.get(tok)
        if st:
            query[q] = QUERY_STATES.index(st)
    return query


def cmd_score(args):
    ds = load_any(args) if (args.bin or args.csv) else None
    nq = ds.nq if ds else args.nq
    query = load_query(args, nq)
    lo, hi = 0.0, 0.0
    n_answered = 0
    for q in range(nq):
        st = QUERY_STATES[query[q]]
        if st == "sure":
            lo += POINTS_CORRECT
            hi += POINTS_CORRECT
            n_answered += 1
        elif st == "wrong":
            lo += POINTS_WRONG
            hi += POINTS_WRONG
            n_answered += 1
        elif st == "blank":
            n_answered += 1
        elif st == "unsure":
            lo += POINTS_WRONG
            hi += POINTS_CORRECT
            n_answered += 1
    exp = 0.0
    for q in range(nq):
        st = QUERY_STATES[query[q]]
        if st == "unsure":
            exp += 0.2 * POINTS_CORRECT + 0.8 * POINTS_WRONG  # 5-option, blind guess
        elif st == "sure":
            exp += POINTS_CORRECT * 0.93 + POINTS_WRONG * 0.07
    print(f"  answered: {n_answered}/{nq}")
    print(f"  score band: {lo:.1f} … {hi:.1f}   (spread {hi - lo:.1f})")
    print(f"  expected if your 'unsure' are coin flips: {exp:.1f}")
    if ds:
        vals = sorted(v for v in ds.num.get("total score", []) if v == v)
        if vals:
            def pct(x):
                j = 0
                while j < len(vals) and vals[j] < x:
                    j += 1
                return 100.0 * (len(vals) - j) / len(vals)
            print(f"  in this dataset, {lo:.1f} → top {pct(lo):.1f}%   "
                  f"{hi:.1f} → top {pct(hi):.1f}%")
    return 0


def cmd_info(args):
    ds = Dataset.read(args.bin)
    print(f"{args.bin}  {human(os.path.getsize(args.bin))}")
    print(f"  rows {ds.nrows:,} · questions {ds.nq} · stride {ds.stride}B/row · "
          f"sedi {len(ds.sedi)}")
    if ds.meta.get("source"):
        print(f"  source {ds.meta['source']} · built {ds.meta.get('generated_at')}")
    if ds.meta.get("note"):
        print(f"  note: {ds.meta['note']}")
    cnt = Counter(ds.row_sede)
    for name, i in sorted(((n, k) for k, n in enumerate(ds.sedi)), key=lambda t: -cnt[t[1]]):
        print(f"    {name[:36]:<36} {cnt[i]:>6,}")
    hist = [Counter() for _ in range(min(6, ds.nq))]
    for r in range(0, ds.nrows, 7):
        cs = ds.row_cells(r)
        for q in range(len(hist)):
            hist[q][cs[q]] += 1
    print("  sample state mix (q1-q6):")
    for q, h in enumerate(hist, 1):
        tot = sum(h.values()) or 1
        print(f"    q{q:<3} " + " ".join(f"{DATA_STATES[k][0]}{100 * h[k] / tot:5.1f}%"
                                          for k in range(4)))
    print("\n  discriminating power (bits per question, whole pool):")
    counts = ds.sede_counts(None)
    tot = sum(counts[0].values())
    powers = []
    for q in range(ds.nq):
        b = -sum(((counts[q][d] + 1) / (tot + 4)) * math.log2((counts[q][d] + 1) / (tot + 4))
                 for d in range(4))
        powers.append((b, q))
    powers.sort(reverse=True)
    print("    most:", ", ".join(f"q{q + 1}({b:.2f})" for b, q in powers[:8]))
    print("    least:", ", ".join(f"q{q + 1}({b:.2f})" for b, q in powers[-8:]))
    print(f"    total if you remembered every answer: {sum(b for b, _ in powers):.1f} bits")
    return 0


def cmd_validate(args):
    """Ground-truth test of the claim 'this is very surely the only person with that vector':
    take real rows, blur them the way a human memory blurs them, search, did we land alone
    on the right row?"""
    ds = load_any(args)
    sede = resolve_sede(ds, args.sede)
    rows = ds.rows_in_sede(sede)
    rng = random.Random(args.seed)
    q = ds.nq
    wins = Counter()
    stats = {"unique": 0, "top1": 0, "top3": 0, "n": 0, "bits": [], "cands": []}
    t0 = time.perf_counter()
    for t in range(args.trials):
        true = rng.choice(rows)
        cells = ds.row_cells(true)
        query = [0] * q
        for i in range(q):
            if i >= args.filled:
                break
            r = rng.random()
            if r < args.forget:
                continue
            if r < args.forget + args.doubt:
                query[i] = QUERY_STATES.index("unsure")
            elif r < args.forget + args.doubt + args.flip:
                other = rng.choice([s for s in QUERY_STATES if s not in ("unset", "unsure")])
                query[i] = QUERY_STATES.index(other)
            else:
                query[i] = QUERY_STATES.index(
                    "sure" if cells[i] == 0 else "wrong" if cells[i] == 1 else "blank")
        query = query[:args.filled] + [0] * (q - args.filled)
        res = search(ds, query, sede, top=3, tol=args.tol)
        stats["n"] += 1
        ranked = [h["row"] for h in res["hits"]]
        if res["ambiguous"] == 1:
            stats["unique"] += 1
            if ranked and ranked[0] == true:
                stats["top1"] += 1
        if true in ranked:
            stats["top3"] += 1
        stats["bits"].append(res["bits"])
        stats["cands"].append(res["ambiguous"])
        wins[query.count(0)] += 1
    dt = time.perf_counter() - t0
    n = stats["n"]
    print(f"\n  validate · pool {res['pool']:,} rows · {n} trials · "
          f"{dt / n * 1000:.1f} ms/search (python is the slow reference impl — the browser engine is 50-100× faster)")
    print(f"  settings: first {args.filled} questions filled, "
          f"{args.forget:.0%} forgotten, {args.doubt:.0%} downgraded to 'unsure', "
          f"{args.flip:.0%} misremembered")
    print(f"  unique top hit (nothing within ±{args.tol}):  {stats['unique'] / n:6.1%}")
    print(f"  ...and it was the right person:               {stats['top1'] / n:6.1%}")
    print(f"  true row in top 3:                            {stats['top3'] / n:6.1%}")
    print(f"  median ambiguity: {sorted(stats['cands'])[n // 2]} row(s) · "
          f"mean entropy {sum(stats['bits']) / n:.1f} bits")
    return 0


def cmd_locate(args):
    ds = Dataset.read(args.bin)
    for rank, name, score in fuzzy_locate(args.query, ds.sedi, top=args.top):
        n = sum(1 for s in ds.row_sede if s == rank)
        print(f"  {score:>5}  {name:<38} {n:>6,} rows")
    return 0


# --------------------------------------------------------------------------- cli

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="imat_fuzzy.py", description=__doc__.splitlines()[1],
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("demo", help="synthetic dataset so you can try this right now")
    p.add_argument("--rows", type=int, default=18000)
    p.add_argument("--nq", type=int, default=60)
    p.add_argument("--seed", type=int, default=2026)
    p.add_argument("--out", default="data/imat-demo.csv")
    p.set_defaults(fn=cmd_demo)

    p = sub.add_parser("build", help="raw csv → web/data/imat.bin")
    p.add_argument("--csv", required=True)
    p.add_argument("--out", default="web/data/imat.bin")
    p.add_argument("--answers-col", help="compact one-string-per-row column (auto-detected)")
    p.add_argument("--chars", default="cwdn", help="state alphabet for that column, in slot order")
    p.add_argument("--key", help="answer key file/string (letters) when cells hold letters")
    p.add_argument("--sede-col", help="column with the test centre (auto-detected)")
    p.add_argument("--nq", type=int, help="force question count")
    p.add_argument("--sections", help="'General Knowledge=1-6,Biology=7-24'")
    p.add_argument("--note", default="")
    p.add_argument("--no-extra", action="store_true",
                   help="pack only the 2-bit answer core (smallest blob, no code/score columns)")
    p.set_defaults(fn=cmd_build)

    p = sub.add_parser("search", help="fuzzy search")
    p.add_argument("--bin")
    p.add_argument("--csv")
    p.add_argument("--key")
    p.add_argument("--answers", help="e.g. '1-14=sure,15-22=unsure,23=w,24=b' or 'ssuwwb...'")
    p.add_argument("--file", help="one 'q state' per line")
    p.add_argument("--start", type=int, default=1, help="first question number (default 1)")
    p.add_argument("--sede", help="fuzzy test-centre name")
    p.add_argument("--top", type=int, default=10)
    p.add_argument("--tol", type=float, default=2.0, help="cost band that counts as 'indistinguishable'")
    p.add_argument("--diff", action="store_true", help="show the disagreements with the top hit")
    p.add_argument("--json", action="store_true", help="machine-readable output (used by the parity test)")
    p.add_argument("--interactive", action="store_true", help="prompt question by question")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("score", help="points band from an answer pattern")
    p.add_argument("--bin")
    p.add_argument("--csv")
    p.add_argument("--nq", type=int, default=60)
    p.add_argument("--answers")
    p.add_argument("--file")
    p.add_argument("--start", type=int, default=1)
    p.add_argument("--key")
    p.add_argument("--sede-col")
    p.add_argument("--chars", default="cwdn")
    p.set_defaults(fn=cmd_score)

    p = sub.add_parser("info", help="dataset summary")
    p.add_argument("bin")
    p.set_defaults(fn=cmd_info)

    p = sub.add_parser("validate", help="how uniquely identifying is a fuzzy recall, really?")
    p.add_argument("--bin")
    p.add_argument("--csv")
    p.add_argument("--sede")
    p.add_argument("--sede-col")
    p.add_argument("--chars", default="cwdn")
    p.add_argument("--trials", type=int, default=120)
    p.add_argument("--filled", type=int, default=40, help="how many questions the person filled")
    p.add_argument("--forget", type=float, default=0.25, help="fraction genuinely forgotten")
    p.add_argument("--doubt", type=float, default=0.30, help="fraction remembered only as 'unsure'")
    p.add_argument("--flip", type=float, default=0.06, help="fraction flat-out misremembered")
    p.add_argument("--tol", type=float, default=2.0)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--key")
    p.add_argument("--nq", type=int)
    p.set_defaults(fn=cmd_validate)

    p = sub.add_parser("locate", help="fuzzy-match a test centre name")
    p.add_argument("bin")
    p.add_argument("query")
    p.add_argument("--top", type=int, default=5)
    p.set_defaults(fn=cmd_locate)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
