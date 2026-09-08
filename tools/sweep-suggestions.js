/* ============================================================================
   Ask the suggestion list what it offers for a city's name.

     node tools/sweep-suggestions.js

   Typing a city's name can bring back the same line several times over, because
   the label is built from the name and the places around it and several
   different objects of that name have nothing else to tell them apart. Four
   rows reading "Dubai, United Arab Emirates" is not a choice, it is a coin
   toss — and one of those four was a node mis-tagged as a state out at Hatta,
   a hundred and thirty kilometres from the city.

   This runs the page's own photonLabel, suggestRank and oneOfEachLabel over a
   list of cities and reports every line that appeared twice, with how far
   apart the answers actually were. The distance is the point: two rows a
   kilometre apart are untidy, two rows three hundred kilometres apart are a
   wrong journey.

   The run of 8 September 2026 found 41 of 64 cities offering at least one
   line twice, and nine of those groups twenty kilometres or more apart — New
   York worst at 311 km, the city against New York State's centroid.

   Needs the network. Not part of npm test: the search is a public service and
   a rate limit should not fail a build.
   ========================================================================== */
"use strict";
var fs = require("fs"), path = require("path");
var vm = require("vm");

/* The page's own functions, run as the page runs them. */
var sb = { window: {}, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: { readyState: "complete", getElementById: function () { return null; },
              addEventListener: function () {} },
  localStorage: { getItem: function () { return null; }, setItem: function () {} },
  fetch: function () { return Promise.reject(new Error("not wanted here")); } };
sb.globalThis = sb; vm.createContext(sb);
vm.runInContext(fs.readFileSync("/home/user/qasrcalc/qasr.js", "utf8"), sb);
var G = sb.window.QasrEngine;
var photonLabel = G.photonLabel, suggestRank = G.suggestRank, oneOfEachLabel = G.oneOfEachLabel;

function km(a, b) {
  var R = 6371.0088, r = Math.PI / 180;
  var dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  var s = Math.sin(dLat/2)*Math.sin(dLat/2) +
          Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

var CITIES = ["London","Birmingham","Manchester","Glasgow","Dublin","Paris","Berlin","Madrid",
  "Rome","Istanbul","Moscow","Cairo","Riyadh","Jeddah","Doha","Kuwait City","Dubai","Abu Dhabi",
  "Sharjah","Baghdad","Karbala","Najaf","Tehran","Mashhad","Qom","Karachi","Lahore","Mumbai",
  "Delhi","Hyderabad","Dhaka","Kuala Lumpur","Singapore","Jakarta","Sydney","Melbourne","Perth",
  "Auckland","Toronto","Montreal","Vancouver","New York","Chicago","Los Angeles","Houston",
  "Detroit","Lagos","Nairobi","Johannesburg","Sao Paulo","Tokyo","Damascus","Beirut","Amman",
  "Muscat","Manama","Isfahan","Shiraz","Basra","Kufa","Kadhimiya","Samarra","Watford","Cambridge"];

var out = [];
(async function () {
  for (var i = 0; i < CITIES.length; i++) {
    var q = CITIES[i];
    var url = "https://photon.komoot.io/api/?limit=8&lang=en&q=" + encodeURIComponent(q);
    var rec = { asked: q };
    try {
      var res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) { rec.error = "HTTP " + res.status; out.push(rec); console.log(q, rec.error);
                     await new Promise(g => setTimeout(g, 2000)); continue; }
      var data = await res.json();
      var rows = (data.features || []).map(function (f) {
        var p = f.properties || {};
        return { label: photonLabel(p), rank: suggestRank(p),
                 lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
                 what: (p.osm_key || "") + ":" + (p.osm_value || "") };
      }).filter(function (p) { return p.label; });

      var kept = oneOfEachLabel(rows);
      rec.before = rows.length;
      rec.after = kept.length;

      /* Every label that appeared more than once, and how far the ones that
         lost were from the one that won. */
      rec.groups = [];
      var by = {};
      rows.forEach(function (r) { (by[r.label] = by[r.label] || []).push(r); });
      Object.keys(by).forEach(function (l) {
        if (by[l].length < 2) return;
        var win = kept.filter(function (k) { return k.label === l; })[0];
        rec.groups.push({
          label: l, n: by[l].length,
          keptWhat: win.what,
          worst: Math.max.apply(null, by[l].map(function (r) {
            return km([win.lat, win.lon], [r.lat, r.lon]); })),
          dropped: by[l].filter(function (r) { return r !== win; })
                        .map(function (r) { return r.what + " " + km([win.lat,win.lon],[r.lat,r.lon]).toFixed(0) + "km"; })
        });
      });
    } catch (e) { rec.error = String(e.message || e); }
    out.push(rec);
    var worst = (rec.groups || []).reduce(function (n, g) { return Math.max(n, g.worst); }, 0);
    console.log((q + "                    ").slice(0, 15) +
      (rec.error ? rec.error
       : rec.before + " → " + rec.after +
         ((rec.groups || []).length ? "   duplicates, worst " + worst.toFixed(0) + " km apart" : "")));
    await new Promise(g => setTimeout(g, 1100));
  }
  fs.writeFileSync(path.join(__dirname, "sweep-suggestions.json"),
                   JSON.stringify(out, null, 1));
  console.log("\nwritten");
})();
