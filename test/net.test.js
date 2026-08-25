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

console.log("\nWhat is asked of the network");

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

queue.then(function () {
  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed ? 1 : 0);
});
