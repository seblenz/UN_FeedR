# UN_FeedR
RSS Feed for Keyword from UN transcripts

## Database (optional)

Every meeting the script processes can also be archived to a Supabase
Postgres database, in addition to the usual RSS feeds -- this is purely
additive. If it's not configured, or if Supabase is unreachable, the script
logs a warning and the feeds still get built exactly as before.

Set two environment variables to enable it:

- `SUPABASE_URL` -- your project's URL, e.g. `https://xxxxx.supabase.co`
- `SUPABASE_SERVICE_KEY` -- a service-role key (kept as a GitHub Actions
  secret in production; never commit it)

Each processed meeting upserts one row into `transcripts` and one row per
spoken statement into `statements`, matched by a unique constraint on
`statements(transcript_id, position)` so re-running is always safe.

### Backfill mode

To populate the database with recent history without touching your RSS
feeds or `data/state.json`, set `BACKFILL=1`. This re-fetches everything in
the lookback window and writes it to Supabase only:

```sh
SUPABASE_URL="https://xxxxx.supabase.co" \
SUPABASE_SERVICE_KEY="..." \
BACKFILL=1 \
LOOKBACK_DAYS=30 \
node scripts/build-feeds.mjs
```

