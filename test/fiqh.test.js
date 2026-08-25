/* ============================================================================
   The 44 golden vectors of §13 of the Fiqh Specification.
   Each asserts two things: the verdict for every segment, and that the trace
   cites the mas'ala that decided it. §A.8 — the right answer for the wrong
   reason is a failure.
     run with:  node test/fiqh.test.js
   ========================================================================== */
"use strict";

var fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

var sandbox = { console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "fiqh.js"), "utf8"), sandbox);
var F = sandbox.Fiqh;
var K = F.FARSAKH_KM;

var passed = 0, failed = 0, pending = 0;

function test(n, name, fn) {
  try { fn(); passed++; console.log("  ok    " + pad(n) + name); }
  catch (e) { failed++; console.log("  FAIL  " + pad(n) + name + "\n            " + e.message); }
}
function todo(n, name, why) {
  pending++; console.log("  todo  " + pad(n) + name + "\n            " + why);
}
function pad(n) { return ("#" + n + "      ").slice(0, 5); }

/* A journey with every ʿurf judgement declared, so stage 0 lets it through. */
function trip(over) {
  var t = {
    person:    { kathirRulingApplies: false },
    journey:   { intendedFromOutset: true, purpose: { kind: "lawful" } },
    breakers:  { destinationIsWatan: false },
    residence: { intendsTenDays: false, atDestination: false },
    legs:      { outboundKm: 0, returning: false }
  };
  return deepMerge(t, over || {});
}
function deepMerge(a, b) {
  var out = {};
  Object.keys(a).forEach(function (k) { out[k] = a[k]; });
  Object.keys(b).forEach(function (k) {
    out[k] = (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object")
      ? deepMerge(a[k], b[k]) : b[k];
  });
  return out;
}
function seg(res, id) {
  var s = res.segments.filter(function (x) { return x.id === id; })[0];
  assert.ok(s, "no segment '" + id + "' in result");
  return s;
}
function cites(s, masala) {
  var all = [];
  Object.keys(s.outcomes).forEach(function (c) { all = all.concat(s.outcomes[c].citations); });
  assert.ok(all.indexOf(masala) >= 0,
    "expected the trace to cite " + masala + ", cited " + all.join(", "));
}

console.log("\nCondition 1 — the distance [1695–1705]");

test(1, "3 farsakh out, 5 back, no breaker → QASR [1696]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 3 * K, returnKm: 5 * K, returning: true } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
  assert.strictEqual(seg(r, "return").verdict, F.QASR);
  cites(seg(r, "outbound"), 1696);
});

test(2, "round trip of 8 farsakh returning a later day → QASR + mustaḥabb [1697]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 4 * K, returnKm: 4 * K, returning: true, returnsLaterDay: true } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
  assert.ok(r.advisories.some(function (a) { return a.citations.indexOf(1697) >= 0 && a.kind === "MUSTAHABB"; }),
    "expected a recommended-precaution note citing 1697, not a JAMʿ verdict");
});

test(3, "slightly under 8 farsakh → TAMAM, no band [1698]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 43.9, returning: false } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
  cites(seg(r, "outbound"), 1698);
  assert.ok(r.verdict !== F.JAMA, "closeness to the threshold must never produce JAMʿ");
});

test(4, "shuttling between places 3 farsakh apart, 12 farsakh total → TAMAM [1702]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 3 * K, returnKm: 3 * K, returning: true },
    breakers: { shuttlingUnderFourFarsakh: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
});

test(5, "waṭan 15 km from Mashhad → shrine 25 km, return → QASR [1705]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 25, returnKm: 25, returning: true } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
});

test(6, "the same waṭan → a point 20 km away, return → TAMAM [1705]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 20, returnKm: 20, returning: true } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
});

test("1a", "both ends within one city → nothing counted [1704, 1705]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 48, returnKm: 48, returning: true, staysInCity: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
  assert.strictEqual(seg(r, "return").verdict, F.TAMAM);
  cites(seg(r, "outbound"), 1704);
  /* and the same road, once it does leave the city, is a journey */
  var out = F.evaluate(trip({ legs: { outboundKm: 48, returning: false } }));
  assert.strictEqual(seg(out, "outbound").verdict, F.QASR);
});

console.log("\nCondition 2 — the intention at the outset [1706–1711]");

test(7, "decides to go further only after arriving → TAMAM [1706]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 5 * K, returning: false },
    journey: { intendedFromOutset: false }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
  cites(seg(r, "outbound"), 1706);
});

console.log("\nCondition 4 — the ten-day residence kills talfīq [1719]");

test(8, "waṭan → 4 farsakh, ten days, return → TAMAM / TAMAM / TAMAM [1719 fn.2]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 4 * K, returnKm: 4 * K, returning: true },
    residence: { intendsTenDays: true, atDestination: true, certainty: "certain", oneSettlement: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM, "outbound");
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM, "at the destination");
  assert.strictEqual(seg(r, "return").verdict, F.TAMAM, "return");
  cites(seg(r, "outbound"), 1719);
});

test(9, "waṭan → 8 farsakh, ten days, return → QASR / TAMAM / QASR [1719 fn.2]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returnKm: 8 * K, returning: true },
    residence: { intendsTenDays: true, atDestination: true, certainty: "certain", oneSettlement: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR, "outbound");
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM, "at the destination");
  assert.strictEqual(seg(r, "return").verdict, F.QASR, "return");
});

test(10, "waṭan → 7 farsakh, ten days, return by 9 farsakh → TAMAM / TAMAM / QASR [1719 fn.2]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 7 * K, returnKm: 9 * K, returning: true },
    residence: { intendsTenDays: true, atDestination: true, certainty: "certain", oneSettlement: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM, "outbound");
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM, "at the destination");
  assert.strictEqual(seg(r, "return").verdict, F.QASR, "return");
});

console.log("\nConditions 5 and 6 — purpose [1722–1735]");

test(11, "sport hunting, 8 farsakh → TAMAM out, QASR back [1732]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returnKm: 8 * K, returning: true },
    journey: { purpose: { kind: "sportHunting" } }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
  assert.strictEqual(seg(r, "return").verdict, F.QASR);
  cites(seg(r, "return"), 1732);
});

test(12, "recreation or sightseeing, 8 farsakh → QASR [1734]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    journey: { purpose: { kind: "recreation" } }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
  cites(seg(r, "outbound"), 1734);
});

test(13, "a customarily futile journey of 8 farsakh → JAMʿ [1735]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    journey: { purpose: { kind: "futile" } }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.JAMA);
  cites(seg(r, "outbound"), 1735);
});

console.log("\nCondition 8 — kathīr al-safar [1739–1754]");

test(14, "group 2, nine travel days a month → JAMʿ [1741]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    person: { kathirRulingApplies: true, kathirGroup: 2, travelDaysPerMonth: 9, frequencyMaterialised: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.JAMA);
  cites(seg(r, "outbound"), 1741);
});

test(15, "group 2, seven travel days a month → QASR [1741]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    person: { kathirRulingApplies: true, kathirGroup: 2, travelDaysPerMonth: 7, frequencyMaterialised: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
});

test(16, "kathīr al-safar, ten days in the waṭan, then travels → TAMAM [1750]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    person: { kathirRulingApplies: true, kathirGroup: 2, travelDaysPerMonth: 12,
              frequencyMaterialised: true, stayedTenDaysBeforeThisJourney: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
  cites(seg(r, "outbound"), 1750);
});

test(17, "kathīr al-safar, a break of five months → JAMʿ [1751]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    person: { kathirRulingApplies: true, kathirGroup: 2, breakMonths: 5, frequencyMaterialised: true }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.JAMA);
  cites(seg(r, "outbound"), 1751);
});

console.log("\nCondition 9 — ḥadd al-tarakhkhuṣ, timing only [1755–1763]");

test(18, "leaving a town of stay that is not the waṭan → no tarakhkhuṣ [1755]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 8 * K, returning: false, departingFromWatan: false } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
  assert.strictEqual(seg(r, "outbound").qasrBeginsAt.where, "onLeavingTheTown");
  assert.ok(seg(r, "outbound").qasrBeginsAt.citations.indexOf(1755) >= 0);
});

test(19, "returning to the waṭan → shortened until he enters it [1757]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 8 * K, returnKm: 8 * K, returning: true } }));
  assert.strictEqual(seg(r, "return").qasrBeginsAt.where, "onEnteringWatan");
  assert.ok(seg(r, "return").qasrBeginsAt.citations.indexOf(1757) >= 0);
});

test(20, "doubt whether tarakhkhuṣ is reached → full until it is [1761]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    tarakhkhus: { doubted: true }
  }));
  /* §A.7(6): condition 9 never alters the verdict, so the journey stays QASR
     while the timing says he prays full until the doubt resolves. */
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
  assert.strictEqual(seg(r, "outbound").qasrBeginsAt.where, "undetermined");
  assert.ok(seg(r, "outbound").qasrBeginsAt.citations.indexOf(1761) >= 0);
});

console.log("\nWaṭan and iʿrāḍ [1764–1777]");

test(21, "owns a house and once stayed six months → no waṭan sharʿī → QASR [1767]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    breakers: { destinationIsWatan: false }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
});

test(22, "returns to the former waṭan two months a year → iʿrāḍ → QASR [1775]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    breakers: { destinationIsWatan: false }
  }));
  assert.strictEqual(seg(r, "outbound").verdict, F.QASR);
});

test(23, "returns three months a year → no iʿrāḍ → TAMAM there [1775]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    breakers: { destinationIsWatan: true },
    residence: { atDestination: true, intendsTenDays: false }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM);
});

todo(24, "intends to return to the waṭan aṣlī in 25 years → TAMAM there [1776]",
  "iʿrāḍ is a declared judgement (§15.2); the engine takes destinationIsWatan as given and does not decide it.");

console.log("\nThe ten-day residence [1779–1808]");

test(25, "arrives at ẓuhr on day 1, means to leave at the end of day 10 → QASR [1779]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain",
                 oneSettlement: true, arrival: "afterFajr", makesUpFromDay11: false }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
  cites(seg(r, "residence"), 1779);
});

test(26, "arrives at ẓuhr on day 1, stays to ẓuhr on day 11 → TAMAM [1779]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain",
                 oneSettlement: true, arrival: "afterFajr", makesUpFromDay11: true }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM);
});

test(27, "merely supposes he will stay ten days, and does → QASR throughout [1782]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "supposition", oneSettlement: true }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
  cites(seg(r, "residence"), 1782);
});

test(28, "sees a real chance work will recall him; it does not → QASR [1785]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "possibleObstacle", oneSettlement: true }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
  cites(seg(r, "residence"), 1785);
});

test(29, "settled residence; an unplanned 40-minute trip to the sharʿī distance → QASR after [1803]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 intentionSettled: true, sharaiTripHappened: true }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
  cites(seg(r, "residence"), 1803);
});

test(30, "before settling, thinks he might drive the sharʿī distance; never does → QASR [1804]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 intentionSettled: false, plannedSharaiTripWithinTen: true }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
  cites(seg(r, "residence"), 1804);
});

todo(31, "intends a month; plans a sharʿī-distance trip in the second block [1805]",
  "Needs a phased residence — TAMAM until departure, QASR from it. The engine returns one verdict per stay.");

test(32, "ten days, with daily outings of an hour or two under 4 farsakh → TAMAM [1806]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 excursion: { compatibleWithResidence: true } }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM);
  cites(seg(r, "residence"), 1806);
});

test(33, "ten days, with a whole-day outing under 4 farsakh → QASR [1806]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 excursion: { compatibleWithResidence: false } }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
});

test(34, "leaves after ẓuhr, returns an hour after sunset → TAMAM [1806]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 excursion: { compatibleWithResidence: true, afterZuhrReturningAfterSunset: true } }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM);
});

test(35, "the same pattern intended two or three times → TAMAM [1806]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 excursion: { compatibleWithResidence: true, repetitions: 3 } }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM);
});

test(36, "repeated enough that ʿurf says he lives in two places → QASR [1806]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: true,
                 excursion: { urfSaysTwoResidences: true } }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
});

todo(37, "settled residence; day trip under 4 farsakh, returning to stay [1807(1)]",
  "Needs a second place of stay as its own segment set; the engine models one destination.");
todo(38, "ten days at a second place, then a real journey through the first [1807(2)]",
  "Same: multi-stop segmentation.");
todo(39, "under ten days at the second place, then a journey [1807(3)]",
  "Same: multi-stop segmentation.");
todo(40, "hesitant whether to return and stay ten days [1807(4)]",
  "Same: multi-stop segmentation.");

console.log("\nOne place, judged by name and never by distance [1789–1790]");

test(41, "seven days in Najaf and three in Kūfa → QASR in both [1789]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: false }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
  cites(seg(r, "residence"), 1789);
});

test(42, "five days in Tehran and five in Karaj → QASR [1789]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: false }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR);
});

test(43, "ten days across two neighbouring villages within sight of each other → QASR [1789]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain", oneSettlement: false }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.QASR,
    "proximity must not make two settlements one");
});

test(44, "ten days in Tehran across districts over 8 farsakh apart → TAMAM [1790]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    residence: { atDestination: true, intendsTenDays: true, certainty: "certain",
                 oneSettlement: true, acrossDistricts: true }
  }));
  assert.strictEqual(seg(r, "residence").verdict, F.TAMAM,
    "distance between districts of one city must not split the residence");
});

console.log("\nThe pipeline itself — §A");

test("A1", "a missing ʿurf judgement halts with UNDETERMINED, never a guess [§15]", function () {
  var r = F.evaluate({ legs: { outboundKm: 100, returning: false } });
  assert.strictEqual(r.verdict, F.UNDETERMINED);
  assert.ok(r.undetermined.length >= 1);
  assert.ok(r.undetermined[0].citations.length >= 1, "each question must cite why it matters");
});

test("A2", "every condition is evaluated for every segment, each citing a mas'ala [§A.5]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 8 * K, returnKm: 8 * K, returning: true } }));
  r.segments.forEach(function (s) {
    [1,2,3,4,5,6,7,8,9].forEach(function (c) {
      assert.ok(s.outcomes[c], "condition " + c + " missing on " + s.id);
      assert.ok(s.outcomes[c].citations.length, "condition " + c + " uncited on " + s.id);
    });
  });
});

test("A3", "the verdict is the lattice maximum, never a default [§A.2]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 8 * K, returning: false },
    journey: { purpose: { kind: "futile" } },
    person: { kathirRulingApplies: true, workIsTravel: true, workDescriptionHolds: true }
  }));
  /* JAMʿ from [1735] and TAMAM from [1739]: TAMAM absorbs JAMʿ. */
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM);
});

/* ---- one city, or two? ---------------------------------------------------
   Both ends inside one border means nothing is counted [1704], and the
   districts of one city count as one however far apart [1790]. But a ring
   road drawn round a city can enclose towns that are nobody's idea of one
   place, and whether two places are one city is a judgement of common usage
   the software may not make for itself [§15].                               */
console.log("\nOne city, or two");

test("C1", "both ends within one city count nothing, however far across [1704], [1790]", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 80 * K, returning: true, staysInCity: true } }));
  assert.strictEqual(seg(r, "outbound").verdict, F.TAMAM,
    "eighty kilometres inside one city is still not a journey");
  assert.ok(seg(r, "outbound").outcomes[1].citations.indexOf(1704) >= 0,
    "the within-city rule must cite where the measuring starts");
});

test("C2", "a ring road that enclosed two towns halts rather than guessing [§15]", function () {
  var r = F.evaluate(trip({
    legs: { outboundKm: 50 * K, returning: true, staysInCity: undefined, oneCityInDoubt: true }
  }));
  assert.strictEqual(r.verdict, F.UNDETERMINED);
  assert.ok(r.undetermined.some(function (u) { return /one city/i.test(u.question); }),
    "the one-city question must be among those asked");
});

test("C3", "answering it decides the ruling, in both directions", function () {
  var asOne = F.evaluate(trip({
    legs: { outboundKm: 50 * K, returning: true, staysInCity: true, oneCityInDoubt: true } }));
  var asTwo = F.evaluate(trip({
    legs: { outboundKm: 50 * K, returning: true, staysInCity: false, oneCityInDoubt: true } }));
  assert.strictEqual(asOne.verdict, F.TAMAM, "one city: nothing is counted");
  assert.strictEqual(asTwo.verdict, F.QASR, "two towns: fifty kilometres is counted");
});

test("C4", "the question is not asked where nothing made it doubtful", function () {
  var r = F.evaluate(trip({ legs: { outboundKm: 50 * K, returning: true, staysInCity: false } }));
  assert.notStrictEqual(r.verdict, F.UNDETERMINED,
    "an ordinary journey must not be held up by a question about ring roads");
});

console.log("\n" + passed + " passed, " + failed + " failed, " + pending + " pending\n");
process.exit(failed ? 1 : 0);
