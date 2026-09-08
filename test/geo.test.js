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

test("a slip road that loops does not outrank the motorway", function () {
  /* The real M25 comes back as eleven hundred ways, and some of the small
     ones close on themselves. A ring road is the biggest thing in the answer,
     not merely a closed thing in it. */
  /* The motorway as it really came back: a long arc that does not quite meet
     itself, because a stretch of it is signed differently. The junction loop
     does meet itself. */
  var arc = ringLoop.slice(0, Math.floor(ringLoop.length * 0.85));
  var roundabout = [[-0.4000, 51.6700], [-0.3990, 51.6706], [-0.3980, 51.6700],
                    [-0.3990, 51.6694], [-0.4000, 51.6700]];
  var data = { elements: [relationOf([arc, roundabout], "M25")] };
  var ring = G.ringShape(data, "M25");
  assert.ok(G.ringAreaKm2(ring.shape.coordinates[0]) > 1000,
    "the ring encloses " + G.ringAreaKm2(ring.shape.coordinates[0]).toFixed(1) +
    " km² — a junction loop was taken for the motorway");
  assert.strictEqual(G.inShape(51.5556, -0.2136, ring.shape), true, "Cricklewood fell outside it");
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

/* --- the M25 as the page carries it --------------------------------------- */
/* This polygon decides whether an address is in London, and with it whether a
   journey counts at all. It is checked against places whose side of the
   motorway is not in doubt. */
console.log("\nThe M25 carried in the page");

function m25() {
  var entry = G.RING_ROADS.filter(function (r) { return r.city === "London"; })[0];
  assert.ok(entry && entry.shape, "London has no ring road in the page");
  return entry;
}

test("it encloses about what the M25 encloses", function () {
  var area = G.ringAreaKm2(m25().shape.coordinates[0]);
  assert.ok(area > 1900 && area < 2600,
    "the M25 holds roughly 2,200 km²; this holds " + area.toFixed(0));
});

test("it is a closed ring of enough points to be a road", function () {
  var edge = m25().shape.coordinates[0];
  assert.ok(edge.length >= 30, "too few points to follow a motorway: " + edge.length);
  assert.strictEqual(edge[0].join(","), edge[edge.length - 1].join(","), "the ring must close");
  assert.ok(edge.every(function (p) {
    return p[0] > -0.7 && p[0] < 0.4 && p[1] > 51.1 && p[1] < 51.9;
  }), "a point strayed outside the south-east — check the [lon, lat] order");
});

test("places inside the M25 are inside", function () {
  var shape = m25().shape;
  [["WD19 4QP, South Oxhey", 51.6238, -0.3892],
   ["Anson Road, Cricklewood", 51.5556, -0.2136],
   ["Watford town centre", 51.6560, -0.3960],
   ["Heathrow", 51.4700, -0.4543],
   ["Croydon", 51.3762, -0.0982],
   ["Dartford", 51.4460, 0.2170],
   ["Uxbridge", 51.5460, -0.4780],
   ["Charing Cross", 51.5074, -0.1278]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), true, c[0] + " came out outside");
  });
});

test("places outside the M25 are outside", function () {
  var shape = m25().shape;
  [["St Albans", 51.7520, -0.3360],
   ["Slough", 51.5105, -0.5950],
   ["Sevenoaks town", 51.2720, 0.1900],
   ["Guildford", 51.2362, -0.5704],
   ["Brighton", 50.8225, -0.1372],
   ["Milton Keynes", 52.0406, -0.7594]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), false, c[0] + " came out inside");
  });
});

/* Checked against the M25 as Google Maps draws it, place by place, from a
   screenshot of the ring with these towns named on it. Every one of them sits
   plainly on one side or the other there — none is a borderline call. */
test("it agrees with the motorway on every town the map names", function () {
  var shape = m25().shape;
  [["Enfield", 51.6520, -0.0810, true],
   ["Romford", 51.5750, 0.1830, true],
   ["Ilford", 51.5590, 0.0690, true],
   ["Wembley", 51.5520, -0.2960, true],
   ["Charing Cross", 51.5074, -0.1278, true],
   ["Croydon", 51.3762, -0.0982, true],
   ["Watford", 51.6560, -0.3960, true],
   ["Rickmansworth", 51.6390, -0.4700, true],
   ["Luton", 51.8790, -0.4200, false],
   ["Stevenage", 51.9020, -0.2020, false],
   ["Guildford", 51.2362, -0.5704, false],
   ["Crawley", 51.1090, -0.1870, false],
   ["Wellingborough", 52.3020, -0.6960, false]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), c[3],
      c[0] + " is " + (c[3] ? "inside" : "outside") + " the M25 on the map, and came out " +
      (c[3] ? "outside" : "inside"));
  });
});

test("it reaches as far as the motorway reaches, and no further", function () {
  var edge = m25().shape.coordinates[0];
  var lat = edge.map(function (p) { return p[1]; });
  var lon = edge.map(function (p) { return p[0]; });
  var n = Math.max.apply(null, lat), s = Math.min.apply(null, lat);
  var e = Math.max.apply(null, lon), w = Math.min.apply(null, lon);
  /* The M25 runs from about 51.25 in the south to 51.72 in the north, and
     from about -0.53 in the west to 0.29 in the east. */
  assert.ok(n > 51.68 && n < 51.76, "north edge at " + n.toFixed(3));
  assert.ok(s > 51.21 && s < 51.29, "south edge at " + s.toFixed(3));
  assert.ok(w > -0.58 && w < -0.48, "west edge at " + w.toFixed(3));
  assert.ok(e > 0.24 && e < 0.34, "east edge at " + e.toFixed(3));
});

/* --- the Greater Toronto Area ---------------------------------------------
   Al-Ma'arif's own line, copied from https://al-m.ca/travel/ , checked the
   way every boundary here is: places whose side of it is not in doubt.

   Three of the places below are outside it although they are inside the
   region they belong to — Burlington in Halton, East Gwillimbury in York,
   Oshawa in Durham. That is their line's choice, not a fault in it, and
   these tests are what would catch it being quietly replaced by the
   municipal boundary, which takes all three in. */
console.log("\nThe GTA boundary");

function gta() {
  var e = G.RING_ROADS.filter(function (r) { return r.city === "Greater Toronto"; })[0];
  assert.ok(e && e.shape, "the GTA is not in the page");
  return e;
}

test("it holds the cities the GTA is made of", function () {
  var shape = gta().shape;
  [["Toronto", 43.6532, -79.3832], ["Mississauga", 43.5890, -79.6441],
   ["Brampton", 43.7315, -79.7624], ["Vaughan", 43.8361, -79.4983],
   ["Markham", 43.8561, -79.3370], ["Richmond Hill", 43.8828, -79.4403],
   ["Newmarket", 44.0592, -79.4613], ["Aurora", 44.0065, -79.4504],
   ["Pickering", 43.8384, -79.0868], ["Ajax", 43.8509, -79.0204],
   ["Whitby", 43.8975, -78.9428], ["Oakville", 43.4675, -79.6877],
   ["Milton", 43.5183, -79.8774], ["Halton Hills", 43.6300, -79.9500],
   ["Uxbridge", 44.1085, -79.1220], ["Stouffville", 43.9710, -79.2470],
   ["Scarborough", 43.7731, -79.2578], ["Etobicoke", 43.6205, -79.5132],
   ["Pearson airport", 43.6777, -79.6248], ["Caledon", 43.8660, -79.8660],
   ["King City", 43.9260, -79.5290], ["North York", 43.7615, -79.4111]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), true, c[0] + " came out outside the GTA");
  });
});

test("it stops where the map stops it", function () {
  var shape = gta().shape;
  [["Hamilton", 43.2557, -79.8711], ["Guelph", 43.5448, -80.2482],
   ["Orangeville", 43.9190, -80.0940], ["Barrie", 44.3894, -79.6903],
   ["Kitchener", 43.4516, -80.4925], ["Peterborough", 44.3091, -78.3197],
   ["St Catharines", 43.1594, -79.2469], ["Cambridge", 43.3616, -80.3144],
   ["Niagara Falls", 43.0896, -79.0849],
   /* Clarington, Scugog, Georgina and Brock: in Durham and York, and not
      in this line. */
   ["Bowmanville", 43.9120, -78.6880], ["Port Perry", 44.1000, -78.9450],
   ["Keswick", 44.2300, -79.4660], ["Beaverton", 44.4300, -79.1500],
   /* And the three whole municipalities their line leaves out, which the
      municipal boundary would take in. */
   ["Burlington", 43.3255, -79.7990], ["Oshawa", 43.8971, -78.8658],
   ["East Gwillimbury", 44.1030, -79.4400], ["Mount Albert", 44.1330, -79.3200]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), false, c[0] + " came out inside the GTA");
  });
});

test("it is one line round the outside, with nothing drawn inside it", function () {
  var e = gta();
  assert.strictEqual(e.shape.type, "Polygon", "the GTA is in parts again");
  assert.strictEqual(e.shape.coordinates.length, 1,
    "the GTA carries " + e.shape.coordinates.length + " rings, so a line would show inside it");
  var ring = e.shape.coordinates[0];
  assert.deepStrictEqual(ring[0], ring[ring.length - 1], "the ring does not close");
});

test("it is the line al-m.ca publishes, not the municipal one", function () {
  /* 4,580 against the 5,473 the municipalities come to. If someone rebuilds
     this from tools/trace-area.html the area alone will say so. */
  var area = G.ringAreaKm2(gta().shape.coordinates[0]);
  assert.ok(area > 4400 && area < 4750,
    "the GTA came out at " + area.toFixed(0) + " km² — 5,473 would mean the municipal boundary");
});

test("it encloses what that boundary encloses, and its box holds it", function () {
  var e = gta(), ring = e.shape.coordinates[0];
  var area = G.ringAreaKm2(ring);
  assert.ok(area > 4400 && area < 4750, "the GTA came out at " + area.toFixed(0) + " km²");
  ring.forEach(function (p) {
    assert.ok(p[1] >= e.box[0] && p[1] <= e.box[2] && p[0] >= e.box[1] && p[0] <= e.box[3],
      "the boundary runs outside its own box at " + p);
  });
});

/* --- drawing along a road ------------------------------------------------- */
console.log("\nSnapping a drawn stroke to the roads under it");

/* A motorway running north, a slip road forty metres east of it running
   alongside, and a residential street crossing them both. */
function road(id, name, kind, pts) { return { id: id, name: name, kind: kind, line: pts }; }
function northSouth(lon, fromLat, toLat, n) {
  var out = [];
  for (var i = 0; i <= n; i++) out.push([lon, fromLat + (toLat - fromLat) * i / n]);
  return out;
}
var M = road(1, "M25", "motorway", northSouth(-0.4000, 51.50, 51.60, 40));
var SLIP = road(2, "slip road", "residential", northSouth(-0.39943, 51.52, 51.55, 20));
var CROSS = road(3, "Mill Lane", "residential",
  [[-0.42, 51.545], [-0.38, 51.545]]);

test("a stroke along the motorway picks the motorway, not the slip beside it", function () {
  /* Drawn down the middle, the slip road is nearer for much of the way — it
     is forty metres east and the pen is never exact. Kind decides it. */
  var stroke = northSouth(-0.39975, 51.53, 51.58, 30);
  var got = G.snapStroke(stroke, [M, SLIP, CROSS]);
  assert.ok(got.length, "the stroke matched no road at all");
  assert.strictEqual(got[0].name, "M25",
    "the stroke snapped to " + got[0].name + " rather than the main road under it");
});

test("a stroke along a street picks the street, not a motorway further off", function () {
  /* The preference must not become an override: a motorway a quarter of a
     kilometre away does not get to take a street from under the pen. */
  var stroke = [[-0.4150, 51.5450], [-0.4120, 51.5450], [-0.4090, 51.5450], [-0.4060, 51.5450]];
  var got = G.snapStroke(stroke, [M, SLIP, CROSS]);
  assert.strictEqual(got[0].name, "Mill Lane",
    "the stroke snapped to " + got[0].name + " rather than the road drawn on");
});

test("brushing past a road does not put it in the border", function () {
  /* One point in passing is not drawing along it: a road has to win twice. */
  var stroke = northSouth(-0.4000, 51.5449, 51.5650, 24);
  var got = G.snapStroke(stroke, [M, CROSS]).map(function (r) { return r.name; });
  assert.ok(got.indexOf("M25") >= 0, "the road drawn along is missing");
  assert.strictEqual(got.indexOf("Mill Lane"), -1,
    "a road crossed once was taken as drawn along");
});

test("a stroke nowhere near a road matches nothing", function () {
  var stroke = northSouth(-0.2000, 51.52, 51.56, 20);
  assert.strictEqual(G.snapStroke(stroke, [M, SLIP, CROSS]).length, 0,
    "a stroke in open country matched a road");
});

test("the weights rank the roads a border is made of", function () {
  assert.ok(G.roadWeight("motorway") < G.roadWeight("primary"),
    "a motorway must outrank a primary");
  assert.ok(G.roadWeight("primary") < G.roadWeight("residential"),
    "a primary must outrank a residential street");
  assert.strictEqual(G.roadWeight(undefined), 1, "an untagged road must not be favoured");
});

/* --- a "city" that is really a region ------------------------------------- */
console.log("\nCities too large to be cities");

function boxCity(km2, extra) {
  /* A square of about the given area, at Melbourne's latitude. */
  var side = Math.sqrt(km2), lat = -37.81, lon = 144.96;
  var dLat = side / 111, dLon = side / (111 * Math.cos(lat * Math.PI / 180));
  var ring = [[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat],
              [lon, lat + dLat], [lon, lat]];
  var c = { name: "Somewhere", shape: { type: "Polygon", coordinates: [ring] } };
  Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
  return c;
}

test("Greater Melbourne's 8,892 km² is refused as a city", function () {
  /* The bug this exists for: Bunyip is 72 km from the CBD and inside that
     polygon, so the whole 72 km was deducted and the journey ruled full. */
  assert.strictEqual(G.cityTooBig(boxCity(8892)), true);
});

test("real cities are left alone", function () {
  [["Toronto", 630], ["New York", 1223], ["Los Angeles", 1302],
   ["Houston", 1651], ["a big one", 2900]].forEach(function (c) {
    assert.strictEqual(G.cityTooBig(boxCity(c[1])), false,
      c[0] + " at " + c[1] + " km² was called a region");
  });
});

test("a ring road is exempt, however large", function () {
  /* The GTA line is 4,580 km² and was chosen on purpose, not found. */
  assert.strictEqual(G.cityTooBig(boxCity(4580, { fromRing: "GTA boundary" })), false,
    "a border chosen deliberately must not be second-guessed");
  assert.strictEqual(G.cityTooBig(boxCity(4580)), true,
    "the same size found by lookup should still be questioned");
});

test("nothing to measure is not a complaint", function () {
  assert.strictEqual(G.cityTooBig(null), false);
  assert.strictEqual(G.cityTooBig({ name: "No border" }), false);
});

/* --- the built-up areas ---------------------------------------------------
   Shipped as a file rather than in the page, so it is checked as a file. */
console.log("\nThe built-up areas");

var URBAN = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "urban-areas.json"), "utf8"));
function urban(name) {
  return URBAN.areas.filter(function (a) { return a.name === name; })[0];
}

test("it says where it came from", function () {
  assert.ok(/Australian Bureau of Statistics/.test(URBAN.source), "the source is not named");
  assert.ok(/CC BY/.test(URBAN.source), "the licence is not named");
  assert.ok(URBAN.areas.length >= 5, "only " + URBAN.areas.length + " built-up area(s) on file");
});

test("Melbourne is the built-up city, not the region", function () {
  /* The bug: Greater Melbourne is 8,892 km² and holds Bunyip, 72 km out, so
     72 km was deducted as home and the journey ruled full. */
  var m = urban("Melbourne");
  assert.ok(m, "Melbourne is not on file");
  assert.ok(m.areaKm2 > 2000 && m.areaKm2 < 3500,
    "Melbourne's built-up area came out at " + m.areaKm2 + " km²");
  [["Melbourne CBD", -37.8136, 144.9631, true], ["Frankston", -38.1430, 145.1230, true],
   ["Werribee", -37.9000, 144.6600, true],      ["Pakenham", -38.0700, 145.4850, true],
   ["Doreen", -37.6030, 145.1470, false],       ["Whittlesea town", -37.5130, 145.1190, false],
   ["Healesville", -37.6540, 145.5170, false],  ["Warburton", -37.7530, 145.6930, false],
   ["Bunyip", -38.0900, 145.7100, false],       ["Geelong", -38.1499, 144.3617, false]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], m.shape), c[3],
      c[0] + " came out " + (c[3] ? "outside" : "inside") + " built-up Melbourne");
  });
});

test("every one of them is small enough to be a city", function () {
  /* Otherwise the guard would fire on the very shape meant to satisfy it. */
  URBAN.areas.forEach(function (a) {
    assert.strictEqual(G.cityTooBig({ shape: a.shape }), false,
      a.name + " is " + a.areaKm2 + " km², which the guard would still refuse");
  });
});

test("each carries a box that holds it", function () {
  URBAN.areas.forEach(function (a) {
    a.shape.coordinates.forEach(function (poly) {
      poly[0].forEach(function (p) {
        assert.ok(p[1] >= a.box[0] && p[1] <= a.box[2] && p[0] >= a.box[1] && p[0] <= a.box[3],
          a.name + " runs outside its own box at " + p + " — the lookup would skip it");
      });
    });
  });
});

/* --- Dubai ---------------------------------------------------------------- */
console.log("\nDubai");

function dubai() {
  var e = G.RING_ROADS.filter(function (r) { return r.city === "Dubai"; })[0];
  assert.ok(e && e.shape, "Dubai is not in the page");
  return e;
}

test("it holds the city, islands and all", function () {
  var shape = dubai().shape;
  [["Downtown", 25.1972, 55.2744], ["Deira", 25.2700, 55.3200],
   ["Marina", 25.0800, 55.1400],   ["Palm Jumeirah", 25.1124, 55.1390],
   ["Al Barsha", 25.1100, 55.2000], ["Silicon Oasis", 25.1200, 55.3800],
   ["Mirdif", 25.2200, 55.4200],   ["Arabian Ranches", 25.0500, 55.2700],
   ["Motor City", 25.0500, 55.2400], ["Sports City", 25.0400, 55.2200],
   ["International City", 25.1650, 55.4100], ["Jebel Ali", 25.0100, 55.1000],
   ["Al Qusais", 25.2800, 55.3800], ["Investment Park", 24.9800, 55.1700],
   ["the airport", 25.2532, 55.3657]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), true, c[0] + " came out outside Dubai");
  });
});

test("it stops at the E611 and at the water", function () {
  /* The two faults this boundary exists to fix: the published one runs
     ninety-seven kilometres inland to Hatta and twelve out into the Gulf. */
  var shape = dubai().shape;
  [["Al Lisaili", 24.8600, 55.5000], ["Margham", 24.8000, 55.6500],
   ["Hatta", 24.8000, 56.1200],      ["5 km offshore", 25.1200, 55.0800],
   ["12 km offshore", 25.1700, 55.0100], ["25 km offshore", 25.2500, 54.9000],
   ["Sharjah", 25.3463, 55.4209],    ["Abu Dhabi", 24.4539, 54.3773]
  ].forEach(function (c) {
    assert.strictEqual(G.inShape(c[1], c[2], shape), false, c[0] + " came out inside Dubai");
  });
});

test("the islands are kept as parts of their own", function () {
  /* Reclaimed ground is Dubai. A boundary cut to the coast that dropped the
     islands would put the Palm out of the city it was built by. */
  var e = dubai();
  assert.strictEqual(e.shape.type, "MultiPolygon");
  assert.ok(e.shape.coordinates.length >= 8,
    "only " + e.shape.coordinates.length + " part(s) — the islands have been lost");
  var area = e.shape.coordinates.reduce(function (n, poly) {
    return n + G.ringAreaKm2(poly[0]);
  }, 0);
  assert.ok(area > 1100 && area < 1600, "Dubai came out at " + area.toFixed(0) + " km²");
});

test("its box holds every part of it", function () {
  var e = dubai();
  e.shape.coordinates.forEach(function (poly) {
    poly[0].forEach(function (p) {
      assert.ok(p[1] >= e.box[0] && p[1] <= e.box[2] && p[0] >= e.box[1] && p[0] <= e.box[3],
        "Dubai runs outside its own box at " + p);
    });
  });
});

test("the box that gates the lookup contains the whole ring", function () {
  var entry = m25(), b = entry.box;
  entry.shape.coordinates[0].forEach(function (p) {
    assert.ok(p[1] >= b[0] && p[1] <= b[2] && p[0] >= b[1] && p[0] <= b[3],
      "the ring runs outside its own box at " + p + " — addresses there would be missed");
  });
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
