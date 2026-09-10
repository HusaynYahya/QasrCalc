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
from references import REFERENCES, NOT_YET               # noqa: E402

ROOT = os.path.dirname(HERE)


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
    s = re.sub(r"\(.*?\)", " ", s)
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
    args = p.parse_args()

    cities = json.load(open(os.path.join(HERE, "sweep-cities.json")))
    if args.country:
        cities = [c for c in cities if c.get("country") == args.country]

    areas, used, missed, skipped, refused = [], {}, [], [], []
    for c in cities:
        ref = REFERENCES.get(c.get("country"))
        if not ref:
            skipped.append(c["asked"])
            continue
        if ref.get("granularity") != "town" and not args.all_granularities:
            refused.append((c["asked"], ref["short"]))
            continue
        geom, label = ask(ref, c["lat"], c["lon"])
        if geom is None:
            missed.append(c["asked"])
            print("%-15s no built-up area contains its centre" % c["asked"])
            continue
        """The official area has to be the city that was asked about.

           Great Britain's 2022 scheme has no single London: the point in
           Trafalgar Square falls inside the City of Westminster, eighteen
           square kilometres, and writing that down as London's border would
           have put most of London outside its own city. The check is on the
           name because that is where the mismatch shows; a parenthetical or a
           duplicated district — "Watford (Watford)", "Perth (WA)" — is fine."""
        if not names_agree(c["asked"], label):
            missed.append(c["asked"])
            print("%-15s the area holding it is called %r — not adopted"
                  % (c["asked"], label))
            continue
        small, was, now = thin(geom, c["lat"], c["lon"], args.thin_km)
        areas.append({
            "name": c["asked"],
            "official": label,
            "areaKm2": round(now, 1),
            "source": ref["short"],
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
        "source": "  ".join(sorted(used.values())),
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
