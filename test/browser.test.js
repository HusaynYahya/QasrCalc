/* ============================================================================
   The page itself, in a real browser.

   Every other suite tests a piece. Every fault that has actually reached the
   reader was in how the pieces join: a city named on one screen and
   contradicted on the next, a border drawn but framed off the map, a ruling
   that disagreed with the line above it. None of those could fail a unit
   test, and all of them are plain to see in a rendered page.

   The map services are stubbed at the network layer, so this needs no
   internet — only the Chromium that is already installed.

     node test/browser.test.js            run it
     node test/browser.test.js --shots    also write PNGs to test/shots/
   ========================================================================== */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var assert = require("assert");
var { chromium } = require("playwright");

var ROOT = path.join(__dirname, "..");
var SHOTS = process.argv.indexOf("--shots") >= 0;
var CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

var TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
              ".json": "application/json",
              ".png": "image/png", ".svg": "image/svg+xml" };

function serve() {
  var server = http.createServer(function (req, res) {
    var rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";
    var file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    fs.readFile(file, function (err, body) {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
      res.end(body);
    });
  });
  return new Promise(function (go) {
    server.listen(0, "127.0.0.1", function () { go({ server: server, port: server.address().port }); });
  });
}

/* --- the world the page is given ------------------------------------------
   Two addresses inside the M25 and one well outside it, with a road between
   each pair. Real shapes, invented content: what is under test is the page's
   own behaviour, not the map services.                                       */
var PLACES = {
  oxhey:       { lat: 51.6238, lon: -0.3892, label: "WD19 4QP, South Oxhey, Watford, Hertfordshire, England" },
  cricklewood: { lat: 51.5556, lon: -0.2136, label: "Anson Road, Cricklewood, London, England" },
  warwick:     { lat: 52.3793, lon: -1.5615, label: "University of Warwick, Coventry, England" }
};

function straightLine(a, b, n) {
  var out = [];
  for (var i = 0; i <= n; i++) out.push([a.lon + (b.lon - a.lon) * i / n, a.lat + (b.lat - a.lat) * i / n]);
  return out;
}

function haversineKm(a, b) {
  var R = 6371, t = Math.PI / 180;
  var dLat = (b.lat - a.lat) * t, dLon = (b.lon - a.lon) * t;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function whichPlace(text) {
  var q = String(text).toLowerCase();
  if (/wd19|oxhey/.test(q)) return PLACES.oxhey;
  if (/anson|cricklewood/.test(q)) return PLACES.cricklewood;
  if (/warwick|coventry/.test(q)) return PLACES.warwick;
  return null;
}

function nominatimRow(p) {
  return { display_name: p.label, lat: String(p.lat), lon: String(p.lon),
           address: { city: p.label.split(", ").slice(-3)[0] } };
}

async function stub(page, log) {
  await page.route("**://photon.komoot.io/**", function (route) {
    var q = new URL(route.request().url()).searchParams.get("q") || "";
    var p = whichPlace(q);
    log.push("photon");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      features: p ? [{ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
                       properties: { name: p.label.split(",")[0], city: "", country: "England" } }] : []
    })});
  });

  await page.route("**://nominatim.openstreetmap.org/**", function (route) {
    var url = new URL(route.request().url());
    log.push("nominatim");
    if (/reverse/.test(url.pathname)) {
      var lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
      var near = Object.keys(PLACES).map(function (k) { return PLACES[k]; })
        .sort(function (a, b) {
          return haversineKm({ lat: lat, lon: lon }, a) - haversineKm({ lat: lat, lon: lon }, b);
        })[0];
      /* Deliberately unhelpful, as the real one is: it calls WD19 4QP Watford. */
      var town = near === PLACES.oxhey ? "Watford"
               : near === PLACES.cricklewood ? "Brent" : "Coventry";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        display_name: near.label, lat: String(near.lat), lon: String(near.lon),
        addresstype: "town", place_rank: 16,
        address: { town: town, county: "England", country: "England" }, geojson: null
      })});
    }
    var p = whichPlace(url.searchParams.get("q") || "");
    route.fulfill({ status: 200, contentType: "application/json",
                    body: JSON.stringify(p ? [nominatimRow(p)] : []) });
  });

  await page.route("**://router.project-osrm.org/**", function (route) {
    var bits = route.request().url().split("/driving/")[1].split("?")[0].split(";");
    var a = { lon: +bits[0].split(",")[0], lat: +bits[0].split(",")[1] };
    var b = { lon: +bits[1].split(",")[0], lat: +bits[1].split(",")[1] };
    var km = haversineKm(a, b) * 1.25;                 /* roads are not straight */
    log.push("osrm");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      code: "Ok",
      routes: [{ distance: km * 1000, duration: km * 60,
                 geometry: { type: "LineString", coordinates: straightLine(a, b, 60) } }]
    })});
  });

  /* Overpass, with two roads invented for the border-from-roads test: B1
     closes into a square of about 2,200 km² round London, B99 is the same
     square with a side missing, so it cannot close. Everything else answers
     empty, as before. */
  await page.route("**overpass**", function (route) {
    log.push("overpass");
    var q = decodeURIComponent(route.request().url().split("data=")[1] || "");
    var S = 51.2885, N = 51.7115, W = -0.4603, E = 0.2203;
    function way(a, b) {
      return { type: "way", geometry: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }] };
    }
    var sides = [way([S, W], [S, E]), way([S, E], [N, E]),
                 way([N, E], [N, W]), way([N, W], [S, W])];
    var elements = [];
    /* Picking roads off the map: whichever side of the square the tap is
       nearest is the road returned, so four taps make the loop. */
    var m = /way\(around:(\d+),(-?[\d.]+),(-?[\d.]+)\)/.exec(q);
    if (m) {
      var radius = parseFloat(m[1]), la = parseFloat(m[2]), lo = parseFloat(m[3]);
      var names = ["south side", "east side", "north side", "west side"];
      /* Distance to the side itself, not to three points on it: a tap
         partway along an edge is nearest that edge, and sampling the ends
         and middle put it on whichever corner happened to be closer. */
      /* In metres, and honouring the radius asked for — the real service
         returns nothing outside it, which is what makes a missed tap a miss
         and the widening worth having. */
      var kx = Math.cos(la * Math.PI / 180) * 111320, ky = 111320;
      function toSegment(g) {
        var ax = (g[0].lon - lo) * kx, ay = (g[0].lat - la) * ky;
        var bx = (g[1].lon - lo) * kx, by = (g[1].lat - la) * ky;
        var dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        var t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
        return Math.hypot(ax + dx * t, ay + dy * t);
      }
      var best = 0, bestD = Infinity;
      sides.forEach(function (w, i) {
        var d = toSegment(w.geometry);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (bestD > radius) {
        return route.fulfill({ status: 200, contentType: "application/json",
                               body: JSON.stringify({ elements: [] }) });
      }
      var w = sides[best];
      var out = [{ type: "way", id: 900 + best, geometry: w.geometry,
                   tags: { highway: "primary", name: names[best] } }];
      /* A junction partway up the west side, where a slip lane runs beside
         the road and is nearer to the tap than the road itself. Kept off the
         midpoints, so the four-tap test still meets one road per tap. */
      var jLat = (S + N) / 2 + 0.12, jLon = W;
      if (Math.abs(la - jLat) < 0.02 && Math.abs(lo - jLon) < 0.02) {
        out.unshift({ type: "way", id: 950,
          geometry: [{ lat: jLat - 0.01, lon: jLon + 0.0002 },
                     { lat: jLat + 0.01, lon: jLon + 0.0002 }],
          tags: { highway: "residential", name: "Slip Lane" } });
      }
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ elements: out }) });
    }

    route.fulfill({ status: 200, contentType: "application/json",
                    body: JSON.stringify({ elements: elements }) });
  });

  /* Tiles: one transparent pixel, so nothing waits on a map server. */
  var PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64");
  await page.route("**basemaps.cartocdn.com/**", function (route) {
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
  });
}

/* --- the runner ----------------------------------------------------------- */
var passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (err) { failed++; console.log("  FAIL " + name + "\n       " + err.message.split("\n")[0]); }
}

async function open(browser, base) {
  var page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  var log = [];
  page.on("pageerror", function (e) { log.push("PAGE ERROR: " + e.message); });
  await stub(page, log);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  page.callLog = log;
  return page;
}

/* Typed, then picked from the list. Typing alone never adopts a place — the
   city is only resolved when a suggestion is taken — so a test that only
   types is testing nothing that a reader does. */
async function enter(page, id, text) {
  var list = id === "fromInput" ? "#fromList" : "#toList";
  await page.click("#" + id);
  await page.fill("#" + id, text);
  await page.waitForTimeout(500);              /* the type-ahead settles */
  var options = await page.$$(list + " li");
  if (options.length) {
    await options[0].click();
    await page.waitForTimeout(200);
  } else {
    await page.keyboard.press("Escape");
  }
}

async function journey(page, from, to) {
  await enter(page, "fromInput", from);
  await enter(page, "toInput", to);
  await page.click("#calcBtn");
  await page.waitForFunction(
    "document.getElementById('result') && !document.getElementById('result').hidden &&" +
    "document.getElementById('verdictLabel').textContent.trim() !== '—'",
    null, { timeout: 20000 });
  await page.waitForTimeout(300);
}

async function shot(page, name) {
  if (!SHOTS) return;
  var dir = path.join(__dirname, "shots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  /* The picture is a debugging aid, never an assertion, so it must not be
     able to fail a test. A full-page capture refuses on a tall page that is
     still settling; the visible window is worth more than nothing. */
  try {
    await page.screenshot({ path: path.join(dir, name + ".png"), fullPage: true });
  } catch (e) {
    try { await page.screenshot({ path: path.join(dir, name + ".png") }); }
    catch (e2) { console.log("       (no screenshot for " + name + ": " + e2.message.split("\n")[0] + ")"); }
  }
}

(async function () {
  var site = await serve();
  var base = "http://127.0.0.1:" + site.port + "/";
  var browser = await chromium.launch({ executablePath: CHROME });

  console.log("\nThe page in a browser");

  await test("it loads with no script error", async function () {
    var page = await open(browser, base);
    await page.waitForTimeout(700);
    var errs = page.callLog.filter(function (l) { return /PAGE ERROR/.test(l); });
    assert.strictEqual(errs.length, 0, errs.join("; "));
    assert.ok(await page.isVisible("#map"), "the map is not on the page");
    await shot(page, "01-at-rest");
    await page.close();
  });

  await test("nothing marked hidden is left showing", async function () {
    /* .mapbusy set display:flex and so beat the browser's own rule for the
       hidden attribute: an empty white pill sat on the map permanently.
       .suggest and .q--sub had the same shape of fault waiting. */
    var page = await open(browser, base);
    await page.waitForTimeout(700);
    var showing = await page.evaluate(function () {
      var bad = [];
      document.querySelectorAll("[hidden]").forEach(function (el) {
        var b = el.getBoundingClientRect();
        if (b.width > 0 || b.height > 0) {
          bad.push((el.id || el.className || el.tagName) + " " +
                   Math.round(b.width) + "x" + Math.round(b.height));
        }
      });
      return bad;
    });
    assert.deepStrictEqual(showing, [], "still rendered while hidden: " + showing.join(", "));
    await page.close();
  });

  await test("an address inside the M25 is called London, not Watford", async function () {
    var page = await open(browser, base);
    await enter(page, "fromInput", "WD19 4QP");
    await page.waitForFunction(
      "/London|Watford/.test(document.getElementById('fromHint').textContent)",
      null, { timeout: 15000 });
    await page.waitForTimeout(500);
    var hint = await page.textContent("#fromHint");
    assert.ok(/London/.test(hint), "the line under the address says: " + hint.trim());
    assert.ok(/M25/.test(hint), "it does not mention the M25: " + hint.trim());
    await shot(page, "02-inside-m25");
    await page.close();
  });

  await test("the M25 is actually drawn, and inside the frame", async function () {
    var page = await open(browser, base);
    await enter(page, "fromInput", "WD19 4QP");
    await page.waitForTimeout(1500);
    var drawn = await page.evaluate(function () {
      var paths = document.querySelectorAll("#map svg path");
      var widest = 0;
      paths.forEach(function (p) {
        var b = p.getBoundingClientRect();
        widest = Math.max(widest, b.width);
      });
      var map = document.getElementById("map").getBoundingClientRect();
      return { paths: paths.length, widest: widest, mapWidth: map.width };
    });
    assert.ok(drawn.paths > 0, "nothing is drawn on the map at all");
    assert.ok(drawn.widest > drawn.mapWidth * 0.4,
      "the widest shape on the map is " + Math.round(drawn.widest) + "px across a " +
      Math.round(drawn.mapWidth) + "px map — the ring is not in frame");
    await shot(page, "03-ring-framed");
    await page.close();
  });

  await test("two addresses inside the M25 are one city: pray in full", async function () {
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "Anson Road, Cricklewood");
    var verdict = (await page.textContent("#verdictLabel")).trim();
    var border = (await page.textContent("#borderCheck")).trim();
    assert.ok(/full/i.test(verdict), "the ruling is: " + verdict);
    assert.ok(/inside one city/i.test(border), "the border check says: " + border);
    await shot(page, "04-within-m25");
    await page.close();
  });

  await test("a journey out of the M25 is shortened, and says where it begins", async function () {
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    var verdict = (await page.textContent("#verdictLabel")).trim();
    assert.ok(/shorten/i.test(verdict), "the ruling is: " + verdict);
    var begins = await page.isVisible(".legend .is-begin");
    assert.ok(begins, "the legend does not say where the shortening begins");
    await shot(page, "05-out-of-m25");
    await page.close();
  });

  await test("the hadd is marked on the route where it falls", async function () {
    /* Two kilometres is about three pixels at the zoom that fits a journey,
       so this was first drawn as a dot and sat exactly under the amber ring
       that marks the border. A circle on the ground is the point: it has a
       size the reader can see, and it grows when they zoom in. */
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    var drawn = await page.evaluate(function () {
      var gold = getComputedStyle(document.documentElement)
        .getPropertyValue("--map-hadd").trim().toLowerCase();
      var hit = [].slice.call(document.querySelectorAll("#map svg path"))
        .filter(function (p) {
          return (p.getAttribute("stroke") || "").toLowerCase() === gold;
        });
      var li = document.querySelector(".legend li.is-hadd");
      return { marks: hit.length, dashed: hit.length ? hit[0].getAttribute("stroke-dasharray") : null,
               legend: !!li && !li.hidden };
    });
    assert.strictEqual(drawn.marks, 1, "the hadd circle is not on the map");
    assert.ok(drawn.dashed, "the hadd circle is not dashed, so it reads as a hard line");
    assert.ok(drawn.legend, "the legend does not carry the hadd");
    await shot(page, "06-hadd");
    await page.close();
  });

  await test("the hadd can be turned off, and stays off", async function () {
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    function gold() {
      return page.evaluate(function () {
        var g = getComputedStyle(document.documentElement)
          .getPropertyValue("--map-hadd").trim().toLowerCase();
        return { marks: [].slice.call(document.querySelectorAll("#map svg path"))
          .filter(function (p) { return (p.getAttribute("stroke") || "").toLowerCase() === g; }).length,
          legend: (function () { var li = document.querySelector(".legend li.is-hadd");
            return !!li && !li.hidden; })() };
      });
    }
    var on = await gold();
    assert.strictEqual(on.marks, 1, "it should be drawn to begin with");

    await page.uncheck("#showHadd");
    await page.waitForTimeout(300);
    var off = await gold();
    assert.strictEqual(off.marks, 0, "unchecking it must take the mark off the map");
    assert.strictEqual(off.legend, false, "and its legend row with it");

    /* The ruling is untouched: the hadd never decided it. */
    var verdict = (await page.textContent("#verdictLabel")).trim();
    assert.ok(/shorten/i.test(verdict), "turning off a drawing changed the ruling: " + verdict);

    /* Remembered across a reload, like the unit and the theme. A new page
       would not test it: each one gets its own storage. */
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    assert.strictEqual((await page.evaluate(function () {
      return document.getElementById("showHadd").checked;
    })), false, "the choice was not remembered");
    await page.close();
  });

  await test("no hadd is drawn on a journey that is not shortened", async function () {
    /* It marks where the shortening begins. On a journey with no shortening
       it would be marking nothing. */
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "Anson Road, Cricklewood");
    var drawn = await page.evaluate(function () {
      var gold = getComputedStyle(document.documentElement)
        .getPropertyValue("--map-hadd").trim().toLowerCase();
      return { marks: [].slice.call(document.querySelectorAll("#map svg path"))
        .filter(function (p) { return (p.getAttribute("stroke") || "").toLowerCase() === gold; }).length,
        legend: (function () { var li = document.querySelector(".legend li.is-hadd");
          return !!li && !li.hidden; })() };
    });
    assert.strictEqual(drawn.marks, 0, "a hadd circle is drawn on a journey prayed in full");
    assert.strictEqual(drawn.legend, false, "the legend offers the hadd on a journey prayed in full");
    await page.close();
  });

  await test("a border can be picked road by road off the map", async function () {
    /* Four taps, one per side of the square, and the roads collected go
       through ringShape — the same stitching the M25 gets. */
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    await page.click("#cityBtn");
    await page.click("#pickStart");
    assert.ok(await page.evaluate(function () {
      return document.getElementById("map").className.indexOf("is-picking") >= 0;
    }), "the map does not say it is picking");

    /* The midpoint of each side of the square the Overpass stub serves. */
    var S = 51.2885, N = 51.7115, W = -0.4603, E = 0.2203;
    var taps = [[S, (W + E) / 2], [(S + N) / 2, E], [N, (W + E) / 2], [(S + N) / 2, W]];
    for (var i = 0; i < taps.length; i++) {
      await page.evaluate(function (t) {
        window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
      }, taps[i]);
      await page.waitForTimeout(400);
    }
    var msg = await page.textContent("#pickMsg");
    assert.ok(/4 roads picked/.test(msg), "four taps did not make four roads: " + msg);
    assert.ok(/close into a loop/.test(msg), "the four sides did not close: " + msg);

    assert.ok(await page.isVisible("#pickUse"), "the border cannot be used");
    await page.click("#pickUse");
    await page.waitForTimeout(500);
    var hint = await page.textContent("#fromHint");
    assert.ok(/border you picked/.test(hint), "the picked border was not adopted: " + hint);
    /* Start picking scrolls the map into view; a full-page capture cannot be
       taken while that is still animating. */
    await page.evaluate(function () { window.scrollTo(0, 0); });
    await page.waitForTimeout(700);
    await shot(page, "08-picked-border");
    await page.close();
  });

  await test("where two roads run under the tap, the reader chooses", async function () {
    /* Tapping a motorway near a junction lands on a slip road a few metres
       away. Taking the nearest silently put a lane in the border. */
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    await page.click("#cityBtn");
    await page.click("#pickStart");
    var S = 51.2885, N = 51.7115, W = -0.4603;
    await page.evaluate(function (t) {
      window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
    }, [(S + N) / 2 + 0.12, W]);
    await page.waitForFunction(
      "!document.getElementById('pickList').hidden", null, { timeout: 20000 });

    var opts = await page.$$eval("#pickList .pickopt", function (bs) {
      return bs.map(function (b) { return b.textContent; });
    });
    assert.strictEqual(opts.length, 2, "both roads should be offered: " + JSON.stringify(opts));
    assert.ok(/Slip Lane/.test(opts.join(" ")), "the nearer lane is not offered");
    assert.ok(/west side/.test(opts.join(" ")), "the road actually meant is not offered");
    assert.ok(!/road picked/.test(await page.textContent("#pickMsg")),
      "a road was taken without being chosen");

    /* Choose the road, not the lane that happened to be nearer. */
    var i = opts.findIndex(function (t) { return /west side/.test(t); });
    await page.$$eval("#pickList .pickopt", function (bs, k) { bs[k].click(); }, i);
    await page.waitForTimeout(400);
    assert.ok(/1 road picked/.test(await page.textContent("#pickMsg")),
      "the chosen road was not picked: " + (await page.textContent("#pickMsg")));
    assert.ok(await page.evaluate(function () {
      return document.getElementById("pickList").hidden;
    }), "the choice stayed on screen after choosing");
    await page.close();
  });

  await test("a tap that finds nothing says so, and keeps what is picked", async function () {
    /* Sixty metres is a poor reach for a thumb, so the search widens before
       giving up — and when it does give up it must not lose the roads
       already picked, or a missed tap costs the whole border. */
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    await page.click("#cityBtn");
    await page.click("#pickStart");
    var S = 51.2885, N = 51.7115, W = -0.4603, E = 0.2203;
    await page.evaluate(function (t) {
      window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
    }, [S, (W + E) / 2]);
    await page.waitForTimeout(400);
    assert.ok(/1 road picked/.test(await page.textContent("#pickMsg")));

    /* The middle of the square: nothing within any radius the stub serves. */
    await page.evaluate(function (t) {
      window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
    }, [(S + N) / 2 - 0.05, (W + E) / 2 + 0.0007]);
    await page.waitForFunction(
      "document.getElementById('pickMsg').className.indexOf('warn') >= 0",
      null, { timeout: 20000 });
    assert.ok(/No road within/.test(await page.textContent("#pickMsg")),
      "the miss is not explained: " + (await page.textContent("#pickMsg")));

    /* And the road picked before the miss is still there. */
    await page.click("#pickUndo");
    await page.waitForTimeout(300);
    assert.ok(!(await page.isVisible("#pickUndo")),
      "undo should have emptied a list of exactly one");
    await page.close();
  });

  await test("two map servers hanging do not hold up the third", async function () {
    /* The fault that made picking look dead: a host took the request and
       never answered, so fetch never settled and the rest were never asked.
       Asked one after another the deadlines then added up, and the reader was
       told nothing until every one of them had passed. They are asked at once
       now, so two dead hosts cost nothing. */
    var page = await open(browser, base);
    await page.route("**overpass.kumi.systems**", function () { /* never answered */ });
    await page.route("**overpass-api.de**", function () { /* never answered */ });
    await journey(page, "WD19 4QP", "University of Warwick");
    await page.click("#cityBtn");
    await page.click("#pickStart");
    var S = 51.2885, W = -0.4603, E = 0.2203;
    await page.evaluate(function (t) {
      window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
    }, [S, (W + E) / 2]);
    /* The live host answers at once — not after the dead ones time out. */
    var began = Date.now();
    await page.waitForFunction(
      "/road picked/.test(document.getElementById('pickMsg').textContent)",
      null, { timeout: 30000 });
    var took = Date.now() - began;
    assert.ok(/1 road picked/.test(await page.textContent("#pickMsg")),
      "the live host never got asked: " + (await page.textContent("#pickMsg")));
    assert.ok(took < 6000,
      "waited " + took + " ms — the hosts are being asked in turn, not at once");
    await page.close();
  });

  await test("a road tapped twice is put back, and three sides will not close", async function () {
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    await page.click("#cityBtn");
    await page.click("#pickStart");
    var S = 51.2885, N = 51.7115, W = -0.4603, E = 0.2203;
    var taps = [[S, (W + E) / 2], [(S + N) / 2, E], [N, (W + E) / 2]];
    for (var i = 0; i < taps.length; i++) {
      await page.evaluate(function (t) {
        window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
      }, taps[i]);
      await page.waitForTimeout(400);
    }
    assert.ok(/3 roads picked/.test(await page.textContent("#pickMsg")));
    assert.ok(/not a closed loop yet/.test(await page.textContent("#pickMsg")),
      "three sides of a square must not count as closed");
    assert.ok(!(await page.isVisible("#pickUse")), "an unclosed loop was offered as a border");

    /* Tapping the same road again takes it off. */
    await page.evaluate(function (t) {
      window.__qasrMap.fire("click", { latlng: { lat: t[0], lng: t[1] } });
    }, taps[2]);
    await page.waitForTimeout(400);
    assert.ok(/2 roads picked/.test(await page.textContent("#pickMsg")),
      "tapping a picked road again did not take it off");
    await page.close();
  });

  await test("the ruling never contradicts the line above it", async function () {
    /* The fault that reached the reader: London on one screen, "your start is
       outside London" on the next. */
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "Anson Road, Cricklewood");
    var hint = await page.textContent("#fromHint");
    var border = await page.textContent("#borderCheck");
    if (/London/.test(hint)) {
      assert.ok(!/outside London/i.test(border),
        "the address line says London and the border check says: " + border.trim());
    }
    await page.close();
  });

  await test("distances can be read in miles, and it is remembered", async function () {
    var page = await open(browser, base);
    await journey(page, "WD19 4QP", "University of Warwick");
    var inKm = await page.textContent("#measure");
    assert.ok(/km/.test(inKm), "distances should start in kilometres: " + inKm.slice(0, 80));

    /* The label, as a reader taps it: the radio itself is visually hidden. */
    await page.click(".units label:has(input[value='mi'])");
    await page.waitForTimeout(400);
    var inMi = await page.textContent("#measure");
    assert.ok(/\bmi\b|mile/.test(inMi), "still not in miles: " + inMi.slice(0, 120));
    assert.ok(!/\d\s?km/.test(inMi), "kilometres left on the page: " + inMi.slice(0, 120));

    /* 44 km is 27.3 miles: the threshold must convert, not stay put. */
    assert.ok(/27\./.test(inMi), "the eight-farsakh limit did not convert: " + inMi.slice(0, 200));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    assert.strictEqual(
      await page.isChecked("input[name='unit'][value='mi']"), true,
      "the choice of miles was forgotten on reload");
    await page.close();
  });

  await test("the journey can be opened in Google Maps", async function () {
    var page = await open(browser, base);
    assert.ok(!(await page.isVisible("#mapOut")), "the link should not be there before a journey is");
    await journey(page, "WD19 4QP", "University of Warwick");
    assert.ok(await page.isVisible("#mapOut"), "no link to Google Maps after a journey");
    var href = await page.getAttribute("#mapOut", "href");
    assert.ok(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/.test(href), href);
    /* The two places the reader actually gave, not the map's centre. */
    assert.ok(href.indexOf("origin=51.6238,-0.3892") > 0, "wrong origin: " + href);
    assert.ok(href.indexOf("destination=52.3793,-1.5615") > 0, "wrong destination: " + href);
    assert.ok(/travelmode=driving/.test(href), "it should open as a drive: " + href);
    assert.strictEqual(await page.getAttribute("#mapOut", "target"), "_blank",
      "it should not navigate away from the ruling");
    await page.close();
  });

  await test("the page can be turned dark, and stays dark", async function () {
    var page = await open(browser, base);
    var light = await page.evaluate(function () {
      return getComputedStyle(document.body).backgroundColor;
    });
    await page.click("#themeToggle");
    await page.waitForTimeout(250);
    var dark = await page.evaluate(function () {
      return { bg: getComputedStyle(document.body).backgroundColor,
               attr: document.documentElement.getAttribute("data-theme"),
               label: document.getElementById("themeLabel").textContent };
    });
    assert.strictEqual(dark.attr, "dark");
    assert.notStrictEqual(dark.bg, light, "the page did not change colour");
    assert.strictEqual(dark.label, "Light", "the button should now offer the way back");

    /* And it survives a reload, which is the whole point of remembering it. */
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    assert.strictEqual(
      await page.evaluate(function () { return document.documentElement.getAttribute("data-theme"); }),
      "dark", "the choice was forgotten on reload");
    await shot(page, "06-dark");
    await page.close();
  });

  await test("dark ink is light enough to read on dark paper", async function () {
    var page = await open(browser, base);
    await page.click("#themeToggle");
    await page.waitForTimeout(250);
    var seen = await page.evaluate(function () {
      function lum(c) {
        var m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(c);
        if (!m) return null;
        var v = [1, 2, 3].map(function (i) {
          var x = +m[i] / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      }
      var body = lum(getComputedStyle(document.body).backgroundColor);
      var out = [];
      document.querySelectorAll("h1, .lede, .block__title, label, .hint, .q__text b")
        .forEach(function (el) {
          var l = lum(getComputedStyle(el).color);
          if (l === null) return;
          var ratio = (Math.max(l, body) + 0.05) / (Math.min(l, body) + 0.05);
          if (ratio < 4.5) out.push(el.className || el.tagName);
        });
      return out;
    });
    assert.deepStrictEqual(seen, [], "too faint to read against the page: " + seen.join(", "));
    await page.close();
  });

  await test("the map takes dark tiles when the page is dark", async function () {
    var page = await open(browser, base);
    await page.click("#themeToggle");
    await page.waitForTimeout(400);
    var url = await page.evaluate(function () {
      var img = document.querySelector("#map .leaflet-tile-pane img");
      return img ? img.src : "";
    });
    assert.ok(/dark_all/.test(url), "the tiles are still the light ones: " + url);
    await page.close();
  });

  await browser.close();
  site.server.close();
  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed ? 1 : 0);
})();
