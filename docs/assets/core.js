// core.js — data loading, matching math and fuzzy search for the IMAT 2026
// anonymous-results finder. All of it runs in the browser, in this tab.

export const SECTION_NAMES = [
  "General Knowledge",
  "Logical Reasoning",
  "Biology",
  "Chemistry",
  "Physics & Math",
];
export const SECTION_SIZES = [4, 5, 23, 15, 13]; // 60 questions

// marking scheme in tenths of a point (sure +1.5, wrong -0.4, blank 0)
export const CORRECT = 15;
export const WRONG = -4;
export const GAP = CORRECT - WRONG; // 19 tenths between right and wrong

export const SURE = 1, UNSURE = 2, WRONG_S = 3, BLANK = 4;

// ---------------------------------------------------------------- data --

export async function loadData(url = "data.bin") {
  const t0 = performance.now();
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 8));
  if (magic !== "IMAT26DB") throw new Error("bad data file");
  const version = dv.getUint16(8, true);
  if (version !== 1) throw new Error("unsupported data version " + version);
  const sedeCount = dv.getUint16(10, true);
  const n = dv.getUint32(12, true);
  const scoresOffset = dv.getUint32(16, true);
  const codesOffset = dv.getUint32(20, true);

  const sedeStarts = [];
  for (let i = 0; i < sedeCount; i++) sedeStarts.push(dv.getUint32(24 + i * 4, true));

  let p = 24 + sedeCount * 4;
  const td = new DataView(buf);
  const sedeCodes = [], sedeNames = [];
  for (let i = 0; i < sedeCount; i++) {
    const cl = td.getUint8(p); p += 1;
    sedeCodes.push(String.fromCharCode(...new Uint8Array(buf, p, cl))); p += cl;
    const nl = td.getUint8(p); p += 1;
    sedeNames.push(new TextDecoder().decode(new Uint8Array(buf, p, nl))); p += nl;
  }

  const scores = new Int16Array(buf, scoresOffset, n * 6);
  const codes = new Uint8Array(buf, codesOffset, n * 15);

  return {
    n, sedeCount, sedeCodes, sedeNames, sedeStarts,
    scores, codes,
    loadMs: performance.now() - t0,
  };
}

export function sedeEnds(data) {
  const out = [];
  for (let i = 0; i < data.sedeCount; i++) {
    out.push(i + 1 < data.sedeCount ? data.sedeStarts[i + 1] : data.n);
  }
  return out;
}

export function barcodeOf(data, row) {
  const b = data.codes.subarray(row * 15, row * 15 + 15);
  if (b[0] === 255) return null;
  let s = "";
  for (let i = 0; i < 15; i++) s += b[i];
  return s;
}

export function vectorOf(data, row) {
  // section scores + total, in points (floats for display)
  const base = row * 6;
  return [
    data.scores[base] / 10, data.scores[base + 1] / 10, data.scores[base + 2] / 10,
    data.scores[base + 3] / 10, data.scores[base + 4] / 10, data.scores[base + 5] / 10,
  ];
}

// -------------------------------------------------------------- matching --

// states: Int8Array(60) — 0 unset, 1 sure, 2 unsure, 3 wrong, 4 blank
export function sectionStats(states) {
  const out = [];
  let i = 0;
  for (const size of SECTION_SIZES) {
    let sure = 0, wrong = 0, unsure = 0, blank = 0, unset = 0;
    for (let k = 0; k < size; k++, i++) {
      const s = states[i];
      if (s === SURE) sure++;
      else if (s === UNSURE) unsure++;
      else if (s === WRONG_S) wrong++;
      else if (s === BLANK) blank++;
      else unset++;
    }
    const fixed = sure * CORRECT + wrong * WRONG;
    out.push({
      sure, wrong, unsure, blank, unset,
      fixed, lo: fixed + unsure * WRONG, hi: fixed + unsure * CORRECT,
    });
  }
  return out;
}

// If the row's section scores (tenths) fit this answer sheet, return the
// number of "unsure" answers that must have been right, per section.
export function rowMatches(data, row, stats) {
  const base = row * 6;
  const resolved = [];
  for (let s = 0; s < 5; s++) {
    const t = data.scores[base + s];
    const st = stats[s];
    const num = t - st.fixed + (-WRONG) * st.unsure;
    if (((num % GAP) + GAP) % GAP !== 0) return null;
    const a = num / GAP;
    if (a < 0 || a > st.unsure) return null;
    resolved.push(a);
  }
  return resolved;
}

export function findMatches(data, sedeIdx, stats) {
  const ends = sedeEnds(data);
  const start = data.sedeStarts[sedeIdx], end = ends[sedeIdx];
  const local = [], other = [];
  for (let r = 0; r < data.n; r++) {
    const res = rowMatches(data, r, stats);
    if (!res) continue;
    if (r >= start && r < end) local.push({ row: r, resolved: res });
    else other.push({ row: r, resolved: res });
  }
  return { local, other };
}

// distance (tenths) from a row's vector to the nearest vector this answer
// sheet could produce — for the "nobody matched" consolation list
export function vectorDistance(data, row, stats) {
  const base = row * 6;
  let d = 0;
  for (let s = 0; s < 5; s++) {
    const t = data.scores[base + s];
    const st = stats[s];
    let best = Infinity;
    for (let a = 0; a <= st.unsure; a++) {
      const v = st.fixed + a * CORRECT + (st.unsure - a) * WRONG;
      best = Math.min(best, Math.abs(v - t));
    }
    d += best;
  }
  return d;
}

export function nearestRows(data, sedeIdx, stats, k = 5) {
  const ends = sedeEnds(data);
  const start = data.sedeStarts[sedeIdx], end = ends[sedeIdx];
  const all = [];
  for (let r = start; r < end; r++) all.push({ row: r, d: vectorDistance(data, r, stats) });
  all.sort((a, b) => a.d - b.d);
  return all.slice(0, k);
}

// ----------------------------------------------------------------- fuzzy --

export function editDistance(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 3) return 99;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}

export function fuzzyScore(query, target) {
  if (!query || !target) return 0;
  if (query === target) return 1;
  const t = target.toLowerCase();
  if (t.startsWith(query) || t.includes(query)) {
    return 0.85 + 0.15 * (query.length / t.length);
  }
  for (const w of t.split(/[\s,.\-"'()]+/)) {
    if (!w) continue;
    if (w.startsWith(query)) return 0.8;
    const d = editDistance(query, w);
    if (d <= 2) return 0.72 - 0.12 * d;
  }
  const d = editDistance(query, t);
  return d <= 2 ? 0.75 - 0.12 * d : 0;
}

export function codeFrags(query) {
  return query.match(/\d+/g) || [];
}

export function codeScore(query, code) {
  if (!code) return 0;
  const frags = codeFrags(query);
  if (!frags.length) return 0;
  const scores = [];
  for (const frag of frags) {
    const idx = code.indexOf(frag);
    if (idx >= 0) {
      scores.push(idx === 0 ? 1.0 : 0.9);
      continue;
    }
    let best = 99;
    for (let i = 0; i < code.length; i++) {
      for (const wl of [frag.length - 1, frag.length, frag.length + 1]) {
        if (wl <= 0 || i + wl > code.length) continue;
        best = Math.min(best, editDistance(frag, code.slice(i, i + wl)));
      }
    }
    if (best <= 2) scores.push(0.7 - 0.2 * best);
    else return 0;
  }
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export function numberScore(value, rowVec) {
  // rowVec: [s1..s5, total] in points
  let best = Infinity;
  for (const v of rowVec) best = Math.min(best, Math.abs(value - v));
  return best <= 0.05 ? 1.0 : 0;
}

// query: raw text. Returns [{row, score}] best-first.
export function searchRows(data, query, limit = 25) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (let r = 0; r < data.n; r++) {
    const vec = vectorOf(data, r);
    const code = barcodeOf(data, r);
    const sedeName = data.sedeNames[
      // binary-search-free: derive sede index from starts
      sedeIndexOf(data, r)
    ];
    let total = 0, ok = true;
    for (const tok of tokens) {
      let s;
      if (/^\d{3,}$/.test(tok)) s = codeScore(tok, code || "");
      else if (/^[+-]?\d+([.,]\d+)?$/.test(tok)) {
        s = numberScore(parseFloat(tok.replace(",", ".")), vec);
      } else if (/^[\d\s-]+$/.test(tok)) s = codeScore(tok, code || "");
      else {
        s = Math.max(
          fuzzyScore(tok, sedeName || ""),
          fuzzyScore(tok, data.sedeCodes[sedeIndexOf(data, r)] || ""),
          codeScore(tok, code || ""),
        );
      }
      if (s <= 0) { ok = false; break; }
      total += s;
    }
    if (ok) hits.push({ row: r, score: total / tokens.length });
  }
  hits.sort((a, b) => b.score - a.score || a.row - b.row);
  return hits.slice(0, limit);
}

export function sedeIndexOf(data, row) {
  const s = data.sedeStarts;
  let lo = 0, hi = s.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= row) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
