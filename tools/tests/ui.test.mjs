// ui.test.mjs — integration smoke test for the whole page (needs: npm i jsdom).
// run with: node tools/tests/ui.test.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { pathToFileURL, fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const html = fs.readFileSync(path.join(ROOT, "docs/index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://localhost:8000/", pretendToBeVisual: true });
const { window } = dom;
window.HTMLElement.prototype.scrollIntoView = function () {};

global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
Object.defineProperty(global, "navigator", { value: window.navigator, configurable: true });

const buf = fs.readFileSync(path.join(ROOT, "docs/data.bin"));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
globalThis.fetch = async () => ({ arrayBuffer: async () => ab });

await import(pathToFileURL(path.join(ROOT, "docs/assets/app.js")));
await new Promise((r) => setTimeout(r, 80));

const $ = (id) => window.document.getElementById(id);

assert.ok($("load-status").textContent.includes("17,350"));
assert.equal(window.document.querySelectorAll(".q-row").length, 60);
assert.equal($("sede-select").options.length, 20);
console.log("boot ✓", $("load-status").textContent);

// pick Bologna
const opt = [...$("sede-select").options].find((o) => o.textContent.startsWith("Bologna"));
$("sede-select").value = opt.value;
$("sede-select").dispatchEvent(new window.Event("change", { bubbles: true }));

// synthesize a real answer sheet from a Bologna row
const core = await import(pathToFileURL(path.join(ROOT, "docs/assets/core.js")));
const data = await core.loadData("data.bin");
const bologna = data.sedeNames.indexOf("Bologna");
const row = data.sedeStarts[bologna] + 100;
const code = core.barcodeOf(data, row);
const vec = core.vectorOf(data, row);
const letters = [];
for (let s = 0; s < 5; s++) {
  const size = core.SECTION_SIZES[s];
  const target = Math.round(vec[s] * 10);
  outer:
  for (let c = 0; c <= size; c++) {
    for (let w = 0; w <= size - c; w++) {
      if (c * 15 - 4 * w === target) {
        for (let i = 0; i < c; i++) letters.push("S");
        for (let i = 0; i < w; i++) letters.push("W");
        for (let i = 0; i < size - c - w; i++) letters.push("B");
        break outer;
      }
    }
  }
}
assert.equal(letters.length, 60);

// paste all 60 → live UNIQUE verdict
$("paste-box").value = letters.join("");
$("paste-apply").click();
await new Promise((r) => setTimeout(r, 30));
assert.equal($("progress-label").textContent, "60 / 60 marked");
assert.ok($("verdict-card").className.includes("unique"), $("verdict-card").className);
assert.ok($("verdict-body").textContent.includes(code));
console.log("paste → UNIQUE verdict ✓", code);

// keyboard edits update the verdict live
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "w", bubbles: true }));
await new Promise((r) => setTimeout(r, 20));
console.log("keyboard ✓ verdict now:", $("verdict-tag").textContent);

// clear + chip click with auto-advance
$("clear-btn").click();
assert.equal($("progress-label").textContent, "0 / 60 marked");
window.document.querySelector('.q-row[data-q="0"] .chip').click();
assert.ok(window.document.querySelector('.q-row[data-q="0"]').className.includes("done"));
assert.ok(window.document.querySelector('.q-row[data-q="1"]').className.includes("current"));
console.log("chip click ✓");

// fuzzy search box
$("search-input").value = "bicoca";
$("search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
assert.ok($("search-results").textContent.includes("Milano Bicocca"));
$("search-input").value = "5111 5335 7351";
$("search-input").dispatchEvent(new window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
assert.ok($("search-results").textContent.includes("511153355735115"));
console.log("fuzzy search box ✓");

console.log("\nALL UI TESTS PASSED");
