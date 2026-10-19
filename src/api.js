import { API } from './state.js';

async function fetchWithRetry(url, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

export async function fetchTrending(page = 1) {
  const data = await fetchWithRetry(`${API}/api/trending?page=${page}`);
  return {
    songs: data.songs || [],
    hasMore: data.hasMore !== false,
    building: data.building || false,
  };
}

export async function fetchSearch(query, page = 1) {
  const data = await fetchWithRetry(
    `${API}/api/search?q=${encodeURIComponent(query)}&page=${page}`
  );
  return {
    songs: data.songs || [],
    hasMore: data.hasMore !== false,
  };
}
