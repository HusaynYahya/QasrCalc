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
  /* The alternatives, fetched all at once and reported as they arrive.

     This was a chain: each lookup waited for the one before it to come back,
     and only then waited its turn in the address queue. Five lookups meant
     five round trips stacked on five one-second pauses, and nothing on screen
     until the last of them landed.

     Now they are all started together. The address service still gets one
     request a second, as its terms require — that pacing is the queue's job,
     not the caller's — but the waiting overlaps instead of accumulating, and
     each city appears the moment it is known.                                */
  function cityChoices(place, onFound) {
    var found = [];

    /* Where the place lies inside a ring road, that road is one of the
       choices — and the one already in use, so it belongs at the top. */
    var ringed = ringRoadNear(place)
      ? cityWithRing(place, false).then(function (c) { return c && c.fromRing ? c : null; })
                                  .catch(function () { return null; })
      : Promise.resolve(null);
    function add(city, first) {
      if (!city || !city.name) return;
      var at = -1;
      found.forEach(function (c, i) { if (c.name === city.name) at = i; });
      if (at >= 0) {
        /* Two answers for one name. The one measured from a ring road wins:
           it is the border actually in use, and the other would quietly put
           the council's boundary back.                                       */
        if (city.fromRing && !found[at].fromRing) found[at] = city;
        else return;
      } else if (first) found.unshift(city);
      else found.push(city);
      if (onFound) onFound(found);
    }

    /* Overpass answers on its own host, so it need not wait behind the
       address lookups at all — it used to be asked only after all of them.   */
    var nearby = biggestCityNear(place)
      .then(function (big) {
        if (!big) return null;
        return cityByName(big.name).then(function (settlement) {
          /* Only if it really is elsewhere. Describing the city you are
             standing in as "the largest nearby, 23 km away" is nonsense.    */
          if (!inShape(place.lat, place.lon, settlement.shape)) {
            settlement.note = "the largest city nearby, " + fmtKm(big.away) + " away";
          }
          return settlement;
        });
      })
      .catch(function () { return null; });

    var byZoom = [12, 10].map(function (zoom) {
      return cityAt(place, zoom)
        .then(function (city) {
          if (!city || !city.name) return null;
          if (isSettlement(city) && city.shape) return city;
          /* Named by a district or a county — take the settlement itself. */
          return cityByName(city.name, place)
            .then(function (settlement) {
              /* Keep whichever knows the border. A named lookup that comes
                 back without one must not displace a shape already found.    */
              return settlement.shape ? settlement : (city.shape ? city : settlement);
            })
            .catch(function () { return city; });
        })
        .then(function (city) { add(city); })
        .catch(function () {});
    });

    /* The largest city goes to the front whenever it lands: it is the one a
       reader is least likely to think of, and most likely to want.           */
    var big = nearby.then(function (city) { add(city, true); });
    var ring = ringed.then(function (city) { add(city, true); });

    return Promise.all(byZoom.concat([big, ring])).then(function () {
      /* Whatever order they arrived in, a ring road that is already the edge
         being measured from goes first. */
      found.sort(function (a, b) { return (b.fromRing ? 1 : 0) - (a.fromRing ? 1 : 0); });
      return found;
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

  /* Everything drawn on the map takes its colour from the stylesheet, so the
     page and the map change together when the theme does, and no colour is
     written down twice — which a lint test used to have to guard.           */
  function paint(token) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(token);
    return (v || "").trim() || "#000000";
  }

  /* Light tiles under a light page, dark under a dark one. The stylesheet
     names which set, so the theme is decided in one place. */
  function tileUrl() {
    var set = paint("--map-tiles").replace(/["']/g, "") || "light_all";
    return "https://{s}.basemaps.cartocdn.com/" + set + "/{z}/{x}/{y}{r}.png";
  }

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

  /* Some answers are slow to fetch and good for months — a motorway's course
     above all. They are kept in the browser between visits. Every access is
     guarded: private windows, cleared site data and full quotas all throw,
     and none of them is a reason to fail.                                    */
  function stored(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var box = JSON.parse(raw);
      if (!box || (Date.now() - box.at) > 30 * 24 * 3600 * 1000) return null;
      return box.value;
    } catch (e) { return null; }
  }
  function keep(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value: value })); }
    catch (e) { /* out of room, or refused — the fetch simply happens again */ }
  }

  /* ---- a ring road as the city's edge ----------------------------------- */

  /* Where a city has outgrown its council boundary, common usage draws the
     line somewhere else — and around London that line is the M25. Which edge
     counts is a judgement of common usage, not of administration [1704], so
     the motorway's own geometry is fetched and the area it encloses stands in
     for the published boundary.

     The road is traced, not approximated. Overpass returns the route relation
     as a heap of member ways, in no particular order and pointing in no
     particular direction; they are stitched end to end into the loop the road
     actually makes. A convex hull was tried first and thrown away: it cut
     straight across every concave stretch, swallowing tens of square miles of
     Hertfordshire and Surrey the road plainly runs inside of.

     A ring road is only a ring if the whole of it carries the number. The M25
     does not: its eastern side across the Thames is the A282, so that is
     asked for too. Where a gap remains, the ends are joined and the fact is
     reported rather than hidden.                                             */
  /* Ring roads that stand in for a city's edge, with a box that comfortably
     contains each. The box is a cheap gate: an address outside it cannot be
     inside the road, so the road is never fetched for one. Only an address
     inside the box is tested against the traced ring itself.                 */
  /* The M25, by its junctions, clockwise from the Dartford Crossing. Its
     eastern side across the Thames is the A282, and the ring closes over it.

     Carried in the page rather than fetched. The motorway does not move, and
     making London's boundary depend on a map server that may be slow,
     unreachable, or answer in a shape the stitching cannot close meant that
     an address plainly inside the M25 could be called Watford, shown no
     border, and ruled a journey. A boundary this central to the answer should
     not be able to fail at all.

     The junctions are the road's own; between them it is a curve fitted
     through the junctions either side, which follows the motorway's bends
     rather than cutting across them. That takes the perimeter from 186 km to
     187.5 against the road's true 191, and never moves the line more than
     625 m from the straight chord it replaces.

     What remains is a kilometre or so at the widest sweeps. Against a legal
     distance of 44 km that cannot move a ruling; it can only matter for an
     address within about a kilometre of the motorway itself, and there the
     question of whether you are inside London is one for the reader anyway.  */
  var M25 = [
    [0.25600, 51.44600],
    [0.25523, 51.43626],
    [0.25481, 51.42631],
    [0.25274, 51.41696],
    [0.24700, 51.40900],
    [0.23634, 51.40303],
    [0.22206, 51.39850],
    [0.20601, 51.39447],
    [0.19000, 51.39000],
    [0.17181, 51.38617],
    [0.15138, 51.38303],
    [0.13375, 51.37813],
    [0.12400, 51.36900],
    [0.12834, 51.35262],
    [0.14244, 51.33109],
    [0.15557, 51.30964],
    [0.15700, 51.29350],
    [0.14184, 51.28474],
    [0.11650, 51.28034],
    [0.08716, 51.27790],
    [0.06000, 51.27500],
    [0.03651, 51.27087],
    [0.01344, 51.26684],
    [-0.01010, 51.26364],
    [-0.03500, 51.26200],
    [-0.06331, 51.26323],
    [-0.09394, 51.26658],
    [-0.12311, 51.26963],
    [-0.14700, 51.27000],
    [-0.16146, 51.26513],
    [-0.16957, 51.25695],
    [-0.17837, 51.24974],
    [-0.19490, 51.24780],
    [-0.22258, 51.25371],
    [-0.25713, 51.26470],
    [-0.29409, 51.27704],
    [-0.32900, 51.28700],
    [-0.36262, 51.29269],
    [-0.39669, 51.29639],
    [-0.42817, 51.30065],
    [-0.45400, 51.30800],
    [-0.47275, 51.32061],
    [-0.48625, 51.33663],
    [-0.49637, 51.35258],
    [-0.50500, 51.36500],
    [-0.51199, 51.37177],
    [-0.51656, 51.37513],
    [-0.51960, 51.37817],
    [-0.52200, 51.38400],
    [-0.52445, 51.39411],
    [-0.52631, 51.40663],
    [-0.52652, 51.41958],
    [-0.52400, 51.43100],
    [-0.51680, 51.44023],
    [-0.50606, 51.44838],
    [-0.49529, 51.45608],
    [-0.48800, 51.46400],
    [-0.48499, 51.47134],
    [-0.48444, 51.47806],
    [-0.48591, 51.48601],
    [-0.48900, 51.49700],
    [-0.49550, 51.51280],
    [-0.50500, 51.53200],
    [-0.51375, 51.55170],
    [-0.51800, 51.56900],
    [-0.51553, 51.58324],
    [-0.50875, 51.59594],
    [-0.50084, 51.60741],
    [-0.49500, 51.61800],
    [-0.49348, 51.62770],
    [-0.49412, 51.63638],
    [-0.49345, 51.64411],
    [-0.48800, 51.65100],
    [-0.47447, 51.65657],
    [-0.45550, 51.66094],
    [-0.43653, 51.66509],
    [-0.42300, 51.67000],
    [-0.41787, 51.67643],
    [-0.41775, 51.68369],
    [-0.41850, 51.69060],
    [-0.41600, 51.69600],
    [-0.40893, 51.69931],
    [-0.39956, 51.70125],
    [-0.38916, 51.70256],
    [-0.37900, 51.70400],
    [-0.36966, 51.70564],
    [-0.36037, 51.70713],
    [-0.35041, 51.70855],
    [-0.33900, 51.71000],
    [-0.32549, 51.71197],
    [-0.31044, 51.71425],
    [-0.29491, 51.71591],
    [-0.28000, 51.71600],
    [-0.26580, 51.71372],
    [-0.25181, 51.70975],
    [-0.23816, 51.70541],
    [-0.22500, 51.70200],
    [-0.21260, 51.70005],
    [-0.20081, 51.69881],
    [-0.18912, 51.69766],
    [-0.17700, 51.69600],
    [-0.16428, 51.69372],
    [-0.15125, 51.69113],
    [-0.13809, 51.68822],
    [-0.12500, 51.68500],
    [-0.11289, 51.68070],
    [-0.10137, 51.67556],
    [-0.08867, 51.67115],
    [-0.07300, 51.66900],
    [-0.05308, 51.67034],
    [-0.03012, 51.67406],
    [-0.00611, 51.67826],
    [0.01700, 51.68100],
    [0.03899, 51.68234],
    [0.06081, 51.68313],
    [0.08223, 51.68259],
    [0.10300, 51.68000],
    [0.12277, 51.67470],
    [0.14175, 51.66725],
    [0.16061, 51.65867],
    [0.18000, 51.65000],
    [0.20221, 51.64159],
    [0.22619, 51.63288],
    [0.24757, 51.62347],
    [0.26200, 51.61300],
    [0.26601, 51.60113],
    [0.26269, 51.58813],
    [0.25752, 51.57456],
    [0.25600, 51.56100],
    [0.26070, 51.54669],
    [0.26831, 51.53163],
    [0.27552, 51.51750],
    [0.27900, 51.50600],
    [0.27685, 51.49855],
    [0.27119, 51.49394],
    [0.26468, 51.48985],
    [0.26000, 51.48400],
    [0.25806, 51.47560],
    [0.25738, 51.46594],
    [0.25700, 51.45580],
    [0.25600, 51.44600]
  ];

  var RING_ROADS = [
    { city: "London", area: "England", refs: ["M25", "A282"],
      /* A box that contains the ring, checked before the ring itself: it is
         a handful of comparisons against a point, where the ring is a walk
         round three dozen. */
      box: [51.20, -0.62, 51.78, 0.36],
      shape: { type: "Polygon", coordinates: [M25] },
      areaKm2: 2269 }
  ];

  /* Keyed by name as well, for a city named by hand. */
  var RING_ROAD = {};
  RING_ROADS.forEach(function (r) { RING_ROAD[r.city.toLowerCase()] = r.refs; });

  /* What a city's ring road may plausibly enclose. The M25 holds about 2,200
     square kilometres. A figure far outside this range is not a ring road: it
     is a chain that stitched wrongly, or a hull thrown round the wreckage,
     and adopting it as somebody's city would be worse than not trying.      */
  var RING_MIN_KM2 = 40, RING_MAX_KM2 = 25000;

  function ringIsSound(ring) {
    return !!ring && ring.traced === true && ring.closedByHand === false &&
           ring.areaKm2 >= RING_MIN_KM2 && ring.areaKm2 <= RING_MAX_KM2;
  }

  /* Worth tracing a ring road for this place at all? */
  function ringRoadNear(place) {
    if (!place || typeof place.lat !== "number" || typeof place.lon !== "number") return null;
    for (var i = 0; i < RING_ROADS.length; i++) {
      var b = RING_ROADS[i].box;
      if (place.lat >= b[0] && place.lat <= b[2] &&
          place.lon >= b[1] && place.lon <= b[3]) return RING_ROADS[i];
    }
    return null;
  }

  /* As many points as the border may keep. Every one of them is walked for
     each point of a route tested against it, and a few thousand costs
     milliseconds — so this is set by what stays honest to the road, not by
     what the browser can bear.                                              */
  var RING_MAX_POINTS = 2500;

  /* How close two way-ends must be to count as the same place. OSM leaves
     small gaps where ways meet; 80 m closes them without ever joining the two
     carriageways of a dual carriageway, which run further apart than that.   */
  var JOIN_KM = 0.08;

  function ptsMeet(a, b) {
    return haversineKm({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }) <= JOIN_KM;
  }

  /* Stitch a heap of polylines into as few chains as they will make. Each way
     may need reversing, and which end joins which is not known in advance, so
     all four pairings are tried.                                             */
  function stitchLines(lines) {
    var pool = lines.filter(function (l) { return l && l.length > 1; });
    var chains = [];

    while (pool.length) {
      var chain = pool.pop(), grew = true;
      while (grew) {
        grew = false;
        for (var i = 0; i < pool.length; i++) {
          var w = pool[i], head = chain[0], tail = chain[chain.length - 1];
          if (ptsMeet(tail, w[0]))                    chain = chain.concat(w.slice(1));
          else if (ptsMeet(tail, w[w.length - 1]))    chain = chain.concat(w.slice(0, -1).reverse());
          else if (ptsMeet(head, w[w.length - 1]))    chain = w.slice(0, -1).concat(chain);
          else if (ptsMeet(head, w[0]))               chain = w.slice(1).reverse().concat(chain);
          else continue;
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
      chains.push(chain);
    }
    return chains;
  }

  /* The shoelace area, in square kilometres. Used only to compare one chain
     against another, so the flat-earth approximation costs nothing.          */
  function ringAreaKm2(ring) {
    if (!ring || ring.length < 3) return 0;
    var sum = 0, latSum = 0, i, j;
    for (i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      latSum += ring[i][1];
    }
    var lat = latSum / ring.length;
    return Math.abs(sum / 2) * 111.32 * 111.32 * Math.cos(lat * Math.PI / 180);
  }

  /* Douglas–Peucker. The traced road arrives with tens of thousands of
     points, and every one of them is walked for each point tested against the
     border. Fifty metres of slack is far below anything that could move a
     verdict, and takes the count down by more than an order of magnitude.
     Iterative rather than recursive: the recursion is as deep as the line is
     long in the worst case.                                                  */
  function simplifyLine(points, toleranceKm) {
    if (points.length < 3) return points.slice();
    var keep = new Array(points.length), stack = [[0, points.length - 1]], i;
    for (i = 0; i < keep.length; i++) keep[i] = false;
    keep[0] = keep[points.length - 1] = true;

    var scale = Math.cos(points[0][1] * Math.PI / 180) * 111.32;

    while (stack.length) {
      var span = stack.pop(), lo = span[0], hi = span[1];
      if (hi - lo < 2) continue;
      var ax = points[lo][0] * scale, ay = points[lo][1] * 111.32;
      var bx = points[hi][0] * scale, by = points[hi][1] * 111.32;
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      var far = -1, farAt = -1;
      for (i = lo + 1; i < hi; i++) {
        var px = points[i][0] * scale, py = points[i][1] * 111.32;
        var away = len === 0
          ? Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay))
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
        if (away > far) { far = away; farAt = i; }
      }
      if (far > toleranceKm && farAt > 0) {
        keep[farAt] = true;
        stack.push([lo, farAt], [farAt, hi]);
      }
    }

    var out = [];
    for (i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  /* Monotone chain — kept as the fallback for a road too broken to stitch.
     Points are [lon, lat], as GeoJSON keeps them.                            */
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 &&
             cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 &&
             cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /* Every member way of everything Overpass returned, as its own polyline.
     Kept apart from the fetch so it can be exercised without a network.      */
  function ringLines(data) {
    var lines = [];
    function line(geometry) {
      var pts = [];
      (geometry || []).forEach(function (g) {
        if (g && typeof g.lat === "number" && typeof g.lon === "number") pts.push([g.lon, g.lat]);
      });
      if (pts.length > 1) lines.push(pts);
    }
    ((data && data.elements) || []).forEach(function (el) {
      (el.members || []).forEach(function (m) { line(m.geometry); });
      if (el.geometry) line(el.geometry);
    });
    return lines;
  }

  /* The loop the road makes, as a GeoJSON polygon.

     Both carriageways of a dual carriageway are in the answer, and they do
     not join each other, so stitching yields two near-identical loops. The
     larger is taken: the outer carriageway is the outer edge of the road, and
     of two lines either of which a reader would call the city's edge, the one
     that counts less distance against them is the safer.                     */
  function ringShape(data, ref) {
    var lines = ringLines(data);
    if (!lines.length) throw new Error("No road numbered " + ref + " was found near here.");

    var chains = stitchLines(lines);
    var best = null;
    chains.forEach(function (chain) {
      if (chain.length < 4) return;
      var closed = ptsMeet(chain[0], chain[chain.length - 1]);
      var area = ringAreaKm2(chain);
      /* A loop that closes on itself beats one that has to be closed by hand,
         whatever their areas; among equals, the larger.                      */
      if (!best || (closed && !best.closed) ||
          (closed === best.closed && area > best.area)) {
        best = { ring: chain, closed: closed, area: area };
      }
    });

    if (best && best.area > 0) {
      /* Thinned only as far as it must be. Slackening the tolerance in one
         jump is how the road lost its curves the first time: 50 m left 4,000
         points, 150 m left 24 — the twenty corners and nothing between them.
         So it is loosened a step at a time and stops the moment it fits.     */
      var tol = 0.05, ring = simplifyLine(best.ring, tol);
      while (ring.length > RING_MAX_POINTS && tol < 0.4) {
        tol *= 1.6;
        ring = simplifyLine(best.ring, tol);
      }
      /* Five decimals is a metre on the ground — far past anything that
         could move a verdict, and it halves what has to be stored.           */
      ring = ring.map(function (p) {
        return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
      });
      if (!ptsMeet(ring[0], ring[ring.length - 1])) ring.push(ring[0].slice());
      else ring[ring.length - 1] = ring[0].slice();     /* exactly closed */
      if (ring.length >= 4) {
        return { shape: { type: "Polygon", coordinates: [ring] },
                 traced: true, closedByHand: !best.closed, points: ring.length,
                 areaKm2: Math.round(ringAreaKm2(ring) * 10) / 10 };
      }
    }

    /* Nothing stitched into a loop. Rather than refuse, fall back to the hull
       of every point — a cruder line, and said to be one.                    */
    var all = [];
    lines.forEach(function (l) { all = all.concat(l); });
    var hull = convexHull(all);
    if (hull.length < 3) throw new Error("The " + ref + " does not enclose an area.");
    hull.push(hull[0].slice());
    return { shape: { type: "Polygon", coordinates: [hull] },
             traced: false, closedByHand: false, points: hull.length,
             areaKm2: Math.round(ringAreaKm2(hull) * 10) / 10 };
  }

  /* "out geom" and not a bare "out": without it the relation comes back as a
     list of member ids, with no coordinates to draw or measure.              */
  function ringBoundary(refs, near) {
    var wanted = (Array.isArray(refs) ? refs : String(refs || "").split(","))
      .map(function (r) { return String(r).trim().toUpperCase().replace(/[^A-Z0-9 .\/-]/g, ""); })
      .filter(Boolean);
    if (!wanted.length) return Promise.reject(new Error("Name a road first."));
    var ref = wanted.join(" and ");

    /* Narrowed to the reader's part of the world where we know it: "M25" is
       not a number unique to England.

       A bounding box and not "around": Overpass indexes by box, so it answers
       in a moment, where a 150 km radius test against every relation on the
       planet takes it tens of seconds.                                       */
    var box = "";
    if (near && typeof near.lat === "number" && typeof near.lon === "number") {
      var dLat = 150 / 111.32;
      var dLon = 150 / (111.32 * Math.max(0.1, Math.cos(near.lat * Math.PI / 180)));
      box = "[bbox:" + (near.lat - dLat).toFixed(3) + "," + (near.lon - dLon).toFixed(3) +
            "," + (near.lat + dLat).toFixed(3) + "," + (near.lon + dLon).toFixed(3) + "]";
    }

    /* A motorway does not move. Tracing it costs a megabyte of geometry and
       several seconds; the answer is a few hundred rounded pairs. It is worth
       fetching once and keeping.                                             */
    var key = "qasr.ring.v1:" + ref + box;
    var was = stored(key);
    if (was && was.shape) return Promise.resolve(was);

    /* "skel" drops the tags and version stamps from every way; only the
       geometry is wanted, and it is most of the reply either way.            */
    var query = "[out:json][timeout:60]" + box + ";(" +
      wanted.map(function (r) {
        return "relation[\"ref\"=\"" + r + "\"][\"type\"=\"route\"][\"route\"=\"road\"];";
      }).join("") +
      ");out skel geom;";

    function ask(hosts, why) {
      if (!hosts.length) return Promise.reject(new Error(why || "No map server answered."));
      return fetch(hosts[0] + "?data=" + encodeURIComponent(query))
        .then(function (r) {
          if (!r.ok) throw new Error(hosts[0].split("/")[2] + " returned " + r.status);
          return r.json();
        })
        .catch(function (err) { return ask(hosts.slice(1), err && err.message); });
    }

    return ask(OVERPASS).then(function (data) {
      var out = ringShape(data, ref);
      out.ref = ref;
      keep(key, out);
      return out;
    });
  }

  var nameCache = {};

  /* A shallow copy is enough: the shape is only ever read, never edited. */
  function copyCity(city) {
    if (!city) return city;
    var out = {};
    Object.keys(city).forEach(function (k) { out[k] = city[k]; });
    return out;
  }

  function cityByName(name, mustContain) {
    var cacheKey = String(name).toLowerCase() + "|" + (mustContain
      ? mustContain.lat.toFixed(2) + "," + mustContain.lon.toFixed(2) : "");
    /* A copy, never the cached object. Callers annotate what they get back —
       a note here, a ring road there — and handing out one shared object let
       those annotations pile up on each other: a London labelled "measured
       from the M25" while carrying the council's boundary, and a start
       address then reported as outside its own city.                        */
    if (nameCache[cacheKey]) return Promise.resolve(copyCity(nameCache[cacheKey]));
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
        var city = {
          /* The name the reader asked for, not the administrative label the
             boundary happens to carry. */
          name: fromAggregate ? settlementName
              : (a.city || a.town || a.village || a.municipality ||
                 (row.display_name || "").split(",")[0]),
          area: a.state || a.county || a.country || null,
          fromAggregate: fromAggregate,
          shape: row.geojson && /Polygon/.test(row.geojson.type) ? row.geojson : null
        };
        nameCache[cacheKey] = city;      /* failures are not kept: they retry */
        return copyCity(city);
      });
  }

  /* The city for a place, taking a ring road as the edge wherever the place
     falls inside one.

     An address inside the M25 is in London however the address service labels
     it — Watford, Croydon and Cricklewood alike — and the distance is measured
     from the motorway, not from a council boundary somewhere inside it. The
     box is checked first so that no address outside the south-east ever costs
     a request, and the traced ring decides it after that.                    */
  function cityWithRing(place, announce) {
    var entry = ringRoadNear(place);
    /* No network, no waiting, nothing to fail: the ring is in the page, and
       the only question is whether the address falls inside it.             */
    if (entry && entry.shape && inShape(place.lat, place.lon, entry.shape)) {
      return Promise.resolve({
        name: entry.city, area: entry.area || null,
        shape: entry.shape, fromRing: entry.refs.join(" and "),
        ringArea: entry.areaKm2, ringTraced: true, ringClosedByHand: false,
        ringTried: true, ringAuto: true
      });
    }
    return cityOf(place);
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
  /* Whether two places inside one ring road are one city. Undefined until
     asked, and asked only where a ring road made it doubtful.                */
  var ringSameCity;
  var oneCityDoubt = false;
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
        staysInCity: oneCityDoubt ? undefined : staysInCity,
        oneCityInDoubt: oneCityDoubt
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
    mapState.tiles = L.tileLayer(tileUrl(), {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(mapState.map);
    mapState.drawn = L.layerGroup().addTo(mapState.map);
    return true;
  }

  /* The two ends of the journey are solid dots with a white rim. They used to
     be rings with a white centre, which is exactly what the shortening mark
     was, in the same green — on the map the two were indistinguishable. A
     place is now filled; nothing else on the map is.                         */
  function pin(at, colour, label) {
    L.circleMarker(at, {
      radius: 7, color: paint("--map-paper"), weight: 2.5, fillColor: colour, fillOpacity: 1
    }).addTo(mapState.drawn).bindTooltip(label);
  }

  /* Draw whatever is known: nothing at all, one address, both, or a full
     route with the reckoning marked on it. Called on load, whenever an
     address is picked, and after every calculation.                          */
  /* What the map should say about the prayer, and where it changes.

     The shortening does not begin where the eight farsakh is reached. Once a
     journey qualifies, it begins on leaving the town [1755], [1756] — and
     readers were reading the eight-farsakh mark as the moment of change,
     because both were drawn as the same green circle. This decides what each
     length of road means; renderMap only draws it.

     Kept a pure function of the measure so it can be tested without a map. */
  function prayerStates(m) {
    var leg = m && m.legVerdict;
    var begins = m && m.qasrBegins;
    var doubted = begins && begins.where === "undetermined";

    if (!m || (leg !== "QASR" && leg !== "JAMA") || doubted) {
      return {
        changes: false,
        both: false,
        head: doubted
          ? "Pray in full — the shortening is doubted, so it does not begin"
          : "Inside your city — not counted",
        tail: "Pray in full for the whole of this journey",
        begin: null,
        beginLabel: null
      };
    }

    var both = leg === "JAMA";
    return {
      changes: true,
      both: both,
      head: "Pray in full — still in town",
      tail: both
        ? "From here pray both — shortened, then full — to the destination"
        : "Pray shortened from here to the destination",
      /* Two lengths: one to write on the map, one for prose. The full
         sentence was being pinned to the map and ran off the edge of it. */
      beginLabel: both ? "Both prayers begin about here" : "Shortening begins about here",
      begin: (both ? "Both prayers begin about here" : "Shortened prayer begins about here") +
        (begins && begins.where === "haddAlTarakhkhus"
          ? " — at ḥadd al-tarakhkhuṣ, where the town is lost to sight. The map can only show the town's edge; the line itself is judged by eye, a little beyond it."
          : " — on leaving the town.")
    };
  }

  /* The outer rings of a GeoJSON shape, whichever kind it is. */
  function ringsOf(shape) {
    if (!shape) return [];
    if (shape.type === "Polygon") return shape.coordinates.slice(0, 1);
    if (shape.type === "MultiPolygon") {
      return shape.coordinates.map(function (poly) { return poly[0]; });
    }
    return [];
  }

  /* The box the map should frame: the journey, and the border round it when
     that border is what decides the ruling.

     City borders used to be framed too, and once London's edge became the
     M25 that meant fitting a fifty-kilometre ring round a fifteen-kilometre
     drive — the journey shrank to a squiggle in the middle of it. The borders
     are context; they are still drawn, and a reader who wants the whole ring
     can zoom out to it.

     One exception, and it is the case that prompted this: where the journey
     never crosses the border — both ends inside one city — there is nothing
     on the route to look at, and the enclosing border is the whole of the
     answer. Framing the journey alone then leaves the reader zoomed in on a
     short drive with the ring that decides it somewhere off the screen. So an
     enclosing shape may be passed, and is framed with the journey.

     Returns [south, west, north, east], or null when there is no journey yet.
     A single point gives a box of no size, which the caller opens out to a
     sensible zoom.                                                           */
  function journeyBox(from, to, line, enclosing) {
    var pts = [];
    ringsOf(enclosing).forEach(function (ring) {
      ring.forEach(function (c) {
        if (c && typeof c[0] === "number" && typeof c[1] === "number") pts.push([c[1], c[0]]);
      });
    });
    if (from && typeof from.lat === "number") pts.push([from.lat, from.lon]);
    if (to && typeof to.lat === "number") pts.push([to.lat, to.lon]);
    (line || []).forEach(function (p) {
      if (p && typeof p[0] === "number" && typeof p[1] === "number") pts.push([p[0], p[1]]);
    });
    if (!pts.length) return null;

    var s = pts[0][0], n = pts[0][0], w = pts[0][1], e = pts[0][1];
    pts.forEach(function (p) {
      if (p[0] < s) s = p[0];
      if (p[0] > n) n = p[0];
      if (p[1] < w) w = p[1];
      if (p[1] > e) e = p[1];
    });
    return [s, w, n, e];
  }

  function renderMap(m) {
    if (!ensureMap()) return;

    mapState.drawn.clearLayers();
    mapState.map.invalidateSize();
    $("mapLegend").hidden = false;

    var line = m && lastRoute && lastRoute.line && lastRoute.line.length > 1
             ? lastRoute.line : null;
    var seen = [];

    /* Only the home border. It is the one the measuring starts from [1704];
       the count runs to the destination itself, not to its border, so drawing
       the destination's put a second outline on the map that decided nothing.
       The destination's city is still worked out — it is what tells us whether
       both ends lie in one place — it is simply not drawn.                    */
    /* A border the start is not inside, on a road that never enters it, is
       deducting nothing — and drawn in the same green as a working one it
       says the opposite. It is still drawn, because seeing that your address
       falls outside the city you chose is how you know to choose another one;
       but it is drawn as what it is: grey, unfilled, and labelled unused.    */
    var borderUnused = !!(borderCheck && borderCheck.ok === false && borderCheck.outside);
    var drewBorder = false;
    [["from", paint("--map-border"), "Your city"]]
      .forEach(function (spec) {
        var city = cities[spec[0]];
        if (!city || !city.shape) return;
        var tone = borderUnused ? paint("--map-faint") : spec[1];
        /* A ring road is drawn heavier and solid. It is not one boundary among
           several — it is the line the measuring starts from, and every
           reading of the map depends on seeing where it runs.                 */
        var isRing = !!city.fromRing && !borderUnused;
        var layer = L.geoJSON(city.shape, {
          style: { color: tone,
                   weight: isRing ? 3.5 : 1.5,
                   opacity: borderUnused ? .5 : (isRing ? .95 : .75),
                   dashArray: isRing ? null : "5 5",
                   fill: !borderUnused, fillOpacity: isRing ? .10 : .06, fillColor: tone }
        }).addTo(mapState.drawn).bindTooltip(spec[2] + ": " + (city.name || "border") +
          (city.fromRing ? " — traced along the " + city.fromRing +
            (city.ringArea ? ", enclosing " + Math.round(city.ringArea) + " km²" : "") : "") +
          (borderUnused ? " — your start is not inside it, so nothing is deducted from it" : ""));
        seen.push(layer.getBounds());
        drewBorder = true;
      });

    if (places.from) {
      pin([places.from.lat, places.from.lon], paint("--map-start"), places.from.label.split(",")[0] + " — start");
      seen.push(L.latLngBounds([[places.from.lat, places.from.lon]]));
    }
    if (places.to) {
      pin([places.to.lat, places.to.lon], paint("--map-dest"), places.to.label.split(",")[0] + " — destination");
      seen.push(L.latLngBounds([[places.to.lat, places.to.lon]]));
    }

    var straight = false;
    var at = null;
    var shortensHere = false;

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

      /* Two lengths of road, drawn as the two prayers. The shortening does
         not begin where the eight farsakh is reached — it begins on leaving
         the town, once the journey qualifies [1755], [1756]. Colouring the
         road by what is prayed on it is the only way to say that plainly. */
      var says = prayerStates(m);
      shortensHere = says.changes;

      if (head && head.length > 1) {
        L.polyline(head, {
          color: says.changes ? paint("--map-full") : paint("--map-faint"), weight: 4, opacity: .85,
          dashArray: "3 7"
        }).addTo(mapState.drawn).bindTooltip(says.head + " — " +
          ((cities.from && cities.from.name) || "your city"));
      }
      if (counted) {
        L.polyline(counted, {
          color: says.changes ? paint("--map-shorten") : paint("--map-full"), weight: 5, opacity: .9,
          dashArray: straight ? "6 8" : null
        }).addTo(mapState.drawn).bindTooltip(says.tail);

        /* The one point the reader came for. */
        if (head && head.length > 1) {
          /* A ring, in the amber of the stretch it ends: the road before it
             is the road prayed in full. It reads apart from the two ends of
             the journey because those are filled and this is hollow — a place
             you are at against a line you cross. Matched by .key--begin in
             qasr.css; the legend must show what the map shows.               */
          var beginMark = says.changes
            ? L.circleMarker(counted[0],
                { radius: 8, color: paint("--map-full"), weight: 4,
                  fillColor: paint("--map-paper"), fillOpacity: 1 })
            : L.circleMarker(counted[0],
                { radius: 6, color: paint("--map-paper"), weight: 2,
                  fillColor: paint("--map-full"), fillOpacity: 1 });
          beginMark
            .addTo(mapState.drawn)
            .bindTooltip(says.beginLabel || ("Counting starts here — the " +
              ((cities.from && cities.from.name) || "city") + " border"),
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
        /* A cross, and neither green nor amber. Every other mark on the map
           is a circle and belongs to a prayer; this one is a measurement, and
           the two were being read as the same thing. Shape and colour both
           say so, so that neither has to be relied on alone.

           The colour is --milestone in the stylesheet, which .key--limit
           uses too: one source, so legend and map cannot drift apart.     */
        L.marker(at, {
          keyboard: false,
          icon: L.divIcon({
            className: "mark-limit",
            html: "<svg viewBox='0 0 18 18' width='18' height='18' aria-hidden='true'>" +
                  "<path d='M4 4 L14 14 M14 4 L4 14' stroke='" + paint("--milestone") +
                  "' stroke-width='3.2' stroke-linecap='round'/></svg>",
            iconSize: [18, 18], iconAnchor: [9, 9]
          })
        }).addTo(mapState.drawn).bindTooltip("Eight farsakh — " + fmtKm(m.limitKm) +
          (m.roundTrip ? " counted, outward and back" : "") +
          ". This is what qualifies the journey; the shortening already began at the town's edge.");
      }
    }

    /* When no border was published, the deduction the reader gave stands in. */
    var hasEdge = !drewBorder && m && m.edgeKm > 0 && line;
    if (hasEdge) {
      L.circle(line[0], {
        radius: m.edgeKm * 1000, color: paint("--ink-mute"), weight: 1,
        dashArray: "4 6", fill: false
      }).addTo(mapState.drawn).bindTooltip("Edge of town — " + fmtKm(m.edgeKm) + " out");
    }

    $("mapTitle").textContent = line ? "The route" : "The map";
    $("mapLegend").querySelector(".is-route").hidden = !(line && shortensHere);
    $("mapLegend").querySelector(".is-fullroute").hidden = !(line && !shortensHere);
    $("mapLegend").querySelector(".is-begin").hidden = !(line && shortensHere && m && m.edgeKm > 0);
    $("mapLegend").querySelector(".is-head").hidden = !(line && m && m.edgeKm > 0);
    $("mapLegend").querySelector(".is-head").textContent = "";
    $("mapLegend").querySelector(".is-head").innerHTML =
      "<span class='key key--head'></span>" + prayerStates(m).head;
    $("mapLegend").querySelector(".is-route").innerHTML =
      "<span class='key key--route'></span>" +
      (m && prayerStates(m).both ? "Pray both — shortened, then full"
                                 : "Pray shortened — to the destination");
    $("mapLegend").querySelector(".is-from").hidden = !places.from;
    $("mapLegend").querySelector(".is-to").hidden = !places.to;
    $("mapLegend").querySelector(".is-border").hidden = !drewBorder;
    var homeRing = !borderUnused && cities.from && cities.from.fromRing;
    $("mapLegend").querySelector(".is-border").innerHTML =
      "<span class='key key--border" +
        (borderUnused ? " key--border-off" : homeRing ? " key--border-ring" : "") + "'></span>" +
      (borderUnused ? "City border — your start is outside it" : "City border");
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
        : "Counted from where the route leaves your city border to the destination itself.";

    /* Frame whatever is on the map, and only when that changes, so toggling a
       circumstance does not yank the view about.                             */
    /* Framed on the journey. Where there is none yet — no address entered at
       all — whatever was drawn will do.                                      */
    /* When the border must be on the screen.

       Before there is a journey there is nothing else worth framing: an
       address alone would zoom to the street it is on and leave the border
       drawn somewhere off the edge of the map, which looks exactly like not
       having drawn it. And where the road never leaves the city, the border
       is the ruling. Where the road does cross it, the crossing lies on the
       route and is in frame already, so the journey is framed on its own. */
    var enclosing = (cities.from && cities.from.shape && (!line || staysInCity))
                  ? cities.from.shape : null;
    var box = journeyBox(places.from, places.to, line, enclosing);
    var bounds;
    if (box) {
      bounds = L.latLngBounds([[box[0], box[1]], [box[2], box[3]]]);
    } else {
      if (!seen.length) return;
      bounds = seen.reduce(function (all, b) { return all.extend(b); }, L.latLngBounds(seen[0]));
    }

    /* Refitted only when the journey itself changes, so that tracing a ring
       road or picking another city does not throw away the reader's panning. */
    var key = bounds.toBBoxString();
    if (mapState.fitted !== key) {
      mapState.map.fitBounds(bounds.pad(0.15), { maxZoom: 15 });
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
    var says = SAYS[result.verdict];
    $("verdict").className = "verdict" + says.cls;
    $("verdictLabel").textContent = says.label;
    $("verdictSub").textContent = summarise(result);

    /* The parts are shown only where they disagree — see segmentsDiffer. */
    var differ = segmentsDiffer(result);
    $("segmentsCard").hidden = !differ;
    var box = $("segments");
    box.innerHTML = "";
    if (differ) {
      result.segments.forEach(function (seg) {
        box.appendChild(segmentCard(seg));
      });
    }

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

  /* Do the parts of the journey disagree with the ruling as a whole?

     Usually they do not, and three rows each repeating the headline are
     noise. But a journey does not always carry one ruling throughout: ten
     days at the destination makes you a resident there, so the stay is full
     while the legs stay shortened [1779]; and a return to your waṭan is
     shortened only until you actually enter it [1757]. Where that happens the
     difference is the ruling, and the parts are the only place it is said. */
  function segmentsDiffer(result) {
    return (result.segments || []).some(function (s) {
      return s.verdict !== result.verdict;
    });
  }

  function summarise(result) {
    if (!segmentsDiffer(result)) {
      return "The same for every part of this journey.";
    }
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
      meets: out && out.outcomes[1].verdict === "QASR",
      /* What the prayer actually is on this leg, and where it changes. The
         map draws the ruling, not the arithmetic.                            */
      verdict: result.verdict,
      legVerdict: out && out.verdict,
      qasrBegins: out && out.qasrBeginsAt
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

    var src0 = lastRoute.source;
    dl.appendChild(measureRow(
      src0 === "crow" ? "Straight line to the destination"
                      : "Road to the destination",
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

    /* The ring road is asked for here, and not only when Calculate is
       pressed: the city is named on screen the moment an address is picked,
       and naming it Watford and then quietly changing it later would be worse
       than never having said it.                                             */
    return cityWithRing(place, slot === "from").then(function (city) {
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

  /* The badge on the map that says something slow is happening, and then
     that it has finished. Tracing a motorway takes seconds on a first visit,
     and until now the only sign of it was a line of text further up the page.

     Passing done shows a tick instead of the spinner and clears itself after
     a moment: "it is finished" is as much what the reader wants as "it is
     working", and a badge that only ever disappears says the second badly. */
  var busyTimer = null;
  function busy(text, done) {
    var el = $("mapBusy");
    if (!el) return;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    if (!text) { el.hidden = true; return; }
    $("mapBusyText").textContent = text;
    el.className = "mapbusy" + (done ? " is-done" : "");
    el.hidden = false;
    if (done) busyTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  /* Take a city as the one whose border the count starts from. */
  function useCity(city, byHand) {
    cities.from = city;
    cityConfirmed = !!byHand;
    edgeTouched = false;                 /* a new border means a new measurement */
    ringSameCity = undefined;            /* and a new border, a new question */
    showCity("from", "fromHint", "Your city is");
    applyBorderDeduction();
    renderCityChoices();
    labelCityBtn();
    if (lastRoute) recalc(); else renderMap(null);
    maybeRing(city);
  }

  /* A city with a ring road named for it gets that road as its edge, without
     being asked. The swap is visible: the road is outlined on the map and
     named under it, and any other border can still be chosen by hand.        */
  function maybeRing(city) {
    if (!city || !city.name || city.fromRing || city.ringTried) return;
    var refs = RING_ROAD[city.name.toLowerCase()];
    if (!refs) return;
    city.ringTried = true;
    city.ringPending = true;
    var named = (Array.isArray(refs) ? refs : [refs]).join(" and ");
    busy("Tracing the " + named + " — a moment the first time");
    showCity("from", "fromHint", "Your city is");
    ringBoundary(refs, places.from || city).then(function (ring) {
      city.ringPending = false;
      if (cities.from !== city) { busy(null); return; }   /* the reader moved on */
      busy("Traced the " + ring.ref + " — that is your city's edge", true);
      city.shape = ring.shape;
      city.fromRing = ring.ref;
      city.ringTraced = ring.traced;
      city.ringClosedByHand = ring.closedByHand;
      city.fromAggregate = false;
      showCity("from", "fromHint", "Your city is");
      applyBorderDeduction();
      renderCityChoices();
      if (lastRoute) recalc(); else renderMap(null);
    }).catch(function () {
      /* The published boundary was there before and stays. */
      city.ringPending = false;
      city.ringFailed = named;
      busy(null);
      if (cities.from === city) showCity("from", "fromHint", "Your city is");
    });
  }

  function cityRow(city, isOn) {
    var li = document.createElement("li");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "city" + (isOn ? " is-on" : "");
    btn.setAttribute("aria-pressed", isOn ? "true" : "false");
    btn.innerHTML = "<b>" + city.name + "</b><span>" +
      (city.area && city.area !== city.name ? city.area + " · " : "") +
      (city.fromRing ? "measured from the " + city.fromRing
        : city.shape ? "border published" : "no border published — nothing to deduct") +
      (city.note ? " · " + city.note : "") +
      "</span>";
    btn.addEventListener("click", function () { useCity(city, true); });
    li.appendChild(btn);
    return li;
  }

  /* Where the line drawn is not the town's own published boundary, say which
     line it is instead. A reader can only judge the choice if they know it
     was made.                                                                */
  function borderNote() {
    var city = cities.from;
    if (!city || !city.name) return "";
    if (city.fromRing) {
      /* Which road it is, is said under the address and in the tooltip. Said
         a third time here it was just length. */
      return city.ringTraced === false
        ? " The " + city.fromRing + " could not be traced into a loop, so the outline runs wide."
        : "";
    }
    if (city.fromAggregate) {
      return " No town-level boundary is published for " + city.name +
             ", so this is the edge of the whole built-up area — which is what the text measures from.";
    }
    return "";
  }

  /* The check, said plainly under the map. [1704] */
  function renderBorderCheck() {
    var el = $("borderCheck");
    if (!lastRoute) { el.hidden = true; return; }
    el.hidden = false;

    if (borderCheck.ok && borderCheck.ask) {
      el.className = "bordercheck is-ask";
      el.innerHTML =
        "<b>One city, or two?</b> Both ends lie inside the " + borderCheck.ring +
        ", but they are in " + borderCheck.city + " and " + borderCheck.other +
        ". Within one city nothing is counted, however far across it you go; " +
        "between two towns the distance counts as usual. Only you can say which " +
        "this is. <span class='cite'>1704</span> <span class='cite'>1790</span>" +
        "<span class='bordercheck__ask'>" +
        "<button type='button' class='btn btn--small' id='oneCityYes'>One city</button>" +
        "<button type='button' class='btn btn--small' id='oneCityNo'>Two towns</button>" +
        "</span>";
      el.querySelector("#oneCityYes").addEventListener("click", function () {
        ringSameCity = true; applyBorderDeduction(); recalc();
      });
      el.querySelector("#oneCityNo").addEventListener("click", function () {
        ringSameCity = false; applyBorderDeduction(); recalc();
      });
      return;
    }
    if (borderCheck.ok && borderCheck.within) {
      el.className = "bordercheck is-within";
      el.innerHTML = "<b>Inside one city.</b> " + borderCheck.reason;
      return;
    }
    if (borderCheck.ok) {
      el.className = "bordercheck is-ok";
      el.innerHTML = "<b>Counting from the " + borderCheck.city + " border.</b> " +
        "The " + fmtKm(borderCheck.km) + " from your door to it is not counted." +
        borderNote() +
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
    /* Drawn again on every arrival, so the first city is on screen in about a
       second rather than after the last one has landed.                      */
    cityChoices(places.from, function (sofar) {
      cityOptions = sofar;
      $("cityMsg").textContent = "";
      renderCityChoices();
      labelCityBtn();
    }).then(function (found) {
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
    if (city && city.ringPending) {
      hint.innerHTML = lead + " <b>" + city.name + "</b> — tracing the " +
        (RING_ROAD[city.name.toLowerCase()] || []).join(" and ") + " now…";
      hint.className = "hint";
      return;
    }
    if (city && city.name) {
      hint.innerHTML = lead + " <b>" + city.name + "</b>" +
        (city.area && city.area !== city.name ? ", " + city.area : "") +
        /* Only the starting city's border is drawn, so only it may be said to
           be on the map. */
        (slot !== "from" ? ""
          : city.ringUnsound ? " — the " + city.ringUnsound + " did not come back as a closed ring, " +
              "so its published boundary is used instead."
          : city.ringFailed ? " — the " + city.ringFailed + " could not be traced just now, " +
              "so its published boundary is outlined instead. Press Refresh to try again."
          : city.fromRing ? " — the " + city.fromRing + " is outlined on the map as its edge."
          : city.shape ? " — its border is outlined on the map."
          : " — no published border to outline.") +
        (slot === "from" && !cityConfirmed ? " <em>Suggested — change it if another city's edge is the one you would call leaving town.</em>" : "");
      hint.className = "hint hint--ok";
    } else {
      hint.textContent = city && city.reason
        ? city.reason + (slot === "from" ? " No border is drawn, and the deduction stays as you left it." : "")
        : "The city here could not be identified" + (slot === "from" ? ", so no border is drawn." : ".");
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
    function fail(reason, outside) {
      borderCheck = { ok: false, reason: reason, km: 0, city: city && city.name,
                      outside: outside === true };
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

    /* A ring road is a wide line to draw round a city. Both ends can sit
       inside the M25 and still be two towns: Watford and Dartford are fifty
       kilometres apart and neither is the other. So where the border is a
       ring road and the two ends answer to different settlements, whether
       they are one city is a judgement of common usage — and §15 forbids the
       software from making one. It is asked instead.                         */
    oneCityDoubt = false;
    if (staysInCity && city.fromRing && city.name && cities.to && cities.to.name &&
        cities.to.name.toLowerCase() !== city.name.toLowerCase()) {
      if (ringSameCity === false) staysInCity = false;
      else if (ringSameCity !== true) oneCityDoubt = true;
    }

    if (oneCityDoubt) {
      say("Both ends lie inside the " + city.fromRing + ", but in <b>" + city.name +
          "</b> and <b>" + cities.to.name + "</b>. Say below whether you count those as one city.", "hint--warn");
      borderCheck = { ok: true, within: true, ask: true, km: 0, city: city.name,
                      other: cities.to.name, ring: city.fromRing,
                      reason: "Both ends lie inside the " + city.fromRing + "." };
      renderBorderCheck();
      return;
    }

    if (staysInCity) {
      say("Both ends lie inside <b>" + city.name + "</b>, so nothing is counted: you never leave town.", "hint--warn");
      if (!edgeTouched) $("edgeKm").value = "";
      borderCheck = { ok: true, within: true, km: 0, city: city.name,
                      reason: "Both ends lie inside " + city.name + " — nothing is counted." };
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
      fail("The start lies outside " + city.name + " and the route never crosses its border, so nothing is deducted. Choose the city whose edge you would call leaving town.", true);
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
        /* The distance condition only, and named as such: whether the prayer
           is shortened is Fiqh.evaluate's to say, not the picker's. */
        "<em>" + (counted >= Fiqh.THRESHOLD_KM ? "reaches 8 farsakh — " : "under 8 farsakh — ") +
        fmtKm(counted) + " counted</em>";
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
                  : cityWithRing(places.from, true)
               ).then(function (home) {
          /* The far end is asked the same question. Two addresses inside the
             M25 are both in London, so the journey stays within one city and
             nothing is counted — which is the whole point of taking the
             motorway as the boundary.                                        */
          return cityWithRing(places.to, false).then(function (away) { return [home, away]; });
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
        showAnswer();
      })
      .catch(function (err) {
        /* A browser reports an unreachable service as "Failed to fetch", which
           tells nobody anything. Say what to do about it instead.            */
        var base = err.message || "Something went wrong. Check the addresses and try again.";
        var offline = /failed to fetch|networkerror|load failed|returned \d+/i.test(base);
        say(offline
          ? "Could not reach the address lookup. Try Refresh in a moment."
          : base, true);
        if (offline) reportNoMeasurement();
      })
      .then(function () { btn.disabled = false; });
  }

  /* Nothing can be ruled without a distance, and there is no longer a way to
     supply one by hand. Say what happened rather than showing a stale result. */
  function reportNoMeasurement() {
    $("undeterminedCard").hidden = true;
    $("segmentsCard").hidden = true;
    $("advisoryCard").hidden = true;
    $("verdict").className = "verdict verdict--ask";
    $("verdictLabel").textContent = "Nothing measured";
    $("verdictSub").textContent = "The addresses could not be looked up, so there is no distance to rule on. Try Refresh, or check the addresses.";
    $("measure").innerHTML = "";
    $("measureNote").textContent = "";
    $("gaugeFill").style.width = "0";
    $("result").hidden = false;
  }

  /* Where to put the page once there is an answer.

     The reader wants two things at once: the map, and the ruling under it.
     Where both fit on the screen the map's top goes to the top of it. Where
     they do not — a short window, or a long legend — the ruling takes the
     bottom of the screen and the map fills whatever is left above, because an
     answer scrolled off the bottom of the page is the one outcome to avoid.  */
  function showAnswer() {
    var card = $("mapCard"), answer = $("verdict");
    if (!card || !answer) return;
    var y = window.pageYOffset || window.scrollY || 0;
    var top = card.getBoundingClientRect().top + y;
    var foot = answer.getBoundingClientRect().bottom + y;
    var room = window.innerHeight || 0;
    var to = (foot - top) <= room ? top - 12 : foot - room + 16;
    if (window.scrollTo) window.scrollTo({ top: Math.max(0, to), behavior: "smooth" });
  }

  /* Recalculate from the numbers already held, without touching the network. */
  function recalc() {
    if (!lastRoute) return;
    rule();
    renderRoutes();
  }

  /* ---- light or dark ------------------------------------------------------
     Three states, and the reader's own choice must beat the system's in both
     directions: someone on a dark phone may still want this page on paper.
     Nothing stored means the system decides.                                 */
  function theme() {
    return document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark" : "light");
  }

  function setTheme(next) {
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("qasr.theme", next); } catch (e) {}
    labelTheme();
    /* The map is drawn rather than styled, so it has to be told. */
    if (mapState.tiles) mapState.tiles.setUrl(tileUrl());
    if (mapState.map) {
      mapState.fitted = null;
      renderMap(lastResult ? metricsFor(lastResult) : null);
    }
  }

  function labelTheme() {
    var btn = $("themeToggle");
    if (!btn) return;
    var dark = theme() === "dark";
    $("themeLabel").textContent = dark ? "Light" : "Dark";
    btn.setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
  }

  function init() {
    if (!$("qasrForm")) return;   /* nothing to wire — the engine is still exported below */

    labelTheme();
    if ($("themeToggle")) {
      $("themeToggle").addEventListener("click", function () {
        setTheme(theme() === "dark" ? "light" : "dark");
      });
    }
    /* Following the system, until the reader says otherwise. */
    if (window.matchMedia) {
      var watch = window.matchMedia("(prefers-color-scheme: dark)");
      if (watch.addEventListener) {
        watch.addEventListener("change", function () {
          if (!document.documentElement.getAttribute("data-theme")) {
            setTheme(watch.matches ? "dark" : "light");
          } else {
            labelTheme();
          }
        });
      }
    }

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
      busy("Looking for " + name + "…");
      cityByName(name).then(function (city) {
        /* Cleared before the city is taken: taking it may start a trace of
           its ring road, which puts its own badge up. */
        busy(null);
        if (!city.shape) {
          $("cityMsg").textContent = "Found " + city.name + ", but it has no published border, so nothing can be deducted from it.";
          $("cityMsg").className = "hint hint--warn";
        } else {
          $("cityMsg").textContent = "";
          $("citySearch").value = "";
        }
        useCity(city, true);
      }).catch(function (err) {
        busy(null);
        $("cityMsg").textContent = err.message;
        $("cityMsg").className = "hint hint--warn";
      });
    });

    $("ringGo").addEventListener("click", function () {
      var ref = $("ringInput").value.trim();
      if (!ref) return;
      $("ringMsg").textContent = "Tracing the " + ref.toUpperCase() + "…";
      $("ringMsg").className = "hint";
      busy("Tracing the " + ref.toUpperCase() + " — a moment the first time");
      ringBoundary(ref, places.from).then(function (ring) {
        busy("Traced the " + ring.ref + " — that is your city's edge", true);
        var was = cities.from;
        $("ringMsg").textContent = ring.traced ? "" :
          "The " + ring.ref + " could not be traced into a loop, so its outline is a rough one.";
        $("ringMsg").className = "hint" + (ring.traced ? "" : " hint--warn");
        $("ringInput").value = "";
        useCity({
          name: (was && was.name) || ring.ref,
          area: was ? was.area : null,
          shape: ring.shape,
          fromRing: ring.ref,
          ringTraced: ring.traced,
          ringClosedByHand: ring.closedByHand,
          ringTried: true
        }, true);
      }).catch(function (err) {
        busy(null);
        $("ringMsg").textContent = err.message;
        $("ringMsg").className = "hint hint--warn";
      });
    });

    $("ringInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("ringGo").click(); }
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
      $("edgeKm").value = "";
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


    /* Ten days and hesitation are contraries — one excludes the other. */

    /* Switching units converts what is already typed, then redraws. */
    $("units").addEventListener("change", function () {
      var was = unit;
      unit = this.value;
      if (was !== unit) {
        ["edgeKm"].forEach(function (id) {
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
    extentKm2: extentKm2, NEAR_CITY_KM: NEAR_CITY_KM,
    convexHull: convexHull, ringShape: ringShape, RING_ROAD: RING_ROAD,
    stitchLines: stitchLines, simplifyLine: simplifyLine, ringLines: ringLines,
    ringAreaKm2: ringAreaKm2, ringBoundary: ringBoundary, cityChoices: cityChoices,
    prayerStates: prayerStates, journeyBox: journeyBox, ringsOf: ringsOf,
    segmentsDiffer: segmentsDiffer, ringRoadNear: ringRoadNear, RING_ROADS: RING_ROADS,
    cityWithRing: cityWithRing, ringIsSound: ringIsSound
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
