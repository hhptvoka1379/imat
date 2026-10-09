#!/usr/bin/env python3
"""Build docs/data.bin from data/results.csv for the in-browser site.

Binary layout (all little-endian):

    0   8s   magic b"IMAT26DB"
    8   u16  version = 1
    10  u16  sede_count
    12  u32  row_count
    16  u32  scores_offset   (absolute file offset, 2-byte aligned)
    20  u32  codes_offset    (absolute file offset)
    24  ...  sede_count x u32 row_start   (prefix ranges; last end = row_count)
    ..  ...  sede table: sede_count x (u8 code_len, code, u8 name_len, name utf8)
    ..  pad  to 4-byte alignment
    ..  ...  scores: row_count x 6 x i16   (s1..s5, total; scores in tenths)
    ..  ...  codes:  row_count x 15 x u8   (digit 0..9, 255 = no bar code)

Rows are stored grouped by sede so "filter by location" is a slice.

Usage:
    python3 tools/build_site_data.py
"""

from __future__ import annotations

import csv
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "results.csv"
OUT_PATH = ROOT / "docs" / "data.bin"

MAGIC = b"IMAT26DB"
VERSION = 1

# Official page order (sedi estere first, then alphabetical).
SEDE_ORDER = [
    ("MU", "Sedi estere"),
    ("02", "Bari Aldo Moro"),
    ("03", "Bologna"),
    ("04", "Cagliari"),
    ("49", 'Campania "L. Vanvitelli" (Napoli)'),
    ("08", "Catania"),
    ("10", "Firenze"),
    ("14", "Messina"),
    ("15", "Milano"),
    ("C6", "Milano Bicocca (Bergamo)"),
    ("18", 'Napoli "Federico II"'),
    ("19", "Padova"),
    ("21", "Parma (sede di Piacenza)"),
    ("22", "Pavia"),
    ("01", "Politecnica delle Marche"),
    ("26", 'Roma "La Sapienza"'),
    ("27", 'Roma "Tor Vergata"'),
    ("30", "Siena Odontoiatria"),
    ("31", "Torino (sede di Orbassano)"),
]


def main() -> int:
    by_sede: dict[str, list[tuple[str, list[int]]]] = {code: [] for code, _ in SEDE_ORDER}
    names = dict(SEDE_ORDER)

    with CSV_PATH.open() as f:
        for r in csv.DictReader(f):
            code = r["sede"]
            assert r["sede_name"] == names[code], f"seat name mismatch: {r['sede_name']}"
            barcode = r["barcode"]
            codes = [255] * 15 if not barcode else [int(ch) for ch in barcode]
            tenths = [round(float(r[k]) * 10) for k in ("s1", "s2", "s3", "s4", "s5", "total")]
            by_sede[code].append((codes, tenths))

    row_count = sum(len(v) for v in by_sede.values())
    sede_count = len(SEDE_ORDER)

    # ---- header + index -------------------------------------------------
    header = struct.pack("<8sHHIII", MAGIC, VERSION, sede_count, row_count, 0, 0)
    starts = []
    acc = 0
    for code, _ in SEDE_ORDER:
        starts.append(acc)
        acc += len(by_sede[code])
    index = struct.pack(f"<{sede_count}I", *starts)

    sede_table = b""
    for code, name in SEDE_ORDER:
        cb, nb = code.encode(), name.encode("utf-8")
        sede_table += struct.pack("<B", len(cb)) + cb
        sede_table += struct.pack("<B", len(nb)) + nb

    prefix = header + index + sede_table
    pad = (-len(prefix)) % 4
    scores_offset = len(prefix) + pad
    codes_offset = scores_offset + row_count * 12

    header = struct.pack(
        "<8sHHIII", MAGIC, VERSION, sede_count, row_count, scores_offset, codes_offset
    )

    # ---- rows ------------------------------------------------------------
    score_blob = bytearray()
    code_blob = bytearray()
    for code, _ in SEDE_ORDER:
        for codes, tenths in by_sede[code]:
            score_blob += struct.pack("<6h", *tenths)
            code_blob += bytes(codes)

    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_bytes(header + index + sede_table + b"\0" * pad + score_blob + code_blob)

    # ---- round-trip check -------------------------------------------------
    blob = OUT_PATH.read_bytes()
    (magic, ver, sc, rc, soff, coff) = struct.unpack_from("<8sHHIII", blob, 0)
    assert (magic, ver, sc, rc) == (MAGIC, VERSION, sede_count, row_count)
    assert soff % 2 == 0
    ok = 0
    for i in range(row_count):
        s = struct.unpack_from("<6h", blob, soff + i * 12)
        c = blob[coff + i * 15 : coff + i * 15 + 15]
        assert abs(sum(s[:5]) - s[5]) <= 1  # tenths rounding slack
        assert all(d == 255 or 0 <= d <= 9 for d in c)
        ok += 1
    print(f"rows={row_count} sedi={sede_count} scores@{soff} codes@{coff}")
    print(f"round-trip ok for {ok} rows")
    print(f"wrote {OUT_PATH}  ({OUT_PATH.stat().st_size/1024:.0f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
