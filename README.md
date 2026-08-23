# QasrCalc

A single-page calculator that takes a starting address and a destination and
says whether the traveller shortens his prayers, according to the rulings of
**Sayyid Ali al-Husayni al-Sistani**.

Open `index.html` — there is no build step, no framework and no API key.
Published with GitHub Pages from `main`; `.nojekyll` keeps the files served
verbatim, which matters because Jekyll would otherwise drop directories it
treats as its own.

The page carries four things and nothing else: the addresses, the map, the
conditions, and the ruling. The rulings themselves live on their own page,
one link away, rather than filling the page you came to use.

```
QasrCalc/
├── index.html          the addresses, the map, the conditions, the ruling
├── rules.html          the rulings in full
├── qasr.css            styles; the design tokens sit at the top
├── qasr.js             geocoding, routing, the map, the ruling engine, the interface
├── lib/leaflet/        Leaflet 1.9.4, vendored — no CDN to depend on (BSD-2-Clause)
└── test/engine.test.js tests for the ruling engine — node test/engine.test.js
```

## How the distance is measured

| Step | Source |
| --- | --- |
| Address → coordinates | [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap), debounced to stay inside its one-request-per-second policy |
| Coordinates → road distance | [OSRM](https://project-osrm.org/) driving route |
| If routing is unreachable | great-circle distance, clearly labelled as the straight line |
| If neither can be reached | the "I already know the distance" panel in the form takes a figure by hand and needs no network at all |

The law counts the path actually travelled, not the straight line on the map,
which is why the driving route is used and the straight line is only ever a
labelled fallback.

## Choices the reader makes

- **There and back / one way** — a return journey adds the legs together, so
  22 km each way reaches the limit.
- **By road / as the crow flies** — the road is the default and what the law
  counts; the straight line is offered for comparison and labelled every time
  it is used, since it is always shorter and can understate a journey.
- **Which road** — where the routing service offers alternatives, each is listed
  with its distance and the ruling it would produce.
- **A distance typed by hand**, which overrides all of the above and needs no
  network.

## Cities and borders

Which city's edge counts as leaving town is a judgment of common usage, not one
a boundary database can settle — someone in Watford may well reckon London's edge
as theirs. So the calculator **suggests and asks rather than deciding**: the city
it finds is labelled a suggestion, alternatives are offered from the town, city
and county levels around the same point, and any other city can be named outright
and its published border used instead.

The crossing is taken as the **last** moment the route is inside the chosen city,
not the first, so a road that dips out and back has not taken you out of town —
and a reader whose own town sits inside the larger city they have named still gets
a crossing where the road finally leaves it.

Each address is resolved to the city it sits in — named under the input, and
outlined on the map from the boundary Nominatim publishes for it. The route is
then walked against the home city's polygon to find where it crosses the border,
and that distance is filled into the deduction field, because the count starts at
the city border rather than the front door. Where no boundary is published the
field falls back to a figure you type yourself.

## The map

The map is on the page from the start, not only after a calculation. At rest it
invites an address; picking one drops a pin, names the city and outlines its
border; picking both frames them together; pressing Calculate draws the road.

You can also work the other way round — tap the map to set the start or the
destination (a From/To toggle says which the next tap sets, and it moves to To
once a start is placed), or press **Use my location** to take the start from the
device. Both go through the same path as a typed address, so the city, the border
and the deduction follow either way.

Once a route is drawn it shows the start, the destination, the road itself, a
dashed circle for the edge of town when a deduction is given, and a mark where
the eight *farsakh* falls along the route. That last mark shows
where the distance lands, not where shortening begins — once a journey qualifies,
the shortening runs from the town limit onwards.

Leaflet is vendored rather than pulled from a CDN, so the page has no third-party
script dependency; only the tiles come over the network. It lives in `lib/`, not
`vendor/`, because GitHub Pages runs Jekyll, and Jekyll leaves `vendor/` out of
the published site — the root `.nojekyll` file stops that processing altogether,
and the directory name is a second line of defence. If the library is missing
or the geometry is unavailable — a hand-entered distance, say — the map card stays
hidden and everything else works unchanged.

## The rules encoded

Conditions follow the Brisc 12 Ahkam Workshop, *Prayers of a Traveller*
(17 January 2025), on the rulings of Sayyid al-Sistani.

The engine lives in `decide()` in `qasr.js` — a pure function, circumstances in,
verdict out. In the order it applies them:

1. **The exemptions.** A journey for an unlawful purpose, and one whose
   occupation is travel (driver, pilot, commuter, nomad) — full prayers, whatever
   the distance.
2. **The distance.** Eight *farsakh*, taken as 5.5 km each, so **44 km**. The
   outward and return legs are added together when the traveller returns without
   staying ten days, so 22 km each way is enough. An optional deduction accounts
   for the road from the door to the edge of town, since the count begins where
   the town ends. Within 2 km of the limit the result carries a caution to pray
   both and ask a scholar.
3. **The intention.** The distance must have been intended at the outset;
   otherwise the count restarts from wherever the intention forms.
4. **The interruptions.** Stopping in a hometown en route (the verdict is then
   marked provisional and the journey must be re-measured from that town), a
   certain intention of ten continuous days, and thirty days of hesitation.
5. **The destination.** A hometown or a ten-day stay means full prayers on
   arrival while the road there is still travel; an undecided stay means
   shortening for up to thirty days; a place newly adopted for a long stay,
   not yet a hometown and with no ten-day intention, means praying **both** by
   obligatory precaution.

Two boundaries the law keeps apart, and the output keeps apart with it: the
**city border** is where the distance starts being counted and where shortening
stops on the way home; the **hadd al-tarakhkhus** is where shortening begins and
where a fast may be broken. The count ends at the destination itself, not at its
border. Which road you take decides the matter too, so every route the service
offers is listed with the ruling it would produce.

Output covers both the road and the destination: rak'ahs per prayer, the ruling
on fasting, the reasoning, and the *hadd al-tarakhkhus* and four-places-of-choice
notes.

## Tests

```sh
node test/engine.test.js
```

39 cases over the distance thresholds, the destination rules, the exemptions,
the intention, the cautions, and the geometry behind the city-border deduction
(point-in-polygon with holes, multipolygons, and the border crossing along a route). They stub the browser and never touch the
network.

## Caveat

A tool for estimating distance and applying the common cases — not a substitute
for a qualified scholar. Unusual cases belong with
[sistani.org](https://www.sistani.org/english/) or a local representative.
