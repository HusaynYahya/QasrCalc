/* ============================================================================
   Turn an Overpass answer into the ring road this page carries.

     node tools/build-ring.js <overpass.json> [--write]

   The M25 does not move, so its shape belongs in the page rather than being
   fetched every visit. This takes the raw answer, stitches the member ways
   into the loop the road actually makes, thins it, checks it against places
   whose side of the motorway is not in doubt, and prints it ready to paste —
   or writes it straight into qasr.js with --write.

   The stitching, thinning and area sums are qasr.js's own, loaded from it, so
   what is built here is what the page would have built for itself.

   To get the file, either open this in a browser and save the result:

     https://overpass-api.de/api/interpreter?data=[out:json][timeout:90];(relation["ref"="M25"]["type"="route"]["route"="road"];relation["ref"="A282"]["type"="route"]["route"="road"];);out%20geom;

   or paste the same query into https://overpass-turbo.eu and export the raw
   data. Either gives a file of a megabyte or two; this reduces it to a few
   hundred coordinate pairs.
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var file = process.argv[2];
var WRITE = process.argv.indexOf("--write") >= 0;
if (!file) {
  console.error("usage: node tools/build-ring.js <overpass.json> [--write]");
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

var data = JSON.parse(fs.readFileSync(file, "utf8"));
var raw = (data.elements || []).reduce(function (n, el) {
  return n + ((el.members || []).reduce(function (m, w) {
    return m + ((w.geometry || []).length);
  }, 0)) + ((el.geometry || []).length);
}, 0);

var ring;
try {
  ring = G.ringShape(data, "M25");
} catch (err) {
  console.error("could not build a ring from that file: " + err.message);
  process.exit(1);
}

var edge = ring.shape.coordinates[0];
console.log("\nread          " + raw + " points from " + path.basename(file));
console.log("stitched      " + (ring.traced ? "into a loop" : "NOT into a loop — this is a hull, not the road"));
console.log("closed        " + (ring.closedByHand ? "by hand, across a gap" : "by the road itself"));
console.log("kept          " + edge.length + " points");
console.log("encloses      " + Math.round(ring.areaKm2) + " km²   (the M25 holds about 2,200)");

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

var sound = ring.traced && !ring.closedByHand && !wrong.length &&
            ring.areaKm2 > 1900 && ring.areaKm2 < 2600;
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
