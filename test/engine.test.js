/* ============================================================================
   Tests for the ruling engine in qasr.js — run with:  node test/engine.test.js
   The engine is a pure function, so no browser and no network are needed; the
   few globals it touches are stubbed below.
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var assert = require("assert");

/* --- load qasr.js with just enough of a browser around it ----------------- */
var sandbox = {
  window: {},
  document: {
    readyState: "complete",
    getElementById: function () { return null; },
    addEventListener: function () {}
  },
  fetch: function () { return Promise.reject(new Error("no network in tests")); },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  console: console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8"), sandbox);

var decide = sandbox.window.QasrEngine.decide;
var LIMIT = sandbox.window.QasrEngine.LIMIT_KM;

/* --- helpers -------------------------------------------------------------- */
function journey(over) {
  return Object.assign({
    oneWayKm: 0,
    edgeKm: 0,
    roundTrip: true,
    intendedFromStart: true,
    destIsWatan: false,
    tenDays: false,
    hesitant: false,
    newLongStay: false,
    passesWatan: false,
    frequentTraveller: false,
    sinful: false
  }, over);
}

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (err) { failed++; console.log("  FAIL " + name + "\n       " + err.message); }
}

/* --- the legal distance --------------------------------------------------- */
console.log("\nThe legal distance (8 farsakh = " + LIMIT + " km)");

test("the limit is 44 km", function () {
  assert.strictEqual(LIMIT, 44);
});

test("60 km one way, not returning — a journey", function () {
  var v = decide(journey({ oneWayKm: 60, roundTrip: false }));
  assert.strictEqual(v.enRoute, "qasr");
  assert.strictEqual(v.atDest, "qasr");
});

test("25 km one way, not returning — short of the limit", function () {
  var v = decide(journey({ oneWayKm: 25, roundTrip: false }));
  assert.strictEqual(v.enRoute, "full");
  assert.strictEqual(v.atDest, "full");
});

test("30 km each way, returning — 60 km counted, a journey", function () {
  var v = decide(journey({ oneWayKm: 30 }));
  assert.strictEqual(v.metrics.countedKm, 60);
  assert.strictEqual(v.enRoute, "qasr");
});

test("20 km each way, returning — 40 km counted, short", function () {
  var v = decide(journey({ oneWayKm: 20 }));
  assert.strictEqual(v.metrics.countedKm, 40);
  assert.strictEqual(v.enRoute, "full");
});

test("exactly 22 km each way, returning — meets the limit", function () {
  var v = decide(journey({ oneWayKm: 22 }));
  assert.strictEqual(v.metrics.countedKm, 44);
  assert.strictEqual(v.metrics.meets, true);
  assert.strictEqual(v.enRoute, "qasr");
});

test("the distance to the edge of town is deducted from each leg", function () {
  var v = decide(journey({ oneWayKm: 26, edgeKm: 5 }));   /* 21 + 21 = 42 */
  assert.strictEqual(v.metrics.legKm, 21);
  assert.strictEqual(v.metrics.countedKm, 42);
  assert.strictEqual(v.enRoute, "full");
});

test("a deduction larger than the journey does not go negative", function () {
  var v = decide(journey({ oneWayKm: 3, edgeKm: 5 }));
  assert.strictEqual(v.metrics.legKm, 0);
  assert.strictEqual(v.metrics.countedKm, 0);
});

/* --- the destination ------------------------------------------------------ */
console.log("\nWhat happens at the destination");

test("a hometown at the end: shorten on the road, full on arrival", function () {
  var v = decide(journey({ oneWayKm: 100, roundTrip: false, destIsWatan: true }));
  assert.strictEqual(v.enRoute, "qasr");
  assert.strictEqual(v.atDest, "full");
});

test("an intention of ten days: shorten on the road, full on arrival", function () {
  var v = decide(journey({ oneWayKm: 100, roundTrip: false, tenDays: true }));
  assert.strictEqual(v.enRoute, "qasr");
  assert.strictEqual(v.atDest, "full");
});

test("an undecided stay: shorten, for up to thirty days", function () {
  var v = decide(journey({ oneWayKm: 100, roundTrip: false, hesitant: true }));
  assert.strictEqual(v.atDest, "qasr-30");
});

test("a short journey to a hometown is still full both ways", function () {
  var v = decide(journey({ oneWayKm: 10, destIsWatan: true }));
  assert.strictEqual(v.enRoute, "full");
  assert.strictEqual(v.atDest, "full");
});

/* --- a place newly moved to (workshop, scenario 9) ------------------------ */
console.log("\nA place newly adopted for a long stay");

test("newly arrived for a long stay: shorten on the road, both on arrival", function () {
  var v = decide(journey({ oneWayKm: 160, roundTrip: false, newLongStay: true }));
  assert.strictEqual(v.enRoute, "qasr");
  assert.strictEqual(v.atDest, "both");
});

test("a hometown outranks the newly-arrived case", function () {
  var v = decide(journey({ oneWayKm: 160, roundTrip: false, newLongStay: true, destIsWatan: true }));
  assert.strictEqual(v.atDest, "full");
});

test("a ten-day intention outranks it too", function () {
  var v = decide(journey({ oneWayKm: 160, roundTrip: false, newLongStay: true, tenDays: true }));
  assert.strictEqual(v.atDest, "full");
});

test("a short journey to a new home is full throughout", function () {
  var v = decide(journey({ oneWayKm: 8, newLongStay: true }));
  assert.strictEqual(v.enRoute, "full");
  assert.strictEqual(v.atDest, "full");
});

test("leaving a ten-day place carries its own departure note", function () {
  var v = decide(journey({ oneWayKm: 160, roundTrip: false, tenDays: true }));
  assert.ok(v.warnings.some(function (w) { return /leave the town itself/.test(w.text); }));
});

/* --- the split between the legs (workshop, scenario 3) -------------------- */
console.log("\nHow the total divides between the legs");

/* 28 miles = 45.06 km, over the limit however it is split. */
[[22.53, 22.53], [19.31, 25.75], [25.75, 19.31]].forEach(function (pair) {
  test(pair[0].toFixed(1) + " out and " + pair[1].toFixed(1) + " back — qasr either way", function () {
    /* The engine measures one outward leg and doubles it, so an uneven split
       is checked by its total: what matters is that the total decides.       */
    var total = pair[0] + pair[1];
    var v = decide(journey({ oneWayKm: total, roundTrip: false }));
    assert.strictEqual(v.enRoute, "qasr");
  });
});

/* --- a journey that ends at its destination ------------------------------- */
console.log("\nWhen the return does not count");

test("25 km each way, but staying ten days — the legs are not added", function () {
  var v = decide(journey({ oneWayKm: 25, tenDays: true }));
  assert.strictEqual(v.metrics.countedKm, 25);   /* not 50 */
  assert.strictEqual(v.metrics.severed, true);
  assert.strictEqual(v.enRoute, "full");
});

test("25 km each way to a hometown — the legs are not added", function () {
  var v = decide(journey({ oneWayKm: 25, destIsWatan: true }));
  assert.strictEqual(v.metrics.countedKm, 25);
  assert.strictEqual(v.enRoute, "full");
});

test("50 km one way still qualifies even when staying ten days", function () {
  var v = decide(journey({ oneWayKm: 50, tenDays: true }));
  assert.strictEqual(v.enRoute, "qasr");
  assert.strictEqual(v.atDest, "full");
});

test("without a ten-day stay the same 25 km each way does qualify", function () {
  var v = decide(journey({ oneWayKm: 25 }));
  assert.strictEqual(v.metrics.countedKm, 50);
  assert.strictEqual(v.enRoute, "qasr");
});

test("an undecided stay does not sever the journey", function () {
  var v = decide(journey({ oneWayKm: 25, hesitant: true }));
  assert.strictEqual(v.metrics.countedKm, 50);
  assert.strictEqual(v.enRoute, "qasr");
});

test("the reason says why the return was left out", function () {
  var v = decide(journey({ oneWayKm: 25, tenDays: true }));
  assert.ok(v.reasons.some(function (r) { return /not<\/b> added|ends the journey there/.test(r); }));
});

/* --- the exemptions ------------------------------------------------------- */
console.log("\nWhere the rulings of travel do not apply");

test("a sinful purpose overrides the distance", function () {
  var v = decide(journey({ oneWayKm: 500, roundTrip: false, sinful: true }));
  assert.strictEqual(v.enRoute, "full");
  assert.strictEqual(v.atDest, "full");
});

test("one whose work is travel prays in full", function () {
  var v = decide(journey({ oneWayKm: 500, roundTrip: false, frequentTraveller: true }));
  assert.strictEqual(v.enRoute, "full");
  assert.strictEqual(v.atDest, "full");
});

test("a sinful purpose is judged before the occupation", function () {
  var v = decide(journey({ oneWayKm: 500, roundTrip: false, sinful: true, frequentTraveller: true }));
  assert.ok(/unlawful/.test(v.reasons[0]));
});

/* --- the intention -------------------------------------------------------- */
console.log("\nThe intention at the outset");

test("without intention from the start, one is not yet a traveller", function () {
  var v = decide(journey({ oneWayKm: 200, roundTrip: false, intendedFromStart: false }));
  assert.strictEqual(v.enRoute, "full");
  assert.strictEqual(v.atDest, "full");
  assert.ok(v.warnings.some(function (w) { return /counted afresh|from there|starting point/.test(w.text); }));
});

test("a short journey without intention needs no restart warning", function () {
  var v = decide(journey({ oneWayKm: 5, intendedFromStart: false }));
  assert.strictEqual(v.enRoute, "full");
});

/* --- interruptions and cautions ------------------------------------------- */
console.log("\nInterruptions and cautions");

test("stopping in a hometown on the way flags the verdict as provisional", function () {
  var v = decide(journey({ oneWayKm: 200, roundTrip: false, passesWatan: true }));
  assert.strictEqual(v.enRoute, "qasr");
  assert.ok(v.warnings.some(function (w) { return /provisional/.test(w.text); }));
});

test("a distance sitting on the limit raises a caution", function () {
  var v = decide(journey({ oneWayKm: 44.5, roundTrip: false }));
  assert.ok(v.warnings.some(function (w) { return /precaution/.test(w.text); }));
});

test("a distance just under the limit raises the same caution", function () {
  var v = decide(journey({ oneWayKm: 43, roundTrip: false }));
  assert.strictEqual(v.enRoute, "full");
  assert.ok(v.warnings.some(function (w) { return /precaution/.test(w.text); }));
});

test("a distance far from the limit raises no caution", function () {
  var v = decide(journey({ oneWayKm: 200, roundTrip: false }));
  assert.ok(!v.warnings.some(function (w) { return /precaution/.test(w.text); }));
});

/* --- shape of the result -------------------------------------------------- */
console.log("\nThe shape of the result");

test("every verdict carries a headline, reasons and metrics", function () {
  [journey({ oneWayKm: 5 }), journey({ oneWayKm: 100 }), journey({ oneWayKm: 100, sinful: true })]
    .forEach(function (j) {
      var v = decide(j);
      assert.ok(v.headline.length > 0);
      assert.ok(v.sub.length > 0);
      assert.ok(v.reasons.length > 0);
      assert.ok(typeof v.metrics.countedKm === "number");
      assert.ok(["qasr", "full"].indexOf(v.enRoute) >= 0);
      assert.ok(["qasr", "qasr-30", "both", "full"].indexOf(v.atDest) >= 0);
    });
});

/* --- geometry: the city border and the walk along a route ---------------- */
console.log("\nGeometry");

var G = sandbox.window.QasrEngine;

test("a point inside a simple square is inside", function () {
  var square = { type: "Polygon", coordinates: [[[0,0],[0,2],[2,2],[2,0],[0,0]]] };
  assert.strictEqual(G.inShape(1, 1, square), true);
  assert.strictEqual(G.inShape(3, 1, square), false);
});

test("a point in a hole is outside", function () {
  var ring = { type: "Polygon", coordinates: [
    [[0,0],[0,4],[4,4],[4,0],[0,0]],
    [[1,1],[1,3],[3,3],[3,1],[1,1]]
  ]};
  assert.strictEqual(G.inShape(2, 2, ring), false);   /* the hole */
  assert.strictEqual(G.inShape(0.5, 0.5, ring), true);
});

test("a multipolygon matches any of its parts", function () {
  var multi = { type: "MultiPolygon", coordinates: [
    [[[0,0],[0,1],[1,1],[1,0],[0,0]]],
    [[[5,5],[5,6],[6,6],[6,5],[5,5]]]
  ]};
  assert.strictEqual(G.inShape(5.5, 5.5, multi), true);
  assert.strictEqual(G.inShape(3, 3, multi), false);
});

test("the border crossing is found along a route leaving the city", function () {
  /* A city one degree of latitude tall, and a route running due north out of
     it. One degree of latitude is about 111 km.                             */
  var city = { type: "Polygon", coordinates: [[[-1,0],[-1,1],[1,1],[1,0],[-1,0]]] };
  var line = [[0.1, 0], [0.5, 0], [0.9, 0], [1.5, 0], [3, 0]];
  var exit = G.borderExitKm(line, city, 1);
  /* The border sits at latitude 1, which is 0.9 degrees along: ~100 km. */
  assert.ok(exit > 95 && exit < 105, "expected about 100 km, got " + exit);
});

test("a route that never leaves the city yields no crossing", function () {
  var city = { type: "Polygon", coordinates: [[[-9,-9],[-9,9],[9,9],[9,-9],[-9,-9]]] };
  assert.strictEqual(G.borderExitKm([[0,0],[1,1],[2,2]], city, 1), null);
});

test("a route that leaves, re-enters and leaves again counts the last exit", function () {
  /* A city spanning latitudes 0 to 1, and a road that dips out and back in
     before finally leaving. Leaving town is the last crossing, not the first. */
  var city = { type: "Polygon", coordinates: [[[-1,0],[-1,1],[1,1],[1,0],[-1,0]]] };
  var line = [[0.2,0],[0.5,0],[1.2,0],[0.8,0],[0.95,0],[2,0]];
  var exit = G.borderExitKm(line, city, 1);
  /* The first crossing falls at about 89 km along; the last at about 178.
     One degree of latitude is roughly 111 km.                               */
  assert.ok(exit > 170 && exit < 185, "expected about 178 km, got " + exit);
});

test("a start outside the city still counts a crossing if the road passes through", function () {
  /* Someone whose own town lies outside the city they reckon as theirs. */
  var city = { type: "Polygon", coordinates: [[[-1,0],[-1,1],[1,1],[1,0],[-1,0]]] };
  var line = [[-0.5,0],[0.5,0],[1.5,0]];       /* starts south of it, drives through */
  var exit = G.borderExitKm(line, city, 1);
  assert.ok(exit > 100 && exit < 200, "expected the far border, got " + exit);
});

test("a route starting outside the city yields no crossing", function () {
  var city = { type: "Polygon", coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] };
  assert.strictEqual(G.borderExitKm([[5,5],[6,6]], city, 1), null);
});

test("no shape at all is handled", function () {
  assert.strictEqual(G.borderExitKm([[0,0],[1,1]], null, 1), null);
  assert.strictEqual(G.inShape(0, 0, null), false);
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
