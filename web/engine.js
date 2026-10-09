/* ============================================================================
 * imat engine — fuzzy answer-vector search, entirely in the browser, zero deps.
 *
 * The same file is loaded three ways: <script> in the page, importScripts() in
 * the worker, require() in the node tests. No module syntax on purpose, so it
 * also works from file:// with no build step.
 *
 * Why it is fast:
 *   · rows are 2 bits per question (18,000 x 60 => 270 KB) so the whole dataset
 *     stays in cache; 36 rows fit in a 128-byte cache line
 *   · a question-major "plane" view (one Uint8Array per question) turns a search
 *     into "for each question you filled: add a 4-entry LUT to a flat Int32Array"
 *   · the cost array is kept ALIVE between edits, so painting one cell costs one
 *     diff pass over the pool, not a full re-scan
 *   · ranking is a counting sort over a cost histogram: no sort, no allocation
 *
 * The cost table is shared with tools/imat_fuzzy.py — keep the two in sync.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MAGIC = 'IMATFSH1';
  var DATA_STATES = ['correct', 'wrong', 'blank', 'unseen'];
  var QUERY_STATES = ['unset', 'sure', 'unsure', 'wrong', 'blank'];

  /* cost[what you picked][what the row says] in HALF POINTS, so typed arrays stay integral.
   * 12 = 6.0, 13 = 6.5, 9 = 4.5, 10 = 5.0, 1 = 0.5. Mirrors COST in imat_fuzzy.py. */
  var COST = [
    [0, 0, 0, 0],       // 0 unset  - don't care, doesn't count
    [0, 12, 13, 13],    // 1 sure   - you say right  => row must say right
    [1, 1, 9, 9],       // 2 unsure - answered either way is fine, blank is not
    [12, 0, 10, 10],    // 3 wrong  - you say missed  => row must say missed
    [12, 12, 0, 0]      // 4 blank  - you say skipped => row must be blank (unseen counts)
  ];
  var TOL = 4;              // half-points: rows within 2.0 pts of the best count as "indistinguishable"
  var POINTS = [1.5, -0.4, 0, 0];   // per data state (correct / wrong / blank / unseen)
  var KEYS = {
    s: 1, c: 1, '1': 1, sure: 1, right: 1, ok: 1, y: 1,
    u: 2, g: 2, m: 2, '2': 2, unsure: 2, guess: 2, maybe: 2,
    w: 3, x: 3, '3': 3, wrong: 3, bad: 3, miss: 3,
    b: 4, '-': 4, _: 4, '0': 4, blank: 4, skip: 4, none: 4,
    '?': 0, '.': 0, n: 0, unset: 0, '': 0
  };

  function now() {
    return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ------------------------------------------------------------------ blob layout

  function parseBlob(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder('utf-8');
    var tag = '';
    for (var i = 0; i < 8; i++) tag += String.fromCharCode(u8[i]);
    if (tag !== MAGIC) throw new Error('not an IMAT fuzzy blob');
    var p = 8;
    var ver = dv.getUint32(p, true); p += 4;
    var nrows = dv.getUint32(p, true); p += 4;
    var nq = dv.getUint16(p, true); p += 2;
    var nsedi = dv.getUint16(p, true); p += 2;
    var nstates = dv.getUint16(p, true); p += 2;
    var nnum = dv.getUint16(p, true); p += 2;
    var nstr = dv.getUint16(p, true); p += 2;
    var stride = dv.getUint32(p, true); p += 4;
    if (ver !== 1) throw new Error('blob version ' + ver + ' unsupported');
    function names(k) {
      var out = [];
      for (var j = 0; j < k; j++) {
        var ln = dv.getUint16(p, true); p += 2;
        out.push(td.decode(u8.subarray(p, p + ln))); p += ln;
      }
      return out;
    }
    var sedi = names(nsedi), stateNames = names(nstates), numNames = names(nnum), strNames = names(nstr);
    var rowSede = u8.subarray(p, p + nrows); p += nrows;
    var codes = u8.subarray(p, p + nrows * stride); p += nrows * stride;
    var num = {};
    numNames.forEach(function (nm) {
      var a = new Float32Array(nrows);
      for (var j = 0; j < nrows; j++) { a[j] = dv.getFloat32(p, true); p += 4; }
      num[nm] = a;
    });
    var strs = {};
    strNames.forEach(function (nm) {
      var offs = new Uint32Array(nrows + 1);
      for (var j = 0; j <= nrows; j++) { offs[j] = dv.getUint32(p, true); p += 4; }
      var end = offs[nrows], raw = u8.subarray(p, p + end); p += end;
      var out = new Array(nrows);
      for (var r = 0; r < nrows; r++) out[r] = td.decode(raw.subarray(offs[r], offs[r + 1]));
      strs[nm] = out;
    });
    var meta = {};
    if (buf.byteLength - p >= 4) {
      var mj = dv.getUint32(p, true); p += 4;
      try { meta = JSON.parse(td.decode(u8.subarray(p, p + mj))); } catch (e) { /* tolerant */ }
    }
    return {
      nrows: nrows, nq: nq, stride: stride, sedi: sedi, stateNames: stateNames,
      rowSede: rowSede, codes: codes, num: num, numNames: numNames,
      strs: strs, strNames: strNames, meta: meta, bytes: buf.byteLength
    };
  }

  // ------------------------------------------------------------------ index

  function Index(src) {
    var nrows = this.nrows = src.nrows, nq = this.nq = src.nq, stride = this.stride = src.stride;
    this.sedi = src.sedi; this.rowSede = src.rowSede; this.codes = src.codes;
    this.stateNames = src.stateNames || DATA_STATES;
    this.meta = src.meta || {};
    this.num = src.num || {}; this.numNames = src.numNames || [];
    this.strs = src.strs || {}; this.strNames = src.strNames || [];

    var planes = new Array(nq), q, i, r;
    for (q = 0; q < nq; q++) planes[q] = new Uint8Array(nrows);
    for (i = 0; i < nrows; i++) {
      var base = i * stride;
      for (q = 0; q < nq; q++) planes[q][i] = (src.codes[base + (q >> 2)] >> ((q & 3) * 2)) & 3;
    }
    this.planes = planes;

    var nSede = Math.max(1, this.sedi.length), cnt = new Uint32Array(nSede);
    for (i = 0; i < nrows; i++) cnt[this.rowSede[i]]++;
    this.sedeCount = cnt;
    var fill = new Uint32Array(nSede), lists = new Array(nSede);
    for (i = 0; i < nSede; i++) lists[i] = new Int32Array(cnt[i]);
    for (i = 0; i < nrows; i++) { r = this.rowSede[i]; lists[r][fill[r]++] = i; }
    this.sedeRows = lists;

    var hist = new Array(nSede);
    for (i = 0; i < nSede; i++) {
      var h = new Uint32Array(nq * 4), rows = lists[i];
      for (var k = 0; k < rows.length; k++) {
        var rr = rows[k];
        for (q = 0; q < nq; q++) h[q * 4 + planes[q][rr]]++;
      }
      hist[i] = h;
    }
    this.sedeHist = hist;
    var gh = new Uint32Array(nq * 4);
    for (i = 0; i < nSede; i++) for (var t = 0; t < nq * 4; t++) gh[t] += hist[i][t];
    this.globalHist = gh;

    this.allRows = new Int32Array(nrows);
    for (i = 0; i < nrows; i++) this.allRows[i] = i;

    this.query = new Uint8Array(nq);
    this.cost = new Int32Array(nrows);
    this.scopeSede = -1;
    this.scope = this.allRows;
    this.dirty = true;
  }

  Index.prototype.setScope = function (sedeIdx) {
    var s = (sedeIdx === null || sedeIdx === undefined || sedeIdx < 0) ? -1 : sedeIdx;
    this.scopeSede = s;
    this.scope = s < 0 ? this.allRows : (this.sedeRows[s] || new Int32Array(0));
    this.dirty = true;
  };

  /* Paint one question. `silent` skips the incremental fold (bulk restore path). */
  Index.prototype.setQuestion = function (q, state) {
    if (q < 0 || q >= this.nq) return false;
    state = state | 0;
    if (this.query[q] === state) return false;
    var old = this.query[q];
    this.query[q] = state;
    var plane = this.planes[q], cost = this.cost, rows = this.scope;
    var lOld = COST[old], lNew = COST[state], i, r;
    if (old === 0) {
      for (i = 0; i < rows.length; i++) { r = rows[i]; cost[r] += lNew[plane[r]]; }
    } else if (state === 0) {
      for (i = 0; i < rows.length; i++) { r = rows[i]; cost[r] -= lOld[plane[r]]; }
    } else {
      for (i = 0; i < rows.length; i++) {
        r = rows[i]; cost[r] += lNew[plane[r]] - lOld[plane[r]];
      }
    }
    return true;
  };

  Index.prototype.reset = function () {
    this.query.fill(0);
    this.cost.fill(0);
    this.dirty = false;
  };

  Index.prototype.rebuild = function () {
    var planes = this.planes, nq = this.nq, rows = this.scope, cost = this.cost, i, r, q;
    for (i = 0; i < rows.length; i++) cost[rows[i]] = 0;
    for (q = 0; q < nq; q++) {
      var s = this.query[q];
      if (!s) continue;
      var lut = COST[s], plane = planes[q];
      for (i = 0; i < rows.length; i++) { r = rows[i]; cost[r] += lut[plane[r]]; }
    }
    this.dirty = false;
  };

  Index.prototype.answered = function () {
    var n = 0;
    for (var q = 0; q < this.nq; q++) if (this.query[q]) n++;
    return n;
  };

  /* the search. one pass for the histogram, one pass to lift out the cheap tail. */
  Index.prototype.rank = function (top, tol, wantBits) {
    if (this.dirty) this.rebuild();
    var rows = this.scope, cost = this.cost, n = rows.length, i, r, c;
    var out = {
      pool: n, hits: [], best: 0, gap: 0, ambiguous: 0,
      answered: this.answered(), bits: 0, collisions: 0
    };
    if (!n) return out;
    var maxC = 0;
    for (i = 0; i < n; i++) { c = cost[rows[i]]; if (c > maxC) maxC = c; }
    var buckets = new Uint32Array(maxC + 1);
    for (i = 0; i < n; i++) buckets[cost[rows[i]]]++;
    var want = Math.max(1, top || 10), cut = maxC, acc = 0;
    for (i = 0; i <= maxC; i++) { acc += buckets[i]; if (acc >= want) { cut = i; break; } }
    var picked = [];
    for (i = 0; i < n && picked.length < want * 6; i++) {
      r = rows[i];
      if (cost[r] <= cut) picked.push(r);
    }
    if (!picked.length) return out;
    picked.sort(function (a, b) { return cost[a] - cost[b] || a - b; });
    var best = cost[picked[0]], T = (tol === undefined ? TOL : tol);
    // amb = how many rows are indistinguishable from the winner; gap = how much the
    // runner-up actually trails it (both read off the histogram, no extra passes)
    var amb = 0, second = 0, k2;
    for (k2 = best; k2 <= Math.min(maxC, best + T); k2++) amb += buckets[k2];
    for (k2 = best + 1; k2 <= maxC; k2++) if (buckets[k2]) { second = k2 - best; break; }
    var self = this;
    var hits = picked.slice(0, want).map(function (rr) {
      return { row: rr, cost: cost[rr], sede: self.sedi[self.rowSede[rr]], info: self.rowInfo(rr) };
    });
    // how many of your cells the winner *flatly contradicts* (>= 1 half of a 6-pt
    // penalty), vs how many are just soft. A cost of 10 with 2 hard cells is a
    // different situation from a cost of 10 with 20 soft cells.
    var hard = 0, soft = 0, w = picked[0];
    for (var hq = 0; hq < this.nq; hq++) {
      var qs = this.query[hq];
      if (!qs) continue;
      var cc = COST[qs][this.planes[hq][w]];
      if (cc >= 12) hard++;
      else if (cc > 1) soft++;
    }
    out.hard = hard; out.soft = soft;
    out.hits = hits; out.best = best; out.ambiguous = amb; out.gap = second;
    if (wantBits !== false) { out.bits = this.bits(); out.collisions = this.collisions(); }
    return out;
  };

  Index.prototype.rowCells = function (r) {
    var out = new Uint8Array(this.nq), base = r * this.stride, c = this.codes;
    for (var q = 0; q < this.nq; q++) out[q] = (c[base + (q >> 2)] >> ((q & 3) * 2)) & 3;
    return out;
  };

  Index.prototype.rowInfo = function (r) {
    var o = {}, i;
    for (i = 0; i < this.numNames.length; i++) o[this.numNames[i]] = this.num[this.numNames[i]][r];
    for (i = 0; i < this.strNames.length; i++) o[this.strNames[i]] = this.strs[this.strNames[i]][r];
    return o;
  };

  /* Self-information of your pattern in this pool: how much a match is *worth*.
   * Naive (questions treated as independent), so it flatters you - estimate() below
   * measures the real thing by replaying the search on people who are in the data. */
  Index.prototype.bits = function () {
    var hist = this.scopeSede >= 0 ? this.sedeHist[this.scopeSede] : this.globalHist;
    var n = this.scope.length;
    if (!n) return 0;
    var bits = 0;
    for (var q = 0; q < this.nq; q++) {
      var s = this.query[q];
      if (!s) continue;
      var lut = COST[s], mass = 0;
      for (var d = 0; d < 4; d++) if (lut[d] <= 1) mass += hist[q * 4 + d];
      if (mass <= 0) continue;
      bits += -Math.log2((mass + 1) / (n + 4));
    }
    return bits;
  };

  Index.prototype.collisions = function () {
    var n = this.scope.length;
    if (n <= 1) return 0;
    return (n - 1) * Math.pow(2, -this.bits());
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* Monte-Carlo honesty check. Take real rows from this pool, blur them the way human
   * memory blurs them (using *your* fill ratio and *your* unsure share), and ask how
   * often the search lands on exactly one row - and whether that row is the right one.
   * This is the only number here that is not a model. */
  Index.prototype.estimate = function (opts) {
    opts = opts || {};
    var trials = Math.max(5, opts.trials || 40), rows = this.scope, nq = this.nq;
    if (!rows.length) return null;
    var known = 0, unsureish = 0, q;
    for (q = 0; q < nq; q++) {
      if (this.query[q]) known++;
      if (this.query[q] === 2) unsureish++;
    }
    if (!known) return null;
    var rng = mulberry32(opts.seed || 0x2f6a);
    var doubt = Math.min(0.9, unsureish / known);
    var forget = Math.max(0, 1 - known / nq) * 0.8;
    var flip = opts.flip === undefined ? 0.06 : opts.flip;
    var saved = new Uint8Array(this.query), keepDirty = this.dirty;
    var sim = new Uint8Array(nq);
    var alone = 0, in3 = 0, ambSum = 0;
    for (var t = 0; t < trials; t++) {
      var truth = rows[(rng() * rows.length) | 0];
      sim.fill(0);
      for (q = 0; q < nq; q++) {
        if (!saved[q]) continue;
        var r = rng();
        if (r < forget) continue;
        var st = this.planes[q][truth];
        if (r < forget + doubt) sim[q] = 2;
        else if (r < forget + doubt + flip) sim[q] = 1 + ((rng() * 3) | 0);
        else sim[q] = st === 0 ? 1 : st === 1 ? 3 : 4;
      }
      this.query.set(sim);
      this.dirty = true;
      var res = this.rank(3, TOL, false);
      if (res.ambiguous === 1 && res.hits.length && res.hits[0].row === truth) alone++;
      for (var k = 0; k < res.hits.length; k++) if (res.hits[k].row === truth) in3++;
      ambSum += res.ambiguous;
    }
    this.query.set(saved);
    this.dirty = keepDirty;
    this.rebuild();
    return {
      trials: trials, alone: alone / trials, inTop3: in3 / trials,
      meanAmbiguity: ambSum / trials, doubt: doubt, forget: forget, flip: flip,
      known: known, pool: rows.length
    };
  };

  /* what you actually score, from the same pattern (IMAT: +1.5 / -0.4 / 0) */
  Index.prototype.scoreBand = function () {
    var lo = 0, hi = 0, n = 0;
    for (var q = 0; q < this.nq; q++) {
      var s = this.query[q];
      if (!s) continue;
      n++;
      if (s === 1) { lo += POINTS[0]; hi += POINTS[0]; }
      else if (s === 3) { lo += POINTS[1]; hi += POINTS[1]; }
      else if (s === 4) { /* nothing */ }
      else { lo += POINTS[1]; hi += POINTS[0]; }
    }
    return { lo: lo, hi: hi, answered: n, empty: this.nq - n };
  };

  // ------------------------------------------------------------------ raw table -> index

  var DATA_MAP = {
    c: 0, correct: 0, right: 0, s: 0, sure: 0, ok: 0, '1': 0, y: 0, true: 0, t: 0,
    w: 1, wrong: 1, x: 1, incorrect: 1, bad: 1, '2': 1, n: 1, false: 1, f: 1,
    u: 1, unsure: 1, guess: 1,
    b: 2, blank: 2, '': 2, skip: 2, '-': 2, _: 2, '0': 2, none: 2, na: 2,
    unanswered: 2, 'not answered': 2, unseen: 3, notseen: 3, not_seen: 3, ns: 3,
    '3': 3, e: 3, exit: 3, 'not reached': 3
  };
  var COMPACT = { c: 0, w: 1, d: 2, n: 3, '1': 0, '2': 1, '0': 2, '3': 3, '.': 2, '-': 2, '?': 3 };
  var RE_SEDE = /(sede|location|centre|center|univ|site|city|citt)/i;
  var RE_QCOL = /^(q\s*\.?\s*)?\d{1,3}$/i;
  var RE_NUM = /(score|punteggio|total|logic|biolog|chemis|physic|math|general|knowledge|percentil|rank)/i;
  var RE_CODE = /(code|codice|\bid\b|anon|answer ?sheet|foglio|hash)/i;

  function splitLine(line, delim) {
    if (line.indexOf('"') === -1) return line.split(delim);
    var out = [], cur = '', i = 0, quoted = false;
    while (i < line.length) {
      var ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        if (ch === '"') { quoted = false; i++; continue; }
        cur += ch; i++; continue;
      }
      if (ch === '"') { quoted = true; i++; continue; }
      if (ch === delim) { out.push(cur); cur = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      cur += ch; i++;
    }
    out.push(cur);
    return out;
  }

  function cellState(txt, keyLetters, q) {
    var t = (txt || '').trim(), low = t.toLowerCase();
    // a real answer key means a lone letter is an A-E choice, not a state word
    if (keyLetters && /^[a-eA-E]$/.test(t)) return t.toUpperCase() === keyLetters[q] ? 0 : 1;
    if (has(DATA_MAP, low)) return DATA_MAP[low];
    if (t.length === 1 && has(COMPACT, low)) return COMPACT[low];
    var m = t.match(/-?\d+(\.\d+)?/);
    if (m) { var v = parseFloat(m[0]); return v > 0 ? 0 : v < 0 ? 1 : 2; }
    return 2;
  }

  /* Two supported shapes, auto-detected:
   *   A) wide   - one column per question, cells say correct/wrong/blank (or letters + key)
   *   B) compact- one column with the whole answer string, one char per question
   */
  function parseTable(text, opts) {
    opts = opts || {};
    var t0 = now();
    var lines = text.split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length < 2) throw new Error('no data rows');
    var head = lines[0].replace(/^\uFEFF/, '');
    var delim = opts.delim ||
      (head.split('\t').length > head.split(',').length ? '\t' : ',');
    var header = splitLine(head, delim).map(function (s) { return s.trim(); });

    var compactCol = -1, i;
    if (opts.answersCol) {
      var want = String(opts.answersCol).toLowerCase();
      for (i = 0; i < header.length; i++) if (header[i].toLowerCase() === want) compactCol = i;
    }
    if (compactCol < 0) {
      for (i = 0; i < header.length; i++) {
        if (/answer|risposte|pattern|sheet/i.test(header[i])) {
          if ((splitLine(lines[1], delim)[i] || '').length >= 12) { compactCol = i; break; }
        }
      }
    }
    var answerCols = null, nq;
    if (compactCol >= 0) {
      var widest = 0;
      for (i = 1; i < Math.min(lines.length, 300); i++) {
        var L = (splitLine(lines[i], delim)[compactCol] || '').length;
        if (L > widest) widest = L;
      }
      nq = opts.nq || widest;
    } else {
      answerCols = [];
      header.forEach(function (hh, idx) { if (RE_QCOL.test(hh)) answerCols.push(idx); });
      if (!answerCols.length) throw new Error('found neither a compact answer column nor q1..qN columns');
      nq = opts.nq || answerCols.length;
      if (answerCols.length > nq) answerCols = answerCols.slice(0, nq);
    }

    var sedeCol = -1;
    if (opts.sedeCol) sedeCol = header.indexOf(opts.sedeCol);
    if (sedeCol < 0) for (i = 0; i < header.length; i++) if (RE_SEDE.test(header[i])) { sedeCol = i; break; }

    var keyLetters = null;
    if (opts.key) {
      var kl = String(opts.key).toUpperCase().match(/[A-E]/g);
      if (kl && kl.length >= nq) keyLetters = kl.slice(0, nq);
    }
    var numCols = [], strCols = [];
    header.forEach(function (hh, idx) {
      if (idx === compactCol || idx === sedeCol) return;
      if (answerCols && answerCols.indexOf(idx) >= 0) return;
      if (RE_CODE.test(hh)) strCols.push(idx);
      else if (RE_NUM.test(hh)) numCols.push(idx);
    });

    var stride = (nq + 3) >> 2, nrowsHint = lines.length - 1;
    var codes = new Uint8Array(nrowsHint * stride), rowSede = new Uint8Array(nrowsHint);
    var sedi = [], sediIx = {}, numOut = [], strOut = [], n = 0;
    for (i = 0; i < numCols.length; i++) numOut.push(new Float32Array(nrowsHint));
    for (i = 0; i < strCols.length; i++) strOut.push(new Array(nrowsHint));
    for (var li = 1; li < lines.length; li++) {
      var cells = splitLine(lines[li], delim);
      var packed = new Uint8Array(stride), q;
      if (compactCol >= 0) {
        var s = (cells[compactCol] || '').trim();
        for (q = 0; q < nq; q++) {
          var ch = (s.charAt(q) || 'd').toLowerCase();
          packed[q >> 2] |= ((has(COMPACT, ch) ? COMPACT[ch] : 2) & 3) << ((q & 3) * 2);
        }
      } else {
        for (q = 0; q < nq; q++) {
          packed[q >> 2] |= (cellState(cells[answerCols[q]], keyLetters, q) & 3) << ((q & 3) * 2);
        }
      }
      codes.set(packed, n * stride);
      var sn = sedeCol >= 0 ? ((cells[sedeCol] || '').trim() || '?') : 'all';
      if (!has(sediIx, sn)) { sediIx[sn] = sedi.length; sedi.push(sn); }
      rowSede[n] = sediIx[sn];
      for (i = 0; i < numCols.length; i++) {
        var t = (cells[numCols[i]] || '').trim().replace(',', '.');
        var m = t.match(/-?\d+(\.\d+)?/);
        numOut[i][n] = m ? parseFloat(m[0]) : NaN;
      }
      for (i = 0; i < strCols.length; i++) strOut[i][n] = (cells[strCols[i]] || '').trim();
      n++;
      if (opts.limit && n >= opts.limit) break;
    }
    if (sedi.length > 400) {
      throw new Error(sedi.length + ' distinct values in the location column - this looks like ' +
        'a scores table, not an answers table');
    }
    var num = {}, numNames = [], strs = {}, strNames = [];
    numCols.forEach(function (ci, k) {
      var nm = header[ci];
      numNames.push(nm);
      num[nm] = (k === 0 && n === nrowsHint) ? numOut[k] : numOut[k].subarray(0, n);
    });
    strCols.forEach(function (ci, k) {
      var nm = header[ci];
      strNames.push(nm);
      strs[nm] = strOut[k].slice(0, n);
    });
    return {
      nrows: n, nq: nq, stride: stride, sedi: sedi, stateNames: DATA_STATES,
      rowSede: n === nrowsHint ? rowSede : rowSede.subarray(0, n),
      codes: codes.subarray(0, n * stride), num: num, numNames: numNames,
      strs: strs, strNames: strNames,
      meta: {
        source: opts.name || 'pasted table', generated_at: new Date().toISOString(),
        note: 'parsed in your browser - nothing was uploaded', delimiter: delim,
        columns: header.length, rows: n, questions: nq
      },
      ms: now() - t0
    };
  }

  // ------------------------------------------------------------------ blob writer

  function packBlob(src) {
    var enc = new TextEncoder();
    var chunks = [], size = 0;
    function pushBytes(u8) { chunks.push(u8); size += u8.length; }
    function pushStr(s) {
      var b = enc.encode(s), l = new Uint8Array(2);
      l[0] = b.length & 255; l[1] = b.length >> 8;
      chunks.push(l, b); size += 2 + b.length;
    }
    var head = new Uint8Array(30), dv = new DataView(head.buffer);
    for (var i = 0; i < 8; i++) head[i] = MAGIC.charCodeAt(i);
    dv.setUint32(8, 1, true);          // version
    dv.setUint32(12, src.nrows, true);
    dv.setUint16(16, src.nq, true);
    dv.setUint16(18, src.sedi.length, true);
    dv.setUint16(20, DATA_STATES.length, true);
    dv.setUint16(22, src.numNames.length, true);
    dv.setUint16(24, src.strNames.length, true);
    dv.setUint32(26, src.stride, true);
    pushBytes(head);
    src.sedi.concat(DATA_STATES, src.numNames, src.strNames).forEach(pushStr);
    pushBytes(src.rowSede);
    pushBytes(src.codes);
    src.numNames.forEach(function (nm) {
      var col = src.num[nm], a = new Float32Array(src.nrows);
      for (var r = 0; r < src.nrows; r++) a[r] = col[r];
      pushBytes(new Uint8Array(a.buffer));
    });
    src.strNames.forEach(function (nm) {
      var col = src.strs[nm], offs = new Uint32Array(src.nrows + 1), acc = 0;
      var blob = [];
      for (var r = 0; r < src.nrows; r++) {
        offs[r] = acc;
        var b = enc.encode(col[r] || '');
        blob.push(b); acc += b.length;
      }
      offs[src.nrows] = acc;
      pushBytes(new Uint8Array(offs.buffer));
      var all = new Uint8Array(acc), o = 0;
      blob.forEach(function (b) { all.set(b, o); o += b.length; });
      pushBytes(all);
    });
    var mj = enc.encode(JSON.stringify(src.meta || {}));
    var l4 = new Uint8Array(4);
    new DataView(l4.buffer).setUint32(0, mj.length, true);
    pushBytes(l4); pushBytes(mj);
    var out = new Uint8Array(size), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  // ------------------------------------------------------------------ query parsing

  /* "1-14 sure, 15 u, 22-30=unsure, s u w b ..." -> Uint8Array(nq)
   * A bare run of state chars with no numbers fills from question 1 on. */
  function parseAnswers(spec, nq, start) {
    var q = new Uint8Array(nq);
    if (!spec) return q;
    spec = String(spec).trim();
    if (!spec) return q;
    start = start || 1;
    if (!/[,;=\d]/.test(spec)) {
      var chars = spec.replace(/\s+/g, '');
      for (var i = 0; i < chars.length && i < nq; i++) {
        var k = KEYS[chars[i].toLowerCase()];
        if (k !== undefined) q[i] = k;
      }
      return q;
    }
    var auto = 0;
    spec.split(/[,;\n]+/).forEach(function (tok0) {
      var tok = tok0.trim();
      if (!tok) return;
      var m = tok.match(/^(?:(\d+)(?:\s*[-:]\s*(\d+))?)\s*[= ]\s*(\S+)$/);
      if (m) {
        var st = KEYS[m[3].toLowerCase()];
        if (st === undefined) throw new Error('unknown state "' + m[3] + '" (sure/unsure/wrong/blank/?)');
        var a = parseInt(m[1], 10) - start, b = parseInt(m[2] || m[1], 10) - start;
        for (var j = a; j <= b && j < nq; j++) if (j >= 0) q[j] = st;
        return;
      }
      m = tok.match(/^(?:(\d+)(?:\s*[-:]\s*(\d+))?)\s*([a-z0-9?_.\-])$/i);
      if (m) {
        var st2 = KEYS[m[3].toLowerCase()];
        if (st2 !== undefined) {
          var a2 = parseInt(m[1], 10) - start, b2 = parseInt(m[2] || m[1], 10) - start;
          for (var j2 = a2; j2 <= b2 && j2 < nq; j2++) if (j2 >= 0) q[j2] = st2;
          return;
        }
      }
      m = tok.match(/^(\d+)([a-z?_.\-])$/i);
      if (m) {
        var k2 = KEYS[m[2].toLowerCase()];
        var idx = parseInt(m[1], 10) - start;
        if (k2 !== undefined && idx >= 0 && idx < nq) q[idx] = k2;
        return;
      }
      m = tok.match(/^([a-z?_.\-])$/i);
      if (m && KEYS[m[1].toLowerCase()] !== undefined && auto < nq) {
        q[auto++] = KEYS[m[1].toLowerCase()];
        return;
      }
      throw new Error("can't read answer token \"" + tok + '"');
    });
    return q;
  }

  /* compact state for the URL bar / clipboard: 3 bits per question, two questions per
   * base64url character => 60 questions in exactly 30 characters. */
  var A64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function packQuery(query) {
    var out = '';
    for (var i = 0; i < query.length; i += 2) {
      var v = (query[i] & 7) | ((query[i + 1] & 7) << 3);
      out += A64.charAt(v);
    }
    return out.replace(/A+$/, '');
  }
  function unpackQuery(str, nq) {
    var q = new Uint8Array(nq);
    if (!str) return q;
    for (var i = 0; i < str.length; i++) {
      var v = A64.indexOf(str.charAt(i));
      if (v < 0) continue;
      var a = i * 2;
      if (a < nq) q[a] = v & 7;
      if (a + 1 < nq) q[a + 1] = (v >> 3) & 7;
    }
    return q;
  }

  // ------------------------------------------------------------------ fuzzy strings
  // fzf-ish subsequence + edit distance, for "which test centre did you mean?"

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function lev(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
      if (best > cap) return cap + 1;
    }
    return prev[b.length];
  }

  function fuzzyRank(needle, choices) {
    var n = norm(needle), out = [];
    for (var i = 0; i < choices.length; i++) {
      var cn = norm(choices[i]), score = 0;
      if (n) {
        if (cn === n) score += 1000;
        if (cn.indexOf(n) === 0) score += 120;
        if ((' ' + cn).indexOf(' ' + n) > 0) score += 90;
        if (cn.indexOf(n) >= 0) score += 60;
        var it = cn, k = 0;
        for (var c = 0; c < n.length; c++) {
          var at = it.indexOf(n.charAt(c), k);
          if (at < 0) { k = -1; break; }
          k = at + 1;
        }
        if (k >= 0) score += 25;
        score += Math.max(0, 40 - 8 * lev(n, cn, Math.max(4, (n.length / 2) | 0)));
      }
      out.push({ i: i, name: choices[i], score: score });
    }
    out.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    return out;
  }

  function resolveSede(name, sedi) {
    if (!name || !String(name).trim()) return { idx: -1, name: null, ranked: [] };
    var want = norm(name), exact = -1;
    for (var i = 0; i < sedi.length; i++) if (norm(sedi[i]) === want) { exact = i; break; }
    var ranked = fuzzyRank(name, sedi);
    if (exact >= 0) return { idx: exact, name: sedi[exact], ranked: ranked };
    return { idx: ranked.length ? ranked[0].i : -1, name: ranked.length ? ranked[0].name : null, ranked: ranked };
  }

  function verdict(res) {
    if (!res.pool) return { tone: 'bad', text: 'no rows in that pool' };
    if (!res.answered) return { tone: 'muted', text: 'paint a few questions to start' };
    if (res.hard >= 2) {
      return { tone: 'bad', text: 'no convincing match - the best row still flatly ' +
        'contradicts you on ' + res.hard + ' cells. Either you are not in this pool, or ' +
        'a couple of cells are misremembered: check the ones in red.' };
    }
    if (res.best === 0 && res.ambiguous === 1) {
      if (res.bits >= 14 && res.collisions < 0.05) {
        return { tone: 'good', text: 'alone - this pattern is effectively a fingerprint' };
      }
      return { tone: 'ok', text: 'the only exact match, but fill more in to swear to it' };
    }
    if (res.ambiguous === 1 && res.hard === 0) {
      return { tone: 'ok', text: 'the only compatible row' + (res.soft ? ' (plus ' + res.soft +
        ' soft cell' + (res.soft > 1 ? 's' : '') + ' you were unsure about)' : '') };
    }
    if (res.ambiguous === 1) return { tone: 'mid', text: 'the only near match, but it ' +
      'contradicts you on 1 cell - worth checking one score section' };
    if (res.ambiguous <= 3) return { tone: 'mid', text: res.ambiguous + ' rows look the same - one more question should split them' };
    return { tone: 'mid', text: res.ambiguous + ' plausible rows - keep going' };
  }

  var api = {
    MAGIC: MAGIC, COST: COST, TOL: TOL, POINTS: POINTS, KEYS: KEYS,
    DATA_STATES: DATA_STATES, QUERY_STATES: QUERY_STATES,
    Index: Index, parseBlob: parseBlob, packBlob: packBlob, parseTable: parseTable,
    parseAnswers: parseAnswers, packQuery: packQuery, unpackQuery: unpackQuery,
    fuzzyRank: fuzzyRank, resolveSede: resolveSede, verdict: verdict,
    cellState: cellState, splitLine: splitLine, norm: norm, lev: lev, now: now
  };
  root.IMATEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
