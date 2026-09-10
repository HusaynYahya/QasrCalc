"""=========================================================================
Choose the cities to check, from the world's urban centres.

    python3 tools/pick-cities.py --ghs GHS_UCDB_GLOBE_R2024A.gpkg

The first list was sixty-five, typed out by hand, and that is as far as
typing goes. This takes the largest urban centres in each country of the
diaspora, by population, and writes tools/sweep-cities.json.

Numbers per country are a judgment about where the diaspora is, not a
calculation, and they are in the table below where they can be argued with.
The point of doing it this way is that the list is reproducible and the
judgment is in one visible place, rather than spread through a hand-typed
list nobody can audit.

The coordinate is a point guaranteed to be inside the centre — its
representative point, not its centroid, because the centroid of a horseshoe
is outside the horseshoe.
========================================================================= """

import argparse, json, os, sys, re

HERE = os.path.dirname(os.path.abspath(__file__))

# How many cities to take from each, largest first. Roughly ordered by where
# the Shia diaspora is; adjust and re-run.
WANTED = [
    ("United Kingdom", 40), ("United States", 50), ("Canada", 30),
    ("Australia", 20),      ("Germany", 20),       ("France", 15),
    ("Netherlands", 12),    ("Sweden", 12),        ("Belgium", 10),
    ("Switzerland", 10),    ("Spain", 10),         ("Italy", 10),
    ("Norway", 8),          ("Austria", 8),        ("New Zealand", 8),
    ("Denmark", 5),         ("Ireland", 5),
    ("Tanzania", 15),       ("Kenya", 15),         ("Uganda", 10),
    ("South Africa", 12),   ("Madagascar", 8),
]


def plain(name):
    """The main name. A bracket in this source lists what a centre swallowed
       — "Rotterdam [The Hague]" — and only the first of them is its name."""
    return re.sub(r"\s*[\[(].*$", "", str(name or "")).strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ghs", default=os.environ.get("GHS_UCDB"), required=False)
    p.add_argument("--out", default=os.path.join(HERE, "sweep-cities.json"))
    args = p.parse_args()
    if not args.ghs or not os.path.exists(args.ghs):
        sys.exit("pass --ghs (or set GHS_UCDB) — see tools/references.py")

    import warnings; warnings.filterwarnings("ignore")
    import geopandas as gpd
    sys.path.insert(0, HERE)
    from references import GLOBAL

    g = gpd.read_file(args.ghs, layer=GLOBAL["layer"],
                      columns=[GLOBAL["name_field"], "GC_CNT_GAD_2025",
                               "GC_POP_TOT_2025"]).to_crs(4326)
    g = g.rename(columns={GLOBAL["name_field"]: "name",
                          "GC_CNT_GAD_2025": "country",
                          "GC_POP_TOT_2025": "pop"})

    out, seen = [], set()
    for country, want in WANTED:
        sub = g[g["country"] == country].nlargest(want, "pop")
        for _, r in sub.iterrows():
            name = plain(r["name"])
            key = (name.lower(), country)
            if not name or key in seen:
                continue
            seen.add(key)
            here = r.geometry.representative_point()
            out.append({"asked": name, "country": country,
                        "lat": round(here.y, 4), "lon": round(here.x, 4),
                        "verdict": "not swept yet"})
        print("%-16s %d" % (country, len(sub)))

    out.sort(key=lambda c: (c["country"], c["asked"]))
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print("\n%d cities from %d countries -> %s" %
          (len(out), len(WANTED), args.out))


if __name__ == "__main__":
    main()
