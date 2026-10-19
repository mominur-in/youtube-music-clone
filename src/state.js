export const state = {
  songs: [],
  queue: [],
  queueIndex: -1,
  currentSongId: null,
  currentSong: null,
  isLoading: false,
  isShuffle: false,
  isRepeat: false,
  liked: JSON.parse(localStorage.getItem('wavvy_liked') || '{}'),
  currentView: 'trending',
  viewMode: 'grid',
};

export const API = '';
