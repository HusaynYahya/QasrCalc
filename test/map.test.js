/* ============================================================================
   What the map says about the prayer, and where it says it changes.

   The shortening begins on leaving the town [1755], [1756] — not where the
   eight farsakh is reached. Both used to be drawn as the same green circle,
   which invited exactly the wrong reading. prayerStates decides what each
   length of road means; it is a pure function of the measure, so it can be
   checked without a map.  — run with:  node test/map.test.js
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var assert = require("assert");

var sandbox = {
  window: {},
  document: { readyState: "complete", getElementById: function () { return null; },
              addEventListener: function () {} },
  fetch: function () { return Promise.reject(new Error("no network in tests")); },
  setTimeout: setTimeout, clearTimeout: clearTimeout, console: console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8"), sandbox);
var G = sandbox.window.QasrEngine;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (err) { failed++; console.log("  FAIL " + name + "\n       " + err.message); }
}

function measure(legVerdict, where) {
  return { edgeKm: 4, limitKm: 44, roundTrip: true, meets: true,
           verdict: legVerdict, legVerdict: legVerdict,
           qasrBegins: where ? { where: where, citations: [1755] } : null };
}

console.log("\nWhere the prayer changes on the map");

test("a qualifying journey changes prayer, and says where", function () {
  var s = G.prayerStates(measure("QASR", "haddAlTarakhkhus"));
  assert.strictEqual(s.changes, true);
  assert.strictEqual(s.both, false);
  assert.ok(/still in town/i.test(s.head), "the road before it must be named as full prayer");
  assert.ok(/shortened/i.test(s.tail), "the road after it must be named as shortened");
  assert.ok(s.begin && /begins/i.test(s.begin), "the point itself must be labelled");
});

test("it points at leaving town, and admits the map cannot draw the real line", function () {
  var s = G.prayerStates(measure("QASR", "haddAlTarakhkhus"));
  assert.ok(/tarakhkhu/i.test(s.begin), "the criterion should be named");
  assert.ok(/judged by eye|a little beyond/i.test(s.begin),
    "the map shows the town's edge, not the line itself — it must say so");
  assert.ok(!/farsakh/i.test(s.begin),
    "the eight farsakh is not where the shortening begins and must not be named here");
});

test("leaving a place that is not your watan says so plainly", function () {
  var s = G.prayerStates(measure("QASR", "onLeavingTheTown"));
  assert.strictEqual(s.changes, true);
  assert.ok(/on leaving the town/i.test(s.begin));
  assert.ok(!/tarakhkhu/i.test(s.begin),
    "hadd al-tarakhkhus has no effect outside the watan [1755] and must not be cited here");
});

test("a full-prayer journey shows no change at all", function () {
  var s = G.prayerStates(measure("TAMAM", "haddAlTarakhkhus"));
  assert.strictEqual(s.changes, false);
  assert.strictEqual(s.begin, null, "there is no point of change to mark");
  assert.ok(/whole of this journey/i.test(s.tail));
});

test("a doubted tarakhkhus does not begin the shortening [1761]", function () {
  var s = G.prayerStates(measure("QASR", "undetermined"));
  assert.strictEqual(s.changes, false, "while it is doubted, the prayer stays full");
  assert.ok(/doubted/i.test(s.head));
});

test("praying both is not shown as praying shortened", function () {
  var s = G.prayerStates(measure("JAMA", "haddAlTarakhkhus"));
  assert.strictEqual(s.changes, true);
  assert.strictEqual(s.both, true);
  assert.ok(/both/i.test(s.tail), "the tail must say both prayers, not just the shortened one");
  assert.ok(/both/i.test(s.begin));
});

test("nothing measured yet is not a ruling", function () {
  var s = G.prayerStates(null);
  assert.strictEqual(s.changes, false);
  assert.strictEqual(s.begin, null);
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
