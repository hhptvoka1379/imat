// app.js — glue for the imat anonymous-results finder.
// All state lives in this tab (plus a localStorage autosave).

import {
  SECTION_NAMES, SECTION_SIZES, SURE, UNSURE, WRONG_S, BLANK,
  loadData, sectionStats, findMatches, nearestRows, barcodeOf, vectorOf,
  searchRows, codeScore,
} from "./core.js";

const N = 60;
const STATE_LETTER = { 1: "S", 2: "U", 3: "W", 4: "B" };
const LETTER_STATE = { S: 1, U: 2, W: 3, B: 4, "1": 1, "2": 2, "3": 3, "4": 4, ".": 4, "-": 4 };
const STATE_LABEL = { 1: "sure", 2: "unsure", 3: "wrong", 4: "blank" };

const $ = (id) => document.getElementById(id);

let data = null;
let states = new Int8Array(N); // 0 unset, 1..4
let sedeIdx = -1;
let current = 0;
const rowEls = [];

// ------------------------------------------------------------- storage --

function save() {
  try {
    localStorage.setItem("imat26", JSON.stringify({
      sede: sedeIdx,
      states: Array.from(states),
    }));
  } catch { /* private mode etc. */ }
}

function restore() {
  try {
    const raw = localStorage.getItem("imat26");
    if (!raw) return;
    const j = JSON.parse(raw);
    if (Array.isArray(j.states) && j.states.length === N) {
      states = Int8Array.from(j.states.map((v) => (v >= 0 && v <= 4 ? v : 0)));
    }
    if (typeof j.sede === "number" && j.sede >= 0) sedeIdx = j.sede;
  } catch { /* ignore */ }
}

// ------------------------------------------------------------- render --

function fmt(v) {
  return (v / 10).toFixed(1);
}

function renderSections() {
  const host = $("sections");
  host.innerHTML = "";
  let q = 0;
  SECTION_SIZES.forEach((size, si) => {
    const card = document.createElement("div");
    card.className = "section-card";
    card.innerHTML = `
      <div class="section-head">
        <h3>${SECTION_NAMES[si]}</h3>
        <div class="section-meta" id="sec-meta-${si}"></div>
      </div>
      <div class="btn-row" style="margin-bottom: 8px;">
        <button class="btn tiny" data-fill="${si}:4">all blank</button>
        <button class="btn tiny" data-fill="${si}:2">all unsure</button>
        <button class="btn tiny" data-fill="${si}:0">clear section</button>
      </div>
      <div class="q-list" id="qlist-${si}"></div>`;
    host.appendChild(card);

    const list = card.querySelector(`#qlist-${si}`);
    for (let k = 0; k < size; k++, q++) {
      const row = document.createElement("div");
      row.className = "q-row";
      row.dataset.q = q;
      row.innerHTML = `
        <div class="q-num">Q${q + 1}</div>
        ${[1, 2, 3, 4].map((s) => `
          <button class="chip" data-state="${s}" data-q="${q}"
            title="${STATE_LABEL[s]} (${s})">${STATE_LABEL[s]}</button>`).join("")}
        <div class="q-done">✓</div>`;
      list.appendChild(row);
      rowEls.push(row);
    }
  });

  host.addEventListener("click", (e) => {
    const fill = e.target.closest("[data-fill]");
    if (fill) {
      const [si, v] = fill.dataset.fill.split(":").map(Number);
      const start = SECTION_SIZES.slice(0, si).reduce((a, b) => a + b, 0);
      for (let i = start; i < start + SECTION_SIZES[si]; i++) {
        if (v === 0 || states[i] === 0) states[i] = v;
      }
      refreshAll();
      return;
    }
    const chip = e.target.closest(".chip");
    if (chip) {
      const q = Number(chip.dataset.q);
      setState(q, Number(chip.dataset.state), true);
    }
  });
}

function setState(q, s, advance) {
  states[q] = s;
  if (advance) {
    let n = -1;
    for (let i = q + 1; i < N; i++) if (states[i] === 0) { n = i; break; }
    if (n < 0) for (let i = 0; i < N; i++) if (states[i] === 0) { n = i; break; }
    current = n >= 0 ? n : Math.min(q + 1, N - 1);
    if (current !== q) scrollToRow(current);
  } else {
    current = q;
  }
  refreshAll();
}

function scrollToRow(q) {
  const el = rowEls[q];
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.top < 80 || r.bottom > window.innerHeight - 40) {
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function refreshRows() {
  for (let q = 0; q < N; q++) {
    const row = rowEls[q];
    row.classList.toggle("current", q === current);
    row.classList.toggle("done", states[q] !== 0);
    for (const chip of row.querySelectorAll(".chip")) {
      chip.classList.toggle("on", Number(chip.dataset.state) === states[q]);
    }
  }
}

function refreshProgress() {
  const done = Array.from(states).filter((s) => s !== 0).length;
  $("progress-fill").style.width = `${(100 * done) / N}%`;
  $("progress-label").textContent = `${done} / 60 marked`;

  const stats = sectionStats(states);
  const lo = stats.reduce((a, s) => a + s.lo, 0);
  const hi = stats.reduce((a, s) => a + s.hi, 0);
  $("range-preview").textContent =
    done === 0 ? "" : `possible total so far: ${fmt(lo)} … ${fmt(hi)} pts`;

  SECTION_SIZES.forEach((size, si) => {
    const st = stats[si];
    const marks = st.sure + st.unsure + st.wrong + st.blank;
    $(`sec-meta-${si}`).textContent =
      `${marks}/${size} · score ${fmt(st.lo)} … ${fmt(st.hi)}`;
  });

  $("check-btn").disabled = done !== N || sedeIdx < 0;
}

// ------------------------------------------------------------ verdict --

function refreshVerdict() {
  const card = $("verdict-card");
  const tag = $("verdict-tag");
  const body = $("verdict-body");
  const disamb = $("disambiguate");
  const done = Array.from(states).filter((s) => s !== 0).length;

  card.className = "card verdict idle";
  disamb.hidden = true;

  if (done !== N) {
    tag.textContent = "waiting for you";
    body.innerHTML = `<p class="hint" style="margin:0">
      ${done === 0 ? "Take your time — mark your answers above." : `Marked ${done}/60 — ${N - done} to go.`}
      The verdict appears here the moment all 60 are in.
    </p>`;
    return;
  }
  if (sedeIdx < 0) {
    tag.textContent = "one thing missing";
    body.innerHTML = `<p class="hint" style="margin:0">
      All 60 answers are in — now pick your test location above so we only
      look among the people who sat it there.
    </p>`;
    return;
  }

  const stats = sectionStats(states);
  const { local, other } = findMatches(data, sedeIdx, stats);
  const sedeName = data.sedeNames[sedeIdx];
  const ends = sedeEndsSafe();
  const nLocal = ends[sedeIdx] - data.sedeStarts[sedeIdx];

  if (local.length === 1) {
    card.className = "card verdict unique";
    tag.textContent = "unique — this is you";
    body.innerHTML = uniqueHTML(local[0], stats, sedeName, nLocal, other);
  } else if (local.length > 1) {
    card.className = "card verdict ambiguous";
    tag.textContent = `ambiguous · ${local.length} matches`;
    body.innerHTML = `
      <h2 style="margin-bottom:4px">${local.length} people at ${escapeHTML(sedeName)} share this exact result vector.</h2>
      <p class="hint">It happens — but a few remembered bar-code digits usually settle it.
      Type them in the box below and the list narrows.</p>
      <div class="candidate-list" id="candidate-list"></div>
      ${other.length ? `<p class="note">for the record: ${other.length} more match(es) at other locations.</p>` : ""}`;
    disamb.hidden = false;
    renderCandidates(local, stats);
  } else {
    card.className = "card verdict none";
    tag.textContent = "no match";
    const near = nearestRows(data, sedeIdx, stats, 5);
    body.innerHTML = `
      <h2 style="margin-bottom:4px">nobody at ${escapeHTML(sedeName)} matches this answer sheet.</h2>
      <p class="hint">No rush. Usually it’s one mis-remembered state: every
      <em>wrong</em> vs <em>blank</em> or <em>sure</em> vs <em>unsure</em> shifts the
      score. Double-check the questions you were least certain about.</p>
      <div class="candidate-list">
        ${near.map(({ row, d }) => candidateHTML(row, null, `≈${(d / 10).toFixed(1)} pts off`)).join("")}
      </div>`;
  }
}

function sedeEndsSafe() {
  const ends = [];
  for (let i = 0; i < data.sedeCount; i++) {
    ends.push(i + 1 < data.sedeCount ? data.sedeStarts[i + 1] : data.n);
  }
  return ends;
}

function uniqueHTML(hit, stats, sedeName, nLocal, other) {
  const vec = vectorOf(data, hit.row);
  const code = barcodeOf(data, hit.row);
  return `
    <h2 style="margin-bottom:4px">only one person at ${escapeHTML(sedeName)} can be you.</h2>
    <p class="hint" style="margin-bottom:2px">your anonymous bar code</p>
    <div class="barcode-big">${code ? escapeHTML(code) : "(no bar code published)"}</div>
    ${scoreTable(vec)}
    ${resolvedHTML(hit.resolved, stats)}
    <p class="note">
      ${nLocal} answer sheets at this location, and yours is the only one with this
      result vector${other.length ? ` — although ${other.length} person(es) elsewhere landed on it too` : " — nobody else in the entire dataset has it"}.
    </p>`;
}

function scoreTable(vec) {
  const names = [...SECTION_NAMES, "Total"];
  return `
    <table class="score-table">
      <tr><th>section</th><th style="text-align:right">score</th></tr>
      ${names.map((nm, i) => `<tr><td>${nm}</td><td class="num">${vec[i].toFixed(1)}</td></tr>`).join("")}
    </table>`;
}

function resolvedHTML(resolved, stats) {
  const rows = [];
  stats.forEach((st, i) => {
    if (st.unsure > 0) {
      rows.push(`<tr><td>${SECTION_NAMES[i]}</td>
        <td class="num">${resolved[i]} of ${st.unsure} unsure right</td></tr>`);
    }
  });
  if (!rows.length) return "";
  return `
    <p class="hint" style="margin:6px 0 0">and your unsure answers resolved:</p>
    <table class="score-table">${rows.join("")}</table>`;
}

function candidateHTML(row, resolved, extra = "") {
  const vec = vectorOf(data, row);
  const code = barcodeOf(data, row);
  return `
    <div class="candidate" data-code="${code || ""}">
      <span class="code">${code ? escapeHTML(code) : "(no bar code)"}</span>
      <span class="vec">${vec.slice(0, 5).map((v) => v.toFixed(1)).join(" · ")}</span>
      <span class="vec">tot ${vec[5].toFixed(1)}</span>
      ${extra ? `<span class="vec">${extra}</span>` : ""}
    </div>`;
}

function renderCandidates(local, stats) {
  const host = $("candidate-list");
  const draw = () => {
    const q = $("code-filter").value.trim();
    const shown = q
      ? local.filter(({ row }) => codeScore(q, barcodeOf(data, row) || "") > 0)
      : local;
    host.innerHTML = shown.length
      ? shown.map(({ row, resolved }) => candidateHTML(row, resolved,
          resolved.some((a, i) => stats[i].unsure > 0)
            ? "unsure: " + stats.map((st, i) => st.unsure ? `${resolved[i]}/${st.unsure}` : null).filter(Boolean).join(" ")
            : "")).join("")
      : `<p class="note">no bar code here looks like “${escapeHTML(q)}” — try fewer digits.</p>`;
  };
  $("code-filter").oninput = draw;
  draw();
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function refreshAll() {
  refreshRows();
  refreshProgress();
  refreshVerdict();
  save();
}

// ------------------------------------------------------------- search --

let searchTimer = 0;
function wireSearch() {
  const input = $("search-input");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = input.value.trim();
      const host = $("search-results");
      if (q.length < 2) { host.innerHTML = ""; return; }
      const t0 = performance.now();
      const hits = searchRows(data, q, 25);
      const ms = (performance.now() - t0).toFixed(0);
      host.innerHTML = hits.length
        ? hits.map(({ row, score }) => {
            const vec = vectorOf(data, row);
            const code = barcodeOf(data, row);
            const si = sedeIndexOfRow(row);
            return `<div class="search-row">
              <span>${escapeHTML(data.sedeNames[si])}</span>
              <span class="code">${code ? escapeHTML(code) : "(no bar code)"}</span>
              <span class="vec">${vec.slice(0, 5).map((v) => v.toFixed(1)).join(" · ")}</span>
              <span class="tot">${vec[5].toFixed(1)}</span>
            </div>`;
          }).join("") + `<p class="note">${hits.length} best match(es) in ${ms} ms</p>`
        : `<p class="note">no matches …deep breath… try fewer or shorter tokens.</p>`;
    }, 140);
  });
}

function sedeIndexOfRow(row) {
  let ans = 0;
  for (let i = 0; i < data.sedeCount; i++) if (data.sedeStarts[i] <= row) ans = i;
  return ans;
}

// ------------------------------------------------------------ keyboard --

function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    const k = e.key.toLowerCase();
    const st = LETTER_STATE[k] || LETTER_STATE[k.toUpperCase()];
    if (st) {
      e.preventDefault();
      setState(current, st, true);
      return;
    }
    if (k === "arrowdown" || k === "j") {
      e.preventDefault();
      current = Math.min(N - 1, current + 1);
      refreshAll();
      scrollToRow(current);
    } else if (k === "arrowup" || k === "k") {
      e.preventDefault();
      current = Math.max(0, current - 1);
      refreshAll();
      scrollToRow(current);
    } else if (k === "enter") {
      e.preventDefault();
      $("verdict-card").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

// --------------------------------------------------------------- paste --

function wirePaste() {
  $("paste-apply").addEventListener("click", () => {
    const raw = $("paste-box").value.toUpperCase();
    const arr = [];
    for (const ch of raw) {
      if (ch === " " || ch === "," || ch === ";" || ch === "|" || ch === "\n") continue;
      const st = LETTER_STATE[ch];
      if (st) arr.push(st);
    }
    if (arr.length !== N) {
      $("paste-box").setCustomValidity(`need ${N} marks, found ${arr.length}`);
      $("paste-box").reportValidity();
      return;
    }
    $("paste-box").setCustomValidity("");
    states = Int8Array.from(arr);
    current = 0;
    refreshAll();
    $("verdict-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $("paste-export").addEventListener("click", async () => {
    const s = Array.from(states).map((v) => STATE_LETTER[v] || "?").join("");
    try {
      await navigator.clipboard.writeText(s);
      $("paste-export").textContent = "copied ✓";
    } catch {
      $("paste-box").value = s;
      $("paste-export").textContent = "in the box ✓";
    }
    setTimeout(() => { $("paste-export").textContent = "copy my 60 letters"; }, 1800);
  });
}

// ---------------------------------------------------------------- boot --

async function boot() {
  restore();

  try {
    data = await loadData("data.bin");
  } catch (err) {
    $("load-status").textContent = "could not load data.bin — serve this folder over http";
    console.error(err);
    return;
  }

  $("load-status").textContent =
    `${data.n.toLocaleString("en-US")} rows · ${data.sedeCount} locations · loaded in ${data.loadMs.toFixed(0)} ms`;

  const sel = $("sede-select");
  data.sedeNames.forEach((name, i) => {
    const ends = i + 1 < data.sedeCount ? data.sedeStarts[i + 1] : data.n;
    const count = ends - data.sedeStarts[i];
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${name} · ${count.toLocaleString("en-US")}`;
    sel.appendChild(opt);
  });
  if (sedeIdx >= 0) sel.value = String(sedeIdx);
  sel.addEventListener("change", () => {
    sedeIdx = sel.value === "" ? -1 : Number(sel.value);
    refreshAll();
  });

  renderSections();
  wireSearch();
  wireKeyboard();
  wirePaste();

  $("check-btn").addEventListener("click", () => {
    $("verdict-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("clear-btn").addEventListener("click", () => {
    states = new Int8Array(N);
    current = 0;
    refreshAll();
  });
  $("fill-unsure-btn").addEventListener("click", () => {
    for (let i = 0; i < N; i++) if (states[i] === 0) states[i] = UNSURE;
    refreshAll();
  });

  refreshAll();
}

boot();
