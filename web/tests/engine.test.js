/* engine tests — pure node, no deps, no DOM.   node web/tests/engine.test.js
 * The important ones: incremental painting must equal a full rebuild, and the
 * JS cost model must agree with tools/imat_fuzzy.py (checked in xtest-parity). */
'use strict';
const path = require('path');
const fs = require('fs');
const E = require(path.join(__dirname, '..', 'engine.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '   → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b, tol) {
  const good = (typeof a === 'number' && typeof b === 'number')
    ? Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol) : a === b;
  ok(name + (good ? '' : `  (got ${a}, want ${b})`), good);
}

// ---------------------------------------------------------------- fixtures
function makeTable(nrows, nq, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const sedi = ['Milano', 'Roma "La Sapienza"', 'Padova', 'Bari Aldo Moro'];
  let out = 'code,sede,answers,total score\n';
  const truth = [];
  for (let i = 0; i < nrows; i++) {
    let st = '';
    for (let q = 0; q < nq; q++) {
      const r = rnd();
      st += r < 0.45 ? 'c' : r < 0.8 ? 'w' : r < 0.99 ? 'd' : 'n';
    }
    truth.push(st);
    const code = (0x100000 + i).toString(16).toUpperCase();
    const sd = sedi[i % sedi.length].replace(/"/g, '""');
    out += `${code},"${sd}",${st},${(rnd() * 60).toFixed(1)}\n`;
  }
  return { text: out, truth, sedi, nq };
}

const FIX = makeTable(600, 60, 7);
const src = E.parseTable(FIX.text, { name: 'fixture' });
const idx = new E.Index(src);

// ---------------------------------------------------------------- parsing
console.log('\nparseTable');
ok('rows', src.nrows === 600, src.nrows);
ok('questions', src.nq === 60, src.nq);
ok('4 sedi detected', src.sedi.length === 4, src.sedi);
ok('carries the code column', src.strNames.indexOf('code') >= 0, src.strNames);
ok('carries total score', src.numNames.indexOf('total score') >= 0, src.numNames);
ok('quoted sede parsed', src.sedi.indexOf('Roma "La Sapienza"') >= 0, src.sedi);
eq('cell state q0 row0', src.rowSede[0], 0);
const wide = 'idx,sede,q1,q2,q3,q4\n1,Milano,correct,wrong,blank,unseen\n2,Milano,A,C,B,B\n';
const wsrc = E.parseTable(wide, {});
ok('wide layout: 4 question columns', wsrc.nq === 4, wsrc.nq);
const wcells = () => { const t = new E.Index(wsrc); return t.rowCells(0); };
ok('wide: correct/wrong/blank/unseen map to 0,1,2,3',
  Array.from(wcells()).join(',') === '0,1,2,3', Array.from(wcells()));
const ksrc = E.parseTable(wide, { key: 'A C B B' });
ok('letters + answer key → correct/wrong',
  Array.from(new E.Index(ksrc).rowCells(1)).join(',') === '0,0,0,0',
  Array.from(new E.Index(ksrc).rowCells(1)));

// ---------------------------------------------------------------- cost model
console.log('\nscoring');
// row 0 truth string; build a query that agrees with it exactly on 20 questions
const t0 = FIX.truth[0].split('');
const map = { c: 1, w: 3, d: 4, n: 4 };
const perfect = new Uint8Array(60);
for (let q = 0; q < 20; q++) perfect[q] = map[t0[q]];
const p2 = new E.Index(src);
p2.setScope(-1);
for (let q = 0; q < 20; q++) p2.setQuestion(q, perfect[q]);
const pr = p2.rank(5);
ok('exact pattern → row 0 is the cheapest', pr.hits[0].row === 0, pr.hits.map(h => [h.row, h.cost]));
eq('exact pattern → best cost 0', pr.best, 0);
ok('answered count tracked', pr.answered === 20, pr.answered);

// one deliberate contradiction on an unfilled question should beat a perfect 20 on 'row 0' only if that row also agrees
const p3 = new E.Index(src);
for (let q = 0; q < 60; q++) p3.setQuestion(q, map[t0[q]]);
const all = p3.rank(3);
eq('all 60 agree → cost 0', all.best, 0);
ok('blank matches unseen for free', E.COST[4][2] === 0 && E.COST[4][3] === 0);
ok('all 60 agree → row 0 first', all.hits[0].row === 0, all.hits.map(h => h.row));
ok('ambiguity is 1 with a full pattern', all.ambiguous === 1, all.ambiguous);
ok('entropy grows with the number of cells', all.bits > pr.bits, [all.bits, pr.bits]);

// unsure is cheap: swapping sure→unsure on a correct row must not cost more than half a point
const p4 = new E.Index(src);
for (let q = 0; q < 20; q++) p4.setQuestion(q, t0[q] === 'c' ? 2 : map[t0[q]]);
const r4 = p4.rank(1);
ok('unsure on a correct row costs ≤ 1 half-point', r4.best <= 1 * (20 / 1), r4.best);

// contradiction is expensive (measured on the row we contradicted, not on the pool)
const p5 = new E.Index(src);
p5.setQuestion(0, t0[0] === 'c' ? 3 : 1);     // claim the opposite of row 0 on q1
p5.rank(1);
ok('contradicting a row costs 6 pts on that row', p5.cost[0] >= 12, p5.cost[0]);
ok('...and that row drops out of the top hit', p5.rank(1).hits[0].row !== 0);

// hard vs soft disagreement
const p6 = new E.Index(src);
p6.setScope(0);
for (let q = 0; q < 30; q++) p6.setQuestion(q, map[FIX.truth[4].split('')[q]]);   // a truthful pattern
const clean = p6.rank(3);
ok('a truthful pattern has no hard cells', clean.hard === 0 && clean.soft === 0, clean);
// flip three of them into an outright contradiction of that row
for (let q = 30; q < 33; q++) p6.setQuestion(q, FIX.truth[4][q] === 'c' ? 3 : 1);
const bad = p6.rank(3);
ok('contradicting 3 cells is reported as 3 hard cells', bad.hard === 3, [bad.hard, bad.best]);
ok('...and the verdict refuses to call it a match', E.verdict(bad).tone === 'bad', E.verdict(bad).text);
ok('cost of a hard cell is exactly 6 pts', E.COST[1][1] === 12 && ptish(E.COST[1][1]) === 6);
function ptish(h) { return h / 2; }

// ---------------------------------------------------------------- incremental
console.log('\nincremental == rebuild');
const inc = new E.Index(src);
const ref = new E.Index(src);
let s2 = 12345;
const rnd2 = () => (s2 = (s2 * 1103515245 + 12345) >>> 0) / 4294967296;
for (let step = 0; step < 400; step++) {
  const q = (rnd2() * 60) | 0, st = (rnd2() * 5) | 0;
  inc.setQuestion(q, st);                       // incremental folds
  ref.setQuestion(q, st);
  ref.dirty = true;                              // force a cold rebuild each time
  ref.rebuild();
  if (step % 97 === 0) {
    const a = inc.rank(3, E.TOL), b = ref.rank(3, E.TOL);
    if (a.best !== b.best || a.hits[0].row !== b.hits[0].row || a.ambiguous !== b.ambiguous) {
      ok(`step ${step} diverged`, false, [a, b]);
      break;
    }
  }
}
ok('400 random edits kept incremental costs in lockstep with cold rebuilds', true);
const ai = inc.rank(4), ar = ref.rank(4);
ok('final ranking identical', ai.hits.map(h => h.row + ':' + h.cost).join() === ar.hits.map(h => h.row + ':' + h.cost).join());
inc.setScope(2); ref.setScope(2);
ok('sede scope changes the pool', ai.pool !== inc.rank(4).pool);
ok('scoped pool = rows in that sede', inc.rank(4).pool === idx.sedeCount[2],
  [inc.rank(4).pool, idx.sedeCount[2]]);
ok('erase (state 0) lowers the cost', (() => {
  const before = inc.rank(1, 0).best;
  inc.setQuestion(0, 0);
  return inc.rank(1, 0).best <= before;
})());

// ---------------------------------------------------------------- scope + sede
console.log('\nsede filtering');
const perPool = [-1, 0, 1].map(sc => { const t = new E.Index(src); t.setScope(sc); return t.rank(1).pool; });
ok('every sede > single sede', perPool[0] > perPool[1] && perPool[1] === perPool[2], perPool);
ok('row 0 lives in pool "Milano" when unscoped-by-index', idx.rowSede[0] === 0);

// ---------------------------------------------------------------- blob roundtrip
console.log('\nblob pack / parse');
const blob = E.packBlob(src);
const back = E.parseBlob(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
ok('blob magic', blob[0] === 0x49 && blob[1] === 0x4d);
eq('rows survive', back.nrows, src.nrows);
eq('nq survives', back.nq, src.nq);
eq('stride survives', back.stride, src.stride);
eq('sedi survive', back.sedi.length, src.sedi.length);
ok('numeric column survives', Math.abs(back.num['total score'][3] - src.num['total score'][3]) < 1e-4);
ok('string column survives', back.strs.code[7] === src.strs.code[7]);
ok('packed codes byte-identical',
  Buffer.from(back.codes).equals(Buffer.from(src.codes)));
const idx2 = new E.Index(back);
const r1 = idx.rank(6, E.TOL, false), r2 = idx2.rank(6, E.TOL, false);
ok('search over the re-parsed blob is the same',
  r1.hits.map(h => h.row + ':' + h.cost).join() === r2.hits.map(h => h.row + ':' + h.cost).join());
ok('the searchable core is 2 bits/question (600x15 = 9000 B)',
  back.codes.length === 600 * 15 && blob.length < 26000, [back.codes.length, blob.length]);
idx.reset(); idx2.reset();

// ---------------------------------------------------------------- query parsing
console.log('\nquery parsing');
const qa = E.parseAnswers('1-14=sure, 15-22=unsure, 23=w, 24=b', 60);
ok('ranges: q1..q14 sure', qa.slice(0, 14).every(x => x === 1));
ok('ranges: q15..q22 unsure', qa.slice(14, 22).every(x => x === 2));
eq('q23 wrong', qa[22], 3);
eq('q24 blank', qa[23], 4);
eq('q25 untouched', qa[24], 0);
const qb = E.parseAnswers('s u w b', 6);
ok('bare state run fills from q1', Array.from(qb).join(',') === '1,2,3,4,0,0',
  Array.from(qb).join(','));
const qc = E.parseAnswers('7u, 8u, 9?', 60);
ok('compact tokens + explicit unset', qc[6] === 2 && qc[7] === 2 && qc[8] === 0);
let threw = false;
try { E.parseAnswers('3=banana', 60); } catch (e) { threw = /unknown state/.test(e.message); }
ok('bad state name is a clear error', threw);
for (const q of [qa, qb, qc, idx.query]) {
  const rt = E.unpackQuery(E.packQuery(q), q.length);
  ok('pack/unpack roundtrip', Array.from(q).join() === Array.from(rt).join());
}

// ---------------------------------------------------------------- fuzzy strings
console.log('\nfuzzy location');
const sedi = src.sedi;
ok('exact', E.resolveSede('Milano', sedi).idx === 0);
ok('case/accents/punctuation', E.resolveSede('  milano ', sedi).idx === 0);
ok('typo', E.resolveSede('Milan', sedi).idx === 0, E.resolveSede('Milan', sedi));
ok('substring', E.resolveSede('sapienza', sedi).idx === 1, E.resolveSede('sapienza', sedi));
ok('quotes stripped', E.resolveSede('la sapienza', sedi).idx === 1);
ok('padova wins over bari', E.resolveSede('pado', sedi).idx === 2);
ok('empty means everywhere', E.resolveSede('', sedi).idx === -1);
ok('ranked list is sorted by score',
  E.fuzzyRank('roma', sedi).every((r, i, a) => !i || a[i - 1].score >= r.score));
eq('edit distance', E.lev('kitten', 'sitting'), 3);

// ---------------------------------------------------------------- verdict + estimate
console.log('\nconfidence');
idx.setScope(0);
idx.reset();
ok('no query → muted verdict', E.verdict(idx.rank(3)).tone === 'muted');
// pick a target that is actually inside scope 0 (fixture assigns sede = row % 4)
const target = 12;
const tc = FIX.truth[target].split('');
for (let q = 0; q < 55; q++) idx.setQuestion(q, map[tc[q]]);
const good = idx.rank(5, E.TOL);
ok('a real full pattern finds its row at cost 0',
  good.hits.some(h => h.row === target && h.cost === 0), good.hits.map(h => [h.row, h.cost]));
ok('a real full pattern is alone', good.ambiguous === 1, good.ambiguous);
const vd = E.verdict(good);
ok('verdict says alone/fingerprint', /alone|fingerprint|only exact/.test(vd.text), vd.text);
ok('entropy over 55 cells is big', good.bits > 40, good.bits);
ok('collisions ~0', good.collisions < 1, good.collisions);
const est = idx.estimate({ trials: 12 });
ok('estimate runs and is a fraction', est && est.alone >= 0 && est.alone <= 1, est);
ok('estimate respects the pool', est.pool === idx.sedeCount[0]);
const band = idx.scoreBand();
ok('score band lo<=hi', band.lo <= band.hi, band);
ok('score band on all-correct is 1.5×n', (() => {
  const t = new E.Index(src);
  for (let q = 0; q < 60; q++) t.setQuestion(q, 1);
  const b = t.scoreBand();
  return Math.abs(b.lo - 90) < 1e-6 && Math.abs(b.hi - 90) < 1e-6;
})(), band);

// ---------------------------------------------------------------- perf claim
console.log('\nperformance (this box, cold-ish)');
const bigSrc = (() => {
  const t = makeTable(18000, 60, 99);
  return E.parseTable(t.text, { name: '18k' });
})();
const big = new E.Index(bigSrc);
let s3 = 3;
const rnd3 = () => (s3 = (s3 * 1103515245 + 12345) >>> 0) / 4294967296;
const NQ = 60;
const query = new Uint8Array(NQ);
for (let q = 0; q < 40; q++) query[q] = 1 + ((rnd3() * 4) | 0);
big.setScope(-1);
for (let q = 0; q < NQ; q++) if (query[q]) big.setQuestion(q, query[q]);
let t = E.now();
for (let i = 0; i < 20; i++) { big.dirty = true; big.rebuild(); }
const rebuildMs = (E.now() - t) / 20;
t = E.now();
for (let i = 0; i < 20; i++) big.rank(8, E.TOL, true);
const rankMs = (E.now() - t) / 20;
t = E.now();
for (let i = 0; i < 200; i++) big.setQuestion(i % NQ, 1 + (i % 4));
const editMs = (E.now() - t) / 200;
console.log(`  full rebuild (18,000×40 cells): ${rebuildMs.toFixed(2)} ms`);
console.log(`  rank/counting-sort:             ${rankMs.toFixed(2)} ms`);
console.log(`  one cell painted (diff pass):   ${(editMs * 1000).toFixed(0)} µs`);
ok('cold rebuild over 18k rows under 25ms', rebuildMs < 25, rebuildMs);
ok('a paint (what you feel per keystroke) under 1ms', editMs < 1, editMs);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
