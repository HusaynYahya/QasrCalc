"""Where each country publishes the edge of its towns.

   Not the council boundary. The ruling counts from the end of the city
   [1704] — where the houses stop, not where a council's writ stops — and
   those are different lines: Leeds the built-up area is 120 km2, Leeds the
   metropolitan district 552, with farmland and three market towns between
   the two. Every source here is the built-up one, published by the country's
   own statistics office, and openly licensed.

   Each is queried by coordinate rather than by name. Asking for "Perth" gets
   a choice between Scotland, Western Australia and Ontario; asking what
   contains 31.95S 115.86E gets one answer and no argument.

   A country with no entry is not guessed at. Its cities keep whatever
   OpenStreetMap publishes, and say so.

   granularity is the thing that decides whether a source can be used at all,
   and it had to be learnt from the data rather than assumed. "Official
   built-up area" is not one definition:

     town           one town, ending where its houses end. Ordnance Survey
                    gives Leeds as 120 km2 and Bradford as 64, which are the
                    two towns. The ABS gives Perth as 1,723, which is Perth.
                    These can be adopted.

     agglomeration  everything built-up and touching, merged. The US Census
                    gives New York as 8,961 km2, Atlanta as 6,709 and Detroit
                    as 3,414 — Dearborn included. Statistics Canada gives
                    Toronto as 1,845 with Mississauga inside it. These are
                    real, official and openly licensed, and adopting one as
                    somebody's home city would deduct an hour's drive of
                    other people's towns as still being at home. They are
                    fetched and reported, never adopted.

   Which of the two a country publishes is not a detail. It is the difference
   between a border that helps and one that shortens a prayer that is due in
   full, so an agglomeration source stays out until somebody has looked at it.
"""

REFERENCES = {
    "United Kingdom": {
        "url": "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
               "BUA_2022_GB/FeatureServer/0/query",
        "name_field": "BUA22NM",
        "short": "Ordnance Survey",
        "granularity": "town",
        "attribution": "OS Open Built Up Areas 2022, via the ONS Open Geography "
                       "Portal. Contains OS data (c) Crown copyright and database "
                       "right 2022, under the Open Government Licence v3.0."
    },
    "United States": {
        "url": "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
               "Urban/MapServer/0/query",
        "name_field": "NAME",
        "short": "the US Census Bureau",
        "granularity": "agglomeration",
        # The Census merges everything built-up and touching into one urban
        # area, so Dearborn falls inside Detroit's. That is the same judgment
        # the M25 already makes about Watford, and it is left to stand.
        "attribution": "2020 Census Urban Areas, US Census Bureau TIGERweb. "
                       "Public domain."
    },
    "Canada": {
        "url": "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/"
               "Cartographic_boundary_files/MapServer/7/query",
        "name_field": "PCNAME",
        "short": "Statistics Canada",
        "granularity": "agglomeration",
        "attribution": "Population Centres, 2021 Census cartographic boundary "
                       "files, Statistics Canada. Reproduced under the Statistics "
                       "Canada Open Licence."
    },
    "Australia": {
        "url": "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/UCL/"
               "MapServer/0/query",
        "name_field": "ucl_name_2021",
        "short": "the Australian Bureau of Statistics",
        "granularity": "town",
        "attribution": "ASGS 2021 Urban Centres and Localities, Australian "
                       "Bureau of Statistics. Licensed CC BY 4.0."
    }
}

# Countries in the sweep list with no open built-up-area source found yet.
# Listed so that the gap is a known one rather than a silence.
NOT_YET = ["New Zealand", "Germany", "Sweden", "Denmark", "Norway",
           "Netherlands", "Belgium", "France", "Austria", "Ireland",
           "Tanzania", "Kenya", "Uganda", "Madagascar"]
