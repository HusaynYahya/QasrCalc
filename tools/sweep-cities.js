/* ============================================================================
   Ask the page what it thinks a city's border is, for a list of cities at
   once, and report which answers are doubtful.

     node tools/sweep-cities.js [--out cities.json]

   London, Greater Toronto and Dubai are drawn by hand and checked by tests.
   Every other city is resolved live, at the moment a reader types an address,
   from whatever polygon OpenStreetMap publishes under the name — so the tests
   prove three cities and nothing else, and there is no way to know the rest
   are right without going and asking.

   This asks. It runs the page's own cityWithRing over a list of cities, each
   with a point a resident would call "in town", and reports what came back
   and whether the page would have doubted it. It cannot prove a border is
   where a resident would draw it; nothing but a resident can. What it does is
   turn "the others are probably fine" into a list that can be read, and catch
   the day OpenStreetMap's answer for a city changes underneath the page.

   It is not part of npm test, and should not be: it needs the network, it
   takes several minutes, and a rate limit would fail the build for no fault
   of the code. Run it by hand, and read it.

   tools/sweep-cities.json is the run of 8 September 2026, kept so the list can
   be read without waiting for the network and so the next run has something to
   differ from. It is a record, not a fixture: nothing asserts against it.

   Nominatim allows one request a second and refuses a default User-Agent, so
   this waits its turn and names itself. Running it twice in quick succession
   will earn 403s and a page of nonsense; leave a few minutes between runs.

   Read the reasons, not just the verdicts. A run that has been rate-limited
   reports "no border published" for city after city, which looks exactly like
   a finding and is not one — the reason beside it says the service refused
   the request. If cities that resolved on an earlier run stop resolving
   halfway down, that is the rate limit, not the map.
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var UA = "qasrcalc-sweep/1.0 (+https://github.com/HusaynYahya/QasrCalc)";

/* Between cities, and after being refused. The second is long on purpose: a
   refusal means the service wants to be left alone, and asking again a second
   later is how a run turns into a page of false findings. */
var GAP_MS = 1200;
var BACKOFF_MS = 30000;

var retries = Object.create(null);

/* The list lives in sweep-cities.json, beside the run it produced, so that
   the cities asked about and the answers recorded can never drift apart —
   which they had: the list here still held the fifty cities of the first
   sweep long after the file beside it had been rewritten for the diaspora. */
var RECORD = path.join(__dirname, "sweep-cities.json");
var CITIES = JSON.parse(fs.readFileSync(RECORD, "utf8")).map(function (c) {
  var one = [c.asked, c.lat, c.lon];
  one.country = c.country || null;
  return one;
});

/* The page, with just enough of a browser round it — the same stubs the
   tests use, and a fetch that names itself. */
function engine() {
  var sandbox = {
    window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: { readyState: "complete", getElementById: function () { return null; },
                addEventListener: function () {} },
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    fetch: function (url, opts) {
      url = String(url);
      /* Served off disk: the page fetches it by relative path, which has no
         meaning outside a browser. Without this the sweep ran with no
         built-up areas at all and reported city after city as having no
         border while the answers sat in the repository. */
      if (/^urban-areas\.json/.test(url)) {
        return Promise.resolve({ ok: true, json: function () {
          return Promise.resolve(JSON.parse(
            fs.readFileSync(path.join(__dirname, "..", "urban-areas.json"), "utf8")));
        } });
      }
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { "User-Agent": UA });
      return global.fetch(url, opts);
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8"), sandbox);
  return sandbox.window.QasrEngine;
}

var G = engine();

function outerRings(shape) {
  return !shape ? []
    : shape.type === "Polygon" ? [shape.coordinates[0]]
    : shape.type === "MultiPolygon" ? shape.coordinates.map(function (p) { return p[0]; })
    : [];
}
function areaKm2(shape) {
  return outerRings(shape).reduce(function (n, r) { return n + G.ringAreaKm2(r); }, 0);
}
/* How far the border reaches at its widest. Area alone misses a boundary
   stretched forty kilometres down a valley to take in one outlying village,
   which is exactly the shape of the Melbourne fault. */
function spanKm(shape) {
  var rings = outerRings(shape);
  if (!rings.length) return null;
  var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  rings.forEach(function (r) {
    r.forEach(function (c) {
      lo[0] = Math.min(lo[0], c[0]); lo[1] = Math.min(lo[1], c[1]);
      hi[0] = Math.max(hi[0], c[0]); hi[1] = Math.max(hi[1], c[1]);
    });
  });
  return Math.max(
    G.haversineKm({ lat: lo[1], lon: lo[0] }, { lat: lo[1], lon: hi[0] }),
    G.haversineKm({ lat: lo[1], lon: lo[0] }, { lat: hi[1], lon: lo[0] })
  );
}

function verdict(r) {
  /* Before anything else, because a refusal masquerades as every other
     answer: no name, no border, nothing to measure. */
  if (wasRefused(r)) return "REFUSED by the address service — not a finding";
  if (r.error) return "asking failed: " + r.error;
  if (r.ring) return "drawn by hand (" + r.ring + ")";
  if (r.urban) return "the official built-up area (" + r.shapeKm2 + " km\u00b2)" +
    (r.regionKm2 ? ", in place of " + r.regionKm2 + " km\u00b2 of administrative boundary" : "");
  if (!r.hasShape) return "no border published" + (r.why ? " — " + r.why : "");
  /* What the reader is actually told comes first. An earlier draft of this
     tool tested the area before the guards and reported Glasgow as having no
     border at all, because its border rounds to nought square kilometres and
     nought is falsy — hiding the fact that the page does warn about it. */
  if (r.insteadOf) return "the city around " + r.insteadOf + " (" + r.insteadOfKm2 +
    " km\u00b2) was taken instead";
  if (r.tooBig) return "TOO BIG, reader warned";
  if (r.tooSmall) return "TOO SMALL, reader warned" +
    (r.holdsCentre === false ? " (and it does not contain its own centre)" : "");
  if (r.holdsCentre === false) return "WRONG: its own centre falls outside it";
  if (r.shapeKm2 < 1) return "a border enclosing under a square kilometre";
  if (r.spanKm > 60) return "reaches " + Math.round(r.spanKm) + " km across — look at it";
  return "nothing obviously wrong";
}

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

/* The service's own words when it is refusing, so a refusal can be told from
   an answer. Matched on the page's message rather than a status code because
   that is all that reaches here — cityAt turns the response into a reason. */
function wasRefused(r) {
  return /refusing requests|returned 4\d\d|returned 5\d\d/.test((r.why || r.error || ""));
}

var out = [];
(async function () {
  for (var i = 0; i < CITIES.length; i++) {
    var c = CITIES[i], asked = c[0], place = { lat: c[1], lon: c[2] };
    var r = { asked: asked, country: c.country || null, lat: c[1], lon: c[2] };
    try {
      var city = await G.cityWithRing(place, false);
      r.got = city.name || null;
      r.hasShape = !!city.shape;
      r.ring = city.fromRing || null;
      r.urban = city.fromUrban || null;
      r.urbanSource = city.urbanSource || null;
      r.regionKm2 = city.regionKm2 || null;
      r.rank = typeof city.rank === "number" ? city.rank : null;
      r.kind = city.kind || null;
      r.shapeKm2 = city.shape ? Math.round(areaKm2(city.shape)) : null;
      r.spanKm = city.shape ? Math.round(spanKm(city.shape)) : null;
      r.holdsCentre = city.shape ? G.inShape(c[1], c[2], city.shape) : null;
      r.tooBig = G.cityTooBig(city);
      r.tooSmall = G.cityTooSmall(city);
      r.insteadOf = city.insteadOf || null;
      r.insteadOfKm2 = city.insteadOfKm2 == null ? null : city.insteadOfKm2;
      if (!city.shape) r.why = city.reason || null;
    } catch (err) {
      r.error = String((err && err.message) || err);
    }
    r.verdict = verdict(r);

    /* A refusal is not a finding, and recording it as one is worse than
       stopping: a rate-limited run reports city after city as having no
       border, which reads exactly like a gap in the map. Wait properly and
       ask again; say so on the way, so a slow run is not a mysterious one. */
    if (wasRefused(r) && !r.retried) {
      console.log(pad(asked, 15) + "refused — waiting " + (BACKOFF_MS / 1000) +
                  "s and asking again");
      await new Promise(function (go) { setTimeout(go, BACKOFF_MS); });
      i--;                    /* the same city, once more */
      CITIES[i].retried = true;
      retries[asked] = true;
      continue;
    }
    if (retries[asked]) r.retried = true;

    out.push(r);
    console.log(pad(asked, 15) + pad(r.got || "—", 22) +
                pad(r.shapeKm2 == null ? "—" : r.shapeKm2 + " km²", 12) + r.verdict);
    /* Nominatim's terms: one request a second. The page's own queue paces
       itself, but a fresh city starts a fresh chain of lookups. */
    await new Promise(function (go) { setTimeout(go, GAP_MS); });
  }

  var doubted = out.filter(function (r) { return r.tooBig || r.tooSmall || r.holdsCentre === false; });
  var quiet = out.filter(function (r) { return r.verdict === "nothing obviously wrong"; });
  console.log("\n" + out.length + " asked · " +
              out.filter(function (r) { return r.ring; }).length + " drawn by hand · " +
              quiet.length + " nothing obviously wrong · " +
              doubted.length + " doubted and said so · " +
              out.filter(function (r) { return !r.error && !r.hasShape && !wasRefused(r); }).length +
              " no border" +
              (out.filter(wasRefused).length
                ? " · " + out.filter(wasRefused).length + " REFUSED (rerun those; not findings)"
                : ""));
  console.log("\n\"Nothing obviously wrong\" means the centre falls inside and the area is\n" +
              "plausible. It does not mean the border is where a resident would put it.");

  var where = process.argv.indexOf("--out");
  if (where > -1 && process.argv[where + 1]) {
    fs.writeFileSync(process.argv[where + 1], JSON.stringify(out, null, 1) + "\n");
    console.log("\nwritten to " + process.argv[where + 1]);
  }
})();
