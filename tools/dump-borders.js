/* ============================================================================
   What the page would actually draw for each city in the sweep list, written
   out with its geometry so that tools/compare-borders.py can measure it
   against an official one.

     node tools/dump-borders.js [--country "United Kingdom"] [--out FILE]

   Kept separate from sweep-cities.js because the two answer different
   questions and the shapes are far too large to keep in the record: the sweep
   asks "does this look like a city", which needs only an area and a centre,
   and this asks "is it the right city", which needs every vertex.

   The output is written to tools/drawn-borders.json, which is not committed —
   it is tens of megabytes and reproducible in a few minutes.
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var UA = "qasrcalc-sweep/1.0 (+https://github.com/HusaynYahya/QasrCalc)";
var GAP_MS = 1500;

function arg(name, fallback) {
  var i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

var ROOT = path.join(__dirname, "..");
var OUT = arg("--out", path.join(__dirname, "drawn-borders.json"));
var ONLY = arg("--country", null);

/* The page, with just enough of a browser round it. urban-areas.json is
   served off disk: the page fetches it by relative path, which has no meaning
   outside a browser. */
function engine() {
  var sandbox = {
    window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: { readyState: "complete", getElementById: function () { return null; },
                addEventListener: function () {} },
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    fetch: function (url, opts) {
      url = String(url);
      if (/^urban-areas\.json/.test(url)) {
        return Promise.resolve({ ok: true, json: function () {
          return Promise.resolve(JSON.parse(
            fs.readFileSync(path.join(ROOT, "urban-areas.json"), "utf8")));
        } });
      }
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { "User-Agent": UA });
      return global.fetch(url, opts);
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "qasr.js"), "utf8"), sandbox);
  return sandbox.window.QasrEngine;
}

var G = engine();
var CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, "sweep-cities.json"), "utf8"))
  .filter(function (c) { return !ONLY || c.country === ONLY; });

(async function () {
  var out = [];
  for (var i = 0; i < CITIES.length; i++) {
    var c = CITIES[i], place = { lat: c.lat, lon: c.lon };
    var row = { asked: c.asked, country: c.country || null, lat: c.lat, lon: c.lon };
    try {
      var city = await G.cityWithRing(place, false);
      row.got = city.name || null;
      row.fromRing = city.fromRing || null;
      row.fromUrban = city.fromUrban || null;
      row.insteadOf = city.insteadOf || null;
      row.shape = city.shape || null;
    } catch (err) {
      row.error = String((err && err.message) || err);
      row.shape = null;
    }
    out.push(row);
    console.log(c.asked + " -> " + (row.got || "—") + (row.shape ? "" : "  (no border)"));
    await new Promise(function (go) { setTimeout(go, GAP_MS); });
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("\nwritten to " + OUT);
})();
