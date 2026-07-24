#!/usr/bin/env node
// UN_FeedR build script.
//
// Reads watchlist.json, fetches recently-transcribed UN meetings from the
// UN transcripts API, searches them for watchlist terms, and writes RSS
// feeds plus data/matches.json for the landing page.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_BASE = "https://transcripts.un.org";
const SITE_URL = "https://seblenz.github.io/UN_FeedR/";
const USER_AGENT =
  "UN_FeedR/1.0 (+https://github.com/seblenz/UN_FeedR; personal RSS watchlist bot)";

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 14);
const REQUEST_DELAY_MS = 400;
const MAX_RETRIES = 3;
const FEED_ITEM_CAP = 100;
const MATCHES_STORE_CAP = 200;
const SNIPPET_TARGET_WORDS = 40;

// ---------- small helpers ----------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function slugify(term) {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function readJson(relPath, fallback) {
  try {
    const text = await readFile(path.join(ROOT, relPath), "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT" && fallback !== undefined) return fallback;
    throw err;
  }
}

async function writeJson(relPath, data) {
  const full = path.join(ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function writeText(relPath, text) {
  const full = path.join(ROOT, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, text, "utf8");
}

// ---------- polite HTTP ----------

async function politeFetch(url) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await delay(REQUEST_DELAY_MS);
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
    } catch (err) {
      if (attempt > MAX_RETRIES) {
        throw new Error(`Network error fetching ${url}: ${err.message}`);
      }
      console.warn(`Network error (attempt ${attempt}) for ${url}: ${err.message}. Retrying...`);
      await delay(REQUEST_DELAY_MS * attempt * 2);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt > MAX_RETRIES) {
        throw new Error(`API returned ${res.status} for ${url} after ${MAX_RETRIES} retries`);
      }
      const retryAfter = res.headers.get("retry-after");
      const wait = retryAfter ? Number(retryAfter) * 1000 : REQUEST_DELAY_MS * attempt * 2;
      console.warn(`Got HTTP ${res.status} for ${url} (attempt ${attempt}). Waiting ${wait}ms.`);
      await delay(wait);
      continue;
    }
    if (!res.ok) {
      throw new Error(`API returned ${res.status} ${res.statusText} for ${url}`);
    }
    return res;
  }
}

async function politeFetchJson(url) {
  const res = await politeFetch(url);
  return res.json();
}

// ---------- UN transcripts API ----------

async function fetchMeetings(fromDate, toDate) {
  const meetings = [];
  let page = 1;
  for (;;) {
    const url = new URL("/en/meetings.json", API_BASE);
    url.searchParams.set("from", fromDate);
    url.searchParams.set("to", toDate);
    url.searchParams.set("text", "transcript");
    url.searchParams.set("sort", "date_desc");
    url.searchParams.set("page", String(page));
    const data = await politeFetchJson(url);
    meetings.push(...data.meetings);
    if (!data.hasMore) break;
    page += 1;
  }
  return meetings;
}

async function fetchMeetingDetail(meeting) {
  const url = new URL(meeting.jsonUrl, API_BASE);
  return politeFetchJson(url); // { disclaimer, video, metadata, transcript }
}

// ---------- watchlist matchers ----------

// Builds a case-insensitive, whole-word regex for a phrase. Tolerates
// varying whitespace between words and around slashes (useful for document
// symbols like "A/RES/79/325" which ASR transcripts may space differently).
function buildPhraseRegex(phrase) {
  const words = phrase.trim().split(/\s+/).map(escapeRegExp);
  let pattern = words.join("\\s+");
  pattern = pattern.replace(/\//g, "\\s*/\\s*");
  return new RegExp(`\\b${pattern}\\b`, "gi");
}

function buildKeywordMatcher(term) {
  return {
    type: "keyword",
    term,
    slug: slugify(term),
    regexes: [buildPhraseRegex(term)],
  };
}

// Generates mechanical variants of a UN resolution symbol, e.g.
// "A/RES/79/325" -> also matches "79/325", "79325", "resolution 79/325", ...
// An optional trailing "(YYYY)" in the watchlist entry is treated as the
// adoption year and included in year-qualified variants.
function buildResolutionMatcher(term) {
  const yearMatch = term.match(/\((\d{4})\)\s*$/);
  const year = yearMatch ? yearMatch[1] : null;
  const symbol = year ? term.slice(0, yearMatch.index).trim() : term.trim();

  const variants = new Set([symbol]);

  const gaStyle = symbol.match(/^[A-Za-z]+\/RES\/(\d+)\/(\d+)$/);
  const scStyle = symbol.match(/^[A-Za-z]+\/RES\/(\d+)$/);

  if (gaStyle) {
    const [, session, number] = gaStyle;
    variants.add(`${session}/${number}`);
    variants.add(`${session}${number}`);
    variants.add(`resolution ${session}/${number}`);
    variants.add(`resolution ${session}${number}`);
    if (year) {
      variants.add(`${session}/${number} (${year})`);
      variants.add(`${session}${number} (${year})`);
      variants.add(`resolution ${session}/${number} (${year})`);
    }
  } else if (scStyle) {
    const [, number] = scStyle;
    variants.add(`resolution ${number}`);
    if (year) {
      variants.add(`${number} (${year})`);
      variants.add(`resolution ${number} (${year})`);
    }
  } else {
    const digits = symbol.match(/\d+/g);
    if (digits) variants.add(digits.join(""));
  }

  return {
    type: "resolution",
    term,
    slug: slugify(term),
    regexes: [...variants].map(buildPhraseRegex),
  };
}

function loadMatchers(watchlist) {
  const keywordMatchers = (watchlist.keywords || []).map(buildKeywordMatcher);
  const resolutionMatchers = (watchlist.resolutions || []).map(buildResolutionMatcher);
  return [...keywordMatchers, ...resolutionMatchers];
}

// ---------- transcript search ----------

function statementWords(statement) {
  const words = [];
  for (const para of statement.paragraphs || []) {
    for (const sentence of para.sentences || []) {
      for (const w of sentence.text.trim().split(/\s+/)) {
        if (w) words.push(w);
      }
    }
  }
  return words;
}

function findFirstMatch(words, matcher) {
  const text = words.join(" ");
  let earliest = null;
  for (const regex of matcher.regexes) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (match && (earliest === null || match.index < earliest.index)) {
      earliest = match;
    }
  }
  if (!earliest) return null;

  const before = text.slice(0, earliest.index);
  const wordStart = before.split(" ").filter(Boolean).length;
  const matchWordCount = earliest[0].trim().split(/\s+/).length;
  const wordEnd = wordStart + matchWordCount - 1;

  const pad = Math.max(0, Math.floor((SNIPPET_TARGET_WORDS - matchWordCount) / 2));
  const from = Math.max(0, wordStart - pad);
  const to = Math.min(words.length - 1, wordEnd + pad);

  let snippet = words.slice(from, to + 1).join(" ");
  if (from > 0) snippet = "… " + snippet;
  if (to < words.length - 1) snippet = snippet + " …";

  return { snippet };
}

function searchTranscript(transcript, matchers) {
  const hits = [];
  for (const matcher of matchers) {
    for (const statement of transcript.data) {
      const words = statementWords(statement);
      if (words.length === 0) continue;
      const result = findFirstMatch(words, matcher);
      if (result) {
        hits.push({
          matcher,
          snippet: result.snippet,
          link: new URL(statement.pageUrl, API_BASE).toString(),
        });
        break; // first occurrence only; one RSS item per meeting+term
      }
    }
  }
  return hits;
}

// ---------- RSS ----------

function rfc822(dateIso) {
  return new Date(dateIso).toUTCString();
}

function buildRss({ title, link, description, items }) {
  const itemsXml = items
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      <pubDate>${item.pubDate}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}

function matchToItem(match) {
  return {
    title: `${match.title} — matched "${match.term}"`,
    link: match.link,
    guid: `${match.meetingId}::${match.termSlug}`,
    pubDate: rfc822(match.date),
    description: `${match.body || "UN Web TV"} · ${match.date.slice(0, 10)} — ${match.snippet}`,
  };
}

// ---------- main ----------

async function run() {
  const watchlist = await readJson("watchlist.json");
  const state = await readJson("data/state.json", { processedIds: [], lastRun: null });
  const processedIds = new Set(state.processedIds);
  const matchers = loadMatchers(watchlist);

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fromStr = isoDate(from);
  const toStr = isoDate(to);

  console.log(`Fetching meetings with transcripts from ${fromStr} to ${toStr}...`);
  const meetings = await fetchMeetings(fromStr, toStr);
  console.log(`Found ${meetings.length} meetings with transcripts in range.`);

  const newMeetings = meetings.filter((m) => !processedIds.has(m.slug));
  console.log(`${newMeetings.length} are new (not yet processed).`);

  if (newMeetings.length === 0) {
    console.log("Nothing new to process. Exiting without writing any files.");
    return;
  }

  const existingMatches = await readJson("data/matches.json", { generatedAt: null, matches: [] });
  const newMatches = [];
  let processedCount = 0;

  for (const meeting of newMeetings) {
    let detail;
    try {
      detail = await fetchMeetingDetail(meeting);
    } catch (err) {
      throw new Error(`Failed to fetch transcript for ${meeting.slug}: ${err.message}`);
    }

    if (!detail.transcript || !Array.isArray(detail.transcript.data)) {
      console.log(`Skipping ${meeting.slug}: transcript not yet complete.`);
      continue; // don't mark as processed; retry on a future run
    }

    processedIds.add(meeting.slug);
    processedCount += 1;

    const hits = searchTranscript(detail.transcript, matchers);
    for (const hit of hits) {
      newMatches.push({
        meetingId: meeting.slug,
        term: hit.matcher.term,
        termSlug: hit.matcher.slug,
        termType: hit.matcher.type,
        title: meeting.title || "(untitled meeting)",
        date: meeting.date,
        body: meeting.body,
        snippet: hit.snippet,
        link: hit.link,
      });
    }
    if (hits.length > 0) {
      console.log(`  ${meeting.slug}: ${hits.length} watchlist term(s) matched.`);
    }
  }

  console.log(`Processed ${processedCount} new transcripts. Found ${newMatches.length} new matches.`);

  state.processedIds = [...processedIds];
  state.lastRun = new Date().toISOString();
  await writeJson("data/state.json", state);

  if (newMatches.length === 0) {
    console.log("No watchlist matches in this run. state.json updated; feeds unchanged.");
    return;
  }

  const allMatches = [...newMatches, ...existingMatches.matches]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MATCHES_STORE_CAP);

  await writeJson("data/matches.json", {
    generatedAt: new Date().toISOString(),
    matches: allMatches,
  });

  const allFeedItems = allMatches.slice(0, FEED_ITEM_CAP).map(matchToItem);
  await writeText(
    "feeds/all.xml",
    buildRss({
      title: "UN_FeedR — All matches",
      link: SITE_URL,
      description: "All UN transcript matches across your watchlist.",
      items: allFeedItems,
    })
  );

  for (const matcher of matchers) {
    const termMatches = allMatches.filter((m) => m.termSlug === matcher.slug).slice(0, FEED_ITEM_CAP);
    await writeText(
      `feeds/${matcher.slug}.xml`,
      buildRss({
        title: `UN_FeedR — "${matcher.term}"`,
        link: SITE_URL,
        description: `UN transcript matches for "${matcher.term}".`,
        items: termMatches.map(matchToItem),
      })
    );
  }

  console.log(`Wrote feeds/all.xml and ${matchers.length} term feed(s). data/matches.json updated.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
