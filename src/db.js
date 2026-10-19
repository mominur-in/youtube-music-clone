// IndexedDB wrapper for browser-side audio caching
const DB_NAME = 'wavvy_cache';
const DB_VERSION = 1;
const STORE = 'audio';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getCached(id) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveCached(id, blob, meta = {}) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put({
        id,
        blob,
        size: blob.size,
        cachedAt: Date.now(),
        ...meta,
      });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return false;
  }
}

export async function getAllCached() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function removeCached(id) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return false;
  }
}

export async function getCacheSize() {
  const all = await getAllCached();
  return all.reduce((sum, item) => sum + (item.size || 0), 0);
}

// Auto cleanup — keep under 500MB in browser
export async function autoCleanup(maxBytes = 500 * 1024 * 1024) {
  const all = await getAllCached();
  const total = all.reduce((s, x) => s + (x.size || 0), 0);
  if (total <= maxBytes) return;

  all.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
  let freed = 0;
  for (const item of all) {
    if (total - freed <= maxBytes * 0.8) break;
    await removeCached(item.id);
    freed += item.size || 0;
  }
  console.log(`🧹 Freed ${(freed / 1024 / 1024).toFixed(1)}MB from browser cache`);
}

// Check if browser supports IndexedDB
export function isSupported() {
  return typeof indexedDB !== 'undefined';
}
