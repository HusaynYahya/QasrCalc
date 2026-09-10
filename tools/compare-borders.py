"""=========================================================================
Measure the border the page draws against an official one, city by city.

    python3 tools/compare-borders.py [--country NAME] [--against built-up|municipal]

The sweep can say a border is a plausible size and holds its own centre. It
cannot say the line is where the city really ends, because it has nothing to
compare against — and "nothing obviously wrong" was being read as "right".
This compares.

Two things to compare against, and which one is right depends on the country:

  built-up   where the houses stop, from building density. What the ruling
             counts from [1704], and what the page prefers wherever a country
             publishes it town by town.

  municipal  where the council's writ ends. This is what OpenStreetMap
             publishes for North America, and for the United States and
             Canada there is no third option — both countries publish
             built-up geography only at agglomeration scale, because their
             cities run into one another with no gap to draw a line in. So
             the page keeps the municipality there, and this checks that what
             it is drawing really is the municipality and not some other
             object that happened to sit at the address.

  IoU        1.00 is the same shape, 0.00 no overlap at all.
  covered    how much of the official area falls inside the page's border.
             Near 1.00 with a low IoU is the signature fault: the page has
             drawn something holding the whole town and a great deal besides.

A low score is not proof the page is wrong. It is proof the two lines differ,
and a city worth opening on the review page. Read it as a work list.

Needs shapely and pyproj, which the page itself does not. Not part of npm
test: it needs the network and several minutes.
========================================================================= """

import argparse, json, os, sys

try:
    from shapely.geometry import shape
except ImportError:
    sys.exit("needs shapely and pyproj:  pip install shapely pyproj")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from references import REFERENCES, MUNICIPAL, GLOBAL, NOT_YET   # noqa: E402
from borders import (ask, ask_global, names_agree, overlap,     # noqa: E402
                     Refused)


def verdict(iou, covered, agrees):
    if not agrees:
        return "a DIFFERENT PLACE by name — look at it"
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
    p.add_argument("--country", default=None)
    p.add_argument("--against", choices=["built-up", "municipal"],
                   default="built-up")
    p.add_argument("--ghs", default=os.environ.get("GHS_UCDB"))
    args = p.parse_args()

    if not os.path.exists(args.drawn):
        sys.exit("no %s — run tools/dump-borders.js first" % args.drawn)
    drawn = json.load(open(args.drawn))
    if args.country:
        drawn = [r for r in drawn if r.get("country") == args.country]

    print("%-15s %9s %9s %6s %8s  %s" %
          ("city", "page km2", "official", "IoU", "covered", "how they compare"))
    rows, cited = [], set()
    for r in drawn:
        name, lat, lon = r["asked"], r["lat"], r["lon"]
        country = r.get("country")

        if args.against == "municipal":
            ref = MUNICIPAL.get(country)
            try:
                got, label = ask(ref, lat, lon) if ref else (None, None)
            except Refused as no:
                print("%-15s  %s — not a finding, ask again later" % (name, no))
                continue
        else:
            ref = REFERENCES.get(country)
            try:
                got, label = ((ask(ref, lat, lon))
                              if ref and ref.get("granularity") == "town"
                              else (None, None))
            except Refused as no:
                print("%-15s  %s — not a finding, ask again later" % (name, no))
                continue
            if got is None:
                ref = GLOBAL
                got, label = ask_global(GLOBAL, args.ghs, lat, lon)

        if got is None:
            print("%-15s %9s %9s %6s %8s  %s" % (name, "—", "—", "—", "—",
                  "nothing published there by %s" %
                  (ref["short"] if ref else "any source on file")))
            continue
        cited.add(ref["attribution"])

        if not r.get("shape"):
            print("%-15s %9s %9s %6s %8s  %s" %
                  (name, "—", "—", "—", "—",
                   "THE PAGE HAS NO BORDER, and %s publishes one" % ref["short"]))
            rows.append({"asked": name, "iou": None})
            continue

        iou, covered, mine_km2, theirs_km2 = overlap(
            shape(r["shape"]).buffer(0), got, lat)
        agrees = names_agree(name, label)
        print("%-15s %9.0f %9.0f %6.2f %8.2f  %s" %
              (name, mine_km2, theirs_km2, iou, covered,
               verdict(iou, covered, agrees) +
               ("" if agrees else " (it calls it %r)" % label)))
        rows.append({"asked": name, "iou": round(iou, 3),
                     "covered": round(covered, 3),
                     "pageKm2": round(mine_km2), "officialKm2": round(theirs_km2),
                     "namesAgree": agrees})

    scored = [x for x in rows if x.get("iou") is not None]
    close = [x for x in scored if x["iou"] >= 0.80 and x.get("namesAgree")]
    print("\n%d compared · %d the same line · %d differ · %d with no border at all"
          % (len(rows), len(close), len(scored) - len(close),
             len([x for x in rows if x.get("iou") is None])))
    for c in sorted(cited):
        print("against: " + c)
    if args.against == "built-up" and NOT_YET:
        print("\nStill on the global fallback, no town-level source found: " +
              ", ".join(NOT_YET))
    print("\nA low score means the two lines differ, not that the page is\n"
          "wrong. It means the city is worth opening on the review page.")


if __name__ == "__main__":
    main()
