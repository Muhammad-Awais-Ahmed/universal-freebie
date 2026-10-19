/**
 * Featured games metadata enrichment.
 *
 * The curated suggestion catalog (src/data/featuredGames.json) ships original
 * fallback descriptions. This module enriches those entries with official Steam
 * metadata (short + detailed description, header artwork, store URL) fetched
 * from Steam's public store APIs, with:
 *   - title-similarity validation (Jaccard on normalized tokens) so we never
 *     attach a wrong game's data (e.g. Wolfenstein: The New Order for the 2009
 *     "Wolfenstein"),
 *   - optional release-year validation (±3 years) when the catalog pins a year,
 *   - a disk cache with a 7-day TTL so Steam is only hit when needed.
 *
 * Failures never throw: missing metadata simply falls back to the catalog
 * description in the renderer.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.55;
const YEAR_TOLERANCE = 3;
const MAX_CANDIDATES = 3;
const MAX_DETAILED_CHARS = 1400;
const FETCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 8000;

const SEARCH_URL = 'https://store.steampowered.com/api/storesearch/';
const DETAILS_URL = 'https://store.steampowered.com/api/appdetails/';

const ROMAN_TO_ARABIC = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };

/** Convert Steam store HTML fragments into plain readable text. */
function sanitizeSteamHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');

  text = text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => safeCodePoint(parseInt(num, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—');

  return text.replace(/[ \t\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch (error) {
    return '';
  }
}

/** Truncate at a sentence boundary when possible. */
function truncateAtSentence(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  const slice = text.slice(0, maxChars);
  const lastSentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastSentence > maxChars * 0.6) return `${slice.slice(0, lastSentence + 1).trim()}…`;
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 0 ? lastSpace : maxChars).trim()}…`;
}

/**
 * Normalize a title into comparable tokens:
 * lowercase, alphanumerics only, standalone roman numerals mapped to digits
 * (so "Assassin's Creed II" matches "assassins creed 2").
 */
function normalizeTokens(value) {
  if (!value) return [];
  return String(value)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (Object.prototype.hasOwnProperty.call(ROMAN_TO_ARABIC, token) ? ROMAN_TO_ARABIC[token] : token));
}

/** Jaccard similarity between two token sets. */
function jaccard(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function releaseYearOf(meta) {
  const raw = meta && meta.release_date && meta.release_date.date;
  if (!raw) return null;
  const match = String(raw).match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * Pick the best Steam search candidate for a target title.
 * Candidates below the similarity threshold are rejected outright; among the
 * survivors we try up to MAX_CANDIDATES in score order and let the caller
 * validate each against the expected release year.
 */
function pickBestCandidate(searchItems, steamQuery, steamYear) {
  if (!Array.isArray(searchItems) || searchItems.length === 0) return null;
  const targetTokens = normalizeTokens(steamQuery);
  const scored = searchItems
    .filter((item) => item && item.id != null && (item.type === 'game' || !item.type))
    .map((item) => ({ item, score: jaccard(targetTokens, normalizeTokens(item.name)) }))
    .filter((entry) => entry.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)));
  return scored.slice(0, MAX_CANDIDATES);
}

function yearMatches(meta, steamYear) {
  if (!steamYear) return true;
  const year = releaseYearOf(meta);
  if (year == null) return true; // unknown year: trust the similarity check
  return Math.abs(year - steamYear) <= YEAR_TOLERANCE;
}

async function fetchSteamMeta(steamQuery, steamYear, fetcher) {
  const searchResponse = await fetcher(SEARCH_URL, { term: steamQuery, cc: 'US', l: 'en' });
  const items = searchResponse && Array.isArray(searchResponse.data) ? searchResponse.data : [];
  const candidates = pickBestCandidate(items, steamQuery, steamYear);
  if (!candidates || candidates.length === 0) return null;

  for (const { item } of candidates) {
    const detailsResponse = await fetcher(DETAILS_URL, { appids: String(item.id), cc: 'US', l: 'en' });
    const payload = detailsResponse && detailsResponse.data ? detailsResponse.data : {};
    const appData = payload[String(item.id)];
    if (!appData || !appData.success || !appData.data) continue;
    const info = appData.data;
    if (!yearMatches(info, steamYear)) continue;

    const shortDescription = sanitizeSteamHtml(info.short_description);
    const detailedRaw = sanitizeSteamHtml(info.detailed_description);
    return {
      appId: item.id,
      name: info.name || item.name || '',
      shortDescription,
      detailedDescription: truncateAtSentence(detailedRaw, MAX_DETAILED_CHARS),
      headerImage: info.header_image || '',
      releaseDate: info.release_date && info.release_date.date ? info.release_date.date : '',
      releaseYear: releaseYearOf(info),
      storeUrl: `https://store.steampowered.com/app/${item.id}/`,
    };
  }
  return null;
}

function defaultFetcher(url, params) {
  return axios.get(url, {
    params,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': 'UniversalFreebie/1.0' },
    validateStatus: (status) => status >= 200 && status < 300,
  });
}

function readCache(cachePath) {
  try {
    if (!cachePath || !fs.existsSync(cachePath)) return { entries: {} };
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) {
      return { entries: {} };
    }
    return { entries: parsed.entries };
  } catch (error) {
    return { entries: {} };
  }
}

function writeCache(cachePath, entries) {
  try {
    if (!cachePath) return;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8');
  } catch (error) {
    // Cache write failures are non-fatal; we just refetch next time.
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolve metadata for a list of catalog entries.
 *
 * @param {Array<{id: string, title: string, steamQuery: ?string, steamYear: ?number}>} entries
 * @param {{cachePath?: string, fetcher?: Function, now?: number}} options
 * @returns {Promise<Object<string, Object>>} map of entry id -> meta (entries
 *   without resolvable metadata are simply absent).
 */
async function getFeaturedGamesMeta(entries, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && entry.id && entry.steamQuery) : [];
  if (list.length === 0) return {};

  const now = typeof options.now === 'number' ? options.now : Date.now();
  const fetcher = typeof options.fetcher === 'function' ? options.fetcher : defaultFetcher;
  const cachePath = options.cachePath || null;
  const cache = readCache(cachePath);
  let cacheDirty = false;

  const resultsById = {};
  const pending = [];

  for (const entry of list) {
    const cached = cache.entries[entry.steamQuery];
    if (cached && typeof cached.fetchedAt === 'number' && now - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.meta) resultsById[entry.id] = cached.meta;
      continue;
    }
    pending.push(entry);
  }

  if (pending.length > 0) {
    await mapWithConcurrency(pending, FETCH_CONCURRENCY, async (entry) => {
      try {
        const meta = await fetchSteamMeta(entry.steamQuery, entry.steamYear, fetcher);
        cache.entries[entry.steamQuery] = { fetchedAt: now, meta };
        cacheDirty = true;
        if (meta) resultsById[entry.id] = meta;
      } catch (error) {
        // Network/API failure: leave no cache entry (or keep a stale one) and
        // let the renderer fall back to the catalog description.
        console.warn(`Featured metadata failed for "${entry.steamQuery}":`, error.message || error);
      }
    });
  }

  if (cacheDirty) writeCache(cachePath, cache.entries);
  return resultsById;
}

module.exports = {
  getFeaturedGamesMeta,
  sanitizeSteamHtml,
  normalizeTokens,
  jaccard,
  pickBestCandidate,
  truncateAtSentence,
  CACHE_TTL_MS,
  SIMILARITY_THRESHOLD,
};
