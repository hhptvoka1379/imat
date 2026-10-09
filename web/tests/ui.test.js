/* ============================================================================
 * End-to-end UI test. Loads the real index.html in jsdom, feeds it the real
 * demo blob, paints cells, and checks the panel answers like the engines do.
 *   node web/tests/ui.test.js
 * Needs jsdom (optional):  cd web && npm i -D jsdom
 * Skips politely when jsdom is not installed.
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB = path.resolve(__dirname, '..');
const ROOT = path.resolve(WEB, '..');
const E = require(path.join(WEB, 'engine.js'));

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  try {
    ({ JSDOM, VirtualConsole } = require(path.join(process.env.HOME || '/home/user', '.tools', 'jd', 'node_modules', 'jsdom')));
  }
  catch (e2) { console.log('  · jsdom not installed — skipping the UI test (npm i -D jsdom in web/)'); process.exit(0); }
}
const jsErrors = [];

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (x !== undefined ? '   → ' + JSON.stringify(x).slice(0, 300) : '')); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const settle = async (dom, n) => { for (let i = 0; i < (n || 12); i++) await wait(35); };

(async () => {
  const binPath = path.join(WEB, 'data', 'imat.bin');
  if (!fs.existsSync(binPath)) { console.log('  · no web/data/imat.bin — run tools/build_site.sh'); process.exit(1); }
  const csv = fs.readFileSync(path.join(ROOT, 'data', 'imat-demo.csv'), 'utf8').split(/\r?\n/);

  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    const m = String(err && (err.message || err));
    if (/Could not parse CSS|not implemented/i.test(m)) return;   // jsdom gaps, not our bugs
    jsErrors.push(m);
  });
  vc.on('error', (m) => jsErrors.push(String(m)));
  const dom = new JSDOM(html, {
    url: pathToFileURL(path.join(WEB, 'index.html')).href,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.TextEncoder = TextEncoder;
      win.TextDecoder = TextDecoder;
      win.fetch = (u) => {
        const p = path.join(WEB, String(u).replace(/^\.?\//, ''));
        if (!fs.existsSync(p)) return Promise.reject(new Error('404 ' + path.basename(p)));
        const buf = fs.readFileSync(p);
        return Promise.resolve({
          ok: true, status: 200,
          arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
        });
      };
    }
  });
  const win = dom.window, doc = win.document;
  await wait(400);
  await settle(dom);

  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));

  console.log('\nUI · jsdom end-to-end\n');

  // ---------------------------------------------------------------- boot
  ok('deck rendered', $$('#deck .cell').length === 60, $$('#deck .cell').length);
  ok('dataset banner filled', /18,000 rows/.test($('#dsName').textContent), $('#dsName').textContent);
  ok('sections grouped from blob meta', $$('#deck .sec').length === 5, $$('#deck .sec').length);
  ok('sede datalist populated', $$('#sedilist option').length === 19, $$('#sedilist option').length);
  ok('quick chips present', $$('#sedeChips button').length >= 4, $$('#sedeChips button').length);
  ok('loader skeleton gone', !$('#loadMsg') || !/warming up/.test($('#loadMsg').textContent));
  ok('brush defaults to sure', $('.brush[data-brush="1"]').getAttribute('aria-pressed') === 'true');
  ok('engine fell back to inline (file://)', typeof win.Worker === 'undefined' || !win.Worker);

  // ---------------------------------------------------------------- painting
  const cell = (q) => $$(`#deck .cell`)[q];
  const paintClick = (q, opts) => {
    const el = cell(q);
    const ev = new win.MouseEvent('pointerdown', Object.assign({ bubbles: true, cancelable: true, clientX: 1, clientY: 1 }, opts || {}));
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    el.dispatchEvent(ev);
    return el;
  };
  paintClick(0);
  await settle(dom, 4);
  ok('click paints the armed brush', cell(0).dataset.state === '1', cell(0).dataset.state);
  ok('filled counter moved', $('#filledN').textContent === '1', $('#filledN').textContent);

  $('.brush[data-brush="2"]').click();
  paintClick(1); paintClick(2);
  $('.brush[data-brush="4"]').click();
  paintClick(3);
  await settle(dom, 5);
  ok('brush switch works', cell(1).dataset.state === '2' && cell(3).dataset.state === '4',
    [cell(1).dataset.state, cell(3).dataset.state]);
  ok('coalesced into one result', $('#filledN').textContent === '4', $('#filledN').textContent);
  ok('hits list rendered', $$('#hits li').length > 0, $$('#hits li').length);
  ok('verdict is talking', $('#verdictText').textContent.length > 8, $('#verdictText').textContent);
  ok('timing chip shows sub-ms', /[0-9]/.test($('#msChip').textContent), $('#msChip').textContent);
  ok('stat line reports throughput', /rows\/s/.test($('#statLine').textContent), $('#statLine').textContent);
  ok('diff strip drawn', $$('#detail .diff .d').length === 60, $$('#detail .diff .d').length);

  // undo
  const before = cell(3).dataset.state;
  $('#btnUndo').click();
  await settle(dom, 4);
  ok('undo reverts a paint', cell(3).dataset.state === '0' && before === '4', [cell(3).dataset.state, before]);

  // keyboard
  const key = (k) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
  $('#btnClear').click();
  await settle(dom, 4);
  key('1'); key('2'); key('Enter');           // jump to q12
  await settle(dom, 2);
  ok('number+jump moves the cursor', cell(11).classList.contains('cursor'),
    $$('#deck .cell').findIndex(c => c.classList.contains('cursor')));
  key('u');
  await settle(dom, 4);
  ok('keyboard paint', cell(11).dataset.state === '2' && $('#filledN').textContent === '1', cell(11).dataset.state);
  key('s');
  await settle(dom, 3);
  ok('painting advances the cursor (vim-style)', cell(12).dataset.state === '1' &&
    cell(13).classList.contains('cursor'),
    { s12: cell(12).dataset.state, cur: $$('#deck .cell').findIndex(c => c.classList.contains('cursor')) });
  key('Backspace');
  await settle(dom, 3);
  ok('backspace erases', cell(13).dataset.state === '0');

  // ---------------------------------------------------------------- paste spec
  $('#btnClear').click();
  await settle(dom, 4);
  $('#spec').value = '1-14=sure, 15-22=unsure, 23=w, 24=b';
  $('#btnApply').click();
  await settle(dom, 6);
  ok('typed spec applies to the deck', cell(0).dataset.state === '1' && cell(20).dataset.state === '2' &&
    cell(22).dataset.state === '3' && cell(23).dataset.state === '4',
    [cell(0).dataset.state, cell(20).dataset.state, cell(22).dataset.state, cell(23).dataset.state]);
  ok('and to the counter', $('#filledN').textContent === '24', $('#filledN').textContent);

  // ---------------------------------------------------------------- sede
  $('#sede').value = 'milano bicoca';         // typo'd on purpose
  $('#sede').dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(dom, 6);
  ok('fuzzy sede resolves a typo', /Milano Bicocca/.test($('#poolLine').textContent), $('#poolLine').textContent);
  ok('pool shrank to that sede', /947/.test($('#poolLine').textContent), $('#poolLine').textContent);

  // ---------------------------------------------------------------- the real thing:
  // a person's full pattern must resolve to exactly one row, and the panel must
  // show that row's own code from the dataset.
  $('#sede').value = '';
  $('#sede').dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(dom, 4);
  const row = 137;
  const cells = E.splitLine(csv[row + 1], ',');
  const code = cells[0], sede = cells[1], answers = cells[2];
  const pattern = answers.split('').map(ch => ({ c: 's', w: 'w', d: 'b', n: 'b' }[ch] || 'b')).join('');
  $('#sede').value = sede;
  $('#sede').dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle(dom, 4);
  $('#spec').value = pattern;
  $('#btnApply').click();
  await settle(dom, 8);
  const verdictTxt = $('#verdictText').textContent;
  ok('a real 60-cell pattern returns at cost 0', $('#mBest').textContent === '0', $('#mBest').textContent);
  ok('and it is alone', /alone|fingerprint|only exact/.test(verdictTxt), verdictTxt);
  ok('exactly one indistinguishable row', $('#mAmb').textContent === '1', $('#mAmb').textContent);
  ok('the winning row shows the dataset code', $$('#hits li .code')[0].textContent === code,
    [$$('#hits li .code')[0].textContent, code]);
  ok('winning row is highlighted', $$('#hits li')[0].className.indexOf('win') >= 0);
  ok('entropy is large', parseFloat($('#mBits').textContent) > 70, $('#mBits').textContent);
  ok('confidence bar full', $('#confBar').style.width === '100%', $('#confBar').style.width);
  ok('score band matches the row', (() => {
    const n = (answers.match(/c/g) || []).length, w = (answers.match(/w/g) || []).length;
    const want = (n * 1.5 - w * 0.4).toFixed(1);
    return $('#mScore').textContent === want;
  })(), $('#mScore').textContent);

  // ---------------------------------------------------------------- estimate
  $('#btnEstimate').click();
  await settle(dom, 30);
  ok('the honesty check runs', /replayed on/.test($('#estLine').textContent), $('#estLine').textContent.slice(0, 120));
  ok('and reports a percentage', /\d+%/.test($('#estLine').textContent), $('#estLine').textContent.slice(0, 120));

  // ---------------------------------------------------------------- details + theme
  $$('#hits li')[0].click();
  await settle(dom, 3);
  ok('row detail opens with the raw table', /code=|row /.test($('#detail').textContent), $('#detail').textContent.slice(0, 80));
  $('#btnTheme').click();
  ok('theme toggles', doc.documentElement.dataset.theme === 'light', doc.documentElement.dataset.theme);

  // no console errors escaped
  ok('no uncaught errors', jsErrors.length === 0, jsErrors.slice(0, 3));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  ✗ harness blew up\n' + (e && e.stack || e)); process.exit(1); });
