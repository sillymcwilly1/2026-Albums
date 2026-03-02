// ======= YOUR CREDENTIALS =======
const SPOTIFY_CLIENT_ID = 'b56c5609caa74134987a3d188193cc3f';
const SUPABASE_URL = 'https://ybqombcywijvkkfedizc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlicW9tYmN5d2lqdmtrZmVkaXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MTQ4MjksImV4cCI6MjA4Nzk5MDgyOX0.1ii1tJKgBy4Asubxb8Zgve5tLcCNFr6dUHK1qD19FVw';
// =================================

let db = null;
let spotifyToken = null;
let currentAlbum = null;
let currentTracks = [];
let selectedTracks = [];
let existingRating = null;
let barChartInstance = null;

function initSupabase() {
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---- Spotify Auth (PKCE) ----
function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const array = new Uint8Array(length);
  window.crypto.getRandomValues(array);
  array.forEach(function(byte) { result += chars[byte % chars.length]; });
  return result;
}

async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function loginSpotify() {
  const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
  const scopes = encodeURIComponent('user-read-private user-read-recently-played');
  const codeVerifier = generateRandomString(64);
  localStorage.setItem('code_verifier', codeVerifier);
  generateCodeChallenge(codeVerifier).then(function(codeChallenge) {
    window.location.href = 'https://accounts.spotify.com/authorize?client_id=' + SPOTIFY_CLIENT_ID +
      '&response_type=code' +
      '&redirect_uri=' + redirectUri +
      '&scope=' + scopes +
      '&code_challenge_method=S256' +
      '&code_challenge=' + codeChallenge;
  });
}

async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  const codeVerifier = localStorage.getItem('code_verifier');
  const redirectUri = window.location.origin + window.location.pathname;
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: SPOTIFY_CLIENT_ID,
      code_verifier: codeVerifier
    })
  });
  const tokenData = await response.json();
  if (tokenData.access_token) {
    spotifyToken = tokenData.access_token;
    localStorage.setItem('spotify_token', tokenData.access_token);
    localStorage.setItem('spotify_token_time', Date.now());
    if (tokenData.refresh_token) localStorage.setItem('spotify_refresh_token', tokenData.refresh_token);
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }
  return false;
}

function getSpotifyToken() {
  const saved = localStorage.getItem('spotify_token');
  const savedTime = localStorage.getItem('spotify_token_time');
  if (saved && savedTime && Date.now() - savedTime < 3600000) {
    spotifyToken = saved;
    return saved;
  }
  return null;
}

// ---- Pages ----
function showPage(page) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.add('hidden'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('page-' + page).classList.remove('hidden');
  document.getElementById('nav-' + page).classList.add('active');
  if (page === 'rankings') loadRankings();
}

// ---- Recently Played ----
async function loadRecentlyPlayed() {
  if (!spotifyToken) return;
  const res = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=50', {
    headers: { Authorization: 'Bearer ' + spotifyToken }
  });
  if (!res.ok) return;
  const data = await res.json();

  const seenIds = new Set();
  const albums = [];
  data.items.forEach(function(item) {
    const album = item.track.album;
    if (!seenIds.has(album.id)) {
      seenIds.add(album.id);
      albums.push(album);
    }
  });

  const spotifyIds = albums.map(function(a) { return a.id; });
  const { data: ratedAlbums } = await db.from('albums').select('spotify_id, ratings(rating)').in('spotify_id', spotifyIds);
  const ratedMap = {};
  (ratedAlbums || []).forEach(function(a) {
    if (a.ratings && a.ratings.length > 0) ratedMap[a.spotify_id] = a.ratings[0].rating;
  });

  const container = document.getElementById('recent-results');
  if (!container) return;
  container.innerHTML = albums.map(function(album) {
    const img = album.images && album.images[0] ? album.images[0].url : '';
    const artist = album.artists && album.artists[0] ? album.artists[0].name : '';
    const badge = ratedMap[album.id] !== undefined ? '<span class="rating-badge">' + ratedMap[album.id] + '/10</span>' : '';
    return '<div class="album-card" onclick="openAlbum(\'' + album.id + '\')">' +
      '<img src="' + img + '" alt="' + album.name + '" />' +
      '<div class="album-card-info"><h3>' + album.name + '</h3><p>' + artist + '</p>' + badge + '</div></div>';
  }).join('');
}

// ---- Search ----
async function searchAlbums() {
  if (!spotifyToken) { loginSpotify(); return; }
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  document.getElementById('recent-section').classList.add('hidden');
  document.getElementById('search-results-section').classList.remove('hidden');

  const res = await fetch('https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=album&limit=20', {
    headers: { Authorization: 'Bearer ' + spotifyToken }
  });
  if (res.status === 401) { loginSpotify(); return; }
  const data = await res.json();
  const albums = data.albums.items;
  const spotifyIds = albums.map(function(a) { return a.id; });
  const { data: ratedAlbums } = await db.from('albums').select('spotify_id, ratings(rating)').in('spotify_id', spotifyIds);
  const ratedMap = {};
  (ratedAlbums || []).forEach(function(a) {
    if (a.ratings && a.ratings.length > 0) ratedMap[a.spotify_id] = a.ratings[0].rating;
  });
  const container = document.getElementById('search-results');
  container.innerHTML = albums.map(function(album) {
    const img = album.images && album.images[0] ? album.images[0].url : '';
    const artist = album.artists && album.artists[0] ? album.artists[0].name : '';
    const badge = ratedMap[album.id] !== undefined ? '<span class="rating-badge">' + ratedMap[album.id] + '/10</span>' : '';
    return '<div class="album-card" onclick="openAlbum(\'' + album.id + '\')">' +
      '<img src="' + img + '" alt="' + album.name + '" />' +
      '<div class="album-card-info"><h3>' + album.name + '</h3><p>' + artist + '</p>' + badge + '</div></div>';
  }).join('');
}

// ---- Open Album Modal ----
async function openAlbum(spotifyId) {
  if (!spotifyToken) { loginSpotify(); return; }
  const [albumRes, tracksRes] = await Promise.all([
    fetch('https://api.spotify.com/v1/albums/' + spotifyId, { headers: { Authorization: 'Bearer ' + spotifyToken } }),
    fetch('https://api.spotify.com/v1/albums/' + spotifyId + '/tracks?limit=50', { headers: { Authorization: 'Bearer ' + spotifyToken } })
  ]);
  const album = await albumRes.json();
  const tracksData = await tracksRes.json();
  currentAlbum = album;
  currentTracks = tracksData.items;
  selectedTracks = [];
  existingRating = null;
  const { data: existing } = await db.from('albums').select('id, ratings(*)').eq('spotify_id', spotifyId).single();
  let ratingVal = '';
  let commentVal = '';
  if (existing && existing.ratings && existing.ratings.length > 0) {
    existingRating = existing.ratings[0];
    ratingVal = existingRating.rating;
    commentVal = existingRating.comments || '';
    selectedTracks = existingRating.top_songs || [];
  }
  const tracksHTML = currentTracks.map(function(t, i) {
    const isSelected = selectedTracks.includes(t.name);
    const safeName = t.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<div class="track-item ' + (isSelected ? 'selected' : '') + '" onclick="toggleTrack(\'' + safeName + '\', this)">' +
      '<span class="track-check">' + (isSelected ? '★' : '☆') + '</span>' +
      '<span>' + (i+1) + '. ' + t.name + '</span></div>';
  }).join('');
  document.getElementById('modal-body').innerHTML =
    '<div class="modal-album-header">' +
    '<img src="' + (album.images && album.images[0] ? album.images[0].url : '') + '" alt="' + album.name + '" />' +
    '<div><h2>' + album.name + '</h2>' +
    '<p>' + (album.artists && album.artists[0] ? album.artists[0].name : '') + '</p>' +
    '<p style="font-size:0.8rem;color:#666">' + (album.release_date ? album.release_date.split('-')[0] : '') + '</p></div></div>' +
    '<label>Rating (0–10)</label>' +
    '<input type="number" id="rating-input" min="0" max="10" step="0.1" value="' + ratingVal + '" placeholder="e.g. 8.5" />' +
    '<label>Comments</label>' +
    '<textarea id="comment-input" placeholder="Write your thoughts...">' + commentVal + '</textarea>' +
    '<label>Top Songs (tap to mark)</label>' +
    '<div class="tracks-list">' + tracksHTML + '</div>' +
    '<button class="save-btn" onclick="saveRating(\'' + spotifyId + '\')">💾 Save Rating</button>';
  document.getElementById('modal').classList.remove('hidden');
}

function toggleTrack(name, el) {
  if (selectedTracks.includes(name)) {
    selectedTracks = selectedTracks.filter(function(t) { return t !== name; });
    el.classList.remove('selected');
    el.querySelector('.track-check').textContent = '☆';
  } else {
    selectedTracks.push(name);
    el.classList.add('selected');
    el.querySelector('.track-check').textContent = '★';
  }
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

// ---- Save Rating ----
async function saveRating(spotifyId) {
  const rating = parseFloat(document.getElementById('rating-input').value);
  const comments = document.getElementById('comment-input').value;
  if (isNaN(rating) || rating < 0 || rating > 10) {
    alert('Please enter a rating between 0 and 10');
    return;
  }
  const { data: albumRow } = await db.from('albums').upsert({
    spotify_id: spotifyId,
    name: currentAlbum.name,
    artist: currentAlbum.artists[0] ? currentAlbum.artists[0].name : '',
    image_url: currentAlbum.images && currentAlbum.images[0] ? currentAlbum.images[0].url : '',
    release_year: currentAlbum.release_date ? currentAlbum.release_date.split('-')[0] : ''
  }, { onConflict: 'spotify_id' }).select().single();
  if (existingRating) {
    await db.from('ratings').update({
      rating: rating, comments: comments, top_songs: selectedTracks, updated_at: new Date().toISOString()
    }).eq('id', existingRating.id);
  } else {
    await db.from('ratings').insert({ album_id: albumRow.id, rating: rating, comments: comments, top_songs: selectedTracks });
  }
  closeModal();
  alert('Rating saved! ✅');
  searchAlbums();
}

// ---- Charts ----
function renderBarChart(data) {
  const sorted = [...data].sort(function(a, b) { return b.rating - a.rating; });
  const labels = sorted.map(function(r) {
    const name = r.albums.name;
    return name.length > 15 ? name.substring(0, 15) + '…' : name;
  });
  const values = sorted.map(function(r) { return r.rating; });
  const colors = values.map(function(v) {
    if (v >= 8) return '#1DB954';
    if (v >= 6) return '#17a844';
    if (v >= 4) return '#b3b300';
    return '#cc3300';
  });
  if (barChartInstance) barChartInstance.destroy();
  const ctx = document.getElementById('barChart').getContext('2d');
  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: function(items) { return sorted[items[0].dataIndex].albums.name; },
            label: function(item) { return item.raw + ' / 10'; }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#aaa', font: { size: 10 } }, grid: { color: '#222' } },
        y: { min: 0, max: 10, ticks: { color: '#aaa' }, grid: { color: '#222' } }
      }
    }
  });
}

function renderTopSongs(data) {
  const songCounts = {};
  data.forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.forEach(function(song) {
        songCounts[song] = (songCounts[song] || 0) + 1;
      });
    }
  });
  const sorted = Object.entries(songCounts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 8);
  const container = document.getElementById('top-songs-chart');
  if (sorted.length === 0) {
    container.innerHTML = '<p style="color:#555;font-size:0.85rem">No top songs marked yet.</p>';
    return;
  }
  const max = sorted[0][1];
  container.innerHTML = sorted.map(function(entry) {
    const song = entry[0];
    const count = entry[1];
    const pct = Math.round((count / max) * 100);
    const displayName = song.length > 22 ? song.substring(0, 22) + '…' : song;
    return '<div class="top-song-row">' +
      '<div class="top-song-label"><span>' + displayName + '</span><span>★ ' + count + '</span></div>' +
      '<div class="top-song-bar-bg"><div class="top-song-bar-fill" style="width:' + pct + '%"></div></div>' +
      '</div>';
  }).join('');
}

// ---- Rankings ----
async function loadRankings() {
  const { data } = await db.from('ratings').select('*, albums(*)').order('rating', { ascending: false });
  const container = document.getElementById('rankings-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No ratings yet. Search for an album to get started!</div>';
    document.getElementById('top-songs-chart').innerHTML = '<p style="color:#555;font-size:0.85rem">No data yet.</p>';
    return;
  }
  renderBarChart(data);
  renderTopSongs(data);
  container.innerHTML = data.map(function(r, i) {
    const topSongs = r.top_songs && r.top_songs.length > 0 ?
      '<p style="color:#1DB954;font-size:0.75rem;margin-top:4px">★ ' + r.top_songs.slice(0,3).join(', ') + '</p>' : '';
    const comment = r.comments ?
      '<p style="color:#666;font-size:0.75rem;margin-top:2px">"' + r.comments.substring(0,60) + (r.comments.length > 60 ? '...' : '') + '"</p>' : '';
    return '<div class="rankings-item" onclick="openAlbum(\'' + r.albums.spotify_id + '\')">' +
      '<div class="rank-num">#' + (i+1) + '</div>' +
      '<img src="' + r.albums.image_url + '" alt="' + r.albums.name + '" />' +
      '<div class="rankings-item-info"><h3>' + r.albums.name + '</h3>' +
      '<p>' + r.albums.artist + ' · ' + (r.albums.release_year || '') + '</p>' +
      topSongs + comment + '</div>' +
      '<div class="big-rating">' + r.rating + '</div></div>';
  }).join('');
}

// ---- Expose to global scope ----
window.showPage = showPage;
window.searchAlbums = searchAlbums;
window.openAlbum = openAlbum;
window.toggleTrack = toggleTrack;
window.closeModal = closeModal;
window.saveRating = saveRating;

// ---- Init ----
window.addEventListener('load', async function() {
  initSupabase();
  const params = new URLSearchParams(window.location.search);
  if (params.get('code')) {
    await handleSpotifyCallback();
  } else {
    getSpotifyToken();
  }
  document.getElementById('search-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchAlbums();
  });
  loadRecentlyPlayed();
});
