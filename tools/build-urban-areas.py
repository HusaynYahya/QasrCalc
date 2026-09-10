"""=========================================================================
Build urban-areas.json from the official built-up areas, without asking
anybody anything.

    python3 tools/build-urban-areas.py [--thin-km 0.15] [--country NAME]

For every city in sweep-cities.json whose country publishes one, this asks
that country's statistics office what built-up area contains the city's
coordinate, thins the answer to something a browser can carry, and writes it
into urban-areas.json, which the page loads and prefers over whatever
OpenStreetMap publishes under the name.

Why prefer it: the ruling counts from the end of the city [1704] — where the
houses stop. OpenStreetMap publishes administrative boundaries, which are a
different line drawn for a different purpose, and in Leeds the difference is
552 km2 against 120. The statistics offices publish the line the ruling
actually wants, and publish it as data, openly licensed.

Run it again whenever the sources are updated, or a country is added to
tools/references.py. The output is committed, so the page never depends on
these services being up.
========================================================================= """

import argparse, json, os, subprocess, sys, urllib.parse

try:
    from shapely.geometry import shape, mapping
    from shapely.ops import transform
    import pyproj
except ImportError:
    sys.exit("needs shapely and pyproj:  pip install shapely pyproj")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from references import REFERENCES, GLOBAL, NOT_YET       # noqa: E402

ROOT = os.path.dirname(HERE)

# The same limit the page uses to decide a border is a region and not a city
# — see CITY_MAX_KM2 in qasr.js. Kept in step by test/geo.test.js.
CITY_MAX_KM2 = 3000


def ask(ref, lat, lon):
    """What built-up area holds this point, with its geometry."""
    q = {"geometry": json.dumps({"x": lon, "y": lat,
                                 "spatialReference": {"wkid": 4326}}),
         "geometryType": "esriGeometryPoint", "inSR": "4326",
         "spatialRel": "esriSpatialRelIntersects",
         "outFields": ref["name_field"], "outSR": "4326",
         "returnGeometry": "true", "f": "geojson"}
    got = subprocess.run(
        ["curl", "-s", "--max-time", "180", ref["url"] + "?" + urllib.parse.urlencode(q)],
        capture_output=True, text=True).stdout
    try:
        d = json.loads(got)
    except ValueError:
        return None, None
    feats = [f for f in (d.get("features") or []) if f.get("geometry")]
    if not feats:
        return None, None
    f = feats[0]
    label = (f.get("properties") or {}).get(ref["name_field"])
    return shape(f["geometry"]).buffer(0), label


_GLOBAL_LAYER = [None]


def global_layer(path):
    """The world's urban centres, read once and kept.

       285 MB of geopackage, so it is not in the repository: pass --ghs with
       the file from GLOBAL["download"]. Without it the global tier is simply
       skipped and the national sources still run."""
    if _GLOBAL_LAYER[0] is None:
        if not path or not os.path.exists(path):
            _GLOBAL_LAYER[0] = False
            return None
        import geopandas as gpd
        g = gpd.read_file(path, layer=GLOBAL["layer"],
                          columns=[GLOBAL["name_field"], GLOBAL["area_field"]])
        _GLOBAL_LAYER[0] = g.to_crs(4326)
    return _GLOBAL_LAYER[0] if _GLOBAL_LAYER[0] is not False else None


def ask_global(path, lat, lon):
    g = global_layer(path)
    if g is None:
        return None, None
    from shapely.geometry import Point
    hit = g[g.contains(Point(lon, lat))]
    if not len(hit):
        return None, None
    row = hit.iloc[0]
    return row.geometry.buffer(0), row[GLOBAL["name_field"]]


def flat(lat, lon):
    """Equal-area metres, centred on the city."""
    crs = "+proj=laea +lat_0=%f +lon_0=%f +units=m" % (lat, lon)
    return (pyproj.Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform,
            pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform)


def thin(geom, lat, lon, tolerance_km):
    """Down to something a browser can carry. A border is used to find where a
       road crosses it; a hundred and fifty metres of detail is past the point
       at which that answer changes, and the full Glasgow polygon is nineteen
       thousand vertices."""
    to_m, to_deg = flat(lat, lon)
    m = transform(to_m, geom)
    # A fixed tolerance is wrong for a small town with a ragged edge. Milton
    # Keynes lost a tenth of itself at 150 m, where Glasgow lost under one
    # per cent, because the shaving is proportional to the length of the
    # border and Milton Keynes has a great deal of border for its size. So
    # the tolerance comes down until what is left is the same town.
    for t in [tolerance_km, tolerance_km / 3.0, tolerance_km / 10.0, 0.0]:
        small = (m.simplify(t * 1000, preserve_topology=True).buffer(0)
                 if t else m)
        if not m.area or abs(small.area - m.area) / m.area <= 0.03:
            break
    return transform(to_deg, small), m.area / 1e6, small.area / 1e6


def tidy(s):
    """For comparing a name to a name: accents off, case down, anything in
       brackets and any trailing label dropped."""
    import re, unicodedata
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    # Both kinds of bracket. The global layer marks a merged cluster by
    # listing what it swallowed — "Rotterdam [The Hague]", "Birmingham
    # [Wolverhampton]" — so comparing against the whole string let a city
    # match the cluster that had eaten it, and The Hague was written down as
    # 678 km2 of Randstad. Only the main name counts.
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"\b(urban area|urban centre|city|town|built[- ]up area)\b", " ",
               s, flags=re.I)
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def names_agree(asked, official):
    a, o = tidy(asked), tidy(official)
    if not a or not o:
        return False
    return a == o or a in o.split() or o in a.split() or a in o or o in a


def bbox(geom):
    """The order urbanAreaAt reads, rounded outward.

       Rounded to nearest, Adelaide's box cut a hundredth of a degree off its
       own western edge, and the lookup — which checks the box before the shape
       and skips on a miss — would have declared a reader in Adelaide to be
       nowhere near it."""
    import math
    lo_lon, lo_lat, hi_lon, hi_lat = geom.bounds
    f = lambda v: math.floor(v * 1e4) / 1e4
    c = lambda v: math.ceil(v * 1e4) / 1e4
    return [f(lo_lat), f(lo_lon), c(hi_lat), c(hi_lon)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--thin-km", type=float, default=0.15)
    p.add_argument("--country", default=None)
    p.add_argument("--all-granularities", action="store_true",
                   help="also write agglomeration sources — see references.py "
                        "for why they are held back")
    p.add_argument("--out", default=os.path.join(ROOT, "urban-areas.json"))
    p.add_argument("--ghs", default=os.environ.get("GHS_UCDB"),
                   help="the GHS-UCDB geopackage, for the global fallback tier")
    args = p.parse_args()

    cities = json.load(open(os.path.join(HERE, "sweep-cities.json")))
    if args.country:
        cities = [c for c in cities if c.get("country") == args.country]

    areas, used, missed, skipped, refused = [], {}, [], [], []
    for c in cities:
        national = REFERENCES.get(c.get("country"))
        town_level = national and (national.get("granularity") == "town"
                                   or args.all_granularities)
        if national and not town_level:
            refused.append((c["asked"], national["short"]))

        # The country's own answer first, the world's if that has none or
        # names something else. A name that is not the city's is the sign of a
        # merge or a mis-scheme: Great Britain's 2022 layer has no single
        # London and puts Trafalgar Square inside the City of Westminster,
        # eighteen square kilometres, and the global layer merges Wolverhampton
        # into Birmingham and San Jose into San Francisco. Neither is that
        # reader's city, so neither is written down. A parenthetical or a
        # doubled district — "Watford (Watford)", "Perth (WA)" — is fine.
        ref, geom, label, why = None, None, None, []
        for candidate in ([national] if town_level else []) + [GLOBAL]:
            if candidate is GLOBAL:
                got, name = ask_global(args.ghs, c["lat"], c["lon"])
            else:
                got, name = ask(candidate, c["lat"], c["lon"])
            if got is None:
                why.append("%s has none" % candidate["short"])
                continue
            if not names_agree(c["asked"], name):
                why.append("%s calls it %r" % (candidate["short"], name))
                continue
            ref, geom, label = candidate, got, name
            break

        if geom is None:
            if not why:
                skipped.append(c["asked"])
                continue
            missed.append(c["asked"])
            print("%-15s not adopted — %s" % (c["asked"], "; ".join(why)))
            continue

        small, was, now = thin(geom, c["lat"], c["lon"], args.thin_km)

        # Anything the page would itself call a region is not written down.
        # The global layer gives Los Angeles as 4,487 km2 and New York as
        # 3,031 — the basin and the conurbation, not the city — and adopting
        # one would have put a border past the size at which the page warns
        # that a border is not a city, so the page would have been drawing a
        # line it does not itself believe.
        if now > CITY_MAX_KM2:
            missed.append(c["asked"])
            print("%-15s %s gives %.0f km2, past the size of a city — not adopted"
                  % (c["asked"], ref["short"], now))
            continue
        areas.append({
            "name": c["asked"],
            "official": label,
            "areaKm2": round(now, 1),
            "source": ref["short"],
            "tier": ref.get("granularity"),
            "country": c["country"],
            "box": bbox(small),
            "shape": mapping(small)
        })
        used[c["country"]] = ref["attribution"]
        print("%-15s %-34s %7.0f km2  (%.0f before thinning)" %
              (c["asked"], (label or "")[:34], now, was))

    out = {
        "what": "The built-up area of each city — where the houses stop — as "
                "published by the country's own statistics office. Preferred "
                "over the administrative boundary OpenStreetMap publishes, "
                "because the ruling counts from the end of the city [1704]. "
                "Built by tools/build-urban-areas.py; do not edit by hand.",
        # One line naming every source and licence, because that is what the
        # attributions require and what test/geo.test.js reads.
        "source": "  ".join(sorted(set(used.values()))),
        "sources": used,
        "thinnedToKm": args.thin_km,
        "areas": sorted(areas, key=lambda a: a["name"])
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
        fh.write("\n")

    size = os.path.getsize(args.out)
    print("\n%d areas from %d countries · %.1f MB · %s" %
          (len(areas), len(used), size / 1e6, args.out))
    if missed:
        print("nothing adopted for: " + ", ".join(missed))
    if refused:
        print("held back, agglomeration sources (%d): %s" %
              (len(refused), ", ".join(sorted(set(r[1] for r in refused)))))
    if skipped:
        print("no source for their country yet (%d): %s" %
              (len(skipped), ", ".join(sorted(set(
                  c.get("country") for c in cities
                  if c["asked"] in skipped and c.get("country"))))))
    print("countries still to find a source for: " + ", ".join(NOT_YET))


if __name__ == "__main__":
    main()
