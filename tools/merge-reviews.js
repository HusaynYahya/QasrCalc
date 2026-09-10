/* ============================================================================
   Put several reviewers' answers side by side.

     node tools/merge-reviews.js border-review-*.json

   The review page hands each reviewer a file named after them. This reads any
   number of those and prints one row per city: what each person said, and
   where they disagree.

   Disagreement is the interesting part rather than a nuisance. Where a border
   is right or wrong, reviewers agree and the row is settled. Where they split,
   the question was never really about the map — it is whether two adjoining
   places are one city, which is a judgement of custom that the page defers to
   the reader on purpose. A row that splits is a row to ask about, not to
   average.
   ========================================================================== */
"use strict";

var fs = require("fs");
var files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node tools/merge-reviews.js border-review-*.json");
  process.exit(1);
}

var byCity = Object.create(null), reviewers = [];
files.forEach(function (f) {
  var doc;
  try { doc = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { console.error("skipped " + f + ": " + e.message); return; }
  /* Older exports were a bare array with no name on them. Taken from the
     filename in that case, which is the best that can be done. */
  var answers = Array.isArray(doc) ? doc : (doc.answers || []);
  var who = (doc && doc.reviewer) ||
            (f.match(/border-review-(.+)\.json$/) || [])[1] || f;
  if (reviewers.indexOf(who) < 0) reviewers.push(who);
  answers.forEach(function (a) {
    if (!a || !a.asked) return;
    (byCity[a.asked] = byCity[a.asked] || {})[who] =
      { verdict: a.verdict, note: a.note || null, km2: a.km2, got: a.got };
  });
});

function pad(s, n) { s = String(s == null ? "" : s); return s + " ".repeat(Math.max(0, n - s.length)); }
var mark = { yes: "yes", nearly: "~", no: "NO" };

var cities = Object.keys(byCity).sort();
console.log(pad("city", 18) + reviewers.map(function (r) { return pad(r, 10); }).join("") + "  border");
cities.forEach(function (c) {
  var row = byCity[c];
  var said = reviewers.map(function (r) { return row[r] ? row[r].verdict : null; });
  var given = said.filter(Boolean);
  var split = given.length > 1 && given.some(function (v) { return v !== given[0]; });
  var any = reviewers.map(function (r) { return row[r]; }).filter(Boolean)[0] || {};
  console.log(pad(c, 18) +
    reviewers.map(function (r) { return pad(row[r] ? (mark[row[r].verdict] || row[r].verdict) : "·", 10); }).join("") +
    "  " + (any.km2 == null ? "none" : any.km2 + " km²") + (split ? "   << they disagree" : ""));
  /* Notes are the reason a "no" is worth anything: they say what is wrong. */
  reviewers.forEach(function (r) {
    if (row[r] && row[r].note) console.log(pad("", 18) + "  " + r + ": " + row[r].note);
  });
});

var counts = { yes: 0, nearly: 0, no: 0 };
var splits = 0;
cities.forEach(function (c) {
  var given = reviewers.map(function (r) { return byCity[c][r] && byCity[c][r].verdict; }).filter(Boolean);
  given.forEach(function (v) { if (counts[v] != null) counts[v]++; });
  if (given.length > 1 && given.some(function (v) { return v !== given[0]; })) splits++;
});
console.log("\n" + reviewers.length + " reviewer(s): " + reviewers.join(", "));
console.log(cities.length + " cities judged · " + counts.yes + " yes · " +
            counts.nearly + " nearly · " + counts.no + " no · " + splits + " disagreed");
if (counts.no || counts.nearly) {
  console.log("\nWorth fixing first, worst named first:");
  cities.filter(function (c) {
    return reviewers.some(function (r) { return byCity[c][r] && byCity[c][r].verdict === "no"; });
  }).forEach(function (c) { console.log("  no      " + c); });
  cities.filter(function (c) {
    return reviewers.some(function (r) { return byCity[c][r] && byCity[c][r].verdict === "nearly"; }) &&
          !reviewers.some(function (r) { return byCity[c][r] && byCity[c][r].verdict === "no"; });
  }).forEach(function (c) { console.log("  nearly  " + c); });
}
