/* =========================================================================
   Site DOM/CSS contract.

   The ops panels are wired by hand: app.js queries elements by id and
   renders markup matching class names in style.css. Nothing catches a typo
   there at runtime until someone opens the page and sees a blank panel (or
   a TypeError stops the whole refresh loop). These tests pin that contract.
   ========================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const html = readFileSync(join(SITE, "index.html"), "utf8");
const app = readFileSync(join(SITE, "app.js"), "utf8");
const css = readFileSync(join(SITE, "style.css"), "utf8");

const idsInHtml = new Set([...html.matchAll(/id=["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]));
const idsInApp = [...new Set([...app.matchAll(/\$\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)].map((m) => m[1]))];

test("every element app.js queries exists in index.html", () => {
  const missing = idsInApp.filter((id) => !idsInHtml.has(id));
  assert.deepEqual(missing, [],
    `app.js references ids that index.html never declares: ${missing.join(", ")}`);
  assert.ok(idsInApp.length >= 20, "expected the full ops panel set to be wired");
});

test("analytics renderers are actually present in app.js", () => {
  for (const fn of [
    "renderRollout",       // patch detector → rollout strip
    "renderDayBars",       // restarts/day + day-of-week rollup
    "renderRoster",        // whitelist roster (tournament signal)
    "renderRegionOptions", // scored region shortlist
    "renderRestartStats",  // MTBF / early-warning accuracy
    "renderPeak",
    "renderPeakBest",
    "feedItem",
  ]) {
    assert.match(app, new RegExp(`function\\s+${fn}\\b`), `missing ${fn}()`);
  }
  // each renderer must be invoked from refreshOps, not just defined
  for (const fn of ["renderRollout", "renderRoster", "renderRegionOptions"]) {
    assert.match(app, new RegExp(`${fn}\\(`), `${fn} is never called`);
  }
});

test("new panel containers and their styles are declared", () => {
  const containers = ["patchRollout", "restartBars", "restartStats", "rosterBox",
    "peakGrid", "peakDays", "peakBest", "adviceLine", "regionOptions", "feedList"];
  for (const id of containers) {
    assert.ok(idsInHtml.has(id), `index.html is missing #${id}`);
  }

  const classes = ["rollout-bar", "rollout-line", "chip-row", "chip",
    "day-bars", "bar-row", "bar-label", "bar-track", "bar-fill", "bar-val",
    "roster-box", "roster-head", "roster-row", "roster-where", "roster-names",
    "roster-key", "roster-move", "opt-list", "opt-row", "opt-rank",
    "opt-code", "opt-why", "opt-score", "muted-inline"];
  const missing = classes.filter((c) => !css.includes(`.${c}`));
  assert.deepEqual(missing, [], `style.css lacks: ${missing.join(", ")}`);
});

test("whitelist roster markup is a container element, not a paragraph", () => {
  // renderRoster injects <div>s — inside a <p> the browser would auto-close
  // the paragraph and split the panel in half.
  const el = html.match(/<(\w+)[^>]*\bid="rosterBox"[^>]*>/);
  assert.ok(el, "rosterBox missing");
  assert.equal(el[1], "div", `#rosterBox should be a <div>, got <${el[1]}>`);
});

test("no inline handlers or eval keep the page CSP-friendly", () => {
  assert.ok(!/ on[a-z]+\s*=\s*["']/i.test(html), "inline event handler in index.html");
  assert.ok(!/eval\s*\(/.test(app), "eval() in app.js");
});
