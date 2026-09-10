/* ============================================================================
   Collect border reviews into a Google Sheet.

   The review page is served from a static host and has nowhere of its own to
   put anything, so this is the somewhere else. It is a Google Apps Script
   bound to a spreadsheet: it takes one answer per request and appends it as a
   row. Setting it up, once:

     1. Make a Google Sheet. Name the first tab "Reviews" (or don't — this
        makes it if it is missing).
     2. Extensions > Apps Script. Delete what is there, paste this in, save.
     3. Deploy > New deployment > type "Web app".
          Execute as:      Me
          Who has access:  Anyone
        Deploy, allow the permissions it asks for, and copy the web app URL.
        It looks like https://script.google.com/macros/s/AKfy…/exec
     4. Put that URL in config.js as review.url, and leave review.headers
        null. Commit and push.

   "Anyone" is doing real work in step 3 and is not an oversight: the people
   reviewing are not signed in to anything, so the endpoint has to accept a
   request from a stranger. What that costs is that anyone who reads the page
   can post to this sheet, because the URL is in the page. It holds review
   answers and nothing else, and nothing here reads or returns what is
   already in it, so the worst a stranger can do is add a row worth ignoring.
   Do not point it at a sheet with anything else in it.

   If the review page later reports that the shared list refused the request,
   the usual cause is a deployment made "Only myself" rather than "Anyone",
   or a new version deployed at a new URL while config.js still names the old.
   ========================================================================== */

var TAB = "Reviews";

var COLUMNS = ["received", "reviewer", "city", "country", "verdict", "note",
               "border named", "km2", "span km", "lat", "lon", "answered at"];

function sheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var tab = book.getSheetByName(TAB) || book.insertSheet(TAB);
  if (tab.getLastRow() === 0) {
    tab.appendRow(COLUMNS);
    tab.setFrozenRows(1);
  }
  return tab;
}

function doPost(e) {
  try {
    /* The page sends plain text on purpose — a JSON content type makes the
       browser ask permission first, and Apps Script does not answer that
       question — so the body is parsed here rather than by the runtime. */
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var a = body.answer || {};

    /* One at a time is what the page sends, but a whole set posted at once
       should not be refused: a reviewer catching up after being offline is
       the obvious case. */
    var answers = body.answers || (a.asked ? [a] : []);
    if (!answers.length) return reply_({ ok: false, why: "no answer in the request" });

    var tab = sheet_();
    var now = new Date();
    answers.forEach(function (one) {
      tab.appendRow([
        now,
        String(body.reviewer || "").slice(0, 60),
        String(one.asked || ""),
        String(one.country || ""),
        String(one.verdict || ""),
        String(one.note || ""),
        String(one.got || ""),
        one.km2 == null ? "" : one.km2,
        one.spanKm == null ? "" : one.spanKm,
        one.lat == null ? "" : one.lat,
        one.lon == null ? "" : one.lon,
        String(one.at || "")
      ]);
    });
    return reply_({ ok: true, added: answers.length });
  } catch (err) {
    /* Answered rather than thrown: the page reads the status, and a thrown
       error gives it a 500 with nothing to say about why. */
    return reply_({ ok: false, why: String(err) });
  }
}

/* A GET says whether the thing is alive, which is the first question when it
   is not working. It deliberately does not hand back what has been collected:
   the URL is public, and the answers are not. */
function doGet() {
  return reply_({ ok: true, what: "border review collector", rows: sheet_().getLastRow() - 1 });
}

function reply_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
                       .setMimeType(ContentService.MimeType.JSON);
}
