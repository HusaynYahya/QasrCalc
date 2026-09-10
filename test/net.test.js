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
  /* Somewhere with no boundary carried in the page: Dubai has one now, and a
     city that is already known is never looked up at all. */
  var SOMEWHERE = { lat: 25.2048, lon: 60.5000 };
  var b = browser(dubaiNetwork);
  return b.window.QasrEngine.cityWithRing(SOMEWHERE, false).then(function () {
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

section("A border that belongs to something that is not the city");

/* Najaf, as the address service actually answers it: no city, town or
   village anywhere in the address, and a quarter's polygon of about one
   square kilometre returned alongside. Recorded from a live reverse lookup
   at 32.0000, 44.3350. */
function najafWorld() {
  var quarter = {
    type: "Polygon",
    coordinates: [[[44.330, 31.997], [44.340, 31.997], [44.340, 32.003],
                   [44.330, 32.003], [44.330, 31.997]]]
  };
  return browser(function (url) {
    if (/\/reverse/.test(url)) {
      return reply({
        addresstype: "quarter", place_rank: 16, name: "حي السعد",
        display_name: "حي السعد, Al-Najaf Central Subdistrict, Al-Najaf Governorate, Iraq",
        address: { quarter: "حي السعد", subdistrict: "Al-Najaf Central Subdistrict",
                   county: "Al-Najaf District", state: "Al-Najaf Governorate",
                   country: "Iraq", country_code: "iq" },
        geojson: quarter
      });
    }
    return reply([]);
  });
}

test("a quarter's border is not drawn as the city's", function () {
  /* It was. OpenStreetMap has no city-level entry at that address and Najaf
     itself is only a point, so the quarter came back and was kept — one
     square kilometre, drawn as the border, with no name beside it because
     the address had no city in it either. A border that small is crossed a
     minute after setting off, so nearly the whole journey counted and a trip
     under eight farsakh could be reported as over it. */
  return najafWorld().window.QasrEngine.cityWithRing({ lat: 32.0, lon: 44.335 }, false)
    .then(function (city) {
      assert.ok(!city.shape, "the quarter's polygon must not be kept as the city's border");
      assert.ok(city.reason, "and the reader must be told why there is none");
    });
});

test("a settlement's own border is still kept when the name is missing", function () {
  /* The guard must not throw away a real city boundary for want of a label. */
  var square = { type: "Polygon", coordinates: [[[44.30, 31.95], [44.40, 31.95],
                 [44.40, 32.05], [44.30, 32.05], [44.30, 31.95]]] };
  var b = browser(function (url) {
    if (/\/reverse/.test(url)) {
      return reply({ addresstype: "city", place_rank: 16, address: { country: "Iraq" },
                     geojson: square });
    }
    return reply([]);
  });
  return b.window.QasrEngine.cityWithRing({ lat: 32.0, lon: 44.35 }, false)
    .then(function (city) {
      assert.ok(city.shape, "a city's own boundary must survive having no name");
    });
});

/* A square of the given side in kilometres, with its corner at lat/lon. */
function square(lat, lon, sideKm) {
  var d = sideKm / 111;
  return { type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat],
           [lon + d, lat + d], [lon, lat + d], [lon, lat]]] };
}

test("a namesake on another continent is not taken for want of a better", function () {
  /* Glasgow, as the address service actually answers it: the city itself is
     published as a point with no boundary, so the only polygons on offer are
     namesakes. Nothing contained the reader, the containment filter gave up
     and let everything through, and "the smallest wins" then picked a hamlet
     in Kentucky — a border of almost no area, four thousand miles off, that
     did not contain the reader it had been found for. */
  var b = browser(function (url) {
    if (/\/reverse/.test(url)) {
      return reply({ addresstype: "city", place_rank: 16, name: "Glasgow",
                     address: { city: "Glasgow", country: "United Kingdom" },
                     geojson: { type: "Point", coordinates: [-4.2518, 55.8642] } });
    }
    return reply([
      { place_rank: 16, addresstype: "village", display_name: "Glasgow, Kentucky",
        address: { village: "Glasgow", country: "United States" },
        geojson: square(37.00, -85.91, 1) },
      { place_rank: 16, addresstype: "town", display_name: "Glasgow, Montana",
        address: { town: "Glasgow", country: "United States" },
        geojson: square(48.19, -106.63, 2) }
    ]);
  });
  return b.window.QasrEngine.cityWithRing({ lat: 55.8642, lon: -4.2518 }, false)
    .then(function (city) {
      assert.ok(!city.shape,
        "a border four thousand miles away must not be drawn as the reader's city");
    });
});

test("the reader's own city is still taken when they stand just outside it", function () {
  /* The guard must not throw away a real boundary for the sake of a few
     kilometres: someone at the edge of town is still in that town's
     reckoning, and its border is the thing being measured to. */
  var b = browser(function (url) {
    if (/\/reverse/.test(url)) {
      return reply({ addresstype: "city", place_rank: 16, name: "Somewhere",
                     address: { city: "Somewhere", country: "Nowhere" },
                     geojson: { type: "Point", coordinates: [0.5, 51.0] } });
    }
    return reply([
      { place_rank: 16, addresstype: "city", display_name: "Somewhere",
        address: { city: "Somewhere", country: "Nowhere" },
        geojson: square(51.0, 0.0, 20) }
    ]);
  });
  /* A few kilometres west of that square, well within reach of it. */
  return b.window.QasrEngine.cityWithRing({ lat: 51.05, lon: -0.05 }, false)
    .then(function (city) {
      assert.ok(city.shape, "a border the reader is standing beside must be kept");
    });
});

test("a lookup that was refused does not report the city as missing", function () {
  /* The address service allows one request a second and answers 429 when
     pressed harder. That arrives with a reason of its own — wait and try
     again — and an earlier draft of the guard above threw it away and said
     "no city, town or village is published for this address" instead. A
     reader whose lookup had merely been refused was told their city does not
     exist, and went looking for another one rather than pressing Refresh. */
  var b = browser(function (url) {
    if (/\/reverse/.test(url)) {
      return { ok: false, status: 429,
               json: function () { return Promise.resolve({}); },
               text: function () { return Promise.resolve(""); } };
    }
    return reply([]);
  });
  return b.window.QasrEngine.cityWithRing({ lat: 51.5074, lon: -0.9 }, false)
    .then(function (city) {
      assert.ok(!city.shape, "nothing was found, so nothing may be drawn");
      assert.ok(/refusing requests/.test(city.reason || ""),
        "expected the service's own reason, got: " + city.reason);
    });
});

section("The city offered as the largest one nearby");

/* A square of the given side in kilometres, cornered at lat/lon. */
function sq(lat, lon, sideKm) {
  var d = sideKm / 111;
  return { type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat],
           [lon + d, lat + d], [lon, lat + d], [lon, lat]]] };
}

test("the nearby city's own border is taken, not a namesake's", function () {
  /* Delhi, as it really answered. Overpass finds a city called Delhi a few
     kilometres off; the search for that name then returns the real one at
     about fifteen hundred square kilometres alongside a village of three in
     Delaware County, Iowa. Nothing said which was meant, and the rule that
     settles ties — the smallest wins — chose Iowa. The reader was offered
     "Delhi, the largest city nearby" and it was on another continent. */
  var b = browser(function (url) {
    if (/overpass/.test(url)) {
      return reply({ elements: [
        { type: "node", lat: 28.66, lon: 77.23, tags: { place: "city", name: "Delhi" } }
      ]});
    }
    if (/\/reverse/.test(url)) {
      return reply({ addresstype: "suburb", place_rank: 15, name: "Karol Bagh",
                     address: { suburb: "Karol Bagh", country: "India" }, geojson: null });
    }
    if (/\/search/.test(url)) {
      return reply([
        { place_rank: 16, addresstype: "village", display_name: "Delhi, Delaware County, Iowa",
          address: { village: "Delhi", country: "United States" },
          geojson: sq(42.42, -91.33, 1.7) },
        { place_rank: 16, addresstype: "city", display_name: "Delhi, India",
          address: { city: "Delhi", country: "India" },
          geojson: sq(28.40, 76.84, 38) }
      ]);
    }
    return reply([]);
  });

  return new Promise(function (done, fail) {
    var seen = [];
    b.window.QasrEngine.cityChoices({ lat: 28.6139, lon: 77.2090 }, function (list) {
      seen = list;
    }).then(function () { done(seen); }, fail);
  }).then(function (list) {
    var delhi = list.filter(function (c) { return c.name === "Delhi"; })[0];
    assert.ok(delhi, "Delhi should be among the choices: " +
      JSON.stringify(list.map(function (c) { return c.name; })));
    assert.ok(delhi.shape, "and it should come with a border");
    var km2 = delhi.shape.coordinates.reduce(function (n, r) {
      return n + b.window.QasrEngine.ringAreaKm2(r);
    }, 0);
    assert.ok(km2 > 500,
      "expected Delhi's own border, got one of " + Math.round(km2) + " km² — that is the namesake");
  });
});

test("the reader's own city is offered, not only the biggest one near it", function () {
  /* Ras Al Khaimah, as it really answered. OpenStreetMap publishes no city
     boundary for it and no city in the address either, so both lookups by
     position came back with nothing to name — and the only choice left on
     the panel was Sharjah, seventy-two kilometres off in another emirate.
     The nearest city comes out of the same Overpass answer as the biggest,
     so offering it costs no extra request. */
  var b = browser(function (url) {
    if (/overpass/.test(url)) {
      return reply({ elements: [
        { type: "node", lat: 25.7895, lon: 55.9432,
          tags: { place: "city", name: "Ras Al Khaimah", population: "345000" } },
        { type: "node", lat: 25.3463, lon: 55.4209,
          tags: { place: "city", name: "Sharjah", population: "1800000" } }
      ]});
    }
    if (/\/reverse/.test(url)) {
      /* A suburb, with no city, town or village anywhere in the address. */
      return reply({ addresstype: "suburb", place_rank: 16,
                     name: "Burial Khor Ras Al Khaimah",
                     address: { suburb: "Burial Khor Ras Al Khaimah",
                                state: "Ras al-Khaimah Emirate",
                                country: "United Arab Emirates" },
                     geojson: null });
    }
    if (/\/search/.test(url)) {
      var q = decodeURIComponent((url.split("q=")[1] || "").split("&")[0]).toLowerCase();
      if (/sharjah/.test(q)) {
        return reply([{ place_rank: 16, addresstype: "city", display_name: "Sharjah",
                        address: { city: "Sharjah", country: "United Arab Emirates" },
                        geojson: square(25.30, 55.38, 12) }]);
      }
      if (/khaimah/.test(q)) {
        /* Only the emirate has a polygon; the city itself is a point. */
        return reply([{ place_rank: 8, addresstype: "state",
                        display_name: "Ras al-Khaimah Emirate",
                        address: { state: "Ras al-Khaimah Emirate",
                                   country: "United Arab Emirates" },
                        geojson: square(25.60, 55.80, 60) }]);
      }
    }
    return reply([]);
  });

  return new Promise(function (done, fail) {
    var seen = [];
    b.window.QasrEngine.cityChoices({ lat: 25.7895, lon: 55.9432 }, function (list) {
      seen = list;
    }).then(function () { done(seen); }, fail);
  }).then(function (list) {
    var names = list.map(function (c) { return c.name; });
    assert.ok(names.indexOf("Ras Al Khaimah") > -1,
      "the reader's own city must be among the choices: " + JSON.stringify(names));
    assert.ok(names.indexOf("Sharjah") > -1,
      "and the biggest one near it is still offered: " + JSON.stringify(names));
  });
});

test("a choice with no border to draw never leads the list", function () {
  /* The panel is for picking a border to measure from, so one that has none
     is a last resort. Al Hillah headed the list for a reader in Karbala,
     forty-one kilometres away and with nothing to draw, above Karbala. */
  var b = browser(function (url) {
    if (/overpass/.test(url)) {
      return reply({ elements: [
        /* Al Hillah is the larger of the two, so it is the one the panel
           offers as the biggest nearby — and the one with no border. */
        { type: "node", lat: 32.48, lon: 44.42, tags: { place: "city", name: "Al Hillah",
                                                        population: "900000" } },
        { type: "node", lat: 32.616, lon: 44.025, tags: { place: "city", name: "Karbala",
                                                          population: "700000" } }
      ]});
    }
    if (/\/reverse/.test(url)) {
      return reply({ addresstype: "city", place_rank: 16, name: "Karbala",
                     address: { city: "Karbala", country: "Iraq" },
                     geojson: square(32.55, 43.95, 12) });
    }
    if (/\/search/.test(url)) {
      var q = decodeURIComponent((url.split("q=")[1] || "").split("&")[0]).toLowerCase();
      /* Al Hillah is published as a point: named, and with no border. */
      if (/hillah/.test(q)) {
        return reply([{ place_rank: 16, addresstype: "city", display_name: "Al Hillah",
                        address: { city: "Al Hillah", country: "Iraq" },
                        geojson: { type: "Point", coordinates: [44.42, 32.48] } }]);
      }
      return reply([{ place_rank: 16, addresstype: "city", display_name: "Karbala",
                      address: { city: "Karbala", country: "Iraq" },
                      geojson: square(32.55, 43.95, 12) }]);
    }
    return reply([]);
  });

  return new Promise(function (done, fail) {
    var seen = [];
    b.window.QasrEngine.cityChoices({ lat: 32.6160, lon: 44.0249 }, function (list) {
      seen = list;
    }).then(function () { done(seen); }, fail);
  }).then(function (list) {
    assert.ok(list.length, "something should be offered");
    assert.ok(list[0].shape,
      "the list is led by a choice with no border: " +
      JSON.stringify(list.map(function (c) { return c.name + (c.shape ? "" : " (none)"); })));
  });
});

section("A district standing in for the city");

/* Sharjah, as the address service really answers for it.

   Every signal points the wrong way at once: addresstype "city",
   place_rank 16, address.city "Halwan" — a quarter of the town, six square
   kilometres of it. A reader there was told they had left home while still
   in the middle of it, and the page's only response was a warning. */
function box(lat, lon, halfLat, halfLon) {
  return { type: "Polygon", coordinates: [[
    [lon - halfLon, lat - halfLat], [lon + halfLon, lat - halfLat],
    [lon + halfLon, lat + halfLat], [lon - halfLon, lat + halfLat],
    [lon - halfLon, lat - halfLat]
  ]] };
}
var SHARJAH = { lat: 25.3463, lon: 55.4209 };
var HALWAN = box(SHARJAH.lat, SHARJAH.lon, 0.011, 0.011);      /* about 5 km2 */
var SHARJAH_CITY = box(SHARJAH.lat, SHARJAH.lon, 0.10, 0.10);  /* about 445 km2 */

function sharjahNetwork(extra) {
  return function (url) {
    if (/photon\.komoot\.io\/reverse/.test(url)) {
      return reply({ features: [{ properties: { name: "Sharjah", state: "Sharjah",
        country: "United Arab Emirates", osm_value: "city",
        extent: [55.35, 25.42, 55.52, 25.27] },
        geometry: { coordinates: [SHARJAH.lon, SHARJAH.lat] } }] });
    }
    if (/nominatim.*\/reverse/.test(url)) {
      return reply({ display_name: "Halwan, Sharjah, United Arab Emirates",
        addresstype: "city", place_rank: 16,
        address: { city: "Halwan", state: "Sharjah",
                   country: "United Arab Emirates" },
        geojson: HALWAN });
    }
    if (/nominatim/.test(url)) {
      var q = decodeURIComponent(url).toLowerCase();
      if (/q=sharjah/.test(q)) {
        return reply([{ place_rank: 16, category: "boundary", type: "administrative",
          display_name: "Sharjah, United Arab Emirates",
          address: { city: "Sharjah", country: "United Arab Emirates" },
          geojson: extra || SHARJAH_CITY }]);
      }
      return reply([]);
    }
    return { ok: false, status: 504, json: function () { return Promise.resolve({}); } };
  };
}

test("a ward answering for the city is replaced by the city around it", function () {
  var b = browser(sharjahNetwork());
  var G = b.window.QasrEngine;
  return G.cityWithRing(SHARJAH, false).then(function (city) {
    assert.strictEqual(city.name, "Sharjah",
      "still measuring from " + city.name + ", a district inside the city");
    assert.strictEqual(G.cityTooSmall(city), false, "the doubt was carried over");
    assert.strictEqual(city.insteadOf, "Halwan",
      "the swap was made without saying what it replaced");
    assert.strictEqual(G.inShape(SHARJAH.lat, SHARJAH.lon, city.shape), true,
      "the border taken does not hold the address it was fetched for");
    assert.ok(G.ringAreaKm2(city.shape.coordinates[0]) > 100,
      "the border taken is still district-sized");
  });
});

test("a district is never traded for the province that holds it", function () {
  /* Tokyo is the other half of the same question. The thing containing a
     small ward there is the prefecture — 42,290 km2, an hour's drive of
     towns inside it — and adopting that would make the opposite error, and
     the larger one. The ward is kept, and its warning with it. */
  var PREFECTURE = box(SHARJAH.lat, SHARJAH.lon, 1.0, 1.0);   /* far over the limit */
  var b = browser(sharjahNetwork(PREFECTURE));
  var G = b.window.QasrEngine;
  return G.cityWithRing(SHARJAH, false).then(function (city) {
    assert.strictEqual(city.name, "Halwan",
      "a province was adopted as somebody's city");
    assert.strictEqual(city.insteadOf, undefined);
    assert.strictEqual(G.cityTooSmall(city), true,
      "the reader is no longer being warned about a border that is still wrong");
  });
});

test("a smaller neighbour is not adopted over the border being doubted", function () {
  /* The candidate has to be a promotion. One district swapped for another
     is movement without improvement, and would hide the warning. */
  var TINIER = box(SHARJAH.lat, SHARJAH.lon, 0.004, 0.004);
  var b = browser(sharjahNetwork(TINIER));
  var G = b.window.QasrEngine;
  return G.cityWithRing(SHARJAH, false).then(function (city) {
    assert.strictEqual(city.name, "Halwan");
    assert.strictEqual(G.cityTooSmall(city), true);
  });
});

test("a candidate that does not hold the address is refused", function () {
  /* Sharjah's border, but drawn round the next town along — near enough
     that the by-name lookup will hand it over, and still not the city this
     reader is standing in. */
  var ELSEWHERE = box(SHARJAH.lat + 0.27, SHARJAH.lon, 0.10, 0.10);
  var b = browser(sharjahNetwork(ELSEWHERE));
  var G = b.window.QasrEngine;
  return G.cityWithRing(SHARJAH, false).then(function (city) {
    assert.strictEqual(city.name, "Halwan");
    assert.strictEqual(G.cityTooSmall(city), true);
  });
});

section("A border drawn by hand answers to its name");

test("a city with a hand-drawn border is not looked up at all", function () {
  var b = browser(function () {
    throw new Error("the network was asked for a border the page is carrying");
  });
  var G = b.window.QasrEngine;
  return G.cityByName("Dubai").then(function (city) {
    assert.strictEqual(city.name, "Dubai");
    assert.strictEqual(city.fromRing, "E611 and the coast",
      "the map server's Dubai — the whole Emirate — was taken instead");
    assert.strictEqual(city.ringArea, 1328);
    assert.strictEqual(b.calls.length, 0, "a request was made for it anyway");
  });
});

test("a hand-drawn border is refused where it does not hold the reader", function () {
  /* There is a London in Ontario, and the M25 is not its edge. */
  var ONTARIO = { lat: 42.9849, lon: -81.2453 };
  var b = browser(function () { return reply([]); });
  var G = b.window.QasrEngine;
  assert.strictEqual(G.ringByName("London", ONTARIO), null,
    "the M25 was handed to a reader in Ontario");
  assert.ok(G.ringByName("London", { lat: 51.5074, lon: -0.1278 }),
    "the M25 was refused to a reader in London");
  assert.ok(G.ringByName("Greater Toronto"), "the traced GTA boundary is unreachable by name");
  assert.ok(G.ringByName("Toronto"), "“Greater” should not be needed to find it");
});

queue.then(function () {
  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed ? 1 : 0);
});
