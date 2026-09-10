"""=========================================================================
Measure the page's border for a city against an official one.

    python3 tools/compare-borders.py [--country "United Kingdom"]

The sweep in sweep-cities.js can say a border is a plausible size and holds
its own centre. It cannot say whether the line is where the city really ends,
because it has nothing to compare against — and "nothing obviously wrong" was
being read as "right". This compares.

For every city it can, it fetches the border the page would draw and the
official built-up area published by the country's own statistical office, and
reports how much of one is the other:

  IoU       intersection over union: 1.00 is the same shape, 0.00 is no
            overlap at all. Below about 0.8 the two are different lines.
  covered   how much of the official area falls inside the page's border.
            Near 1.00 with a low IoU is the signature fault: the page has
            drawn something that contains the whole town and a great deal
            besides — the administrative district, not the city.

What "official" means, and why it is the built-up area rather than the
council boundary: the ruling counts from the end of the city [1704], which is
where the houses stop, not where a council's writ stops. Ordnance Survey
publishes exactly that for Great Britain, from 25 m grid squares of building
density, and the ONS republishes it. Where the two definitions disagree, the
built-up area is the one this app wants.

A low score is not proof the page is wrong. It is proof the two lines differ,
and a city worth looking at on the review page. Read it as a work list.

Needs shapely and pyproj, which the page itself does not — this is a tool for
checking the data, not part of the site. It is not in npm test: it needs the
network and several minutes.
========================================================================= """

import argparse, json, os, subprocess, sys, urllib.parse

try:
    from shapely.geometry import shape
    from shapely.ops import transform
    import pyproj
except ImportError:
    sys.exit("needs shapely and pyproj:  pip install shapely pyproj")

HERE = os.path.dirname(os.path.abspath(__file__))

# Where each country publishes the edge of its towns. Only the countries that
# publish one openly can be checked; the rest print as "no reference".
#
# `field` is the name column, `url` an ArcGIS feature service that will answer
# in WGS84 GeoJSON.
REFERENCES = {
    "United Kingdom": {
        "what": "OS Open Built Up Areas 2022, via ONS Open Geography Portal (OGL v3)",
        "url": ("https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/"
                "services/BUA_2022_GB/FeatureServer/0/query"),
        "field": "BUA22NM"
    }
}


def official(country, name):
    ref = REFERENCES.get(country)
    if not ref:
        return None, None
    q = {"where": "%s='%s'" % (ref["field"], name.replace("'", "''")),
         "outFields": ref["field"], "outSR": "4326", "f": "geojson"}
    got = subprocess.run(["curl", "-s", "--max-time", "120",
                          ref["url"] + "?" + urllib.parse.urlencode(q)],
                         capture_output=True, text=True).stdout
    try:
        d = json.loads(got)
    except ValueError:
        return None, ref["what"]
    feats = d.get("features") or []
    if not feats:
        return None, ref["what"]
    return shape(feats[0]["geometry"]).buffer(0), ref["what"]


def metres(geom, lat):
    """Into an equal-area projection centred on the city, so that an area in
       Glasgow and an area in Mombasa are measured on the same terms."""
    to = pyproj.Transformer.from_crs(
        "EPSG:4326",
        "+proj=laea +lat_0=%f +lon_0=%f +units=m" % (lat, geom.centroid.x),
        always_xy=True).transform
    return transform(to, geom)


def verdict(iou, covered):
    if iou >= 0.80:
        return "the same line"
    if covered >= 0.90:
        return "TOO WIDE — holds the whole town and more besides"
    if iou >= 0.50:
        return "a different line"
    return "NOT THE SAME PLACE — look at it"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--drawn", default=os.path.join(HERE, "drawn-borders.json"),
                   help="what the page draws, from tools/dump-borders.js")
    p.add_argument("--country", default=None, help="only this country")
    args = p.parse_args()

    if not os.path.exists(args.drawn):
        sys.exit("no %s — run tools/dump-borders.js first" % args.drawn)
    drawn = json.load(open(args.drawn))
    if args.country:
        drawn = [r for r in drawn if r.get("country") == args.country]

    print("%-15s %9s %9s %6s %8s  %s" %
          ("city", "page km2", "official", "IoU", "covered", "how they compare"))
    rows, said = [], set()
    for r in drawn:
        name, lat, country = r["asked"], r["lat"], r.get("country")
        ref, what = official(country, name)
        if what and what not in said:
            said.add(what)
        if ref is None:
            print("%-15s %9s %9s %6s %8s  %s" % (name, "—", "—", "—", "—",
                  "no official built-up area published under that name"))
            continue
        R = metres(ref, lat)
        if not r.get("shape"):
            print("%-15s %9s %9.0f %6s %8s  %s" % (name, "—", R.area / 1e6, "—", "—",
                  "THE PAGE HAS NO BORDER, and an official one exists"))
            rows.append({"asked": name, "iou": None, "officialKm2": round(R.area / 1e6)})
            continue
        M = metres(shape(r["shape"]).buffer(0), lat)
        inter = M.intersection(R).area
        union = M.union(R).area
        iou = inter / union if union else 0.0
        covered = inter / R.area if R.area else 0.0
        print("%-15s %9.0f %9.0f %6.2f %8.2f  %s" %
              (name, M.area / 1e6, R.area / 1e6, iou, covered, verdict(iou, covered)))
        rows.append({"asked": name, "iou": round(iou, 3), "covered": round(covered, 3),
                     "pageKm2": round(M.area / 1e6), "officialKm2": round(R.area / 1e6)})

    scored = [x for x in rows if x.get("iou") is not None]
    close = [x for x in scored if x["iou"] >= 0.80]
    print("\n%d compared · %d the same line · %d differ · %d with no border at all" %
          (len(rows), len(close), len(scored) - len(close),
           len([x for x in rows if x.get("iou") is None])))
    for w in said:
        print("reference: " + w)
    print("\nA low score means the two lines differ, not that the page is wrong.\n"
          "It means the city is worth opening on the review page.")


if __name__ == "__main__":
    main()
