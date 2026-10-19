import { useEffect, useRef, useState, useCallback } from 'react';
import { state } from './state.js';
import { fetchTrending, fetchSearch } from './api.js';
import { createAudioController } from './player.js';
import { formatTime } from './utils.js';
import { getCached, getAllCached } from './db.js';

export default function App() {
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate(n => n + 1), []);

  const [songs, setSongs] = useState([]);
  const [sectionTitle, setSectionTitle] = useState('🔥 Trending Now');
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('Loading trending music…');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [view, setView] = useState('trending');
  const [viewMode, setViewMode] = useState('grid');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState({ current: 0, total: 0, pct: 0 });
  const [volume, setVolume] = useState(80);
  const [toasts, setToasts] = useState([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [cachedIds, setCachedIds] = useState(new Set());
  const [pullState, setPullState] = useState({ dist: 0, active: false, refreshing: false });

  const audioRef = useRef(null);
  const searchInputRef = useRef(null);
  const searchTimerRef = useRef(null);
  const bottomSentinelRef = useRef(null);
  const mainScrollRef = useRef(null);
  const queryRef = useRef('');
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const pageRef = useRef(1);
  const touchStartRef = useRef(0);
  const isPullingRef = useRef(false);
  const failCountRef = useRef(0);

  const showToast = useCallback((msg, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2500);
  }, []);

  // ── Init audio ──
  useEffect(() => {
    audioRef.current = createAudioController({
      onStateChange: ({ playing }) => setPlaying(playing),
      onSongChange: () => rerender(),
      onTimeUpdate: (t) => setCurrentTime(t),
      showToast,
    });
  }, [rerender, showToast]);

  // ── Sync cached IDs ──
  const refreshCachedIds = useCallback(async () => {
    const all = await getAllCached();
    setCachedIds(new Set(all.map(x => x.id)));
  }, []);

  useEffect(() => { refreshCachedIds(); }, [refreshCachedIds]);

  // ── INITIAL LOAD (with retry for building feed) ──
  const loadInitial = useCallback(async (type, q = '') => {
    setLoading(true);
    setLoadingStatus(type === 'search' ? `Searching "${q}"…` : 'Loading trending music…');
    setSongs([]);
    state.songs = [];
    pageRef.current = 1;
    hasMoreRef.current = true;
    failCountRef.current = 0;
    setHasMore(true);
    queryRef.current = q;

    let attempts = 0;
    const maxAttempts = 12;

    while (attempts < maxAttempts) {
      try {
        const fn = type === 'search' ? () => fetchSearch(q, 1) : () => fetchTrending(1);
        const { songs: s, hasMore: hm, building } = await fn();

        // Server is building — wait & retry
        if (building && s.length === 0) {
          attempts++;
          setLoadingStatus(`Server building feed… (${attempts}/${maxAttempts})`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        setSongs(s);
        state.songs = s;
        hasMoreRef.current = hm;
        setHasMore(hm);
        break;
      } catch (e) {
        attempts++;
        console.error(`Load attempt ${attempts} failed:`, e);
        setLoadingStatus(`Retrying… (${attempts}/${maxAttempts})`);
        if (attempts >= maxAttempts) {
          showToast('Server slow — please retry', 'error');
        } else {
          await new Promise(r => setTimeout(r, 1000 * Math.min(attempts, 3)));
        }
      }
    }

    setLoading(false);
  }, [showToast]);

  const loadTrending = useCallback(() => {
    setView('trending');
    setSectionTitle('🔥 Trending Now');
    loadInitial('trending', '');
  }, [loadInitial]);

  const doSearch = useCallback((q) => {
    if (!q) return;
    setView('search');
    setSectionTitle(`🔍 "${q}"`);
    loadInitial('search', q);
  }, [loadInitial]);

  const showLiked = useCallback(() => {
    setView('liked');
    const likedFull = JSON.parse(localStorage.getItem('wavvy_liked_full') || '{}');
    const arr = Object.values(likedFull).sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
    setSongs(arr);
    state.songs = arr;
    setSectionTitle('❤️ Liked Songs');
    hasMoreRef.current = false;
    setHasMore(false);
  }, []);

  // ── LOAD MORE ──
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (view === 'liked') return;
    if (loading) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);

    const nextPage = pageRef.current + 1;

    try {
      const fn = view === 'search'
        ? () => fetchSearch(queryRef.current, nextPage)
        : () => fetchTrending(nextPage);

      const { songs: newSongs, hasMore: hm } = await fn();

      const existingIds = new Set(state.songs.map(s => s.id));
      const filtered = newSongs.filter(s => !existingIds.has(s.id));

      if (filtered.length > 0) {
        const merged = [...state.songs, ...filtered];
        state.songs = merged;
        setSongs(merged);
        pageRef.current = nextPage;
        failCountRef.current = 0;
      } else {
        pageRef.current = nextPage;
        failCountRef.current += 1;
      }

      if (failCountRef.current >= 5) {
        hasMoreRef.current = false;
        setHasMore(false);
      } else {
        hasMoreRef.current = true;
        setHasMore(true);
      }
    } catch (e) {
      console.error('Load more failed:', e);
      failCountRef.current += 1;
      if (failCountRef.current >= 5) {
        hasMoreRef.current = false;
        setHasMore(false);
      }
    }

    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [view, loading]);

  // ── BOTTOM OBSERVER ──
  useEffect(() => {
    const el = bottomSentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && !loadingMore) {
        loadMore();
      }
    }, { rootMargin: '600px', threshold: 0.01 });

    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, loading, loadingMore]);

  // ── AUTO-RETRY ──
  useEffect(() => {
    if (loading || loadingMore || !hasMore) return;
    if (view === 'liked') return;

    const lastCount = songs.length;
    const timer = setTimeout(() => {
      if (state.songs.length === lastCount && !loadingMoreRef.current) {
        loadMore();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [songs.length, hasMore, loading, loadingMore, loadMore, view]);

  // ── PULL-TO-REFRESH ──
  useEffect(() => {
    const el = mainScrollRef.current;
    if (!el) return;

    const THRESHOLD = 80;

    const onTouchStart = (e) => {
      if (el.scrollTop <= 0 && !pullState.refreshing) {
        touchStartRef.current = e.touches[0].clientY;
        isPullingRef.current = false;
      }
    };

    const onTouchMove = (e) => {
      if (pullState.refreshing) return;
      if (el.scrollTop > 0) return;
      const diff = e.touches[0].clientY - touchStartRef.current;
      if (diff > 0) {
        isPullingRef.current = true;
        const dist = Math.min(diff * 0.5, THRESHOLD + 20);
        setPullState({ dist, active: true, refreshing: false });
      }
    };

    const onTouchEnd = async () => {
      if (!isPullingRef.current) {
        setPullState({ dist: 0, active: false, refreshing: false });
        return;
      }

      if (pullState.dist >= THRESHOLD) {
        setPullState({ dist: 60, active: false, refreshing: true });

        if (view === 'search' && queryRef.current) {
          await loadInitial('search', queryRef.current);
        } else if (view === 'liked') {
          showLiked();
        } else {
          await loadInitial('trending', '');
        }

        showToast('🔄 Refreshed');
        setTimeout(() => {
          setPullState({ dist: 0, active: false, refreshing: false });
        }, 300);
      } else {
        setPullState({ dist: 0, active: false, refreshing: false });
      }
      isPullingRef.current = false;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);

    const onWheel = (e) => {
      if (el.scrollTop <= 0 && e.deltaY < -50 && !pullState.refreshing) {
        setPullState(p => {
          if (p.refreshing) return p;
          const newDist = Math.min((p.dist || 0) + 10, 100);
          return { dist: newDist, active: true, refreshing: false };
        });
        clearTimeout(window.__pullWheelTimer);
        window.__pullWheelTimer = setTimeout(() => {
          setPullState(prev => {
            if (prev.dist >= 80 && !prev.refreshing) {
              setPullState({ dist: 60, active: false, refreshing: true });
              if (view === 'search' && queryRef.current) loadInitial('search', queryRef.current);
              else if (view === 'liked') showLiked();
              else loadInitial('trending', '');
              showToast('🔄 Refreshed');
              setTimeout(() => setPullState({ dist: 0, active: false, refreshing: false }), 300);
              return { dist: 60, active: false, refreshing: true };
            }
            return { dist: 0, active: false, refreshing: false };
          });
        }, 200);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [pullState, view, loadInitial, showLiked, showToast]);

  // ── Play ──
  const playFromList = useCallback((id) => {
    const song = songs.find(s => s.id === id);
    if (!song) return;
    const idx = songs.indexOf(song);
    state.queue = [...songs];
    state.queueIndex = idx;
    audioRef.current?.play(song);
    rerender();
    setTimeout(refreshCachedIds, 3000);
  }, [songs, rerender, refreshCachedIds]);

  const toggleLike = useCallback((id, title, artist, thumb, dur) => {
    if (!id) return;
    const likedFull = JSON.parse(localStorage.getItem('wavvy_liked_full') || '{}');
    if (state.liked[id]) {
      delete state.liked[id];
      delete likedFull[id];
      showToast('Removed from liked');
    } else {
      state.liked[id] = true;
      likedFull[id] = { id, title, author: artist, thumbnail: thumb, duration: dur, likedAt: Date.now() };
      showToast('❤️ Added to liked');
    }
    localStorage.setItem('wavvy_liked', JSON.stringify(state.liked));
    localStorage.setItem('wavvy_liked_full', JSON.stringify(likedFull));
    rerender();
    if (view === 'liked') showLiked();
  }, [showToast, rerender, view, showLiked]);

  const download = useCallback(async (id, title) => {
    const cached = await getCached(id);
    const a = document.createElement('a');
    if (cached?.blob) a.href = URL.createObjectURL(cached.blob);
    else a.href = `/api/audio/${id}`;
    a.download = `${(title || id).replace(/[^\w\s-]/gi, '')}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`⬇ Downloading...`, 'success');
  }, [showToast]);

  const onSearchChange = (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimerRef.current);
    if (q.length > 1) searchTimerRef.current = setTimeout(() => doSearch(q), 500);
    else if (q.length === 0) loadTrending();
  };

  useEffect(() => {
    loadTrending();
    const savedVol = localStorage.getItem('wavvy_volume');
    if (savedVol) setVolume(parseFloat(savedVol));
    // eslint-disable-next-line
  }, []);

  const shufflePlay = () => {
    if (!songs.length) return;
    state.isShuffle = true;
    state.queue = [...songs];
    state.queueIndex = Math.floor(Math.random() * songs.length);
    audioRef.current?.play(state.queue[state.queueIndex]);
    rerender();
  };

  const currentSong = state.currentSong;

  // ── SKELETON ──
  const renderSkeleton = () => {
    if (viewMode === 'list') {
      return (
        <div className="songs-list-view">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="list-item" style={{ pointerEvents: 'none' }}>
              <div className="skeleton-list-line" style={{ width: 20, height: 12 }}></div>
              <div className="skeleton-list-thumb"></div>
              <div className="skeleton-list-line"></div>
              <div className="skeleton-list-line" style={{ width: '60%' }}></div>
              <div className="skeleton-list-line" style={{ width: 40 }}></div>
              <div></div>
            </div>
          ))}
        </div>
      );
    }
    return (
      <>
        <div className="loading-status">
          <div className="spinner-ring"></div>
          <span>{loadingStatus}</span>
        </div>
        <div className="songs-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 0.04}s` }}>
              <div className="skeleton-thumb"></div>
              <div className="skeleton-line"></div>
              <div className="skeleton-line short"></div>
            </div>
          ))}
        </div>
      </>
    );
  };

  // ── SONGS ──
  const renderSongs = () => {
    if (loading) return renderSkeleton();

    if (!songs.length) {
      return (
        <div className="error-state">
          {view === 'liked' ? '❤️ No liked songs yet. Tap the heart on any song.' : '🎵 No songs found'}
        </div>
      );
    }

    return (
      <>
        {viewMode === 'grid' ? (
          <div className="songs-grid fade-in">
            {songs.map((s, i) => (
              <div
                key={s.id}
                className={`song-card ${state.currentSongId === s.id ? 'playing' : ''}`}
                style={{ animationDelay: `${Math.min(i * 0.03, 0.25)}s` }}
                onClick={() => playFromList(s.id)}
              >
                <div className="card-thumb-wrap">
                  <img
                    className="card-thumb"
                    src={s.thumbnail || '/assets/placeholder.svg'}
                    onError={e => (e.target.src = '/assets/placeholder.svg')}
                    alt={s.title}
                    loading="lazy"
                  />
                  <div className="card-overlay">
                    <button className="card-play-btn" onClick={e => { e.stopPropagation(); playFromList(s.id); }}>
                      {state.currentSongId === s.id && playing
                        ? <div className="eq-bars"><div className="eq-bar"></div><div className="eq-bar"></div><div className="eq-bar"></div><div className="eq-bar"></div></div>
                        : <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3" /></svg>}
                    </button>
                  </div>
                  {cachedIds.has(s.id) && <span className="cached-dot" title="Cached">✓</span>}
                  <button
                    className={`card-like-btn ${state.liked[s.id] ? 'liked' : ''}`}
                    onClick={e => { e.stopPropagation(); toggleLike(s.id, s.title, s.author, s.thumbnail, s.duration); }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill={state.liked[s.id] ? 'var(--pink)' : 'none'} stroke="var(--pink)" strokeWidth="2">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                  </button>
                </div>
                <div className="card-body">
                  <div className="card-title">{s.title}</div>
                  <div className="card-meta">{s.author || 'Unknown'} · {s.duration || '0:00'}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="songs-list-view fade-in">
            <div className="list-header">
              <span>#</span><span></span><span>Title</span>
              <span>Artist</span><span>Duration</span><span></span>
            </div>
            {songs.map((s, i) => (
              <div
                key={s.id}
                className={`list-item ${state.currentSongId === s.id ? 'playing' : ''}`}
                onClick={() => playFromList(s.id)}
              >
                <span className="list-num">{state.currentSongId === s.id && playing ? '♪' : i + 1}</span>
                <img className="list-thumb" src={s.thumbnail || '/assets/placeholder.svg'} onError={e => (e.target.src = '/assets/placeholder.svg')} alt="" loading="lazy" />
                <span className="list-title">{s.title}</span>
                <span className="list-cached">{cachedIds.has(s.id) ? <span className="cached-badge">✓</span> : ''}</span>
                <span className="list-artist">{s.author || 'Unknown'}</span>
                <span className="list-dur">{s.duration || '0:00'}</span>
                <div className="list-actions">
                  <button className={`card-like-btn ${state.liked[s.id] ? 'liked' : ''}`} onClick={e => { e.stopPropagation(); toggleLike(s.id, s.title, s.author, s.thumbnail, s.duration); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill={state.liked[s.id] ? 'var(--pink)' : 'none'} stroke="var(--pink)" strokeWidth="2">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                  </button>
                  <button className="card-dl-btn" onClick={e => { e.stopPropagation(); download(s.id, s.title); }} title="Download">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div ref={bottomSentinelRef} style={{ height: 1 }}></div>

        {loadingMore && (
          <div className="infinite-loader">
            <div className="infinite-dots">
              <div className="infinite-dot"></div>
              <div className="infinite-dot"></div>
              <div className="infinite-dot"></div>
            </div>
            <span>Loading more…</span>
          </div>
        )}

        {!hasMore && songs.length > 0 && view !== 'liked' && (
          <div className="infinite-loader done">
            <span>Scroll to load more…</span>
          </div>
        )}
      </>
    );
  };

  const pullProgress = Math.min(pullState.dist / 80, 1);
  const pullClass = pullState.refreshing
    ? 'refreshing'
    : pullState.dist > 0
      ? 'visible'
      : '';

  return (
    <>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-logo">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="10" fill="url(#logoGrad)" />
              <path d="M8 22 Q12 10 16 18 Q20 26 24 14" stroke="white" strokeWidth="2.5" strokeLinecap="round" fill="none" />
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="32" y2="32">
                  <stop offset="0%" stopColor="#6C63FF" />
                  <stop offset="100%" stopColor="#FF6B9D" />
                </linearGradient>
              </defs>
            </svg>
            <span className="logo-wordmark">Wavvy</span>
          </div>
          <nav className="sidebar-nav">
            <span className="nav-label">Discover</span>
            <button className={`nav-item ${view === 'trending' ? 'active' : ''}`} onClick={loadTrending}>
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
              Trending
            </button>
            <button className="nav-item" onClick={() => searchInputRef.current?.focus()}>
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              Search
            </button>
            <button className={`nav-item ${view === 'liked' ? 'active' : ''}`} onClick={showLiked}>
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
              Liked Songs
            </button>
            <span className="nav-label">Queue</span>
            <div className="sidebar-queue">
              <div className="queue-list">
                {state.queue.length === 0
                  ? <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 10 }}>Play a song to start your queue</div>
                  : state.queue.slice(0, 20).map((s, i) => (
                    <div key={s.id + i} className={`queue-item ${s.id === state.currentSongId ? 'playing' : ''}`} onClick={() => playFromList(s.id)}>
                      <img className="queue-thumb" src={s.thumbnail || '/assets/placeholder.svg'} alt="" />
                      <div className="queue-info">
                        <div className="queue-title">{s.title.substring(0, 35)}</div>
                        <div className="queue-artist">{s.author}</div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </nav>
        </aside>

        <main className="main-content" ref={mainScrollRef}>
          <div className={`pull-refresh-indicator ${pullClass}`}>
            <div className={`pull-spinner ${!pullState.refreshing ? 'idle' : ''}`} style={{ transform: pullState.refreshing ? 'none' : `rotate(${pullProgress * 270}deg)` }}></div>
            <span>
              {pullState.refreshing
                ? 'Refreshing…'
                : pullProgress >= 1
                  ? 'Release to refresh'
                  : 'Pull down to refresh'}
            </span>
          </div>

          <div className="topbar">
            <div className="search-wrap">
              <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input ref={searchInputRef} type="text" className="search-input" placeholder="Search songs, artists, albums…" onChange={onSearchChange} autoComplete="off" />
            </div>
            <div className="topbar-actions">
              <button className="btn-icon" onClick={loadTrending} title="Trending">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
              </button>
              <button className="btn-icon" onClick={shufflePlay} title="Shuffle Play">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" /><polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
              </button>
            </div>
          </div>

          {view === 'liked' && (
            <div className="liked-header">
              <div className="liked-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="white"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
              </div>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 22, fontWeight: 800 }}>Liked Songs</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{songs.length} song{songs.length === 1 ? '' : 's'}</div>
              </div>
            </div>
          )}

          <div className="view-tabs">
            <button className={`view-tab ${viewMode === 'grid' ? 'active' : ''}`} onClick={() => setViewMode('grid')}>Grid</button>
            <button className={`view-tab ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>List</button>
          </div>

          <div className="section-header">
            <h2 className="section-title">{sectionTitle}</h2>
            <span className="section-sub" onClick={loadTrending}>Refresh</span>
          </div>

          <div>{renderSongs()}</div>
        </main>
      </div>

      <div className="player">
        <div className="player-track">
          <img className="player-art" src={currentSong?.thumbnail || '/assets/placeholder.svg'} alt="" onClick={() => currentSong && setPanelOpen(o => !o)} />
          <div className="player-info">
            <div className="player-title">{currentSong?.title || '—'}</div>
            <div className="player-artist">{currentSong?.author || 'Select a song to play'}</div>
          </div>
          <button className={`player-like ${state.liked[state.currentSongId] ? 'liked' : ''}`} onClick={() => currentSong && toggleLike(currentSong.id, currentSong.title, currentSong.author, currentSong.thumbnail, currentSong.duration)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill={state.liked[state.currentSongId] ? 'var(--pink)' : 'none'} stroke="currentColor" strokeWidth="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
          </button>
        </div>

        <div className="player-controls">
          <div className="player-buttons">
            <button className={`ctrl-btn ${state.isShuffle ? 'active' : ''}`} onClick={() => { state.isShuffle = !state.isShuffle; rerender(); showToast(state.isShuffle ? 'Shuffle on' : 'Shuffle off'); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" /><polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" /></svg>
            </button>
            <button className="ctrl-btn" onClick={() => audioRef.current?.prev()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5" /></svg>
            </button>
            <button className="ctrl-btn-play" onClick={() => audioRef.current?.toggle()}>
              {playing
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3" /></svg>}
            </button>
            <button className="ctrl-btn" onClick={() => audioRef.current?.next()}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" y1="5" x2="19" y2="19" /></svg>
            </button>
            <button className={`ctrl-btn ${state.isRepeat ? 'active' : ''}`} onClick={() => { state.isRepeat = !state.isRepeat; rerender(); showToast(state.isRepeat ? 'Repeat on' : 'Repeat off'); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
            </button>
          </div>
          <div className="player-seek">
            <span className="seek-time">{formatTime(currentTime.current)}</span>
            <input type="range" className="seek-bar" min="0" max="100" step="0.1" value={currentTime.pct || 0} style={{ '--progress': `${currentTime.pct || 0}%` }} onChange={e => audioRef.current?.seek(parseFloat(e.target.value))} />
            <span className="seek-time right">{formatTime(currentTime.total)}</span>
          </div>
        </div>

        <div className="player-extra">
          <div className="volume-wrap">
            <button className="ctrl-btn" onClick={() => audioRef.current?.toggleMute()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
            </button>
            <input type="range" className="volume-bar" min="0" max="100" value={volume} onChange={e => { const v = parseFloat(e.target.value); setVolume(v); audioRef.current?.setVolume(v); }} />
          </div>
          <button className="ctrl-btn" onClick={() => currentSong && download(currentSong.id, currentSong.title)} title="Download">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          </button>
        </div>
      </div>

      {panelOpen && currentSong && (
        <div className="now-playing-panel">
          <button className="panel-close" onClick={() => setPanelOpen(false)}>✕</button>
          <img className="panel-artwork" src={currentSong.thumbnail || '/assets/placeholder.svg'} alt="" />
          <div className="panel-title">{currentSong.title}</div>
          <div className="panel-artist">{currentSong.author}</div>
          <a className="panel-download" onClick={() => download(currentSong.id, currentSong.title)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Download MP3
          </a>
        </div>
      )}

      <div id="toastContainer">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type} show`}>{t.msg}</div>
        ))}
      </div>
    </>
  );
}
