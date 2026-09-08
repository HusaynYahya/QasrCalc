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
  assert.ok(s.beginLabel && s.beginLabel.length < 40,
    "the label written on the map must be short enough to fit on it: " + s.beginLabel);
  /* Leaving the waṭan the border is not where the prayer changes, so the mark
     on it must not say it is. It is where the counting starts, which is a
     published line and exact — "about" belongs to the ḥadd, further out. */
  assert.strictEqual(s.atHadd, true);
  assert.ok(/count/i.test(s.beginLabel),
    "the border mark must say what it is — where the counting starts: " + s.beginLabel);
  assert.ok(!/begins/i.test(s.beginLabel),
    "the border mark must not claim the shortening begins there: " + s.beginLabel);
});

test("leaving the waṭan, the border and the ḥadd are told apart", function () {
  /* The two were written on the same point: the border mark said the
     shortening began there and the gold circle said it began at its far
     edge. They are different measurements — the eight farsakh is counted
     from the border [1755], the prayer changes at the ḥadd [1756]. */
  var s = G.prayerStates(measure("QASR", "haddAlTarakhkhus"));
  assert.ok(/counting starts/i.test(s.begin), "the border must be named as the count's start");
  assert.ok(/farsakh/i.test(s.begin), "and as what the farsakh is measured from");
  assert.ok(/further out/i.test(s.begin), "the ḥadd must be placed beyond it, not on it");

  /* Not leaving the waṭan, the town limit is both, and one mark carries it. */
  var t = G.prayerStates(measure("QASR", "onLeavingTheTown"));
  assert.strictEqual(t.atHadd, false);
  assert.ok(/begins/i.test(t.beginLabel),
    "leaving a place that is not the waṭan, the border mark is where it begins");
});

test("it points at leaving town, and admits the map cannot draw the real line", function () {
  var s = G.prayerStates(measure("QASR", "haddAlTarakhkhus"));
  assert.ok(/tarakhkhu/i.test(s.begin), "the criterion should be named");
  assert.ok(/judged by eye|a little beyond/i.test(s.begin),
    "the map shows the town's edge, not the line itself — it must say so");
  /* The farsakh may be named here — it is what the border is for — but only
     as the thing measured from it, never as the point of change. */
  assert.ok(!/farsakh[^.]*begins/i.test(s.begin),
    "the eight farsakh must never be given as where the shortening begins");
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
  assert.strictEqual(s.beginLabel, null);
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

/* --- what the map frames -------------------------------------------------- */
console.log("\nWhat the map frames");

/* The M25, near enough: fifty kilometres across. */
var RING = [[51.72, -0.55], [51.72, 0.28], [51.26, 0.28], [51.26, -0.55], [51.72, -0.55]];
/* WD19 4QP to Anson Road, Cricklewood — about fifteen kilometres, well inside. */
var OXHEY = { lat: 51.6238, lon: -0.3892 };
var CRICKLEWOOD = { lat: 51.5556, lon: -0.2136 };
var DRIVE = [[51.6238, -0.3892], [51.60, -0.34], [51.58, -0.28], [51.5556, -0.2136]];

function span(box) {          /* [south, west, north, east] -> degrees across */
  return { lat: box[2] - box[0], lon: box[3] - box[1] };
}

test("the journey is framed, not the city border round it", function () {
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE);
  var ring = span([51.26, -0.55, 51.72, 0.28]);
  var got = span(box);
  assert.ok(got.lat < ring.lat / 3 && got.lon < ring.lon / 3,
    "the frame is still the size of the ring road: " + JSON.stringify(box));
});

test("the frame holds every part of the journey", function () {
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE);
  [[OXHEY.lat, OXHEY.lon], [CRICKLEWOOD.lat, CRICKLEWOOD.lon]].concat(DRIVE)
    .forEach(function (p) {
      assert.ok(p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3],
        "left out of the frame: " + p);
    });
});

test("a route that wanders wider than its endpoints is still framed whole", function () {
  var detour = DRIVE.concat([[51.70, -0.50]]);       /* a swing to the north-west */
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, detour);
  assert.ok(box[2] >= 51.70 && box[1] <= -0.50, "the detour fell outside the frame");
});

test("one address alone gives a point to zoom to, not nothing", function () {
  var box = G.journeyBox(OXHEY, null, null);
  /* Compared value by value: the array is built inside the sandbox realm, so
     it is not reference-equal to one built out here. */
  assert.strictEqual(box.join(","), [OXHEY.lat, OXHEY.lon, OXHEY.lat, OXHEY.lon].join(","));
});

test("nothing entered yet frames nothing", function () {
  assert.strictEqual(G.journeyBox(null, null, null), null);
  assert.strictEqual(G.journeyBox(null, null, []), null);
});

/* The case that prompted this: WD19 4QP to Cricklewood is about fifteen
   kilometres and never leaves the M25, which is fifty across. Framing the
   drive alone left the ring — the only thing that decides the ruling — off
   the screen entirely, and it looked as though no border had been drawn.   */
var M25_SHAPE = { type: "Polygon", coordinates: [
  [[-0.55, 51.72], [0.28, 51.72], [0.28, 51.26], [-0.55, 51.26], [-0.55, 51.72]]
]};

test("a journey that never leaves the city frames the border round it", function () {
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE, M25_SHAPE);
  assert.ok(box[0] <= 51.26 && box[2] >= 51.72, "the ring's north and south are outside the frame");
  assert.ok(box[1] <= -0.55 && box[3] >= 0.28, "the ring's east and west are outside the frame");
});

test("a journey that does leave the city is framed on its own", function () {
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE, null);
  assert.ok(box[2] < 51.72 && box[1] > -0.55,
    "without an enclosing border the frame must stay on the journey");
});

test("the enclosing border may be a multipolygon", function () {
  var multi = { type: "MultiPolygon", coordinates: [
    [[[-0.55, 51.72], [0.28, 51.72], [0.28, 51.26], [-0.55, 51.26], [-0.55, 51.72]]],
    [[[1.00, 51.50], [1.10, 51.50], [1.10, 51.60], [1.00, 51.60], [1.00, 51.50]]]
  ]};
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE, multi);
  assert.ok(box[3] >= 1.10, "the second part of the border fell outside the frame");
});

test("a shape that is not a polygon is passed over, not thrown on", function () {
  assert.strictEqual(G.ringsOf(null).length, 0);
  assert.strictEqual(G.ringsOf({ type: "Point", coordinates: [0, 0] }).length, 0);
  assert.strictEqual(G.ringsOf(M25_SHAPE).length, 1);
  var box = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE, { type: "Point", coordinates: [0, 0] });
  assert.ok(box[3] < 0, "a point border must not drag the frame to the meridian");
});

test("with no journey yet, the border is what gets framed", function () {
  /* An address on its own, its city border known. Framing the address alone
     zooms to its street and leaves the ring off the edge of the map — which
     is indistinguishable from never having drawn it. */
  var box = G.journeyBox(OXHEY, null, null, M25_SHAPE);
  assert.ok(box[0] <= 51.26 && box[2] >= 51.72 && box[1] <= -0.55 && box[3] >= 0.28,
    "the ring is outside the frame: " + JSON.stringify(box));
  assert.ok(box[0] <= OXHEY.lat && box[2] >= OXHEY.lat, "the address left the frame");
});

test("the ring road does not widen the frame at all", function () {
  var withRing = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE.concat(RING));
  var without = G.journeyBox(OXHEY, CRICKLEWOOD, DRIVE);
  assert.notStrictEqual(withRing.join(","), without.join(","),
    "sanity: passing the ring as route points must widen it");
  /* But the border is never passed as route points — that is the whole fix. */
  assert.ok(span(without).lon < 0.25, "the journey's own frame stayed tight");
});

/* --- when the parts of the journey are worth showing ---------------------- */
console.log("\nWhen the parts are worth showing");

function result(overall, segs) {
  return { verdict: overall, segments: segs.map(function (v, i) {
    return { id: "s" + i, verdict: v };
  })};
}

test("three parts all agreeing with the ruling are not shown", function () {
  assert.strictEqual(
    G.segmentsDiffer(result("QASR", ["QASR", "QASR", "QASR"])), false,
    "repeating the headline three times is noise, not information");
});

test("ten days at the destination is shown, because the stay differs [1779]", function () {
  /* The legs are shortened; the stay is full, because ten days makes you a
     resident there. This is the case a traveller most often gets wrong.     */
  assert.strictEqual(
    G.segmentsDiffer(result("TAMAM", ["QASR", "TAMAM", "QASR"])), true);
});

test("a return ruled differently from the outward leg is shown [1757]", function () {
  assert.strictEqual(
    G.segmentsDiffer(result("TAMAM", ["QASR", "TAMAM"])), true);
});

test("a one-way journey that agrees throughout is not shown", function () {
  assert.strictEqual(G.segmentsDiffer(result("QASR", ["QASR"])), false);
});

test("praying both on one part alone is a difference", function () {
  assert.strictEqual(
    G.segmentsDiffer(result("JAMA", ["QASR", "JAMA"])), true);
});

test("nothing segmented at all is no difference", function () {
  assert.strictEqual(G.segmentsDiffer({ verdict: "QASR" }), false);
  assert.strictEqual(G.segmentsDiffer({ verdict: "QASR", segments: [] }), false);
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
