#!/usr/bin/env node
// UN_FeedR build script.
//
// Plain-language plan (implemented in Phase 2):
//   1. Read watchlist.json and data/state.json.
//   2. Fetch meetings from the UN transcripts API for a rolling 14-day
//      window, restricted to meetings that have a completed transcript.
//   3. Skip any meeting whose ID is already in data/state.json.processedIds.
//   4. For each new meeting's transcript, search for each watchlist term:
//      whole-word case-insensitive for keywords, variant-aware for
//      resolution numbers (e.g. "A/RES/79/325", "resolution 79/325", "79325 (2025)").
//   5. For each hit, record title, date, body, matched term, a short
//      surrounding snippet, and a link (deep-linked to the matching moment
//      where possible).
//   6. Write feeds/all.xml, feeds/<term-slug>.xml per watchlist term, and
//      data/matches.json (most recent 200 matches, for the webpage).
//   7. Give every RSS item a stable <guid isPermaLink="false"> built from
//      meeting ID + matched term.
//   8. Cap each feed at the 100 most recent items.
//   9. Update data/state.json.
//  10. Log what was found; exit without committing if nothing changed.
//
// This is a Phase 1 skeleton -- run() is not implemented yet.

async function run() {
  throw new Error("build-feeds.mjs is not implemented yet (Phase 2).");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
