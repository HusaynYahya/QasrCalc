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

import argparse, json, os, re, sys

try:
    from shapely.geometry import mapping
except ImportError:
    sys.exit("needs shapely and pyproj:  pip install shapely pyproj")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from references import (REFERENCES, GLOBAL, NOT_YET,     # noqa: E402
                        KEEP_MUNICIPAL)
from borders import (ask, ask_global, names_agree, thin, bbox,   # noqa: E402
                     CITY_MAX_KM2, Refused)

ROOT = os.path.dirname(HERE)


def slug(country):
    return re.sub(r"[^a-z0-9]+", "-", str(country or "world").lower()).strip("-")


def write_sharded(out, areas, index_path):
    """An index the page always loads, and the geometry split by country so
       that it never loads more than one.

       Three hundred cities of border is some megabytes, and the page fetches
       this the first time it needs a border — which is while somebody is
       waiting to be told whether to shorten their prayer. The index is names
       and bounding boxes, tens of kilobytes; the shape only arrives once a
       box has matched, and only for that country."""
    folder = os.path.splitext(index_path)[0]
    os.makedirs(folder, exist_ok=True)

    shards = {}
    index = []
    for a in areas:
        shards.setdefault(a["shard"], {})[a["name"]] = a["shape"]
        index.append({k: v for k, v in a.items() if k != "shape"})

    # A partial run keeps what it did not rebuild.
    #
    # This used to empty the folder and rewrite the index from whatever this
    # run produced — so `--country France`, which the usage line above offers,
    # deleted seventeen countries' borders and left an index naming only
    # France. The page reads a missing shard as no data and says nothing, so
    # the loss was silent at both ends.
    #
    # Now only the countries this run rebuilt are touched, and the index keeps
    # every entry whose shard is still on disk.
    keep, kept_sources = [], {}
    if os.path.exists(index_path):
        try:
            was = json.load(open(index_path))
            keep = [a for a in was.get("areas", [])
                    if a.get("shard") not in shards
                    and os.path.exists(os.path.join(folder, str(a.get("shard")) + ".json"))]
            # And their attribution with them. Keeping Ordnance Survey's
            # borders while dropping Ordnance Survey's licence off the file is
            # not a tidying-up problem, it is publishing their data uncredited
            # — which the licence is the permission for.
            countries = {a.get("country") for a in keep}
            kept_sources = {k: v for k, v in (was.get("sources") or {}).items()
                            if k in countries}
        except (IOError, ValueError):
            keep, kept_sources = [], {}
    for k, v in kept_sources.items():
        out.setdefault("sources", {}).setdefault(k, v)
    out["source"] = "  ".join(sorted(set((out.get("sources") or {}).values())))

    # Written to a temporary name and moved into place, so that a run which
    # dies partway leaves the old shard rather than half a new one.
    for name, shapes in shards.items():
        final = os.path.join(folder, name + ".json")
        with open(final + ".part", "w") as fh:
            json.dump(shapes, fh, separators=(",", ":"))
            fh.write("\n")
        os.replace(final + ".part", final)

    out["areas"] = sorted(index + keep, key=lambda a: (a.get("country", ""), a["name"]))
    out["shards"] = os.path.basename(folder) + "/"
    with open(index_path + ".part", "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
        fh.write("\n")
    os.replace(index_path + ".part", index_path)
    if keep:
        print("kept %d area(s) from countries this run did not rebuild" % len(keep))
    return folder, len(shards)


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

    areas, used, missed, skipped, refused, kept = [], {}, [], [], [], []
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
        # The global layer is not offered where the municipality is the
        # answer: it would trade a city for its conurbation.
        tiers = ([national] if town_level else [])
        if c.get("country") not in KEEP_MUNICIPAL:
            tiers = tiers + [GLOBAL]
        elif not tiers:
            kept.append(c["asked"])
        for candidate in tiers:
            if candidate is GLOBAL:
                got, name = ask_global(GLOBAL, args.ghs, c["lat"], c["lon"])
            else:
                try:
                    got, name = ask(candidate, c["lat"], c["lon"])
                except Refused as no:
                    # Never recorded as a gap. A refusal that got written down
                    # as "nothing published" would replace a good committed
                    # border with a coarser one, or with none.
                    sys.exit("\nstopped: %s\nNothing has been written. Wait and "
                             "run again." % no)
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
        areas[-1]["shard"] = slug(c["country"])
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
        "thinnedToKm": args.thin_km
    }
    folder, shard_count = write_sharded(out, sorted(areas, key=lambda a: a["name"]),
                                        args.out)

    whole = os.path.getsize(args.out) + sum(
        os.path.getsize(os.path.join(folder, f)) for f in os.listdir(folder))
    print("\n%d areas from %d countries · index %.0f kB, %d shards, %.1f MB "
          "in all · %s" %
          (len(areas), len(used), os.path.getsize(args.out) / 1e3,
           shard_count, whole / 1e6, args.out))
    if missed:
        print("nothing adopted for: " + ", ".join(missed))
    if kept:
        print("kept as published, the municipality being the answer (%d): %s"
              % (len(kept), ", ".join(sorted(set(kept)))))
    if refused:
        print("held back, agglomeration sources (%d): %s" %
              (len(refused), ", ".join(sorted(set(r[1] for r in refused)))))
    if skipped:
        print("nothing published anywhere for (%d): %s" %
              (len(skipped), ", ".join(sorted(skipped)[:12])))
    print("countries still to find a source for: " + ", ".join(NOT_YET))


if __name__ == "__main__":
    main()
