"""=========================================================================
One log: every city, every official source that has an opinion about it, and
whether what the page draws agrees.

    python3 tools/border-report.py            # writes tools/border-report.json

The comparison was only ever terminal output, so there was nowhere to look up
whether a given city had been checked or what came of it. This writes it down.

Each city is measured against every official source that publishes something
at its coordinate — the country's built-up areas, its municipal boundaries,
and the world's urban centres — and the verdict is the best agreement any of
them shows:

    correct   0.80 or better against an independent source of comparable
              scale.
    nearly    0.50 to 0.80 against such a source.
    wrong     under 0.50 against every one of them.
    adopted   taken from an official source, with nothing comparable and
              independent to check it against.
              A source bigger than a city cannot check one either, whatever
              it is filed under: some municipalities are regions.
    by hand   a border drawn deliberately for this app — the M25, the GTA —
              which is a decision rather than a reading, and not something a
              dataset can mark right or wrong.
    unchecked nothing published there, or nothing that names this place.

Two things had to be excluded before the verdict meant anything.

A source cannot check a border that was copied from it. The first draft of
this file scored fifty-seven cities "correct" on exactly that — a line
agreeing with itself.

And a source of a different scale cannot check one either. The world's urban
centres merge everything built-up and touching: measured against it, Ordnance
Survey's Leeds scores 0.31 and its Manchester 0.10, because the global layer
is drawing Leeds-with-Bradford and Manchester-with-Salford-and-Bolton. That
is the two datasets meaning different things, not a fault in the border, and
the second draft called five correct English cities wrong on it. Those
comparisons are still recorded on each row, as context; they no longer decide
anything.

"Correct" means an official source agrees, not that the border is where a
resident would draw it. Only a resident can say that, and the review page at
tools/review-borders.html is where they say it.

This is not a comparison against Google Maps. Google publishes no boundary
geometry through any API — a geocode gives a point and a bounding box, and
the boundary product styles Google's own polygons on a Google map without
ever handing over the coordinates. There is nothing there to compare against,
so the comparison is against the public bodies whose data those maps are
themselves built from.
========================================================================= """

import argparse, json, os, sys

try:
    from shapely.geometry import shape
except ImportError:
    sys.exit("needs shapely and pyproj:  pip install shapely pyproj")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from references import REFERENCES, MUNICIPAL, GLOBAL          # noqa: E402
from borders import (ask, ask_global, names_agree, overlap,    # noqa: E402
                     CITY_MAX_KM2)

ROOT = os.path.dirname(HERE)


def whose_border(fromUrban):
    """Which source a drawn border was copied from, if any — so that its
       agreement with that source can be discounted."""
    if not fromUrban:
        return None
    try:
        areas = json.load(open(os.path.join(ROOT, "urban-areas.json")))["areas"]
    except (IOError, ValueError, KeyError):
        return None
    for a in areas:
        if a.get("name") == fromUrban or a.get("official") == fromUrban:
            return a.get("source")
    return None

CORRECT, NEARLY = 0.80, 0.50


# A town and a municipality are both drawn round one city, so either can
# check the other. A cluster is drawn round as many cities as happen to touch,
# and can check neither.
CITY_SCALE = ("town", "municipality")


def sources_for(country):
    """Everything with an opinion about a city in this country, and at what
       scale each of them draws."""
    out = []
    nat = REFERENCES.get(country)
    if nat:
        out.append(("built-up", nat, nat.get("granularity")))
    mun = MUNICIPAL.get(country)
    if mun:
        out.append(("municipal", mun, "municipality"))
    out.append(("built-up", GLOBAL, "cluster"))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--drawn", default=os.path.join(HERE, "drawn-borders.json"))
    p.add_argument("--out", default=os.path.join(HERE, "border-report.json"))
    p.add_argument("--ghs", default=os.environ.get("GHS_UCDB"))
    args = p.parse_args()

    if not os.path.exists(args.drawn):
        sys.exit("no %s — run tools/dump-borders.js first" % args.drawn)
    drawn = json.load(open(args.drawn))

    rows = []
    for r in drawn:
        name, lat, lon = r["asked"], r["lat"], r["lon"]
        row = {"asked": name, "country": r.get("country"),
               "lat": lat, "lon": lon,
               "drawn": {"name": r.get("got"),
                         "from": r.get("fromRing") or r.get("fromUrban") or
                                 "OpenStreetMap",
                         "km2": None},
               "against": []}

        copied_from = whose_border(r.get("fromUrban"))
        if copied_from:
            row["drawn"]["from"] = copied_from
        mine = shape(r["shape"]).buffer(0) if r.get("shape") else None
        if mine is None:
            row["verdict"] = "no border"
            row["why"] = r.get("reason") or r.get("error")
            rows.append(row)
            print("%-15s %s" % (name, "no border drawn"))
            continue

        best = -1.0
        for kind, ref, scale in sources_for(r.get("country")):
            if ref is GLOBAL:
                got, label = ask_global(GLOBAL, args.ghs, lat, lon)
            else:
                got, label = ask(ref, lat, lon)
            if got is None:
                continue
            iou, covered, mine_km2, theirs_km2 = overlap(mine, got, lat)
            row["drawn"]["km2"] = round(mine_km2)
            agrees = names_agree(name, label)
            adopted = (copied_from is not None and ref["short"] == copied_from)
            row["against"].append({
                "source": ref["short"], "kind": kind, "calls_it": label,
                "km2": round(theirs_km2), "iou": round(iou, 3),
                "covered": round(covered, 3), "namesAgree": agrees,
                "adopted": adopted, "scale": scale,
                "checks": bool(agrees and not adopted and scale in CITY_SCALE
                               and theirs_km2 <= CITY_MAX_KM2)})
            # And a region cannot check a city whatever it is filed under.
            # Halifax's municipality is the Halifax Regional Municipality,
            # 5,929 km2 of Nova Scotia, so the town's own 97 km2 scored 0.00
            # against it and was called wrong for being right.
            if (agrees and not adopted and scale in CITY_SCALE
                    and theirs_km2 <= CITY_MAX_KM2 and iou > best):
                best = iou

        row["best"] = None if best < 0 else round(best, 3)
        row["copiedFrom"] = copied_from
        row["verdict"] = ("by hand" if r.get("fromRing") else
                          "correct" if best >= CORRECT else
                          "nearly" if best >= NEARLY else
                          "wrong" if best >= 0 else
                          "adopted" if copied_from else "unchecked")
        rows.append(row)
        print("%-15s %-9s best %s  (%s)" %
              (name, row["verdict"], "—" if best < 0 else "%.2f" % best,
               ", ".join("%s %.2f%s" % (a["source"].replace("the ", ""),
                                        a["iou"], "" if a["checks"] else "*")
                         for a in row["against"]) or "nothing published"))

    tally = {}
    for r in rows:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    out = {
        "what": "Every city, measured against every official source that "
                "publishes a boundary at its coordinate. Written by "
                "tools/border-report.py; do not edit by hand.",
        "notGoogle": "Not a comparison against Google Maps: Google publishes "
                     "no boundary geometry through any API, so there is "
                     "nothing there to measure against. These are the public "
                     "bodies whose data such maps are themselves built from.",
        "thresholds": {"correct": CORRECT, "nearly": NEARLY},
        "tally": tally,
        "cities": rows
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print("\n" + " · ".join("%d %s" % (v, k) for k, v in sorted(tally.items())))
    print("written to " + args.out)


if __name__ == "__main__":
    main()
