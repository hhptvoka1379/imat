/* ============================================================================
 * IMAT · find your line — the UI.
 * Talks to worker.js through one message protocol (see core.js). If workers are
 * unavailable (file://, ancient browser) it attaches the very same handler
 * in-process, so behaviour is identical, only the thread differs.
 * ==========================================================================*/
(function () {
  'use strict';
  var E = window.IMATEngine;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var STATE_NAMES = ['—', 'sure', 'unsure', 'wrong', 'blank'];
  var LS = 'imat.find-your-line.v1';

  var ui = {
    brush: 1, cursor: 0, cells: [], nq: 0, loaded: false,
    pending: new Map(), raf: 0, undo: [], lastRes: null, sedeIdx: -1, sedi: [],
    jump: ''
  };

  // ---------------------------------------------------------------- bridge
  var send, worker = null;
  function boot() {
    try {
      if (window.Worker && location.protocol !== 'file:') {
        worker = new Worker('worker.js');
        worker.onmessage = function (ev) { onMsg(ev.data); };
        worker.onerror = function (e) {
          toast('worker failed (' + (e.message || 'blocked') + ') — running inline', true);
          degrade();
        };
        send = function (m, t) { t ? worker.postMessage(m, t) : worker.postMessage(m); };
        return;
      }
    } catch (e) { /* fall through */ }
    degrade();
  }
  var localCore = null;
  function degrade() {
    var hadData = ui.loaded;
    worker = null;
    localCore = window.IMATCore.create(E, function (m) { onMsg(m); });
    send = function (m) { localCore.handle(m); };
    ui.loaded = false;
    if (hadData) loadDefault();
  }

  // ---------------------------------------------------------------- toasts
  function toast(text, bad) {
    var el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.classList.add('gone'); }, 2600);
    setTimeout(function () { el.remove(); }, 3100);
  }

  // ---------------------------------------------------------------- deck
  function buildDeck(info) {
    var nq = info.nq, n = Math.max(1, info.sedi.length);
    ui.nq = nq;
    var host = $('#deck');
    host.innerHTML = '';
    ui.cells = new Array(nq);
    var groups = [];
    if (info.sections && info.sections.length) {
      info.sections.forEach(function (s) { groups.push([s.name, s.from, s.to]); });
      var covered = info.sections.reduce(function (a, s) { return a + (s.to - s.from + 1); }, 0);
      if (covered < nq) groups.push(['rest', covered + 1, nq]);
    } else {
      for (var i = 1; i <= nq; i += 10) groups.push(['q' + i + '–q' + Math.min(i + 9, nq), i, Math.min(i + 9, nq)]);
    }
    groups.forEach(function (g) {
      var sec = document.createElement('div');
      sec.className = 'sec';
      var head = document.createElement('div');
      head.className = 'sec-h';
      head.innerHTML = '<span></span><i></i>';
      head.firstChild.textContent = g[0];
      var from = Math.max(1, g[1] | 0), to = Math.min(nq, g[2] | 0);
      head.insertAdjacentHTML('beforeend', '<span class="num" style="opacity:.6">' + from + '–' + to + '</span>');
      var wrap = document.createElement('div');
      wrap.className = 'cells';
      for (var q = from; q <= to; q++) {
        var b = document.createElement('button');
        b.className = 'cell';
        b.type = 'button';
        b.dataset.q = q - 1;
        b.dataset.state = '0';
        b.textContent = q;
        b.title = 'q' + q + ' — ' + STATE_NAMES[ui.brush];
        b.setAttribute('aria-label', 'question ' + q);
        wrap.appendChild(b);
        ui.cells[q - 1] = b;
      }
      sec.appendChild(head);
      sec.appendChild(wrap);
      host.appendChild(sec);
    });
    $('#filledT').textContent = nq;
    wirePaint();

    var dl = $('#sedilist');
    dl.innerHTML = '';
    info.sedi.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s;
      dl.appendChild(o);
    });
    ui.sedi = info.sedi;
    var chips = $('#sedeChips');
    chips.innerHTML = '';
    var top = info.sedeCount.slice(0, 6);
    top.forEach(function (s) {
      var i = info.sedi.indexOf(s.name);
      var btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.innerHTML = '<span>' + esc(s.name) + '</span><span class="num" style="opacity:.55">' + s.n + '</span>';
      btn.onclick = function () {
        $('#sede').value = ui.sedeIdx === i ? '' : s.name;
        applySede();
      };
      chips.appendChild(btn);
    });
    if (info.sedi.length > 1) {
      var all = document.createElement('button');
      all.className = 'btn btn-sm btn-ghost';
      all.textContent = 'everywhere';
      all.onclick = function () { $('#sede').value = ''; applySede(); };
      chips.appendChild(all);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function paint(q, state) {
    var el = ui.cells[q];
    if (!el) return;
    var old = Number(el.dataset.state);
    if (old === state) return;
    el.dataset.state = String(state);
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    ui.undo.push([q, old]);
    ui.pending.set(q, state);
    queueFlush();
  }

  function queueFlush() {
    if (ui.raf) return;
    ui.raf = requestAnimationFrame(function () {
      ui.raf = 0;
      if (!ui.pending.size) return;
      var changes = [];
      ui.pending.forEach(function (v, k) { changes.push([k, v]); });
      ui.pending.clear();
      var filled = 0;
      for (var i = 0; i < ui.cells.length; i++) {
        var s = ui.cells[i] ? Number(ui.cells[i].dataset.state) : 0;
        if (s) filled++;
      }
      $('#filledN').textContent = filled;
      send({ type: 'paint', changes: changes });
      save();
    });
  }

  // ---------------------------------------------------------------- painting
  var dragging = false;
  function wirePaint() {
    var deck = $('#deck');
    deck.onpointerdown = function (ev) {
      var cell = (ev.target && ev.target.closest) ? ev.target.closest('.cell') : null;
      if (!cell) return;
      dragging = true;
      try { deck.setPointerCapture(ev.pointerId); } catch (e) { }
      var q = Number(cell.dataset.q);
      var st = ev.button === 2 ? 0 : ui.brush;
      if (ev.shiftKey) { paintRange(ui.cursor, q, st); dragging = false; return; }
      ui.cursor = q;
      markCursor();
      paint(q, st);
      ev.preventDefault();
    };
    deck.onpointermove = function (ev) {
      if (!dragging) return;
      var el = document.elementFromPoint(ev.clientX, ev.clientY);
      var cell = el && el.closest ? el.closest('.cell') : null;
      if (!cell) return;
      paint(Number(cell.dataset.q), ui.brush);
    };
    deck.onpointerup = deck.onpointercancel = function () { dragging = false; };
    deck.oncontextmenu = function (ev) { if (ev.target.closest && ev.target.closest('.cell')) ev.preventDefault(); };
  }

  function paintRange(a, b, st) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    for (var q = lo; q <= hi; q++) paint(q, st);
  }

  function markCursor() {
    for (var i = 0; i < ui.cells.length; i++) {
      if (ui.cells[i]) ui.cells[i].classList.toggle('cursor', i === ui.cursor);
    }
  }

  function moveCursor(d) {
    ui.cursor = Math.max(0, Math.min(ui.nq - 1, ui.cursor + d));
    markCursor();
    var el = ui.cells[ui.cursor];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- keys
  function isField(t) {
    return !!(t && typeof t.matches === 'function' && t.matches('input,textarea,select,[contenteditable]'));
  }
  document.addEventListener('keydown', function (ev) {
    if (isField(ev.target)) return;
    var k = String(ev.key || '').toLowerCase();
    if (k === 'arrowright' || k === 'l') { moveCursor(1); ev.preventDefault(); return; }
    if (k === 'arrowleft' || k === 'h') { moveCursor(-1); ev.preventDefault(); return; }
    if (k === 'arrowdown' || k === 'j') { moveCursor(10); ev.preventDefault(); return; }
    if (k === 'arrowup' || k === 'k') { moveCursor(-10); ev.preventDefault(); return; }
    if (k >= '0' && k <= '9' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ui.jump === '' && k === '0') { return; }
      ui.jump = (ui.jump + k).slice(0, 3);
      flashJump();
      ev.preventDefault();
      return;
    }
    if (k === 'enter' && ui.jump) {
      var q = Math.min(ui.nq, parseInt(ui.jump, 10)) - 1;
      ui.jump = '';
      $('#loadMsg') && null;
      ui.cursor = Math.max(0, q);
      markCursor();
      var el = ui.cells[ui.cursor];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (el) el.focus();
      return;
    }
    if (k === 'backspace') {
      if (ui.jump) { ui.jump = ui.jump.slice(0, -1); flashJump(); ev.preventDefault(); return; }
      paint(ui.cursor, 0); moveCursor(1); ev.preventDefault(); return;
    }
    var map = { s: 1, u: 2, w: 3, b: 4 };
    if (map[k] && ui.loaded) { setBrush(map[k]); paint(ui.cursor, map[k]); moveCursor(1); ev.preventDefault(); return; }
    if (k === 'z') { undo(); ev.preventDefault(); return; }
    if (k === 'escape') { ui.jump = ''; flashJump(); return; }
  });

  function flashJump() {
    $('#msChip').textContent = ui.jump ? '→ q' + ui.jump : (ui.lastRes ? fmtMs(ui.lastRes.ms) : '–');
  }

  function undo() {
    var n = 0, last = -1;
    while (ui.undo.length && n < 24) {
      var e = ui.undo.pop();
      if (!e) break;
      if (e[0] === last && n) break;
      last = e[0];
      var el = ui.cells[e[0]];
      if (el) { el.dataset.state = String(e[1]); ui.pending.set(e[0], e[1]); }
      n++;
    }
    if (n) queueFlush();
  }

  // ---------------------------------------------------------------- brush
  function setBrush(st) {
    ui.brush = st;
    $$('.brush').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.brush) === st)); });
    for (var i = 0; i < ui.cells.length; i++) {
      if (ui.cells[i]) ui.cells[i].title = 'q' + (i + 1) + ' — ' + STATE_NAMES[st];
    }
  }
  $$('.brush').forEach(function (b) {
    b.onclick = function () { setBrush(Number(b.dataset.brush)); };
  });
  document.addEventListener('keydown', function (ev) {
    if (isField(ev.target)) return;
    var n = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 0 }[ev.key];
    if (n !== undefined && (ev.altKey || ev.metaKey)) { setBrush(n); ev.preventDefault(); }
  });

  // ---------------------------------------------------------------- sede
  function applySede() {
    var v = $('#sede').value.trim();
    if (!ui.loaded) return;
    var r = E.resolveSede(v, ui.sedi);
    ui.sedeIdx = v ? r.idx : -1;
    if (v && r.name && E.norm(r.name) !== E.norm(v)) {
      $('#poolLine').innerHTML = 'reading <b>' + esc(r.name) + '</b> for “' + esc(v) + '” · ' +
        (r.ranked.slice(1, 3).map(function (x) { return esc(x.name); }).join(' · ') || '');
    }
    send({ type: 'sede', idx: v ? r.idx : -1 });
    save();
  }
  var sedeTimer = 0;
  $('#sede').addEventListener('input', function () {
    clearTimeout(sedeTimer);
    sedeTimer = setTimeout(applySede, 90);
  });

  // ---------------------------------------------------------------- results
  function fmtMs(ms) { return ms < 1 ? (ms * 1000).toFixed(0) + 'µs' : ms.toFixed(ms < 10 ? 2 : 0) + 'ms'; }
  function pt(halfpoints) { return (halfpoints / 2).toFixed(halfpoints % 2 ? 1 : 0); }

  function onMsg(m) {
    if (m.type === 'ready') {
      ui.loaded = true;
      buildDeck(m.info);
      var rows = m.info.rows.toLocaleString('en-US');
      $('#dsName').textContent = m.info.name + ' · ' + rows + ' rows · ' + m.info.nq + ' questions';
      $('#loadMsg') && ($('#loadMsg').textContent = '');
      $('#footStat').textContent = rows + ' rows × ' + m.info.nq + ' questions · ' +
        Math.round(m.info.bytes / 1024) + ' KB on disk, ' +
        Math.round((m.info.rows * (m.info.nq / 4 + 1)) / 1024) + ' KB of it is the answer grid';
      restore();
      send({ type: 'search', top: 8 });
      return;
    }
    if (m.type === 'sede') return;
    if (m.type === 'error') { toast(m.msg, true); return; }
    if (m.type === 'estimate') { renderEstimate(m.est, m.ms); return; }
    if (m.type === 'export') {
      if (m.for === 'store') { idbPut(S_CACHE_KEY, m.buf); return; }
      downloadBlob(new Blob([m.buf], { type: 'application/octet-stream' }), 'imat.bin');
      return;
    }
    if (m.type === 'result') { render(m.res); return; }
  }

  function render(res) {
    ui.lastRes = res;
    if (res.query && ui.cells.length) {
      for (var ci = 0; ci < ui.cells.length; ci++) {
        if (ui.cells[ci]) ui.cells[ci].dataset.state = String(res.query[ci] || 0);
      }
      $('#filledN').textContent = res.answered;
    }
    $('#msChip').textContent = ui.jump ? '→ q' + ui.jump : fmtMs(res.ms);
    if (!res.pool) {
      $('#verdictText').textContent = 'nothing in that pool';
      $('#hits').innerHTML = '';
      return;
    }
    var v = res.verdict;
    var vd = $('#verdict');
    vd.dataset.tone = v.tone;
    $('#verdictText').textContent = v.text;

    $('#mBest').textContent = res.answered ? pt(res.best) : '–';
    var contra = res.hard ? ('<b style="color:var(--rose)">' + res.hard + '</b> cell' +
      (res.hard > 1 ? 's' : '') + ' contradict') : res.soft ? res.soft + ' soft cells' : 'nothing contradicts';
    $('#mGap').innerHTML = res.answered ? contra + (res.gap ? ' · next row +' + pt(res.gap) : ' · alone above') : 'lower = better';
    $('#mAmb').textContent = res.ambiguous.toLocaleString('en-US');
    $('#mBits').textContent = res.bits ? res.bits.toFixed(1) + ' bits' : '–';
    $('#mColl').textContent = res.answered
      ? (res.collisions < 0.001 ? '< 1 in 1,000 look-alikes' : res.collisions.toFixed(3) + ' look-alikes expected')
      : '–';
    var sc = res.score || { lo: 0, hi: 0 };
    $('#mScore').textContent = sc.lo === sc.hi ? sc.lo.toFixed(1) : sc.lo.toFixed(1) + '–' + sc.hi.toFixed(1);
    $('#mScoreSub').textContent = sc.answered
      ? sc.answered + ' filled · ' + (sc.hi - sc.lo).toFixed(1) + ' pts of slack'
      : '+1.5 right / −0.4 wrong';

    var alone = res.ambiguous === 1 && res.best <= E.TOL ? 1
      : Math.max(0.02, 1 - Math.min(1, Math.log2(Math.max(2, res.ambiguous)) / 7));
    $('#confBar').style.width = (alone * 100).toFixed(0) + '%';

    var poolTxt = ui.sedeIdx >= 0
      ? 'pool <b>' + res.pool.toLocaleString('en-US') + '</b> · ' + esc(ui.sedi[ui.sedeIdx] || '')
      : 'pool <b>' + res.pool.toLocaleString('en-US') + '</b> · every sede';
    $('#poolLine').innerHTML = poolTxt + ' · <b>' + res.answered + '</b> of ' + ui.nq + ' filled';
    $('#statLine').innerHTML = 'scored <b>' + res.pool.toLocaleString('en-US') + '</b> rows in <b>' +
      fmtMs(res.ms) + '</b> · ≈ ' + Math.round(res.rate / 1e6) + 'M rows/s';

    var html = '';
    res.hits.forEach(function (h, i) {
      var code = firstKey(h.info, /(code|codice|id|hash)/) || ('row ' + h.row);
      var score = firstNumKey(h.info, /(total|score|punteggio)/);
      html += '<li data-row="' + h.row + '" class="' + (i === 0 && res.ambiguous === 1 ? 'win' : '') + '">' +
        '<span class="rk"></span>' +
        '<span class="code">' + esc(code) + '</span>' +
        '<span class="cost">' + (h.cost ? pt(h.cost) : '0') + '</span>' +
        '<span class="meta">' + esc(h.sede) + (score ? ' · ' + score : '') + '</span></li>';
    });
    $('#hits').innerHTML = html || '<li>nothing yet</li>';
    $$('#hits li').forEach(function (li) {
      li.onclick = function () {
        var row = Number(li.dataset.row);
        renderDetail(row, res);
      };
    });
    renderDiff(res);
  }

  function firstKey(info, re) {
    for (var k in info) if (re.test(k) && info[k]) return String(info[k]);
    return null;
  }
  function firstNumKey(info, re) {
    for (var k in info) if (re.test(k)) {
      var v = info[k];
      if (typeof v === 'number' && isFinite(v)) return v.toFixed(1);
    }
    return null;
  }

  function renderDiff(res) {
    var host = $('#detail');
    if (!res.cells || !res.cells.length || !res.answered) {
      if (host.querySelector('.diff')) host.innerHTML = '';
      return;
    }
    var q = res.query, out = '', hard = 0;
    for (var i = 0; i < q.length; i++) {
      var cost = q[i] ? E.COST[q[i]][res.cells[i]] : -1;
      var k = cost < 0 ? 3 : cost === 0 ? 1 : cost <= 1 ? 2 : 0;
      var dn = (res.stateNames && res.stateNames[res.cells[i]]) || res.cells[i];
      if (k === 0) hard++;
      out += '<span class="d" data-k="' + k + '" title="q' + (i + 1) + '  you: ' + STATE_NAMES[q[i]] +
        '  row: ' + dn + '  cost ' + (cost / 2).toFixed(1) + '"></span>';
    }
    var legend = hard
      ? '<span class="hint">' + hard + ' cell' + (hard > 1 ? 's' : '') +
        ' flatly contradict' + ' you — ' + '</span>'
      : '<span class="hint">top row agrees with every cell you filled</span>';
    host.innerHTML = '<div class="diff">' + out + '</div><div style="margin-top:7px">' + legend +
      '<span class="hint"> · each square is a question: green agrees, red contradicts, amber is soft, grey is blank</span></div>';
  }

  function renderDetail(row, res) {
    var idx = localCore ? localCore.state.idx : null;
    if (!idx && !worker) return;
    if (!idx) { toast('open the row list — the per-question breakdown is local', true); return; }
    var cells = idx.rowCells(row), info = idx.rowInfo(row), bits = '';
    for (var q = 0; q < cells.length; q++) {
      var mine = res.query[q];
      bits += '<span class="num" style="display:inline-block;min-width:8.6em">' +
        'q' + (q + 1) + ' ' + (mine ? STATE_NAMES[mine] : '·') + ' → ' + idx.stateNames[cells[q]] + '</span>';
    }
    $('#detail').innerHTML = '<details open><summary class="hint" style="cursor:pointer">row ' + row +
      ' — ' + esc(Object.keys(info).map(function (k) {
        var v = info[k]; return k + '=' + (typeof v === 'number' ? v.toFixed(1) : v);
      }).join('  ')) + '</summary><div style="font-size:11.5px;color:var(--ink-dim);line-height:1.9">' +
      bits + '</div></details>';
  }

  function renderEstimate(est, ms) {
    if (!est) { $('#estLine').textContent = 'paint at least one question first.'; return; }
    $('#estLine').innerHTML = 'replayed on <b>' + est.trials + '</b> real rows from this pool: ' +
      '<b>' + (est.alone * 100).toFixed(0) + '%</b> of the time a recall like yours leaves exactly one row ' +
      'and it is the right one, <b>' + (est.inTop3 * 100).toFixed(0) + '%</b> of the time it is in the top 3 ' +
      '(avg ' + est.meanAmbiguity.toFixed(1) + ' look-alikes) · ' + fmtMs(ms || 0) +
      '<br><span style="opacity:.7">blurred with your own fill ratio: ' + Math.round(est.forget * 100) +
      '% forgotten, ' + Math.round(est.doubt * 100) + '% unsure, 6% misremembered</span>';
  }

  // ---------------------------------------------------------------- buttons
  $('#btnApply').onclick = function () {
    send({ type: 'paint', bulk: true, spec: $('#spec').value.trim() || 'clear' });
  };
  $('#btnApplyAdd').onclick = function () {
    send({ type: 'paint', bulk: true, spec: $('#spec').value.trim(), add: true });
  };
  $('#btnClear').onclick = function () {
    send({ type: 'paint', bulk: true, spec: 'clear' });
    ui.undo = [];
  };
  $('#btnUndo').onclick = undo;
  $('#btnEstimate').onclick = function () {
    if (!ui.loaded) return toast('no dataset yet', true);
    $('#estLine').textContent = 'replaying…';
    send({ type: 'estimate', trials: 48 });
  };
  $('#btnExport').onclick = function () { if (ui.loaded) send({ type: 'export' }); };
  $('#btnShare').onclick = function () {
    if (!ui.lastRes) return;
    var packed = E.packQuery(ui.lastRes.query);
    var base = location.href.split('#')[0];
    var url = base + '#p=' + packed + '&s=' + ui.sedeIdx;
    history.replaceState(null, '', '#p=' + packed + '&s=' + ui.sedeIdx);
    copy(url).then(function () { toast('pattern link copied — the data still only lives in this tab'); },
      function () { toast(url, true); });
  };
  $('#btnImport').onclick = function () { $('#file').click(); };
  $('#file').onchange = function (ev) { if (ev.target.files[0]) loadFile(ev.target.files[0]); };
  $('#btnTheme').onclick = function () {
    var r = document.documentElement;
    var next = (r.dataset.theme === 'light') ? 'dark' : 'light';
    r.dataset.theme = next;
    $('#btnTheme').textContent = next === 'light' ? '☀' : '☾';
    try { localStorage.setItem(LS + '.theme', next); } catch (e) { }
  };

  function syncFromQuery() {
    if (!ui.lastRes) return;
    var q = ui.lastRes.query;
    for (var i = 0; i < ui.cells.length; i++) {
      if (ui.cells[i]) ui.cells[i].dataset.state = String(q[i] || 0);
    }
    $('#filledN').textContent = q.filter(function (x) { return x; }).length;
    save();
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); ta.remove(); return Promise.resolve(); }
    catch (e) { ta.remove(); return Promise.reject(e); }
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  // ---------------------------------------------------------------- data io
  /* A CSV you drop in is re-parsed from scratch every visit unless we keep the packed
   * form around. IndexedDB is per-origin and per-device, so this is a private cache:
   * the table itself never leaves the tab, and clearing site data clears it. */
  var S_CACHE_KEY = '';
  function idb() {
    return new Promise(function (res, rej) {
      if (!root_hasIDB()) return rej(new Error('no idb'));
      var r = indexedDB.open('imat-find-your-line', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('blobs'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function root_hasIDB() { try { return !!window.indexedDB; } catch (e) { return false; } }
  function idbPut(key, val) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put(val, key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = tx.onabort = function () { res(false); };
      });
    }).catch(function () { return false; });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var rq = db.transaction('blobs', 'readonly').objectStore('blobs').get(key);
        rq.onsuccess = function () { rq.result ? res(rq.result) : rej(new Error('miss')); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }

  function loadFile(f) {
    var isBin = /\.bin$/i.test(f.name) || f.type === 'application/octet-stream';
    if (isBin) {
      f.arrayBuffer().then(function (buf) {
        send({ type: 'blob', buf: buf, name: f.name }, worker ? [buf] : undefined);
      });
      return;
    }
    var key = [f.name, f.size, f.lastModified || 0].join('|');
    idbGet(key).then(function (buf) {
      toast('restored ' + f.name + ' from the local cache');
      S_CACHE_KEY = key;
      send({ type: 'blob', buf: buf, name: f.name }, worker ? [buf] : undefined);
    }).catch(function () {
      var rd = new FileReader();
      rd.onload = function () {
        toast('parsing ' + (f.size / 1024).toFixed(0) + ' KB…');
        S_CACHE_KEY = key;
        send({ type: 'table', text: String(rd.result), opts: { name: f.name }, top: 8, cache: true });
        save();
      };
      rd.onerror = function () { toast('could not read that file', true); };
      rd.readAsText(f);
    });
    rd.onerror = function () { toast('could not read that file', true); };
    rd.readAsText(f);
  }

  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (ev) {
      if (ev.dataTransfer && Array.prototype.some.call(ev.dataTransfer.types || [], function (x) { return x === 'Files'; })) {
        document.body.classList.add('dragging');
        ev.preventDefault();
      }
    });
  });
  document.addEventListener('dragleave', function (ev) {
    if (!ev.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', function (ev) {
    if (!ev.dataTransfer || !ev.dataTransfer.files || !ev.dataTransfer.files.length) return;
    document.body.classList.remove('dragging');
    ev.preventDefault();
    loadFile(ev.dataTransfer.files[0]);
  });

  // ---------------------------------------------------------------- persist
  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        sedeText: $('#sede').value, sedeIdx: ui.sedeIdx, brush: ui.brush,
        cells: ui.cells.map(function (c) { return c ? Number(c.dataset.state) : 0; })
      }));
    } catch (e) { }
  }
  function restore() {
    var q = null, sedeIdx = null;
    var h = location.hash.slice(1);
    if (h) {
      var mp = /(?:^|&)p=([^&]+)/.exec(h);
      var ms = /(?:^|&)s=(-?\d+)/.exec(h);
      if (mp) q = E.unpackQuery(decodeURIComponent(mp[1]), ui.nq);
      if (ms) sedeIdx = Number(ms[1]);
    }
    if (!q) {
      try {
        var s = JSON.parse(localStorage.getItem(LS) || 'null');
        if (s && s.cells && s.cells.length) {
          q = new Uint8Array(s.cells.slice(0, ui.nq));
          if (s.sedeIdx !== undefined && s.sedeIdx >= 0) sedeIdx = s.sedeIdx;
          if (s.sedeText) $('#sede').value = s.sedeText;
          if (s.brush !== undefined) setBrush(s.brush);
        }
      } catch (e) { }
    }
    if (sedeIdx !== null && sedeIdx >= -1 && sedeIdx < ui.sedi.length) {
      if (!$('#sede').value && sedeIdx >= 0) $('#sede').value = ui.sedi[sedeIdx];
      ui.sedeIdx = sedeIdx;
      send({ type: 'sede', idx: sedeIdx });
    }
    if (q) {
      send({ type: 'paint', bulk: true, spec: queryToSpec(q), top: 8 });
      for (var i = 0; i < ui.cells.length; i++) {
        if (ui.cells[i]) ui.cells[i].dataset.state = String(q[i] || 0);
      }
      $('#filledN').textContent = Array.prototype.filter.call(q, function (x) { return x; }).length;
    }
  }
  function queryToSpec(q) {
    var out = '';
    for (var i = 0; i < q.length; i++) {
      out += '.suwb'[q[i] || 0];
    }
    // '.' is read as 'unset' by the parser, so a positional run restores exactly
    return out;
  }

  try {
    var th = localStorage.getItem(LS + '.theme');
    if (th) { document.documentElement.dataset.theme = th; $('#btnTheme').textContent = th === 'light' ? '☀' : '☾'; }
  } catch (e) { }

  // ---------------------------------------------------------------- go
  function noData(why) {
    var msg = $('#loadMsg');
    if (msg) {
      msg.innerHTML = 'no <span class="num">data/imat.bin</span> here yet' + (why ? ' (' + esc(why) + ')' : '') +
        '.<br>drop a <span class="num">.csv</span> anywhere on this page, or run ' +
        '<span class="num">tools/build_site.sh</span> to make the demo blob.';
    }
    var sp = $('#deck') && $('#deck').querySelector('.spin');
    if (sp) sp.remove();
  }
  function loadDefault() {
    if (typeof fetch !== 'function') { noData('no fetch'); return; }
    fetch('data/imat.bin').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      send({ type: 'blob', buf: buf, name: 'demo dataset' }, worker ? [buf] : undefined);
    }).catch(function (e) { noData(e && e.message); });
  }
  boot();
  loadDefault();
})();
