/* ============================================================================
   QASR CALCULATOR
   ----------------------------------------------------------------------------
   Takes a starting address and a destination, measures the road distance
   between them, and applies the rulings of Sayyid Ali al-Sistani on the
   prayers and fast of a traveller.

   Three parts, in order:
     1. Geography — geocoding (Nominatim) and routing (OSRM), with a
        straight-line fallback and a manual override when either is unreachable.
     2. The ruling engine — a pure function: circumstances in, verdict out.
        No network, no DOM. This is the part worth reading.
     3. The interface — form wiring and rendering.
   ========================================================================== */
(function () {
  "use strict";

  /* ---- constants ------------------------------------------------------- */

  /* Eight farsakh. One farsakh is three miles, about 5.5 km, so the legal
     distance is roughly 44 km. Sources differ by a few hundred metres either
     way, which is why NEAR_KM below asks for caution close to the line.       */
  var FARSAKH_KM = 5.5;
  var LIMIT_KM   = 8 * FARSAKH_KM;   /* 44 km */
  var NEAR_KM    = 2;                /* caution band on either side of the limit */
  var KM_PER_MI  = 1.609344;

  var NOMINATIM = "https://nominatim.openstreetmap.org/search";
  /* Nominatim wants a fairly complete address before it will answer, which
     makes it a poor companion while someone is still typing. Photon indexes
     the same OpenStreetMap data for type-ahead: partial words, fuzzy
     spelling, and no one-a-second limit. It answers the suggestions;
     Nominatim keeps the boundary work, which it does better.                 */
  var PHOTON = "https://photon.komoot.io/api/";
  var PHOTON_NEAR = "https://photon.komoot.io/reverse";
  var OSRM      = "https://router.project-osrm.org/route/v1/driving/";

  /* ==========================================================================
     1. GEOGRAPHY
     ========================================================================== */

  /* Nominatim asks for no more than one request a second, and enforces it.
     Every call to it goes through this queue, which spaces them out; firing
     two at once — both addresses, or both city lookups — earns a refusal that
     looks from the outside like the page being broken.                       */
  var nomTurn = Promise.resolve();
  var nomLast = 0;

  function nominatim(url, opts) {
    function run() {
      if (opts && opts.signal && opts.signal.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      var wait = Math.max(0, 1100 - (Date.now() - nomLast));
      return new Promise(function (go) { setTimeout(go, wait); })
        .then(function () {
          nomLast = Date.now();
          return fetch(url, opts);
        });
    }
    var turn = nomTurn.then(run, run);
    nomTurn = turn.catch(function () {});   /* one failure must not stall the queue */
    return turn;
  }

  function nominatimError(status) {
    return status === 429 || status === 403
      ? new Error("The address service is refusing requests just now — it allows only one a second. Wait a few seconds and press Calculate again.")
      : new Error("The address service returned " + status + ".");
  }

  var geocodeCache = Object.create(null);

  /* Build a readable line from Photon's parts, without repeating itself. */
  function photonLabel(p) {
    var head = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.street;
    var rest = [p.district, p.city || p.town || p.village, p.county, p.state, p.country];
    var seen = Object.create(null), out = [];
    [head].concat(rest).forEach(function (part) {
      if (!part || seen[part]) return;
      seen[part] = true;
      out.push(part);
    });
    return out.join(", ");
  }

  /* Suggestions while typing. Biased towards a place already chosen, so the
     second address is looked for near the first.                             */
  function suggest(query, near, signal) {
    var url = PHOTON + "?limit=8&lang=en&q=" + encodeURIComponent(query) +
              (near ? "&lat=" + near.lat + "&lon=" + near.lon : "");

    return fetch(url, { signal: signal, headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Search returned " + r.status);
        return r.json();
      })
      .then(function (data) {
        return (data.features || []).map(function (f) {
          return {
            label: photonLabel(f.properties || {}),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0]
          };
        }).filter(function (p) { return p.label; });
      })
      .then(function (found) {
        /* Type-ahead is weak on postcodes and plot numbers; the older search
           is better at them, so an empty answer is worth a second opinion.   */
        return found.length ? found : geocode(query, 6, signal);
      })
      .catch(function (err) {
        if (err.name === "AbortError") throw err;
        return geocode(query, 6, signal);
      });
  }

  function geocode(query, limit, signal) {
    var key = limit + "|" + query.toLowerCase();
    if (geocodeCache[key]) return Promise.resolve(geocodeCache[key]);

    var url = NOMINATIM + "?format=jsonv2&addressdetails=1&limit=" + limit +
              "&q=" + encodeURIComponent(query);

    return nominatim(url, { signal: signal, headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw nominatimError(r.status);
        return r.json();
      })
      .then(function (rows) {
        var places = (rows || []).map(function (row) {
          return {
            label: row.display_name,
            lat: parseFloat(row.lat),
            lon: parseFloat(row.lon)
          };
        });
        geocodeCache[key] = places;
        return places;
      });
  }

  /* The city a point falls in, with its boundary where one is published.
     Nominatim's reverse lookup at zoom 10 answers at city level; the polygon
     is what the map draws and what the border deduction is measured against. */
  var cityCache = Object.create(null);

  /* The border must be a town's or a city's. A district, a borough, a county
     or a region is not what the law means by leaving town, so a lookup that
     answers with one is taken only for the settlement name it carries, and
     the settlement's own boundary is fetched instead.                        */
  var SETTLEMENT = /^(city|town|village|municipality)$/;

  function cityOf(place) {
    return cityAt(place, 10).then(function (city) {
      if (!city.name) return city;
      if (SETTLEMENT.test(city.kind || "") && city.shape) return city;
      /* Named, but the shape belongs to something larger or smaller. */
      return cityByName(city.name, place).catch(function () {
        return { name: city.name, area: city.area, shape: null };
      });
    });
  }

  /* Zoom 12 answers with the town, 10 with the city. Which of them is "your
     city" is a judgment of common usage, so both are offered and the reader
     chooses; the county is not offered at all.                               */
  function cityAt(place, zoom) {
    var key = zoom + "|" + place.lat.toFixed(3) + "," + place.lon.toFixed(3);
    if (cityCache[key]) return Promise.resolve(cityCache[key]);

    var url = NOMINATIM.replace("/search", "/reverse") +
              "?format=jsonv2&zoom=" + zoom + "&addressdetails=1&polygon_geojson=1" +
              "&lat=" + place.lat + "&lon=" + place.lon;

    return nominatim(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw nominatimError(r.status);
        return r.json();
      })
      .then(function (row) {
        var a = row.address || {};
        var city = {
          name: a.city || a.town || a.village || a.municipality || null,
          area: a.county || a.state || a.country || null,
          kind: row.addresstype || null,
          /* Only an area has a border to draw; a point result has none. */
          shape: row.geojson && /Polygon/.test(row.geojson.type) ? row.geojson : null
        };
        cityCache[key] = city;
        return city;
      })
      .catch(function (err) {
        return { name: null, area: null, shape: null, reason: err && err.message };
      });
  }

  /* The candidates for "your city", nearest first, without repeats. */
  function cityChoices(place) {
    var found = [];
    return [12, 10].reduce(function (chain, zoom) {
      return chain.then(function () {
        return cityAt(place, zoom).then(function (city) {
          if (!city || !city.name) return;
          if (found.some(function (c) { return c.name === city.name; })) return;
          if (SETTLEMENT.test(city.kind || "") && city.shape) { found.push(city); return; }
          /* Named by a district or a county — take the settlement itself. */
          return cityByName(city.name, place)
            .then(function (settlement) {
              /* Keep whichever knows the border. A named lookup that comes
                 back without one must not displace a shape already found.    */
              found.push(settlement.shape ? settlement : (city.shape ? city : settlement));
            })
            .catch(function () { found.push(city); });
        });
      });
    }, Promise.resolve())
      .then(function () { return biggestCityNear(place); })
      .then(function (big) {
        if (!big) return found;
        if (found.some(function (c) { return c.name === big.name; })) return found;
        return cityByName(big.name)
          .then(function (settlement) {
            settlement.note = "the largest city nearby, " + fmtKm(big.away) + " away";
            /* Ahead of the smaller alternatives: it is the one a reader is
               least likely to think of, and most likely to want.             */
            found.unshift(settlement);
            return found;
          })
          .catch(function () { return found; });
      });
  }

  /* The largest city within reach, whether or not the reader lives in it.
     Someone in Watford is unlikely to be offered London by any lookup that
     asks what administrative area they stand in — but London's edge may well
     be the one they would call leaving town, so it is always on the list.

     Both place=city and place=town are asked for, because which tier a large
     settlement carries varies by country, and size is then measured rather
     than assumed. Bounding boxes are compared in square kilometres, not in
     degrees: a degree of longitude is 111 km at the equator and 48 km at
     Helsinki, so degrees alone would call northern cities the larger.        */
  /* Wide enough for a metropolitan commuter belt anywhere — London's is about
     40 km, Tokyo's 60, Los Angeles' 70 — without offering a city nobody would
     claim. Nothing is forced: the distance is shown and the reader chooses.  */
  var NEAR_CITY_KM = 75;

  /* Photon's extent is [west, north, east, south], in degrees. */
  function extentKm2(e, lat) {
    if (!e || e.length < 4) return 0;
    var dLon = Math.abs(e[2] - e[0]);
    if (dLon > 180) dLon = 360 - dLon;          /* across the antimeridian */
    var dLat = Math.abs(e[1] - e[3]);
    return (dLat * 111.32) * (dLon * 111.32 * Math.cos(lat * Math.PI / 180));
  }

  /* Overpass is often busy, and a single host answering slowly should not cost
     the reader the option. Each is tried in turn.                            */
  var OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];
  var nearbyReason = null;          /* why the last search found nothing */

  /* Overpass is asked first, because it answers the question directly — every
     city and town within the radius, with the population tag where it exists.
     Population beats any guess from the size of a bounding box.              */
  function biggestCityNear(place) {
    var round = NEAR_CITY_KM * 1000 + "," + place.lat + "," + place.lon;
    /* "out body" and not "out tags": the tags mode returns the tags without
       the coordinates, and a city with no position cannot be measured.       */
    var query = "[out:json][timeout:25];(" +
      "node(around:" + round + ")[place=city];" +
      "node(around:" + round + ")[place=town];" +
      ");out body 60;";

    nearbyReason = null;

    /* A GET rather than a POST: browsers refuse cross-origin POSTs for more
       reasons than they refuse GETs, and an error response without the
       permissive header reads only as "Failed to fetch".                     */
    function ask(hosts) {
      if (!hosts.length) return Promise.reject(new Error("no host answered"));
      return fetch(hosts[0] + "?data=" + encodeURIComponent(query))
        .then(function (r) {
          if (!r.ok) throw new Error(hosts[0].split("/")[2] + " returned " + r.status);
          return r.json();
        })
        .catch(function (err) {
          nearbyReason = err.message;
          return ask(hosts.slice(1));
        });
    }

    return ask(OVERPASS)
      .then(function (data) {
        var best = null;
        (data.elements || []).forEach(function (el) {
          var t = el.tags || {};
          if (!t.name || typeof el.lat !== "number" || typeof el.lon !== "number") return;
          var away = haversineKm(place, { lat: el.lat, lon: el.lon });
          if (!isFinite(away) || away > NEAR_CITY_KM) return;
          /* Population where it is recorded; the place tier otherwise, so a
             city outranks a town even when neither carries a figure.         */
          var pop = parseInt((t.population || "").replace(/[^0-9]/g, ""), 10);
          var rank = isNaN(pop) ? (t.place === "city" ? 1 : 0) : pop;
          if (!best || rank > best.rank || (rank === best.rank && away < best.away)) {
            best = { name: t["name:en"] || t.name, area: null, rank: rank, away: away };
          }
        });
        if (!best) throw new Error("no city or town within " + NEAR_CITY_KM + " km");
        return best;
      })
      .catch(function (err) {
        nearbyReason = nearbyReason || (err && err.message);
        return biggestCityNearByExtent(place);
      });
  }

  /* If Overpass is unreachable, fall back to sizing bounding boxes. */
  function biggestCityNearByExtent(place) {
    var url = PHOTON_NEAR + "?lat=" + place.lat + "&lon=" + place.lon +
              "&limit=20&lang=en&osm_tag=place:city&osm_tag=place:town";

    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Nearby search returned " + r.status);
        return r.json();
      })
      .then(function (data) {
        var best = null;
        (data.features || []).forEach(function (f) {
          var p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
          if (!p.name || !c) return;
          var away = haversineKm(place, { lat: c[1], lon: c[0] });
          if (away > NEAR_CITY_KM) return;
          var size = extentKm2(p.extent, c[1]);
          if (!best || size > best.size || (size === best.size && away < best.away)) {
            best = { name: p.name, area: p.state || p.county || p.country || null,
                     size: size, away: away };
          }
        });
        return best;
      })
      .catch(function () { return null; });
  }

  /* A city named by the reader — Londoners in all but postcode may want
     London's border rather than their own town's.                            */
  /* Suggestions for the "name the city yourself" box: settlements only, near
     the reader first. This path needs nothing but Photon, so it keeps working
     when the nearby-city search cannot be reached at all.                    */
  function suggestCities(query, near, signal) {
    var url = PHOTON + "?limit=6&lang=en&osm_tag=place:city&osm_tag=place:town" +
              "&q=" + encodeURIComponent(query) +
              (near ? "&lat=" + near.lat + "&lon=" + near.lon : "");

    return fetch(url, { signal: signal, headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Search returned " + r.status);
        return r.json();
      })
      .then(function (data) {
        return (data.features || []).map(function (f) {
          var p = f.properties || {};
          return {
            name: p.name,
            area: [p.county, p.state, p.country].filter(Boolean).join(", "),
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0]
          };
        }).filter(function (c) { return c.name; });
      });
  }

  function cityByName(name, mustContain) {
    /* featureType=settlement confines the answer to cities, towns, villages
       and hamlets — never a county, a district or a region. The spelling is
       case-sensitive; "featuretype" is quietly ignored.

       Several results are asked for, not one: the top hit for a town's name is
       usually the place node, which is a point and carries no boundary. The
       first result that actually has a polygon is the one worth having.       */
    var url = NOMINATIM + "?format=jsonv2&addressdetails=1&polygon_geojson=1&limit=10" +
              "&featureType=settlement&q=" + encodeURIComponent(name);
    return nominatim(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw nominatimError(r.status);
        return r.json();
      })
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error("No city of that name was found.");
        var withShape = rows.filter(function (r) {
          return r.geojson && /Polygon/.test(r.geojson.type);
        });
        /* There is a Watford in Northamptonshire as well as Hertfordshire,
           and a Cambridge on two continents. When we know where the reader
           is, the right boundary is the one they stand inside.               */
        if (mustContain) {
          var holds = withShape.filter(function (r) {
            return inShape(mustContain.lat, mustContain.lon, r.geojson);
          });
          if (holds.length) withShape = holds;
        }
        var row = withShape[0] || rows[0], a = row.address || {};
        return {
          name: a.city || a.town || a.village || a.municipality ||
                (row.display_name || "").split(",")[0],
          area: a.state || a.county || a.country || null,
          shape: row.geojson && /Polygon/.test(row.geojson.type) ? row.geojson : null
        };
      });
  }

  /* A readable address for a point on the map. Zoom 18 answers at street
     level, where cityOf's zoom 10 answers with the city.                     */
  function addressAt(lat, lon) {
    var url = NOMINATIM.replace("/search", "/reverse") +
              "?format=jsonv2&addressdetails=1&zoom=18&lat=" + lat + "&lon=" + lon;
    return nominatim(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw nominatimError(r.status);
        return r.json();
      })
      .then(function (row) {
        return {
          label: row.display_name || (lat.toFixed(4) + ", " + lon.toFixed(4)),
          lat: lat, lon: lon
        };
      })
      .catch(function () {
        /* No name for it is no reason to refuse the point. */
        return { label: lat.toFixed(4) + ", " + lon.toFixed(4), lat: lat, lon: lon };
      });
  }

  /* Ray casting, honouring holes: a point inside an inner ring is outside the
     polygon. GeoJSON rings are [lon, lat].                                    */
  function inRing(lat, lon, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function inPolygon(lat, lon, rings) {
    if (!inRing(lat, lon, rings[0])) return false;
    for (var h = 1; h < rings.length; h++) {
      if (inRing(lat, lon, rings[h])) return false;   /* in a hole */
    }
    return true;
  }

  function inShape(lat, lon, shape) {
    if (!shape) return false;
    if (shape.type === "Polygon") return inPolygon(lat, lon, shape.coordinates);
    if (shape.type === "MultiPolygon") {
      return shape.coordinates.some(function (rings) { return inPolygon(lat, lon, rings); });
    }
    return false;
  }

  /* Great-circle distance — the straight line, used only as a fallback and
     always labelled as such. The legal distance follows the road.            */
  function haversineKm(a, b) {
    var R = 6371.0088, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* Road distances by car — every route the service offers, not just the
     quickest, because the law counts the road actually taken: a longer way
     round can carry a journey past the limit that the direct road misses.
     Falls back to the straight line, flagged so the interface can say so.    */
  function routeKm(a, b) {
    var coords = a.lon + "," + a.lat + ";" + b.lon + "," + b.lat;
    return fetch(OSRM + coords + "?overview=full&geometries=geojson&alternatives=3")
      .then(function (r) {
        if (!r.ok) throw new Error("Routing service returned " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.code !== "Ok" || !data.routes || !data.routes.length) {
          throw new Error("No road route found");
        }
        return data.routes.map(function (r, i) {
          var geo = r.geometry;
          return {
            km: r.distance / 1000,
            minutes: r.duration / 60,
            source: "road",
            label: i === 0 ? "Quickest route" : "Alternative " + i,
            /* GeoJSON gives [lon, lat]; the map wants [lat, lon]. */
            line: (geo && geo.coordinates || []).map(function (c) { return [c[1], c[0]]; })
          };
        });
      })
      .catch(function () {
        return [{
          km: haversineKm(a, b),
          minutes: null,
          source: "straight",
          label: "Straight line",
          line: [[a.lat, a.lon], [b.lat, b.lon]]
        }];
      });
  }

  /* ==========================================================================
     2. THE RULING ENGINE

     Input:
       oneWayKm          road distance of the outward leg
       edgeKm            distance from the door to the town limit, deducted per leg
       roundTrip         returning without a ten-day stay, so both legs count
       intendedFromStart the whole distance was intended when setting out
       destIsWatan       the destination is one of the traveller's hometowns
       tenDays           a certain intention to stay ten continuous days
       hesitant          no idea how long the stay will be
       newLongStay       newly arrived somewhere adopted for a long stay — study or
                         work — which is not yet a hometown, with no ten-day intention
       passesWatan       the route passes through, and stops in, a hometown
       frequentTraveller travel is part of the occupation, or the person is a nomad
       sinful            the journey is for an unlawful purpose

     Output: a verdict for the road and a verdict for the destination, the
     numbers behind them, the reasoning, and any cautions.
     ========================================================================== */

  function decide(o) {
    var reasons  = [];
    var warnings = [];

    var legKm = Math.max(0, o.oneWayKm - o.edgeKm);

    /* The two legs are added together only when the return belongs to the
       same journey. Reaching a hometown, or intending ten days, ends the
       journey there — what follows is a fresh one, and must reach the limit
       on its own.                                                            */
    var severed   = o.destIsWatan || o.tenDays;
    var bothLegs  = o.roundTrip && !severed;
    var countedKm = bothLegs ? legKm * 2 : legKm;
    var meets     = countedKm >= LIMIT_KM;

    var metrics = {
      oneWayKm: o.oneWayKm,
      edgeKm: o.edgeKm,
      legKm: legKm,
      countedKm: countedKm,
      limitKm: LIMIT_KM,
      roundTrip: bothLegs,
      severed: severed,
      meets: meets
    };

    function out(enRoute, atDest, headline, sub) {
      return {
        enRoute: enRoute, atDest: atDest, headline: headline, sub: sub,
        reasons: reasons, warnings: warnings, metrics: metrics
      };
    }

    /* -- the exemptions come first: they hold whatever the distance -------- */
    if (o.sinful) {
      reasons.push("A journey undertaken for an unlawful purpose is not a journey in the eyes of the law. <b>The prayers are not shortened</b> and the fast is not lifted, however far one travels.");
      return out("full", "full", "Pray in full",
        "The rulings of travel do not apply to a journey whose purpose is sinful.");
    }

    if (o.frequentTraveller) {
      reasons.push("Travel is part of your occupation — a driver, a pilot, a commuting worker or student, or one with no settled home. <b>Such a person prays in full and fasts</b> while travelling for that work.");
      warnings.push({ kind: "info", text: "The exemption applies to the travel of the occupation itself. A journey of a different kind — a holiday, a pilgrimage — is judged on its own terms, and the first journey after a long break from the work is treated as ordinary travel." });
      return out("full", "full", "Pray in full",
        "One whose work is travel is not a traveller in the eyes of the law.");
    }

    /* -- the distance ------------------------------------------------------ */
    reasons.push(
      "The outward leg measures <b>" + fmtKm(o.oneWayKm) + "</b>" +
      (o.edgeKm > 0 ? ", less " + fmtKm(o.edgeKm) + " counted from your door to the edge of town, leaving <b>" + fmtKm(legKm) + "</b>" : "") +
      (bothLegs
        ? ". Since you return without staying ten days, the outward and return legs are added: <b>" + fmtKm(countedKm) + "</b>."
        : severed && o.roundTrip
        ? ". The return is <b>not</b> added to it: " +
          (o.destIsWatan ? "arriving in your own hometown" : "intending to stay ten days") +
          " ends the journey there, so each leg must reach the limit on its own."
        : ". You are not counting a return, so this leg alone must reach the limit.")
    );

    if (!meets) {
      reasons.push("That is short of the legal distance of eight <i>farsakh</i> — <b>" + fmtKm(LIMIT_KM) + "</b>. <b>You are not a traveller</b>: pray in full and fast as usual.");
      nearLimit();
      return out("full", "full", "Pray in full",
        "The journey falls short of eight farsakh, so the rulings of travel do not apply.");
    }

    reasons.push("That meets the legal distance of eight <i>farsakh</i> — <b>" + fmtKm(LIMIT_KM) + "</b>.");
    nearLimit();

    /* -- the intention ----------------------------------------------------- */
    if (!o.intendedFromStart) {
      reasons.push("The intention to cover the distance was not present when you set out. <b>Until that intention forms you are not a traveller</b>, and once it does the distance is counted afresh from wherever you happen to be.");
      warnings.push({ kind: "warn", text: "Run the calculation again using the place where you decided to continue as the starting point. Only the road from there onwards counts towards the eight farsakh." });
      return out("full", "full", "Pray in full — for now",
        "The distance was not intended from the outset, so the count restarts from the point the intention formed.");
    }

    /* -- a hometown on the way --------------------------------------------- */
    if (o.passesWatan) {
      warnings.push({ kind: "warn", text: "You stop in one of your hometowns on the way, which ends the journey at that point. The verdict below is provisional: run the calculator again with that town as the starting point, and treat the remaining road as a journey of its own." });
    }

    /* -- the destination --------------------------------------------------- */
    if (o.destIsWatan) {
      reasons.push("The destination is one of your hometowns. <b>In your own hometown you pray in full and fast</b>, even having travelled the legal distance to reach it. On the road between the two you are still a traveller.");
      return out("qasr", "full", "Shorten on the road, pray in full on arrival",
        "The journey meets the legal distance, but a person is never a traveller in his own hometown.");
    }

    if (o.tenDays) {
      reasons.push("You intend to stay ten continuous days or more. <b>That intention ends the journey</b>: at the destination you pray in full and fast as a resident. On the road you remain a traveller.");
      warnings.push({ kind: "info", text: "The ten days must be certain from the outset and spent in one place. Once a single four-rak'ah prayer has been offered in full there, the resident's ruling holds for as long as you remain, even if you then leave earlier than planned." });
      warnings.push({ kind: "info", text: "Setting off again from a place where you stayed ten days, you shorten as soon as you leave the town itself. The <i>hadd al-tarakhkhus</i> governs departure from your hometown, not from a place of ten days' residence." });
      return out("qasr", "full", "Shorten on the road, pray in full on arrival",
        "An intention to stay ten continuous days makes you a resident at the destination.");
    }

    if (o.newLongStay) {
      reasons.push("You have come to stay for a long period — for study or work — but the place is not yet your hometown, and you hold no intention of ten continuous days. By obligatory precaution (<i>ihtiyat wajib</i>) you <b>pray both</b> there: the four-rak'ah prayers shortened, and again in full.");
      warnings.push({ kind: "warn", text: "This holds while the place is still new to you. Once you have lived there long enough that people no longer count you a traveller — a matter of settling in, not of owning a house — it becomes your hometown and you pray in full, even if you are only there to study and do not mean to remain for life." });
      warnings.push({ kind: "info", text: "The workshop gives this ruling for the prayer. For the fast in the same circumstance, ask a scholar rather than reasoning from the prayer." });
      return out("qasr", "both", "Shorten on the road, pray both on arrival",
        "A place newly adopted for a long stay is neither travel nor residence outright, so the precaution is to pray both.");
    }

    if (o.hesitant) {
      reasons.push("You do not know how long you will stay. <b>Remain a traveller and shorten</b> — for up to thirty days in that one place. From the thirty-first day you pray in full without any new intention.");
      warnings.push({ kind: "info", text: "If certainty arrives during the stay that you will remain ten more days, you become a resident from that moment; the days already spent are not counted towards the ten." });
      return out("qasr", "qasr-30", "Shorten your prayers",
        "You remain a traveller while the length of the stay is undecided, up to thirty days.");
    }

    reasons.push("Nothing interrupts the journey: no hometown at its end, no intention of a ten-day stay. <b>Shorten the four-rak'ah prayers and do not fast.</b>");
    return out("qasr", "qasr", "Shorten your prayers",
      "The journey meets every condition. The distance is counted from your city border; the shortening itself begins once you pass the hadd al-tarakhkhus.");

    /* -- a caution when the distance sits on the line ---------------------- */
    function nearLimit() {
      if (Math.abs(countedKm - LIMIT_KM) <= NEAR_KM) {
        warnings.push({
          kind: "warn",
          text: "This journey sits within " + fmtKm(NEAR_KM) + " of the legal limit, and the road you take may differ from the one measured here. Where the distance is genuinely doubtful, the precaution is to pray both — shortened and in full — and to ask a scholar."
        });
      }
    }
  }

  /* ==========================================================================
     3. THE INTERFACE
     ========================================================================== */

  var $ = function (id) { return document.getElementById(id); };

  var unit = "km";                    /* display unit */
  var places = { from: null, to: null };
  var cities = { from: null, to: null };
  var routes = [];                    /* every road the service offered */
  var roadRoute = null;               /* the road chosen from those */
  var crowRoute = null;               /* the straight line, for comparison */
  var lastRoute = null;               /* whichever is being ruled on */
  var edgeTouched = false;            /* the reader overrode the measured border */
  var cityConfirmed = false;          /* the reader settled which city counts */

  function isReturn()  { return document.querySelector("input[name='trip']:checked").value === "return"; }
  function byCrow()    { return document.querySelector("input[name='measure']:checked").value === "crow"; }

  /* The distance the ruling is made on: the chosen road, or the straight line
     if that is what the reader asked for. */
  function chooseRoute() {
    lastRoute = (byCrow() && crowRoute) ? crowRoute : roadRoute;
    return lastRoute;
  }

  function toKm(v)      { return unit === "mi" ? v * KM_PER_MI : v; }
  function fromKm(v)    { return unit === "mi" ? v / KM_PER_MI : v; }
  function unitLabel()  { return unit === "mi" ? "miles" : "km"; }

  function fmtKm(km) {
    var v = fromKm(km);
    var s = v >= 100 ? v.toFixed(0) : v.toFixed(1);
    return s.replace(/\.0$/, "") + " " + unitLabel();
  }

  /* ---- address autocomplete -------------------------------------------- */

  function attachAutocomplete(inputId, listId, slot, hintId) {
    var input = $(inputId), list = $(listId), hint = $(hintId);
    var timer = null, controller = null, items = [], active = -1;

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      active = -1;
    }

    function choose(place) {
      close();
      adoptPlace(slot, place);
    }

    function render(rows) {
      items = rows;
      list.innerHTML = "";
      if (!rows.length) {
        var none = document.createElement("li");
        none.className = "is-empty";
        none.textContent = "No place of that name was found.";
        list.appendChild(none);
      } else {
        rows.forEach(function (place, i) {
          var li = document.createElement("li");
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", "false");
          li.textContent = place.label;
          li.addEventListener("mousedown", function (e) { e.preventDefault(); choose(place); });
          li.dataset.index = String(i);
          list.appendChild(li);
        });
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function highlight(next) {
      var nodes = list.querySelectorAll("li[role='option']");
      if (!nodes.length) return;
      if (active >= 0) nodes[active].setAttribute("aria-selected", "false");
      active = (next + nodes.length) % nodes.length;
      nodes[active].setAttribute("aria-selected", "true");
      nodes[active].scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("input", function () {
      places[slot] = null;
      cities[slot] = null;
      hint.className = "hint";
      var q = input.value.trim();
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
      if (q.length < 2) { close(); return; }

      /* Photon carries no one-a-second rule, so the wait is only long enough
         to avoid searching on every keystroke; stale requests are abandoned. */
      timer = setTimeout(function () {
        controller = new AbortController();
        /* The other address, when there is one, biases the search nearby. */
        var near = places[slot === "from" ? "to" : "from"];
        suggest(q, near, controller.signal)
          .then(render)
          .catch(function (err) { if (err.name !== "AbortError") close(); });
      }, 250);
    });

    input.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      if (e.key === "ArrowDown")      { e.preventDefault(); highlight(active + 1); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); highlight(active - 1); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(items[active]); }
      else if (e.key === "Escape")    { close(); }
    });

    input.addEventListener("blur", function () { setTimeout(close, 120); });
  }

  /* ---- reading the form ------------------------------------------------- */

  function readCircumstances(oneWayKm) {
    return {
      oneWayKm: oneWayKm,
      edgeKm: toKm(Math.max(0, parseFloat($("edgeKm").value) || 0)),
      roundTrip:         isReturn(),
      intendedFromStart: $("qIntent").checked,
      destIsWatan:       $("qWatan").checked,
      tenDays:           $("qTenDays").checked,
      hesitant:          $("qHesitant").checked,
      newLongStay:       $("qNewLongStay").checked,
      passesWatan:       $("qPassWatan").checked,
      frequentTraveller: $("qFrequent").checked,
      sinful:            $("qSin").checked
    };
  }

  /* ---- the map ----------------------------------------------------------
     Leaflet is loaded from a CDN. If it does not arrive — an offline machine,
     a blocked network — every other part of the page carries on without it and
     the map card simply stays hidden.
     ---------------------------------------------------------------------- */

  var mapState = { map: null, drawn: null, fitted: null };

  function walkTo(line, targetKm, scale) {
    /* The point on the route at a given distance along it. OSRM's polyline is
       a shade shorter than the distance it reports, so the walk is scaled to
       agree with the figure shown to the reader.                              */
    var run = 0;
    for (var i = 1; i < line.length; i++) {
      var a = { lat: line[i - 1][0], lon: line[i - 1][1] };
      var b = { lat: line[i][0], lon: line[i][1] };
      var seg = haversineKm(a, b) * scale;
      if (run + seg >= targetKm) {
        var t = seg > 0 ? (targetKm - run) / seg : 0;
        return [a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t];
      }
      run += seg;
    }
    return null;
  }

  /* How far along the route the home city's border falls. This is where the
     legal distance starts being counted: the point at which people would call
     you a traveller, which the workshop puts at the city border.             */
  function borderExitKm(line, shape, scale) {
    if (!shape) return null;

    /* The last moment the route is inside the city — not the first. A road
       that leaves and re-enters has not taken you out of town, and a reader
       whose own town sits inside a larger city they have named may start
       outside the polygon and pass through it.                               */
    var run = 0, exit = null, inside = inShape(line[0][0], line[0][1], shape);
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      var seg = haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) * scale;
      var nowIn = inShape(b[0], b[1], shape);
      if (inside && !nowIn) exit = run + seg * crossing(a, b, shape);
      inside = nowIn;
      run += seg;
    }
    return exit;   /* null if the route never leaves the city, or never enters it */
  }

  /* Bisect a straddling segment to place the crossing along it. */
  function crossing(a, b, shape) {
    var lo = 0, hi = 1;
    for (var k = 0; k < 14; k++) {
      var mid = (lo + hi) / 2;
      if (inShape(a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid, shape)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /* Cut a route in two at a distance along it, the cut point belonging to
     both halves so the drawn line has no gap.                                */
  function splitLine(line, targetKm, scale) {
    var run = 0, before = [line[0]];
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      var seg = haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) * scale;
      if (run + seg >= targetKm) {
        var t = seg > 0 ? (targetKm - run) / seg : 0;
        var cut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        before.push(cut);
        return [before, [cut].concat(line.slice(i))];
      }
      before.push(b);
      run += seg;
    }
    return [line, []];               /* the whole road is inside the city */
  }

  function polylineKm(line) {
    var total = 0;
    for (var i = 1; i < line.length; i++) {
      total += haversineKm({ lat: line[i - 1][0], lon: line[i - 1][1] },
                           { lat: line[i][0], lon: line[i][1] });
    }
    return total;
  }

  /* Create the map once, on a wide view. Returns false when the library is
     missing, having said so in place of the map.                            */
  function ensureMap() {
    if (mapState.map) return true;
    if (typeof L === "undefined") {
      $("map").innerHTML = "<p class='map__fail'>The map library did not load, so nothing can be drawn here. " +
        "Every ruling below still stands — the distance does not depend on the map.</p>";
      $("mapLegend").hidden = true;
      $("routePick").hidden = true;
      $("mapNote").textContent = "Expected at lib/leaflet/leaflet.js. If this persists, the file is not being served.";
      return false;
    }
    mapState.map = L.map("map", { scrollWheelZoom: false, attributionControl: true })
                    .setView([30, 10], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(mapState.map);
    mapState.drawn = L.layerGroup().addTo(mapState.map);
    return true;
  }

  function pin(at, colour, label) {
    L.circleMarker(at, {
      radius: 7, color: colour, weight: 3, fillColor: "#ffffff", fillOpacity: 1
    }).addTo(mapState.drawn).bindTooltip(label);
  }

  /* Draw whatever is known: nothing at all, one address, both, or a full
     route with the reckoning marked on it. Called on load, whenever an
     address is picked, and after every calculation.                          */
  function renderMap(m) {
    if (!ensureMap()) return;

    mapState.drawn.clearLayers();
    mapState.map.invalidateSize();
    $("mapLegend").hidden = false;

    var line = m && lastRoute && lastRoute.line && lastRoute.line.length > 1
             ? lastRoute.line : null;
    var seen = [];

    /* The two city borders. The home border is where counting starts; the
       destination's is drawn for orientation only, since the count runs to
       the destination itself, not to its border.                             */
    var drewBorder = false;
    [["from", "#0f8a76", "Your city"], ["to", "#b0740d", "Destination city"]]
      .forEach(function (spec) {
        var city = cities[spec[0]];
        if (!city || !city.shape) return;
        var layer = L.geoJSON(city.shape, {
          style: { color: spec[1], weight: 1.5, opacity: .75, dashArray: "5 5",
                   fill: true, fillOpacity: .06, fillColor: spec[1] }
        }).addTo(mapState.drawn).bindTooltip(spec[2] + ": " + (city.name || "border"));
        seen.push(layer.getBounds());
        drewBorder = true;
      });

    if (places.from) {
      pin([places.from.lat, places.from.lon], "#0a6455", places.from.label.split(",")[0] + " — start");
      seen.push(L.latLngBounds([[places.from.lat, places.from.lon]]));
    }
    if (places.to) {
      pin([places.to.lat, places.to.lon], "#8a5a06", places.to.label.split(",")[0] + " — destination");
      seen.push(L.latLngBounds([[places.to.lat, places.to.lon]]));
    }

    var straight = false;
    var at = null;

    if (line) {
      straight = lastRoute.source === "straight" || lastRoute.source === "crow";
      var polyKmAll = polylineKm(line);
      var scaleAll = polyKmAll > 0 ? lastRoute.km / polyKmAll : 1;

      /* The road inside your own city is not part of the legal distance, so
         it is drawn as what it is: faint, and not the journey.               */
      var head = null, counted = line;
      if (m && m.edgeKm > 0) {
        var parts = splitLine(line, m.edgeKm, scaleAll);
        head = parts[0];
        counted = parts[1].length > 1 ? parts[1] : null;
      }

      if (head && head.length > 1) {
        L.polyline(head, {
          color: "#93a1ac", weight: 3, opacity: .85, dashArray: "3 7"
        }).addTo(mapState.drawn).bindTooltip("Not counted — inside " +
          ((cities.from && cities.from.name) || "your city"));
      }
      if (counted) {
        L.polyline(counted, {
          color: "#0f8a76", weight: 5, opacity: .9,
          dashArray: straight ? "6 8" : null
        }).addTo(mapState.drawn);

        /* Where the counting begins. */
        if (head && head.length > 1) {
          L.circleMarker(counted[0], {
            radius: 6, color: "#0f8a76", weight: 3, fillColor: "#ffffff", fillOpacity: 1
          }).addTo(mapState.drawn).bindTooltip("The count starts here — the " +
            ((cities.from && cities.from.name) || "city") + " border");
        }
      }
      seen.push(L.latLngBounds(line));

      /* Where the eight farsakh falls along this road. It marks the distance
         only: once a journey qualifies, the shortening runs from the town
         limit onwards, not from this point.                                  */
      var oneWayNeeded = m.roundTrip ? m.limitKm / 2 : m.limitKm;
      at = m.meets ? walkTo(line, m.edgeKm + oneWayNeeded, scaleAll) : null;
      if (at) {
        L.circleMarker(at, {
          radius: 6, color: "#0f8a76", weight: 3, fillColor: "#ffffff", fillOpacity: 1
        }).addTo(mapState.drawn).bindTooltip("Eight farsakh — " + fmtKm(m.limitKm) +
          (m.roundTrip ? " counted, outward and back" : ""));
      }
    }

    /* When no border was published, the deduction the reader gave stands in. */
    var hasEdge = !drewBorder && m && m.edgeKm > 0 && line;
    if (hasEdge) {
      L.circle(line[0], {
        radius: m.edgeKm * 1000, color: "#64737f", weight: 1,
        dashArray: "4 6", fill: false
      }).addTo(mapState.drawn).bindTooltip("Edge of town — " + fmtKm(m.edgeKm) + " out");
    }

    $("mapTitle").textContent = line ? "The route" : "The map";
    $("mapLegend").querySelector(".is-route").hidden = !line;
    $("mapLegend").querySelector(".is-head").hidden = !(line && m && m.edgeKm > 0);
    $("mapLegend").querySelector(".is-from").hidden = !places.from;
    $("mapLegend").querySelector(".is-to").hidden = !places.to;
    $("mapLegend").querySelector(".is-border").hidden = !drewBorder;
    $("mapLegend").querySelector(".is-edge").hidden = !hasEdge;
    $("mapLegend").querySelector(".is-limit").hidden = !at;

    $("mapNote").innerHTML =
      !line && !places.from && !places.to
        ? "Choose an address above and it will appear here, with the border of its city outlined."
      : !line
        ? "Press Calculate to measure the road between them."
      : lastRoute.source === "crow"
        ? "The straight line between the two places, as you asked. It is not a road, and the law measures the road."
      : straight
        ? "The road could not be fetched, so this is the straight line between the two places — not a route."
        : "Counted from where the route leaves your city border to the destination itself. The destination's border is drawn only to place it.";

    /* Frame whatever is on the map, and only when that changes, so toggling a
       circumstance does not yank the view about.                             */
    if (!seen.length) return;
    var bounds = seen.reduce(function (all, b) { return all.extend(b); }, L.latLngBounds(seen[0]));
    var key = (line ? line.length + ":" + line[0] + ":" + line[line.length - 1] : "no-line") +
              "|" + bounds.toBBoxString();
    if (mapState.fitted !== key) {
      mapState.map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
      mapState.fitted = key;
    }
  }

  /* ---- rendering the verdict -------------------------------------------- */

  var RAKAHS = [
    { name: "Fajr",    full: 2, short: 2 },
    { name: "Dhuhr",   full: 4, short: 2 },
    { name: "Asr",     full: 4, short: 2 },
    { name: "Maghrib", full: 3, short: 3 },
    { name: "Isha",    full: 4, short: 2 }
  ];

  function render(verdict) {
    var m = verdict.metrics;
    var src = lastRoute ? lastRoute.source : "road";
    var shortensSomewhere = verdict.enRoute === "qasr" || verdict.atDest !== "full";

    /* the headline */
    $("verdict").className = "verdict" + (shortensSomewhere ? "" : " verdict--full");
    $("verdictLabel").textContent = verdict.headline;
    $("verdictSub").textContent = verdict.sub;

    /* the numbers */
    var home = (cities.from && cities.from.name) || "your city";
    var rows = [
      [(src === "crow" ? "Straight line, door to destination" : "Road, door to destination"), fmtKm(m.oneWayKm) +
        (lastRoute && lastRoute.minutes ? " · about " + fmtDuration(lastRoute.minutes) + " by car" : "")]
    ];
    if (m.edgeKm > 0) {
      rows.push(["Less door to the " + home + " border", "− " + fmtKm(m.edgeKm)]);
      rows.push([home + " border to destination", fmtKm(m.legKm)]);
    }
    if (m.roundTrip) rows.push(["Return leg", "+ " + fmtKm(m.legKm)]);
    rows.push(["Legal distance — 8 farsakh", fmtKm(m.limitKm)]);

    var dl = $("measure");
    dl.innerHTML = "";
    rows.forEach(function (r) { dl.appendChild(measureRow(r[0], r[1], false)); });
    dl.appendChild(measureRow(
      m.roundTrip ? "Total counted for this journey" : "Counted for this journey",
      fmtKm(m.countedKm) + (m.meets ? " — meets the limit" : " — short of the limit"),
      true
    ));

    var pct = Math.max(2, Math.min(100, (m.countedKm / m.limitKm) * 100));
    $("gaugeFill").style.width = pct + "%";
    $("gaugeFill").className = "gauge__fill" + (m.meets ? " is-over" : "");

    $("measureNote").innerHTML =
      src === "straight" ? "The routing service could not be reached, so this is the straight-line distance — always shorter than the road. Enter the real distance by hand before relying on this verdict." :
      src === "crow"     ? "As the crow flies, at your request. <b>The law counts the road travelled</b>, which is longer" +
                           (roadRoute ? " — " + fmtKm(roadRoute.km) + " by road." : ".") :
      src === "manual"   ? "Measured from the distance you entered by hand." :
      "Measured along the driving route — the path travelled, as the law requires.";
    $("measureNote").className = "hint" + (src === "straight" ? " hint--warn" : "");

    /* the prayers */
    var body = $("prayers").querySelector("tbody");
    body.innerHTML = "";
    RAKAHS.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.appendChild(cell("th", p.name));
      tr.appendChild(cell("td", rakahText(verdict.enRoute, p), verdict.enRoute !== "full" && p.short < p.full));
      tr.appendChild(cell("td", rakahText(verdict.atDest, p) + (verdict.atDest === "qasr-30" ? " *" : ""),
                          verdict.atDest !== "full" && p.short < p.full));
      body.appendChild(tr);
    });

    /* the fast */
    var fastRoad = verdict.enRoute === "qasr"
      ? "Do not fast. Setting out <b>after</b> the adhan of Dhuhr, complete that day's fast; before it, make it up later."
      : "Fast as usual — this journey does not lift the obligation.";
    var fastDest =
      verdict.atDest === "both" ? "The precaution settles the prayer, not the fast — ask a scholar." :
      verdict.atDest.indexOf("qasr") === 0 ? "Do not fast there either; make the days up afterwards." :
      "At the destination you fast as a resident.";

    $("fasting").innerHTML =
      "<div><h3>Fasting on the road</h3><p>" + fastRoad + "</p></div>" +
      "<div><h3>Fasting at the destination</h3><p>" + fastDest + "</p></div>" +
      (verdict.atDest === "qasr-30"
        ? "<p class='hint'>* Shortened for up to thirty days in that one place; from the thirty-first day, pray in full.</p>"
        : "");

    /* the reasoning */
    var ol = $("reasons");
    ol.innerHTML = "";
    verdict.reasons.forEach(function (text) {
      var li = document.createElement("li");
      li.innerHTML = text;
      ol.appendChild(li);
    });

    /* the cautions */
    var warn = $("warnings");
    warn.innerHTML = "";
    verdict.warnings.forEach(function (w) {
      var div = document.createElement("div");
      div.className = "note" + (w.kind === "info" ? " note--info" : "");
      div.innerHTML = "<b>" + (w.kind === "info" ? "Note" : "Take care") + ".</b> " + w.text;
      warn.appendChild(div);
    });
    if (shortensSomewhere) {
      note(warn, "Two lines, not one",
        "The distance is counted from your <b>city border</b>; the shortening begins later, at the <i>hadd al-tarakhkhus</i>. Coming home, shorten until you are inside the city border again. <a href='rules.html'>The rulings in full</a>.");
      note(warn, "The four places of choice",
        "In Makkah, Madinah, the Masjid of Kufa and the sanctuary of Imam al-Husayn (peace be upon him), a traveller may choose between shortening and praying in full.");
    }

    function note(parent, title, body) {
      var div = document.createElement("div");
      div.className = "note note--info";
      div.innerHTML = "<b>" + title + ".</b> " + body;
      parent.appendChild(div);
    }

    /* The panel must be on screen before the map measures itself — Leaflet
       reads the container's size, and a hidden ancestor makes that zero.     */
    $("result").hidden = false;
    renderMap(m);
  }

  /* Maghrib and Fajr are the same either way, so "both" collapses for them. */
  function rakahText(state, p) {
    if (state === "full") return p.full + " rak'ah";
    if (state === "both") {
      return p.short === p.full ? p.short + " rak'ah" : p.short + " and " + p.full + " rak'ah";
    }
    return p.short + " rak'ah";
  }

  function measureRow(term, value, total) {
    var div = document.createElement("div");
    if (total) div.className = "is-total";
    var dt = document.createElement("dt"); dt.textContent = term;
    var dd = document.createElement("dd"); dd.textContent = value;
    div.appendChild(dt); div.appendChild(dd);
    return div;
  }

  function cell(tag, text, isShort) {
    var node = document.createElement(tag);
    if (tag === "th") node.setAttribute("scope", "row");
    node.textContent = text;
    if (isShort) node.className = "is-short";
    return node;
  }

  function fmtDuration(minutes) {
    var h = Math.floor(minutes / 60), m = Math.round(minutes % 60);
    if (!h) return m + " min";
    return m ? h + " h " + m + " min" : h + " h";
  }

  /* ---- cities, borders and the choice of road ---------------------------- */

  var SLOTS = {
    from: { input: "fromInput", hint: "fromHint", lead: "Your city is" },
    to:   { input: "toInput",   hint: "toHint",   lead: "The destination is in" }
  };

  /* Take a place as the start or the destination — typed, tapped on the map,
     or read from the device — and show it everywhere at once.                */
  function adoptPlace(slot, place) {
    var spec = SLOTS[slot];
    places[slot] = place;
    cities[slot] = null;
    $(spec.input).value = place.label;
    $(spec.hint).textContent = "Finding which city this is in…";
    $(spec.hint).className = "hint";
    renderMap(null);                        /* the pin, straight away */

    if (slot === "from") { cityConfirmed = false; cityOptions = null; }

    return cityOf(place).then(function (city) {
      if (places[slot] !== place) return;   /* the reader moved on */
      cities[slot] = city;
      showCity(slot, spec.hint, spec.lead);
      if (slot === "from") {
        $("cityBtn").hidden = false;        /* a suggestion, open to correction */
        renderCityChoices();
        loadCityChoices();                  /* so the alternatives are known, unasked */
      }
      renderMap(null);
    });
  }

  /* Take a city as the one whose border the count starts from. */
  function useCity(city, byHand) {
    cities.from = city;
    cityConfirmed = !!byHand;
    edgeTouched = false;                 /* a new border means a new measurement */
    showCity("from", "fromHint", "Your city is");
    applyBorderDeduction();
    renderCityChoices();
    labelCityBtn();
    if (lastRoute) recalc(); else renderMap(null);
  }

  function cityRow(city, isOn) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "city" + (isOn ? " is-on" : "");
    btn.setAttribute("aria-pressed", isOn ? "true" : "false");
    btn.innerHTML = "<b>" + city.name + "</b><span>" +
      (city.area && city.area !== city.name ? city.area + " · " : "") +
      (city.shape ? "border published" : "no border published — nothing to deduct") +
      (city.note ? " · " + city.note : "") +
      "</span>";
    btn.addEventListener("click", function () { useCity(city, true); });
    li.appendChild(btn);
    return li;
  }

  function renderCityChoices() {
    var list = $("cityList");
    list.innerHTML = "";
    (cityOptions || []).forEach(function (c) {
      list.appendChild(cityRow(c, cities.from && c.name === cities.from.name));
    });
    /* A city named by hand belongs in the list too, once chosen. */
    if (cities.from && !(cityOptions || []).some(function (c) { return c.name === cities.from.name; })) {
      list.appendChild(cityRow(cities.from, true));
    }
  }

  var cityOptions = null;

  /* The button names what else is on offer. A reader who never opens the
     panel would otherwise never learn that London was among the choices.     */
  function labelCityBtn() {
    var btn = $("cityBtn");
    if (!$("cityPick").hidden) { btn.textContent = "Done choosing"; return; }
    var other = (cityOptions || []).filter(function (c) {
      return !cities.from || c.name !== cities.from.name;
    });
    btn.textContent = other.length
      ? "Not " + ((cities.from && cities.from.name) || "this") + "? " + other[0].name + " is also an option"
      : "Change which city";
  }

  function loadCityChoices() {
    if (!places.from) return;
    $("cityMsg").textContent = "Looking for the alternatives…";
    $("cityMsg").className = "hint";
    cityChoices(places.from).then(function (found) {
      cityOptions = found;
      var lonely = found.length < 2;
      $("cityMsg").textContent = lonely
        ? "No larger city could be found nearby" +
          (nearbyReason ? " (" + nearbyReason + ")" : "") +
          " — name one below if you have another in mind."
        : "";
      $("cityMsg").className = "hint" + (lonely ? " hint--warn" : "");
      renderCityChoices();

      labelCityBtn();
    });
  }

  function showCity(slot, hintId, lead) {
    var city = cities[slot], hint = $(hintId);
    if (city && city.name) {
      hint.innerHTML = lead + " <b>" + city.name + "</b>" +
        (city.area && city.area !== city.name ? ", " + city.area : "") +
        (city.shape ? " — its border is outlined on the map." : " — no published border to outline.") +
        (slot === "from" && !cityConfirmed ? " <em>Suggested — change it if another city's edge is the one you would call leaving town.</em>" : "");
      hint.className = "hint hint--ok";
    } else {
      hint.textContent = city && city.reason
        ? city.reason + " No border is drawn, and the deduction stays as you left it."
        : "The city here could not be identified, so no border is drawn.";
      hint.className = "hint" + (city && city.reason ? " hint--warn" : "");
    }
  }

  /* The distance from the start to the point where the route leaves the home
     city. Written into the deduction field unless the reader has set it. */
  /* The legal distance runs from the city border to the destination, so the
     road from the door to that border is measured and taken off. Every case
     where it cannot be done says which, rather than quietly measuring from
     the doorstep.                                                            */
  function applyBorderDeduction() {
    var city = cities.from;
    var hint = $("edgeHint");

    function say(text, kind) {
      hint.innerHTML = text;
      hint.className = "hint" + (kind ? " " + kind : "");
    }

    if (!lastRoute || !lastRoute.line) return;          /* nothing measured yet */

    if (!city || !city.name) {
      say("No city identified for the start, so the count runs from the address itself.", "hint--warn");
      return;
    }
    if (!city.shape) {
      say("No published border for <b>" + city.name + "</b>, so the count runs from the address itself. " +
          "Name another city above, or type the distance to your city's edge here.", "hint--warn");
      return;
    }

    var polyKm = polylineKm(lastRoute.line);
    var exit = borderExitKm(lastRoute.line, city.shape,
                            polyKm > 0 ? lastRoute.km / polyKm : 1);

    if (exit === null) {
      var inside = inShape(lastRoute.line[0][0], lastRoute.line[0][1], city.shape);
      say(inside
        ? "This route never leaves <b>" + city.name + "</b>, so no journey is counted at all."
        : "The start lies outside <b>" + city.name + "</b> and this route does not pass through it, so nothing is deducted. " +
          "Choose the city you would call leaving town, above.", "hint--warn");
      if (!edgeTouched) $("edgeKm").value = "";
      return;
    }

    if (!edgeTouched) $("edgeKm").value = fromKm(exit).toFixed(1);
    say("Counting from the border of <b>" + city.name + "</b> to the destination. " +
        "The road from your door to that border is <b>" + fmtKm(exit) + "</b>, and is not counted. " +
        "Overwrite it if you know better.", "hint--ok");
  }

  function renderRoutes() {
    var pick = $("routePick"), list = $("routes");
    if (routes.length < 2 || byCrow()) { pick.hidden = true; return; }

    list.innerHTML = "";
    routes.forEach(function (r, i) {
      var edge = toKm(parseFloat($("edgeKm").value) || 0);
      var bothLegs = isReturn() && !$("qWatan").checked && !$("qTenDays").checked;
      var counted = Math.max(0, r.km - edge) * (bothLegs ? 2 : 1);
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "route" + (r === roadRoute ? " is-on" : "");
      btn.setAttribute("aria-pressed", r === roadRoute ? "true" : "false");
      btn.innerHTML =
        "<b>" + r.label + "</b>" +
        "<span>" + fmtKm(r.km) + (r.minutes ? " · " + fmtDuration(r.minutes) : "") + "</span>" +
        "<em>" + (counted >= LIMIT_KM ? "qualifies — " : "falls short — ") + fmtKm(counted) + " counted</em>";
      btn.addEventListener("click", function () {
        roadRoute = r;
        chooseRoute();
        applyBorderDeduction();
        recalc();                     /* redraws the picker, so the choice shows */
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    pick.hidden = false;
  }

  /* ---- orchestration ----------------------------------------------------- */

  function say(text, isError) {
    var el = $("status");
    el.textContent = text || "";
    el.className = "status" + (isError ? " status--err" : "");
  }

  /* Resolve a field to coordinates: the place picked from the list if there is
     one, otherwise the best match for whatever was typed.                     */
  function resolve(slot, inputId, label) {
    if (places[slot]) return Promise.resolve(places[slot]);
    var q = $(inputId).value.trim();
    if (!q) return Promise.reject(new Error("Enter the " + label + " address."));
    return geocode(q, 1).then(function (rows) {
      if (!rows.length) throw new Error("Could not find “" + q + "”. Try adding the town and country.");
      places[slot] = rows[0];
      $(inputId).value = rows[0].label;
      return rows[0];
    });
  }

  function calculate(e) {
    if (e) e.preventDefault();
    var btn = $("calcBtn");

    /* A distance typed by hand wins, and needs neither service. */
    var typed = parseFloat($("manualKm").value);
    if (!isNaN(typed) && typed >= 0) {
      lastRoute = { km: toKm(typed), minutes: null, source: "manual" };
      render(decide(readCircumstances(lastRoute.km)));
      say("Calculated from the distance you entered.");
      $("result").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    btn.disabled = true;
    say("Finding the addresses…");

    resolve("from", "fromInput", "starting")
      .then(function () { return resolve("to", "toInput", "destination"); })
      .then(function () {
        say("Measuring the road…");
        return routeKm(places.from, places.to);
      })
      .then(function (found) {
        routes = found;
        roadRoute = found[0];
        crowRoute = {
          km: haversineKm(places.from, places.to),
          minutes: null,
          source: "crow",
          label: "Straight line",
          line: [[places.from.lat, places.from.lon], [places.to.lat, places.to.lon]]
        };
        chooseRoute();
        say("Finding the city borders…");
        /* A missing border costs the deduction, not the ruling, so a failure
           here must not sink the calculation. */
        return (cityConfirmed && cities.from
                  ? Promise.resolve(cities.from)
                  : cityOf(places.from)
               ).then(function (home) {
          return cityOf(places.to).then(function (away) { return [home, away]; });
        });
      })
      .then(function (pair) {
        cities.from = pair[0];
        cities.to = pair[1];
        showCity("from", "fromHint", "Your city is");
        showCity("to", "toHint", "The destination is in");
        applyBorderDeduction();
        render(decide(readCircumstances(lastRoute.km)));
        renderRoutes();
        say(lastRoute.source === "straight" ? "Routing unavailable — showing the straight-line distance." : "");
        $("result").scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function (err) {
        /* A browser reports an unreachable service as "Failed to fetch", which
           tells nobody anything. Say what to do about it instead.            */
        var base = err.message || "Something went wrong. Check the addresses and try again.";
        var offline = /failed to fetch|networkerror|load failed|returned \d+/i.test(base);
        say(offline
          ? "Could not reach the address lookup. Enter the distance by hand — the panel is open above — and press Calculate."
          : base, true);
        if (offline) $("manualKm").closest("details").open = true;
      })
      .then(function () { btn.disabled = false; });
  }

  /* Recalculate from the numbers already held, without touching the network. */
  function recalc() {
    if (!lastRoute) return;
    render(decide(readCircumstances(lastRoute.km)));
    renderRoutes();
  }

  function init() {
    if (!$("qasrForm")) return;   /* nothing to wire — the engine is still exported below */

    attachAutocomplete("fromInput", "fromList", "from", "fromHint");
    attachAutocomplete("toInput", "toList", "to", "toHint");

    renderMap(null);                  /* a map at rest, before anything is asked */

    /* Tapping the map sets whichever end the toggle names. */
    if (mapState.map) {
      mapState.map.on("click", function (e) {
        var slot = document.querySelector("input[name='target']:checked").value;
        $("mapToolHint").textContent = "Looking up that point…";
        addressAt(e.latlng.lat, e.latlng.lng).then(function (place) {
          $("mapToolHint").textContent = "Tap the map to set a location";
          adoptPlace(slot, place);
          /* Setting the start leaves the destination as the obvious next tap. */
          if (slot === "from" && !places.to) {
            document.querySelector("input[name='target'][value='to']").checked = true;
          }
        });
      });
    }

    $("cityBtn").addEventListener("click", function () {
      var pick = $("cityPick");
      pick.hidden = !pick.hidden;
      if (!pick.hidden && !cityOptions) loadCityChoices();
      labelCityBtn();
    });

    $("cityGo").addEventListener("click", function () {
      var name = $("citySearch").value.trim();
      if (!name) return;
      $("cityMsg").textContent = "Looking for " + name + "…";
      $("cityMsg").className = "hint";
      cityByName(name).then(function (city) {
        if (!city.shape) {
          $("cityMsg").textContent = "Found " + city.name + ", but it has no published border, so nothing can be deducted from it.";
          $("cityMsg").className = "hint hint--warn";
        } else {
          $("cityMsg").textContent = "";
          $("citySearch").value = "";
        }
        useCity(city, true);
      }).catch(function (err) {
        $("cityMsg").textContent = err.message;
        $("cityMsg").className = "hint hint--warn";
      });
    });

    $("citySearch").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("cityGo").click(); }
      if (e.key === "Escape") { $("cityFound").hidden = true; }
    });

    /* Suggestions for the box, so the city need not be typed exactly nor its
       spelling guessed. Independent of the nearby-city search entirely.      */
    var cityTimer = null, cityAbort = null;
    $("citySearch").addEventListener("input", function () {
      var q = this.value.trim(), list = $("cityFound");
      if (cityTimer) clearTimeout(cityTimer);
      if (cityAbort) cityAbort.abort();
      if (q.length < 2) { list.hidden = true; return; }

      cityTimer = setTimeout(function () {
        cityAbort = new AbortController();
        suggestCities(q, places.from, cityAbort.signal)
          .then(function (found) {
            list.innerHTML = "";
            found.forEach(function (c) {
              var li = document.createElement("li");
              li.setAttribute("role", "option");
              li.textContent = c.name + (c.area ? " — " + c.area : "");
              li.addEventListener("mousedown", function (e) {
                e.preventDefault();
                list.hidden = true;
                $("citySearch").value = c.name;
                $("cityGo").click();
              });
              list.appendChild(li);
            });
            list.hidden = !found.length;
            $("citySearch").setAttribute("aria-expanded", String(!list.hidden));
          })
          .catch(function () { list.hidden = true; });
      }, 250);
    });

    $("citySearch").addEventListener("blur", function () {
      setTimeout(function () { $("cityFound").hidden = true; }, 120);
    });

    $("locateBtn").addEventListener("click", function () {
      var btn = this;
      if (!navigator.geolocation) {
        say("This browser will not report your location.", true);
        return;
      }
      btn.disabled = true;
      btn.textContent = "Finding you…";
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          addressAt(pos.coords.latitude, pos.coords.longitude).then(function (place) {
            adoptPlace("from", place);
            btn.disabled = false;
            btn.textContent = "Use my location";
            say("");
          });
        },
        function (err) {
          btn.disabled = false;
          btn.textContent = "Use my location";
          say(err && err.code === 1
            ? "Location permission was refused, so type the address instead."
            : "Your location could not be read, so type the address instead.", true);
        },
        { timeout: 12000, maximumAge: 300000 }
      );
    });

    $("qasrForm").addEventListener("submit", calculate);

    $("resetBtn").addEventListener("click", function () {
      $("qasrForm").reset();
      places = { from: null, to: null };
      cities = { from: null, to: null };
      routes = [];
      roadRoute = crowRoute = lastRoute = null;
      edgeTouched = false;
      cityConfirmed = false;
      cityOptions = null;
      $("cityPick").hidden = true;
      $("cityBtn").hidden = true;
      $("cityBtn").textContent = "Change which city";
      $("cityList").innerHTML = "";
      $("cityMsg").textContent = "";
      $("routePick").hidden = true;
      mapState.fitted = null;
      if (mapState.map) mapState.map.setView([30, 10], 2);
      renderMap(null);              /* back to a map at rest */
      $("edgeHint").className = "hint";
      $("edgeHint").textContent = "The count starts at your city border, not your front door. Once the addresses are in, this is measured along the route for you — overwrite it if you know better.";
      $("result").hidden = true;
      $("fromHint").className = $("toHint").className = "hint";
      $("fromHint").textContent = "Your hometown, or wherever the journey begins.";
      $("toHint").textContent = "The furthest point you intend to reach on this journey.";
      say("");
      $("fromInput").focus();
    });

    /* Any change to the circumstances re-runs the ruling on the same distance. */
    ["qIntent", "qWatan", "qTenDays", "qHesitant", "qNewLongStay", "qPassWatan", "qFrequent", "qSin"]
      .forEach(function (id) { $(id).addEventListener("change", recalc); });

    document.querySelectorAll("input[name='trip']").forEach(function (el) {
      el.addEventListener("change", recalc);
    });
    document.querySelectorAll("input[name='measure']").forEach(function (el) {
      el.addEventListener("change", function () {
        if (!roadRoute) return;       /* nothing measured yet */
        chooseRoute();
        applyBorderDeduction();
        recalc();
      });
    });
    $("edgeKm").addEventListener("input", function () { edgeTouched = true; recalc(); });
    window.addEventListener("resize", function () {
      if (mapState.map && !$("mapCard").hidden) mapState.map.invalidateSize();
    });

    $("manualKm").addEventListener("input", function () {
      var v = parseFloat(this.value);
      if (!isNaN(v) && v >= 0) {
        lastRoute = roadRoute = { km: toKm(v), minutes: null, source: "manual" };
      }
      recalc();
    });

    /* Ten days and hesitation are contraries — one excludes the other. */
    var exclusive = ["qTenDays", "qHesitant", "qNewLongStay"];
    exclusive.forEach(function (id) {
      $(id).addEventListener("change", function () {
        if (!this.checked) return;
        exclusive.forEach(function (other) { if (other !== id) $(other).checked = false; });
      });
    });

    /* Switching units converts what is already typed, then redraws. */
    $("units").addEventListener("change", function () {
      var was = unit;
      unit = this.value;
      if (was !== unit) {
        ["edgeKm", "manualKm"].forEach(function (id) {
          var el = $(id), v = parseFloat(el.value);
          if (!isNaN(v)) el.value = (unit === "mi" ? v / KM_PER_MI : v * KM_PER_MI).toFixed(1);
        });
      }
      recalc();
    });

  }

  /* The ruling engine is exported so it can be exercised on its own — see
     test/engine.test.js. Nothing in the interface reads it back.             */
  window.QasrEngine = {
    decide: decide, LIMIT_KM: LIMIT_KM, FARSAKH_KM: FARSAKH_KM,
    inShape: inShape, borderExitKm: borderExitKm, haversineKm: haversineKm,
    extentKm2: extentKm2, NEAR_CITY_KM: NEAR_CITY_KM
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
