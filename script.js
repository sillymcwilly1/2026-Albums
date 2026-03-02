// ======= YOUR CREDENTIALS =======
const SPOTIFY_CLIENT_ID = 'b56c5609caa74134987a3d188193cc3f';
const SUPABASE_URL = 'https://ybqombcywijvkkfedizc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlicW9tYmN5d2lqdmtrZmVkaXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MTQ4MjksImV4cCI6MjA4Nzk5MDgyOX0.1ii1tJKgBy4Asubxb8Zgve5tLcCNFr6dUHK1qD19FVw';
// =================================

let supabase = null;
let spotifyToken = null;
let currentAlbum = null;
let currentTracks = [];
let selectedTracks = [];
let existingRating = null;

// Load Supabase from CDN then init
function initSupabase() {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ---- Spotify Auth ----
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
  document.getElementById('page-' + page).classList.remove('hidden');
  document.getElementById('nav-' + page).classList.add('active');
  if (page === 'rankings') loadRankings();
}

// ---- Search ----
async function searchAlbums() {
  if (!spotifyToken) { loginSpotify(); return; }
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const res = await fetch('https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=album&limit=20', {
    headers: { Authorization: 'Bearer ' + spotifyToken }
  });

  if (res.status === 401) { loginSpotify(); return; }
  const data = await res.json();
  const albums = data.albums.items;

  const spotifyIds = albums.map(a => a.id);
  const { data: ratedAlbums } = await supabase
    .from('albums')
    .select('spotify_id, ratings(rating)')
    .in('spotify_id', spotifyIds);

  const ratedMap = {};
  (ratedAlbums || []).forEach(a => {
    if (a.ratings && a.ratings.length > 0) ratedMap[a.spotify_id] = a.ratings[0].rating;
  });

  const container = document.getElementById('search-results');
  container.innerHTML = albums.map(album => {
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

  const { data: existing } = await supabase
    .from('albums')
    .select('id, ratings(*)')
    .eq('spotify_id', spotifyId)
    .single();

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

  const { data: albumRow } = await supabase
    .from('albums')
    .upsert({
      spotify_id: spotifyId,
      name: currentAlbum.name,
      artist: currentAlbum.artists[0] ? currentAlbum.artists[0].name : '',
      image_url: currentAlbum.images && currentAlbum.images[0] ? currentAlbum.images[0].url : '',
      release_year: currentAlbum.release_date ? currentAlbum.release_date.split('-')[0] : ''
    }, { onConflict: 'spotify_id' })
    .select()
    .single();

  if (existingRating) {
    await supabase.from('ratings').update({
      rating: rating,
      comments: comments,
      top_songs: selectedTracks,
      updated_at: new Date().toISOString()
    }).eq('id', existingRating.id);
  } else {
    await supabase.from('ratings').insert({
      album_id: albumRow.id,
      rating: rating,
      comments: comments,
      top_songs: selectedTracks
    });
  }

  closeModal();
  alert('Rating saved! ✅');
  searchAlbums();
}

// ---- Rankings ----
async function loadRankings() {
  const { data } = await supabase
    .from('ratings')
    .select('*, albums(*)')
    .order('rating', { ascending: false });

  const container = document.getElementById('rankings-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">No ratings yet. Search for an album to get started!</div>';
    return;
  }

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

// Expose functions to global scope
window.showPage = showPage;
window.searchAlbums = searchAlbums;
window.openAlbum = openAlbum;
window.toggleTrack = toggleTrack;
window.closeModal = closeModal;
window.saveRating = saveRating;

// ---- Init ----
window.addEventListener('load', function() {
  initSupabase();
  getSpotifyToken();
  document.getElementById('search-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchAlbums();
  });
});
