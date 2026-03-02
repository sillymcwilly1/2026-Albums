// ======= FILL THESE IN =======
const SPOTIFY_CLIENT_ID = 'b56c5609caa74134987a3d188193cc3f';
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY';
// ==============================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let spotifyToken = null;
let currentAlbum = null;
let currentTracks = [];
let selectedTracks = [];
let existingRating = null;

// ---- Spotify Auth (implicit grant, no backend needed) ----
function getSpotifyToken() {
  const hash = window.location.hash;
  if (hash) {
    const params = new URLSearchParams(hash.substring(1));
    const token = params.get('access_token');
    if (token) {
      spotifyToken = token;
      localStorage.setItem('spotify_token', token);
      localStorage.setItem('spotify_token_time', Date.now());
      window.location.hash = '';
      return token;
    }
  }
  const saved = localStorage.getItem('spotify_token');
  const savedTime = localStorage.getItem('spotify_token_time');
  if (saved && savedTime && Date.now() - savedTime < 3600000) {
    spotifyToken = saved;
    return saved;
  }
  return null;
}

function loginSpotify() {
  const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
  const scopes = encodeURIComponent('user-read-private');
  window.location.href = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=token&redirect_uri=${redirectUri}&scope=${scopes}`;
}

// ---- Pages ----
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.remove('hidden');
  document.getElementById(`nav-${page}`).classList.add('active');
  if (page === 'rankings') loadRankings();
}

// ---- Search ----
async function searchAlbums() {
  if (!spotifyToken) { loginSpotify(); return; }
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album&limit=20`, {
    headers: { Authorization: `Bearer ${spotifyToken}` }
  });

  if (res.status === 401) { loginSpotify(); return; }
  const data = await res.json();
  const albums = data.albums.items;

  // Check which ones are already rated
  const spotifyIds = albums.map(a => a.id);
  const { data: ratedAlbums } = await supabase
    .from('albums')
    .select('spotify_id, ratings(rating)')
    .in('spotify_id', spotifyIds);

  const ratedMap = {};
  (ratedAlbums || []).forEach(a => {
    if (a.ratings.length > 0) ratedMap[a.spotify_id] = a.ratings[0].rating;
  });

  const container = document.getElementById('search-results');
  container.innerHTML = albums.map(album => `
    <div class="album-card" onclick="openAlbum('${album.id}')">
      <img src="${album.images[0]?.url || ''}" alt="${album.name}" />
      <div class="album-card-info">
        <h3>${album.name}</h3>
        <p>${album.artists[0]?.name}</p>
        ${ratedMap[album.id] !== undefined ? `<span class="rating-badge">${ratedMap[album.id]}/10</span>` : ''}
      </div>
    </div>
  `).join('');
}

document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchAlbums();
});

// ---- Open Album Modal ----
async function openAlbum(spotifyId) {
  if (!spotifyToken) { loginSpotify(); return; }

  const [albumRes, tracksRes] = await Promise.all([
    fetch(`https://api.spotify.com/v1/albums/${spotifyId}`, { headers: { Authorization: `Bearer ${spotifyToken}` } }),
    fetch(`https://api.spotify.com/v1/albums/${spotifyId}/tracks?limit=50`, { headers: { Authorization: `Bearer ${spotifyToken}` } })
  ]);

  const album = await albumRes.json();
  const tracksData = await tracksRes.json();
  currentAlbum = album;
  currentTracks = tracksData.items;
  selectedTracks = [];
  existingRating = null;

  // Check for existing rating
  const { data: existing } = await supabase
    .from('albums')
    .select('id, ratings(*)')
    .eq('spotify_id', spotifyId)
    .single();

  let ratingVal = '';
  let commentVal = '';
  if (existing?.ratings?.length > 0) {
    existingRating = existing.ratings[0];
    ratingVal = existingRating.rating;
    commentVal = existingRating.comments || '';
    selectedTracks = existingRating.top_songs || [];
  }

  const tracksHTML = currentTracks.map((t, i) => `
    <div class="track-item ${selectedTracks.includes(t.name) ? 'selected' : ''}" onclick="toggleTrack('${t.name.replace(/'/g, "\\'")}', this)">
      <span class="track-check">${selectedTracks.includes(t.name) ? '★' : '☆'}</span>
      <span>${i + 1}. ${t.name}</span>
    </div>
  `).join('');

  document.getElementById('modal-body').innerHTML = `
    <div class="modal-album-header">
      <img src="${album.images[0]?.url}" alt="${album.name}" />
      <div>
        <h2>${album.name}</h2>
        <p>${album.artists[0]?.name}</p>
        <p style="font-size:0.8rem;color:#666">${album.release_date?.split('-')[0]}</p>
      </div>
    </div>
    <label>Rating (0–10)</label>
    <input type="number" id="rating-input" min="0" max="10" step="0.1" value="${ratingVal}" placeholder="e.g. 8.5" />
    <label>Comments</label>
    <textarea id="comment-input" placeholder="Write your thoughts...">${commentVal}</textarea>
    <label>Top Songs (tap to mark)</label>
    <div class="tracks-list">${tracksHTML}</div>
    <button class="save-btn" onclick="saveRating('${spotifyId}')">💾 Save Rating</button>
  `;

  document.getElementById('modal').classList.remove('hidden');
}

function toggleTrack(name, el) {
  if (selectedTracks.includes(name)) {
    selectedTracks = selectedTracks.filter(t => t !== name);
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

  // Upsert album
  const { data: albumRow } = await supabase
    .from('albums')
    .upsert({ spotify_id: spotifyId, name: currentAlbum.name, artist: currentAlbum.artists[0]?.name, image_url: currentAlbum.images[0]?.url, release_year: currentAlbum.release_date?.split('-')[0] }, { onConflict: 'spotify_id' })
    .select()
    .single();

  if (existingRating) {
    await supabase.from('ratings').update({ rating, comments, top_songs: selectedTracks, updated_at: new Date().toISOString() }).eq('id', existingRating.id);
  } else {
    await supabase.from('ratings').insert({ album_id: albumRow.id, rating, comments, top_songs: selectedTracks });
  }

  closeModal();
  alert('Rating saved! ✅');
  searchAlbums();
}

// ---- Rankings ----
async function loadRankings() {
  const { data, error } = await supabase
    .from('ratings')
    .select('*, albums(*)')
    .order('rating', { ascending: false });

  const container = document.getElementById('rankings-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No ratings yet. Search for an album to get started!</div>';
    return;
  }

  container.innerHTML = data.map((r, i) => `
    <div class="rankings-item" onclick="openAlbum('${r.albums.spotify_id}')">
      <div class="rank-num">#${i + 1}</div>
      <img src="${r.albums.image_url}" alt="${r.albums.name}" />
      <div class="rankings-item-info">
        <h3>${r.albums.name}</h3>
        <p>${r.albums.artist} · ${r.albums.release_year || ''}</p>
        ${r.top_songs?.length > 0 ? `<p style="color:#1DB954;font-size:0.75rem;margin-top:4px">★ ${r.top_songs.slice(0,3).join(', ')}</p>` : ''}
        ${r.comments ? `<p style="color:#666;font-size:0.75rem;margin-top:2px">"${r.comments.substring(0,60)}${r.comments.length > 60 ? '...' : ''}"</p>` : ''}
      </div>
      <div class="big-rating">${r.rating}</div>
    </div>
  `).join('');
}

// ---- Init ----
getSpotifyToken();
