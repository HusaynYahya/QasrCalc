/* ============================================================================
   Tests for the geometry in qasr.js — the city border and the walk along a
   route. The rulings themselves live in fiqh.js and are tested by fiqh.test.js. — run with:  node test/engine.test.js
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


var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (err) { failed++; console.log("  FAIL " + name + "\n       " + err.message); }
}

var G = sandbox.window.QasrEngine;

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

/* --- sizing a city, anywhere on earth ------------------------------------ */
console.log("\nMeasuring a city's extent");

test("the same span of degrees is a smaller city further north", function () {
  var span = [-0.5, 0.2, 0.5, -0.2];            /* one degree by 0.4 */
  var equator = G.extentKm2(span, 0);
  var helsinki = G.extentKm2(span, 60);
  assert.ok(helsinki < equator * 0.55,
    "60N should be about half: " + helsinki.toFixed(0) + " vs " + equator.toFixed(0));
});

test("London's box outsizes Watford's", function () {
  var london  = G.extentKm2([-0.51, 51.69, 0.33, 51.28], 51.5);
  var watford = G.extentKm2([-0.44, 51.69, -0.36, 51.63], 51.66);
  assert.ok(london > watford * 20, "London " + london.toFixed(0) + " vs Watford " + watford.toFixed(0));
});

test("a box across the antimeridian is not counted as the whole globe", function () {
  var fiji = G.extentKm2([179.7, -17.6, -179.8, -18.2], -18);
  assert.ok(fiji > 0 && fiji < 5000, "expected a small island city, got " + fiji.toFixed(0));
});

test("a missing or malformed extent is zero, not an error", function () {
  assert.strictEqual(G.extentKm2(null, 50), 0);
  assert.strictEqual(G.extentKm2([1, 2], 50), 0);
});

test("the search radius is a sane distance", function () {
  assert.ok(G.NEAR_CITY_KM >= 40 && G.NEAR_CITY_KM <= 100);
});

/* --- a ring road standing in for the city border ------------------------- */
console.log("\nRing roads");

/* The M25, coarsely: one point near each of twenty junctions, clockwise from
   South Mimms. Coarse is enough — the hull of a nearly convex ring is the
   ring, and what is under test is the parsing and the containment, not the
   surveying. Given as Overpass gives it: a relation whose members carry
   geometry, in [lat, lon].                                                  */
var M25 = [
  [51.700, -0.230], [51.660, -0.060], [51.665,  0.100], [51.615,  0.270],
  [51.505,  0.270], [51.465,  0.260], [51.400,  0.240], [51.375,  0.170],
  [51.300,  0.130], [51.270, -0.050], [51.290, -0.150], [51.265, -0.200],
  [51.320, -0.470], [51.375, -0.510], [51.440, -0.520], [51.500, -0.520],
  [51.570, -0.545], [51.660, -0.500], [51.700, -0.430], [51.720, -0.290]
];

function overpassRelation(points) {
  /* Split across two members, as a real route relation is split across ways. */
  function member(part) {
    return { type: "way", role: "", geometry: part.map(function (p) {
      return { lat: p[0], lon: p[1] };
    })};
  }
  var half = Math.ceil(points.length / 2);
  return { elements: [{ type: "relation", tags: { ref: "M25" },
    members: [member(points.slice(0, half)), member(points.slice(half))] }] };
}

test("the ring road's members are read into a closed polygon", function () {
  var shape = G.ringShape(overpassRelation(M25), "M25");
  assert.strictEqual(shape.type, "Polygon");
  var ring = shape.coordinates[0];
  assert.ok(ring.length >= 4, "too few points: " + ring.length);
  assert.deepStrictEqual(ring[0], ring[ring.length - 1], "the ring must close");
  /* GeoJSON order: longitude first. */
  assert.ok(ring.every(function (p) { return p[0] > -1 && p[0] < 1 && p[1] > 50 && p[1] < 53; }),
            "points are not [lon, lat] around London");
});

test("both ends of the Oxhey to Cricklewood journey lie inside the M25", function () {
  var shape = G.ringShape(overpassRelation(M25), "M25");
  assert.strictEqual(G.inShape(51.6238, -0.3892, shape), true, "WD19 4QP, South Oxhey");
  assert.strictEqual(G.inShape(51.5556, -0.2136, shape), true, "Anson Road, Cricklewood");
});

test("places beyond the ring are outside it", function () {
  var shape = G.ringShape(overpassRelation(M25), "M25");
  assert.strictEqual(G.inShape(52.0406, -0.7594, shape), false, "Milton Keynes");
  assert.strictEqual(G.inShape(50.8225, -0.1372, shape), false, "Brighton");
  assert.strictEqual(G.inShape(51.4543, -2.5879, shape), false, "Bristol");
});

test("the hull wraps every point of the road", function () {
  var shape = G.ringShape(overpassRelation(M25), "M25");
  M25.forEach(function (p) {
    /* A point nudged a little inward from each junction must be inside. */
    var lat = 51.5 + (p[0] - 51.5) * 0.97, lon = -0.15 + (p[1] + 0.15) * 0.97;
    assert.strictEqual(G.inShape(lat, lon, shape), true, "just inside " + p);
  });
});

test("a relation with no geometry is refused, not silently empty", function () {
  assert.throws(function () { G.ringShape({ elements: [{ type: "relation" }] }, "M25"); },
                /No road numbered M25/);
  assert.throws(function () { G.ringShape({}, "M25"); }, /No road numbered M25/);
});

test("the hull of collinear points does not pretend to enclose an area", function () {
  var line = [[0, 0], [1, 1], [2, 2], [3, 3]];
  assert.ok(G.convexHull(line).length < 3, "a straight line encloses nothing");
});

test("London is the city measured from its ring road", function () {
  assert.strictEqual(G.RING_ROAD.london, "M25");
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
