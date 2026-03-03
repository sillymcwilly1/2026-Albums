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
let replayBarInstance = null;
let replayLineInstance = null;

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
    saveTokens(tokenData);
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }
  return false;
}

function saveTokens(tokenData) {
  spotifyToken = tokenData.access_token;
  localStorage.setItem('spotify_token', tokenData.access_token);
  localStorage.setItem('spotify_token_time', Date.now());
  if (tokenData.refresh_token) {
    localStorage.setItem('spotify_refresh_token', tokenData.refresh_token);
  }
}

async function refreshSpotifyToken() {
  const refreshToken = localStorage.getItem('spotify_refresh_token');
  if (!refreshToken) { loginSpotify(); return false; }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: SPOTIFY_CLIENT_ID
    })
  });
  const tokenData = await response.json();
  if (tokenData.access_token) { saveTokens(tokenData); return true; }
  loginSpotify();
  return false;
}

async function spotifyFetch(url) {
  let token = localStorage.getItem('spotify_token');
  const savedTime = localStorage.getItem('spotify_token_time');
  const needsRefresh = !token || !savedTime || Date.now() - savedTime >= 55 * 60 * 1000;
  if (needsRefresh) {
    const refreshed = await refreshSpotifyToken();
    if (!refreshed) return null;
    token = localStorage.getItem('spotify_token');
  }
  if (!token) return null;
  spotifyToken = token;
  let res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    const refreshed = await refreshSpotifyToken();
    if (!refreshed) return null;
    token = localStorage.getItem('spotify_token');
    res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  }
  if (!res.ok) return null;
  return res.json();
}

// ---- Pages ----
function showPage(page) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.add('hidden'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('page-' + page).classList.remove('hidden');
  document.getElementById('nav-' + page).classList.add('active');
  if (page === 'rankings') loadRankings();
  if (page === 'replay') loadReplayTracker();
  if (page === 'week') initWeekPage();
}

// ---- Recently Played ----
async function loadRecentlyPlayed() {
  const token = localStorage.getItem('spotify_token');
  if (!token) return;
  const data = await spotifyFetch('https://api.spotify.com/v1/me/player/recently-played?limit=50');
  if (!data || !data.items) return;
  await logPlays(data.items);
  const seenIds = new Set();
  const albums = [];
  data.items.forEach(function(item) {
    const album = item.track.album;
    if (!seenIds.has(album.id)) { seenIds.add(album.id); albums.push(album); }
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

async function logPlays(items) {
  const now = new Date();
  const hourKey = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0') + 'T' +
    String(now.getHours()).padStart(2,'0');
  const lastLogged = localStorage.getItem('last_log_hour');
  if (lastLogged === hourKey) return;
  localStorage.setItem('last_log_hour', hourKey);
  const albumMap = {};
  items.forEach(function(item) {
    const album = item.track.album;
    const duration = item.track.duration_ms || 0;
    if (!albumMap[album.id]) {
      albumMap[album.id] = {
        spotify_album_id: album.id,
        album_name: album.name,
        artist: album.artists && album.artists[0] ? album.artists[0].name : '',
        image_url: album.images && album.images[0] ? album.images[0].url : '',
        duration_ms: 0,
        logged_at: new Date().toISOString()
      };
    }
    albumMap[album.id].duration_ms += duration;
  });
  const toLog = Object.values(albumMap);
  if (toLog.length > 0) await db.from('play_logs').insert(toLog);
}

// ---- Replay Tracker ----
async function loadReplayTracker() {
  const { data: logs } = await db.from('play_logs').select('*').order('logged_at', { ascending: true });
  if (!logs || logs.length === 0) {
    document.getElementById('replayBarChart').closest('.chart-card').innerHTML +=
      '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:16px;font-style:italic">No play data yet — open the app a few times to start building your history.</p>';
    return;
  }
  renderReplayBar(logs);
  renderReplayLine(logs);
}

function renderReplayBar(logs) {
  const minuteMap = {};
  logs.forEach(function(log) {
    const mins = log.duration_ms ? Math.round(log.duration_ms / 60000) : 0;
    minuteMap[log.album_name] = (minuteMap[log.album_name] || 0) + mins;
  });
  const sorted = Object.entries(minuteMap).filter(function(e) { return e[1] > 0; })
    .sort(function(a,b) { return b[1]-a[1]; }).slice(0,12);
  if (sorted.length === 0) {
    document.getElementById('replayBarChart').closest('.chart-card').innerHTML +=
      '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:16px;font-style:italic">No duration data yet — new plays will be tracked correctly going forward.</p>';
    return;
  }
  const labels = sorted.map(function(e) { return e[0].length > 16 ? e[0].substring(0,16)+'…' : e[0]; });
  const values = sorted.map(function(e) { return e[1]; });
  if (replayBarInstance) replayBarInstance.destroy();
  const ctx = document.getElementById('replayBarChart').getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, '#1DB954');
  gradient.addColorStop(1, '#0a4d22');
  replayBarInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: gradient, borderRadius: 3, borderSkipped: false }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a15', borderColor: '#2e2e24', borderWidth: 1,
          titleColor: '#f0efe8', bodyColor: '#9e9d8e',
          callbacks: {
            title: function(items) { return sorted[items[0].dataIndex][0]; },
            label: function(item) { return item.raw + ' min listened'; }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#5a5a4a', font: { size: 10, family: 'DM Sans' } }, grid: { color: '#2e2e24' } },
        y: { ticks: { color: '#5a5a4a', font: { family: 'DM Sans' }, callback: function(v) { return v + 'm'; } }, grid: { color: '#2e2e24' } }
      }
    }
  });
}

function renderReplayLine(logs) {
  const byDate = {};
  logs.forEach(function(log) {
    const date = log.logged_at.substring(0,10);
    const mins = log.duration_ms ? Math.round(log.duration_ms / 60000) : 0;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][log.album_name] = (byDate[date][log.album_name] || 0) + mins;
  });
  const dates = Object.keys(byDate).sort();
  const totalMins = {};
  logs.forEach(function(log) {
    const mins = log.duration_ms ? Math.round(log.duration_ms / 60000) : 0;
    totalMins[log.album_name] = (totalMins[log.album_name] || 0) + mins;
  });
  const top5 = Object.entries(totalMins).filter(function(e) { return e[1] > 0; })
    .sort(function(a,b) { return b[1]-a[1]; }).slice(0,5).map(function(e) { return e[0]; });
  if (top5.length === 0) return;
  const colors = ['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];
  const datasets = top5.map(function(album, i) {
    return {
      label: album.length > 20 ? album.substring(0,20)+'…' : album,
      data: dates.map(function(date) { return (byDate[date] && byDate[date][album]) || 0; }),
      borderColor: colors[i], backgroundColor: colors[i]+'22',
      tension: 0.4, fill: false, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2
    };
  });
  if (replayLineInstance) replayLineInstance.destroy();
  const ctx = document.getElementById('replayLineChart').getContext('2d');
  replayLineInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets: datasets },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#9e9d8e', font: { size: 11, family: 'DM Sans' }, boxWidth: 10, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          backgroundColor: '#1a1a15', borderColor: '#2e2e24', borderWidth: 1,
          titleColor: '#f0efe8', bodyColor: '#9e9d8e',
          callbacks: { label: function(item) { return ' '+item.dataset.label+': '+item.raw+'m'; } }
        }
      },
      scales: {
        x: { ticks: { color: '#5a5a4a', font: { size: 10, family: 'DM Sans' } }, grid: { color: '#2e2e24' } },
        y: { ticks: { color: '#5a5a4a', font: { family: 'DM Sans' }, callback: function(v) { return v+'m'; } }, grid: { color: '#2e2e24' } }
      }
    }
  });
}

// ---- Search ----
async function searchAlbums() {
  const token = localStorage.getItem('spotify_token');
  if (!token) { loginSpotify(); return; }
  spotifyToken = token;
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;
  document.getElementById('recent-section').classList.add('hidden');
  document.getElementById('search-results-section').classList.remove('hidden');
  const res = await fetch('https://api.spotify.com/v1/search?q=' + encodeURIComponent(query) + '&type=album&limit=10', {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (res.status === 401) {
    const refreshed = await refreshSpotifyToken();
    if (!refreshed) { loginSpotify(); return; }
    return searchAlbums();
  }
  if (!res.ok) { alert('Search failed — please try again.'); return; }
  const data = await res.json();
  if (!data.albums || !data.albums.items) { alert('No results found.'); return; }
  const albums = data.albums.items;
  const spotifyIds = albums.map(function(a) { return a.id; });
  const { data: ratedAlbums } = await db.from('albums').select('spotify_id, ratings(rating)').in('spotify_id', spotifyIds);
  const ratedMap = {};
  (ratedAlbums||[]).forEach(function(a) { if (a.ratings&&a.ratings.length>0) ratedMap[a.spotify_id]=a.ratings[0].rating; });
  const container = document.getElementById('search-results');
  container.innerHTML = albums.map(function(album) {
    const img = album.images&&album.images[0]?album.images[0].url:'';
    const artist = album.artists&&album.artists[0]?album.artists[0].name:'';
    const badge = ratedMap[album.id]!==undefined?'<span class="rating-badge">'+ratedMap[album.id]+'/10</span>':'';
    return '<div class="album-card" onclick="openAlbum(\''+album.id+'\')">'+
      '<img src="'+img+'" alt="'+album.name+'" />'+
      '<div class="album-card-info"><h3>'+album.name+'</h3><p>'+artist+'</p>'+badge+'</div></div>';
  }).join('');
}

// ---- Open Album Modal ----
async function openAlbum(spotifyId) {
  const token = localStorage.getItem('spotify_token');
  if (!token) { loginSpotify(); return; }
  spotifyToken = token;
  const [album, tracksData] = await Promise.all([
    spotifyFetch('https://api.spotify.com/v1/albums/' + spotifyId),
    spotifyFetch('https://api.spotify.com/v1/albums/' + spotifyId + '/tracks?limit=50')
  ]);
  if (!album || !tracksData) return;
  currentAlbum = album;
  currentTracks = tracksData.items;
  selectedTracks = [];
  existingRating = null;
  const { data: existing } = await db.from('albums').select('id, ratings(*)').eq('spotify_id', spotifyId).single();
  let ratingVal = '', commentVal = '';
  if (existing && existing.ratings && existing.ratings.length > 0) {
    existingRating = existing.ratings[0];
    ratingVal = existingRating.rating;
    commentVal = existingRating.comments || '';
    selectedTracks = existingRating.top_songs || [];
  }
  const tracksHTML = currentTracks.map(function(t, i) {
    const isSelected = selectedTracks.includes(t.name);
    const safeName = t.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<div class="track-item '+(isSelected?'selected':'')+'" onclick="toggleTrack(\''+safeName+'\', this)">'+
      '<span class="track-check">'+(isSelected?'★':'☆')+'</span>'+
      '<span>'+(i+1)+'. '+t.name+'</span></div>';
  }).join('');
  const year = album.release_date ? album.release_date.split('-')[0] : '';
  const artistName = album.artists && album.artists[0] ? album.artists[0].name : '';
  document.getElementById('modal-body').innerHTML =
    '<div class="modal-album-header">'+
    '<img src="'+(album.images&&album.images[0]?album.images[0].url:'')+'" alt="'+album.name+'" />'+
    '<div><h2>'+album.name+'</h2><p>'+artistName+'</p>'+
    '<p style="color:var(--text-muted);font-size:0.76rem;margin-top:4px">'+year+'</p></div></div>'+
    '<label>Rating (0–10)</label>'+
    '<input type="number" id="rating-input" min="0" max="10" step="0.1" value="'+ratingVal+'" placeholder="e.g. 8.5" />'+
    '<label>Comments</label>'+
    '<textarea id="comment-input" placeholder="Write your thoughts…">'+commentVal+'</textarea>'+
    '<label>Top Songs</label>'+
    '<div class="tracks-list">'+tracksHTML+'</div>'+
    '<button class="save-btn" onclick="saveRating(\''+spotifyId+'\')">Save Rating</button>';
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

function closeModal() { document.getElementById('modal').classList.add('hidden'); }

// ---- Save Rating ----
async function saveRating(spotifyId) {
  const rating = parseFloat(document.getElementById('rating-input').value);
  const comments = document.getElementById('comment-input').value;
  if (isNaN(rating) || rating < 0 || rating > 10) { alert('Please enter a rating between 0 and 10'); return; }
  const { data: albumRow } = await db.from('albums').upsert({
    spotify_id: spotifyId,
    name: currentAlbum.name,
    artist: currentAlbum.artists[0] ? currentAlbum.artists[0].name : '',
    image_url: currentAlbum.images && currentAlbum.images[0] ? currentAlbum.images[0].url : '',
    release_year: currentAlbum.release_date ? currentAlbum.release_date.split('-')[0] : ''
  }, { onConflict: 'spotify_id' }).select().single();
  if (existingRating) {
    await db.from('ratings').update({ rating, comments, top_songs: selectedTracks, updated_at: new Date().toISOString() }).eq('id', existingRating.id);
  } else {
    await db.from('ratings').insert({ album_id: albumRow.id, rating, comments, top_songs: selectedTracks });
  }
  closeModal();
  alert('Rating saved! ✅');
}

// ---- Bar Chart ----
function renderBarChart(data) {
  const sorted = [...data].sort(function(a,b) { return b.rating-a.rating; });
  function ratingToColor(v) {
    if (v >= 9.5) return '#1fef6a';
    if (v >= 9)   return '#1DB954';
    if (v >= 8)   return '#19a348';
    if (v >= 7)   return '#148d3c';
    if (v >= 6)   return '#0f7731';
    if (v >= 5)   return '#0b6128';
    if (v >= 4)   return '#074b1e';
    if (v >= 3)   return '#053a17';
    if (v >= 2)   return '#032a10';
    return '#021a0a';
  }
  const labels = sorted.map(function(r) { const n=r.albums.name; return n.length>16?n.substring(0,16)+'…':n; });
  const values = sorted.map(function(r) { return r.rating; });
  const colors = values.map(ratingToColor);
  const borderColors = values.map(function(v) { return v>=7?'rgba(29,185,84,0.4)':'rgba(29,185,84,0.1)'; });
  if (barChartInstance) barChartInstance.destroy();
  const ctx = document.getElementById('barChart').getContext('2d');
  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: borderColors, borderWidth: 1, borderRadius: 3, borderSkipped: false }] },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a15', borderColor: '#2e2e24', borderWidth: 1,
          titleColor: '#f0efe8', titleFont: { family: 'DM Sans', weight: '700' },
          bodyColor: '#9e9d8e', bodyFont: { family: 'DM Sans' }, padding: 12,
          callbacks: {
            title: function(items) { return sorted[items[0].dataIndex].albums.name; },
            label: function(item) { const r=sorted[item.dataIndex]; return ' '+item.raw+' / 10  —  '+r.albums.artist; }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#5a5a4a', font: { size: 10, family: 'DM Sans' }, maxRotation: 45 }, grid: { color: '#2e2e24' } },
        y: { min: 0, max: 10, ticks: { color: '#5a5a4a', font: { family: 'DM Sans' }, callback: function(v) { return v%2===0?v:''; } }, grid: { color: '#2e2e24' } }
      }
    }
  });
}

// ---- Rankings ----
async function loadRankings() {
  const { data } = await db.from('ratings').select('*, albums(*)').order('rating', { ascending: false });
  const container = document.getElementById('rankings-list');
  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state">Nothing rated yet.<br>Head to Search to get started.</div>';
    return;
  }
  renderBarChart(data);
  container.innerHTML = data.map(function(r, i) {
    const rankClass = i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'';
    const topSongs = r.top_songs&&r.top_songs.length>0?
      '<p style="color:var(--green);font-size:0.72rem;margin-top:5px">★ '+r.top_songs.slice(0,3).join(' · ')+'</p>':'';
    const comment = r.comments?
      '<p style="color:var(--text-muted);font-size:0.72rem;margin-top:3px;font-style:italic">"'+r.comments.substring(0,70)+(r.comments.length>70?'…':'')+'"</p>':'';
    return '<div class="rankings-item '+rankClass+'" onclick="openAlbum(\''+r.albums.spotify_id+'\')">'+
      '<div class="rank-num">'+(i+1)+'</div>'+
      '<img src="'+r.albums.image_url+'" alt="'+r.albums.name+'" />'+
      '<div class="rankings-item-info"><h3>'+r.albums.name+'</h3>'+
      '<p>'+r.albums.artist+' &nbsp;·&nbsp; '+(r.albums.release_year||'')+'</p>'+
      topSongs+comment+'</div>'+
      '<div class="big-rating">'+r.rating+'</div></div>';
  }).join('');
}

// ============================================================
// ---- Week in Review Card (9:16 — 1080×1920) ----
// ============================================================

// Canvas dimensions
const CW = 1080;
const CH = 1920;
const PAD = 72; // horizontal padding

// Strict row layout — each section gets a fixed Y band
const LAYOUT = {
  topBar:       { y: 0,    h: 8 },
  logo:         { y: 8,    h: 130 },
  divider1:     { y: 138,  h: 24 },
  dateRow:      { y: 162,  h: 60 },
  divider2:     { y: 222,  h: 24 },
  statsRow:     { y: 246,  h: 120 },
  divider3:     { y: 366,  h: 24 },
  albumsLabel:  { y: 390,  h: 50 },
  albumsRow:    { y: 440,  h: 430 },
  divider4:     { y: 870,  h: 24 },
  distLabel:    { y: 894,  h: 50 },
  distRow:      { y: 944,  h: 260 },
  divider5:     { y: 1204, h: 24 },
  songsLabel:   { y: 1228, h: 50 },
  songsRow:     { y: 1278, h: 540 },
  bottomBar:    { y: 1912, h: 8 },
};

// Strict text truncation — measures and cuts at maxWidth
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ctx.measureText(text.substring(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid;
  }
  return text.substring(0, lo) + '…';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawMCMDivider(ctx, x, y, width) {
  ctx.strokeStyle = '#2e2e24';
  ctx.lineWidth = 1;
  const cx = x + width / 2;
  // Left line
  ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(cx - 28, y + 12); ctx.stroke();
  // Right line
  ctx.beginPath(); ctx.moveTo(cx + 28, y + 12); ctx.lineTo(x + width, y + 12); ctx.stroke();
  // Dots
  [cx - 18, cx, cx + 18].forEach(function(dx, i) {
    ctx.fillStyle = i === 1 ? '#1DB954' : '#3a3a2e';
    ctx.beginPath();
    ctx.arc(dx, y + 12, i === 1 ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawStarburst(ctx, cx, cy, r, rays, color) {
  ctx.save();
  ctx.fillStyle = color;
  const inner = r * 0.35;
  for (let i = 0; i < rays; i++) {
    const a1 = (i / rays) * Math.PI * 2;
    const a2 = a1 + Math.PI / rays;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
    ctx.lineTo(cx + Math.cos(a2) * inner, cy + Math.sin(a2) * inner);
    ctx.lineTo(cx + Math.cos(a1 + Math.PI * 2 / rays) * r, cy + Math.sin(a1 + Math.PI * 2 / rays) * r);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawAtomicDots(ctx, x, y, color) {
  ctx.fillStyle = color;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      ctx.beginPath();
      ctx.arc(x + col * 18, y + row * 18, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function initWeekPage() {
  const input = document.getElementById('week-start-input');
  if (!input.value) {
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    input.value = monday.toISOString().substring(0, 10);
  }
}

async function generateWeekReview() {
  const input = document.getElementById('week-start-input');
  const startStr = input.value;
  if (!startStr) { alert('Please pick a week start date.'); return; }

  const startDate = new Date(startStr + 'T00:00:00');
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 7);

  document.getElementById('week-loading').classList.remove('hidden');
  document.getElementById('week-output').classList.add('hidden');
  document.getElementById('week-empty').classList.add('hidden');

  // Fetch ratings for this week (by updated_at or created_at)
  const { data: ratingsU } = await db.from('ratings').select('*, albums(*)')
    .gte('updated_at', startDate.toISOString()).lt('updated_at', endDate.toISOString());
  const { data: ratingsC } = await db.from('ratings').select('*, albums(*)')
    .gte('created_at', startDate.toISOString()).lt('created_at', endDate.toISOString());
  const allMap = {};
  [...(ratingsU||[]), ...(ratingsC||[])].forEach(function(r) { allMap[r.id] = r; });
  const weekRatings = Object.values(allMap).sort(function(a,b) { return b.rating - a.rating; });

  // Fetch play logs
  const { data: playLogs } = await db.from('play_logs').select('*')
    .gte('logged_at', startDate.toISOString()).lt('logged_at', endDate.toISOString());

  if (weekRatings.length === 0 && (!playLogs || playLogs.length === 0)) {
    document.getElementById('week-loading').classList.add('hidden');
    document.getElementById('week-empty').classList.remove('hidden');
    return;
  }

  // Stats
  const totalMinutes = (playLogs||[]).reduce(function(s, l) {
    return s + (l.duration_ms ? Math.round(l.duration_ms / 60000) : 0);
  }, 0);

  const ratingBuckets = { '9-10': 0, '7-8': 0, '5-6': 0, '1-4': 0 };
  weekRatings.forEach(function(r) {
    if (r.rating >= 9) ratingBuckets['9-10']++;
    else if (r.rating >= 7) ratingBuckets['7-8']++;
    else if (r.rating >= 5) ratingBuckets['5-6']++;
    else ratingBuckets['1-4']++;
  });

  // Top starred songs from top 3 rated albums
  const topStarred = [];
  weekRatings.slice(0, 3).forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.slice(0, 2).forEach(function(song) {
        topStarred.push({ song: song, album: r.albums.name, artist: r.albums.artist });
      });
    }
  });

  const top3 = weekRatings.slice(0, 3);

  // Load album art with CORS proxy fallback
  const artImages = await Promise.all(top3.map(function(r) {
    return new Promise(function(resolve) {
      if (!r.albums.image_url) { resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function() { resolve(img); };
      img.onerror = function() { resolve(null); };
      // Add cache-busting to help with CORS
      img.src = r.albums.image_url + (r.albums.image_url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
    });
  }));

  document.getElementById('week-loading').classList.add('hidden');

  drawWeekCard({
    startDate, endDate, top3, artImages,
    totalMinutes, ratingBuckets, topStarred,
    totalRated: weekRatings.length
  });

  document.getElementById('week-output').classList.remove('hidden');
}

function drawWeekCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  // ── Background ──
  ctx.fillStyle = '#0e0e0b';
  ctx.fillRect(0, 0, CW, CH);

  // Radial glow top-left
  const g1 = ctx.createRadialGradient(180, 300, 0, 180, 300, 700);
  g1.addColorStop(0, 'rgba(29,185,84,0.07)');
  g1.addColorStop(1, 'transparent');
  ctx.fillStyle = g1; ctx.fillRect(0, 0, CW, CH);

  // Radial glow bottom-right
  const g2 = ctx.createRadialGradient(900, 1700, 0, 900, 1700, 600);
  g2.addColorStop(0, 'rgba(232,160,48,0.04)');
  g2.addColorStop(1, 'transparent');
  ctx.fillStyle = g2; ctx.fillRect(0, 0, CW, CH);

  // MCM starburst top-right
  drawStarburst(ctx, CW - 60, 60, 110, 20, 'rgba(29,185,84,0.065)');

  // MCM atomic dots bottom-left
  drawAtomicDots(ctx, 72, CH - 100, 'rgba(29,185,84,0.12)');

  // MCM boomerang arc left side
  ctx.save();
  ctx.strokeStyle = 'rgba(29,185,84,0.04)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(30, 900);
  ctx.quadraticCurveTo(160, 700, 30, 500);
  ctx.stroke();
  ctx.restore();

  // ── Top green bar ──
  ctx.fillStyle = '#1DB954';
  ctx.fillRect(0, LAYOUT.topBar.y, CW, LAYOUT.topBar.h);

  // ── Logo row ──
  const logoY = LAYOUT.logo.y;
  // Waveform bars
  const wBars = [8, 18, 28, 36, 28, 18, 8];
  const wBarW = 10, wGap = 6, wX = PAD, wMidY = logoY + 65;
  wBars.forEach(function(h, i) {
    ctx.fillStyle = '#1DB954';
    ctx.beginPath();
    ctx.roundRect(wX + i*(wBarW+wGap), wMidY - h/2, wBarW, h, 4);
    ctx.fill();
  });
  // "YOUR PERSONAL" label
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '300 24px "DM Sans", sans-serif';
  ctx.fillText('YOUR PERSONAL', PAD + 110, logoY + 50);
  // "Album Rater" serif
  ctx.fillStyle = '#f0efe8';
  ctx.font = 'italic 56px "DM Serif Display", serif';
  ctx.fillText('Album ', PAD + 110, logoY + 108);
  const alW = ctx.measureText('Album ').width;
  ctx.fillStyle = '#1DB954';
  ctx.font = '56px "DM Serif Display", serif';
  ctx.fillText('Rater', PAD + 110 + alW, logoY + 108);
  // Green accent circle
  ctx.fillStyle = '#1DB954';
  ctx.beginPath();
  ctx.arc(CW - PAD, logoY + 65, 10, 0, Math.PI * 2);
  ctx.fill();

  // ── Divider 1 ──
  drawMCMDivider(ctx, PAD, LAYOUT.divider1.y, CW - PAD*2);

  // ── Date row ──
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const s = d.startDate;
  const e = new Date(d.endDate); e.setDate(e.getDate() - 1);
  const dateStr = ('WEEK OF ' + months[s.getMonth()].toUpperCase() + ' ' + s.getDate() +
    ' – ' + months[e.getMonth()].toUpperCase() + ' ' + e.getDate() + ', ' + e.getFullYear()).toUpperCase();
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '600 26px "DM Sans", sans-serif';
  ctx.fillText(dateStr, PAD, LAYOUT.dateRow.y + 40);

  // ── Divider 2 ──
  drawMCMDivider(ctx, PAD, LAYOUT.divider2.y, CW - PAD*2);

  // ── Stats row — 4 evenly spaced blocks ──
  const statSlotW = (CW - PAD*2) / 4;
  const statData = [
    { val: String(d.totalRated), label: 'RATED' },
    { val: d.totalMinutes > 0 ? Math.round(d.totalMinutes) + 'm' : '—', label: 'MINUTES' },
    { val: d.top3.length > 0 ? (d.top3.reduce(function(s,r){return s+r.rating;},0)/d.top3.length).toFixed(1) : '—', label: 'AVG SCORE' },
    { val: String(d.topStarred.length), label: 'STARRED' }
  ];
  statData.forEach(function(stat, i) {
    const sx = PAD + i * statSlotW;
    const sy = LAYOUT.statsRow.y;
    ctx.fillStyle = '#1DB954';
    ctx.font = 'italic 700 62px "DM Serif Display", serif';
    ctx.fillText(stat.val, sx, sy + 72);
    ctx.fillStyle = '#5a5a4a';
    ctx.font = '600 20px "DM Sans", sans-serif';
    ctx.fillText(stat.label, sx, sy + 102);
  });

  // ── Divider 3 ──
  drawMCMDivider(ctx, PAD, LAYOUT.divider3.y, CW - PAD*2);

  // ── Top Albums label ──
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '700 22px "DM Sans", sans-serif';
  ctx.fillText('TOP ALBUMS THIS WEEK', PAD, LAYOUT.albumsLabel.y + 34);

  // ── Album cards ── 3 cards side by side with strict height
  const numCards = 3;
  const cardGap = 20;
  const cardW = Math.floor((CW - PAD*2 - cardGap*(numCards-1)) / numCards);
  const cardH = LAYOUT.albumsRow.h;
  const artSize = cardW - 24;
  const rankColors = ['#1DB954', '#9e9d8e', '#e8a030'];

  for (let i = 0; i < numCards; i++) {
    const cx = PAD + i * (cardW + cardGap);
    const cy = LAYOUT.albumsRow.y;
    const r = d.top3[i];

    // Card bg
    ctx.fillStyle = '#1a1a15';
    ctx.strokeStyle = '#2e2e24';
    ctx.lineWidth = 1;
    roundRect(ctx, cx, cy, cardW, cardH, 8);
    ctx.fill(); ctx.stroke();

    // Top accent stripe
    ctx.fillStyle = rankColors[i];
    ctx.fillRect(cx, cy, cardW, 4);

    if (r) {
      // Album art — fixed square
      const artY = cy + 16;
      if (d.artImages[i]) {
        ctx.save();
        roundRect(ctx, cx + 12, artY, artSize, artSize, 6);
        ctx.clip();
        ctx.drawImage(d.artImages[i], cx + 12, artY, artSize, artSize);
        ctx.restore();
      } else {
        // Placeholder
        ctx.fillStyle = '#222219';
        roundRect(ctx, cx + 12, artY, artSize, artSize, 6);
        ctx.fill();
        ctx.fillStyle = '#3a3a2e';
        ctx.font = '32px "DM Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('♪', cx + 12 + artSize/2, artY + artSize/2 + 12);
        ctx.textAlign = 'left';
      }

      // Rank badge — top-left of art
      ctx.fillStyle = rankColors[i];
      roundRect(ctx, cx + 12, artY, 44, 30, 3);
      ctx.fill();
      ctx.fillStyle = i === 0 ? '#000' : '#0e0e0b';
      ctx.font = '700 18px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('#'+(i+1), cx + 34, artY + 21);
      ctx.textAlign = 'left';

      // Text area below art — strictly bounded
      const textX = cx + 12;
      const textMaxW = cardW - 24;
      const textBaseY = artY + artSize + 20;

      // Album name — truncated
      ctx.fillStyle = '#f0efe8';
      ctx.font = '700 24px "DM Sans", sans-serif';
      ctx.fillText(fitText(ctx, r.albums.name, textMaxW), textX, textBaseY);

      // Artist — truncated
      ctx.fillStyle = '#5a5a4a';
      ctx.font = '400 20px "DM Sans", sans-serif';
      ctx.fillText(fitText(ctx, r.albums.artist, textMaxW), textX, textBaseY + 28);

      // Rating
      ctx.fillStyle = rankColors[i];
      ctx.font = 'italic 700 42px "DM Serif Display", serif';
      const ratingStr = String(r.rating);
      ctx.fillText(ratingStr, textX, textBaseY + 76);
      const ratingW = ctx.measureText(ratingStr).width;
      ctx.fillStyle = '#3a3a2e';
      ctx.font = '400 20px "DM Sans", sans-serif';
      ctx.fillText('/ 10', textX + ratingW + 6, textBaseY + 70);
    } else {
      // Empty slot
      ctx.fillStyle = '#2e2e24';
      ctx.font = 'italic 28px "DM Serif Display", serif';
      ctx.textAlign = 'center';
      ctx.fillText('—', cx + cardW/2, cy + cardH/2);
      ctx.textAlign = 'left';
    }
  }

  // ── Divider 4 ──
  drawMCMDivider(ctx, PAD, LAYOUT.divider4.y, CW - PAD*2);

  // ── Rating Distribution label ──
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '700 22px "DM Sans", sans-serif';
  ctx.fillText('RATING DISTRIBUTION', PAD, LAYOUT.distLabel.y + 34);

  // ── Distribution bars — 4 rows, each strictly 58px tall ──
  const distKeys   = ['9-10', '7-8', '5-6', '1-4'];
  const distLabels = ['9–10', '7–8', '5–6', '1–4'];
  const distColors = ['#1fef6a', '#1DB954', '#0f7731', '#032a10'];
  const distBarH   = 52;
  const distGap    = 8;
  const distLabelW = 70;
  const distCountW = 50;
  const distBarAreaW = CW - PAD*2 - distLabelW - distCountW - 16;
  const total = d.totalRated || 1;

  distKeys.forEach(function(key, i) {
    const count = d.ratingBuckets[key] || 0;
    const pct = count / total;
    const ry = LAYOUT.distRow.y + i * (distBarH + distGap);

    // Label
    ctx.fillStyle = '#9e9d8e';
    ctx.font = '600 22px "DM Sans", sans-serif';
    ctx.fillText(distLabels[i], PAD, ry + distBarH * 0.68);

    // Bar bg
    ctx.fillStyle = '#1a1a15';
    roundRect(ctx, PAD + distLabelW, ry, distBarAreaW, distBarH, 4);
    ctx.fill();

    // Bar fill
    if (pct > 0) {
      ctx.fillStyle = distColors[i];
      roundRect(ctx, PAD + distLabelW, ry, Math.max(distBarAreaW * pct, 10), distBarH, 4);
      ctx.fill();
    }

    // Count
    ctx.fillStyle = count > 0 ? '#f0efe8' : '#3a3a2e';
    ctx.font = '700 22px "DM Sans", sans-serif';
    ctx.fillText(String(count), PAD + distLabelW + distBarAreaW + 12, ry + distBarH * 0.68);
  });

  // ── Divider 5 ──
  drawMCMDivider(ctx, PAD, LAYOUT.divider5.y, CW - PAD*2);

  // ── Starred Songs label ──
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '700 22px "DM Sans", sans-serif';
  ctx.fillText('STARRED SONGS', PAD, LAYOUT.songsLabel.y + 34);

  // ── Song rows — max 6 rows, each strictly 80px tall ──
  const songRowH = 82;
  const maxSongs = Math.min(d.topStarred.length, 6);
  const songMaxNameW = CW - PAD*2 - 52; // star + gap
  const songMaxMetaW = CW - PAD*2 - 52;

  if (maxSongs === 0) {
    ctx.fillStyle = '#3a3a2e';
    ctx.font = 'italic 28px "DM Serif Display", serif';
    ctx.fillText('No starred songs this week', PAD, LAYOUT.songsRow.y + 50);
  } else {
    for (let i = 0; i < maxSongs; i++) {
      const s = d.topStarred[i];
      const sy = LAYOUT.songsRow.y + i * songRowH;

      // Alternating row bg
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(29,185,84,0.04)';
        roundRect(ctx, PAD - 8, sy + 2, CW - PAD*2 + 16, songRowH - 4, 4);
        ctx.fill();
      }

      // Star
      ctx.fillStyle = '#1DB954';
      ctx.font = '700 28px "DM Sans", sans-serif';
      ctx.fillText('★', PAD, sy + 36);

      // Song name — strictly truncated
      ctx.fillStyle = '#f0efe8';
      ctx.font = '600 28px "DM Sans", sans-serif';
      ctx.fillText(fitText(ctx, s.song, songMaxNameW), PAD + 44, sy + 36);

      // Artist · Album — strictly truncated
      ctx.fillStyle = '#5a5a4a';
      ctx.font = '400 22px "DM Sans", sans-serif';
      const meta = s.artist + ' · ' + s.album;
      ctx.fillText(fitText(ctx, meta, songMaxMetaW), PAD + 44, sy + 64);
    }
  }

  // ── Bottom bar ──
  ctx.fillStyle = '#1DB954';
  ctx.fillRect(0, LAYOUT.bottomBar.y, CW, LAYOUT.bottomBar.h);

  // ── Footer URL ──
  ctx.fillStyle = '#2e2e24';
  ctx.font = '400 22px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater · sillymcwilly1.github.io/2026-Albums', CW/2, LAYOUT.bottomBar.y - 14);
  ctx.textAlign = 'left';
}

// ---- Download as photo (works on iOS Safari via share sheet) ----
function downloadWeekCard() {
  const canvas = document.getElementById('weekCanvas');
  canvas.toBlob(function(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'week-in-review.png';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }, 'image/png');
}

// ---- Expose to global scope ----
window.showPage = showPage;
window.searchAlbums = searchAlbums;
window.openAlbum = openAlbum;
window.toggleTrack = toggleTrack;
window.closeModal = closeModal;
window.saveRating = saveRating;
window.generateWeekReview = generateWeekReview;
window.downloadWeekCard = downloadWeekCard;

// ---- Init ----
window.addEventListener('load', async function() {
  initSupabase();
  const params = new URLSearchParams(window.location.search);
  if (params.get('code')) {
    await handleSpotifyCallback();
  } else {
    const token = localStorage.getItem('spotify_token');
    if (token) spotifyToken = token;
  }
  document.getElementById('search-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchAlbums();
  });
  loadRecentlyPlayed();
});
