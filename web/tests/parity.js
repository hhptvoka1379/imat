/* ============================================================================
 * Cross-implementation parity: the browser engine and tools/imat_fuzzy.py must
 * agree cell-for-cell on the same CSV, or one of them is wrong.
 *   node web/tests/parity.js            (needs python3 + data/imat-demo.csv)
 * It also round-trips the blob format both ways: python writes -> js reads,
 * js writes -> python reads.
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const E = require(path.join(ROOT, 'web', 'engine.js'));
const PY = path.join(ROOT, 'tools', 'imat_fuzzy.py');
const CSV = process.argv[2] || path.join(ROOT, 'data', 'imat-demo.csv');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '   → ' + JSON.stringify(x).slice(0, 400) : '')); }
};

if (!fs.existsSync(CSV)) {
  console.log('  (no ' + CSV + ' — run: python3 tools/imat_fuzzy.py demo)');
  process.exit(0);
}
const text = fs.readFileSync(CSV, 'utf8');

function py(args) {
  const out = cp.execFileSync('python3', [PY, ...args], { maxBuffer: 1 << 28, encoding: 'utf8' });
  return JSON.parse(out);
}

const src = E.parseTable(text, { name: path.basename(CSV) });
const idx = new E.Index(src);

const CASES = [
  { sede: 'Milano', answers: '1-14=sure,15-22=unsure,23=w,24=b' },
  { sede: 'milan', answers: '1-60=sure' },
  { sede: '', answers: '1-8=unsure,9-10=blank,11-12=wrong' },
  { sede: 'Roma Tor Vergata', answers: '1-10=sure,20-22=unsure,55=wrong,56=b' },
  { sede: 'Padova', answers: 's'.repeat(23) + 'u'.repeat(9) + 'w'.repeat(4) + 'b'.repeat(11) },
  { sede: 'Bari', answers: '1-59=sure' }
];

console.log(`\nparity · ${src.nrows.toLocaleString('en-US')} rows × ${src.nq} questions · js vs python\n`);

// a row straight out of the data, so cost 0 is achievable and "alone" is checkable
const target = 137;
const tcells = (() => { idx.setScope(-1); return Array.from(idx.rowCells(target)); })();
const fromRow = tcells.map(s => (s === 0 ? 's' : s === 1 ? 'w' : 'b')).join('');
CASES.push({ sede: src.sedi[idx.rowSede[target]], answers: fromRow.slice(0, 40), note: 'real row, 40 cells' });
CASES.push({ sede: src.sedi[idx.rowSede[target]], answers: fromRow, note: 'real row, all 60' });

for (const c of CASES) {
  const label = `${c.sede || 'everywhere'} · ${c.answers.length} chars ${c.note ? '(' + c.note + ')' : ''}`;
  let ref;
  try {
    ref = py(['search', '--csv', CSV, '--top', '12', '--tol', '2.0', '--json',
      ...(c.sede ? ['--sede', c.sede] : []), '--answers', c.answers]);
  } catch (e) {
    ok(label + ' — python ran', false, String(e).slice(0, 200));
    continue;
  }
  const js = new E.Index(src);
  js.setScope(c.sede ? E.resolveSede(c.sede, src.sedi).idx : -1);
  const q = E.parseAnswers(c.answers, src.nq, 1);
  for (let i = 0; i < q.length; i++) if (q[i]) js.setQuestion(i, q[i]);
  const res = js.rank(12, 4, true);

  const sameOrder = res.hits.map(h => h.row).join() === ref.hits.map(h => h.row).join();
  const costOk = res.hits.every((h, i) => Math.abs(h.cost / 2 - ref.hits[i].cost) < 1e-9);
  ok(label,
    res.pool === ref.pool && res.answered === ref.answered &&
    Math.abs(res.best / 2 - ref.best) < 1e-9 &&
    Math.abs(res.gap / 2 - ref.gap) < 1e-9 &&
    res.ambiguous === ref.ambiguous && res.hard === ref.hard && res.soft === ref.soft &&
    Math.abs(res.bits - ref.bits) < 1e-6 &&
    Math.abs(res.collisions - ref.collisions) < 1e-6 &&
    sameOrder && costOk,
    {
      pool: [res.pool, ref.pool], ans: [res.answered, ref.answered],
      best: [res.best / 2, ref.best], amb: [res.ambiguous, ref.ambiguous],
      bits: [res.bits, ref.bits], hard: [res.hard, ref.hard], soft: [res.soft, ref.soft], orderSame: sameOrder, costOk
    });
  // the actual per-question cells must agree too, not just the score
  if (res.hits.length && ref.hits.length) {
    const mine = Array.from(js.rowCells(res.hits[0].row)).join();
    ok(label + ' · top row cells identical', mine === ref.hits[0].cells.join(), [mine, ref.hits[0].cells.join()]);
  }
}

console.log('\nblob format interop');
const pyBin = path.join(ROOT, 'web', 'data', 'imat.bin');
if (fs.existsSync(pyBin)) {
  const buf = fs.readFileSync(pyBin);
  const b = E.parseBlob(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const jb = new E.Index(b);
  const ref = py(['search', '--bin', pyBin, '--top', '8', '--tol', '2.0', '--json', '--sede', 'Milano',
    '--answers', '1-14=sure,15-22=unsure,23=w,24=b']);
  const q = E.parseAnswers('1-14=sure,15-22=unsure,23=w,24=b', b.nq, 1);
  jb.setScope(E.resolveSede('Milano', b.sedi).idx);
  for (let i = 0; i < q.length; i++) if (q[i]) jb.setQuestion(i, q[i]);
  const r = jb.rank(8, 4, true);
  ok('python-built blob → js search agrees',
    r.pool === ref.pool && r.ambiguous === ref.ambiguous && Math.abs(r.best / 2 - ref.best) < 1e-9 &&
    r.hits.map(h => h.row).join() === ref.hits.map(h => h.row).join(),
    { pool: [r.pool, ref.pool], best: [r.best / 2, ref.best], amb: [r.ambiguous, ref.ambiguous] });
  ok('python-built blob carries sections for the UI',
    !!(b.meta && b.meta.sections && b.meta.sections.length === 5), b.meta && b.meta.sections);
} else {
  ok('web/data/imat.bin present (run tools/build_site.sh)', false);
}

const tmp = path.join(os.tmpdir(), `imat-js-${process.pid}.bin`);
fs.writeFileSync(tmp, Buffer.from(E.packBlob(src)));
try {
  const info = cp.execFileSync('python3', [PY, 'info', tmp], { encoding: 'utf8' });
  const m = /rows ([\d,]+) · questions (\d+)/.exec(info);
  ok('js-packed blob → python reads it',
    !!m && Number(m[1].replace(/,/g, '')) === src.nrows && Number(m[2]) === src.nq,
    { got: m && m.slice(1), want: [src.nrows, src.nq] });
  const ref2 = py(['search', '--bin', tmp, '--top', '6', '--tol', '2.0', '--json', '--answers', '1-30=sure']);
  const jc = new E.Index(src);
  const q2 = E.parseAnswers('1-30=sure', src.nq, 1);
  for (let i = 0; i < q2.length; i++) if (q2[i]) jc.setQuestion(i, q2[i]);
  const r2 = jc.rank(6, 4, false);
  ok('js-packed blob → python search agrees',
    r2.pool === ref2.pool && r2.hits.map(h => h.row).join() === ref2.hits.map(h => h.row).join(),
    { js: r2.hits.map(h => h.row), py: ref2.hits.map(h => h.row) });
} catch (e) {
  ok('python read the js blob', false, String(e.stderr || e).slice(0, 300));
} finally {
  fs.unlinkSync(tmp);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
