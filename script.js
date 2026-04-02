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

const CW = 1080, CH = 1920, PAD = 64;
const Z = {
  headerEnd:   150,
  titleEnd:    300,
  statsEnd:    450,
  albumsEnd:   760,   // albums get 310px — plenty of room
  chartEnd:    1100,  // chart gets 340px — large enough for any data scale
  songsStart:  1120,  // 20px gap after chart rule
  songsEnd:    1730,  // songs get 610px — generous for 12 tiles
  footerStart: 1730,
};

// ---- Color helpers ----
function sampleImageColor(img, sampleCount) {
  if (!img) return [29, 185, 84];
  try {
    const size = 40;
    const off = document.createElement('canvas'); off.width = size; off.height = size;
    const oc = off.getContext('2d'); oc.drawImage(img, 0, 0, size, size);
    const pixels = oc.getImageData(0, 0, size, size).data;
    let r=0, g=0, b=0, count=0;
    const step = Math.max(1, Math.floor((size*size)/sampleCount)) * 4;
    for (let i=0; i<pixels.length; i+=step) { r+=pixels[i]; g+=pixels[i+1]; b+=pixels[i+2]; count++; }
    return [Math.round(r/count), Math.round(g/count), Math.round(b/count)];
  } catch(e) { return [29, 185, 84]; }
}

function blendColors(colorArr) {
  if (!colorArr || !colorArr.length) return [29, 185, 84];
  return [
    Math.round(colorArr.reduce(function(s,c){return s+c[0];},0)/colorArr.length),
    Math.round(colorArr.reduce(function(s,c){return s+c[1];},0)/colorArr.length),
    Math.round(colorArr.reduce(function(s,c){return s+c[2];},0)/colorArr.length)
  ];
}

function lighten(rgb, t) {
  return [
    Math.round(rgb[0]+(255-rgb[0])*t),
    Math.round(rgb[1]+(255-rgb[1])*t),
    Math.round(rgb[2]+(255-rgb[2])*t)
  ];
}

function toRgb(rgb, alpha) {
  if (alpha !== undefined) return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';
  return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
}

// ---- Canvas helpers ----
function fit(ctx, text, maxW) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo=0, hi=text.length;
  while (lo<hi-1) {
    const mid=Math.floor((lo+hi)/2);
    ctx.measureText(text.substring(0,mid)+'…').width<=maxW?(lo=mid):(hi=mid);
  }
  return text.substring(0,lo)+'…';
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function starburst(ctx, cx, cy, outerR, rays, color) {
  ctx.save(); ctx.fillStyle=color;
  const innerR=outerR*0.38;
  for (let i=0;i<rays;i++) {
    const a1=(i/rays)*Math.PI*2, a2=a1+Math.PI/rays, a3=a1+(Math.PI*2)/rays;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a1)*outerR,cy+Math.sin(a1)*outerR);
    ctx.lineTo(cx+Math.cos(a2)*innerR,cy+Math.sin(a2)*innerR);
    ctx.lineTo(cx+Math.cos(a3)*outerR,cy+Math.sin(a3)*outerR);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function dotgrid(ctx, x, y, cols, rows, gap, r, color) {
  ctx.fillStyle=color;
  for (let row=0;row<rows;row++) for (let col=0;col<cols;col++) {
    ctx.beginPath(); ctx.arc(x+col*gap,y+row*gap,r,0,Math.PI*2); ctx.fill();
  }
}

function rule(ctx, x, y, w, color) {
  ctx.save();
  const cx=x+w/2;
  ctx.strokeStyle=color; ctx.lineWidth=1; ctx.globalAlpha=0.35;
  ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(cx-24,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx+24,y); ctx.lineTo(x+w,y); ctx.stroke();
  ctx.globalAlpha=1;
  [-14,0,14].forEach(function(dx,i) {
    ctx.fillStyle=color; ctx.globalAlpha=i===1?0.9:0.3;
    ctx.beginPath(); ctx.arc(cx+dx,y,i===1?4:2.5,0,Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha=1; ctx.restore();
}

// ---- Mini line chart with dynamic Y axis ----
function miniLineChart(ctx, x, y, w, h, byDate, albums, colors) {
  const dates = Object.keys(byDate).sort();
  if (dates.length < 2) {
    ctx.fillStyle='#3a3a2e'; ctx.font='italic 24px Georgia,serif'; ctx.textAlign='center';
    ctx.fillText('Not enough data yet', x+w/2, y+h/2); ctx.textAlign='left'; return;
  }
  // Dynamic max with 20% headroom, rounded to nearest 10
  let rawMax = 0;
  dates.forEach(function(d) { albums.forEach(function(a) { rawMax=Math.max(rawMax,(byDate[d]&&byDate[d][a])||0); }); });
  if (rawMax===0) rawMax=1;
  const maxVal = Math.ceil((rawMax*1.2)/10)*10;

  const pL=60, pR=20, pT=16, pB=34;
  const cw=w-pL-pR, ch=h-pT-pB;

  // 4 grid lines
  [0,0.33,0.66,1].forEach(function(pct) {
    const gy=y+pT+ch*(1-pct);
    ctx.strokeStyle='#2a2a1e'; ctx.lineWidth=0.5;
    ctx.beginPath(); ctx.moveTo(x+pL,gy); ctx.lineTo(x+pL+cw,gy); ctx.stroke();
    const labelVal=Math.round(maxVal*pct);
    if (labelVal>0) {
      ctx.fillStyle='#3a3a2e'; ctx.font='18px "DM Sans",sans-serif'; ctx.textAlign='right';
      ctx.fillText(labelVal+'m', x+pL-8, gy+6); ctx.textAlign='left';
    }
  });

  // X labels — Mondays only
  ctx.fillStyle='#3a3a2e'; ctx.font='18px "DM Sans",sans-serif'; ctx.textAlign='center';
  dates.forEach(function(d,i) {
    const dt=new Date(d+'T00:00:00');
    if (i===0||dt.getDay()===1) {
      const px=x+pL+(i/Math.max(dates.length-1,1))*cw;
      ctx.fillText((dt.getMonth()+1)+'/'+dt.getDate(), px, y+pT+ch+pB-4);
    }
  });
  ctx.textAlign='left';

  // Area fills first
  albums.forEach(function(album, ai) {
    const pts=dates.map(function(d,i) {
      return { px:x+pL+(i/Math.max(dates.length-1,1))*cw, py:y+pT+ch*(1-((byDate[d]&&byDate[d][album])||0)/maxVal) };
    });
    ctx.beginPath(); ctx.moveTo(pts[0].px,y+pT+ch);
    pts.forEach(function(p){ctx.lineTo(p.px,p.py);}); ctx.lineTo(pts[pts.length-1].px,y+pT+ch);
    ctx.closePath(); ctx.fillStyle=colors[ai]+'12'; ctx.fill();
  });

  // Lines + dots on top
  albums.forEach(function(album, ai) {
    const pts=dates.map(function(d,i) {
      return { px:x+pL+(i/Math.max(dates.length-1,1))*cw, py:y+pT+ch*(1-((byDate[d]&&byDate[d][album])||0)/maxVal) };
    });
    ctx.beginPath(); ctx.strokeStyle=colors[ai]; ctx.lineWidth=2.5; ctx.lineJoin='round';
    ctx.moveTo(pts[0].px,pts[0].py);
    for (let i=1;i<pts.length;i++) {
      const cpx=(pts[i-1].px+pts[i].px)/2;
      ctx.bezierCurveTo(cpx,pts[i-1].py,cpx,pts[i].py,pts[i].px,pts[i].py);
    }
    ctx.stroke();
    pts.forEach(function(p) { ctx.beginPath(); ctx.arc(p.px,p.py,3.5,0,Math.PI*2); ctx.fillStyle=colors[ai]; ctx.fill(); });
  });

  // Legend top-right
  let ly=y+pT+6;
  albums.forEach(function(album, ai) {
    const lx=x+pL+cw;
    ctx.fillStyle=colors[ai]; ctx.fillRect(lx-210,ly+2,14,3);
    ctx.font='17px "DM Sans",sans-serif'; ctx.textAlign='left';
    ctx.fillText(fit(ctx,album,190),lx-190,ly+12); ly+=26;
  });
}

// ---- Data fetching ----
async function generateWeekReview() {
  const endDate=new Date();
  const startDate=new Date(); startDate.setDate(endDate.getDate()-7);
  document.getElementById('week-loading').classList.remove('hidden');
  document.getElementById('week-output').classList.add('hidden');
  document.getElementById('week-empty').classList.add('hidden');

  const { data: rU } = await db.from('ratings').select('*, albums(*)')
    .gte('updated_at',startDate.toISOString()).lt('updated_at',endDate.toISOString());
  const { data: rC } = await db.from('ratings').select('*, albums(*)')
    .gte('created_at',startDate.toISOString()).lt('created_at',endDate.toISOString());
  const rmap={};
  [...(rU||[]),...(rC||[])].forEach(function(r){rmap[r.id]=r;});
  const weekRatings=Object.values(rmap).sort(function(a,b){return b.rating-a.rating;});

  const { data: playLogs } = await db.from('play_logs').select('*')
    .gte('logged_at',startDate.toISOString()).lt('logged_at',endDate.toISOString());

  if (!weekRatings.length&&(!playLogs||!playLogs.length)) {
    document.getElementById('week-loading').classList.add('hidden');
    document.getElementById('week-empty').classList.remove('hidden'); return;
  }

  const totalMins=(playLogs||[]).reduce(function(s,l){return s+(l.duration_ms?Math.round(l.duration_ms/60000):0);},0);

  // albumMins — minutes per album THIS WEEK ONLY (from play_logs already filtered to 7 days)
  const albumMins={};
  (playLogs||[]).forEach(function(l) {
    const m=l.duration_ms?Math.round(l.duration_ms/60000):0;
    if (m>0) albumMins[l.album_name]=(albumMins[l.album_name]||0)+m;
  });

  const byDate={};
  (playLogs||[]).forEach(function(l) {
    const date=l.logged_at.substring(0,10);
    const m=l.duration_ms?Math.round(l.duration_ms/60000):0;
    if (!byDate[date]) byDate[date]={};
    byDate[date][l.album_name]=(byDate[date][l.album_name]||0)+m;
  });

  const top5forChart=Object.entries(albumMins).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0];});
  const lineColors=['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];

  // Starred songs — no minutes on tiles
  const starredSongs=[];
  weekRatings.slice(0,6).forEach(function(r) {
    if (r.top_songs&&r.top_songs.length>0) {
      r.top_songs.forEach(function(song) {
        if (starredSongs.length<12) starredSongs.push({ song, album:r.albums.name, artist:r.albums.artist });
      });
    }
  });

  const top3=weekRatings.slice(0,3);
  const avgScore=top3.length?(top3.reduce(function(s,r){return s+r.rating;},0)/top3.length).toFixed(1):'—';
  const totalStarred=weekRatings.reduce(function(s,r){return s+(r.top_songs?r.top_songs.length:0);},0);

  const artImages=await Promise.all(top3.map(function(r) {
    return new Promise(function(resolve) {
      if (!r.albums.image_url){resolve(null);return;}
      const img=new Image(); img.crossOrigin='anonymous';
      img.onload=function(){resolve(img);}; img.onerror=function(){resolve(null);};
      img.src=r.albums.image_url;
    });
  }));

  const sampledColors=artImages.map(function(img){return sampleImageColor(img,200);});
  const blended=blendColors(sampledColors);
  const accentColors=sampledColors.map(function(c) {
    const bright=Math.max(c[0],c[1],c[2]);
    return bright<60?lighten(c,0.4):c;
  });

  document.getElementById('week-loading').classList.add('hidden');
  drawCard({
    startDate,endDate,top3,artImages,totalMins,avgScore,
    totalRated:weekRatings.length,totalStarred,starredSongs,
    byDate,top5forChart,lineColors,
    blended,accentColors,albumMinsMap:albumMins
  });
  document.getElementById('week-output').classList.remove('hidden');
}

function drawCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  const accent = d.blended;
  const accentStr = toRgb(accent);

  // Background
  ctx.fillStyle = '#0e0e0b'; ctx.fillRect(0, 0, CW, CH);
  const g1 = ctx.createRadialGradient(CW, 0, 0, CW, 0, 900);
  g1.addColorStop(0, toRgb(accent, 0.12)); g1.addColorStop(1, 'transparent');
  ctx.fillStyle = g1; ctx.fillRect(0, 0, CW, CH);
  const g2 = ctx.createRadialGradient(0, CH, 0, 0, CH, 700);
  g2.addColorStop(0, toRgb(lighten(accent, 0.2), 0.08)); g2.addColorStop(1, 'transparent');
  ctx.fillStyle = g2; ctx.fillRect(0, 0, CW, CH);

  // ── ZONE 1: MCM Header (0 – headerEnd) ──
  const hGrad = ctx.createLinearGradient(0, 0, CW, Z.headerEnd);
  hGrad.addColorStop(0, toRgb(accent, 0.15));
  hGrad.addColorStop(1, 'rgba(6,6,4,0.95)');
  ctx.fillStyle = hGrad; ctx.fillRect(0, 0, CW, Z.headerEnd);
  ctx.fillStyle = accentStr; ctx.fillRect(0, 0, CW, 5);
  starburst(ctx, CW - 70, 65, 120, 22, toRgb(accent, 0.13));
  dotgrid(ctx, PAD, 24, 5, 3, 20, 2.5, toRgb(accent, 0.2));
  ctx.save(); ctx.strokeStyle = toRgb(accent, 0.09); ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(300, 0); ctx.quadraticCurveTo(500, 65, 300, Z.headerEnd);
  ctx.stroke(); ctx.restore();
  rule(ctx, PAD, Z.headerEnd - 1, CW - PAD * 2, accentStr);

  // ── ZONE 2: Title + Date (headerEnd – titleEnd) ──
  const titleY = Z.headerEnd + 20;
  const wh = [7,16,26,34,26,16,7], wbw = 9, wgap = 5;
  const wTotalW = wh.length * (wbw + wgap) - wgap;
  const wMidY = titleY + 40;
  wh.forEach(function(h, i) {
    const t = h / 34;
    ctx.fillStyle = toRgb([
      Math.round(accent[0]*t + 40*(1-t)),
      Math.round(accent[1]*t + 40*(1-t)),
      Math.round(accent[2]*t + 40*(1-t))
    ]);
    ctx.beginPath(); ctx.roundRect(PAD + i*(wbw+wgap), wMidY - h/2, wbw, h, 3); ctx.fill();
  });
  const titleX = PAD + wTotalW + 18;
  ctx.fillStyle = toRgb(accent, 0.5); ctx.font = '300 20px "DM Sans",sans-serif';
  ctx.fillText('YOUR PERSONAL', titleX, titleY + 22);
  ctx.fillStyle = '#f0efe8'; ctx.font = 'italic 48px Georgia,serif';
  ctx.fillText('Album ', titleX, titleY + 68);
  const aw = ctx.measureText('Album ').width;
  ctx.fillStyle = accentStr; ctx.font = '48px Georgia,serif';
  ctx.fillText('Rater', titleX + aw, titleY + 68);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const s = d.startDate, e = new Date(d.endDate); e.setDate(e.getDate() - 1);
  const dateStr = months[s.getMonth()] + ' ' + s.getDate() + ' – ' + months[e.getMonth()] + ' ' + e.getDate() + ', ' + e.getFullYear();
  ctx.fillStyle = toRgb(accent, 0.55); ctx.font = '500 22px "DM Sans",sans-serif';
  ctx.textAlign = 'right'; ctx.fillText(dateStr.toUpperCase(), CW - PAD, titleY + 68); ctx.textAlign = 'left';
  rule(ctx, PAD, Z.titleEnd - 1, CW - PAD * 2, '#2e2e24');

  // ── ZONE 3: Stats (titleEnd – statsEnd) ──
  const statsY = Z.titleEnd + 20;
  const statW = (CW - PAD * 2) / 4;
  [
    { val: String(d.totalRated),  label: 'RATED'    },
    { val: String(d.totalStarred),label: 'STARRED'  },
    { val: d.totalMins > 0 ? Math.round(d.totalMins) + 'm' : '—', label: 'MINUTES' },
    { val: d.avgScore,            label: 'AVG SCORE' }
  ].forEach(function(stat, i) {
    const sx = PAD + i * statW;
    ctx.fillStyle = accentStr; ctx.font = 'italic bold 58px Georgia,serif';
    ctx.fillText(stat.val, sx, statsY + 62);
    ctx.fillStyle = toRgb(accent, 0.55); ctx.font = '600 17px "DM Sans",sans-serif';
    ctx.fillText(stat.label, sx, statsY + 84);
  });
  rule(ctx, PAD, Z.statsEnd - 1, CW - PAD * 2, '#2e2e24');

  // ── ZONE 4: Top 3 Albums (statsEnd – albumsEnd) ──
  // cardH is calculated strictly from zone boundaries — can never overflow
  const albumLabelY = Z.statsEnd + 10;
  const cardStartY  = albumLabelY + 26;
  const cardH       = Z.albumsEnd - cardStartY - 16; // 16px bottom breathing room
  const cardGap     = 14;
  const cardW       = Math.floor((CW - PAD * 2 - cardGap * 2) / 3);
  const artSz       = Math.min(cardW - 20, cardH - 110); // art never taller than card allows

  ctx.fillStyle = toRgb(accent, 0.4); ctx.font = '600 17px "DM Sans",sans-serif';
  ctx.fillText('TOP ALBUMS THIS WEEK', PAD, albumLabelY + 16);

  for (let i = 0; i < 3; i++) {
    const cx = PAD + i * (cardW + cardGap);
    const cy = cardStartY;
    const r  = d.top3[i];
    const cardAccent = d.accentColors[i] || accent;

    // Card background — strictly bounded
    ctx.fillStyle = '#141410'; ctx.strokeStyle = toRgb(cardAccent, 0.25); ctx.lineWidth = 1;
    rrect(ctx, cx, cy, cardW, cardH, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = toRgb(cardAccent); ctx.fillRect(cx, cy, cardW, 4);
    const cardBg = ctx.createLinearGradient(cx, cy, cx + cardW, cy + cardH);
    cardBg.addColorStop(0, toRgb(cardAccent, 0.07)); cardBg.addColorStop(1, 'transparent');
    ctx.fillStyle = cardBg; rrect(ctx, cx, cy, cardW, cardH, 6); ctx.fill();

    if (r) {
      const artY = cy + 12;

      // Draw art — clipped to artSz square
      if (d.artImages[i]) {
        ctx.save(); rrect(ctx, cx+10, artY, artSz, artSz, 4); ctx.clip();
        ctx.drawImage(d.artImages[i], cx+10, artY, artSz, artSz); ctx.restore();
      } else {
        ctx.fillStyle = '#1e1e18'; rrect(ctx, cx+10, artY, artSz, artSz, 4); ctx.fill();
      }

      // Rank badge
      ctx.fillStyle = toRgb(cardAccent); rrect(ctx, cx+10, artY, 38, 26, 3); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = 'bold 15px "DM Sans",sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('#' + (i+1), cx+29, artY+18); ctx.textAlign = 'left';

      // Text zone — starts strictly below art
      const tx    = cx + 10;
      const tmx   = cardW - 20;
      const textY = artY + artSz + 14; // guaranteed below art

      ctx.fillStyle = '#f0efe8'; ctx.font = 'bold 20px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.name, tmx), tx, textY);

      ctx.fillStyle = toRgb(cardAccent, 0.7); ctx.font = '400 16px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.artist, tmx), tx, textY + 22);

      ctx.fillStyle = toRgb(cardAccent); ctx.font = 'italic bold 34px Georgia,serif';
      const rs = String(r.rating);
      ctx.fillText(rs, tx, textY + 58);
      const rw = ctx.measureText(rs).width;
      ctx.fillStyle = '#3a3a2e'; ctx.font = '400 16px "DM Sans",sans-serif';
      ctx.fillText('/ 10', tx + rw + 5, textY + 52);

      // Minutes this week — only if it fits inside the card
      const minsVal = d.albumMinsMap ? (d.albumMinsMap[r.albums.name] || 0) : 0;
      const minsY   = textY + 74;
      if (minsVal > 0 && minsY < cy + cardH - 8) {
        ctx.fillStyle = toRgb(cardAccent, 0.45); ctx.font = '400 14px "DM Sans",sans-serif';
        ctx.fillText(minsVal + 'm this week', tx, minsY);
      }
    }
  }
  rule(ctx, PAD, Z.albumsEnd - 1, CW - PAD * 2, '#2e2e24');

  // ── ZONE 5: Play Timeline (albumsEnd – chartEnd) ──
  // Chart height is derived from zone boundaries — guaranteed not to touch albums
  const chartLabelY  = Z.albumsEnd + 8;
  const chartDrawY   = chartLabelY + 28;
  const chartDrawH   = Z.chartEnd - chartDrawY - 20;

  ctx.fillStyle = toRgb(accent, 0.4); ctx.font = '600 17px "DM Sans",sans-serif';
  ctx.fillText('PLAY TIMELINE — MINUTES PER DAY', PAD, chartLabelY + 16);
  miniLineChart(ctx, PAD, chartDrawY, CW - PAD * 2, chartDrawH, d.byDate, d.top5forChart, d.lineColors);
  rule(ctx, PAD, Z.chartEnd - 1, CW - PAD * 2, '#2e2e24');

  // ── ZONE 6: Starred Songs (songsStart – songsEnd) ──
  const songsLabelY  = Z.songsStart + 24;
  const songsDrawY   = Z.songsStart + 42;
  const songsAreaH   = Z.songsEnd - songsDrawY - 10;
  const maxSongs     = Math.min(d.starredSongs.length, 12);

  ctx.fillStyle = toRgb(accent, 0.4); ctx.font = '600 17px "DM Sans",sans-serif';
  ctx.fillText('STARRED SONGS', PAD, songsLabelY);

  if (maxSongs === 0) {
    ctx.fillStyle = '#2e2e24'; ctx.font = 'italic 26px Georgia,serif';
    ctx.fillText('No starred songs this week', PAD, songsDrawY + 44);
  } else {
    const cols     = 2;
    const tileGapX = 14;
    const tileGapY = 12;
    const colW     = Math.floor((CW - PAD * 2 - tileGapX) / cols);
    const numRows  = Math.ceil(maxSongs / cols);
    // tileH is calculated to exactly fill songsAreaH — never overflows
    const tileH    = Math.min(86, Math.floor((songsAreaH - tileGapY * (numRows - 1)) / numRows));
    const colJitter = [-10, 8];

    for (let i = 0; i < maxSongs; i++) {
      const sg   = d.starredSongs[i];
      const col  = i % cols;
      const row  = Math.floor(i / cols);
      const tileX = PAD + col * (colW + tileGapX) + colJitter[col];
      const tileY = songsDrawY + row * (tileH + tileGapY);
      const tileActualW = colW - Math.abs(colJitter[col]);
      const tileAccent  = d.accentColors[i % Math.max(d.accentColors.length, 1)] || accent;
      const tileAccentBright = lighten(tileAccent, 0.15);
      const capR = tileH / 2;

      // Guard: skip tile if it would go below songsEnd
      if (tileY + tileH > Z.songsEnd) continue;

      // Shadow
      ctx.save();
      ctx.shadowColor = toRgb(tileAccent, 0.15);
      ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
      ctx.fillStyle = '#111110';
      rrect(ctx, tileX, tileY, tileActualW, tileH, capR); ctx.fill();
      ctx.restore();

      // Border
      ctx.strokeStyle = toRgb(tileAccentBright, 0.2); ctx.lineWidth = 1;
      rrect(ctx, tileX, tileY, tileActualW, tileH, capR); ctx.stroke();

      // Color wash
      const tw = ctx.createLinearGradient(tileX, tileY, tileX + tileActualW, tileY);
      tw.addColorStop(0, toRgb(tileAccent, 0.1));
      tw.addColorStop(0.5, toRgb(tileAccent, 0.02));
      tw.addColorStop(1, 'transparent');
      ctx.fillStyle = tw; rrect(ctx, tileX, tileY, tileActualW, tileH, capR); ctx.fill();

      // Circular cap
      ctx.fillStyle = toRgb(tileAccent);
      ctx.beginPath(); ctx.arc(tileX + capR, tileY + capR, capR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold ' + Math.round(tileH * 0.28) + 'px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('★', tileX + capR, tileY + capR + Math.round(tileH * 0.1));
      ctx.textAlign = 'left';

      // Text
      const textX    = tileX + capR * 2 + 10;
      const textMaxW = tileActualW - capR * 2 - 18;
      const songSz   = tileH > 70 ? 22 : 18;
      const metaSz   = tileH > 70 ? 17 : 14;

      ctx.fillStyle = '#f0efe8';
      ctx.font = '600 ' + songSz + 'px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.song, textMaxW), textX, tileY + tileH * 0.44);

      ctx.fillStyle = toRgb(tileAccent, 0.65);
      ctx.font = '400 ' + metaSz + 'px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.artist + ' · ' + sg.album, textMaxW), textX, tileY + tileH * 0.76);
    }
  }

  // ── ZONE 7: MCM Footer (footerStart – CH) ──
  const fGrad = ctx.createLinearGradient(0, Z.footerStart, CW, CH);
  fGrad.addColorStop(0, 'rgba(6,6,4,0.9)');
  fGrad.addColorStop(1, toRgb(accent, 0.1));
  ctx.fillStyle = fGrad; ctx.fillRect(0, Z.footerStart, CW, CH - Z.footerStart);
  rule(ctx, PAD, Z.footerStart + 1, CW - PAD * 2, accentStr);
  starburst(ctx, 70, Z.footerStart + (CH - Z.footerStart) / 2, 90, 20, toRgb(accent, 0.09));
  dotgrid(ctx, CW - PAD - 80, Z.footerStart + 50, 5, 4, 20, 2.5, toRgb(accent, 0.14));
  ctx.fillStyle = toRgb(accent, 0.25); ctx.font = '400 20px "DM Sans",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater  ·  sillymcwilly1.github.io/2026-Albums', CW / 2, Z.footerStart + (CH - Z.footerStart) / 2 + 8);
  ctx.textAlign = 'left';
  ctx.fillStyle = accentStr; ctx.fillRect(0, CH - 5, CW, 5);
} // ← end drawCard

function downloadWeekCard() {
  const canvas=document.getElementById('weekCanvas');
  canvas.toBlob(function(blob) {
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='week-in-review.png';
    document.body.appendChild(a); a.click();
    setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
  },'image/png');
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
