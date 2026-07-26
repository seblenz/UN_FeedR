// UN_FeedR Supabase writer.
//
// Talks to Supabase's PostgREST endpoint directly via fetch -- no
// @supabase/supabase-js, no npm dependency. If SUPABASE_URL or
// SUPABASE_SERVICE_KEY isn't set, every export becomes a no-op so the
// rest of the script still runs for anyone without database credentials.
// Every function here catches its own errors and only ever warns --
// a Supabase outage must never stop the feeds from being written.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const STATEMENT_BATCH_SIZE = 200;

if (!ENABLED) {
  console.log("Supabase not configured, skipping database write");
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

async function postgrest(table, rows, { onConflict } = {}) {
  const url = new URL(`/rest/v1/${table}`, SUPABASE_URL);
  if (onConflict) url.searchParams.set("on_conflict", onConflict);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Deliberately omit headers/credentials from this message -- only the
    // server's own status/response text ever gets logged.
    throw new Error(`${res.status} ${res.statusText}${body ? ` -- ${body}` : ""}`);
  }
}

export async function upsertTranscript({ id, title, date, body, pageUrl }) {
  if (!ENABLED) return;
  try {
    await postgrest("transcripts", [
      { id, title, meeting_date: date, body, page_url: pageUrl },
    ]);
  } catch (err) {
    console.warn(`Supabase warning: could not upsert transcript ${id}: ${err.message}`);
  }
}

export async function upsertStatements(transcriptId, statements) {
  if (!ENABLED || statements.length === 0) return;
  const rows = statements.map((s) => ({
    transcript_id: transcriptId,
    position: s.position,
    speaker: s.speaker,
    text: s.text,
    page_url: s.pageUrl,
  }));
  try {
    for (const batch of chunk(rows, STATEMENT_BATCH_SIZE)) {
      await postgrest("statements", batch, { onConflict: "transcript_id,position" });
    }
  } catch (err) {
    console.warn(`Supabase warning: could not upsert statements for ${transcriptId}: ${err.message}`);
  }
}
