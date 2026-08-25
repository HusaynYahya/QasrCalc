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

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
