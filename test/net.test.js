/* ============================================================================
   What the page asks the network for, and how often.

   Two complaints drove these: tracing the M25 took far too long, and finding
   the nearby cities took longer still. Both were the shape of the requests
   rather than the speed of the services, so both are testable here without
   one.  — run with:  node test/net.test.js
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var assert = require("assert");

var passed = 0, failed = 0, queue = Promise.resolve();
/* Headings are queued like the tests. Printed directly they all appeared
   first, before a single asynchronous test had run. */
function section(name) {
  queue = queue.then(function () { console.log("\n" + name); });
}
function test(name, fn) {
  queue = queue.then(function () {
    return Promise.resolve().then(fn).then(
      function () { passed++; console.log("  ok   " + name); },
      function (err) { failed++; console.log("  FAIL " + name + "\n       " + err.message); }
    );
  });
}

/* A browser with a memory, a clock and a network we can watch. */
function browser(handler) {
  var box = {};
  var sandbox = {
    window: {},
    document: { readyState: "complete", getElementById: function () { return null; },
                addEventListener: function () {} },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(box, k) ? box[k] : null; },
      setItem: function (k, v) { box[k] = String(v); },
      removeItem: function (k) { delete box[k]; }
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout, console: console,
    calls: []
  };
  sandbox.fetch = function (url, opts) {
    sandbox.calls.push({ url: String(url), at: Date.now() });
    return Promise.resolve(handler(String(url), opts));
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8"), sandbox);
  sandbox.store = box;
  return sandbox;
}

function reply(body) {
  return { ok: true, status: 200, json: function () { return Promise.resolve(body); },
           text: function () { return Promise.resolve(JSON.stringify(body)); } };
}

/* A square ring road, enough to trace. */
function ringReply() {
  var loop = [[51.7, -0.5], [51.7, 0.2], [51.3, 0.2], [51.3, -0.5], [51.7, -0.5]];
  var dense = [];
  for (var i = 0; i < loop.length - 1; i++) {
    for (var k = 0; k < 40; k++) {
      var a = loop[i], b = loop[i + 1], t = k / 40;
      dense.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t });
    }
  }
  dense.push({ lat: 51.7, lon: -0.5 });
  return { elements: [{ type: "relation", members: [{ type: "way", geometry: dense }] }] };
}

section("What is asked of the network");

test("the ring is asked for by bounding box, not by radius", function () {
  var b = browser(function () { return reply(ringReply()); });
  return b.window.QasrEngine.ringBoundary(["M25", "A282"], { lat: 51.5, lon: -0.12 })
    .then(function (ring) {
      assert.strictEqual(ring.traced, true);
      var url = decodeURIComponent(b.calls[0].url);
      assert.ok(/\[bbox:/.test(url), "no bounding box in the query:\n" + url);
      assert.ok(!/around:/.test(url), "still asking by radius, which is what was slow");
      assert.ok(/out skel geom/.test(url), "tags are still being fetched with the geometry");
      assert.ok(/"M25"/.test(url) && /"A282"/.test(url), "both roads must be asked for");
    });
});

test("a traced road is fetched once and remembered", function () {
  var b = browser(function () { return reply(ringReply()); });
  var near = { lat: 51.5, lon: -0.12 };
  return b.window.QasrEngine.ringBoundary(["M25"], near)
    .then(function () {
      assert.strictEqual(b.calls.length, 1, "the first trace should fetch");
      return b.window.QasrEngine.ringBoundary(["M25"], near);
    })
    .then(function (again) {
      assert.strictEqual(b.calls.length, 1,
        "the second trace fetched again — the road was not remembered");
      assert.strictEqual(again.traced, true);
      assert.ok(again.shape.coordinates[0].length > 3, "the remembered ring is unusable");
    });
});

test("what is remembered is small enough to be worth remembering", function () {
  var b = browser(function () { return reply(ringReply()); });
  return b.window.QasrEngine.ringBoundary(["M25"], { lat: 51.5, lon: -0.12 })
    .then(function () {
      var keys = Object.keys(b.store);
      assert.strictEqual(keys.length, 1, "expected one stored road, got " + keys.length);
      assert.ok(b.store[keys[0]].length < 400000,
        "stored " + b.store[keys[0]].length + " bytes — too much for a browser to hold");
      /* Coordinates rounded to five decimals: no seven-decimal tails. */
      assert.ok(!/\d\.\d{7}/.test(b.store[keys[0]]), "coordinates were not rounded");
    });
});

test("the nearby-city search does not wait for the address lookups", function () {
  var started = {};
  var b = browser(function (url) {
    started[/overpass/.test(url) ? "overpass" : "nominatim"] =
      started[/overpass/.test(url) ? "overpass" : "nominatim"] || Date.now();
    if (/overpass/.test(url)) {
      return reply({ elements: [{ type: "node", lat: 51.50, lon: -0.12,
        tags: { name: "London", place: "city", population: "8900000" } }] });
    }
    return reply(/reverse/.test(url)
      ? { address: { town: "Watford", county: "Hertfordshire" }, addresstype: "town",
          place_rank: 16, geojson: { type: "Polygon",
            coordinates: [[[-0.45, 51.62], [-0.35, 51.62], [-0.35, 51.68], [-0.45, 51.68], [-0.45, 51.62]]] } }
      : [{ address: { city: "London" }, place_rank: 12, geojson: { type: "Polygon",
            coordinates: [[[-0.5, 51.3], [0.2, 51.3], [0.2, 51.7], [-0.5, 51.7], [-0.5, 51.3]]] } }]);
  });
  var t0 = Date.now();
  var seen = 0;
  return b.window.QasrEngine.cityChoices({ lat: 51.63, lon: -0.39 }, function () { seen++; })
    .then(function (found) {
      assert.ok(found.length >= 1, "no cities found at all");
      /* The address queue paces itself at 1.1 s. If Overpass were behind it,
         it could not have started in the first second.                       */
      assert.ok(started.overpass - t0 < 1000,
        "the nearby search waited " + (started.overpass - t0) + " ms behind the address queue");
      assert.ok(seen >= 1, "nothing was reported until the very end");
    });
});

/* --- the M25 taken as London's edge, without being asked ------------------ */
section("The ring road, adopted automatically");

/* A square standing in for the M25, and a reverse-geocode that would call
   every one of these places something else. */
function londonWorld() {
  return browser(function (url) {
    if (/overpass/.test(url)) {
      var loop = [[51.72, -0.55], [51.72, 0.28], [51.26, 0.28], [51.26, -0.55], [51.72, -0.55]];
      var dense = [];
      for (var i = 0; i < loop.length - 1; i++) {
        for (var k = 0; k < 40; k++) {
          var a = loop[i], b = loop[i + 1], t = k / 40;
          dense.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t });
        }
      }
      dense.push({ lat: 51.72, lon: -0.55 });
      return reply({ elements: [{ type: "relation", members: [{ type: "way", geometry: dense }] }] });
    }
    return reply({ address: { town: "Watford", county: "Hertfordshire" },
                   addresstype: "town", place_rank: 16, geojson: null });
  });
}

test("an address inside the ring is in London, whatever it is called", function () {
  var b = londonWorld();
  /* WD19 4QP, which the address service calls Watford. */
  return b.window.QasrEngine.cityWithRing({ lat: 51.6238, lon: -0.3892 }, false)
    .then(function (city) {
      assert.strictEqual(city.name, "London", "expected London, got " + city.name);
      assert.strictEqual(city.fromRing, "M25 and A282");
      assert.ok(city.shape, "the ring must come with the shape to measure against");
      assert.strictEqual(city.ringAuto, true, "it should be marked as taken automatically");
    });
});

test("an address near the ring but outside it keeps its own city", function () {
  var b = londonWorld();
  /* Inside the box that gates the lookup, outside the ring itself. */
  return b.window.QasrEngine.cityWithRing({ lat: 51.76, lon: -0.30 }, false)
    .then(function (city) {
      assert.notStrictEqual(city.name, "London", "outside the ring is not inside London");
      assert.ok(!city.fromRing, "no ring should be adopted for it");
    });
});

test("an address far from any ring road costs no request at all", function () {
  var b = londonWorld();
  /* Manchester: outside the box, so the motorway is never fetched. */
  return b.window.QasrEngine.cityWithRing({ lat: 53.4808, lon: -2.2426 }, false)
    .then(function () {
      var traced = b.calls.filter(function (c) { return /overpass/.test(c.url); });
      assert.strictEqual(traced.length, 0,
        "the ring road was fetched for a place nowhere near it");
    });
});

test("the box round the ring is checked before the road is", function () {
  var G = londonWorld().window.QasrEngine;
  assert.ok(G.ringRoadNear({ lat: 51.5, lon: -0.12 }), "central London is in the box");
  assert.ok(G.ringRoadNear({ lat: 51.6238, lon: -0.3892 }), "WD19 4QP is in the box");
  assert.strictEqual(G.ringRoadNear({ lat: 53.48, lon: -2.24 }), null, "Manchester is not");
  assert.strictEqual(G.ringRoadNear({ lat: 52.3793, lon: -1.5615 }), null, "Warwick is not");
  assert.strictEqual(G.ringRoadNear(null), null);
  assert.strictEqual(G.ringRoadNear({ lat: "51.5", lon: -0.12 }), null, "a string is not a latitude");
});

test("a ring road that will not trace falls back to the published city", function () {
  var b = browser(function (url) {
    if (/overpass/.test(url)) return { ok: false, status: 504,
      json: function () { return Promise.resolve({}); } };
    return reply({ address: { town: "Watford", county: "Hertfordshire" },
                   addresstype: "town", place_rank: 16, geojson: null });
  });
  return b.window.QasrEngine.cityWithRing({ lat: 51.6238, lon: -0.3892 }, false)
    .then(function (city) {
      assert.strictEqual(city.name, "Watford", "the fallback must still name a city");
    });
});

/* The whole sequence, in the order it happens: an address arrives, the box
   says a ring road is worth looking for, the road is traced, the address is
   found to be inside it, that becomes the city border, and the map frames the
   ring. Each step has its own test above or in map.test.js; this one is here
   so that the sequence itself cannot quietly come apart. */
test("address, box, trace, inside, border, drawn — the whole way through", function () {
  var b = londonWorld();
  var G = b.window.QasrEngine;
  var here = { lat: 51.6238, lon: -0.3892 };          /* WD19 4QP */

  var step = G.ringRoadNear(here);
  assert.ok(step, "1. the box did not recognise the address as near a ring road");
  assert.strictEqual(step.city, "London");

  return G.ringBoundary(step.refs, here).then(function (ring) {
    assert.strictEqual(ring.traced, true, "2. the road was not traced");
    assert.strictEqual(G.inShape(here.lat, here.lon, ring.shape), true,
      "3. the address was not found inside the road");

    return G.cityWithRing(here, false).then(function (city) {
      assert.strictEqual(city.name, "London", "4. the border did not become London");
      assert.ok(city.shape, "4. the border came without a shape to measure against");
      assert.strictEqual(city.fromRing, "M25 and A282");

      var box = G.journeyBox(here, null, null, city.shape);
      assert.ok(box[0] <= 51.26 && box[2] >= 51.72 && box[1] <= -0.55 && box[3] >= 0.28,
        "5. the ring was drawn but framed off the edge of the map");
    });
  });
});

queue.then(function () {
  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed ? 1 : 0);
});
