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

  /* The threshold and the farsakh live in fiqh.js, with the mas'ala that gives
     them. There is deliberately no tolerance band: under 44 km is under. [1698] */
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

  /* Nominatim's place_rank puts a country at 4, a state at 8, a county at 12,
     a city at 16 and a village at 19. "Greater London" is an administrative
     county wearing a city's name, and the rank is what gives it away.        */
  function isSettlement(city) {
    if (!SETTLEMENT.test(city.kind || "")) return false;
    return city.rank == null || (city.rank >= 16 && city.rank <= 20);
  }

  function cityOf(place) {
    return cityAt(place, 10).then(function (city) {
      if (!city.name) return city;
      if (isSettlement(city) && city.shape) return city;

      /* Named, but the shape belongs to something larger or smaller. Look the
         settlement up by name; and where the name is itself an aggregate —
         "Greater London", "Greater Manchester" — try the town inside it. */
      var plain = city.name.replace(/^Greater\s+/i, "");
      return cityByName(city.name, place)
        .catch(function () {
          return plain !== city.name ? cityByName(plain, place) : Promise.reject();
        })
        .catch(function () {
          return { name: plain, area: city.area, shape: null };
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
          rank: typeof row.place_rank === "number" ? row.place_rank : null,
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
          if (isSettlement(city) && city.shape) { found.push(city); return; }
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
        /* A settlement ranks 16 to 20; a county ranks 12. A settlement's own
           boundary is preferred where one exists.

           But some cities have none: the only polygon published for London is
           the Greater London relation, which ranks as a county. Refusing it
           leaves London with no border at all, and the text wants the edge of
           the whole city anyway — Tehran is measured from the end of the city,
           not of a quarter [1704 fn.2]. So an aggregate boundary is accepted
           when nothing finer exists, and carries the settlement's own name
           rather than the administrative one. */
        var settled = withShape.filter(function (r) {
          return typeof r.place_rank !== "number" || (r.place_rank >= 16 && r.place_rank <= 20);
        });
        var fromAggregate = false;
        if (settled.length) withShape = settled;
        else if (withShape.length) fromAggregate = true;
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
        var settlementName = String(name).replace(/^Greater\s+/i, "");
        return {
          /* The name the reader asked for, not the administrative label the
             boundary happens to carry. */
          name: fromAggregate ? settlementName
              : (a.city || a.town || a.village || a.municipality ||
                 (row.display_name || "").split(",")[0]),
          area: a.state || a.county || a.country || null,
          fromAggregate: fromAggregate,
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
     2. THE RULING — deferred entirely to fiqh.js

     No verdict is computed in this file. The interface gathers what the reader
     has told it, hands one TripInput to Fiqh.evaluate, and renders what comes
     back. Every ruling on the page carries the mas'ala that produced it.
     ========================================================================== */

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
  var lastResult = null;
  var edgeTouched = false;            /* the reader overrode the measured border */
  var cityConfirmed = false;          /* the reader settled which city counts */
  var staysInCity = false;
  /* Whether the count actually began at a city border, and if not, why not.
     [1704] requires it; the reader is shown whether it happened.            */
  var borderCheck = { ok: false, reason: "Nothing measured yet.", km: 0, city: null };            /* the road never leaves the home city */

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

  /* Always one decimal. Rounding long distances to whole kilometres made the
     rows stop adding up on the page — 220 less 37.6 shown as 182, then doubled
     to 365 — and a reader checking the arithmetic by eye is the point.       */
  function fmtKm(km) {
    return fromKm(km).toFixed(1) + " " + unitLabel();
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

  /* What the reader has told us, in the shape the engine expects. Anything not
     asked is left undefined, and the engine says so rather than guessing.    */
  /* A slider has two positions, so an unanswered question is one with neither
     chosen. Those come back undefined, and the engine asks for them rather
     than reading silence as "no". §15                                        */
  function ans(name) {
    var el = document.querySelector("input[name='" + name + "']:checked");
    return el ? el.value === "yes" : undefined;
  }

  function buildTrip(oneWayKm) {
    var tenDays = ans("qTenDays");
    var edge = toKm(Math.max(0, parseFloat($("edgeKm").value) || 0));
    var leg = Math.max(0, oneWayKm - edge);
    var sinful = ans("qSin") === true;

    return {
      person: {
        kathirRulingApplies: ans("qKathir"),
        workIsTravel: ans("qKathir") === true || undefined,
        workDescriptionHolds: ans("qKathir") === true ? true : undefined
      },
      journey: {
        intendedFromOutset: ans("qIntent"),
        purpose: { kind: sinful ? "sinful" : "lawful" }
      },
      breakers: {
        destinationIsWatan: ans("qWatan"),
        mayPassAndStopInWatan: ans("qBreakerPossible") === true || undefined,
        mayIntendTenDays: undefined
      },
      residence: {
        atDestination: true,
        intendsTenDays: tenDays,
        certainty: tenDays === true ? $("qCertainty").value : undefined,
        oneSettlement: tenDays === true ? ans("qOneSettlement") : undefined
      },
      legs: {
        outboundKm: leg,
        returnKm: leg,
        returning: isReturn(),
        departingFromWatan: true,
        staysInCity: staysInCity
      }
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
            radius: 7, color: "#0f8a76", weight: 3, fillColor: "#ffffff", fillOpacity: 1
          }).addTo(mapState.drawn)
            .bindTooltip("Counting starts here — the " +
              ((cities.from && cities.from.name) || "city") + " border",
              { permanent: true, direction: "right", className: "tip-start" });
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
    renderBorderCheck();

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

  /* ---- rendering what the engine returned -------------------------------- */

  var SAYS = {
    QASR:  { label: "Shorten your prayers", cls: "" },
    JAMA:  { label: "Pray both — shortened, then full", cls: " verdict--both" },
    TAMAM: { label: "Pray in full", cls: " verdict--full" }
  };

  var RAKAHS = [
    { name: "Fajr",    full: 2, short: 2 },
    { name: "Dhuhr",   full: 4, short: 2 },
    { name: "Asr",     full: 4, short: 2 },
    { name: "Maghrib", full: 3, short: 3 },
    { name: "Isha",    full: 4, short: 2 }
  ];

  /* What the folded panel says about itself. A condition left at its default
     is not worth a word; one that has been changed must be visible without
     opening anything, or the fold hides the very thing that decided it.     */
  var CONDITION_LABELS = [
    ["qIntent",          false, "no intention at the outset", "was the distance intended at the outset?"],
    ["qWatan",           true,  "destination is a homeland",  "is the destination your homeland?"],
    ["qTenDays",         true,  "staying ten days",           "will you stay ten days?"],
    ["qBreakerPossible", true,  "a stop is possible on the way", null],
    ["qKathir",          true,  "travel is my work",          null],
    ["qSin",             true,  "unlawful or futile purpose", null]
  ];

  function updateCondState() {
    var unanswered = [], set = [];

    CONDITION_LABELS.forEach(function (c) {
      var v = ans(c[0]);
      if (v === undefined) { if (c[3]) unanswered.push(c[3]); return; }
      if (v === c[1]) set.push(c[2]);
    });

    if (ans("qTenDays") === true) {
      if ($("qCertainty").value !== "certain") set.push("the ten days are not certain");
      if (ans("qOneSettlement") === false) set.push("ten days across two settlements");
    }

    var el = $("condState");
    /* Every slider now rests on the ordinary journey, so nothing is normally
       unanswered. The branch stands because the engine can still be handed an
       undefined answer, and silence must never read as "no". §15            */
    if (unanswered.length) {
      el.textContent = "Needs an answer — " + unanswered.join("; ");
      el.className = "conds__state is-asking";
    } else if (set.length) {
      el.textContent = set.join(" · ");
      el.className = "conds__state is-set";
    } else {
      el.textContent = "Standard journey — open to check";
      el.className = "conds__state";
    }
  }

  function rule() {
    if (!lastRoute) return;
    render(Fiqh.evaluate(buildTrip(lastRoute.km)));
    renderRoutes();
  }

  function render(result) {
    lastResult = result;

    /* Nothing may be ruled until the reader has answered. §15 */
    if (result.verdict === Fiqh.UNDETERMINED) {
      $("undeterminedCard").hidden = false;
      $("segmentsCard").hidden = true;
      $("verdict").className = "verdict verdict--ask";
      $("verdictLabel").textContent = "Not enough to rule on";
      $("verdictSub").textContent = "Answer the questions below and the ruling follows.";
      $("condPanel").open = true;      /* the answers it wants are in there */
      var asks = $("undetermined");
      asks.innerHTML = "";
      result.undetermined.forEach(function (u) {
        var li = document.createElement("li");
        li.innerHTML = "<b>" + u.question + "</b><span>" + u.whyItMatters + "</span>" + citeList(u.citations);
        asks.appendChild(li);
      });
      $("result").hidden = false;
      renderMap(null);
      return;
    }

    $("undeterminedCard").hidden = true;
    $("segmentsCard").hidden = false;

    var says = SAYS[result.verdict];
    $("verdict").className = "verdict" + says.cls;
    $("verdictLabel").textContent = says.label;
    $("verdictSub").textContent = summarise(result);

    /* every segment, with its conditions and their masāʾil */
    var box = $("segments");
    box.innerHTML = "";
    result.segments.forEach(function (seg) {
      box.appendChild(segmentCard(seg));
    });

    renderMeasure(result);

    var adv = $("advisories");
    adv.innerHTML = "";
    result.advisories.forEach(function (a) {
      var div = document.createElement("div");
      div.className = "note note--info";
      div.innerHTML = a.text + citeList(a.citations);
      adv.appendChild(div);
    });
    $("advisoryCard").hidden = !result.advisories.length;

    $("result").hidden = false;
    renderMap(metricsFor(result));
  }

  function summarise(result) {
    var parts = result.segments.map(function (s) {
      return s.name.toLowerCase() + ": " + SAYS[s.verdict].label.toLowerCase();
    });
    return parts.join("; ") + ".";
  }

  function segmentCard(seg) {
    var el = document.createElement("details");
    el.className = "segment segment--" + seg.verdict.toLowerCase();
    el.innerHTML =
      "<summary><b>" + seg.name + "</b><span>" + SAYS[seg.verdict].label + "</span></summary>";

    var body = document.createElement("div");
    body.className = "segment__body";

    var tbl = document.createElement("table");
    tbl.className = "prayers";
    tbl.innerHTML = "<thead><tr><th scope='col'>Prayer</th><th scope='col'>Rakʿahs</th></tr></thead>";
    var tb = document.createElement("tbody");
    RAKAHS.forEach(function (p) {
      var text = seg.verdict === "TAMAM" ? p.full + " rakʿah"
               : seg.verdict === "JAMA"  ? (p.short === p.full ? p.short + " rakʿah" : p.short + " and " + p.full + " rakʿah")
               : p.short + " rakʿah";
      tb.innerHTML += "<tr><th scope='row'>" + p.name + "</th><td>" + text + "</td></tr>";
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);

    if (seg.qasrBeginsAt) {
      var when = document.createElement("p");
      when.className = "hint";
      when.innerHTML = seg.qasrBeginsAt.text + citeList(seg.qasrBeginsAt.citations);
      body.appendChild(when);
    }

    var ol = document.createElement("ol");
    ol.className = "conditions";
    [1,2,3,4,5,6,7,8,9].forEach(function (c) {
      var o = seg.outcomes[c];
      var li = document.createElement("li");
      li.className = "cond cond--" + o.verdict.toLowerCase();
      li.innerHTML = "<span class='cond__v'>" + o.verdict + "</span>" + o.reasoning + citeList(o.citations);
      ol.appendChild(li);
    });
    var more = document.createElement("details");
    more.className = "why";
    more.innerHTML = "<summary>The nine conditions, one by one</summary>";
    more.appendChild(ol);
    body.appendChild(more);

    el.appendChild(body);
    return el;
  }

  function citeList(cites) {
    if (!cites || !cites.length) return "";
    return " <span class='cite'>" + cites.map(function (c) {
      return "<a href='https://www.sistani.org/persian/book/26575/' rel='noopener'>" + c + "</a>";
    }).join(" · ") + "</span>";
  }

  function metricsFor(result) {
    var out = result.segments.filter(function (s) { return s.kind === "outbound"; })[0];
    var edge = toKm(Math.max(0, parseFloat($("edgeKm").value) || 0));
    return {
      edgeKm: edge,
      limitKm: Fiqh.THRESHOLD_KM,
      roundTrip: isReturn(),
      meets: out && out.outcomes[1].verdict === "QASR"
    };
  }

  function renderMeasure(result) {
    var out  = result.segments.filter(function (s) { return s.kind === "outbound"; })[0];
    var back = result.segments.filter(function (s) { return s.kind === "return"; })[0];
    var edge = toKm(Math.max(0, parseFloat($("edgeKm").value) || 0));
    var home = (cities.from && cities.from.name) || "your city";
    var leg  = Math.max(0, lastRoute.km - edge);
    var combined = out && out._combined === true;
    var counted  = out && out._counted != null ? out._counted : leg;

    var dl = $("measure");
    dl.innerHTML = "";

    dl.appendChild(measureRow("Road to the destination",
      fmtKm(lastRoute.km) + (lastRoute.minutes ? " · " + fmtDuration(lastRoute.minutes) : "")));

    if (edge > 0) {
      dl.appendChild(measureRow("Not counted — inside " + home, "− " + fmtKm(edge), false, "is-off"));
    }

    /* A road that never leaves the city has nothing to count, and saying
       "counts: 40 km" above a total of nought is a contradiction on its face. */
    if (borderCheck.within) {
      dl.appendChild(measureRow("Never leaves " + home, "nothing to count", false, "is-off"));
    } else {
      dl.appendChild(measureRow(combined ? "Counted going" : "Counted", fmtKm(leg)));
    }

    if (borderCheck.within) {
      /* nothing more to add: the journey never began */
    } else if (combined && back) {
      dl.appendChild(measureRow("Counted returning", "+ " + fmtKm(leg)));
    } else if (back && out && out._talfiqRefused) {
      dl.appendChild(measureRow("Return not counted", out._talfiqRefused, false, "is-off"));
    }

    dl.appendChild(measureRow("Total counted", fmtKm(counted), true));

    var gap = Fiqh.THRESHOLD_KM - counted;
    dl.appendChild(measureRow("Needed to shorten — 8 farsakh",
      fmtKm(Fiqh.THRESHOLD_KM) + (counted >= Fiqh.THRESHOLD_KM
        ? " · met, " + fmtKm(-gap) + " over"
        : " · " + fmtKm(gap) + " short")));

    var pct = Math.max(2, Math.min(100, (counted / Fiqh.THRESHOLD_KM) * 100));
    $("gaugeFill").style.width = pct + "%";
    $("gaugeFill").className = "gauge__fill" + (counted >= Fiqh.THRESHOLD_KM ? " is-over" : "");

    var src = lastRoute.source;
    $("measureNote").innerHTML =
      src === "straight" ? "The routing service could not be reached, so this is the straight line — always shorter than the road." :
      src === "crow"     ? "As the crow flies, at your request. The law counts the road travelled." :
      src === "manual"   ? "From the distance you entered by hand." :
      "Counted from your city border to the destination itself, along the road travelled. " +
      "<span class='cite'>1704 · 1705</span>";
  }

  function measureRow(term, value, total, extra) {
    var div = document.createElement("div");
    div.className = (total ? "is-total " : "") + (extra || "");
    var dt = document.createElement("dt"); dt.textContent = term;
    var dd = document.createElement("dd"); dd.textContent = value;
    div.appendChild(dt); div.appendChild(dd);
    return div;
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

  /* The check, said plainly under the map. [1704] */
  function renderBorderCheck() {
    var el = $("borderCheck");
    if (!lastRoute) { el.hidden = true; return; }
    el.hidden = false;

    if (borderCheck.ok && borderCheck.within) {
      el.className = "bordercheck is-within";
      el.innerHTML = "<b>Inside one city.</b> " + borderCheck.reason;
      return;
    }
    if (borderCheck.ok) {
      el.className = "bordercheck is-ok";
      el.innerHTML = "<b>Counting from the " + borderCheck.city + " border.</b> " +
        "The " + fmtKm(borderCheck.km) + " from your door to it is drawn faint and is not counted." +
        (cities.from && cities.from.fromAggregate
          ? " No town-level boundary is published for " + borderCheck.city +
            ", so this is the edge of the whole built-up area — which is what the text measures from."
          : "") +
        " <span class='cite'>1704</span>";
      return;
    }
    el.className = "bordercheck is-off";
    el.innerHTML = "<b>Not counting from a city border.</b> " + borderCheck.reason +
      " <span class='cite'>1704</span>";
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
    function fail(reason) {
      borderCheck = { ok: false, reason: reason, km: 0, city: city && city.name };
      renderBorderCheck();
    }

    staysInCity = false;
    if (!lastRoute || !lastRoute.line) return;          /* nothing measured yet */

    if (!city || !city.name) {
      say("No city identified for the start, so the count runs from the address itself.", "hint--warn");
      fail("No city was identified for the start, so the distance is counted from the address itself — which overstates it.");
      return;
    }

    /* Does the journey end inside the same city? Asked of the two addresses
       themselves, not of the road between them: a city border is a ragged
       thing, and a road across a large one dips outside and back without
       taking anyone out of town.

       Where a border is published, the test is whether both ends fall within
       it. Where none is, two addresses that resolve to the same city are in
       the same city, which is the question being asked.                      */
    if (city.shape && places.from && places.to) {
      staysInCity = inShape(places.from.lat, places.from.lon, city.shape) &&
                    inShape(places.to.lat, places.to.lon, city.shape);
    } else if (cities.to && cities.to.name && city.name) {
      staysInCity = cities.to.name.toLowerCase() === city.name.toLowerCase();
    }

    if (staysInCity) {
      say("Both ends lie inside <b>" + city.name + "</b>, so nothing is counted: you never leave town.", "hint--warn");
      if (!edgeTouched) $("edgeKm").value = "";
      borderCheck = { ok: true, within: true, reason: "Both ends lie inside " + city.name + ", so the border is never crossed and nothing is counted.", km: 0, city: city.name };
      renderBorderCheck();
      return;
    }

    if (!city.shape) {
      say("No published border for <b>" + city.name + "</b>, so the count runs from the address itself. " +
          "Name another city above, or type the distance to your city's edge here.", "hint--warn");
      fail("No border is published for " + city.name + ", so the distance is counted from the address itself — which overstates it. Name another city, or enter the distance to your city's edge by hand.");
      return;
    }

    var polyKm = polylineKm(lastRoute.line);
    var exit = borderExitKm(lastRoute.line, city.shape,
                            polyKm > 0 ? lastRoute.km / polyKm : 1);

    if (exit === null) {
      say("The start lies outside <b>" + city.name + "</b> and this route does not pass through it, so nothing is deducted. " +
          "Choose the city you would call leaving town, above.", "hint--warn");
      if (!edgeTouched) $("edgeKm").value = "";
      fail("The start lies outside " + city.name + " and the route never crosses its border, so nothing is deducted. Choose the city whose edge you would call leaving town.");
      return;
    }

    borderCheck = { ok: true, reason: null, km: exit, city: city.name };
    renderBorderCheck();

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
      var bothLegs = isReturn() && ans("qWatan") !== true && ans("qTenDays") !== true;
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
      rule();
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
        rule();
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
    rule();
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

    /* Everything is cached to spare the services; a refresh empties the caches
       and asks again, which is what to reach for when a border or a road looks
       wrong or a lookup failed a moment ago. */
    $("refreshBtn").addEventListener("click", function () {
      if (!places.from && !$("fromInput").value.trim()) { $("fromInput").focus(); return; }
      Object.keys(geocodeCache).forEach(function (k) { delete geocodeCache[k]; });
      Object.keys(cityCache).forEach(function (k) { delete cityCache[k]; });
      cities = { from: null, to: null };
      cityOptions = null;
      routes = [];
      roadRoute = crowRoute = lastRoute = null;
      edgeTouched = false;
      if (!$("manualKm").value.trim()) $("edgeKm").value = "";
      mapState.fitted = null;
      this.disabled = true;
      this.textContent = "Refreshing…";
      var btn = this;
      say("Looking everything up again…");
      calculate();
      setTimeout(function () { btn.disabled = false; btn.textContent = "Refresh"; }, 1200);
    });

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
      $("tenDaysDetail").hidden = true;
      $("condPanel").open = false;
      updateCondState();
      $("undeterminedCard").hidden = true;
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
    document.querySelectorAll(".toggle input[type='radio']").forEach(function (el) {
      el.addEventListener("change", function () {
        if (this.name === "qTenDays") $("tenDaysDetail").hidden = this.value !== "yes";
        updateCondState();
        recalc();
      });
    });
    $("qCertainty").addEventListener("change", function () { updateCondState(); recalc(); });
    updateCondState();


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
    /* The geography only. Rulings belong to Fiqh.evaluate and nowhere else. */
    inShape: inShape, borderExitKm: borderExitKm, haversineKm: haversineKm,
    extentKm2: extentKm2, NEAR_CITY_KM: NEAR_CITY_KM
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
