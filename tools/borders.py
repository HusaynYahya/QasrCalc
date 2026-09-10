"""Fetching and measuring a border, shared by the tools that do either.

   Everything here takes a coordinate rather than a name. Asking for "Perth"
   is a choice between Scotland, Western Australia and Ontario; asking what
   contains 31.95S 115.86E is not, and the namesake problem never arises.
"""

import json, os, re, subprocess, unicodedata, urllib.parse

from shapely.geometry import shape, Point
from shapely.ops import transform
import pyproj

# The same limit the page uses to decide a border is a region rather than a
# city — see CITY_MAX_KM2 in qasr.js. Kept in step by test/geo.test.js.
CITY_MAX_KM2 = 3000


def ask(ref, lat, lon):
    """What this service publishes around this point, with its geometry."""
    q = {"geometry": json.dumps({"x": lon, "y": lat,
                                 "spatialReference": {"wkid": 4326}}),
         "geometryType": "esriGeometryPoint", "inSR": "4326",
         "spatialRel": "esriSpatialRelIntersects",
         "outFields": ref["name_field"], "outSR": "4326",
         "returnGeometry": "true", "f": "geojson"}
    got = subprocess.run(
        ["curl", "-s", "--max-time", "180",
         ref["url"] + "?" + urllib.parse.urlencode(q)],
        capture_output=True, text=True).stdout
    try:
        d = json.loads(got)
    except ValueError:
        return None, None
    feats = [f for f in (d.get("features") or []) if f.get("geometry")]
    if not feats:
        return None, None
    f = feats[0]
    return (shape(f["geometry"]).buffer(0),
            (f.get("properties") or {}).get(ref["name_field"]))


_GLOBAL = [None]


def ask_global(spec, path, lat, lon):
    """The world's urban centres. 285 MB of geopackage, so it is not in the
       repository: pass the file from spec["download"]. Without it the global
       tier is skipped and everything else still runs."""
    if _GLOBAL[0] is None:
        if not path or not os.path.exists(path):
            _GLOBAL[0] = False
        else:
            import geopandas as gpd
            g = gpd.read_file(path, layer=spec["layer"],
                              columns=[spec["name_field"]])
            _GLOBAL[0] = g.to_crs(4326)
    if _GLOBAL[0] is False:
        return None, None
    hit = _GLOBAL[0][_GLOBAL[0].contains(Point(lon, lat))]
    if not len(hit):
        return None, None
    row = hit.iloc[0]
    return row.geometry.buffer(0), row[spec["name_field"]]


def tidy(s):
    """For comparing a name to a name: accents off, case down, brackets and
       generic labels dropped.

       Both kinds of bracket. The global source marks a merged cluster by
       listing what it swallowed — "Rotterdam [The Hague]" — so comparing
       against the whole string let a city match the cluster that had eaten
       it, and The Hague came out as 678 km2 of Randstad."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"\b(urban area|urban centre|city|town|village|municipality|"
               r"built[- ]up area)\b", " ", s, flags=re.I)
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def names_agree(asked, official):
    a, o = tidy(asked), tidy(official)
    if not a or not o:
        return False
    return a == o or a in o.split() or o in a.split() or a in o or o in a


def flat(lat, lon):
    """Equal-area metres centred on the city, so an area in Glasgow and an
       area in Mombasa are measured on the same terms."""
    crs = "+proj=laea +lat_0=%f +lon_0=%f +units=m" % (lat, lon)
    return (pyproj.Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform,
            pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform)


def metres(geom, lat):
    to_m, _ = flat(lat, geom.centroid.x)
    return transform(to_m, geom)


def thin(geom, lat, lon, tolerance_km):
    """Down to something a browser can carry. A border is used to find where a
       road crosses it, and a hundred and fifty metres of detail is past the
       point at which that answer changes — the full Glasgow polygon is
       nineteen thousand vertices.

       A fixed tolerance is wrong for a small town with a ragged edge: Milton
       Keynes lost a tenth of itself at 150 m where Glasgow lost under one per
       cent, because the shaving is proportional to the length of the border
       and Milton Keynes has a great deal of border for its size. So the
       tolerance comes down until what is left is the same town."""
    to_m, to_deg = flat(lat, lon)
    m = transform(to_m, geom)
    small = m
    for t in [tolerance_km, tolerance_km / 3.0, tolerance_km / 10.0, 0.0]:
        small = m.simplify(t * 1000, preserve_topology=True).buffer(0) if t else m
        if not m.area or abs(small.area - m.area) / m.area <= 0.03:
            break
    return transform(to_deg, small), m.area / 1e6, small.area / 1e6


def bbox(geom):
    """The order urbanAreaAt reads, rounded outward.

       Rounded to nearest, Adelaide's box cut a hundredth of a degree off its
       own western edge, and the lookup — which checks the box before the
       shape and skips on a miss — would have declared a reader in Adelaide to
       be nowhere near it."""
    import math
    lo_lon, lo_lat, hi_lon, hi_lat = geom.bounds
    f = lambda v: math.floor(v * 1e4) / 1e4
    c = lambda v: math.ceil(v * 1e4) / 1e4
    return [f(lo_lat), f(lo_lon), c(hi_lat), c(hi_lon)]


def overlap(mine, theirs, lat):
    """How much of one is the other. IoU is 1.00 for the same shape and 0.00
       for no overlap; covered is how much of theirs falls inside mine, and
       covered near 1.00 with a low IoU is the signature of a border that
       holds the whole town and a great deal besides."""
    M, T = metres(mine, lat), metres(theirs, lat)
    inter = M.intersection(T).area
    union = M.union(T).area
    return (inter / union if union else 0.0,
            inter / T.area if T.area else 0.0,
            M.area / 1e6, T.area / 1e6)
