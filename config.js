/* ============================================================================
   Settings that belong to whoever is running the page, not to the page.

   Only one so far: a Mapbox access token. Without it the map falls back to
   OpenStreetMap's own tiles, which need no key and are fine — the page is
   complete either way, and a reader who never sets this will not notice
   anything missing except a slightly plainer map and a dark theme made by
   inverting the light one rather than drawn dark.

   To use Mapbox, paste a PUBLIC token here — the one that begins "pk." on
   https://account.mapbox.com/access-tokens/ . It is meant to be visible: it
   goes to the browser and anyone reading the page can see it, which is how
   every Mapbox web map works. That is also why it should be restricted. On
   that page, set the token's URL restrictions to the domain the page is
   served from, so a token lifted from here cannot be spent somewhere else.
   A secret token — one beginning "sk." — must never go in this file.

   GitHub's push protection treats any Mapbox token as a secret and refuses a
   push containing one, whether it begins "pk." or "sk.", so the placeholder
   is what lives in the repository. Two ways to have a real one:

     - Paste it here and keep the change out of git:
           git update-index --skip-worktree config.js
       Undo with --no-skip-worktree when this file itself needs changing.

     - Or substitute it when deploying, and leave the repository alone.

   If you would rather it simply were committed — which is defensible, since
   a URL-restricted public token is not worth hiding — GitHub will let it
   through once you allow it from the link in the rejected push.
   ========================================================================== */
window.QasrConfig = {
  mapboxToken: "",

  /* Which Mapbox styles stand for the light page and the dark one. Mapbox
     draws a real dark map, so the dark theme no longer has to invert the
     light one. Any style id works — "outdoors-v12", "satellite-streets-v12"
     — but the two chosen here are the ones the legend's colours were picked
     against. */
  mapboxLight: "light-v11",
  mapboxDark: "dark-v11"
};
