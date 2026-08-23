/* ============================================================================
   QAṢR — THE RULING ENGINE
   ----------------------------------------------------------------------------
   Implements the pipeline of the Fiqh Specification (Sayyid al-Sīstānī),
   Tawḍīḥ al-Masā'il Jāmi' vol. 1, masā'il 1695–1790 and 1803–1808.

   One entry point: evaluate(trip) -> RulingSet.  No verdict is computed
   anywhere else.  Every Outcome carries at least one mas'ala number; a verdict
   that cannot cite one is a bug, not a ruling.

   No network, no DOM.  The interface reads this; it never rules.
   ========================================================================== */
(function (root) {
  "use strict";

  /* ---- §0, §A.2 the verdict lattice ------------------------------------- */

  var QASR  = "QASR";        /* Ẓuhr, ʿAṣr, ʿIshāʾ as two rakʿahs. Obligatory. */
  var JAMA  = "JAMA";        /* Pray both — only from iḥtiyāṭ wājib.           */
  var TAMAM = "TAMAM";       /* Four rakʿahs as normal.                        */
  var UNDETERMINED = "UNDETERMINED";

  var ORDER = { QASR: 0, JAMA: 1, TAMAM: 2 };

  function max(a, b) { return ORDER[a] >= ORDER[b] ? a : b; }

  function maxOf(verdicts) {
    return verdicts.reduce(function (acc, v) { return max(acc, v); }, QASR);
  }

  /* ---- §1 constants ------------------------------------------------------ */

  var FARSAKH_KM        = 5.5;      /* [1695] */
  var THRESHOLD_KM      = 44;       /* ḥadd masāfat sharʿī [1695] */
  var HALF_THRESHOLD_KM = 22;       /* 4 farsakh [1702], [1711] */
  var IQAMA_DAYS        = 10;       /* [1779] */
  var TARADDUD_DAYS     = 30;       /* [1713] — rulings themselves unsourced */

  /* There is no tolerance band.  43.9 km is under the threshold. [1698] §2.2 */

  function outcome(verdict, citations, reasoning) {
    return {
      verdict: verdict,
      citations: [].concat(citations),
      reasoning: reasoning
    };
  }

  /* ==========================================================================
     THE NINE CONDITIONS

     Each takes (segment, trip) and returns an Outcome.  None may return early
     out of the pipeline: a failing condition sets TAMAM for itself and
     evaluation continues, so the trace records why and not merely that. §A.5
     ========================================================================== */

  /* ---- Condition 1 — the distance, masāfat sharʿī [1695–1705] ------------ */

  function condition1(seg, trip) {
    /* §A.4 — a segment may inherit the distance condition outright. */
    if (seg.distanceSatisfiedByPrecedent) {
      return outcome(QASR, seg.precedentCitations || [1695],
        "The distance condition is granted to this segment by precedent, whatever its own length.");
    }

    /* A residence is not a travelling segment: it inherits whether the person
       arrived as a traveller.  [1719 fn.2] */
    if (seg.kind === "residence") {
      var arrived = trip._outboundDistance || QASR;
      return outcome(arrived, [1719],
        "At a place of residence the distance is not measured afresh; what matters is whether the journey there was itself a sharʿī distance.");
    }

    if (seg.distanceUncertain) {
      return outcome(TAMAM, [1698],
        "The distance is not known to reach 8 farsakh. Doubt about the distance resolves to full prayer, and investigation is not required.");
    }

    var counted = seg.km;
    var cites = [1695];
    var how = "This leg measures " + fmt(seg.km) + ".";

    if (trip._talfiqAvailable && seg.talfiqWith != null && trip._legKm[seg.talfiqWith] != null) {
      counted = seg.km + trip._legKm[seg.talfiqWith];
      cites.push(1696);
      how = "Outward and return are added together — " + fmt(seg.km) + " and " +
            fmt(trip._legKm[seg.talfiqWith]) + " — giving " + fmt(counted) +
            ". Neither leg need reach 4 farsakh on its own.";
    }

    /* [1718] the only place distance is deducted rather than added. */
    if (seg.hesitantKm > 0) {
      counted = Math.max(0, counted - seg.hesitantKm);
      cites.push(1718);
      how += " The " + fmt(seg.hesitantKm) + " covered while hesitant is subtracted, leaving " + fmt(counted) + ".";
    }

    seg._counted = counted;

    if (counted >= THRESHOLD_KM) {
      return outcome(QASR, cites, how + " That reaches the legal distance of 8 farsakh (" + fmt(THRESHOLD_KM) + ").");
    }
    return outcome(TAMAM, cites.concat(1698),
      how + " That is under the legal distance of 8 farsakh (" + fmt(THRESHOLD_KM) + "), so the prayer is full. There is no margin: under is under.");
  }

  /* ---- Condition 2 — intending the distance at the outset [1706–1711] ---- */

  function condition2(seg, trip) {
    var j = trip.journey || {};

    if (seg.kind === "residence") {
      return outcome(QASR, [1706], "Not a travelling segment; the condition does not bear on it.");
    }

    /* The dependent traveller — tābiʿ. [1710–1711] */
    if (j.tabi) {
      var t = j.tabi;
      if (t.separatesBeforeFourFarsakh === true || t.maySeparateBeforeFourFarsakh === true) {
        return outcome(TAMAM, [1711],
          "A follower who knows, or sees a rational possibility, that he will part from the principal before 4 farsakh prays full — a possible obstacle counts.");
      }
      if (t.knowsPrincipalsDistance === false) {
        if (t.learnedMidJourney && t.remainderReachesThreshold) {
          return outcome(QASR, [1710],
            "Learning mid-journey, with the remaining route — the return added — reaching 8 farsakh.");
        }
        return outcome(TAMAM, [1710],
          "A follower who does not know the principal's journey reaches 8 farsakh prays full. He is not obliged to ask, nor the principal to tell him.");
      }
      return outcome(QASR, [1710, 1711],
        "A follower who knows the principal's journey is 8 farsakh, and is confident of not parting before 4 farsakh.");
    }

    if (j.intendedFromOutset === false) {
      /* [1706] — but from the new point a fresh journey may qualify. */
      if (j.newJourneyFromHereQualifies === true) {
        return outcome(QASR, [1706],
          "The distance was not intended at the outset, but from the point of decision a fresh journey of 8 farsakh — or a round trip of 8 farsakh with no breaker between — is intended.");
      }
      return outcome(TAMAM, [1706],
        "The distance was not intended when setting out. Deciding to go further only after arriving does not make the earlier travel part of one journey.");
    }

    if (j.distanceUnknownAtOutset === true) {
      if (seg.kind === "return" && seg.km >= THRESHOLD_KM) {
        return outcome(QASR, [1707],
          "The outward distance was unknown, but the return to the waṭan or to a place of ten days' residence is itself 8 farsakh.");
      }
      return outcome(TAMAM, [1707],
        "One who does not know how far he will travel — searching for something lost, say — prays full.");
    }

    if (j.contingent === "notConfident") {
      return outcome(TAMAM, [1708],
        "The journey is conditional on something he is not confident of, so the intention is not settled.");
    }
    if (j.contingent === "confident") {
      return outcome(QASR, [1708],
        "The journey is conditional, but he is confident the condition will be met.");
    }

    if (j.slowTravelVerySmallDaily === true) {
      return outcome(JAMA, [1709],
        "Covering only a very small amount each day: obligatory precaution to pray both. The text gives no numeric line for 'very small'.");
    }

    return outcome(QASR, [1706], "The whole distance was intended when setting out.");
  }

  /* ---- Condition 3 — not abandoning the intention en route [1712–1718] --- */

  function condition3(seg, trip) {
    var a = (trip.journey || {}).abandonment;
    if (!a || seg.kind === "residence") {
      return outcome(QASR, [1712], "The intention was not abandoned en route.");
    }

    if (a.before4Farsakh === true && a.coveredPlusReturnUnderThreshold === true) {
      return outcome(TAMAM, [1712],
        "The intention was abandoned before 4 farsakh, and what was covered plus the return is under 8 farsakh. Obligatory precaution to repeat any prayer already shortened.");
    }

    if (a.roundTripAlreadyReachesThreshold === true) {
      switch (a.newIntention) {
        case "stay":
          return outcome(TAMAM, [1713], "On abandoning, he intends to stay there.");
        case "returnAfterTenDays":
          return outcome(TAMAM, [1713], "On abandoning, he intends to return only after ten days.");
        case "hesitantBetweenReturnAndTenDays":
          return outcome(TAMAM, [1713], "He is hesitant between returning and intending a ten-day stay.");
        case "mayRemainThirtyDays":
          return outcome(TAMAM, [1713], "There is a rational possibility of his remaining thirty days without forming an intention.");
        case "return":
          return outcome(QASR, [1714],
            "On abandoning, he intends to return, with no journey-breaker intervening. A different return route is no obstacle: out and back together are what count.");
      }
    }

    if (a.redirected === true) {
      return a.fromOriginalOriginReachesThreshold
        ? outcome(QASR, [1715], "Redirected mid-journey, but from the original starting point the new destination — alone or with the return — is 8 farsakh.")
        : outcome(TAMAM, [1715], "Redirected mid-journey, and from the original starting point the new destination does not reach 8 farsakh.");
    }

    if (a.hesitation) {
      var h = a.hesitation;
      if (h.travelledWhileHesitant === false) {
        return outcome(QASR, [1716], "He hesitated without covering any distance, then resolved to continue.");
      }
      if (h.thenIntendsFurtherThreshold === true) {
        return outcome(QASR, [1717], "Having hesitated, he then resolved on a further 8 farsakh, or on a point making the round trip 8 farsakh.");
      }
      /* [1718] handled arithmetically in condition 1 through seg.hesitantKm. */
      return outcome(QASR, [1718], "The distance covered while hesitant is subtracted before the distance is tested — see condition 1.");
    }

    return outcome(QASR, [1712], "The intention was not abandoned en route.");
  }

  /* ---- Condition 4 — no journey-breaker before the distance [1719–1721] -- */

  function condition4(seg, trip) {
    var b = trip.breakers || {};
    var r = trip.residence || {};

    if (seg.kind === "residence") {
      return residenceVerdict(trip);
    }

    if (b.mayPassAndStopInWatan === true || b.mayIntendTenDays === true) {
      return outcome(TAMAM, [1720],
        "There is a rational possibility of stopping in a waṭan, or of intending ten days' residence, before 8 farsakh is complete. Possibility is enough.");
    }

    if (b.intendedBreakerThenAbandoned === true) {
      return b.remainderWithReturnReachesThreshold
        ? outcome(QASR, [1721], "The intended breaker was abandoned, and the remaining route — the return added — is itself 8 farsakh.")
        : outcome(TAMAM, [1721], "An intended breaker was abandoned, but that does not restore the earlier ruling; the reckoning restarts from here.");
    }

    if (b.passesThroughWatan === "stops") {
      return outcome(TAMAM, [1770],
        "He alights and stops for a considerable period in his waṭan, which breaks the journey.");
    }
    if (b.passesThroughWatan === "passesOnly") {
      return outcome(JAMA, [1770],
        "Whether passing through the waṭan without a meaningful stop breaks the journey is problematic; the precaution is to pray both.");
    }

    /* Talfīq is gated here, not in the arithmetic. [1696 fn.1], [1719] */
    if (!trip._talfiqAvailable && seg.talfiqWith != null) {
      return outcome(QASR, [1719],
        "A breaker stands between the legs, so they are not added together; this leg is judged on its own length. See condition 1.");
    }

    return outcome(QASR, [1719], "No journey-breaker intervenes before the distance is complete.");
  }

  /* ---- the ten-day residence [1779–1808] --------------------------------- */

  function residenceVerdict(trip) {
    var r = trip.residence || {};
    var b = trip.breakers || {};

    if (b.destinationIsWatan === true) {
      return outcome(TAMAM, [1764, 1770],
        "The destination is his waṭan, where he prays full however far he travelled to reach it.");
    }

    if (r.intendsTenDays !== true) {
      return outcome(QASR, [1782],
        "No firm intention of ten consecutive days at this place, so the residence is not established.");
    }

    /* Condition 3 — one place, judged by name and never by distance. [1789–1790] */
    if (r.oneSettlement === false) {
      return outcome(QASR, [1789],
        "The ten days are split across two settlements — Najaf and Kūfa, Tehran and Karaj — which does not realise the intention, even where the two lie within sight of each other.");
    }
    if (r.oneSettlement === true && r.acrossDistricts === true) {
      /* [1790] districts of one city combine however far apart. */
    }

    /* Condition 2 — a firm decision. [1782–1788] */
    switch (r.certainty) {
      case "doubt":
      case "supposition":
        return outcome(QASR, [1782],
          "Doubt, or mere supposition, that he will stay ten days: he prays shortened even if he does in fact stay ten days.");
      case "contingentUncertain":
        return outcome(QASR, [1784],
          "The intention hangs on something uncertain — a friend arriving, lodging being found — which he doubts or merely supposes.");
      case "possibleObstacle":
        return outcome(QASR, [1785],
          "He allows a rationally significant possibility of an obstacle, so the intention is not firm — even if the obstacle never arises.");
      case "unknownPeriod":
        return outcome(QASR, [1786, 1788],
          "He intends to stay until a certain day, or to the month's end, without knowing whether that is ten days.");
      case "believedFewer":
        return outcome(QASR, [1787],
          "He believed the period fewer than ten days; the intention was never formed, whatever the period proved to be.");
    }

    /* Condition 1 — the ten-day clock. [1779] */
    if (r.arrival === "afterFajr" && r.makesUpFromDay11 !== true) {
      return outcome(QASR, [1779],
        "Arriving after the fajr adhān of day one without intending to make up the shortfall from day eleven, the ten days are not complete. The shortfall cannot be made up from night eleven.");
    }
    if (r.endsAtSunsetNotMaghrib === true) {
      return outcome(JAMA, [1779],
        "Intending to stay only until sunset on the tenth day, where the stay does not reach maghrib, the ten-day intention is doubtful: obligatory precaution to pray both.");
    }

    /* Conditions 5 and 6 — leaving during the residence. [1803–1807] */
    if (r.intentionSettled !== true && r.plannedSharaiTripWithinTen === true) {
      return outcome(QASR, [1804],
        "Before praying a four-rakʿah adā prayer he intends, or thinks it rationally possible, that he will travel the sharʿī distance and return within the ten days. The intention never settles — even if he never makes that trip.");
    }
    if (r.intentionSettled === true && r.sharaiTripHappened === true) {
      if (r.freshTenDayIntentionAfter === true) {
        return outcome(TAMAM, [1803], "The residence was broken by a trip to the sharʿī distance, but a fresh ten-day intention was formed on returning.");
      }
      return outcome(QASR, [1803],
        "The settled residence is broken by travelling out to the sharʿī distance and returning — even if that trip lasted under an hour.");
    }

    /* Condition 6 — short excursions under 4 farsakh. [1806] */
    if (r.excursion) {
      var e = r.excursion;
      if (e.beyondFirstTenDays === true) {
        return outcome(TAMAM, [1806],
          "The excursion falls beyond the first ten days, which does not disturb the residence, even lasting a day or more and repeated.");
      }
      if (e.urfSaysTwoResidences === true) {
        return outcome(QASR, [1806],
          "The pattern is repeated often enough that custom would say he resides in two places, so the ten-day intention is not realised.");
      }
      if (e.repetitions != null && e.repetitions > 3) {
        return outcome(JAMA, [1806],
          "Repeating the excursion more than two or three times is maḥall al-ishkāl; the precaution is to pray both.");
      }
      if (e.compatibleWithResidence === false) {
        return outcome(QASR, [1806],
          "An excursion customarily incompatible with ten days' residence — a whole day or a whole night away.");
      }
      return outcome(TAMAM, [1806],
        "An excursion customarily compatible with residence — an hour or two, or leaving after the ẓuhr adhān and returning after sunset.");
    }

    return outcome(TAMAM, [1779, 1808],
      "A firm intention of ten consecutive days in one place: he prays full, must keep the obligatory fast, and prays the nawāfil of ẓuhr, ʿaṣr and ʿishāʾ.");
  }

  /* ---- Condition 5 — the purpose must not be sinful [1722–1731] ---------- */

  function condition5(seg, trip) {
    var p = (seg.purpose || (trip.journey || {}).purpose || {});

    if (p.abandonedSinfulIntentionMidRoute === true) {
      return outcome(QASR, [1729],
        "The sinful intention was abandoned mid-route, and the prayer is shortened from then — whatever the remainder measures.");
    }
    if (p.turnedSinfulMidRoute === true) {
      return outcome(TAMAM, [1730],
        "A lawful journey turned to a sinful purpose mid-route. Prayers already shortened remain valid.");
    }
    if (p.believedForbiddenButWasNot === true) {
      return outcome(QASR, [1731], "He believed the purpose forbidden and it was not.");
    }
    if (p.forbiddenButDidNotMaterialise === true) {
      return outcome(TAMAM, [1731], "The purpose was forbidden though it did not come about — setting out to steal and failing.");
    }

    switch (p.kind) {
      case "sinful":
      case "haramTravelItself":
        return outcome(TAMAM, [1722], "The journey is for a forbidden purpose, or is itself forbidden.");
      case "distressesParent":
        return outcome(TAMAM, [1723], "A non-obligatory journey causing a parent distress born of compassion is forbidden; he prays full, and must fast.");
      case "escapingObligation":
        return outcome(TAMAM, [1725], "The journey is undertaken to escape an obligation — fleeing a debt he could pay and whose creditor is demanding it.");
      case "usurped":
        return outcome(TAMAM, [1726], "A usurped mount, flight from its owner, or travel over usurped land.");
      case "withOppressorFreely":
        return outcome(TAMAM, [1727], "Travelling with an oppressor, uncompelled, in a way that assists him.");
      case "withOppressorCompelled":
        return outcome(QASR, [1727], "Travelling with an oppressor under compulsion, or to rescue one wronged.");
      case "obligatory":
        return outcome(QASR, [1722], "Obligatory travel, such as Ḥajjat al-Islām.");
      case "sinsEnRoute":
        return outcome(QASR, [1724], "The journey is lawful though he sins along the way; the prayer is unaffected.");
      case "omitsDutyIncidentally":
        return outcome(QASR, [1725], "The journey is for another purpose, though a duty is thereby omitted.");
    }

    return outcome(QASR, [1722], "The purpose of the journey is lawful.");
  }

  /* ---- Condition 6 — not sport hunting, not futile [1732–1735] ----------- */

  function condition6(seg, trip) {
    var p = (seg.purpose || (trip.journey || {}).purpose || {});

    switch (p.kind) {
      case "sportHunting":
        if (seg.kind === "return" && p.returnAlsoSportHunting !== true) {
          return outcome(QASR, [1732],
            "The return from a sport-hunting journey is shortened, provided it is not itself for sport hunting, whether or not it reaches 8 farsakh alone.");
        }
        return outcome(TAMAM, [1732],
          "Travelling to hunt for amusement: he prays full on the way out, though the act itself is not forbidden.");
      case "huntingLivelihood":
        return outcome(QASR, [1733], "Hunting to earn a living.");
      case "huntingTrade":
        return outcome(QASR, [1733], "Hunting for trade or to increase wealth. Recommended precaution to pray both.");
      case "recreation":
        return outcome(QASR, [1734], "Travel for recreation or sightseeing is not forbidden, and the prayer is shortened.");
      case "futile":
        return outcome(JAMA, [1735],
          "A journey custom reckons futile — no rational purpose: obligatory precaution to pray both. A holiday is a rational purpose and is not this.");
    }
    return outcome(QASR, [1732], "Neither sport hunting nor a futile journey.");
  }

  /* ---- Condition 7 — his house does not travel with him [1736–1738] ------ */

  function condition7(seg, trip) {
    var p = trip.person || {};
    if (p.houseTravelsWithHim === true) {
      return outcome(TAMAM, [1736, 1737],
        "One whose dwelling travels with him — settling where he finds water and pasture — prays full. The test is the customary description, not the occupation.");
    }
    if (p.nomadWithoutHouse === true) {
      return outcome(QASR, [1737, 1738],
        "A nomad travelling without his dwelling, for lodging, pasture, ziyāra, ḥajj or trade, where 'his house is with him' does not hold.");
    }
    return outcome(QASR, [1736], "His house does not travel with him.");
  }

  /* ---- Condition 8 — travel is not his work, nor kathīr al-safar [1739–54] */

  function condition8(seg, trip) {
    var p = trip.person || {};

    if (p.noWatanAdopted === true) {
      return outcome(TAMAM, [1753], "One who tours cities and has adopted no waṭan prays full.");
    }
    if (p.hardshipFromExcessTravel === true) {
      return outcome(QASR, [1752],
        "One whose work is travel, for whom travelling more than usual brings hardship and fatigue.");
    }
    if (p.shortRadiusWorker === true) {
      return outcome(QASR, [1749],
        "A driver or pedlar working within 2–3 farsakh of the city who happens to make an 8-farsakh journey.");
    }

    /* [1750] — ten days' stay does NOT reset the ruling for Sīstānī. */
    if (p.kathirRulingApplies === true && p.stayedTenDaysBeforeThisJourney === true) {
      if (p.isMukari === true) {
        return outcome(TAMAM, [1750],
          "A kathīr al-safar who stayed ten days still prays full on the first journey after. For the mukārī specifically it is a recommended precaution to pray both.");
      }
      return outcome(TAMAM, [1750],
        "Staying ten days or more does not reset the ruling: he prays full on the first journey afterwards. Many summaries say otherwise; that is another marjaʿ's position.");
    }

    /* Group 1 — travel is the work itself. [1739], [1740], [1743] */
    if (p.workIsTravel === true) {
      if (p.workDescriptionHolds === false) {
        return outcome(QASR, [1740],
          "The description 'one whose work is travel' does not hold — the journeys are too far apart, as with a driver working only on Thursday nights.");
      }
      if (p.travellingForOtherThanWork === true && p.urfKathirOutright !== true) {
        return outcome(QASR, [1744],
          "Travelling for something other than the work — ziyāra or ḥajj — unless custom calls him kathīr al-safar outright.");
      }
      return outcome(TAMAM, [1739, 1743],
        "Travel at the sharʿī distance is his occupation, and the description holds from the very first journey, even if the work is temporary.");
    }

    /* Groups 2 and 3 — the numeric ladder. [1741] */
    if (p.kathirGroup === 2 || p.kathirGroup === 3) {
      if (p.breakMonths != null) {
        if (p.breakMonths >= 6) {
          return outcome(QASR, [1751], "The break in travelling has run to six months or more, and the ruling has lapsed.");
        }
        if (p.breakMonths >= 4) {
          return outcome(JAMA, [1751], "A break of four or five months is problematic; the precaution is to pray both.");
        }
      }
      if (p.frequencyMaterialised === false) {
        return outcome(JAMA, [1741, 1743],
          "The frequency has not yet materialised — the first two weeks of the pattern: obligatory precaution to pray both.");
      }
      var n = p.travelDaysPerMonth;
      if (n == null) {
        return outcome(TAMAM, [1741], "Kathīr al-safar by the customary description.");
      }
      if (n >= 10) return outcome(TAMAM, [1741], "Ten or more travel days, or ten journeys, in the month.");
      if (n >= 8)  return outcome(JAMA,  [1741], "Eight or nine travel days in the month: obligatory precaution to pray both.");
      return outcome(QASR, [1741], "Seven or fewer travel days in the month; the description does not hold.");
    }

    if (p.seasonal) {
      var s = p.seasonal;
      if (s.hamladarMonths != null) {
        if (s.hamladarMonths >= 3) return outcome(TAMAM, [1745], "A ḥamladār travelling three months a year or more.");
        if (s.hamladarMonths <= 2) return outcome(QASR, [1745], "A ḥamladār travelling two months a year or less.");
        return outcome(JAMA, [1745], "A ḥamladār between two and three months a year: obligatory precaution.");
      }
      if (s.inSeason === false) {
        return outcome(QASR, [1746, 1747], "Outside the season, where there is no regular programme of travel.");
      }
      if (s.breakWeeks != null) {
        if (s.breakWeeks <= 3) return outcome(TAMAM, [1748], "A short defined break of two or three weeks does not lift the ruling.");
        if (s.breakWeeks <= 6) return outcome(JAMA,  [1748], "A break of about a month: observe the precaution.");
        return outcome(QASR, [1748], "A break of two or three months or more: he prays shortened during it.");
      }
      return outcome(TAMAM, [1746], "Within the season in which the description holds.");
    }

    if (p.successiveGoodsJourneys === true) {
      return outcome(QASR, [1754],
        "One whose job is not travel but who makes successive journeys to carry his goods, and who does not qualify under [1741].");
    }

    return outcome(QASR, [1739], "Travel is neither his occupation nor his habit.");
  }

  /* ---- Condition 9 — ḥadd al-tarakhkhuṣ [1755–1763] ---------------------- */
  /* §A.7(6): never changes a verdict. It reports only where qaṣr begins.     */

  function condition9(seg, trip) {
    return outcome(QASR, [1755],
      "Where shortening begins is a matter of timing and never alters the ruling itself.");
  }

  function qasrBeginsAt(seg, trip) {
    var b = trip.breakers || {};
    if (seg.kind === "return") {
      return {
        where: "onEnteringWatan",
        citations: [1757],
        text: "Returning to his waṭan he prays shortened until he actually enters it; ḥadd al-tarakhkhuṣ has no bearing on the return. The same holds when heading for a place of ten days' residence: shortened until he reaches it."
      };
    }
    if (seg.departingFromWatan === false) {
      return {
        where: "onLeavingTheTown",
        citations: [1755],
        text: "Leaving somewhere that is not his waṭan, the prayer is shortened as soon as he leaves the town or village, intending the sharʿī distance. Ḥadd al-tarakhkhuṣ has no effect outside the waṭan."
      };
    }
    if (trip.tarakhkhus && trip.tarakhkhus.doubted === true) {
      return {
        where: "undetermined",
        citations: [1761],
        text: "While he doubts whether he has reached ḥadd al-tarakhkhuṣ, he prays full."
      };
    }
    return {
      where: "haddAlTarakhkhus",
      citations: [1755, 1756],
      text: "Leaving his waṭan he prays shortened on reaching ḥadd al-tarakhkhuṣ: the point at which the people of the town and its dependencies can no longer see him, the sign being that he cannot see them. The dependencies matter in a conurbation — the line lies beyond the continuous built-up area, not at the administrative boundary."
    };
  }

  var CONDITIONS = [
    { id: 1, fn: condition1 }, { id: 2, fn: condition2 }, { id: 3, fn: condition3 },
    { id: 4, fn: condition4 }, { id: 5, fn: condition5 }, { id: 6, fn: condition6 },
    { id: 7, fn: condition7 }, { id: 8, fn: condition8 }, { id: 9, fn: condition9 }
  ];

  /* ==========================================================================
     §A.3 — the pipeline
     ========================================================================== */

  function evaluate(trip) {
    trip = trip || {};
    var advisories = [];
    var undetermined = [];

    /* -- stage 0: the input gate ------------------------------------------ */
    undetermined = missingJudgements(trip);
    if (undetermined.length) {
      return {
        verdict: UNDETERMINED,
        segments: [],
        advisories: advisories,
        undetermined: undetermined
      };
    }

    /* -- stage 1: segment the trip ---------------------------------------- */
    var segments = buildSegments(trip);

    /* -- stage 5 (before 6): breaker analysis sets talfīq ------------------ */
    trip._talfiqAvailable = talfiqAvailable(trip);
    trip._legKm = {};
    segments.forEach(function (s) { if (s.kind !== "residence") trip._legKm[s.id] = s.km; });

    /* -- stage 7: precedent overrides ------------------------------------- */
    applyPrecedents(trip, segments);

    /* -- stages 3, 4, 6: every condition, every segment, no early return -- */
    segments.forEach(function (seg) {
      seg.outcomes = {};
      CONDITIONS.forEach(function (c) {
        seg.outcomes[c.id] = c.fn(seg, trip);
      });
      /* Condition 1 for a residence needs the outbound's own reading. */
      if (seg.kind === "outbound") trip._outboundDistance = seg.outcomes[1].verdict;
    });

    /* The residence inherits the outbound reading, so it is settled after. */
    segments.forEach(function (seg) {
      if (seg.kind === "residence") seg.outcomes[1] = condition1(seg, trip);
    });

    /* -- stage 8: combine through the lattice ----------------------------- */
    segments.forEach(function (seg) {
      seg.verdict = maxOf(CONDITIONS.map(function (c) { return seg.outcomes[c.id].verdict; }));
      /* -- stage 9: timing, which never alters a verdict ------------------ */
      seg.qasrBeginsAt = qasrBeginsAt(seg, trip);
    });

    collectAdvisories(trip, segments, advisories);

    /* -- stage 10: completeness ------------------------------------------- */
    assertComplete(segments);

    return {
      verdict: maxOf(segments.map(function (s) { return s.verdict; })),
      segments: segments,
      advisories: advisories,
      undetermined: []
    };
  }

  /* ---- stage 0 — §15, the judgements the software must refuse to make ---- */

  function missingJudgements(trip) {
    var missing = [];
    function need(value, question, why, cites) {
      if (value === undefined || value === null) {
        missing.push({ question: question, whyItMatters: why, citations: cites });
      }
    }

    var j = trip.journey || {}, p = trip.person || {}, b = trip.breakers || {};

    need(b.destinationIsWatan, "Is the destination one of your homelands (waṭan)?",
      "A waṭan is prayed in full however far away it is, and its kind governs several later branches.", [1764]);
    need(j.intendedFromOutset, "Did you intend the whole distance when you set out?",
      "Without the intention at the outset there is no journey to measure.", [1706]);
    need(p.kathirRulingApplies, "Is travel your work, or are you customarily one who travels often?",
      "Such a person prays full at any distance, so this is decided before the distance is.", [1739]);
    need((trip.residence || {}).intendsTenDays, "Will you stay ten continuous days at the destination?",
      "A firm ten-day intention makes you a resident there and stops the legs being added together.", [1779, 1719]);

    return missing;
  }

  /* ---- stage 1 — segments ------------------------------------------------ */

  function buildSegments(trip) {
    var legs = trip.legs || {};
    var out = [];

    out.push({
      id: "outbound", kind: "outbound", name: "On the way there",
      km: num(legs.outboundKm),
      hesitantKm: num(legs.hesitantKm) || 0,
      distanceUncertain: legs.distanceUncertain === true,
      departingFromWatan: legs.departingFromWatan !== false,
      purpose: (trip.journey || {}).purpose
    });

    if (trip.residence && trip.residence.atDestination !== false) {
      out.push({ id: "residence", kind: "residence", name: "At the destination" });
    }

    if (legs.returning === true) {
      out.push({
        id: "return", kind: "return", name: "On the way back",
        km: num(legs.returnKm != null ? legs.returnKm : legs.outboundKm),
        hesitantKm: 0,
        distanceUncertain: legs.distanceUncertain === true,
        departingFromWatan: false,
        purpose: (trip.journey || {}).returnPurpose || (trip.journey || {}).purpose
      });
    }

    /* Talfīq pairs the two travelling legs, if the breakers allow it. */
    if (legs.returning === true) {
      out[0].talfiqWith = "return";
      out[out.length - 1].talfiqWith = "outbound";
    }
    return out;
  }

  /* ---- stage 5 — is talfīq available? [1696 fn.1], [1719] ---------------- */

  function talfiqAvailable(trip) {
    var b = trip.breakers || {}, r = trip.residence || {};
    if (r.intendsTenDays === true) return false;      /* [1719] */
    if (b.destinationIsWatan === true) return false;  /* [1719] second case */
    if (b.passesThroughWatan === "stops") return false;
    if (b.shuttlingUnderFourFarsakh === true) return false;  /* [1702] */
    return true;
  }

  /* ---- stage 7 — §A.4 precedent overrides -------------------------------- */

  function applyPrecedents(trip, segments) {
    var j = trip.journey || {}, p = j.purpose || {};
    segments.forEach(function (seg) {
      if (seg.kind !== "return") return;
      if (p.kind === "sinful" && j.returnIsSinful !== true) {
        seg.distanceSatisfiedByPrecedent = true;
        seg.precedentCitations = [1728];
      }
      if (p.kind === "sportHunting" && p.returnAlsoSportHunting !== true) {
        seg.distanceSatisfiedByPrecedent = true;
        seg.precedentCitations = [1732];
      }
    });
    if (p.abandonedSinfulIntentionMidRoute === true) {
      segments.forEach(function (seg) {
        seg.distanceSatisfiedByPrecedent = true;
        seg.precedentCitations = [1729];
      });
    }
    var a = j.abandonment;
    if (a && a.breakerAbandoned === true && a.remainderWithReturnReachesThreshold === true) {
      segments.forEach(function (seg) {
        if (seg.kind !== "residence") {
          seg.distanceSatisfiedByPrecedent = true;
          seg.precedentCitations = [1721];
        }
      });
    }
    if (j.tabi && j.tabi.learnedMidJourney === true && j.tabi.remainderReachesThreshold === true) {
      segments.forEach(function (seg) {
        if (seg.kind !== "residence") {
          seg.distanceSatisfiedByPrecedent = true;
          seg.precedentCitations = [1710];
        }
      });
    }
  }

  /* ---- recommended precautions — never verdicts. §0, §A.2 ---------------- */

  function collectAdvisories(trip, segments, advisories) {
    var j = trip.journey || {}, p = j.purpose || {}, legs = trip.legs || {};

    if (legs.returning === true && legs.returnsLaterDay === true && trip._talfiqAvailable) {
      advisories.push({ kind: "MUSTAHABB", citations: [1697],
        text: "Out and back reach 8 farsakh though the return falls on a later day. The prayer is shortened; it is a recommended precaution — not an obligation — also to pray it full." });
    }
    if (p.kind === "sinful" && !j.repented) {
      advisories.push({ kind: "MUSTAHABB", citations: [1728],
        text: "On the return from a journey undertaken for sin, it is a recommended precaution to pray both if he has not repented." });
    }
    if (p.kind === "huntingTrade") {
      advisories.push({ kind: "MUSTAHABB", citations: [1733],
        text: "Hunting for trade: recommended precaution to pray both." });
    }
    if (legs.distanceUncertain === true) {
      advisories.push({ kind: "MUSTAHABB", citations: [1698],
        text: "Where the distance is doubtful the prayer is full and investigation is not required — though investigating is a recommended precaution." });
    }
    if ((trip.person || {}).isMukari === true && (trip.person || {}).stayedTenDaysBeforeThisJourney === true) {
      advisories.push({ kind: "MUSTAHABB", citations: [1750],
        text: "For the mukārī, a recommended precaution to pray both on the first journey after a ten-day stay." });
    }
  }

  /* ---- stage 10 — §A.5 completeness -------------------------------------- */

  function assertComplete(segments) {
    segments.forEach(function (seg) {
      CONDITIONS.forEach(function (c) {
        var o = seg.outcomes[c.id];
        if (!o) throw new Error("condition " + c.id + " never evaluated for segment " + seg.id);
        if (!o.citations || !o.citations.length) {
          throw new Error("condition " + c.id + " produced a verdict with no mas'ala citation, segment " + seg.id);
        }
      });
      var expected = maxOf(CONDITIONS.map(function (c) { return seg.outcomes[c.id].verdict; }));
      if (seg.verdict !== expected) {
        throw new Error("segment " + seg.id + " verdict " + seg.verdict + " is not the lattice maximum " + expected);
      }
    });
  }

  /* ---- small helpers ----------------------------------------------------- */

  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
  function fmt(km) { return (Math.round(km * 10) / 10) + " km"; }

  root.Fiqh = {
    evaluate: evaluate,
    QASR: QASR, JAMA: JAMA, TAMAM: TAMAM, UNDETERMINED: UNDETERMINED,
    FARSAKH_KM: FARSAKH_KM, THRESHOLD_KM: THRESHOLD_KM,
    HALF_THRESHOLD_KM: HALF_THRESHOLD_KM,
    IQAMA_DAYS: IQAMA_DAYS, TARADDUD_DAYS: TARADDUD_DAYS,
    max: max, maxOf: maxOf
  };
})(typeof window !== "undefined" ? window : globalThis);
