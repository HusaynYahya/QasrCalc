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

section("Which boundary is taken for a city");

/* Dubai, as the address service actually answers for it: a point at
   settlement rank, a municipality published more precisely than that, and the
   whole Emirate above both. */
function square(lat, lon, halfDeg) {
  return { type: "Polygon", coordinates: [[
    [lon - halfDeg, lat - halfDeg], [lon + halfDeg, lat - halfDeg],
    [lon + halfDeg, lat + halfDeg], [lon - halfDeg, lat + halfDeg],
    [lon - halfDeg, lat - halfDeg]
  ]] };
}
var DUBAI = { lat: 25.2048, lon: 55.2708 };

function dubaiNetwork(url) {
  if (/\/reverse/.test(url)) {
    /* The city is a point here: no boundary comes back from the reverse. */
    return reply({ display_name: "Dubai, Dubai Emirate, United Arab Emirates",
      lat: String(DUBAI.lat), lon: String(DUBAI.lon), addresstype: "city", place_rank: 16,
      address: { city: "Dubai", state: "Dubai Emirate", country: "United Arab Emirates" },
      geojson: { type: "Point", coordinates: [DUBAI.lon, DUBAI.lat] } });
  }
  if (/featureType=settlement/.test(url)) {
    /* The narrow question hides the municipality and offers the Emirate. */
    return reply([
      { place_rank: 16, category: "place", type: "city", display_name: "Dubai",
        address: { city: "Dubai", state: "Dubai Emirate" },
        geojson: { type: "Point", coordinates: [DUBAI.lon, DUBAI.lat] } },
      { place_rank: 8, category: "boundary", type: "administrative",
        display_name: "Dubai Emirate", address: { state: "Dubai Emirate" },
        geojson: square(DUBAI.lat, DUBAI.lon, 0.9) }
    ]);
  }
  /* The wide question carries the municipality, at a finer rank. */
  return reply([
    { place_rank: 25, category: "boundary", type: "administrative",
      display_name: "Dubai, Dubai Emirate, United Arab Emirates",
      address: { city: "Dubai", state: "Dubai Emirate" },
      geojson: square(DUBAI.lat, DUBAI.lon, 0.12) },
    { place_rank: 16, category: "place", type: "city", display_name: "Dubai",
      address: { city: "Dubai" },
      geojson: { type: "Point", coordinates: [DUBAI.lon, DUBAI.lat] } },
    { place_rank: 8, category: "boundary", type: "administrative",
      display_name: "Dubai Emirate", address: { state: "Dubai Emirate" },
      geojson: square(DUBAI.lat, DUBAI.lon, 0.9) }
  ]);
}

test("a city published finer than settlement rank is still found", function () {
  var b = browser(dubaiNetwork);
  var G = b.window.QasrEngine;
  return G.cityWithRing(DUBAI, false).then(function (city) {
    assert.strictEqual(city.name, "Dubai");
    assert.ok(city.shape, "no boundary was taken at all");
    var got = G.ringAreaKm2(city.shape.coordinates[0]);
    var emirate = G.ringAreaKm2(square(DUBAI.lat, DUBAI.lon, 0.9).coordinates[0]);
    assert.ok(got < emirate / 4,
      "the emirate was taken as the city — " + Math.round(got) + " km² against " +
      Math.round(emirate) + " for the region it sits in");
  });
});

test("a city of the same name on another continent is not taken", function () {
  /* Paris, Texas is published at settlement rank; Paris, France is not.
     Ranking before asking which one holds the reader handed somebody on the
     Ile de la Cite the boundary of Paris, Lamar County — and every point of
     central Paris then came out outside its own city. */
  var FR={lat:48.8566,lon:2.3522};
  function square(lat,lon,half){
    return {type:"Polygon",coordinates:[[[lon-half,lat-half],[lon+half,lat-half],
      [lon+half,lat+half],[lon-half,lat+half],[lon-half,lat-half]]]};
  }
  var b = browser(function (url) {
    if (/\/reverse/.test(url)) {
      return reply({ display_name:"Paris, France", lat:"48.8566", lon:"2.3522",
        addresstype:"city", place_rank:16,
        address:{ city:"Paris", country:"France" },
        geojson:{ type:"Point", coordinates:[2.3522,48.8566] } });
    }
    return reply([
      { place_rank:16, category:"boundary", type:"administrative",
        display_name:"Paris, Lamar County, Texas, United States",
        address:{ city:"Paris", state:"Texas" },
        geojson: square(33.6609,-95.5555,0.06) },
      { place_rank:15, category:"boundary", type:"administrative",
        display_name:"Paris, Ile-de-France, France",
        address:{ city:"Paris", country:"France" },
        geojson: square(48.8566,2.3522,0.05) }
    ]);
  });
  var G=b.window.QasrEngine;
  return G.cityWithRing(FR,false).then(function (city) {
    assert.ok(city.shape, "no boundary at all");
    assert.strictEqual(G.inShape(FR.lat,FR.lon,city.shape), true,
      "the reader came out outside their own city — the wrong Paris was taken");
    assert.strictEqual(G.inShape(33.6609,-95.5555,city.shape), false,
      "the Texan Paris was taken");
  });
});

test("the address service is asked in English", function () {
  var b = browser(dubaiNetwork);
  return b.window.QasrEngine.cityWithRing(DUBAI, false).then(function () {
    var asked = b.calls.filter(function (c) { return /nominatim/.test(c.url); });
    assert.ok(asked.length, "the address service was never asked");
    asked.forEach(function (c) {
      assert.ok(/accept-language=en/.test(c.url),
        "asked without a language, so a name comes back in the local script: " +
        c.url.slice(0, 90));
    });
  });
});

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

test("London needs no map server at all", function () {
  /* The M25 is carried in the page. Overpass being down, slow, or answering
     in a shape the stitching cannot close must no longer be able to turn an
     address inside the ring into Watford with no border. */
  var b = browser(function () {
    throw new Error("nothing should be fetched to decide this");
  });
  return b.window.QasrEngine.cityWithRing({ lat: 51.6238, lon: -0.3892 }, true)
    .then(function (city) {
      assert.strictEqual(city.name, "London");
      assert.ok(city.shape, "the border must come with the shape to measure against");
      assert.strictEqual(b.calls.length, 0,
        "deciding London cost " + b.calls.length + " request(s); it should cost none");
    });
});

/* The whole sequence, in the order it happens: an address arrives, the box
   says a ring road may apply, the ring itself is consulted, the address is
   found inside it, that becomes the city border, and the map frames the ring.
   Each step has its own test; this one is here so the sequence cannot quietly
   come apart, which is how it broke twice. */
test("address, box, ring, inside, border, drawn — the whole way through", function () {
  var b = browser(function () { throw new Error("no network for this"); });
  var G = b.window.QasrEngine;
  var here = { lat: 51.6238, lon: -0.3892 };          /* WD19 4QP */

  var entry = G.ringRoadNear(here);
  assert.ok(entry, "1. the box did not recognise the address as near a ring road");
  assert.strictEqual(entry.city, "London");
  assert.ok(entry.shape, "2. the ring is not carried in the page");
  assert.strictEqual(G.inShape(here.lat, here.lon, entry.shape), true,
    "3. the address was not found inside the ring");

  return G.cityWithRing(here, false).then(function (city) {
    assert.strictEqual(city.name, "London", "4. the border did not become London");
    assert.strictEqual(city.fromRing, "M25 and A282");

    /* 5. the frame must hold the whole ring, or it is drawn off the screen. */
    var edge = city.shape.coordinates[0];
    var s = Math.min.apply(null, edge.map(function (p) { return p[1]; }));
    var n = Math.max.apply(null, edge.map(function (p) { return p[1]; }));
    var w = Math.min.apply(null, edge.map(function (p) { return p[0]; }));
    var e = Math.max.apply(null, edge.map(function (p) { return p[0]; }));
    var box = G.journeyBox(here, null, null, city.shape);
    assert.ok(box[0] <= s && box[2] >= n && box[1] <= w && box[3] >= e,
      "5. the ring was drawn but framed off the edge of the map");
  });
});

test("a city looked up twice is never the same object twice", function () {
  /* The fault behind "your start is outside its own city": the cache handed
     out one object, one caller hung a note on it and another swapped its
     shape for a ring road's, so a London labelled M25 carried the council's
     boundary and WD19 4QP fell outside it. */
  var b = londonWorld();
  var G = b.window.QasrEngine;
  return G.cityWithRing({ lat: 51.6238, lon: -0.3892 }, false).then(function (first) {
    first.note = "scribbled on by whoever got it first";
    first.shape = null;
    return G.cityWithRing({ lat: 51.6238, lon: -0.3892 }, false).then(function (second) {
      assert.ok(!second.note, "the second caller inherited the first one's note");
      assert.ok(second.shape, "the second caller inherited the first one's cleared shape");
    });
  });
});

test("a ring that is not a closed loop of believable size is refused", function () {
  var G = londonWorld().window.QasrEngine;
  var sound = { traced: true, closedByHand: false, areaKm2: 2200 };
  assert.strictEqual(G.ringIsSound(sound), true, "the M25's own shape must pass");
  assert.strictEqual(G.ringIsSound(null), false);
  assert.strictEqual(G.ringIsSound({ traced: false, closedByHand: false, areaKm2: 2200 }), false,
    "a hull thrown round the wreckage is not a ring road");
  assert.strictEqual(G.ringIsSound({ traced: true, closedByHand: true, areaKm2: 2200 }), false,
    "a loop closed by hand is not sound enough to become somebody's city");
  assert.strictEqual(G.ringIsSound({ traced: true, closedByHand: false, areaKm2: 4 }), false,
    "four square kilometres is not a city");
  assert.strictEqual(G.ringIsSound({ traced: true, closedByHand: false, areaKm2: 900000 }), false,
    "most of England is not a city either");
});

queue.then(function () {
  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed ? 1 : 0);
});
