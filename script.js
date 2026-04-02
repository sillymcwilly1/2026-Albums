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
// ---- Card canvas constants + helpers ----
const CW = 1080, CH = 1920, PAD = 64;

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
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function starburst(ctx, cx, cy, outerR, rays, color) {
  ctx.save(); ctx.fillStyle = color;
  const innerR = outerR * 0.38;
  for (let i = 0; i < rays; i++) {
    const a1=(i/rays)*Math.PI*2, a2=a1+Math.PI/rays, a3=a1+(Math.PI*2)/rays;
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
  ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(cx-24,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx+24,y); ctx.lineTo(x+w,y); ctx.stroke();
  ctx.globalAlpha = 1;
  [-14,0,14].forEach(function(dx,i) {
    ctx.fillStyle = color; ctx.globalAlpha = i===1?0.9:0.3;
    ctx.beginPath(); ctx.arc(cx+dx,y,i===1?4:2.5,0,Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha = 1; ctx.restore();
}

function sampleImageColor(img, sampleCount) {
  if (!img) return [29, 185, 84];
  try {
    const size = 40;
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    const oc = off.getContext('2d');
    oc.drawImage(img, 0, 0, size, size);
    const pixels = oc.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, count = 0;
    const step = Math.max(1, Math.floor((size * size) / sampleCount)) * 4;
    for (let i = 0; i < pixels.length; i += step) {
      r += pixels[i]; g += pixels[i+1]; b += pixels[i+2]; count++;
    }
    return [Math.round(r/count), Math.round(g/count), Math.round(b/count)];
  } catch(e) { return [29, 185, 84]; }
}

function blendColors(colorArr) {
  if (!colorArr || !colorArr.length) return [29, 185, 84];
  return [
    Math.round(colorArr.reduce(function(s,c){return s+c[0];},0) / colorArr.length),
    Math.round(colorArr.reduce(function(s,c){return s+c[1];},0) / colorArr.length),
    Math.round(colorArr.reduce(function(s,c){return s+c[2];},0) / colorArr.length)
  ];
}

function lighten(rgb, t) {
  return [
    Math.round(rgb[0] + (255-rgb[0])*t),
    Math.round(rgb[1] + (255-rgb[1])*t),
    Math.round(rgb[2] + (255-rgb[2])*t)
  ];
}

function toRgb(rgb, alpha) {
  if (alpha !== undefined) return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';
  return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
}

async function generateWeekReview() {
  const endDate = new Date();
  const startDate = new Date(); startDate.setDate(endDate.getDate() - 7);

  document.getElementById('week-loading').classList.remove('hidden');
  document.getElementById('week-output').classList.add('hidden');
  document.getElementById('week-empty').classList.add('hidden');

  const { data: rU } = await db.from('ratings').select('*, albums(*)')
    .gte('updated_at', startDate.toISOString()).lt('updated_at', endDate.toISOString());
  const { data: rC } = await db.from('ratings').select('*, albums(*)')
    .gte('created_at', startDate.toISOString()).lt('created_at', endDate.toISOString());
  const rmap = {};
  [...(rU||[]), ...(rC||[])].forEach(function(r) { rmap[r.id] = r; });
  const weekRatings = Object.values(rmap).sort(function(a,b) { return b.rating - a.rating; });

  const { data: playLogs } = await db.from('play_logs').select('*')
    .gte('logged_at', startDate.toISOString()).lt('logged_at', endDate.toISOString());

  if (!weekRatings.length && (!playLogs || !playLogs.length)) {
    document.getElementById('week-loading').classList.add('hidden');
    document.getElementById('week-empty').classList.remove('hidden');
    return;
  }

  const totalMins = (playLogs||[]).reduce(function(s,l) {
    return s + (l.duration_ms ? Math.round(l.duration_ms / 60000) : 0);
  }, 0);

  const albumMins = {};
  (playLogs||[]).forEach(function(l) {
    const m = l.duration_ms ? Math.round(l.duration_ms / 60000) : 0;
    if (m > 0) albumMins[l.album_name] = (albumMins[l.album_name] || 0) + m;
  });

  const byDate = {};
  (playLogs||[]).forEach(function(l) {
    const date = l.logged_at.substring(0, 10);
    const m = l.duration_ms ? Math.round(l.duration_ms / 60000) : 0;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][l.album_name] = (byDate[date][l.album_name] || 0) + m;
  });

  const top5forChart = Object.entries(albumMins)
    .sort(function(a,b) { return b[1] - a[1]; }).slice(0, 5)
    .map(function(e) { return e[0]; });
  const lineColors = ['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];

  const starredSongs = [];
  weekRatings.slice(0, 6).forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.forEach(function(song) {
        if (starredSongs.length < 9) {
          starredSongs.push({ song, album: r.albums.name, artist: r.albums.artist });
        }
      });
    }
  });

  const top3 = weekRatings.slice(0, 3);
  const avgScore = top3.length
    ? (top3.reduce(function(s,r) { return s + r.rating; }, 0) / top3.length).toFixed(1)
    : '—';
  const totalStarred = weekRatings.reduce(function(s,r) {
    return s + (r.top_songs ? r.top_songs.length : 0);
  }, 0);

  const artImages = await Promise.all(top3.map(function(r) {
    return new Promise(function(resolve) {
      if (!r.albums.image_url) { resolve(null); return; }
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function() { resolve(img); };
      img.onerror = function() { resolve(null); };
      img.src = r.albums.image_url;
    });
  }));

  const sampledColors = artImages.map(function(img) { return sampleImageColor(img, 200); });
  const blended = blendColors(sampledColors);
  const accentColors = sampledColors.map(function(c) {
    return Math.max(c[0], c[1], c[2]) < 60 ? lighten(c, 0.4) : c;
  });

  // All-time rating distribution for stacked bar
  const { data: allRatings } = await db.from('ratings').select('rating');
  const ratingBuckets = { '1-4': 0, '5-6': 0, '7-8': 0, '9-10': 0 };
  (allRatings || []).forEach(function(r) {
    if (r.rating >= 9) ratingBuckets['9-10']++;
    else if (r.rating >= 7) ratingBuckets['7-8']++;
    else if (r.rating >= 5) ratingBuckets['5-6']++;
    else ratingBuckets['1-4']++;
  });
  const totalAllTimeCount = (allRatings || []).length;

  document.getElementById('week-loading').classList.add('hidden');

  drawCard({
    startDate, endDate, top3, artImages, totalMins, avgScore,
    totalRated: weekRatings.length, totalStarred, starredSongs,
    byDate, top5forChart, lineColors,
    blended, accentColors, albumMinsMap: albumMins,
    ratingBuckets: ratingBuckets,
    totalAllTime: totalAllTimeCount
  });

  document.getElementById('week-output').classList.remove('hidden');
}

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

// ================================================================
// WEEK IN REVIEW CARD — drawCard() only
//
// Zone map (pixels, 1080×1920):
//   0    – 130   MCM header (dark, Instagram chrome safe)
//   130  – 270   Title + date
//   270  – 390   Stats row
//   390  – 630   Top 3 albums
//   630  – 790   Starred songs (3-col compact tiles) ← MOVED UP
//   790  – 960   Stacked rating bar chart
//   960  – 1130  Play timeline (strictly bounded, never bleeds)
//   1130 – 1920  MCM footer (dark, Instagram chrome safe)
//
// All zones are hard pixel boundaries. Every section measures its
// available height from zone boundaries — never from font baselines.
// ================================================================

function drawCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  const accent = d.blended;
  const accentStr = toRgb(accent);

  // ── BACKGROUND — warm cream with colorful tinted panels ──
  // Base: warm off-white
  ctx.fillStyle = '#f2ece0';
  ctx.fillRect(0, 0, CW, CH);

  // Large diagonal color wash top-right — album palette
  const bgWash1 = ctx.createLinearGradient(CW * 0.3, 0, CW, CH * 0.6);
  bgWash1.addColorStop(0, toRgb(accent, 0.0));
  bgWash1.addColorStop(0.4, toRgb(accent, 0.07));
  bgWash1.addColorStop(1, toRgb(accent, 0.14));
  ctx.fillStyle = bgWash1;
  ctx.fillRect(0, 0, CW, CH);

  // Secondary color wash bottom-left — album 2 color
  const c2 = d.accentColors[1] || accent;
  const bgWash2 = ctx.createLinearGradient(0, CH * 0.5, CW * 0.6, CH);
  bgWash2.addColorStop(0, toRgb(c2, 0.08));
  bgWash2.addColorStop(1, toRgb(c2, 0.0));
  ctx.fillStyle = bgWash2;
  ctx.fillRect(0, 0, CW, CH);

  // Horizontal color band mid-card — album 3 color, very subtle
  const c3 = d.accentColors[2] || accent;
  const bgWash3 = ctx.createLinearGradient(0, CH * 0.35, CW, CH * 0.65);
  bgWash3.addColorStop(0, toRgb(c3, 0.0));
  bgWash3.addColorStop(0.5, toRgb(c3, 0.05));
  bgWash3.addColorStop(1, toRgb(c3, 0.0));
  ctx.fillStyle = bgWash3;
  ctx.fillRect(0, 0, CW, CH);

  // ── ZONE 1: MCM Header (0–130) ──
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(0, 0, CW, 130);

  // Top accent edge
  ctx.fillStyle = accentStr;
  ctx.fillRect(0, 0, CW, 5);

  // Starburst — top right
  starburst(ctx, CW - 70, 60, 110, 22, toRgb(accent, 0.22));

  // Dot grid — top left
  dotgrid(ctx, PAD, 22, 5, 3, 20, 2.5, toRgb(accent, 0.35));

  // MCM arc
  ctx.save();
  ctx.strokeStyle = toRgb(accent, 0.2);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 130);
  ctx.quadraticCurveTo(160, 60, 320, 130);
  ctx.stroke();
  ctx.restore();

  // Waveform bars
  const wh = [7, 16, 26, 34, 26, 16, 7], wbw = 9, wgap = 5;
  const wTotalW = wh.length * (wbw + wgap) - wgap;
  const wMidY = 78;
  wh.forEach(function(h, i) {
    const t = h / 34;
    ctx.fillStyle = toRgb([
      Math.round(accent[0] * t + 40 * (1 - t)),
      Math.round(accent[1] * t + 40 * (1 - t)),
      Math.round(accent[2] * t + 40 * (1 - t))
    ]);
    ctx.beginPath();
    ctx.roundRect(PAD + i * (wbw + wgap), wMidY - h / 2, wbw, h, 3);
    ctx.fill();
  });

  const titleX = PAD + wTotalW + 18;
  ctx.fillStyle = toRgb(accent, 0.55);
  ctx.font = '300 20px "DM Sans",sans-serif';
  ctx.fillText('YOUR PERSONAL', titleX, 60);
  ctx.fillStyle = '#f2ece0';
  ctx.font = 'italic 48px Georgia,serif';
  ctx.fillText('Album ', titleX, 108);
  const aw = ctx.measureText('Album ').width;
  ctx.fillStyle = accentStr;
  ctx.font = '48px Georgia,serif';
  ctx.fillText('Rater', titleX + aw, 108);

  // Date — right aligned
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const s = d.startDate, e = new Date(d.endDate);
  e.setDate(e.getDate() - 1);
  const dateStr = months[s.getMonth()] + ' ' + s.getDate() + ' – ' + months[e.getMonth()] + ' ' + e.getDate() + ', ' + e.getFullYear();
  ctx.fillStyle = toRgb(accent, 0.5);
  ctx.font = '500 22px "DM Sans",sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(dateStr.toUpperCase(), CW - PAD, 108);
  ctx.textAlign = 'left';

  rule(ctx, PAD, 129, CW - PAD * 2, accentStr);

  // ── ZONE 2: Stats (130–270) ──
  const statsY = 155;
  const statW = (CW - PAD * 2) / 4;
  const statsData = [
    { val: String(d.totalRated), label: 'RATED', color: accent },
    { val: String(d.totalStarred), label: 'STARRED', color: d.accentColors[1] || accent },
    { val: d.totalMins > 0 ? Math.round(d.totalMins) + 'm' : '—', label: 'MINUTES', color: d.accentColors[2] || accent },
    { val: d.avgScore, label: 'AVG SCORE', color: accent }
  ];
  statsData.forEach(function(stat, i) {
    const sx = PAD + i * statW;
    ctx.fillStyle = toRgb(stat.color);
    ctx.font = 'italic bold 62px Georgia,serif';
    ctx.fillText(stat.val, sx, statsY + 68);
    ctx.fillStyle = '#7a6a50';
    ctx.font = '600 18px "DM Sans",sans-serif';
    ctx.fillText(stat.label, sx, statsY + 94);
  });

  rule(ctx, PAD, 269, CW - PAD * 2, '#d4c8b0');

  // ── ZONE 3: Top 3 Albums (270–630) ──
  // cardH is derived strictly from zone: 630 - 310 (start after label) = 320px cards
  const albumLabelY = 280;
  const cardStartY = 300;
  const cardH = 630 - cardStartY - 10; // 320px, guaranteed in zone
  const cardGap = 14;
  const cardW = Math.floor((CW - PAD * 2 - cardGap * 2) / 3);
  const artSz = Math.min(cardW - 20, cardH - 130); // art never taller than card allows text

  ctx.fillStyle = '#9a8a6a';
  ctx.font = '600 18px "DM Sans",sans-serif';
  ctx.fillText('TOP ALBUMS THIS WEEK', PAD, albumLabelY + 16);

  for (let i = 0; i < 3; i++) {
    const cx = PAD + i * (cardW + cardGap);
    const cy = cardStartY;
    const r = d.top3[i];
    const cardAccent = d.accentColors[i] || accent;

    // Card bg
    ctx.fillStyle = '#1a1410';
    ctx.strokeStyle = toRgb(cardAccent, 0.3);
    ctx.lineWidth = 1;
    rrect(ctx, cx, cy, cardW, cardH, 8);
    ctx.fill();
    ctx.stroke();

    // Color wash inside card
    const cardBg = ctx.createLinearGradient(cx, cy, cx + cardW, cy + cardH);
    cardBg.addColorStop(0, toRgb(cardAccent, 0.08));
    cardBg.addColorStop(1, 'transparent');
    ctx.fillStyle = cardBg;
    rrect(ctx, cx, cy, cardW, cardH, 8);
    ctx.fill();

    // Top stripe
    ctx.fillStyle = toRgb(cardAccent);
    ctx.fillRect(cx, cy, cardW, 5);

    if (r) {
      const artY = cy + 14;

      // Album art or placeholder
      if (d.artImages[i]) {
        ctx.save();
        rrect(ctx, cx + 10, artY, artSz, artSz, 6);
        ctx.clip();
        ctx.drawImage(d.artImages[i], cx + 10, artY, artSz, artSz);
        ctx.restore();
      } else {
        ctx.fillStyle = toRgb(cardAccent, 0.1);
        rrect(ctx, cx + 10, artY, artSz, artSz, 6);
        ctx.fill();
        ctx.fillStyle = toRgb(cardAccent, 0.35);
        ctx.font = '36px "DM Sans",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('♪', cx + 10 + artSz / 2, artY + artSz / 2 + 12);
        ctx.textAlign = 'left';
      }

      // Rank badge
      ctx.fillStyle = toRgb(cardAccent);
      rrect(ctx, cx + 10, artY, 40, 28, 4);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold 15px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('#' + (i + 1), cx + 30, artY + 19);
      ctx.textAlign = 'left';

      // Text — strictly below art
      const tx = cx + 10;
      const tmx = cardW - 20;
      const textY = artY + artSz + 14;

      ctx.fillStyle = '#f2ece0';
      ctx.font = 'bold 22px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.name, tmx), tx, textY);

      ctx.fillStyle = toRgb(cardAccent, 0.75);
      ctx.font = '400 18px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.artist, tmx), tx, textY + 24);

      ctx.fillStyle = toRgb(cardAccent);
      ctx.font = 'italic bold 38px Georgia,serif';
      const rs = String(r.rating);
      ctx.fillText(rs, tx, textY + 66);
      const rw = ctx.measureText(rs).width;
      ctx.fillStyle = '#8a7a5a';
      ctx.font = '400 18px "DM Sans",sans-serif';
      ctx.fillText('/ 10', tx + rw + 6, textY + 60);

      // Minutes — only draw if it fits inside card
      const minsVal = d.albumMinsMap ? (d.albumMinsMap[r.albums.name] || 0) : 0;
      const minsY = textY + 86;
      if (minsVal > 0 && minsY < cy + cardH - 8) {
        ctx.fillStyle = toRgb(cardAccent, 0.5);
        ctx.font = '400 15px "DM Sans",sans-serif';
        ctx.fillText(minsVal + 'm this week', tx, minsY);
      }
    }
  }

  rule(ctx, PAD, 629, CW - PAD * 2, '#d4c8b0');

  // ── ZONE 4: Starred Songs — 3-col compact (630–790) ──
  // Each tile is (790 - 670) / rows tall. Max 9 songs in 3 rows of 3.
  const songsLabelY = 640;
  const songsDrawStart = 658;
  const songsDrawEnd = 788; // hard ceiling — never exceed this
  const maxSongs = Math.min(d.starredSongs.length, 9);
  const numRows = Math.ceil(maxSongs / 3);
  const tileGap = 10;
  const tileH = numRows > 0
    ? Math.min(56, Math.floor((songsDrawEnd - songsDrawStart - tileGap * (numRows - 1)) / numRows))
    : 56;
  const tileW = Math.floor((CW - PAD * 2 - tileGap * 2) / 3);

  ctx.fillStyle = '#9a8a6a';
  ctx.font = '600 18px "DM Sans",sans-serif';
  ctx.fillText('STARRED SONGS', PAD, songsLabelY + 14);

  if (maxSongs === 0) {
    ctx.fillStyle = '#b4a888';
    ctx.font = 'italic 24px Georgia,serif';
    ctx.fillText('No starred songs this week', PAD, songsDrawStart + 40);
  } else {
    for (let i = 0; i < maxSongs; i++) {
      const sg = d.starredSongs[i];
      const col = i % 3;
      const row = Math.floor(i / 3);
      const tileX = PAD + col * (tileW + tileGap);
      const tileY = songsDrawStart + row * (tileH + tileGap);
      const capR = tileH / 2;
      const tileAccent = d.accentColors[i % Math.max(d.accentColors.length, 1)] || accent;

      // Hard guard — skip if tile would exceed zone
      if (tileY + tileH > songsDrawEnd) continue;

      // Tile bg
      ctx.fillStyle = '#1a1410';
      rrect(ctx, tileX, tileY, tileW, tileH, capR);
      ctx.fill();

      // Color wash
      const tw = ctx.createLinearGradient(tileX, tileY, tileX + tileW, tileY);
      tw.addColorStop(0, toRgb(tileAccent, 0.12));
      tw.addColorStop(0.4, toRgb(tileAccent, 0.03));
      tw.addColorStop(1, 'transparent');
      ctx.fillStyle = tw;
      rrect(ctx, tileX, tileY, tileW, tileH, capR);
      ctx.fill();

      // Border
      ctx.strokeStyle = toRgb(lighten(tileAccent, 0.2), 0.25);
      ctx.lineWidth = 1;
      rrect(ctx, tileX, tileY, tileW, tileH, capR);
      ctx.stroke();

      // Circular star cap
      ctx.fillStyle = toRgb(tileAccent);
      ctx.beginPath();
      ctx.arc(tileX + capR, tileY + capR, capR, 0, Math.PI * 2);
      ctx.fill();

      const starSz = Math.round(tileH * 0.3);
      ctx.fillStyle = '#000';
      ctx.font = 'bold ' + starSz + 'px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('★', tileX + capR, tileY + capR + starSz * 0.35);
      ctx.textAlign = 'left';

      // Song text — measured against actual available width
      const textX = tileX + capR * 2 + 8;
      const textMaxW = tileW - capR * 2 - 16;
      const songSz = tileH >= 52 ? 20 : 17;
      const metaSz = tileH >= 52 ? 16 : 13;

      ctx.fillStyle = '#f2ece0';
      ctx.font = '600 ' + songSz + 'px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.song, textMaxW), textX, tileY + tileH * 0.44);

      ctx.fillStyle = toRgb(tileAccent, 0.65);
      ctx.font = '400 ' + metaSz + 'px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.artist + ' · ' + sg.album, textMaxW), textX, tileY + tileH * 0.76);
    }
  }

  rule(ctx, PAD, 789, CW - PAD * 2, '#d4c8b0');

  // ── ZONE 5: Stacked Rating Bar (790–960) ──
  // Shows all-time distribution with this week highlighted
  const ratingLabelY = 800;
  const barY = 826;
  const barH = 56;
  const barW = CW - PAD * 2;

  ctx.fillStyle = '#9a8a6a';
  ctx.font = '600 18px "DM Sans",sans-serif';
  ctx.fillText('RATINGS — ALL TIME + THIS WEEK', PAD, ratingLabelY + 14);

  // Background track
  ctx.fillStyle = '#e0d8c8';
  rrect(ctx, PAD, barY, barW, barH, barH / 2);
  ctx.fill();

  // Calculate proportional widths from d.ratingBuckets
  const buckets = d.ratingBuckets || { '1-4': 4, '5-6': 8, '7-8': 22, '9-10': 13 };
  const totalAllTime = d.totalAllTime || (buckets['1-4'] + buckets['5-6'] + buckets['7-8'] + buckets['9-10']);
  const safe = Math.max(totalAllTime, 1);

  const seg1W = Math.round((buckets['1-4'] / safe) * barW);
  const seg2W = Math.round((buckets['5-6'] / safe) * barW);
  const seg3W = Math.round((buckets['7-8'] / safe) * barW);
  const seg4W = barW - seg1W - seg2W - seg3W;

  // Draw segments with rounded caps at start/end only
  // Segment 1: 1-4, coral
  ctx.fillStyle = '#d4907a';
  rrect(ctx, PAD, barY, seg1W, barH, barH / 2);
  ctx.fill();
  // Square off right side of segment 1
  if (seg1W > barH / 2) {
    ctx.fillRect(PAD + barH / 2, barY, seg1W - barH / 2, barH);
  }

  // Segment 2: 5-6, amber
  ctx.fillStyle = '#c49a4a';
  ctx.fillRect(PAD + seg1W, barY, seg2W, barH);

  // Segment 3: 7-8, teal
  ctx.fillStyle = '#4a9e8a';
  ctx.fillRect(PAD + seg1W + seg2W, barY, seg3W, barH);

  // Segment 4: 9-10, green — right pill cap
  const seg4X = PAD + seg1W + seg2W + seg3W;
  ctx.fillStyle = '#3a9e4a';
  ctx.fillRect(seg4X, barY, seg4W - barH / 2, barH);
  rrect(ctx, seg4X + seg4W - barH, barY, barH, barH, barH / 2);
  ctx.fill();

  // This-week highlight overlay — right portion of bar
  const thisWeekPct = d.totalRated / Math.max(safe + d.totalRated, 1);
  const thisWeekW = Math.max(Math.round(thisWeekPct * barW), 80);
  const highlightX = PAD + barW - thisWeekW;

  ctx.fillStyle = toRgb(accent, 0.2);
  rrect(ctx, highlightX, barY, thisWeekW, barH, barH / 2);
  ctx.fill();

  ctx.strokeStyle = accentStr;
  ctx.lineWidth = 2.5;
  rrect(ctx, highlightX, barY - 1, thisWeekW + 1, barH + 2, barH / 2 + 1);
  ctx.stroke();

  // Callout above highlight
  const calloutCX = highlightX + thisWeekW / 2;
  ctx.strokeStyle = accentStr;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(calloutCX, barY - 2);
  ctx.lineTo(calloutCX, barY - 24);
  ctx.stroke();
  ctx.setLineDash([]);

  const tag = '+' + d.totalRated + ' THIS WEEK';
  ctx.font = 'bold 18px "DM Sans",sans-serif';
  const tagW = ctx.measureText(tag).width + 24;
  ctx.fillStyle = accentStr;
  rrect(ctx, calloutCX - tagW / 2, barY - 48, tagW, 26, 13);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(tag, calloutCX, barY - 30);
  ctx.textAlign = 'left';

  // Bucket labels below
  const labelCenters = [
    PAD + seg1W / 2,
    PAD + seg1W + seg2W / 2,
    PAD + seg1W + seg2W + seg3W / 2,
    seg4X + seg4W / 2
  ];
  const bucketLabels = ['1–4', '5–6', '7–8', '9–10'];
  const bucketCounts = [buckets['1-4'], buckets['5-6'], buckets['7-8'], buckets['9-10']];
  const bucketColors = ['#d4907a', '#c49a4a', '#4a9e8a', '#3a9e4a'];

  // Counts inside bar
  bucketLabels.forEach(function(lbl, i) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(bucketCounts[i]), labelCenters[i], barY + barH * 0.62);
  });
  ctx.textAlign = 'left';

  // Labels below bar
  bucketLabels.forEach(function(lbl, i) {
    ctx.fillStyle = bucketColors[i];
    ctx.font = '600 16px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(lbl, labelCenters[i], barY + barH + 22);
  });
  ctx.textAlign = 'left';

  // Legend
  ctx.fillStyle = toRgb(accent, 0.4);
  rrect(ctx, PAD, barY + barH + 36, 12, 12, 3);
  ctx.fill();
  ctx.fillStyle = '#9a8a6a';
  ctx.font = '400 16px "DM Sans",sans-serif';
  ctx.fillText('= this week\'s additions', PAD + 18, barY + barH + 47);

  rule(ctx, PAD, 959, CW - PAD * 2, '#d4c8b0');

  // ── ZONE 6: Play Timeline (960–1130) ──
  // STRICTLY bounded: chart draws only within [982, 1112]
  // Dynamic Y axis — never touches zone boundaries
  const chartLabelY = 970;
  const chartX = PAD + 52;         // left edge (after Y labels)
  const chartY = 996;              // top of drawing area
  const chartW = CW - PAD * 2 - 52 - 16; // right margin 16px
  const chartH = 1110 - chartY;   // = 114px — hard ceiling 20px above rule
  const chartBottom = chartY + chartH;

  ctx.fillStyle = '#9a8a6a';
  ctx.font = '600 18px "DM Sans",sans-serif';
  ctx.fillText('PLAY TIMELINE — MINUTES PER DAY', PAD, chartLabelY + 14);

  const dates = Object.keys(d.byDate).sort();

  if (dates.length < 2) {
    ctx.fillStyle = '#b4a888';
    ctx.font = 'italic 24px Georgia,serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough data yet', chartX + chartW / 2, chartY + chartH / 2);
    ctx.textAlign = 'left';
  } else {
    // Dynamic max with 20% headroom, rounded to nearest 10
    let rawMax = 0;
    dates.forEach(function(dt) {
      d.top5forChart.forEach(function(a) {
        rawMax = Math.max(rawMax, (d.byDate[dt] && d.byDate[dt][a]) || 0);
      });
    });
    if (rawMax === 0) rawMax = 1;
    const maxVal = Math.ceil((rawMax * 1.2) / 10) * 10;

    // 3 grid lines only — plenty for the compact height
    const gridPcts = [0, 0.5, 1];
    gridPcts.forEach(function(pct) {
      const gy = chartBottom - pct * chartH;
      // Clamp: never above chartY or below chartBottom
      if (gy < chartY || gy > chartBottom) return;
      ctx.strokeStyle = '#d4c8b0';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(chartX, gy);
      ctx.lineTo(chartX + chartW, gy);
      ctx.stroke();
      if (pct > 0) {
        ctx.fillStyle = '#b4a888';
        ctx.font = '17px "DM Sans",sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(maxVal * pct) + 'm', chartX - 6, gy + 6);
        ctx.textAlign = 'left';
      }
    });

    // X axis labels — Mondays only, drawn at chartBottom + 20
    ctx.fillStyle = '#b4a888';
    ctx.font = '17px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    dates.forEach(function(dt, i) {
      const dtObj = new Date(dt + 'T00:00:00');
      if (i === 0 || dtObj.getDay() === 1) {
        const px = chartX + (i / Math.max(dates.length - 1, 1)) * chartW;
        ctx.fillText((dtObj.getMonth() + 1) + '/' + dtObj.getDate(), px, chartBottom + 22);
      }
    });
    ctx.textAlign = 'left';

    // Point calculation — Y is clamped to [chartY, chartBottom]
    function ptY(val) {
      const raw = chartBottom - (val / maxVal) * chartH;
      return Math.min(chartBottom, Math.max(chartY, raw));
    }

    // Area fills first
    d.top5forChart.forEach(function(album, ai) {
      const pts = dates.map(function(dt, i) {
        return {
          px: chartX + (i / Math.max(dates.length - 1, 1)) * chartW,
          py: ptY((d.byDate[dt] && d.byDate[dt][album]) || 0)
        };
      });
      ctx.beginPath();
      ctx.moveTo(pts[0].px, chartBottom);
      pts.forEach(function(p) { ctx.lineTo(p.px, p.py); });
      ctx.lineTo(pts[pts.length - 1].px, chartBottom);
      ctx.closePath();
      ctx.fillStyle = d.lineColors[ai] + '12';
      ctx.fill();
    });

    // Lines + dots
    d.top5forChart.forEach(function(album, ai) {
      const pts = dates.map(function(dt, i) {
        return {
          px: chartX + (i / Math.max(dates.length - 1, 1)) * chartW,
          py: ptY((d.byDate[dt] && d.byDate[dt][album]) || 0)
        };
      });
      ctx.beginPath();
      ctx.strokeStyle = d.lineColors[ai];
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) {
        const cpx = (pts[i - 1].px + pts[i].px) / 2;
        ctx.bezierCurveTo(cpx, pts[i - 1].py, cpx, pts[i].py, pts[i].px, pts[i].py);
      }
      ctx.stroke();
      pts.forEach(function(p) {
        ctx.beginPath();
        ctx.arc(p.px, p.py, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = d.lineColors[ai];
        ctx.fill();
      });
    });

    // Legend — top-right inside chart, small
    let ly = chartY + 4;
    d.top5forChart.forEach(function(album, ai) {
      const lx = chartX + chartW;
      ctx.fillStyle = d.lineColors[ai];
      ctx.fillRect(lx - 200, ly + 2, 12, 3);
      ctx.font = '16px "DM Sans",sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, album, 182), lx - 182, ly + 12);
      ly += 22;
    });
  }

  rule(ctx, PAD, 1129, CW - PAD * 2, '#d4c8b0');

  // ── ZONE 7: MCM Footer (1130–1920) ──
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(0, 1130, CW, CH - 1130);

  // Diagonal accent at top of footer
  ctx.save();
  const footerDiag = ctx.createLinearGradient(0, 1130, CW, 1220);
  footerDiag.addColorStop(0, toRgb(accent, 0.18));
  footerDiag.addColorStop(1, 'transparent');
  ctx.fillStyle = footerDiag;
  ctx.fillRect(0, 1130, CW, 90);
  ctx.restore();

  rule(ctx, PAD, 1131, CW - PAD * 2, accentStr);

  // Starburst bottom-left
  starburst(ctx, 70, 1130 + (CH - 1130) / 2, 90, 20, toRgb(accent, 0.14));

  // Dot grid bottom-right
  dotgrid(ctx, CW - PAD - 90, 1180, 5, 4, 20, 2.5, toRgb(accent, 0.2));

  // MCM arc footer
  ctx.save();
  ctx.strokeStyle = toRgb(accent, 0.18);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(300, 1130);
  ctx.quadraticCurveTo(500, 1200, 700, 1130);
  ctx.stroke();
  ctx.restore();

  // Watermark
  ctx.fillStyle = toRgb(accent, 0.22);
  ctx.font = '400 20px "DM Sans",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater  ·  sillymcwilly1.github.io/2026-Albums', CW / 2, 1130 + (CH - 1130) / 2 + 10);
  ctx.textAlign = 'left';

  // Bottom edge
  ctx.fillStyle = accentStr;
  ctx.fillRect(0, CH - 5, CW, 5);
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
