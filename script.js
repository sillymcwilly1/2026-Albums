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
      '&response_type=code&redirect_uri=' + redirectUri +
      '&scope=' + scopes +
      '&code_challenge_method=S256&code_challenge=' + codeChallenge;
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
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: SPOTIFY_CLIENT_ID, code_verifier: codeVerifier
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
  if (tokenData.refresh_token) localStorage.setItem('spotify_refresh_token', tokenData.refresh_token);
}

async function refreshSpotifyToken() {
  const refreshToken = localStorage.getItem('spotify_refresh_token');
  if (!refreshToken) { loginSpotify(); return false; }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: SPOTIFY_CLIENT_ID
    })
  });
  const tokenData = await response.json();
  if (tokenData.access_token) { saveTokens(tokenData); return true; }
  loginSpotify(); return false;
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
  if (lastLogged) {
    const lastDate = new Date(lastLogged.replace('T', ' ') + ':00:00');
    const hoursSince = (now - lastDate) / (1000 * 60 * 60);
    if (hoursSince > 2) localStorage.removeItem('last_log_hour');
  }
  if (localStorage.getItem('last_log_hour') === hourKey) return;
  localStorage.setItem('last_log_hour', hourKey);
  const albumMap = {};
  items.forEach(function(item) {
    const album = item.track.album;
    const duration = item.track.duration_ms || 0;
    if (!albumMap[album.id]) {
      albumMap[album.id] = {
        spotify_album_id: album.id, album_name: album.name,
        artist: album.artists && album.artists[0] ? album.artists[0].name : '',
        image_url: album.images && album.images[0] ? album.images[0].url : '',
        duration_ms: 0, logged_at: new Date().toISOString()
      };
    }
    albumMap[album.id].duration_ms += duration;
  });
  const toLog = Object.values(albumMap);
  if (toLog.length > 0) {
    const { error } = await db.from('play_logs').insert(toLog);
    if (error) console.error('Play log insert failed:', error);
  }
}

// ---- Replay Tracker ----
async function loadReplayTracker() {
  let allLogs = [], page = 0;
  while (true) {
    const { data, error } = await db.from('play_logs').select('*')
      .order('logged_at', { ascending: true })
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error || !data || data.length === 0) break;
    allLogs = allLogs.concat(data);
    if (data.length < 1000) break;
    page++;
  }
  if (allLogs.length === 0) {
    document.getElementById('replayBarChart').closest('.chart-card').innerHTML +=
      '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:16px;font-style:italic">No play data yet — open the app a few times to start building your history.</p>';
    return;
  }
  renderReplayBar(allLogs);
  renderReplayLine(allLogs);
}

function renderReplayBar(logs) {
  const minuteMap = {};
  logs.forEach(function(log) {
    const mins = log.duration_ms ? Math.round(log.duration_ms / 60000) : 0;
    minuteMap[log.album_name] = (minuteMap[log.album_name] || 0) + mins;
  });
  const sorted = Object.entries(minuteMap).filter(function(e) { return e[1] > 0; })
    .sort(function(a,b) { return b[1]-a[1]; }).slice(0,12);
  if (sorted.length === 0) return;
  const labels = sorted.map(function(e) { return e[0].length > 16 ? e[0].substring(0,16)+'…' : e[0]; });
  const values = sorted.map(function(e) { return e[1]; });
  if (replayBarInstance) replayBarInstance.destroy();
  const ctx = document.getElementById('replayBarChart').getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, '#1DB954'); gradient.addColorStop(1, '#0a4d22');
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
      tension: 0.4, fill: false, pointRadius: 2, pointHoverRadius: 6, borderWidth: 2
    };
  });
  if (replayLineInstance) replayLineInstance.destroy();
  const ctx = document.getElementById('replayLineChart').getContext('2d');
  replayLineInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: dates, datasets },
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
        x: {
          ticks: {
            color: '#5a5a4a', font: { size: 10, family: 'DM Sans' }, maxRotation: 0, autoSkip: false,
            callback: function(val, index) {
              const date = dates[index];
              if (!date) return '';
              const d = new Date(date + 'T00:00:00');
              if (index === 0 || d.getDay() === 1) return (d.getMonth()+1) + '/' + d.getDate();
              return '';
            }
          },
          grid: { color: '#2e2e24' }
        },
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
  if (res.status === 401) { const r = await refreshSpotifyToken(); if (!r) { loginSpotify(); return; } return searchAlbums(); }
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
    return '<div class="album-card" onclick="openAlbum(\''+album.id+'\')"><img src="'+img+'" alt="'+album.name+'" /><div class="album-card-info"><h3>'+album.name+'</h3><p>'+artist+'</p>'+badge+'</div></div>';
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
  currentAlbum = album; currentTracks = tracksData.items; selectedTracks = []; existingRating = null;
  const { data: existing } = await db.from('albums').select('id, ratings(*)').eq('spotify_id', spotifyId).single();
  let ratingVal = '', commentVal = '';
  if (existing && existing.ratings && existing.ratings.length > 0) {
    existingRating = existing.ratings[0];
    ratingVal = existingRating.rating; commentVal = existingRating.comments || '';
    selectedTracks = existingRating.top_songs || [];
  }
  const tracksHTML = currentTracks.map(function(t, i) {
    const isSelected = selectedTracks.includes(t.name);
    const safeName = t.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<div class="track-item '+(isSelected?'selected':'')+'" onclick="toggleTrack(\''+safeName+'\', this)"><span class="track-check">'+(isSelected?'★':'☆')+'</span><span>'+(i+1)+'. '+t.name+'</span></div>';
  }).join('');
  const year = album.release_date ? album.release_date.split('-')[0] : '';
  const artistName = album.artists && album.artists[0] ? album.artists[0].name : '';
  document.getElementById('modal-body').innerHTML =
    '<div class="modal-album-header"><img src="'+(album.images&&album.images[0]?album.images[0].url:'')+'" alt="'+album.name+'" /><div><h2>'+album.name+'</h2><p>'+artistName+'</p><p style="color:var(--text-muted);font-size:0.76rem;margin-top:4px">'+year+'</p></div></div>'+
    '<label>Rating (0–10)</label><input type="number" id="rating-input" min="0" max="10" step="0.1" value="'+ratingVal+'" placeholder="e.g. 8.5" />'+
    '<label>Comments</label><textarea id="comment-input" placeholder="Write your thoughts…">'+commentVal+'</textarea>'+
    '<label>Top Songs</label><div class="tracks-list">'+tracksHTML+'</div>'+
    '<button class="save-btn" onclick="saveRating(\''+spotifyId+'\')">Save Rating</button>';
  document.getElementById('modal').classList.remove('hidden');
}

function toggleTrack(name, el) {
  if (selectedTracks.includes(name)) {
    selectedTracks = selectedTracks.filter(function(t) { return t !== name; });
    el.classList.remove('selected'); el.querySelector('.track-check').textContent = '☆';
  } else {
    selectedTracks.push(name); el.classList.add('selected'); el.querySelector('.track-check').textContent = '★';
  }
}

function closeModal() { document.getElementById('modal').classList.add('hidden'); }

// ---- Save Rating ----
async function saveRating(spotifyId) {
  const rating = parseFloat(document.getElementById('rating-input').value);
  const comments = document.getElementById('comment-input').value;
  if (isNaN(rating) || rating < 0 || rating > 10) { alert('Please enter a rating between 0 and 10'); return; }
  const { data: albumRow } = await db.from('albums').upsert({
    spotify_id: spotifyId, name: currentAlbum.name,
    artist: currentAlbum.artists[0] ? currentAlbum.artists[0].name : '',
    image_url: currentAlbum.images && currentAlbum.images[0] ? currentAlbum.images[0].url : '',
    release_year: currentAlbum.release_date ? currentAlbum.release_date.split('-')[0] : ''
  }, { onConflict: 'spotify_id' }).select().single();
  if (existingRating) {
    await db.from('ratings').update({ rating, comments, top_songs: selectedTracks, updated_at: new Date().toISOString() }).eq('id', existingRating.id);
  } else {
    await db.from('ratings').insert({ album_id: albumRow.id, rating, comments, top_songs: selectedTracks });
  }
  closeModal(); alert('Rating saved! ✅');
}

// ---- Bar Chart ----
function renderBarChart(data) {
  const sorted = [...data].sort(function(a,b) { return b.rating-a.rating; });
  function ratingToColor(v) {
    if (v >= 9.5) return '#1fef6a'; if (v >= 9) return '#1DB954'; if (v >= 8) return '#19a348';
    if (v >= 7) return '#148d3c'; if (v >= 6) return '#0f7731'; if (v >= 5) return '#0b6128';
    if (v >= 4) return '#074b1e'; if (v >= 3) return '#053a17'; if (v >= 2) return '#032a10';
    return '#021a0a';
  }
  const labels = sorted.map(function(r) { const n=r.albums.name; return n.length>16?n.substring(0,16)+'…':n; });
  const values = sorted.map(function(r) { return r.rating; });
  if (barChartInstance) barChartInstance.destroy();
  const ctx = document.getElementById('barChart').getContext('2d');
  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: values.map(ratingToColor), borderColor: values.map(function(v){return v>=7?'rgba(29,185,84,0.4)':'rgba(29,185,84,0.1)';}), borderWidth: 1, borderRadius: 3, borderSkipped: false }] },
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
  if (!data || data.length === 0) { container.innerHTML = '<div class="empty-state">Nothing rated yet.<br>Head to Search to get started.</div>'; return; }
  renderBarChart(data);
  container.innerHTML = data.map(function(r, i) {
    const rankClass = i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'';
    const topSongs = r.top_songs&&r.top_songs.length>0?'<p style="color:var(--green);font-size:0.72rem;margin-top:5px">★ '+r.top_songs.slice(0,3).join(' · ')+'</p>':'';
    const comment = r.comments?'<p style="color:var(--text-muted);font-size:0.72rem;margin-top:3px;font-style:italic">"'+r.comments.substring(0,70)+(r.comments.length>70?'…':'')+'"</p>':'';
    return '<div class="rankings-item '+rankClass+'" onclick="openAlbum(\''+r.albums.spotify_id+'\')"><div class="rank-num">'+(i+1)+'</div><img src="'+r.albums.image_url+'" alt="'+r.albums.name+'" /><div class="rankings-item-info"><h3>'+r.albums.name+'</h3><p>'+r.albums.artist+' &nbsp;·&nbsp; '+(r.albums.release_year||'')+'</p>'+topSongs+comment+'</div><div class="big-rating">'+r.rating+'</div></div>';
  }).join('');
}

// ================================================================
// WEEK IN REVIEW CARD — 1080×1920 (9:16)
//
// Color palette is sampled from the top 3 album art images and
// used to tint backgrounds, borders, and accents throughout.
//
// Zone map:
//   0    – 130   MCM header
//   130  – 270   Title + date
//   270  – 410   Stats
//   410  – 660   Top 3 albums
//   660  – 940   Play timeline
//   940  – 1730  Starred songs (floating pill tiles)
//   1730 – 1920  MCM footer
// ================================================================

const CW = 1080, CH = 1920, PAD = 64;
const Z = {
  headerEnd: 130, titleEnd: 270, statsEnd: 410,
  albumsEnd: 660, chartEnd: 940,
  songsStart: 955, songsEnd: 1730, footerStart: 1730
};

// ---- Color Sampling ----
// Samples N random pixels from a canvas-drawn image and returns
// the average as [r, g, b]. Falls back to Spotify green if no image.
function sampleImageColor(img, sampleCount) {
  if (!img) return [29, 185, 84];
  try {
    const size = 40;
    const offscreen = document.createElement('canvas');
    offscreen.width = size; offscreen.height = size;
    const oc = offscreen.getContext('2d');
    oc.drawImage(img, 0, 0, size, size);
    const pixels = oc.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, count = 0;
    const step = Math.max(1, Math.floor((size * size) / sampleCount)) * 4;
    for (let i = 0; i < pixels.length; i += step) {
      r += pixels[i]; g += pixels[i+1]; b += pixels[i+2]; count++;
    }
    return [Math.round(r/count), Math.round(g/count), Math.round(b/count)];
  } catch(e) {
    return [29, 185, 84];
  }
}

// Blend multiple [r,g,b] colors together with equal weight
function blendColors(colorArr) {
  if (!colorArr || colorArr.length === 0) return [29, 185, 84];
  const r = Math.round(colorArr.reduce(function(s,c){return s+c[0];},0) / colorArr.length);
  const g = Math.round(colorArr.reduce(function(s,c){return s+c[1];},0) / colorArr.length);
  const b = Math.round(colorArr.reduce(function(s,c){return s+c[2];},0) / colorArr.length);
  return [r, g, b];
}

// Lighten a color toward white by t (0=original, 1=white)
function lighten(rgb, t) {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * t),
    Math.round(rgb[1] + (255 - rgb[1]) * t),
    Math.round(rgb[2] + (255 - rgb[2]) * t)
  ];
}

function toRgb(rgb, alpha) {
  if (alpha !== undefined) return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';
  return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
}

// ---- Canvas Helpers ----
function fit(ctx, text, maxW) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    ctx.measureText(text.substring(0, mid) + '…').width <= maxW ? (lo = mid) : (hi = mid);
  }
  return text.substring(0, lo) + '…';
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
}

function starburst(ctx, cx, cy, outerR, rays, color) {
  ctx.save(); ctx.fillStyle = color;
  const innerR = outerR * 0.38;
  for (let i = 0; i < rays; i++) {
    const a1 = (i/rays)*Math.PI*2, a2 = a1+Math.PI/rays, a3 = a1+(Math.PI*2)/rays;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a1)*outerR, cy+Math.sin(a1)*outerR);
    ctx.lineTo(cx+Math.cos(a2)*innerR, cy+Math.sin(a2)*innerR);
    ctx.lineTo(cx+Math.cos(a3)*outerR, cy+Math.sin(a3)*outerR);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function dotgrid(ctx, x, y, cols, rows, gap, r, color) {
  ctx.fillStyle = color;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ctx.beginPath(); ctx.arc(x+col*gap, y+row*gap, r, 0, Math.PI*2); ctx.fill();
    }
  }
}

function rule(ctx, x, y, w, color) {
  ctx.save();
  const cx = x + w/2;
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx-24, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx+24, y); ctx.lineTo(x+w, y); ctx.stroke();
  ctx.globalAlpha = 1;
  [-14, 0, 14].forEach(function(dx, i) {
    ctx.fillStyle = i===1 ? color : color;
    ctx.globalAlpha = i===1 ? 0.9 : 0.3;
    ctx.beginPath(); ctx.arc(cx+dx, y, i===1?4:2.5, 0, Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha = 1; ctx.restore();
}

function miniLineChart(ctx, x, y, w, h, byDate, albums, colors) {
  const dates = Object.keys(byDate).sort();
  if (dates.length < 2) {
    ctx.fillStyle = '#3a3a2e'; ctx.font = 'italic 24px Georgia, serif'; ctx.textAlign = 'center';
    ctx.fillText('Not enough data yet', x+w/2, y+h/2); ctx.textAlign = 'left'; return;
  }
  let maxVal = 0;
  dates.forEach(function(d) { albums.forEach(function(a) { maxVal = Math.max(maxVal, (byDate[d]&&byDate[d][a])||0); }); });
  if (maxVal === 0) maxVal = 1;
  const pL=52, pR=20, pT=12, pB=30, cw=w-pL-pR, ch=h-pT-pB;
  ctx.strokeStyle = '#2a2a1e'; ctx.lineWidth = 1;
  [0,0.5,1].forEach(function(pct) {
    const gy = y+pT+ch*(1-pct);
    ctx.beginPath(); ctx.moveTo(x+pL,gy); ctx.lineTo(x+pL+cw,gy); ctx.stroke();
    if (pct > 0) {
      ctx.fillStyle = '#3a3a2e'; ctx.font = '20px "DM Sans",sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal*pct)+'m', x+pL-6, gy+7); ctx.textAlign = 'left';
    }
  });
  ctx.fillStyle = '#3a3a2e'; ctx.font = '18px "DM Sans",sans-serif'; ctx.textAlign = 'center';
  dates.forEach(function(d, i) {
    const dt = new Date(d+'T00:00:00');
    if (i===0 || dt.getDay()===1) {
      const px = x+pL+(i/Math.max(dates.length-1,1))*cw;
      ctx.fillText((dt.getMonth()+1)+'/'+dt.getDate(), px, y+pT+ch+pB-4);
    }
  });
  ctx.textAlign = 'left';
  albums.forEach(function(album, ai) {
    const pts = dates.map(function(d, i) {
      return { px: x+pL+(i/Math.max(dates.length-1,1))*cw, py: y+pT+ch*(1-((byDate[d]&&byDate[d][album])||0)/maxVal) };
    });
    ctx.beginPath(); ctx.moveTo(pts[0].px, y+pT+ch);
    pts.forEach(function(p) { ctx.lineTo(p.px, p.py); });
    ctx.lineTo(pts[pts.length-1].px, y+pT+ch); ctx.closePath();
    ctx.fillStyle = colors[ai]+'15'; ctx.fill();
    ctx.beginPath(); ctx.strokeStyle = colors[ai]; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    ctx.moveTo(pts[0].px, pts[0].py);
    for (let i = 1; i < pts.length; i++) {
      const cpx = (pts[i-1].px+pts[i].px)/2;
      ctx.bezierCurveTo(cpx, pts[i-1].py, cpx, pts[i].py, pts[i].px, pts[i].py);
    }
    ctx.stroke();
    pts.forEach(function(p) {
      ctx.beginPath(); ctx.arc(p.px, p.py, 3.5, 0, Math.PI*2); ctx.fillStyle = colors[ai]; ctx.fill();
    });
  });
  let ly = y+pT+4;
  albums.forEach(function(album, ai) {
    const lx = x+pL+cw-10;
    ctx.fillStyle = colors[ai]; ctx.fillRect(lx-218, ly+1, 14, 3);
    ctx.font = '17px "DM Sans",sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, album, 200), lx-198, ly+11); ly += 24;
  });
}

// ---- Data Fetching ----
async function generateWeekReview() {
  const endDate = new Date();
  const startDate = new Date(); startDate.setDate(endDate.getDate()-7);
  document.getElementById('week-loading').classList.remove('hidden');
  document.getElementById('week-output').classList.add('hidden');
  document.getElementById('week-empty').classList.add('hidden');

  const { data: rU } = await db.from('ratings').select('*, albums(*)')
    .gte('updated_at', startDate.toISOString()).lt('updated_at', endDate.toISOString());
  const { data: rC } = await db.from('ratings').select('*, albums(*)')
    .gte('created_at', startDate.toISOString()).lt('created_at', endDate.toISOString());
  const rmap = {};
  [...(rU||[]),...(rC||[])].forEach(function(r) { rmap[r.id] = r; });
  const weekRatings = Object.values(rmap).sort(function(a,b) { return b.rating-a.rating; });

  const { data: playLogs } = await db.from('play_logs').select('*')
    .gte('logged_at', startDate.toISOString()).lt('logged_at', endDate.toISOString());

  if (!weekRatings.length && (!playLogs||!playLogs.length)) {
    document.getElementById('week-loading').classList.add('hidden');
    document.getElementById('week-empty').classList.remove('hidden'); return;
  }

  const totalMins = (playLogs||[]).reduce(function(s,l) { return s+(l.duration_ms?Math.round(l.duration_ms/60000):0); }, 0);
  const albumMins = {};
  (playLogs||[]).forEach(function(l) {
    const m = l.duration_ms?Math.round(l.duration_ms/60000):0;
    if (m > 0) albumMins[l.album_name] = (albumMins[l.album_name]||0)+m;
  });
  const byDate = {};
  (playLogs||[]).forEach(function(l) {
    const date = l.logged_at.substring(0,10);
    const m = l.duration_ms?Math.round(l.duration_ms/60000):0;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][l.album_name] = (byDate[date][l.album_name]||0)+m;
  });
  const top5forChart = Object.entries(albumMins).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});
  const lineColors = ['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];

  const starredSongs = [];
  weekRatings.slice(0,5).forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.forEach(function(song) {
        if (starredSongs.length < 8) {
          starredSongs.push({ song, album: r.albums.name, artist: r.albums.artist, mins: albumMins[r.albums.name]||0 });
        }
      });
    }
  });

  const top3 = weekRatings.slice(0,3);
  const avgScore = top3.length ? (top3.reduce(function(s,r){return s+r.rating;},0)/top3.length).toFixed(1) : '—';
  const totalStarred = weekRatings.reduce(function(s,r){return s+(r.top_songs?r.top_songs.length:0);},0);

  // Load album art images
  const artImages = await Promise.all(top3.map(function(r) {
    return new Promise(function(resolve) {
      if (!r.albums.image_url) { resolve(null); return; }
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function() { resolve(img); };
      img.onerror = function() { resolve(null); };
      img.src = r.albums.image_url;
    });
  }));

  // Sample colors from each art image and blend into a palette
  const sampledColors = artImages.map(function(img) { return sampleImageColor(img, 200); });
  const blended = blendColors(sampledColors.filter(function(c) { return c !== null; }));
  // Per-album accent colors — each slightly different hue from their own art
  const accentColors = sampledColors.map(function(c) {
    // Ensure minimum brightness so colors don't go too dark
    const bright = Math.max(c[0], c[1], c[2]);
    if (bright < 60) return lighten(c, 0.4);
    return c;
  });

  document.getElementById('week-loading').classList.add('hidden');
  drawCard({
    startDate, endDate, top3, artImages, totalMins, avgScore,
    totalRated: weekRatings.length, totalStarred, starredSongs,
    byDate, top5forChart, lineColors,
    blended, accentColors
  });
  document.getElementById('week-output').classList.remove('hidden');
}

function drawCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  const accent = d.blended;           // blended color from all 3 albums
  const accentStr = toRgb(accent);
  const accentDim = toRgb(accent, 0.12);
  const accentMid = toRgb(accent, 0.35);
  const accentLine = toRgb(lighten(accent, 0.3), 0.5);

  // ── Background — warm dark tinted with album palette ──
  ctx.fillStyle = '#0e0e0b'; ctx.fillRect(0, 0, CW, CH);

  // Album color radial glow — top right
  const g1 = ctx.createRadialGradient(CW, 0, 0, CW, 0, 900);
  g1.addColorStop(0, toRgb(accent, 0.12)); g1.addColorStop(1, 'transparent');
  ctx.fillStyle = g1; ctx.fillRect(0, 0, CW, CH);

  // Secondary glow — bottom left
  const g2 = ctx.createRadialGradient(0, CH, 0, 0, CH, 700);
  g2.addColorStop(0, toRgb(lighten(accent, 0.2), 0.08)); g2.addColorStop(1, 'transparent');
  ctx.fillStyle = g2; ctx.fillRect(0, 0, CW, CH);

  // ── ZONE 1: MCM Header ──
  ctx.fillStyle = '#06060400'; ctx.fillRect(0, 0, CW, Z.headerEnd);
  // Tinted header overlay using album color
  const headerGrad = ctx.createLinearGradient(0, 0, CW, Z.headerEnd);
  headerGrad.addColorStop(0, toRgb(accent, 0.15));
  headerGrad.addColorStop(1, 'rgba(6,6,4,0.95)');
  ctx.fillStyle = headerGrad; ctx.fillRect(0, 0, CW, Z.headerEnd);

  // Top edge — album color
  ctx.fillStyle = accentStr; ctx.fillRect(0, 0, CW, 5);

  // Starburst — top right, album tinted
  starburst(ctx, CW-70, 65, 120, 22, toRgb(accent, 0.13));

  // Dot grid — top left
  dotgrid(ctx, PAD, 24, 5, 3, 20, 2.5, toRgb(accent, 0.2));

  // MCM arc
  ctx.save(); ctx.strokeStyle = toRgb(accent, 0.09); ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(300, 0); ctx.quadraticCurveTo(500, 65, 300, Z.headerEnd);
  ctx.stroke(); ctx.restore();

  rule(ctx, PAD, Z.headerEnd-1, CW-PAD*2, accentStr);

  // ── ZONE 2: Title + Date ──
  const titleY = Z.headerEnd + 20;

  // Waveform — colored from album palette
  const wh = [7,16,26,34,26,16,7], wbw = 9, wgap = 5;
  const wTotalW = wh.length*(wbw+wgap)-wgap;
  const wMidY = titleY + 40;
  wh.forEach(function(h, i) {
    const t = h / 34;
    const barColor = toRgb([
      Math.round(accent[0]*t + 40*(1-t)),
      Math.round(accent[1]*t + 40*(1-t)),
      Math.round(accent[2]*t + 40*(1-t))
    ]);
    ctx.fillStyle = barColor;
    ctx.beginPath(); ctx.roundRect(PAD+i*(wbw+wgap), wMidY-h/2, wbw, h, 3); ctx.fill();
  });

  const titleX = PAD + wTotalW + 18;
  ctx.fillStyle = toRgb(accent, 0.5); ctx.font = '300 20px "DM Sans",sans-serif';
  ctx.fillText('YOUR PERSONAL', titleX, titleY+22);
  ctx.fillStyle = '#f0efe8'; ctx.font = 'italic 48px Georgia,serif';
  ctx.fillText('Album ', titleX, titleY+68);
  const aw = ctx.measureText('Album ').width;
  ctx.fillStyle = accentStr; ctx.font = '48px Georgia,serif';
  ctx.fillText('Rater', titleX+aw, titleY+68);

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const s = d.startDate, e = new Date(d.endDate); e.setDate(e.getDate()-1);
  const dateStr = months[s.getMonth()]+' '+s.getDate()+' – '+months[e.getMonth()]+' '+e.getDate()+', '+e.getFullYear();
  ctx.fillStyle = toRgb(accent, 0.55); ctx.font = '500 22px "DM Sans",sans-serif';
  ctx.textAlign = 'right'; ctx.fillText(dateStr.toUpperCase(), CW-PAD, titleY+68); ctx.textAlign = 'left';

  rule(ctx, PAD, Z.titleEnd-1, CW-PAD*2, '#2e2e24');

  // ── ZONE 3: Stats ──
  const statsY = Z.statsEnd - 130;
  const statW = (CW-PAD*2)/4;
  [
    { val: String(d.totalRated),  label: 'RATED'    },
    { val: String(d.totalStarred),label: 'STARRED'  },
    { val: d.totalMins > 0 ? Math.round(d.totalMins)+'m' : '—', label: 'MINUTES' },
    { val: d.avgScore,            label: 'AVG SCORE' },
  ].forEach(function(stat, i) {
    const sx = PAD + i*statW;
    ctx.fillStyle = accentStr; ctx.font = 'italic bold 58px Georgia,serif';
    ctx.fillText(stat.val, sx, statsY+62);
    ctx.fillStyle = toRgb(accent, 0.55); ctx.font = '600 17px "DM Sans",sans-serif';
    ctx.fillText(stat.label, sx, statsY+84);
  });

  rule(ctx, PAD, Z.statsEnd-1, CW-PAD*2, '#2e2e24');

  // ── ZONE 4: Top 3 Albums ──
  const albumY = Z.statsEnd + 10;
  ctx.fillStyle = toRgb(accent, 0.4); ctx.font = '600 17px "DM Sans",sans-serif';
  ctx.fillText('TOP ALBUMS THIS WEEK', PAD, albumY+16);

  const cardGap = 14;
  const cardW = Math.floor((CW-PAD*2-cardGap*2)/3);
  const cardH = Z.albumsEnd - Z.statsEnd - 34;
  const artSz = cardW - 20;

  for (let i = 0; i < 3; i++) {
    const cx = PAD + i*(cardW+cardGap);
    const cy = albumY + 26;
    const r = d.top3[i];
    // Each card tinted by its own album's color
    const cardAccent = d.accentColors[i] || accent;

    ctx.fillStyle = '#141410'; ctx.strokeStyle = toRgb(cardAccent, 0.25); ctx.lineWidth = 1;
    rrect(ctx, cx, cy, cardW, cardH, 6); ctx.fill(); ctx.stroke();
    // Rank stripe — album's own color
    ctx.fillStyle = toRgb(cardAccent); ctx.fillRect(cx, cy, cardW, 4);

    // Subtle card bg tint from album color
    const cardBg = ctx.createLinearGradient(cx, cy, cx+cardW, cy+cardH);
    cardBg.addColorStop(0, toRgb(cardAccent, 0.07));
    cardBg.addColorStop(1, 'transparent');
    ctx.fillStyle = cardBg; rrect(ctx, cx, cy, cardW, cardH, 6); ctx.fill();

    if (r) {
      const artY = cy + 12;
      if (d.artImages[i]) {
        ctx.save(); rrect(ctx, cx+10, artY, artSz, artSz, 4); ctx.clip();
        ctx.drawImage(d.artImages[i], cx+10, artY, artSz, artSz); ctx.restore();
      } else {
        ctx.fillStyle = '#1e1e18'; rrect(ctx, cx+10, artY, artSz, artSz, 4); ctx.fill();
      }
      // Rank badge
      ctx.fillStyle = toRgb(cardAccent); rrect(ctx, cx+10, artY, 38, 26, 3); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = 'bold 15px "DM Sans",sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('#'+(i+1), cx+29, artY+18); ctx.textAlign = 'left';

      const tx = cx+10, tmx = cardW-20, ty = artY+artSz+12;
      ctx.fillStyle = '#f0efe8'; ctx.font = 'bold 21px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.name, tmx), tx, ty);
      ctx.fillStyle = toRgb(cardAccent, 0.7); ctx.font = '400 17px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.artist, tmx), tx, ty+20);
      ctx.fillStyle = toRgb(cardAccent); ctx.font = 'italic bold 36px Georgia,serif';
      const rs = String(r.rating); ctx.fillText(rs, tx, ty+58);
      const rw = ctx.measureText(rs).width;
      ctx.fillStyle = '#3a3a2e'; ctx.font = '400 17px "DM Sans",sans-serif';
      ctx.fillText('/ 10', tx+rw+5, ty+52);
    }
  }

  rule(ctx, PAD, Z.albumsEnd-1, CW-PAD*2, '#2e2e24');

  // ── ZONE 5: Play Timeline ──
  const chartY = Z.albumsEnd + 8;
  ctx.fillStyle = toRgb(accent, 0.4); ctx.font = '600 17px "DM Sans",sans-serif';
  ctx.fillText('PLAY TIMELINE — MINUTES PER DAY', PAD, chartY+16);
  miniLineChart(ctx, PAD, chartY+28, CW-PAD*2, Z.chartEnd-chartY-40, d.byDate, d.top5forChart, d.lineColors);

  rule(ctx, PAD, Z.chartEnd-1, CW-PAD*2, '#2e2e24');

  // ── ZONE 6: Starred Songs — Floating Pill Tiles ──
  ctx.fillStyle = toRgb(accent, 0.4); ctx.font = '600 17px "DM Sans",sans-serif';
  ctx.fillText('STARRED SONGS', PAD, Z.songsStart+20);

  const maxSongs = Math.min(d.starredSongs.length, 8);
  const songsAreaH = Z.songsEnd - Z.songsStart - 36;

  if (maxSongs === 0) {
    ctx.fillStyle = '#2e2e24'; ctx.font = 'italic 26px Georgia,serif';
    ctx.fillText('No starred songs this week', PAD, Z.songsStart+70);
  } else {
    // Pill tile layout:
    // Tiles have a fixed height of 90px. They stack with slight vertical overlap
    // and a small random-looking (but deterministic) horizontal offset based on index.
    // Each tile's left border color cycles through the per-album accent colors.
    const tileH = 90;
    const tileW = CW - PAD*2;
    const overlap = maxSongs > 4 ? 14 : 8; // more overlap when more songs
    const totalStackH = tileH + (maxSongs-1)*(tileH - overlap);
    // Center the stack vertically in the songs zone
    const stackTopY = Z.songsStart + 36 + Math.max(0, (songsAreaH - totalStackH) / 2);

    // Deterministic horizontal jitter — small, tasteful
    const jitters = [-12, 8, -6, 14, -10, 6, -14, 10];

    for (let i = 0; i < maxSongs; i++) {
      const sg = d.starredSongs[i];
      const tileY = stackTopY + i*(tileH - overlap);
      const jitter = jitters[i % jitters.length];
      const tileX = PAD + jitter;
      const tileActualW = tileW - Math.abs(jitter);

      // Tile border color — cycles through album accent colors
      const tileAccent = d.accentColors[i % d.accentColors.length] || accent;
      const tileAccentBright = lighten(tileAccent, 0.15);

      // Shadow / depth layer beneath tile
      ctx.save();
      ctx.shadowColor = toRgb(tileAccent, 0.2);
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;

      // Tile background
      ctx.fillStyle = '#111110';
      rrect(ctx, tileX, tileY, tileActualW, tileH, 44); // high radius = pill
      ctx.fill();
      ctx.restore();

      // Tile border
      ctx.strokeStyle = toRgb(tileAccentBright, 0.22);
      ctx.lineWidth = 1;
      rrect(ctx, tileX, tileY, tileActualW, tileH, 44);
      ctx.stroke();

      // Subtle color wash inside tile
      const tileWash = ctx.createLinearGradient(tileX, tileY, tileX+tileActualW, tileY);
      tileWash.addColorStop(0, toRgb(tileAccent, 0.1));
      tileWash.addColorStop(0.4, toRgb(tileAccent, 0.03));
      tileWash.addColorStop(1, 'transparent');
      ctx.fillStyle = tileWash;
      rrect(ctx, tileX, tileY, tileActualW, tileH, 44); ctx.fill();

      // Bold left border — the pill's "accent stripe" as a circle cap
      ctx.fillStyle = toRgb(tileAccent);
      ctx.beginPath(); ctx.arc(tileX+44, tileY+tileH/2, tileH/2, 0, Math.PI*2); ctx.fill();

      // Star on the cap
      ctx.fillStyle = '#000'; ctx.font = 'bold 22px "DM Sans",sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('★', tileX+44, tileY+tileH/2+8); ctx.textAlign = 'left';

      // Song name
      const textX = tileX + 44 + tileH/2 + 12;
      const textMaxW = tileActualW - (44 + tileH/2 + 12) - (sg.mins > 0 ? 90 : 20);
      ctx.fillStyle = '#f0efe8'; ctx.font = '600 26px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.song, textMaxW), textX, tileY + tileH*0.44);

      // Artist · album
      ctx.fillStyle = toRgb(tileAccent, 0.65); ctx.font = '400 19px "DM Sans",sans-serif';
      const metaMaxW = tileActualW - (44 + tileH/2 + 12) - (sg.mins > 0 ? 90 : 20);
      ctx.fillText(fit(ctx, sg.artist + ' · ' + sg.album, metaMaxW), textX, tileY + tileH*0.74);

      // Minutes pill — right side
      if (sg.mins > 0) {
        const label = sg.mins + 'm';
        ctx.font = '600 18px "DM Sans",sans-serif';
        const pillW = ctx.measureText(label).width + 20;
        const pillH = 30;
        const px = tileX + tileActualW - pillW - 20;
        const py = tileY + (tileH - pillH)/2;
        ctx.fillStyle = toRgb(tileAccent, 0.18);
        rrect(ctx, px, py, pillW, pillH, 15); ctx.fill();
        ctx.strokeStyle = toRgb(tileAccent, 0.35); ctx.lineWidth = 1;
        rrect(ctx, px, py, pillW, pillH, 15); ctx.stroke();
        ctx.fillStyle = toRgb(tileAccentBright);
        ctx.textAlign = 'center'; ctx.fillText(label, px+pillW/2, py+20); ctx.textAlign = 'left';
      }
    }
  }

  // ── ZONE 7: MCM Footer ──
  ctx.fillStyle = '#06060490'; ctx.fillRect(0, Z.footerStart, CW, CH-Z.footerStart);

  // Footer tint from album palette
  const footerGrad = ctx.createLinearGradient(0, Z.footerStart, CW, CH);
  footerGrad.addColorStop(0, 'rgba(6,6,4,0.9)');
  footerGrad.addColorStop(1, toRgb(accent, 0.1));
  ctx.fillStyle = footerGrad; ctx.fillRect(0, Z.footerStart, CW, CH-Z.footerStart);

  rule(ctx, PAD, Z.footerStart+1, CW-PAD*2, accentStr);
  starburst(ctx, 70, Z.footerStart+(CH-Z.footerStart)/2, 90, 20, toRgb(accent, 0.09));
  dotgrid(ctx, CW-PAD-80, Z.footerStart+50, 5, 4, 20, 2.5, toRgb(accent, 0.14));

  ctx.fillStyle = toRgb(accent, 0.25); ctx.font = '400 20px "DM Sans",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater  ·  sillymcwilly1.github.io/2026-Albums', CW/2, Z.footerStart+(CH-Z.footerStart)/2+8);
  ctx.textAlign = 'left';

  // Bottom edge
  ctx.fillStyle = accentStr; ctx.fillRect(0, CH-5, CW, 5);
} // ← end drawCard

function downloadWeekCard() {
  const canvas = document.getElementById('weekCanvas');
  canvas.toBlob(function(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'week-in-review.png';
    document.body.appendChild(a); a.click();
    setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
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
