import express from 'express';
import cors from 'cors';
import axios from 'axios';
import yts from 'yt-search';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3002;
const HOST = '127.0.0.1';

app.use(cors({ origin: true }));
app.use(express.json());

const isValidDuration = d => d && d <= 600;
const mapVideo = v => ({
  id: v.videoId,
  title: v.title,
  duration: v.timestamp,
  thumbnail: v.thumbnail,
  author: v.author.name,
});

// ── Disk cache paths ──
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const FEED_FILE = path.join(CACHE_DIR, 'feed.json');
const SEARCH_CACHE_FILE = path.join(CACHE_DIR, 'search_cache.json');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ── In-memory feed cache ──
let feedCache = [];
let feedCacheTime = 0;
let feedBuilding = false;
const FEED_CACHE_TTL = 10 * 60 * 1000; // 10 min

// ── Search cache (last 50 queries) ──
let searchCache = {};
try {
  if (fs.existsSync(SEARCH_CACHE_FILE)) {
    searchCache = JSON.parse(fs.readFileSync(SEARCH_CACHE_FILE, 'utf8'));
  }
} catch {}

function saveSearchCache() {
  try {
    // Keep only 50 most recent
    const entries = Object.entries(searchCache)
      .sort((a, b) => (b[1].time || 0) - (a[1].time || 0))
      .slice(0, 50);
    searchCache = Object.fromEntries(entries);
    fs.writeFileSync(SEARCH_CACHE_FILE, JSON.stringify(searchCache));
  } catch {}
}

const CHART_QUERIES = [
  'top 100 songs',
  'billboard hot 100',
  'top music videos',
  'most viewed songs',
  'popular music 2025',
  'trending music videos',
  'top hits playlist',
  'youtube music trending',
  'viral music videos',
  'top songs this week',
  'music charts 2025',
  'global top 50',
  'top hindi songs 2025',
  'bollywood latest songs',
  'punjabi top hits',
  'top pop songs 2025',
  'top hip hop songs',
  'top edm songs',
  'top r&b songs 2025',
  'top rock songs 2025',
];

// ── Load feed from disk on startup ──
function loadFeedFromDisk() {
  try {
    if (fs.existsSync(FEED_FILE)) {
      const saved = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8'));
      if (saved.songs && saved.songs.length > 0) {
        feedCache = saved.songs;
        feedCacheTime = saved.time || Date.now();
        console.log(`📦 Loaded ${feedCache.length} songs from disk (age: ${Math.round((Date.now() - feedCacheTime) / 1000)}s)`);
        return true;
      }
    }
  } catch (e) {
    console.error('Disk cache load failed:', e.message);
  }
  return false;
}

// ── Save feed to disk ──
function saveFeedToDisk() {
  try {
    fs.writeFileSync(FEED_FILE, JSON.stringify({
      songs: feedCache,
      time: feedCacheTime,
    }));
    console.log(`💾 Feed saved to disk (${feedCache.length} songs)`);
  } catch (e) {
    console.error('Disk save failed:', e.message);
  }
}

// ── Build feed (chunked to avoid rate limits) ──
async function buildFeed() {
  if (feedBuilding) return;
  feedBuilding = true;
  console.log('🔄 Building trending feed...');
  const startTime = Date.now();

  try {
    const seen = new Set();
    const results = [];

    // Process in chunks of 5
    for (let i = 0; i < CHART_QUERIES.length; i += 5) {
      const chunk = CHART_QUERIES.slice(i, i + 5);
      const promises = chunk.map(q => yts(q).catch(() => ({ videos: [] })));
      const chunkResults = await Promise.all(promises);

      for (const r of chunkResults) {
        for (const v of (r.videos || [])) {
          if (!isValidDuration(v.duration.seconds)) continue;
          if (seen.has(v.videoId)) continue;
          seen.add(v.videoId);
          results.push(mapVideo(v));
        }
      }
    }

    // Shuffle
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [results[i], results[j]] = [results[j], results[i]];
    }

    if (results.length > 0) {
      feedCache = results;
      feedCacheTime = Date.now();
      saveFeedToDisk();
      console.log(`✅ Feed built: ${results.length} songs in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    } else {
      console.warn('⚠️ Build returned 0 songs — keeping old cache');
    }
  } catch (e) {
    console.error('Feed build error:', e.message);
  } finally {
    feedBuilding = false;
  }
}

// ── Startup: load from disk first, then build fresh ──
const loaded = loadFeedFromDisk();
if (!loaded || Date.now() - feedCacheTime > FEED_CACHE_TTL) {
  buildFeed();
}

// ── Background refresh every minute ──
setInterval(() => {
  if (!feedBuilding && Date.now() - feedCacheTime > FEED_CACHE_TTL) {
    buildFeed();
  }
}, 60 * 1000);

// ── Trending endpoint ──
app.get('/api/trending', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;

  // Cache empty → return building status
  if (feedCache.length === 0) {
    if (!feedBuilding) buildFeed();
    return res.json({
      songs: [],
      page,
      hasMore: true,
      building: true,
      total: 0,
    });
  }

  // Cache old → trigger background refresh
  if (Date.now() - feedCacheTime > FEED_CACHE_TTL && !feedBuilding) {
    buildFeed();
  }

  const start = (page - 1) * limit;
  let songs = feedCache.slice(start, start + limit);

  // If empty slice but cache exists, trigger rebuild
  if (songs.length === 0) {
    if (!feedBuilding) buildFeed();
  }

  res.json({
    songs,
    page,
    hasMore: songs.length > 0 || feedBuilding,
    total: feedCache.length,
    building: feedBuilding,
  });
});

// ── Search endpoint with disk cache ──
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  if (!q) return res.status(400).json({ error: 'Query required', songs: [] });

  const cacheKey = `${q.toLowerCase()}_${page}`;

  // Serve from cache if fresh (< 30 min)
  if (searchCache[cacheKey] && Date.now() - searchCache[cacheKey].time < 30 * 60 * 1000) {
    return res.json({
      songs: searchCache[cacheKey].songs,
      page,
      hasMore: searchCache[cacheKey].hasMore,
      cached: true,
    });
  }

  try {
    const s = await yts(q);
    const all = (s.videos || []).filter(v => isValidDuration(v.duration.seconds));

    const start = (page - 1) * 20;
    const songs = all.slice(start, start + 20).map(mapVideo);
    const hasMore = start + 20 < all.length && songs.length > 0;

    // Save to cache
    searchCache[cacheKey] = { songs, hasMore, time: Date.now() };
    saveSearchCache();

    res.json({ songs, page, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message, songs: [], hasMore: false });
  }
});

// ── Audio proxy ──
app.get('/api/audio/:id', async (req, res) => {
  const videoUrl = `https://youtube.com/watch?v=${req.params.id}`;

  const APIS = [
    { url: 'https://eliteprotech-apis.zone.id/ytdown', param: 'url' },
    { url: 'https://ycdn.devhubx.org/ytdown', param: 'url' },
  ];

  for (const api of APIS) {
    try {
      const r = await axios.get(api.url, {
        params: { [api.param]: videoUrl },
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const data = r.data || {};
      const downloadURL =
        data.downloadURL || data.download_url || data.url ||
        data.link || data.result?.downloadURL || data.result?.url;

      if (downloadURL && typeof downloadURL === 'string' && downloadURL.startsWith('http')) {
        const audio = await axios({
          method: 'GET',
          url: downloadURL,
          responseType: 'stream',
          timeout: 60000,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Range': req.headers.range || 'bytes=0-',
          },
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (audio.headers['content-length']) {
          res.setHeader('Content-Length', audio.headers['content-length']);
        }
        audio.data.pipe(res);
        return;
      }
    } catch (e) {
      continue;
    }
  }

  res.status(500).json({ error: 'Stream failed' });
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    feed: feedCache.length,
    building: feedBuilding,
    cacheAge: Date.now() - feedCacheTime,
    searches: Object.keys(searchCache).length,
    uptime: process.uptime(),
  });
});

app.listen(PORT, HOST, () => {
  console.log(`\n🎵 API → http://${HOST}:${PORT}`);
  console.log(`🔒 Localhost only`);
  console.log(`📦 Feed: ${feedCache.length} songs\n`);
});
