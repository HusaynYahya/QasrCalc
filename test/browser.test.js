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

  await page.route("**overpass**", function (route) {
    log.push("overpass");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ elements: [] }) });
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
  await page.screenshot({ path: path.join(dir, name + ".png"), fullPage: true });
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

  await browser.close();
  site.server.close();
  console.log("\n" + passed + " passed, " + failed + " failed\n");
  process.exit(failed ? 1 : 0);
})();
