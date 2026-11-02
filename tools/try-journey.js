/* ============================================================================
   Run one journey through the page's own pipeline and print every number it
   turned on, so an answer can be argued with rather than taken.

     node tools/try-journey.js --from 53.8008,-1.5491 --to 53.3811,-1.4701
     node tools/try-journey.js --json journeys.json

   This is the page, not an imitation of it: the same cityWithRing, the same
   routing service, the same borderExitKm, the same Fiqh.evaluate. What it
   adds is the arithmetic written out — road distance, what was deducted and
   to which border, what was counted, and how that sits against eight farsakh
   — because a verdict on its own cannot be checked.

   A journey in --json may carry `expect` ("qasr", "tamam", "jam", or a
   verdict name) and `why`; the run then says whether the page agrees. It is
   not part of npm test: it needs the network, the address service allows one
   request a second, and a refusal is not a failing test.
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var UA = "qasrcalc-journeys/1.0 (+https://github.com/HusaynYahya/QasrCalc)";
var ROOT = path.join(__dirname, "..");
var GAP_MS = 1500;

function arg(name, fallback) {
  var i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/* The page, with just enough of a browser round it. The border files are
   served off disk — the page fetches them by relative path, which means
   nothing outside a browser, and a shard fetched from the network instead
   comes back empty and is indistinguishable from a city with no border. */
function engine() {
  var box = {};
  var sandbox = {
    window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    document: { readyState: "complete", getElementById: function () { return null; },
                addEventListener: function () {}, querySelector: function () { return null; },
                querySelectorAll: function () { return []; },
                documentElement: { setAttribute: function () {} } },
    localStorage: { getItem: function (k) { return box[k] == null ? null : box[k]; },
                    setItem: function (k, v) { box[k] = String(v); },
                    removeItem: function (k) { delete box[k]; } },
    fetch: function (url, opts) {
      url = String(url);
      if (/^urban-areas(\.json|\/)/.test(url)) {
        var onDisk = path.join(ROOT, url.split("?")[0]);
        if (!fs.existsSync(onDisk)) {
          return Promise.resolve({ ok: false, status: 404,
            json: function () { return Promise.resolve({}); } });
        }
        return Promise.resolve({ ok: true, json: function () {
          return Promise.resolve(JSON.parse(fs.readFileSync(onDisk, "utf8")));
        } });
      }
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { "User-Agent": UA });
      return global.fetch(url, opts);
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "fiqh.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "qasr.js"), "utf8"), sandbox);
  return { G: sandbox.window.QasrEngine, F: sandbox.window.Fiqh, fetch: sandbox.fetch };
}

var E = engine(), G = E.G, F = E.F;
var OSRM = "https://router.project-osrm.org/route/v1/driving/";

function place(s) {
  var p = String(s).split(",");
  return { lat: parseFloat(p[0]), lon: parseFloat(p[1]) };
}

/* Every route the service offers, because the law counts the road actually
   taken and a longer way round can carry a journey past the limit that the
   direct road misses. The quickest is reported; the longest is noted. */
function routes(a, b) {
  var url = OSRM + a.lon + "," + a.lat + ";" + b.lon + "," + b.lat +
            "?overview=full&geometries=geojson&alternatives=3";
  return E.fetch(url).then(function (r) {
    if (!r.ok) throw new Error("the router returned " + r.status);
    return r.json();
  }).then(function (d) {
    if (d.code !== "Ok" || !d.routes || !d.routes.length) {
      throw new Error("no road route: " + d.code);
    }
    return d.routes.map(function (r) {
      return { km: r.distance / 1000,
               line: (r.geometry.coordinates || []).map(function (c) {
                 return [c[1], c[0]];
               }) };
    });
  });
}

function polylineKm(line) {
  var n = 0;
  for (var i = 1; i < line.length; i++) {
    n += G.haversineKm({ lat: line[i - 1][0], lon: line[i - 1][1] },
                       { lat: line[i][0], lon: line[i][1] });
  }
  return n;
}

function one(j) {
  var from = place(j.from), to = place(j.to);
  var out = { name: j.name || (j.from + " -> " + j.to), expect: j.expect, why: j.why };

  return G.cityWithRing(from, false).then(function (city) {
    out.city = city.name;
    /* Every outer ring, not the first. Birmingham came out as 0 km2 because
       its first ring is a sliver; the number is only printed, but a printed
       number that is wrong is worse than none. */
    out.cityKm2 = city.shape ? Math.round(
      (city.shape.type === "Polygon" ? [city.shape.coordinates[0]]
        : city.shape.coordinates.map(function (p) { return p[0]; }))
        .reduce(function (n, r) { return n + G.ringAreaKm2(r); }, 0)) : null;
    out.cityFrom = city.fromRing || city.fromUrban || "OpenStreetMap";
    out.startInsideCity = city.shape ? G.inShape(from.lat, from.lon, city.shape) : null;

    return G.cityWithRing(to, false).then(function (dest) {
      out.dest = dest.name;
      out.bothInSameCity = !!(city.shape && G.inShape(to.lat, to.lon, city.shape));

      return routes(from, to).then(function (rs) {
        var r = rs[0];
        out.roadKm = +r.km.toFixed(1);
        out.longestKm = +Math.max.apply(null, rs.map(function (x) { return x.km; })).toFixed(1);

        var poly = polylineKm(r.line);
        var exit = city.shape
          ? G.borderExitKm(r.line, city.shape, poly > 0 ? r.km / poly : 1)
          : null;
        out.deducted = exit === null ? 0 : +exit.toFixed(1);
        out.deductedTo = exit === null ? "nothing — no border crossing found" : out.cityFrom;
        out.counted = +(r.km - out.deducted).toFixed(1);
        out.limitKm = F.THRESHOLD_KM;
        out.overTheLimit = out.counted >= F.THRESHOLD_KM;

        var leg = Math.max(0, r.km - out.deducted);
        var trip = {
          person: { kathirRulingApplies: false },
          journey: { intendedFromOutset: true, purpose: { kind: "lawful" } },
          breakers: { destinationIsWatan: false },
          residence: { atDestination: true, intendsTenDays: j.tenDays === true },
          legs: { outboundKm: leg, returnKm: leg,
                  returning: j.returning === undefined ? false : j.returning,
                  departingFromWatan: true,
                  staysInCity: out.bothInSameCity, oneCityInDoubt: false }
        };
        var v = F.evaluate(trip);
        out.verdict = v.verdict;
        out.segments = (v.segments || []).map(function (sg) {
          return sg.name + "=" + sg.verdict;
        }).join(" ");
        /* outcomes is keyed by condition number, not a list, and the
           citations live under `citations`. Reading it as an array threw on
           every journey — which is the harness being wrong, not the page. */
        out.because = [];
        (v.segments || []).forEach(function (sg) {
          Object.keys(sg.outcomes || {}).forEach(function (n) {
            var o = sg.outcomes[n];
            if (!o || o.verdict !== sg.verdict) return;      /* what decided it */
            out.because.push(sg.name + " c" + n + " " +
              "[" + (o.citations || []).join(", ") + "] " + (o.reasoning || ""));
          });
        });
        out.because = out.because.slice(0, 4);
        if (j.expect) {
          out.agrees = String(out.verdict).toUpperCase()
                          .indexOf(String(j.expect).toUpperCase()) === 0;
        }
        return out;
      });
    });
  }).catch(function (err) {
    out.error = String((err && err.message) || err);
    return out;
  });
}

function show(o) {
  console.log("\n" + o.name);
  if (o.error) { console.log("  FAILED: " + o.error); return; }
  console.log("  home city      " + o.city + "  " +
              (o.cityKm2 == null ? "(no border)" : o.cityKm2 + " km2") +
              "  [" + o.cityFrom + "]" +
              (o.startInsideCity === false ? "  START IS OUTSIDE IT" : ""));
  console.log("  destination    " + o.dest +
              (o.bothInSameCity ? "  — INSIDE the home city" : ""));
  console.log("  road           " + o.roadKm + " km" +
              (o.longestKm > o.roadKm ? "  (longest route offered " + o.longestKm + ")" : ""));
  console.log("  deducted       " + o.deducted + " km to " + o.deductedTo);
  console.log("  counted        " + o.counted + " km against " + o.limitKm +
              " — " + (o.overTheLimit ? "over" : "under"));
  console.log("  VERDICT        " + o.verdict + "   " + o.segments);
  (o.because || []).forEach(function (line, i) {
    console.log((i ? "                 " : "  because        ") + line);
  });
  if (o.expect) {
    console.log("  expected       " + o.expect + (o.why ? "  (" + o.why + ")" : "") +
                "  ->  " + (o.agrees ? "AGREES" : "*** DISAGREES ***"));
  }
}

var list = arg("--json")
  ? JSON.parse(fs.readFileSync(arg("--json"), "utf8"))
  : [{ from: arg("--from"), to: arg("--to"), name: arg("--name"),
       expect: arg("--expect"), returning: process.argv.indexOf("--return") > -1 }];

(async function () {
  var all = [];
  for (var i = 0; i < list.length; i++) {
    var o = await one(list[i]);
    show(o);
    all.push(o);
    await new Promise(function (go) { setTimeout(go, GAP_MS); });
  }
  var judged = all.filter(function (o) { return o.expect && !o.error; });
  var wrong = judged.filter(function (o) { return !o.agrees; });
  console.log("\n" + all.length + " journeys · " + judged.length + " with an expected answer · " +
              wrong.length + " disagreeing" +
              (all.filter(function (o) { return o.error; }).length
                ? " · " + all.filter(function (o) { return o.error; }).length + " failed to run"
                : ""));
  wrong.forEach(function (o) {
    console.log("  DISAGREES: " + o.name + " — page says " + o.verdict +
                ", expected " + o.expect);
  });
  var out = arg("--out");
  if (out) { fs.writeFileSync(out, JSON.stringify(all, null, 1) + "\n"); console.log("\nwritten to " + out); }
})();
