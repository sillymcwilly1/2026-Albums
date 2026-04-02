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
  // Per-bucket breakdown of THIS WEEK's ratings
  const weekRatingBuckets = { '1-4': 0, '5-6': 0, '7-8': 0, '9-10': 0 };
  weekRatings.forEach(function(r) {
    if (r.rating >= 9) weekRatingBuckets['9-10']++;
    else if (r.rating >= 7) weekRatingBuckets['7-8']++;
    else if (r.rating >= 5) weekRatingBuckets['5-6']++;
    else weekRatingBuckets['1-4']++;
  });
  const totalAllTimeCount = (allRatings || []).length;

  document.getElementById('week-loading').classList.add('hidden');

  drawCard({
    startDate, endDate, top3, artImages, totalMins, avgScore,
    totalRated: weekRatings.length, totalStarred, starredSongs,
    byDate, top5forChart, lineColors,
    blended, accentColors, albumMinsMap: albumMins,
    ratingBuckets: ratingBuckets,
    totalAllTime: totalAllTimeCount,
    weekRatingBuckets: weekRatingBuckets
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
// WEEK IN REVIEW — drawCard()
//
// Zone map (1080 × 1920):
//   0    –  180   MCM Header (dark)
//   180  –  440   Stats row
//   440  –  900   Top 3 Albums
//   900  – 1140   Starred Songs (3-col compact tiles)
//   1140 – 1460   Stacked Rating Rows (4 buckets × row)
//   1460 – 1730   Play Timeline
//   1730 – 1920   MCM Footer (dark)
//
// Every section derives its pixel coordinates from these constants.
// Nothing is allowed to draw outside its zone.
// ================================================================

const CW = 1080, CH = 1920, PAD = 72;

const Z = {
  headerEnd:   180,
  statsEnd:    440,
  albumsEnd:   900,
  songsEnd:    1140,
  ratingEnd:   1460,
  chartEnd:    1730,
  footerStart: 1730,
};

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
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.4;
  ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(cx-32,y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx+32,y); ctx.lineTo(x+w,y); ctx.stroke();
  ctx.globalAlpha = 1;
  [-18,0,18].forEach(function(dx,i) {
    ctx.fillStyle = color; ctx.globalAlpha = i===1?0.95:0.35;
    ctx.beginPath(); ctx.arc(cx+dx,y,i===1?5:3,0,Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha = 1; ctx.restore();
}

function sectionLabel(ctx, text, x, y, color) {
  ctx.fillStyle = color;
  ctx.font = '600 26px "DM Sans",sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillText(text, x, y);
  ctx.letterSpacing = '0px';
}

function drawCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  const accent = d.blended;
  const accentStr = toRgb(accent);
  const c2 = d.accentColors[1] || accent;
  const c3 = d.accentColors[2] || accent;

  // ── BACKGROUND — warm cream with 3-color album washes ──
  ctx.fillStyle = '#f2ece0';
  ctx.fillRect(0, 0, CW, CH);

  // Wash 1 — accent top-right diagonal
  const bw1 = ctx.createLinearGradient(CW*0.2, 0, CW, CH*0.55);
  bw1.addColorStop(0, toRgb(accent, 0.0));
  bw1.addColorStop(0.5, toRgb(accent, 0.09));
  bw1.addColorStop(1, toRgb(accent, 0.18));
  ctx.fillStyle = bw1; ctx.fillRect(0, 0, CW, CH);

  // Wash 2 — album 2 bottom-left
  const bw2 = ctx.createLinearGradient(0, CH*0.45, CW*0.65, CH);
  bw2.addColorStop(0, toRgb(c2, 0.1));
  bw2.addColorStop(1, toRgb(c2, 0.0));
  ctx.fillStyle = bw2; ctx.fillRect(0, 0, CW, CH);

  // Wash 3 — album 3 mid horizontal band
  const bw3 = ctx.createLinearGradient(0, CH*0.38, CW, CH*0.62);
  bw3.addColorStop(0, toRgb(c3, 0.0));
  bw3.addColorStop(0.5, toRgb(c3, 0.07));
  bw3.addColorStop(1, toRgb(c3, 0.0));
  ctx.fillStyle = bw3; ctx.fillRect(0, 0, CW, CH);

  // ══════════════════════════════════════════
  // ZONE 1 — MCM Header (0 – headerEnd=180)
  // ══════════════════════════════════════════
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(0, 0, CW, Z.headerEnd);

  // Top accent stripe
  ctx.fillStyle = accentStr;
  ctx.fillRect(0, 0, CW, 6);

  // Decorations
  starburst(ctx, CW-80, 80, 130, 22, toRgb(accent, 0.22));
  dotgrid(ctx, PAD, 26, 6, 3, 22, 3, toRgb(accent, 0.35));

  // MCM arc
  ctx.save();
  ctx.strokeStyle = toRgb(accent, 0.22);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, Z.headerEnd);
  ctx.quadraticCurveTo(180, 70, 360, Z.headerEnd);
  ctx.stroke();
  ctx.restore();

  // Waveform bars
  const wh = [8,18,30,42,30,18,8], wbw = 11, wgap = 6;
  const wTotalW = wh.length*(wbw+wgap)-wgap;
  const wMidY = 108;
  wh.forEach(function(h, i) {
    const t = h/42;
    ctx.fillStyle = toRgb([
      Math.round(accent[0]*t + 40*(1-t)),
      Math.round(accent[1]*t + 40*(1-t)),
      Math.round(accent[2]*t + 40*(1-t))
    ]);
    ctx.beginPath();
    ctx.roundRect(PAD + i*(wbw+wgap), wMidY-h/2, wbw, h, 4);
    ctx.fill();
  });

  // Wordmark
  const titleX = PAD + wTotalW + 22;
  ctx.fillStyle = toRgb(accent, 0.55);
  ctx.font = '300 24px "DM Sans",sans-serif';
  ctx.fillText('YOUR PERSONAL', titleX, 80);
  ctx.fillStyle = '#f2ece0';
  ctx.font = 'italic 58px Georgia,serif';
  ctx.fillText('Album ', titleX, 148);
  const aw = ctx.measureText('Album ').width;
  ctx.fillStyle = accentStr;
  ctx.font = '58px Georgia,serif';
  ctx.fillText('Rater', titleX + aw, 148);

  // Date right-aligned
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const s = d.startDate, eCopy = new Date(d.endDate);
  eCopy.setDate(eCopy.getDate()-1);
  const dateStr = months[s.getMonth()]+' '+s.getDate()+' – '+months[eCopy.getMonth()]+' '+eCopy.getDate()+', '+eCopy.getFullYear();
  ctx.fillStyle = toRgb(accent, 0.55);
  ctx.font = '500 26px "DM Sans",sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(dateStr.toUpperCase(), CW-PAD, 148);
  ctx.textAlign = 'left';

  rule(ctx, PAD, Z.headerEnd-1, CW-PAD*2, accentStr);

  // ══════════════════════════════════════════
  // ZONE 2 — Stats (headerEnd=180 – statsEnd=440)
  // ══════════════════════════════════════════
  // 4 large stat blocks spread across zone height
  const statZoneH = Z.statsEnd - Z.headerEnd;           // 260px
  const statNumY = Z.headerEnd + statZoneH * 0.62;      // baseline for numbers
  const statLblY = Z.headerEnd + statZoneH * 0.82;      // baseline for labels
  const statW = (CW - PAD*2) / 4;

  const statsData = [
    { val: String(d.totalRated),  label: 'RATED',     color: accent },
    { val: String(d.totalStarred),label: 'STARRED',   color: c2 },
    { val: d.totalMins > 0 ? Math.round(d.totalMins)+'m' : '—', label: 'MINUTES', color: c3 },
    { val: d.avgScore,            label: 'AVG SCORE', color: accent }
  ];

  statsData.forEach(function(stat, i) {
    const sx = PAD + i*statW;
    ctx.fillStyle = toRgb(stat.color);
    ctx.font = 'italic bold 82px Georgia,serif';
    ctx.fillText(stat.val, sx, statNumY);
    ctx.fillStyle = '#7a6a50';
    ctx.font = '600 24px "DM Sans",sans-serif';
    ctx.fillText(stat.label, sx, statLblY);
  });

  rule(ctx, PAD, Z.statsEnd-1, CW-PAD*2, '#d4c8b0');

  // ══════════════════════════════════════════
  // ZONE 3 — Top 3 Albums (statsEnd=440 – albumsEnd=900)
  // ══════════════════════════════════════════
  const albumZoneH = Z.albumsEnd - Z.statsEnd;          // 460px
  const albumLabelY = Z.statsEnd + 36;
  const cardStartY = Z.statsEnd + 62;
  const cardH = Z.albumsEnd - cardStartY - 12;          // strictly inside zone
  const cardGap = 16;
  const cardW = Math.floor((CW - PAD*2 - cardGap*2) / 3);
  const artSz = Math.min(cardW - 24, Math.floor(cardH * 0.55)); // art = 55% of card height max

  sectionLabel(ctx, 'TOP ALBUMS THIS WEEK', PAD, albumLabelY, '#9a8a6a');

  for (let i = 0; i < 3; i++) {
    const cx = PAD + i*(cardW+cardGap);
    const cy = cardStartY;
    const r = d.top3[i];
    const ca = d.accentColors[i] || accent;

    // Card shell
    ctx.fillStyle = '#1a1410';
    ctx.strokeStyle = toRgb(ca, 0.35);
    ctx.lineWidth = 1.5;
    rrect(ctx, cx, cy, cardW, cardH, 10);
    ctx.fill(); ctx.stroke();

    // Color wash inside
    const cg = ctx.createLinearGradient(cx, cy, cx+cardW, cy+cardH);
    cg.addColorStop(0, toRgb(ca, 0.1));
    cg.addColorStop(1, 'transparent');
    ctx.fillStyle = cg;
    rrect(ctx, cx, cy, cardW, cardH, 10);
    ctx.fill();

    // Top stripe
    ctx.fillStyle = toRgb(ca);
    ctx.fillRect(cx, cy, cardW, 6);

    if (r) {
      const artY = cy + 16;
      // Art
      if (d.artImages[i]) {
        ctx.save();
        rrect(ctx, cx+12, artY, artSz, artSz, 6);
        ctx.clip();
        ctx.drawImage(d.artImages[i], cx+12, artY, artSz, artSz);
        ctx.restore();
      } else {
        ctx.fillStyle = toRgb(ca, 0.1);
        rrect(ctx, cx+12, artY, artSz, artSz, 6);
        ctx.fill();
        ctx.fillStyle = toRgb(ca, 0.4);
        ctx.font = '48px "DM Sans",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('♪', cx+12+artSz/2, artY+artSz/2+16);
        ctx.textAlign = 'left';
      }

      // Rank badge
      ctx.fillStyle = toRgb(ca);
      rrect(ctx, cx+12, artY, 44, 30, 5);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold 17px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('#'+(i+1), cx+34, artY+21);
      ctx.textAlign = 'left';

      // Text block — anchored below art, strictly inside card
      const tx = cx+12;
      const tmx = cardW - 24;
      const ty = artY + artSz + 18;

      ctx.fillStyle = '#f2ece0';
      ctx.font = 'bold 26px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.name, tmx), tx, ty);

      ctx.fillStyle = toRgb(ca, 0.78);
      ctx.font = '400 21px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, r.albums.artist, tmx), tx, ty+30);

      ctx.fillStyle = toRgb(ca);
      ctx.font = 'italic bold 48px Georgia,serif';
      const rs = String(r.rating);
      ctx.fillText(rs, tx, ty+82);
      const rw = ctx.measureText(rs).width;
      ctx.fillStyle = '#8a7a5a';
      ctx.font = '400 22px "DM Sans",sans-serif';
      ctx.fillText('/ 10', tx+rw+8, ty+74);

      // Minutes — only if room
      const minsVal = d.albumMinsMap ? (d.albumMinsMap[r.albums.name]||0) : 0;
      const minsY = ty+104;
      if (minsVal > 0 && minsY < cy+cardH-10) {
        ctx.fillStyle = toRgb(ca, 0.52);
        ctx.font = '400 19px "DM Sans",sans-serif';
        ctx.fillText(minsVal+'m this week', tx, minsY);
      }
    }
  }

  rule(ctx, PAD, Z.albumsEnd-1, CW-PAD*2, '#d4c8b0');

  // ══════════════════════════════════════════
  // ZONE 4 — Starred Songs (albumsEnd=900 – songsEnd=1140)
  // ══════════════════════════════════════════
  const songsZoneH = Z.songsEnd - Z.albumsEnd;          // 240px
  const songsLabelY = Z.albumsEnd + 38;
  const songsDrawStart = Z.albumsEnd + 62;
  const songsDrawEnd = Z.songsEnd - 10;                 // hard ceiling
  const maxSongs = Math.min(d.starredSongs.length, 9);
  const numRows = Math.max(1, Math.ceil(maxSongs/3));
  const tileGapX = 12, tileGapY = 10;
  const tileW = Math.floor((CW - PAD*2 - tileGapX*2) / 3);
  const tileH = Math.min(60, Math.floor((songsDrawEnd - songsDrawStart - tileGapY*(numRows-1)) / numRows));

  sectionLabel(ctx, 'STARRED SONGS', PAD, songsLabelY, '#9a8a6a');

  if (maxSongs === 0) {
    ctx.fillStyle = '#b4a888';
    ctx.font = 'italic 28px Georgia,serif';
    ctx.fillText('No starred songs this week', PAD, songsDrawStart+44);
  } else {
    for (let i = 0; i < maxSongs; i++) {
      const sg = d.starredSongs[i];
      const col = i%3, row = Math.floor(i/3);
      const tileX = PAD + col*(tileW+tileGapX);
      const tileY = songsDrawStart + row*(tileH+tileGapY);
      const capR = tileH/2;
      const ta = d.accentColors[i % Math.max(d.accentColors.length,1)] || accent;

      if (tileY + tileH > songsDrawEnd) continue; // hard guard

      // Pill bg
      ctx.fillStyle = '#1a1410';
      rrect(ctx, tileX, tileY, tileW, tileH, capR);
      ctx.fill();

      // Color wash
      const tw = ctx.createLinearGradient(tileX, tileY, tileX+tileW, tileY);
      tw.addColorStop(0, toRgb(ta, 0.14));
      tw.addColorStop(0.4, toRgb(ta, 0.04));
      tw.addColorStop(1, 'transparent');
      ctx.fillStyle = tw;
      rrect(ctx, tileX, tileY, tileW, tileH, capR);
      ctx.fill();

      // Border
      ctx.strokeStyle = toRgb(lighten(ta, 0.2), 0.28);
      ctx.lineWidth = 1;
      rrect(ctx, tileX, tileY, tileW, tileH, capR);
      ctx.stroke();

      // Star cap
      ctx.fillStyle = toRgb(ta);
      ctx.beginPath();
      ctx.arc(tileX+capR, tileY+capR, capR, 0, Math.PI*2);
      ctx.fill();
      const starSz = Math.round(tileH*0.32);
      ctx.fillStyle = '#000';
      ctx.font = 'bold '+starSz+'px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('★', tileX+capR, tileY+capR+starSz*0.36);
      ctx.textAlign = 'left';

      // Text
      const textX = tileX+capR*2+10;
      const textMaxW = tileW-capR*2-18;
      ctx.fillStyle = '#f2ece0';
      ctx.font = '600 22px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.song, textMaxW), textX, tileY+tileH*0.44);
      ctx.fillStyle = toRgb(ta, 0.68);
      ctx.font = '400 18px "DM Sans",sans-serif';
      ctx.fillText(fit(ctx, sg.artist+' · '+sg.album, textMaxW), textX, tileY+tileH*0.78);
    }
  }

  rule(ctx, PAD, Z.songsEnd-1, CW-PAD*2, '#d4c8b0');

  // ══════════════════════════════════════════
  // ZONE 5 — Stacked Rating Rows (songsEnd=1140 – ratingEnd=1460)
  // 4 bucket rows. Each row = prior count bar + this-week stack on top.
  // ══════════════════════════════════════════
  const ratingZoneH = Z.ratingEnd - Z.songsEnd;         // 320px
  const rLabelY = Z.songsEnd + 40;
  const rDrawStart = Z.songsEnd + 68;
  const rDrawEnd = Z.ratingEnd - 14;                    // hard ceiling

  sectionLabel(ctx, 'RATINGS — ALL TIME + THIS WEEK', PAD, rLabelY, '#9a8a6a');

  const buckets = d.ratingBuckets || {'1-4':4,'5-6':8,'7-8':22,'9-10':13};
  const weekBuckets = d.weekRatingBuckets || {'1-4':0,'5-6':0,'7-8':0,'9-10':0};

  const bucketDefs = [
    { key:'9-10', label:'9–10', priorColor:'#3a9e4a', weekColor:'#7cef8a', textColor:'#c8ffd0' },
    { key:'7-8',  label:'7–8',  priorColor:'#4a9e8a', weekColor:'#8aefdb', textColor:'#c0fff6' },
    { key:'5-6',  label:'5–6',  priorColor:'#c49a4a', weekColor:'#f5d07a', textColor:'#fff4cc' },
    { key:'1-4',  label:'1–4',  priorColor:'#c4705a', weekColor:'#f5a090', textColor:'#ffd8d0' },
  ];

  // Find the max total count across all buckets for proportional bar width
  const maxBucketTotal = Math.max(1, ...bucketDefs.map(function(b) {
    return (buckets[b.key]||0) + (weekBuckets[b.key]||0);
  }));

  const rowCount = bucketDefs.length;
  const rowGap = 14;
  const rowH = Math.min(56, Math.floor((rDrawEnd - rDrawStart - rowGap*(rowCount-1)) / rowCount));
  const barMaxW = CW - PAD*2 - 110; // 110px reserved for label + count on left

  bucketDefs.forEach(function(b, bi) {
    const rowY = rDrawStart + bi*(rowH+rowGap);
    if (rowY + rowH > rDrawEnd) return; // guard

    const priorCount = buckets[b.key] || 0;
    const weekCount = weekBuckets[b.key] || 0;
    const totalCount = priorCount + weekCount;
    const priorW = Math.round((priorCount / maxBucketTotal) * barMaxW);
    const weekW = Math.round((weekCount / maxBucketTotal) * barMaxW);
    const barX = PAD + 100; // bar starts after label column

    // Row label — bucket range
    ctx.fillStyle = b.priorColor;
    ctx.font = 'bold 28px "DM Sans",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(b.label, PAD+88, rowY+rowH*0.68);
    ctx.textAlign = 'left';

    // Background track
    ctx.fillStyle = '#e0d8c8';
    rrect(ctx, barX, rowY, barMaxW, rowH, rowH/2);
    ctx.fill();

    // Prior albums bar
    if (priorW > 0) {
      ctx.fillStyle = b.priorColor;
      const pw = priorW + weekW > 0 ? priorW : barMaxW; // at least something if data
      rrect(ctx, barX, rowY, Math.min(priorW, barMaxW), rowH, rowH/2);
      ctx.fill();
      // Square off right cap if week bar follows
      if (weekW > 0 && priorW > rowH/2) {
        ctx.fillRect(barX + rowH/2, rowY, priorW - rowH/2, rowH);
      }
    }

    // This-week stack — bright color on top of prior bar
    if (weekW > 0) {
      const weekX = barX + priorW;
      ctx.fillStyle = b.weekColor;
      // Left side: square if prior exists, rounded if not
      if (priorW > 0) {
        ctx.fillRect(weekX, rowY, weekW, rowH);
        // Round right cap
        rrect(ctx, weekX + weekW - rowH, rowY, rowH, rowH, rowH/2);
        ctx.fill();
      } else {
        rrect(ctx, weekX, rowY, weekW, rowH, rowH/2);
        ctx.fill();
      }

      // "NEW" label inside week segment if wide enough
      if (weekW > 80) {
        ctx.fillStyle = b.priorColor;
        ctx.font = 'bold 16px "DM Sans",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('NEW', weekX + weekW/2, rowY+rowH*0.66);
        ctx.textAlign = 'left';
      }
    }

    // Count badge — right of bar
    const badgeX = barX + Math.max(priorW + weekW, 20) + 12;
    if (badgeX < barX + barMaxW - 10) {
      ctx.fillStyle = '#9a8a6a';
      ctx.font = '500 22px "DM Sans",sans-serif';
      ctx.fillText(String(totalCount), badgeX, rowY+rowH*0.68);
    }

    // Count inside bar (always)
    if (priorCount > 0 && priorW > 48) {
      ctx.fillStyle = b.textColor;
      ctx.font = 'bold 22px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(priorCount), barX + priorW/2, rowY+rowH*0.68);
      ctx.textAlign = 'left';
    }
    if (weekCount > 0 && weekW > 48) {
      ctx.fillStyle = b.priorColor;
      ctx.font = 'bold 22px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(weekCount), barX + priorW + weekW/2, rowY+rowH*0.68);
      ctx.textAlign = 'left';
    }
  });

  // Legend
  const legendY = rDrawEnd - 4;
  ctx.fillStyle = '#c49a4a';
  ctx.fillRect(PAD, legendY-10, 18, 10);
  ctx.fillStyle = '#9a8a6a';
  ctx.font = '400 20px "DM Sans",sans-serif';
  ctx.fillText('= prior ratings', PAD+24, legendY);

  ctx.fillStyle = '#f5d07a';
  ctx.fillRect(PAD+210, legendY-10, 18, 10);
  ctx.fillStyle = '#9a8a6a';
  ctx.fillText('= this week', PAD+234, legendY);

  rule(ctx, PAD, Z.ratingEnd-1, CW-PAD*2, '#d4c8b0');

  // ══════════════════════════════════════════
  // ZONE 6 — Play Timeline (ratingEnd=1460 – chartEnd=1730)
  // Hard pixel boundaries on every element. ptY() clamps all points.
  // ══════════════════════════════════════════
  const chartLabelY = Z.ratingEnd + 40;
  const chartX = PAD + 64;           // left of chart (after Y labels)
  const chartTop = Z.ratingEnd + 72; // top pixel of plot area
  const chartBot = Z.chartEnd - 50;  // bottom pixel of plot area (leaves room for X labels)
  const chartW = CW - PAD*2 - 64 - 20;
  const chartH = chartBot - chartTop;

  sectionLabel(ctx, 'PLAY TIMELINE — MINUTES PER DAY', PAD, chartLabelY, '#9a8a6a');

  const dates = Object.keys(d.byDate).sort();

  if (dates.length < 2) {
    ctx.fillStyle = '#b4a888';
    ctx.font = 'italic 28px Georgia,serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough data yet', chartX+chartW/2, chartTop+chartH/2);
    ctx.textAlign = 'left';
  } else {
    // Dynamic max with 20% headroom
    let rawMax = 0;
    dates.forEach(function(dt) {
      d.top5forChart.forEach(function(a) {
        rawMax = Math.max(rawMax, (d.byDate[dt]&&d.byDate[dt][a])||0);
      });
    });
    if (rawMax === 0) rawMax = 1;
    const maxVal = Math.ceil((rawMax*1.2)/10)*10;

    // ptY — clamps every point strictly inside [chartTop, chartBot]
    function ptY(val) {
      const raw = chartBot - (val/maxVal)*chartH;
      return Math.min(chartBot, Math.max(chartTop, raw));
    }

    // Grid lines — 3 lines, clamped
    [0, 0.5, 1].forEach(function(pct) {
      const gy = chartBot - pct*chartH;
      if (gy < chartTop || gy > chartBot) return;
      ctx.strokeStyle = '#d4c8b0'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(chartX, gy); ctx.lineTo(chartX+chartW, gy); ctx.stroke();
      if (pct > 0) {
        ctx.fillStyle = '#b4a888';
        ctx.font = '20px "DM Sans",sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(maxVal*pct)+'m', chartX-8, gy+7);
        ctx.textAlign = 'left';
      }
    });

    // X labels — at chartBot+28, Mondays only
    ctx.fillStyle = '#b4a888';
    ctx.font = '20px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    dates.forEach(function(dt, i) {
      const dtObj = new Date(dt+'T00:00:00');
      if (i===0 || dtObj.getDay()===1) {
        const px = chartX + (i/Math.max(dates.length-1,1))*chartW;
        ctx.fillText((dtObj.getMonth()+1)+'/'+dtObj.getDate(), px, chartBot+28);
      }
    });
    ctx.textAlign = 'left';

    // Area fills first
    d.top5forChart.forEach(function(album, ai) {
      const pts = dates.map(function(dt, i) {
        return { px: chartX+(i/Math.max(dates.length-1,1))*chartW, py: ptY((d.byDate[dt]&&d.byDate[dt][album])||0) };
      });
      ctx.beginPath();
      ctx.moveTo(pts[0].px, chartBot);
      pts.forEach(function(p) { ctx.lineTo(p.px, p.py); });
      ctx.lineTo(pts[pts.length-1].px, chartBot);
      ctx.closePath();
      ctx.fillStyle = d.lineColors[ai]+'14';
      ctx.fill();
    });

    // Lines + dots
    d.top5forChart.forEach(function(album, ai) {
      const pts = dates.map(function(dt, i) {
        return { px: chartX+(i/Math.max(dates.length-1,1))*chartW, py: ptY((d.byDate[dt]&&d.byDate[dt][album])||0) };
      });
      ctx.beginPath();
      ctx.strokeStyle = d.lineColors[ai];
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) {
        const cpx = (pts[i-1].px+pts[i].px)/2;
        ctx.bezierCurveTo(cpx, pts[i-1].py, cpx, pts[i].py, pts[i].px, pts[i].py);
      }
      ctx.stroke();
      pts.forEach(function(p) {
        ctx.beginPath(); ctx.arc(p.px, p.py, 5, 0, Math.PI*2);
        ctx.fillStyle = d.lineColors[ai]; ctx.fill();
      });
    });

    // Legend — stacked top-right inside chart bounds
    let ly = chartTop + 6;
    d.top5forChart.forEach(function(album, ai) {
      const lx = chartX + chartW;
      ctx.fillStyle = d.lineColors[ai];
      ctx.fillRect(lx-230, ly+4, 16, 4);
      ctx.font = '19px "DM Sans",sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, album, 208), lx-208, ly+16);
      ly += 28;
    });
  }

  rule(ctx, PAD, Z.chartEnd-1, CW-PAD*2, '#d4c8b0');

  // ══════════════════════════════════════════
  // ZONE 7 — MCM Footer (footerStart=1730 – 1920)
  // ══════════════════════════════════════════
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(0, Z.footerStart, CW, CH-Z.footerStart);

  // Accent diagonal at top of footer
  const fd = ctx.createLinearGradient(0, Z.footerStart, CW, Z.footerStart+120);
  fd.addColorStop(0, toRgb(accent, 0.2));
  fd.addColorStop(1, 'transparent');
  ctx.fillStyle = fd;
  ctx.fillRect(0, Z.footerStart, CW, 120);

  rule(ctx, PAD, Z.footerStart+1, CW-PAD*2, accentStr);
  starburst(ctx, 80, Z.footerStart+(CH-Z.footerStart)/2, 100, 20, toRgb(accent, 0.14));
  dotgrid(ctx, CW-PAD-100, Z.footerStart+60, 5, 4, 22, 3, toRgb(accent, 0.22));

  ctx.save();
  ctx.strokeStyle = toRgb(accent, 0.2);
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(340, Z.footerStart);
  ctx.quadraticCurveTo(560, Z.footerStart+80, 780, Z.footerStart);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = toRgb(accent, 0.25);
  ctx.font = '400 24px "DM Sans",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater  ·  sillymcwilly1.github.io/2026-Albums', CW/2, Z.footerStart+(CH-Z.footerStart)/2+10);
  ctx.textAlign = 'left';

  // Bottom accent edge
  ctx.fillStyle = accentStr;
  ctx.fillRect(0, CH-6, CW, 6);
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
