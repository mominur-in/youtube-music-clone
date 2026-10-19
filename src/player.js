import { state, API } from './state.js';
import { getCached, saveCached, autoCleanup } from './db.js';

export function createAudioController({ onStateChange, onSongChange, onTimeUpdate, showToast }) {
  const audio = new Audio();
  audio.preload = 'auto';

  const savedVol = localStorage.getItem('wavvy_volume');
  audio.volume = savedVol !== null ? parseFloat(savedVol) / 100 : 0.8;

  let currentObjectUrl = null;

  audio.addEventListener('play', () => onStateChange?.({ playing: true }));
  audio.addEventListener('pause', () => onStateChange?.({ playing: false }));
  audio.addEventListener('ended', () => {
    if (state.isRepeat) {
      audio.currentTime = 0;
      audio.play();
    } else {
      next();
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    onTimeUpdate?.({
      current: audio.currentTime,
      total: audio.duration,
      pct: (audio.currentTime / audio.duration) * 100,
    });
  });
  audio.addEventListener('error', () => {
    showToast?.('Playback error', 'error');
  });

  async function play(song) {
    if (!song) return;

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    state.currentSongId = song.id;
    state.currentSong = song;
    onSongChange?.(song);

    try {
      const cached = await getCached(song.id);
      let url;

      if (cached && cached.blob && cached.blob.size > 1000) {
        url = URL.createObjectURL(cached.blob);
        currentObjectUrl = url;
      } else {
        // Relative URL — vite proxy forwards to localhost:3002
        url = `${API}/api/audio/${song.id}`;
        cacheInBackground(song.id, song);
      }

      audio.src = url;
      audio.load();

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => showToast?.(`▶ ${song.title.substring(0, 40)}`, 'success'))
          .catch((err) => {
            console.error('Play failed:', err);
            if (err.name === 'NotAllowedError') {
              showToast?.('Click play button to start', 'warning');
            } else {
              showToast?.('Failed to play', 'error');
            }
          });
      }
    } catch (e) {
      console.error('Play error:', e);
      showToast?.('Failed to load song', 'error');
    }
  }

  async function cacheInBackground(id, song) {
    try {
      const existing = await getCached(id);
      if (existing) return;

      const res = await fetch(`${API}/api/audio/${id}`);
      if (!res.ok) return;
      const blob = await res.blob();
      if (blob.size < 10000) return;

      await saveCached(id, blob, {
        title: song.title,
        author: song.author,
        thumbnail: song.thumbnail,
        duration: song.duration,
      });
      await autoCleanup();
    } catch (e) {
      // silent
    }
  }

  function toggle() {
    if (!state.currentSong) return;
    audio.paused ? audio.play() : audio.pause();
  }

  function prev() {
    if (state.queue.length < 2) return;
    if (state.isShuffle) {
      let i;
      do { i = Math.floor(Math.random() * state.queue.length); }
      while (i === state.queueIndex && state.queue.length > 1);
      state.queueIndex = i;
    } else {
      state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    }
    play(state.queue[state.queueIndex]);
  }

  function next() {
    if (state.queue.length < 2) return;
    if (state.isShuffle) {
      let i;
      do { i = Math.floor(Math.random() * state.queue.length); }
      while (i === state.queueIndex && state.queue.length > 1);
      state.queueIndex = i;
    } else {
      state.queueIndex = (state.queueIndex + 1) % state.queue.length;
    }
    play(state.queue[state.queueIndex]);
  }

  function seek(pct) {
    if (audio.duration) audio.currentTime = (pct / 100) * audio.duration;
  }

  function setVolume(v) {
    audio.volume = v / 100;
    audio.muted = false;
    localStorage.setItem('wavvy_volume', v);
  }

  function toggleMute() {
    audio.muted = !audio.muted;
  }

  return { play, toggle, prev, next, seek, setVolume, toggleMute, audio };
}
