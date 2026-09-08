/* ============================================================================
   Turn an Overpass answer into the ring road this page carries.

     node tools/build-ring.js <overpass.json> [more.json ...] [--write]

   The M25 does not move, so its shape belongs in the page rather than being
   fetched every visit. This takes the raw answer, stitches the member ways
   into the loop the road actually makes, thins it, checks it against places
   whose side of the motorway is not in doubt, and prints it ready to paste —
   or writes it straight into qasr.js with --write.

   The stitching, thinning and area sums are qasr.js's own, loaded from it, so
   what is built here is what the page would have built for itself.

   To get the file, either open this in a browser and save the result:

     https://overpass-api.de/api/interpreter?data=[out:json][timeout:90];(relation["ref"="M25"]["type"="route"]["route"="road"](51.2,-0.65,51.8,0.4);relation["ref"="A282"]["type"="route"]["route"="road"](51.2,-0.65,51.8,0.4););out%20geom;

   or paste the same query into https://overpass-turbo.eu and export the raw
   data. Either gives a file of a megabyte or two; this reduces it to a few
   hundred coordinate pairs.

   The bounding box in that query is not decoration. ref=M25 is not unique on
   earth: without it the same query also returns an M25 in Cape Town, one in
   Hungary, one in South Africa and a road in Malaysia, and they were being
   stitched into the London ring. The box is checked again below, on every
   point, so a query pasted from somewhere older cannot get them in.
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var WRITE = process.argv.indexOf("--write") >= 0;
var files = process.argv.slice(2).filter(function (a) { return a !== "--write"; });
if (!files.length) {
  console.error("usage: node tools/build-ring.js <overpass.json> [more.json ...] [--write]");
  process.exit(2);
}

/* qasr.js's own geometry, so this cannot drift from what the page does. */
var sandbox = {
  window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: { readyState: "complete", getElementById: function () { return null; },
              addEventListener: function () {} },
  fetch: function () { return Promise.reject(new Error("no network here")); }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8"), sandbox);
var G = sandbox.window.QasrEngine;

/* Several files are merged before stitching, so the M25 and the A282 may be
   fetched separately — one query each is easier to get past a browser than
   one query with brackets in it. */
var data = { elements: [] };
files.forEach(function (f) {
  var part = JSON.parse(fs.readFileSync(f, "utf8"));
  var got = (part.elements || []).length;
  console.log("  " + path.basename(f) + ": " + got + " element(s)");
  data.elements = data.elements.concat(part.elements || []);
});
var raw = data.elements.reduce(function (n, el) {
  return n + ((el.members || []).reduce(function (m, w) {
    return m + ((w.geometry || []).length);
  }, 0)) + ((el.geometry || []).length);
}, 0);

/* Only the London ring. Every point is checked, not just the relation. */
var LONDON = [51.2, -0.65, 51.8, 0.4];
var pts = [];
data.elements.forEach(function (el) {
  (el.members || []).concat(el.geometry ? [el] : []).forEach(function (w) {
    (w.geometry || []).forEach(function (p) {
      if (p.lat >= LONDON[0] && p.lat <= LONDON[2] &&
          p.lon >= LONDON[1] && p.lon <= LONDON[3]) pts.push([p.lon, p.lat]);
    });
  });
});
if (pts.length < 500) {
  console.error("only " + pts.length + " point(s) fell inside London — wrong file, or the " +
                "query had no bounding box and returned some other country's M25.");
  process.exit(1);
}

/* The ring, as the median radius on each bearing from the middle of it.

   It used to be stitched end to end, and that stopped working: the M25
   relation carries over a thousand member ways now — both carriageways, the
   slip roads and the spurs — and joining them nose to tail makes knots, not
   a loop. The last ring built that way was out by up to six kilometres in
   places, which moves where a journey crosses the border and so what is
   counted.

   A ring road is star-shaped about its own centre, so every bearing from
   that centre meets it once. Taking the MEDIAN radius on each bearing lands
   on the carriageway: both directions and every slip road sit at slightly
   different radii on the same bearing, and a median ignores them where a
   mean would be dragged off the road by each one.                          */
var cx = pts.reduce(function (a, p) { return a + p[0]; }, 0) / pts.length;
var cy = pts.reduce(function (a, p) { return a + p[1]; }, 0) / pts.length;
var kx = Math.cos(cy * Math.PI / 180);
var N = 1440, bins = [];
for (var b = 0; b < N; b++) bins.push([]);
pts.forEach(function (p) {
  var dx = (p[0] - cx) * kx, dy = p[1] - cy;
  var th = Math.atan2(dy, dx);
  if (th < 0) th += 2 * Math.PI;
  bins[Math.min(N - 1, Math.floor(th / (2 * Math.PI) * N))].push(Math.sqrt(dx * dx + dy * dy));
});
var full = [];
for (b = 0; b < N; b++) {
  if (!bins[b].length) continue;
  bins[b].sort(function (x, y) { return x - y; });
  var r = bins[b][Math.floor(bins[b].length / 2)];
  var a = (b + 0.5) / N * 2 * Math.PI;
  full.push([cx + Math.cos(a) * r / kx, cy + Math.sin(a) * r]);
}
full.push(full[0].slice());

/* qasr.js's own thinning and area, so these cannot drift from the page. */
var edge = G.simplifyLine(full, 0.1);
if (edge[0][0] !== edge[edge.length - 1][0] || edge[0][1] !== edge[edge.length - 1][1]) {
  edge.push(edge[0].slice());
}
edge = edge.map(function (p) {
  return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
});
var ring = { shape: { type: "Polygon", coordinates: [edge] },
             areaKm2: G.ringAreaKm2(edge), traced: true, closedByHand: false };

/* How far the ring sits from the road it is meant to be. This is the check
   the landmarks cannot make: every landmark can be on the right side while
   the line between them wanders kilometres off the motorway. */
var worst = 0, sum = 0;
edge.forEach(function (p) {
  var best = Infinity;
  for (var i = 0; i < pts.length; i++) {
    var v = G.haversineKm({ lat: p[1], lon: p[0] }, { lat: pts[i][1], lon: pts[i][0] });
    if (v < best) best = v;
  }
  sum += best;
  if (best > worst) worst = best;
});
var offMean = sum / edge.length;
console.log("\nread          " + raw + " points from " + files.length + " file(s)");
console.log("in London     " + pts.length + " of them");
console.log("kept          " + edge.length + " points");
console.log("encloses      " + Math.round(ring.areaKm2) + " km²   (the M25 holds about 2,200)");
console.log("off the road  " + (offMean * 1000).toFixed(0) + " m on average, " +
            (worst * 1000).toFixed(0) + " m at worst");

/* The same places the tests use: none of them a borderline call. */
var CHECKS = [
  ["WD19 4QP", 51.6238, -0.3892, true], ["Cricklewood", 51.5556, -0.2136, true],
  ["Watford", 51.6560, -0.3960, true],  ["Heathrow", 51.4700, -0.4543, true],
  ["Croydon", 51.3762, -0.0982, true],  ["Dartford", 51.4460, 0.2170, true],
  ["Enfield", 51.6520, -0.0810, true],  ["Romford", 51.5750, 0.1830, true],
  ["Charing Cross", 51.5074, -0.1278, true],
  ["St Albans", 51.7520, -0.3360, false], ["Slough", 51.5105, -0.5950, false],
  ["Sevenoaks", 51.2720, 0.1900, false],  ["Guildford", 51.2362, -0.5704, false],
  ["Luton", 51.8790, -0.4200, false],     ["Brighton", 50.8225, -0.1372, false]
];
var wrong = CHECKS.filter(function (c) {
  return G.inShape(c[1], c[2], ring.shape) !== c[3];
});
console.log("landmarks     " + (CHECKS.length - wrong.length) + " of " + CHECKS.length + " correct" +
  (wrong.length ? "  — WRONG: " + wrong.map(function (c) { return c[0]; }).join(", ") : ""));

/* Off-road distance is a condition, not a note: a ring can put all fifteen
   landmarks on the right side and still wander kilometres from the motorway
   between them, which is exactly what the stitched one did. */
var sound = !wrong.length && ring.areaKm2 > 1900 && ring.areaKm2 < 2600 && worst < 0.25;
console.log("\n" + (sound ? "This is usable." : "NOT usable — do not paste this in.") + "\n");

var literal = "  var M25 = [\n" +
  edge.map(function (p, i) {
    return "    [" + p[0].toFixed(5) + ", " + p[1].toFixed(5) + "]" +
           (i < edge.length - 1 ? "," : "");
  }).join("\n") + "\n  ];";

if (!WRITE) {
  console.log(literal.length > 4000
    ? literal.slice(0, 2000) + "\n    … " + (edge.length - 60) + " more …\n" + literal.slice(-800)
    : literal);
  console.log("\nRun again with --write to put this into qasr.js.");
  process.exit(sound ? 0 : 1);
}

if (!sound) { console.error("refusing to write an unsound ring."); process.exit(1); }

var js = fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8");
var start = js.indexOf("  var M25 = [");
var end = js.indexOf("\n  ];", start);
if (start < 0 || end < 0) { console.error("could not find the M25 array in qasr.js"); process.exit(1); }
var out = js.slice(0, start) + literal + js.slice(end + "\n  ];".length);
fs.writeFileSync(path.join(__dirname, "..", "qasr.js") + ".tmp", out);
fs.renameSync(path.join(__dirname, "..", "qasr.js") + ".tmp", path.join(__dirname, "..", "qasr.js"));
console.log("written into qasr.js — now run the tests, and update areaKm2 to " +
            Math.round(ring.areaKm2) + " in RING_ROADS.");
