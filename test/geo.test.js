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
   South Mimms, with the eastern side across the Thames included — that stretch
   is signed A282, not M25. Coarse is enough; what is under test is the
   stitching, the tracing and the containment, not the surveying.            */
var M25 = [
  [51.700, -0.230], [51.660, -0.060], [51.665,  0.100], [51.615,  0.270],
  [51.505,  0.270], [51.465,  0.260], [51.400,  0.240], [51.375,  0.170],
  [51.300,  0.130], [51.270, -0.050], [51.290, -0.150], [51.265, -0.200],
  [51.320, -0.470], [51.375, -0.510], [51.440, -0.520], [51.500, -0.520],
  [51.570, -0.545], [51.660, -0.500], [51.700, -0.430], [51.720, -0.290]
];

/* Densified, so that simplification has something to remove and the ways have
   interior points to be reversed about. */
function densify(loop, per) {
  var out = [];
  for (var i = 0; i < loop.length; i++) {
    var a = loop[i], b = loop[(i + 1) % loop.length];
    for (var k = 0; k < per; k++) {
      out.push([a[0] + (b[0] - a[0]) * (k / per), a[1] + (b[1] - a[1]) * (k / per)]);
    }
  }
  return out;
}

/* Cut a closed loop into ways, reverse every other one and shuffle them: this
   is how Overpass hands a route relation over — unordered, and each way
   pointing whichever way it was drawn.                                       */
function asWays(loopLatLon, pieces, offset) {
  var ways = [], n = loopLatLon.length, size = Math.ceil(n / pieces);
  for (var i = 0; i < n; i += size) {
    var part = loopLatLon.slice(i, i + size + 1);
    if (part.length < 2) continue;
    if (i + size >= n) part = part.concat([loopLatLon[0]]);   /* close the loop */
    if ((i / size) % 2 === 1) part = part.slice().reverse();
    ways.push(part);
  }
  /* A fixed shuffle — no randomness, so a failure is always reproducible. */
  var shuffled = [];
  for (var j = 0; j < ways.length; j++) shuffled.push(ways[(j * 7 + (offset || 0)) % ways.length]);
  return shuffled.filter(function (w, k) { return shuffled.indexOf(w) === k; });
}

function relationOf(ways, ref) {
  return { type: "relation", tags: { ref: ref }, members: ways.map(function (w) {
    return { type: "way", role: "", geometry: w.map(function (p) {
      return { lat: p[0], lon: p[1] };
    })};
  })};
}

var ringLoop = densify(M25, 6);

function overpassM25() {
  return { elements: [relationOf(asWays(ringLoop, 9, 0), "M25")] };
}

test("the scattered, reversed ways are stitched back into one loop", function () {
  var ring = G.ringShape(overpassM25(), "M25");
  assert.strictEqual(ring.traced, true, "the road should trace, not fall back to a hull");
  assert.strictEqual(ring.closedByHand, false, "a complete loop needs no joining");
  var coords = ring.shape.coordinates[0];
  assert.deepStrictEqual(coords[0], coords[coords.length - 1], "the ring must close");
  assert.ok(coords.every(function (p) {
    return p[0] > -1 && p[0] < 1 && p[1] > 50 && p[1] < 53;
  }), "points are not [lon, lat] around London");
});

test("both ends of the Oxhey to Cricklewood journey lie inside the M25", function () {
  var shape = G.ringShape(overpassM25(), "M25").shape;
  assert.strictEqual(G.inShape(51.6238, -0.3892, shape), true, "WD19 4QP, South Oxhey");
  assert.strictEqual(G.inShape(51.5556, -0.2136, shape), true, "Anson Road, Cricklewood");
});

test("places beyond the ring are outside it", function () {
  var shape = G.ringShape(overpassM25(), "M25").shape;
  assert.strictEqual(G.inShape(52.0406, -0.7594, shape), false, "Milton Keynes");
  assert.strictEqual(G.inShape(50.8225, -0.1372, shape), false, "Brighton");
  assert.strictEqual(G.inShape(51.4543, -2.5879, shape), false, "Bristol");
});

/* The reason the hull was thrown away. A road that bends sharply inward
   leaves a notch that is outside the road but inside its hull.               */
test("a concave stretch is excluded, where the hull would have swallowed it", function () {
  var notched = [
    [51.70, -0.30], [51.70,  0.20], [51.30,  0.20], [51.30, -0.30],
    [51.45, -0.30], [51.45, -0.05], [51.55, -0.05], [51.55, -0.30]   /* the notch */
  ];
  var data = { elements: [relationOf(asWays(densify(notched, 4), 5, 1), "TEST")] };
  var ring = G.ringShape(data, "TEST");
  assert.strictEqual(ring.traced, true);

  var inNotch = [51.50, -0.20];       /* deep inside the notch, outside the road */
  assert.strictEqual(G.inShape(inNotch[0], inNotch[1], ring.shape), false,
    "the notch is outside the road and must be outside the border");

  var hull = { type: "Polygon", coordinates: [(function () {
    var pts = densify(notched, 4).map(function (p) { return [p[1], p[0]]; });
    var h = G.convexHull(pts); h.push(h[0]); return h;
  })()] };
  assert.strictEqual(G.inShape(inNotch[0], inNotch[1], hull), true,
    "the hull would have included it — which is why it was dropped");
});

test("the larger of two carriageways is the one taken", function () {
  /* An outer loop and an inner one, neither joining the other. */
  var inner = M25.map(function (p) {
    return [51.5 + (p[0] - 51.5) * 0.98, -0.15 + (p[1] + 0.15) * 0.98];
  });
  var data = { elements: [
    relationOf(asWays(densify(inner, 4), 6, 0), "M25"),
    relationOf(asWays(ringLoop, 9, 0), "M25")
  ]};
  var ring = G.ringShape(data, "M25");
  var area = G.ringAreaKm2(ring.shape.coordinates[0]);
  var outerArea = G.ringAreaKm2(G.ringShape(overpassM25(), "M25").shape.coordinates[0]);
  assert.ok(Math.abs(area - outerArea) / outerArea < 0.02,
    "expected the outer loop, got an area of " + area.toFixed(0) + " against " + outerArea.toFixed(0));
});

test("a road that does not quite close is joined, and says so", function () {
  var open = ringLoop.slice(0, ringLoop.length - 8);      /* a gap left in it */
  var data = { elements: [relationOf(asWays(open, 7, 0).filter(function (w, i) {
    return i < 6;                                        /* drop a piece outright */
  }), "M25")]};
  var ring = G.ringShape(data, "M25");
  assert.strictEqual(ring.traced, true, "an open road still traces");
  assert.strictEqual(ring.closedByHand, true, "the gap must be reported, not hidden");
  var coords = ring.shape.coordinates[0];
  assert.deepStrictEqual(coords[0], coords[coords.length - 1]);
});

test("simplification keeps the line where it was", function () {
  var dense = densify(M25, 40);
  var thin = G.simplifyLine(dense.map(function (p) { return [p[1], p[0]]; }), 0.05);
  assert.ok(thin.length < dense.length / 3,
    "expected far fewer points, got " + thin.length + " of " + dense.length);
  assert.ok(thin.length >= 4, "too few points left: " + thin.length);
  /* Every junction of the original must survive within the tolerance. */
  M25.forEach(function (p) {
    var closest = Infinity;
    thin.forEach(function (q) {
      closest = Math.min(closest, G.haversineKm({ lat: p[0], lon: p[1] }, { lat: q[1], lon: q[0] }));
    });
    assert.ok(closest < 0.2, "a junction moved " + (closest * 1000).toFixed(0) + " m");
  });
});

/* A dense road, wiggling by about 60 m — the scale of a real motorway's
   curves. Thinning must fit the budget without flattening the curves away.  */
function wigglyRing(perLeg) {
  var loop = [];
  for (var i = 0; i < M25.length; i++) {
    var a = M25[i], b = M25[(i + 1) % M25.length];
    for (var k = 0; k < perLeg; k++) {
      var t = k / perLeg;
      loop.push([a[0] + (b[0] - a[0]) * t + Math.sin(k * 0.7) * 0.0006,
                 a[1] + (b[1] - a[1]) * t + Math.cos(k * 0.9) * 0.0006]);
    }
  }
  return loop;
}

test("the traced ring is small enough to measure a route against", function () {
  var ring = G.ringShape({ elements: [relationOf(asWays(wigglyRing(750), 17, 0), "M25")] }, "M25");
  assert.ok(ring.shape.coordinates[0].length <= 2501,
    "too many points to walk a route against: " + ring.shape.coordinates[0].length);
});

/* The bug this is here for: thinning used to jump straight from a 50 m
   tolerance to 150 m the moment the count ran over, which took a fifteen
   thousand point road down to twenty-four — its corners, and no curve
   between them. A ring that coarse is not the M25.                          */
test("thinning a dense road does not flatten it to its corners", function () {
  var ring = G.ringShape({ elements: [relationOf(asWays(wigglyRing(750), 17, 0), "M25")] }, "M25");
  var kept = ring.shape.coordinates[0].length;
  assert.ok(kept > M25.length * 10,
    "the road collapsed to " + kept + " points — barely more than its " +
    M25.length + " corners");
});

test("a thinned road still holds the places it enclosed", function () {
  var ring = G.ringShape({ elements: [relationOf(asWays(wigglyRing(750), 17, 0), "M25")] }, "M25");
  assert.strictEqual(G.inShape(51.6238, -0.3892, ring.shape), true, "WD19 4QP");
  assert.strictEqual(G.inShape(51.5556, -0.2136, ring.shape), true, "Cricklewood");
  assert.strictEqual(G.inShape(52.0406, -0.7594, ring.shape), false, "Milton Keynes");
});

test("stitching never joins two lines that do not meet", function () {
  var apart = G.stitchLines([
    [[0, 51], [0.1, 51]],
    [[5, 51], [5.1, 51]]
  ]);
  assert.strictEqual(apart.length, 2, "two distant lines are two chains");
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

test("London is measured from the M25, and from the A282 across the Thames", function () {
  /* Compared as text: the array is built inside the sandbox realm, so it is
     not reference-equal to one built out here. */
  assert.strictEqual(G.RING_ROAD.london.join(","), "M25,A282");
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
