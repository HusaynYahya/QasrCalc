/* ============================================================================
   A guard against the one mistake `node --check` cannot see: a constant
   referred to by a name that was never declared.

   LIMIT_KM was written for Fiqh.THRESHOLD_KM in the route picker, and the
   file parsed perfectly. The picker only runs when the router offers two or
   more routes, so the ReferenceError went unseen through a twenty-journey
   stress test. This catches that class outright.  — run with: node test/lint.test.js
   ========================================================================== */
"use strict";

var fs = require("fs");
var path = require("path");
var assert = require("assert");

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (err) { failed++; console.log("  FAIL " + name + "\n       " + err.message); }
}

/* Comments and string literals are removed first: they are full of words that
   look like constants — "GET", "QASR", a road called M25 — and none of them
   are code.                                                                  */
function stripCommentsAndStrings(src) {
  var out = "", i = 0, n = src.length;
  while (i < n) {
    var c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      var quote = c;
      i++;
      while (i < n && src[i] !== quote) { if (src[i] === "\\") i++; i++; }
      i++;
      out += '""';                       /* keep the expression well-formed */
    } else {
      out += c; i++;
    }
  }
  return out;
}

/* SHOUTING_CASE only. Ordinary names are too many to track this way, and the
   constants are where a typo hides longest — they are read rarely.           */
var NAME = "[A-Z][A-Z0-9_]{2,}";

/* Standard globals that happen to shout. Deliberately short: every name
   waved through here is a name this test can no longer catch.                */
var BUILTIN = { JSON: true, URL: true, NaN: true, Infinity: true };

function undeclaredConstants(file) {
  var code = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));

  var declared = Object.create(null);
  var decl = new RegExp("(?:var|let|const|function)\\s+(" + NAME + ")\\b", "g"), d;
  while ((d = decl.exec(code))) declared[d[1]] = true;
  /* "var A = 1, B = 2" declares B as much as A, and reading only the first
     name reported B as undeclared. */
  var more = new RegExp(",\\s*(" + NAME + ")\\s*=", "g");
  while ((d = more.exec(code))) declared[d[1]] = true;

  var missing = [], seen = Object.create(null);
  var use = new RegExp("(.?)\\b(" + NAME + ")\\b(\\s*:)?", "g"), u;
  while ((u = use.exec(code))) {
    var before = u[1], name = u[2], isKey = !!u[3];
    if (before === ".") continue;                    /* Fiqh.THRESHOLD_KM */
    if (isKey && /[{,\s]/.test(before)) continue;    /* a key in an object literal */
    if (declared[name] || seen[name] || BUILTIN[name]) continue;
    seen[name] = true;
    missing.push(name);
  }
  return missing;
}

console.log("\nUndeclared constants");

["qasr.js", "fiqh.js"].forEach(function (file) {
  test(file + " refers to no constant it never declares", function () {
    var missing = undeclaredConstants(path.join(__dirname, "..", file));
    assert.deepStrictEqual(missing, [], file + " uses " + missing.join(", ") +
      " without declaring " + (missing.length === 1 ? "it" : "them"));
  });
});

test("the scan would have caught the bug it was written for", function () {
  var tmp = path.join(__dirname, ".lint-probe.js");
  fs.writeFileSync(tmp, [
    "var THRESHOLD_KM = 44;",
    "/* a comment naming LIMIT_MI, which is not code */",
    'var label = "LIMIT_MI is not code either";',
    "var table = { LIMIT_KEY: 1 };",
    "var ok = 3 >= THRESHOLD_KM;",
    "var bad = 3 >= LIMIT_KM;"
  ].join("\n"));
  try {
    assert.deepStrictEqual(undeclaredConstants(tmp), ["LIMIT_KM"]);
  } finally {
    fs.unlinkSync(tmp);
  }
});

/* The map and its legend must carry the same mark. The colour lives in two
   files — a hex in qasr.js for the SVG cross drawn on the map, and a custom
   property in qasr.css for the one drawn in the legend — and nothing but this
   stops them drifting apart. */
console.log("\nThe map and its legend agree");

test("no colour is written into the drawing code", function () {
  /* The map used to carry its own hexes, matched by hand against the ones in
     the stylesheet — which a test had to police, and which made a second
     theme impossible without a second set of them. Every drawn colour is now
     a token read from the stylesheet, so light and dark are one change in
     one file, and the guard is simply that no hex is left. */
  var js = fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8");
  var hexes = (js.match(/"#[0-9a-fA-F]{6}"/g) || [])
    .filter(function (h) { return h !== '"#000000"'; });   /* the fallback */
  assert.deepStrictEqual(hexes, [],
    "colours still written into qasr.js: " + hexes.join(", "));
  assert.ok(/function paint\(/.test(js), "the token reader has gone");
});

test("the map has a colour for every theme the stylesheet offers", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "qasr.css"), "utf8");
  var js = fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8");
  var wanted = (js.match(/paint\("(--[a-z-]+)"\)/g) || []).map(function (m) {
    return /paint\("(--[a-z-]+)"\)/.exec(m)[1];
  }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  assert.ok(wanted.length >= 6, "the map reads suspiciously few tokens");
  wanted.forEach(function (token) {
    var light = new RegExp(":root \\{[\\s\\S]*?" + token + ":");
    assert.ok(light.test(css), token + " is read by the map but not defined for the light theme");
    var dark = new RegExp('\\[data-theme="dark"\\][\\s\\S]*?' + token + ":");
    assert.ok(dark.test(css), token + " is read by the map but not defined for the dark theme");
  });
});

test("that colour is neither of the two prayer colours", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "qasr.css"), "utf8");
  function prop(name) {
    var m = new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{3,8})").exec(css);
    return m && m[1].toLowerCase();
  }
  var mile = prop("milestone");
  assert.ok(mile, "--milestone is not declared");
  [["accent", prop("accent")], ["amber", prop("amber")]].forEach(function (p) {
    assert.notStrictEqual(mile, p[1],
      "the milestone shares its colour with --" + p[0] + ", which is a prayer state");
  });
});

/* The M25 was adopted only when Calculate was pressed, while the city shown
   beside the address came from cityOf directly — so an address in Watford was
   named Watford, and silently became London later. One missed call site is
   all it takes, so the rule is made structural: cityOf is the fallback inside
   cityWithRing and is called from nowhere else. */
console.log("\nThe ring road is asked every time");

test("cityOf is only ever called from inside cityWithRing", function () {
  var js = fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8");
  var wrapper = /function cityWithRing\([\s\S]*?\n  \}\n/.exec(js);
  assert.ok(wrapper, "cityWithRing has gone — the rule below no longer means anything");

  var everywhere = (js.match(/\bcityOf\(/g) || []).length;
  var inside = (wrapper[0].match(/\bcityOf\(/g) || []).length;
  /* One for the declaration itself; the rest must all be the fallback. */
  assert.strictEqual(everywhere - 1, inside,
    "cityOf is called " + (everywhere - 1 - inside) + " time(s) outside cityWithRing — " +
    "those places will miss the ring road");
});

test("the places that name the starting city do ask for the ring", function () {
  var js = fs.readFileSync(path.join(__dirname, "..", "qasr.js"), "utf8");
  var adopt = /function adoptPlace\([\s\S]*?\n  \}\n/.exec(js);
  assert.ok(adopt, "adoptPlace has gone");
  assert.ok(/cityWithRing\(/.test(adopt[0]),
    "adoptPlace names the city as soon as an address is picked, and must ask the ring road");
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
