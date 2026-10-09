/* ============================================================================
 * IMAT core — the message protocol between the UI and the engine.
 * Lives in its own file because it is used twice: inside the Web Worker
 * (importScripts) and, as a fallback when workers can't load (file://),
 * attached directly to the main thread. Same handler, same numbers.
 * ==========================================================================*/
(function (root) {
  'use strict';

  function create(E, send) {
    var S = { idx: null, name: '', bytes: 0, lastMs: 0, lastN: 0, opts: {} };

    function info() {
      var i = S.idx;
      if (!i) return null;
      var top = i.sedi.map(function (n, k) { return { name: n, n: i.sedeCount[k] }; })
        .sort(function (a, b) { return b.n - a.n; });
      return {
        rows: i.nrows, nq: i.nq, sedi: i.sedi, sedeCount: top,
        stateNames: i.stateNames, meta: i.meta,
        numNames: i.numNames, strNames: i.strNames, bytes: S.bytes, name: S.name,
        sections: (i.meta && i.meta.sections) || [],
        note: (i.meta && i.meta.note) || ''
      };
    }

    function search(top, tol) {
      var t0 = E.now();
      var res = S.idx.rank(top || 8, tol === undefined ? E.TOL : tol, true);
      var ms = E.now() - t0;
      S.lastMs = ms; S.lastN = res.pool;
      res.ms = ms;
      res.rate = res.pool / Math.max(0.0005, ms / 1000);
      res.verdict = E.verdict(res);
      res.stateNames = S.idx.stateNames;
      res.query = Array.prototype.slice.call(S.idx.query);
      res.score = S.idx.scoreBand();
      res.cells = res.hits.length ? Array.prototype.slice.call(S.idx.rowCells(res.hits[0].row)) : [];
      return res;
    }

    function handle(msg) {
      try {
        switch (msg.type) {
          case 'blob': {
            var src = E.parseBlob(msg.buf);
            S.idx = new E.Index(src);
            S.name = msg.name || (src.meta && src.meta.source) || 'imat.bin';
            S.bytes = src.bytes;
            if (msg.query) S.idx.setQuery(E.unpackQuery(msg.query, S.idx.nq));
            send({ type: 'ready', info: info(), via: 'blob', ms: src.ms || 0 });
            send({ type: 'result', res: search(msg.top) });
            return;
          }
          case 'table': {
            var src2 = E.parseTable(msg.text, msg.opts || {});
            S.idx = new E.Index(src2);
            S.name = (msg.opts && msg.opts.name) || 'your table';
            S.bytes = msg.text.length;
            send({ type: 'ready', info: info(), via: 'table', ms: src2.ms, indexMs: 0 });
            send({ type: 'result', res: search(msg.top) });
            if (msg.cache) send({ type: 'export', for: 'store' });   // park the packed form in IDB
            return;
          }
          case 'ready':
            send({ type: 'ready', info: info(), via: 'noop', ms: 0 });
            return;
          case 'sede':
            if (!S.idx) return;
            S.idx.setScope(msg.idx);
            send({ type: 'sede', idx: S.idx.scopeSede, pool: S.idx.scope.length });
            send({ type: 'result', res: search(msg.top) });
            return;
          case 'locate': {
            var r = E.resolveSede(msg.q, S.idx ? S.idx.sedi : []);
            send({ type: 'locate', r: r });
            return;
          }
          case 'paint': {
            if (!S.idx) return;
            if (msg.changes) {
              // one coalesced batch (drag-painting) -> then exactly one search
              var cs = msg.changes;
              for (var c = 0; c < cs.length; c++) S.idx.setQuestion(cs[c][0], cs[c][1]);
              send({ type: 'result', res: search(msg.top, undefined, cs.length) });
              return;
            }
            if (msg.bulk) {
              var spec = msg.spec || '';
              if (spec === 'clear') {
                S.idx.reset();
              } else {
                var arr = E.parseAnswers(spec, S.idx.nq, msg.start || 1);
                var cur = S.idx.query;
                if (msg.add) {
                  // merge: only cells named in the spec touch the deck
                  for (var i = 0; i < arr.length; i++) {
                    if (arr[i] && cur[i] !== arr[i]) S.idx.setQuestion(i, arr[i]);
                  }
                } else {
                  // apply: the spec is the whole truth, so cells it leaves out go back to unset
                  for (var j = 0; j < arr.length; j++) {
                    if (arr[j] !== cur[j]) S.idx.setQuestion(j, arr[j]);
                  }
                }
              }
            } else {
              S.idx.setQuestion(msg.q | 0, msg.state | 0);
            }
            send({ type: 'result', res: search(msg.top) });
            return;
          }
          case 'search':
            if (S.idx) send({ type: 'result', res: search(msg.top, msg.tol) });
            return;
          case 'estimate':
            if (!S.idx) return;
            var t1 = E.now();
            var est = S.idx.estimate({ trials: msg.trials || 40, flip: msg.flip });
            send({ type: 'estimate', est: est, ms: E.now() - t1 });
            return;
          case 'export':
            if (!S.idx) return;
            var out = E.packBlob({
              nrows: S.idx.nrows, nq: S.idx.nq, stride: S.idx.stride, sedi: S.idx.sedi,
              rowSede: S.idx.rowSede, codes: S.idx.codes, stateNames: E.DATA_STATES,
              num: S.idx.num, numNames: S.idx.numNames, strs: S.idx.strs, strNames: S.idx.strNames,
              meta: Object.assign({}, S.idx.meta, {
                source: S.name, generated_at: new Date().toISOString(),
                generator: 'imat web (packBlob)'
              })
            });
            send({ type: 'export', buf: out.buffer, bytes: out.length, for: msg.for || 'download' },
              [out.buffer]);
            return;
          case 'snapshot':
            send({ type: 'snapshot', s: E.packQuery(S.idx.query), sede: S.idx.scopeSede });
            return;
          default:
            send({ type: 'error', msg: 'unknown message ' + msg.type });
        }
      } catch (err) {
        send({ type: 'error', msg: (err && err.message) || String(err) });
      }
    }

    return { handle: handle, state: S };
  }

  root.IMATCore = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.IMATCore;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
