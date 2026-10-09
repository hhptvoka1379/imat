// core.test.mjs — unit tests for docs/assets/core.js against the real data.bin.
// run with: node tools/tests/core.test.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const buf = fs.readFileSync(path.join(ROOT, "docs/data.bin"));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
globalThis.fetch = async () => ({ arrayBuffer: async () => ab });

const core = await import(pathToFileURL(path.join(ROOT, "docs/assets/core.js")));
const data = await core.loadData("data.bin");
console.log("loaded rows:", data.n, "sedi:", data.sedeCount);
assert.equal(data.n, 17350);
assert.equal(data.sedeCount, 19);

// pick a real Bologna row and synthesize a matching answer sheet
const bologna = data.sedeNames.indexOf("Bologna");
const row = data.sedeStarts[bologna] + 100;
const vec = core.vectorOf(data, row);
const code = core.barcodeOf(data, row);
console.log("target:", code, vec);

const states = new Int8Array(60);
let q = 0;
for (let s = 0; s < 5; s++) {
  const size = core.SECTION_SIZES[s];
  const target = Math.round(vec[s] * 10);
  let found = false;
  outer:
  for (let c = 0; c <= size; c++) {
    for (let w = 0; w <= size - c; w++) {
      if (c * 15 - 4 * w === target) {
        for (let i = 0; i < c; i++) states[q++] = core.SURE;
        for (let i = 0; i < w; i++) states[q++] = core.WRONG_S;
        for (let i = 0; i < size - c - w; i++) states[q++] = core.BLANK;
        found = true;
        break outer;
      }
    }
  }
  assert.ok(found, "score must decompose");
}
assert.equal(q, 60);

// exact sheet → exactly one match at Bologna
const { local, other } = core.findMatches(data, bologna, core.sectionStats(states));
assert.equal(local.length, 1);
assert.equal(core.barcodeOf(data, local[0].row), code);
console.log("UNIQUE ✓");

// sure/wrong → unsure keeps the same vector feasible, with resolution
const states2 = Int8Array.from(states);
states2[states2.indexOf(core.SURE)] = core.UNSURE;
const i2 = states2.indexOf(core.WRONG_S);
if (i2 >= 0) states2[i2] = core.UNSURE;
const m2 = core.findMatches(data, bologna, core.sectionStats(states2));
assert.ok(m2.local.some((h) => h.row === row));
console.log("unsure-resolution ✓ resolved =", m2.local.find((h) => h.row === row).resolved);

// nearest list
const near = core.nearestRows(data, bologna, core.sectionStats(new Int8Array(60).fill(core.SURE)), 5);
assert.equal(near.length, 5);
console.log("nearest ✓");

// fuzzy search
const h1 = core.searchRows(data, "bicoca", 5);
assert.equal(data.sedeNames[core.sedeIndexOf(data, h1[0].row)], "Milano Bicocca (Bergamo)");
const h2 = core.searchRows(data, "pavia 65.5", 5);
assert.ok(h2.every((h) => Math.abs(core.vectorOf(data, h.row)[5] - 65.5) < 0.06));
const h3 = core.searchRows(data, "5111 5335 7351", 25);
assert.ok(h3.some((h) => core.barcodeOf(data, h.row) === "511153355735115"));
console.log("fuzzy ✓");

console.log("\nALL CORE TESTS PASSED");
