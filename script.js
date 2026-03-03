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
  if (tokenData.access_token) {
    saveTokens(tokenData);
    return true;
  }
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
  const sorted = Object.entries(minuteMap).filter(function(e){ return e[1] > 0; })
    .sort(function(a,b){ return b[1]-a[1]; }).slice(0,12);
  if (sorted.length === 0) {
    document.getElementById('replayBarChart').closest('.chart-card').innerHTML +=
      '<p style="color:var(--text-muted);font-size:0.85rem;margin-top:16px;font-style:italic">No duration data yet — new plays will be tracked correctly going forward.</p>';
    return;
  }
  const labels = sorted.map(function(e){ return e[0].length > 16 ? e[0].substring(0,16)+'…' : e[0]; });
  const values = sorted.map(function(e){ return e[1]; });
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
            title: function(items){ return sorted[items[0].dataIndex][0]; },
            label: function(item){ return item.raw + ' min listened'; }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#5a5a4a', font: { size: 10, family: 'DM Sans' } }, grid: { color: '#2e2e24' } },
        y: { ticks: { color: '#5a5a4a', font: { family: 'DM Sans' }, callback: function(v){ return v + 'm'; } }, grid: { color: '#2e2e24' } }
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
  logs.forEach(function(log){
    const mins = log.duration_ms ? Math.round(log.duration_ms / 60000) : 0;
    totalMins[log.album_name] = (totalMins[log.album_name] || 0) + mins;
  });
  const top5 = Object.entries(totalMins).filter(function(e){ return e[1] > 0; })
    .sort(function(a,b){ return b[1]-a[1]; }).slice(0,5).map(function(e){ return e[0]; });
  if (top5.length === 0) return;
  const colors = ['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];
  const datasets = top5.map(function(album,i){
    return {
      label: album.length>20?album.substring(0,20)+'…':album,
      data: dates.map(function(date){ return (byDate[date]&&byDate[date][album])||0; }),
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
          callbacks: { label: function(item){ return ' '+item.dataset.label+': '+item.raw+'m'; } }
        }
      },
      scales: {
        x: { ticks: { color: '#5a5a4a', font: { size: 10, family: 'DM Sans' } }, grid: { color: '#2e2e24' } },
        y: { ticks: { color: '#5a5a4a', font: { family: 'DM Sans' }, callback: function(v){ return v+'m'; } }, grid: { color: '#2e2e24' } }
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
  const spotifyIds = albums.map(function(a){ return a.id; });
  const { data: ratedAlbums } = await db.from('albums').select('spotify_id, ratings(rating)').in('spotify_id', spotifyIds);
  const ratedMap = {};
  (ratedAlbums||[]).forEach(function(a){ if (a.ratings&&a.ratings.length>0) ratedMap[a.spotify_id]=a.ratings[0].rating; });
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
    selectedTracks = selectedTracks.filter(function(t){ return t !== name; });
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
  const sorted = [...data].sort(function(a,b){ return b.rating-a.rating; });
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
  const labels = sorted.map(function(r){ const n=r.albums.name; return n.length>16?n.substring(0,16)+'…':n; });
  const values = sorted.map(function(r){ return r.rating; });
  const colors = values.map(ratingToColor);
  const borderColors = values.map(function(v){ return v>=7?'rgba(29,185,84,0.4)':'rgba(29,185,84,0.1)'; });
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
            title: function(items){ return sorted[items[0].dataIndex].albums.name; },
            label: function(item){ const r=sorted[item.dataIndex]; return ' '+item.raw+' / 10  —  '+r.albums.artist; }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#5a5a4a', font: { size: 10, family: 'DM Sans' }, maxRotation: 45 }, grid: { color: '#2e2e24' } },
        y: { min: 0, max: 10, ticks: { color: '#5a5a4a', font: { family: 'DM Sans' }, callback: function(v){ return v%2===0?v:''; } }, grid: { color: '#2e2e24' } }
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
// ---- Week in Review ----
// ============================================================

function initWeekPage() {
  const input = document.getElementById('week-start-input');
  if (!input.value) {
    // Default to start of current week (Monday)
    const now = new Date();
    const day = now.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
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

  // 1. Fetch ratings created/updated this week
  const { data: ratings } = await db
    .from('ratings')
    .select('*, albums(*)')
    .gte('updated_at', startDate.toISOString())
    .lt('updated_at', endDate.toISOString())
    .order('rating', { ascending: false });

  // Also grab ratings with created_at in range if updated_at didn't catch them
  const { data: ratingsCreated } = await db
    .from('ratings')
    .select('*, albums(*)')
    .gte('created_at', startDate.toISOString())
    .lt('created_at', endDate.toISOString())
    .order('rating', { ascending: false });

  // Merge and deduplicate
  const allRatingsMap = {};
  [...(ratings || []), ...(ratingsCreated || [])].forEach(function(r) {
    allRatingsMap[r.id] = r;
  });
  const weekRatings = Object.values(allRatingsMap).sort(function(a,b){ return b.rating - a.rating; });

  // 2. Fetch play logs this week
  const { data: playLogs } = await db
    .from('play_logs')
    .select('*')
    .gte('logged_at', startDate.toISOString())
    .lt('logged_at', endDate.toISOString());

  if (weekRatings.length === 0 && (!playLogs || playLogs.length === 0)) {
    document.getElementById('week-loading').classList.add('hidden');
    document.getElementById('week-empty').classList.remove('hidden');
    return;
  }

  // 3. Calculate stats
  const totalMinutes = (playLogs || []).reduce(function(sum, log) {
    return sum + (log.duration_ms ? Math.round(log.duration_ms / 60000) : 0);
  }, 0);

  // Rating distribution for the week
  const ratingBuckets = { '9-10': 0, '7-8': 0, '5-6': 0, '1-4': 0 };
  weekRatings.forEach(function(r) {
    if (r.rating >= 9) ratingBuckets['9-10']++;
    else if (r.rating >= 7) ratingBuckets['7-8']++;
    else if (r.rating >= 5) ratingBuckets['5-6']++;
    else ratingBuckets['1-4']++;
  });

  // Top starred songs from top 3 rated albums this week
  const topStarred = [];
  weekRatings.slice(0, 3).forEach(function(r) {
    if (r.top_songs && r.top_songs.length > 0) {
      r.top_songs.slice(0, 2).forEach(function(song) {
        topStarred.push({ song: song, album: r.albums.name, artist: r.albums.artist });
      });
    }
  });

  // Top 3 rated this week
  const top3 = weekRatings.slice(0, 3);

  // 4. Load album art images for top 3
  const artImages = await Promise.all(top3.map(function(r) {
    return new Promise(function(resolve) {
      if (!r.albums.image_url) { resolve(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function() { resolve(img); };
      img.onerror = function() { resolve(null); };
      img.src = r.albums.image_url;
    });
  }));

  document.getElementById('week-loading').classList.add('hidden');

  // 5. Draw the card
  drawWeekCard({
    startDate: startDate,
    endDate: endDate,
    top3: top3,
    artImages: artImages,
    totalMinutes: totalMinutes,
    ratingBuckets: ratingBuckets,
    topStarred: topStarred,
    totalRated: weekRatings.length
  });

  document.getElementById('week-output').classList.remove('hidden');
}

function drawWeekCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  const W = 1080;
  const H = 1350;
  ctx.clearRect(0, 0, W, H);

  // ---- Background ----
  ctx.fillStyle = '#0e0e0b';
  ctx.fillRect(0, 0, W, H);

  // Subtle radial glow top-left
  const glow = ctx.createRadialGradient(200, 200, 0, 200, 200, 600);
  glow.addColorStop(0, 'rgba(29,185,84,0.06)');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Bottom-right warm glow
  const glow2 = ctx.createRadialGradient(900, 1150, 0, 900, 1150, 500);
  glow2.addColorStop(0, 'rgba(232,160,48,0.04)');
  glow2.addColorStop(1, 'transparent');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // ---- MCM Starburst top-right ----
  drawStarburst(ctx, W - 80, 80, 130, 24, 'rgba(29,185,84,0.07)');

  // ---- MCM Atomic dots bottom-left ----
  drawAtomicDots(ctx, 60, H - 60, 'rgba(29,185,84,0.1)');

  // ---- MCM boomerang shape ----
  ctx.save();
  ctx.strokeStyle = 'rgba(29,185,84,0.05)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(80, 700);
  ctx.quadraticCurveTo(200, 500, 80, 300);
  ctx.stroke();
  ctx.restore();

  // ---- Top green accent bar ----
  ctx.fillStyle = '#1DB954';
  ctx.fillRect(0, 0, W, 6);

  // ---- Header area ----
  // Waveform logo
  drawWaveform(ctx, 72, 70, '#1DB954');

  // "ALBUM RATER" wordmark
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '300 26px "DM Sans", sans-serif';
  ctx.letterSpacing = '8px';
  ctx.fillText('YOUR PERSONAL', 130, 68);
  ctx.fillStyle = '#f0efe8';
  ctx.font = 'italic 52px "DM Serif Display", serif';
  ctx.fillText('Album Rater', 130, 118);

  // Green accent dot after title
  ctx.fillStyle = '#1DB954';
  ctx.beginPath();
  ctx.arc(W - 72, 94, 8, 0, Math.PI * 2);
  ctx.fill();

  // ---- Date range ----
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const startLabel = months[d.startDate.getMonth()] + ' ' + d.startDate.getDate();
  const endDate2 = new Date(d.endDate); endDate2.setDate(endDate2.getDate() - 1);
  const endLabel = months[endDate2.getMonth()] + ' ' + endDate2.getDate() + ', ' + endDate2.getFullYear();
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '600 28px "DM Sans", sans-serif';
  ctx.fillText('WEEK OF ' + startLabel.toUpperCase() + ' – ' + endLabel.toUpperCase(), 72, 172);

  // ---- Horizontal rule ----
  drawMCMDivider(ctx, 72, 200, W - 144);

  // ---- Stats row ----
  const statsY = 260;
  drawStatBlock(ctx, 72, statsY, d.totalRated + '', 'ALBUMS RATED');
  drawStatBlock(ctx, 350, statsY, d.totalMinutes > 0 ? Math.round(d.totalMinutes) + 'm' : '—', 'MINS LISTENED');
  const avgRating = d.totalRated > 0
    ? (Object.values(d.top3.reduce ? d.top3 : []).reduce ? d.top3 : [])
    : null;
  // Calculate avg from top3 if available
  let avg = '—';
  if (d.top3.length > 0) {
    const sum = d.top3.reduce(function(s,r){ return s + r.rating; }, 0);
    avg = (sum / d.top3.length).toFixed(1);
  }
  drawStatBlock(ctx, 628, statsY, avg, 'AVG RATING');
  drawStatBlock(ctx, 860, statsY, d.topStarred.length + '', 'STARRED SONGS');

  // ---- Top Albums header ----
  drawMCMDivider(ctx, 72, 340, W - 144);
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '700 22px "DM Sans", sans-serif';
  ctx.fillText('TOP ALBUMS THIS WEEK', 72, 376);

  // ---- Top 3 album cards ----
  const cardY = 400;
  const cardW = 290;
  const cardH = 360;
  const cardGap = 24;
  const cardStartX = 72;

  d.top3.forEach(function(r, i) {
    const x = cardStartX + i * (cardW + cardGap);
    drawAlbumCard(ctx, x, cardY, cardW, cardH, r, d.artImages[i], i);
  });

  // Fill empty slots if fewer than 3
  for (let i = d.top3.length; i < 3; i++) {
    const x = cardStartX + i * (cardW + cardGap);
    ctx.fillStyle = '#1a1a15';
    ctx.strokeStyle = '#2e2e24';
    ctx.lineWidth = 1;
    roundRect(ctx, x, cardY, cardW, cardH, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2e2e24';
    ctx.font = 'italic 28px "DM Serif Display", serif';
    ctx.textAlign = 'center';
    ctx.fillText('—', x + cardW/2, cardY + cardH/2);
    ctx.textAlign = 'left';
  }

  // ---- Rating Distribution ----
  const distY = 830;
  drawMCMDivider(ctx, 72, distY, W - 144);
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '700 22px "DM Sans", sans-serif';
  ctx.fillText('RATING DISTRIBUTION', 72, distY + 36);

  drawRatingDistribution(ctx, 72, distY + 64, W - 144, d.ratingBuckets, d.totalRated);

  // ---- Starred Songs ----
  const songsY = 1040;
  drawMCMDivider(ctx, 72, songsY, W - 144);
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '700 22px "DM Sans", sans-serif';
  ctx.fillText('STARRED SONGS', 72, songsY + 36);

  if (d.topStarred.length === 0) {
    ctx.fillStyle = '#3a3a2e';
    ctx.font = 'italic 28px "DM Serif Display", serif';
    ctx.fillText('No starred songs this week', 72, songsY + 90);
  } else {
    d.topStarred.slice(0, 4).forEach(function(s, i) {
      const sy = songsY + 68 + i * 62;
      // row bg
      ctx.fillStyle = i % 2 === 0 ? '#1a1a15' : 'transparent';
      roundRect(ctx, 72, sy - 2, W - 144, 52, 4);
      ctx.fill();
      // star
      ctx.fillStyle = '#1DB954';
      ctx.font = '700 28px "DM Sans", sans-serif';
      ctx.fillText('★', 88, sy + 34);
      // song name
      ctx.fillStyle = '#f0efe8';
      ctx.font = '600 28px "DM Sans", sans-serif';
      const songTrunc = s.song.length > 32 ? s.song.substring(0,32)+'…' : s.song;
      ctx.fillText(songTrunc, 130, sy + 34);
      // artist · album
      ctx.fillStyle = '#5a5a4a';
      ctx.font = '400 22px "DM Sans", sans-serif';
      const meta = s.artist + ' · ' + s.album;
      const metaTrunc = meta.length > 52 ? meta.substring(0,52)+'…' : meta;
      ctx.fillText(metaTrunc, 130, sy + 56);
    });
  }

  // ---- Bottom green bar ----
  ctx.fillStyle = '#1DB954';
  ctx.fillRect(0, H - 6, W, 6);

  // ---- Bottom label ----
  ctx.fillStyle = '#2e2e24';
  ctx.font = '400 22px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater · sillymcwilly1.github.io/2026-Albums', W/2, H - 24);
  ctx.textAlign = 'left';
}

// ---- Canvas Drawing Helpers ----

function drawWaveform(ctx, x, y, color) {
  const bars = [6, 14, 22, 28, 22, 14, 6];
  const barW = 8;
  const gap = 5;
  bars.forEach(function(h, i) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x + i*(barW+gap), y - h/2, barW, h, 4);
    ctx.fill();
  });
}

function drawStarburst(ctx, cx, cy, r, rays, color) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const innerR = r * 0.3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
    ctx.lineTo(cx + Math.cos(angle + 0.13) * r, cy + Math.sin(angle + 0.13) * r);
    ctx.lineTo(cx + Math.cos(angle + 0.26) * innerR, cy + Math.sin(angle + 0.26) * innerR);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawAtomicDots(ctx, x, y, color) {
  ctx.fillStyle = color;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      ctx.beginPath();
      ctx.arc(x + col * 20, y - row * 20, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawMCMDivider(ctx, x, y, width) {
  ctx.strokeStyle = '#2e2e24';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width * 0.42, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + width * 0.58, y);
  ctx.lineTo(x + width, y);
  ctx.stroke();
  // Center dots
  const cx = x + width / 2;
  [cx - 20, cx, cx + 20].forEach(function(dx, i) {
    ctx.fillStyle = i === 1 ? '#1DB954' : '#3a3a2e';
    ctx.beginPath();
    ctx.arc(dx, y, i === 1 ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawStatBlock(ctx, x, y, value, label) {
  ctx.fillStyle = '#1DB954';
  ctx.font = 'italic 700 64px "DM Serif Display", serif';
  ctx.fillText(value, x, y + 52);
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '600 20px "DM Sans", sans-serif';
  ctx.fillText(label, x, y + 82);
}

function drawAlbumCard(ctx, x, y, w, h, rating, artImg, rank) {
  // Card background
  ctx.fillStyle = '#1a1a15';
  ctx.strokeStyle = '#2e2e24';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();

  // Top accent color by rank
  const rankColors = ['#1DB954', '#9e9d8e', '#e8a030'];
  ctx.fillStyle = rankColors[rank] || '#2e2e24';
  ctx.fillRect(x, y, w, 4);

  // Album art
  const artSize = w - 32;
  if (artImg) {
    ctx.save();
    roundRect(ctx, x + 16, y + 20, artSize, artSize, 6);
    ctx.clip();
    ctx.drawImage(artImg, x + 16, y + 20, artSize, artSize);
    ctx.restore();
  } else {
    ctx.fillStyle = '#222219';
    roundRect(ctx, x + 16, y + 20, artSize, artSize, 6);
    ctx.fill();
  }

  // Rank badge top-left
  ctx.fillStyle = rankColors[rank] || '#2e2e24';
  roundRect(ctx, x + 24, y + 28, 52, 36, 4);
  ctx.fill();
  ctx.fillStyle = rank === 0 ? '#000' : '#0e0e0b';
  ctx.font = '800 22px "DM Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('#' + (rank+1), x + 50, y + 52);
  ctx.textAlign = 'left';

  // Album name
  const infoY = y + 20 + artSize + 20;
  ctx.fillStyle = '#f0efe8';
  ctx.font = '700 26px "DM Sans", sans-serif';
  const name = rating.albums.name.length > 22 ? rating.albums.name.substring(0,22)+'…' : rating.albums.name;
  ctx.fillText(name, x + 16, infoY);

  // Artist
  ctx.fillStyle = '#5a5a4a';
  ctx.font = '400 22px "DM Sans", sans-serif';
  const artist = rating.albums.artist.length > 24 ? rating.albums.artist.substring(0,24)+'…' : rating.albums.artist;
  ctx.fillText(artist, x + 16, infoY + 28);

  // Rating
  ctx.fillStyle = rankColors[rank] || '#1DB954';
  ctx.font = 'italic 700 44px "DM Serif Display", serif';
  ctx.fillText(rating.rating + '', x + 16, infoY + 78);
  ctx.fillStyle = '#3a3a2e';
  ctx.font = '400 22px "DM Sans", sans-serif';
  ctx.fillText('/ 10', x + 16 + ctx.measureText(rating.rating + '').width + 8, infoY + 72);
}

function drawRatingDistribution(ctx, x, y, width, buckets, total) {
  const labels = ['9–10', '7–8', '5–6', '1–4'];
  const keys = ['9-10', '7-8', '5-6', '1-4'];
  const colors = ['#1fef6a', '#1DB954', '#0f7731', '#032a10'];
  const barH = 44;
  const gap = 14;
  const labelW = 80;
  const countW = 60;
  const barAreaW = width - labelW - countW - 20;

  keys.forEach(function(key, i) {
    const count = buckets[key] || 0;
    const pct = total > 0 ? count / total : 0;
    const rowY = y + i * (barH + gap);

    // Label
    ctx.fillStyle = '#5a5a4a';
    ctx.font = '600 22px "DM Sans", sans-serif';
    ctx.fillText(labels[i], x, rowY + barH * 0.65);

    // Bar background
    ctx.fillStyle = '#1a1a15';
    roundRect(ctx, x + labelW, rowY, barAreaW, barH, 4);
    ctx.fill();

    // Bar fill
    if (pct > 0) {
      ctx.fillStyle = colors[i];
      roundRect(ctx, x + labelW, rowY, Math.max(barAreaW * pct, 8), barH, 4);
      ctx.fill();
    }

    // Count
    ctx.fillStyle = count > 0 ? '#f0efe8' : '#3a3a2e';
    ctx.font = '700 22px "DM Sans", sans-serif';
    ctx.fillText(count, x + labelW + barAreaW + 16, rowY + barH * 0.65);
  });
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

function downloadWeekCard() {
  const canvas = document.getElementById('weekCanvas');
  const link = document.createElement('a');
  link.download = 'week-in-review.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
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
