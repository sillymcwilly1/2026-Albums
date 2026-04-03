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

const sampledColors = artImages.map(function(img) { return sampleVividColor(img); });
const blended = sampledColors[0] || [29, 185, 84];
const accentColors = sampledColors;
  

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
// WEEK IN REVIEW — drawCard() + helpers
//
// Design: bold color-blocked background, vivid per-album accent
// colors sampled for saturation (not average), editorial hierarchy.
//
// Zone map (1080 × 1920 canvas):
//   0    –  170   Masthead (dark charcoal)
//   170  –  560   Hero album #1
//   560  –  760   Albums #2 and #3 side by side
//   760  –  870   Stats row
//   870  – 1090   Starred songs (3 album columns)
//   1090 – 1340   Rating distribution bars
//   1340 – 1560   Play timeline
//   1560 – 1920   Footer (dark)
// ================================================================

const CW_CARD = 1080, CH_CARD = 1920, PAD_CARD = 56;

// ── Color helpers ──────────────────────────────────────────────

// Sample the most SATURATED pixel from album art (not the average).
// This gives us vivid edge colors like Spotify Wrapped.
function sampleVividColor(img) {
  if (!img) return [29, 185, 84];
  try {
    const size = 60;
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    const oc = off.getContext('2d');
    oc.drawImage(img, 0, 0, size, size);
    const pixels = oc.getImageData(0, 0, size, size).data;
    let bestR = 29, bestG = 185, bestB = 84, bestSat = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      const sat = mx - mn;
      if (sat > bestSat && mx > 80) {
        bestSat = sat; bestR = r; bestG = g; bestB = b;
      }
    }
    // Boost: amplify the vivid color for Spotify-level pop
    const mx = Math.max(bestR, bestG, bestB);
    const boost = 255 / Math.max(mx, 1);
    return [
      Math.min(255, Math.round(bestR * boost * 0.85)),
      Math.min(255, Math.round(bestG * boost * 0.85)),
      Math.min(255, Math.round(bestB * boost * 0.85))
    ];
  } catch(e) { return [29, 185, 84]; }
}

function lightenC(rgb, t) {
  return [
    Math.round(rgb[0]+(255-rgb[0])*t),
    Math.round(rgb[1]+(255-rgb[1])*t),
    Math.round(rgb[2]+(255-rgb[2])*t)
  ];
}

function darkenC(rgb, t) {
  return [Math.round(rgb[0]*(1-t)), Math.round(rgb[1]*(1-t)), Math.round(rgb[2]*(1-t))];
}

function toRgbC(rgb, alpha) {
  if (alpha !== undefined) return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+alpha+')';
  return 'rgb('+rgb[0]+','+rgb[1]+','+rgb[2]+')';
}

// ── Canvas helpers ─────────────────────────────────────────────

function fitC(ctx, text, maxW) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi - 1) {
    const mid = Math.floor((lo+hi)/2);
    ctx.measureText(text.substring(0,mid)+'…').width <= maxW ? (lo=mid) : (hi=mid);
  }
  return text.substring(0,lo)+'…';
}

function rrectC(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function hRuleC(ctx, y, x1, x2, color, alpha) {
  ctx.save();
  ctx.strokeStyle = color; ctx.globalAlpha = alpha||0.15; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke();
  ctx.globalAlpha = 1; ctx.restore();
}

// ── Main draw function ─────────────────────────────────────────

function drawCard(d) {
  const canvas = document.getElementById('weekCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW_CARD, CH_CARD);

  const PAD = PAD_CARD;
  const CW = CW_CARD;
  const CH = CH_CARD;

  // Vivid accent colors sampled for saturation, not average
  const vivid = (d.artImages||[]).map(function(img) { return sampleVividColor(img); });
  const A = vivid[0]||[255,140,0];
  const B = vivid[1]||[148,103,189];
  const C = vivid[2]||[44,160,101];

  // ── BACKGROUND — Spotify-style bold color blocking ─────────
  ctx.fillStyle = '#0f0d0b';
  ctx.fillRect(0, 0, CW, CH);

  // Hero zone tinted with album 1
  ctx.fillStyle = toRgbC(darkenC(A, 0.72));
  ctx.fillRect(0, 0, CW, 760);

  // Album 2+3 zone
  ctx.fillStyle = '#111018';
  ctx.fillRect(0, 560, CW, 310);

  // Stats zone
  ctx.fillStyle = toRgbC(darkenC(A, 0.80));
  ctx.fillRect(0, 760, CW, 110);

  // Songs zone
  ctx.fillStyle = '#0d0c10';
  ctx.fillRect(0, 870, CW, 220);

  // Rating zone
  ctx.fillStyle = '#100f0d';
  ctx.fillRect(0, 1090, CW, 250);

  // Chart zone
  ctx.fillStyle = '#0d0c10';
  ctx.fillRect(0, 1340, CW, 220);

  // Footer
  ctx.fillStyle = '#0a0908';
  ctx.fillRect(0, 1560, CW, CH-1560);

  // Large decorative circles — Spotify Wrapped geometry
  ctx.fillStyle = toRgbC(A, 0.18);
  ctx.beginPath(); ctx.arc(CW+80, -80, 380, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = toRgbC(B, 0.13);
  ctx.beginPath(); ctx.arc(-60, CH-200, 340, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = toRgbC(C, 0.1);
  ctx.beginPath(); ctx.arc(CW+40, 1200, 280, 0, Math.PI*2); ctx.fill();

  // Left edge stripe — album 1 vivid
  ctx.fillStyle = toRgbC(A);
  ctx.fillRect(0, 0, 8, CH);

  // ── ZONE 1: MASTHEAD (0–170) ───────────────────────────────
// Instagram story UI safe zone — 80px of breathing room at top
// (time, battery, camera icon float here without competing with content)
ctx.fillStyle = toRgbC(darkenC(A, 0.6));
ctx.fillRect(0, 0, CW, 80);
ctx.fillStyle = toRgbC(A, 0.5);
ctx.font = 'italic 20px "DM Sans",sans-serif';
ctx.fillText('week in review', PAD+4, 114);

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const eDateCopy = new Date(d.endDate); eDateCopy.setDate(eDateCopy.getDate()-1);
  const dateStr = months[d.startDate.getMonth()]+' '+d.startDate.getDate()+' – '+months[eDateCopy.getMonth()]+' '+eDateCopy.getDate()+', '+eDateCopy.getFullYear();
  ctx.textAlign = 'right';
  ctx.fillStyle = toRgbC(A, 0.4);
  ctx.font = '400 20px "DM Sans",sans-serif';
  ctx.fillText(dateStr.toUpperCase(), CW-PAD, 114);
  ctx.textAlign = 'left';

ctx.fillStyle = '#ffffff';
ctx.font = 'italic bold 84px Georgia,serif';
ctx.fillText('Album ', PAD, 208);
const awW = ctx.measureText('Album ').width;
ctx.fillStyle = toRgbC(A);
ctx.font = 'bold 84px Georgia,serif';
ctx.fillText('Rater', PAD+awW, 208);

  hRuleC(ctx, 170, PAD, CW-PAD, '#ffffff', 0.12);

  // ── ZONE 2: HERO ALBUM #1 (170–560) ───────────────────────
  const artSz = 310;
  const artX = PAD, artY = 192;

  if (d.artImages && d.artImages[0]) {
    ctx.save();
    rrectC(ctx, artX, artY, artSz, artSz, 12);
    ctx.clip();
    ctx.drawImage(d.artImages[0], artX, artY, artSz, artSz);
    ctx.restore();
  } else {
    ctx.fillStyle = toRgbC(darkenC(A, 0.4));
    rrectC(ctx, artX, artY, artSz, artSz, 12);
    ctx.fill();
    ctx.fillStyle = toRgbC(A, 0.4);
    ctx.font = '80px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', artX+artSz/2, artY+artSz/2+28);
    ctx.textAlign = 'left';
  }

  // #1 badge
  ctx.fillStyle = toRgbC(A);
  rrectC(ctx, artX, artY, 60, 38, 6);
  ctx.fill();
  ctx.fillStyle = toRgbC(darkenC(A, 0.55));
  ctx.font = 'bold 20px "DM Sans",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('#1', artX+30, artY+26);
  ctx.textAlign = 'left';

  const r0 = d.top3 && d.top3[0];
  const heroTx = PAD+artSz+38;
  const heroMaxW = CW-heroTx-PAD;

  if (r0) {
    ctx.fillStyle = toRgbC(A, 0.65);
    ctx.font = '600 20px "DM Sans",sans-serif';
    ctx.fillText('ALBUM OF THE WEEK', heroTx, 228);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px "DM Sans",sans-serif';
    ctx.fillText(fitC(ctx, r0.albums.name, heroMaxW), heroTx, 286);

    ctx.fillStyle = toRgbC(A);
    ctx.font = '400 28px "DM Sans",sans-serif';
    ctx.fillText(fitC(ctx, r0.albums.artist, heroMaxW), heroTx, 326);

    // Big score
    ctx.fillStyle = toRgbC(A);
    ctx.font = 'italic bold 148px Georgia,serif';
    ctx.fillText(String(r0.rating), heroTx, 476);
    const sw = ctx.measureText(String(r0.rating)).width;
    ctx.fillStyle = toRgbC(A, 0.45);
    ctx.font = '400 34px "DM Sans",sans-serif';
    ctx.fillText('/10', heroTx+sw+8, 462);

    const songs0 = (r0.top_songs||[]).slice(0,3);
    if (songs0.length) {
      ctx.fillStyle = toRgbC(A, 0.55);
      ctx.font = '400 20px "DM Sans",sans-serif';
      ctx.fillText('★ '+songs0.join(' · '), heroTx, 516);
    }

    const m0 = d.albumMinsMap ? (d.albumMinsMap[r0.albums.name]||0) : 0;
    if (m0 > 0) {
      ctx.fillStyle = toRgbC(darkenC(A, 0.25));
      rrectC(ctx, heroTx, 528, 150, 34, 17);
      ctx.fill();
      ctx.fillStyle = toRgbC(A);
      ctx.font = '600 18px "DM Sans",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(m0+'m this week', heroTx+75, 550);
      ctx.textAlign = 'left';
    }
  }

  hRuleC(ctx, 560, PAD, CW-PAD, '#ffffff', 0.08);

  // ── ZONE 3: ALBUMS 2 & 3 (560–760) ───────────────────────
  const aW = Math.floor((CW-PAD*2-20)/2);
  [[1,B],[2,C]].forEach(function(pair) {
    const idx=pair[0], col=pair[1];
    const ax = idx===1 ? PAD : PAD+aW+20;
    const ay = 572;
    const r = d.top3 && d.top3[idx];

    ctx.fillStyle = toRgbC(col, 0.12);
    rrectC(ctx, ax, ay, aW, 178, 10); ctx.fill();
    ctx.strokeStyle = toRgbC(col, 0.4); ctx.lineWidth = 1.5;
    rrectC(ctx, ax, ay, aW, 178, 10); ctx.stroke();
    ctx.fillStyle = toRgbC(col);
    ctx.fillRect(ax, ay, aW, 5);

    const sArt = 116;
    if (d.artImages && d.artImages[idx]) {
      ctx.save();
      rrectC(ctx, ax+12, ay+14, sArt, sArt, 6); ctx.clip();
      ctx.drawImage(d.artImages[idx], ax+12, ay+14, sArt, sArt);
      ctx.restore();
    } else {
      ctx.fillStyle = toRgbC(darkenC(col,0.5));
      rrectC(ctx, ax+12, ay+14, sArt, sArt, 6); ctx.fill();
    }

    ctx.fillStyle = toRgbC(col);
    rrectC(ctx, ax+12, ay+14, 40, 26, 4); ctx.fill();
    ctx.fillStyle = toRgbC(darkenC(col,0.55));
    ctx.font = 'bold 15px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('#'+(idx+1), ax+32, ay+31); ctx.textAlign = 'left';

    if (r) {
      const tx=ax+12+sArt+14, tmx=aW-sArt-38;
      ctx.fillStyle='#ffffff'; ctx.font='bold 26px "DM Sans",sans-serif';
      ctx.fillText(fitC(ctx,r.albums.name,tmx), tx, ay+46);
      ctx.fillStyle=toRgbC(col); ctx.font='400 19px "DM Sans",sans-serif';
      ctx.fillText(fitC(ctx,r.albums.artist,tmx), tx, ay+72);
      ctx.fillStyle=toRgbC(col); ctx.font='italic bold 60px Georgia,serif';
      ctx.fillText(String(r.rating), tx, ay+148);
      const rw=ctx.measureText(String(r.rating)).width;
      ctx.fillStyle=toRgbC(col,0.5); ctx.font='400 20px "DM Sans",sans-serif';
      ctx.fillText('/10', tx+rw+6, ay+138);
    }
  });

  // ── ZONE 4: STATS (760–870) ───────────────────────────────
  hRuleC(ctx, 762, PAD, CW-PAD, '#ffffff', 0.1);

  // Each stat gets exactly 248px — no crowding
  const sCols = [PAD, PAD+248, PAD+496, PAD+744];
  const sData = [
    {val:String(d.totalRated),  label:'RATED',    c:A},
    {val:String(d.totalStarred),label:'STARRED',  c:B},
    {val:String(Math.round(d.totalMins||0))+'m', label:'MINUTES', c:C},
    {val:String(d.avgScore),    label:'AVG SCORE',c:A}
  ];
  sData.forEach(function(st,i) {
    const sx=sCols[i];
    ctx.fillStyle=toRgbC(st.c,0.5); ctx.font='600 18px "DM Sans",sans-serif';
    ctx.fillText(st.label, sx, 800);
    ctx.fillStyle=toRgbC(st.c); ctx.font='italic bold 62px Georgia,serif';
    ctx.fillText(st.val, sx, 860);
  });

  hRuleC(ctx, 870, PAD, CW-PAD, '#ffffff', 0.08);

  // ── ZONE 5: STARRED SONGS (870–1090) ─────────────────────
  // Strictly one column per album, color = that album's vivid color only
  ctx.fillStyle = toRgbC(A, 0.5);
  ctx.font = '600 20px "DM Sans",sans-serif';
  ctx.fillText('STARRED THIS WEEK', PAD, 912);

  const songColW = Math.floor((CW-PAD*2-2)/3);
  const songCX = [PAD, PAD+songColW+1, PAD+songColW*2+2];
  const songPalette = [A, B, C];

  songCX.forEach(function(cx, ci) {
    const col = songPalette[ci];
    const r = d.top3 && d.top3[ci];
    const albumName = r ? r.albums.name : '';
    const songs = r && r.top_songs ? r.top_songs.slice(0,5) : [];

    // Album header — this album's vivid color
    ctx.fillStyle = toRgbC(col);
    ctx.font = '600 19px "DM Sans",sans-serif';
    const shortN = fitC(ctx, albumName, songColW-10);
    ctx.fillText(shortN, cx, 948);
    // Underline
    ctx.fillStyle = toRgbC(col, 0.6);
    ctx.fillRect(cx, 952, ctx.measureText(shortN).width, 2);

    // Songs — always this column's color for dot, white for name
    songs.forEach(function(song, si) {
      const sy = 985 + si*38;
      if (sy > 1080) return;
      ctx.fillStyle = toRgbC(col, 0.75);
      ctx.beginPath(); ctx.arc(cx+7, sy-7, 5, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#e4e0d8';
      ctx.font = '400 20px "DM Sans",sans-serif';
      ctx.fillText(fitC(ctx, song, songColW-22), cx+18, sy);
    });

    // Column divider
    if (ci < 2) {
      ctx.fillStyle = toRgbC(songPalette[ci+1], 0.25);
      ctx.fillRect(cx+songColW, 925, 1, 155);
    }
  });

  hRuleC(ctx, 1092, PAD, CW-PAD, '#ffffff', 0.08);

  // ── ZONE 6: RATING BARS (1090–1340) ──────────────────────
  ctx.fillStyle = '#8a8070';
  ctx.font = '600 20px "DM Sans",sans-serif';
  ctx.fillText('RATING HISTORY', PAD, 1132);

  // Legend on same line, right-aligned, won't overlap label
  ctx.fillStyle = '#5a5040'; ctx.font = '400 17px "DM Sans",sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('prior  ·  this week', CW-PAD, 1132);
  ctx.textAlign = 'left';

  const bkts = d.ratingBuckets||{'1-4':4,'5-6':8,'7-8':21,'9-10':13};
  const wkBkts = d.weekRatingBuckets||{'1-4':0,'5-6':0,'7-8':0,'9-10':0};

  const bktDefs = [
    {key:'9-10',label:'9–10',priorFill:'#2e8a3e',newFill:'#7cef8a',textFill:'#c8ffd0'},
    {key:'7-8', label:'7–8', priorFill:'#1e7a68',newFill:'#8aefdb',textFill:'#c0fff6'},
    {key:'5-6', label:'5–6', priorFill:'#9a7820',newFill:'#f5d07a',textFill:'#fff4cc'},
    {key:'1-4', label:'1–4', priorFill:'#9a4830',newFill:'#f5a090',textFill:'#ffd8d0'},
  ];

  const maxBktTotal = Math.max(1, ...bktDefs.map(function(b) {
    return (bkts[b.key]||0)+(wkBkts[b.key]||0);
  }));
  const barAreaW = CW-PAD*2-90;
  const barX = PAD+90;
  const rowH = 40, rowGap = 18;

  bktDefs.forEach(function(b, bi) {
    const rowY = 1152 + bi*(rowH+rowGap);
    if (rowY+rowH > 1330) return;
    const prior = bkts[b.key]||0;
    const wk = wkBkts[b.key]||0;
    const priorW = Math.round((prior/maxBktTotal)*barAreaW);
    const wkW = Math.round((wk/maxBktTotal)*barAreaW);

    // Label
    ctx.fillStyle = b.priorFill;
    ctx.font = 'bold 26px "DM Sans",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(b.label, barX-12, rowY+rowH*0.72);
    ctx.textAlign = 'left';

// Track — always drawn regardless of count
    ctx.fillStyle = '#1e1c18';
    rrectC(ctx, barX, rowY, barAreaW, rowH, rowH/2); ctx.fill();

    // If bucket is empty, show a zero label so the row is always visible
    if (prior === 0 && wk === 0) {
      ctx.fillStyle = '#3a3830';
      ctx.font = '400 18px "DM Sans",sans-serif';
      ctx.fillText('0', barX+16, rowY+rowH*0.70);
    }

    // Prior bar
    if (priorW > 0) {
      ctx.fillStyle = b.priorFill;
      rrectC(ctx, barX, rowY, priorW, rowH, rowH/2); ctx.fill();
      if (wk > 0 && priorW > rowH/2) {
        ctx.fillRect(barX+rowH/2, rowY, priorW-rowH/2, rowH);
      }
      if (priorW > 56) {
        ctx.fillStyle = b.textFill;
        ctx.font = 'bold 20px "DM Sans",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(prior), barX+priorW/2, rowY+rowH*0.70);
        ctx.textAlign = 'left';
      }
    }

    // This-week stack — bright, no text overlap with prior
    if (wkW > 0) {
      const wkX = barX+priorW;
      ctx.fillStyle = b.newFill;
      if (priorW > 0) {
        ctx.fillRect(wkX, rowY, Math.max(wkW-rowH/2, 2), rowH);
        rrectC(ctx, wkX+wkW-rowH, rowY, rowH, rowH, rowH/2); ctx.fill();
      } else {
        rrectC(ctx, wkX, rowY, wkW, rowH, rowH/2); ctx.fill();
      }
      // Label only inside if wide enough — uses DIFFERENT x center from prior
      if (wkW > 52) {
        ctx.fillStyle = b.textFill;
        ctx.font = 'bold 20px "DM Sans",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('+'+wk, wkX+wkW/2, rowY+rowH*0.70);
        ctx.textAlign = 'left';
      }
    }

    // Fallback: count to the right of bar when both segments too narrow to label
    if (priorW <= 56 && wkW <= 52 && (prior > 0 || wk > 0)) {
      const endX = barX+priorW+wkW+10;
      ctx.fillStyle = '#6a6050'; ctx.font = '400 18px "DM Sans",sans-serif';
      ctx.fillText(String(prior)+(wk>0?' +'+wk:''), endX, rowY+rowH*0.70);
    }
  });

  hRuleC(ctx, 1342, PAD, CW-PAD, '#ffffff', 0.08);

  // ── ZONE 7: PLAY TIMELINE (1340–1560) ────────────────────
  ctx.fillStyle = '#8a8070';
  ctx.font = '600 20px "DM Sans",sans-serif';
  ctx.fillText('PLAY TIMELINE', PAD, 1380);

  // Hard bounds — chart can NEVER draw outside these
  const cX = PAD+64;
  const cTop = 1398;
  const cBot = 1534;
  const cW = CW-PAD-cX-PAD;
  const cH = cBot-cTop;

  const dates = Object.keys(d.byDate||{}).sort();

  if (dates.length < 2) {
    ctx.fillStyle='#5a5040'; ctx.font='italic 26px Georgia,serif';
    ctx.textAlign='center';
    ctx.fillText('not enough data yet', cX+cW/2, cTop+cH/2);
    ctx.textAlign='left';
  } else {
    let rawMax=0;
    dates.forEach(function(dt) {
      (d.top5forChart||[]).forEach(function(a) {
        rawMax=Math.max(rawMax,(d.byDate[dt]&&d.byDate[dt][a])||0);
      });
    });
    if (rawMax===0) rawMax=1;
    const maxV = Math.ceil((rawMax*1.2)/10)*10;

    function ptY(v) { return Math.min(cBot, Math.max(cTop, cBot-(v/maxV)*cH)); }

    [0,0.5,1].forEach(function(pct) {
      const gy=cBot-pct*cH;
      if (gy<cTop||gy>cBot) return;
      ctx.strokeStyle='#2a2820'; ctx.lineWidth=0.8;
      ctx.beginPath(); ctx.moveTo(cX,gy); ctx.lineTo(cX+cW,gy); ctx.stroke();
      if (pct>0) {
        ctx.fillStyle='#5a5040'; ctx.font='18px "DM Sans",sans-serif';
        ctx.textAlign='right';
        ctx.fillText(Math.round(maxV*pct)+'m', cX-8, gy+6);
        ctx.textAlign='left';
      }
    });

    ctx.fillStyle='#5a5040'; ctx.font='18px "DM Sans",sans-serif'; ctx.textAlign='center';
    dates.forEach(function(dt,i) {
      const dtO=new Date(dt+'T00:00:00');
      if (i===0||dtO.getDay()===1) {
        const px=cX+(i/Math.max(dates.length-1,1))*cW;
        ctx.fillText((dtO.getMonth()+1)+'/'+dtO.getDate(), px, cBot+24);
      }
    });
    ctx.textAlign='left';

    const lineColors=d.lineColors||['#1DB954','#e8a030','#e05a3a','#4a9eff','#c084fc'];

    (d.top5forChart||[]).forEach(function(album,ai) {
      const pts=dates.map(function(dt,i) {
        return {px:cX+(i/Math.max(dates.length-1,1))*cW, py:ptY((d.byDate[dt]&&d.byDate[dt][album])||0)};
      });
      ctx.beginPath(); ctx.moveTo(pts[0].px,cBot);
      pts.forEach(function(p){ctx.lineTo(p.px,p.py);}); ctx.lineTo(pts[pts.length-1].px,cBot);
      ctx.closePath(); ctx.fillStyle=lineColors[ai]+'18'; ctx.fill();
    });

    (d.top5forChart||[]).forEach(function(album,ai) {
      const pts=dates.map(function(dt,i) {
        return {px:cX+(i/Math.max(dates.length-1,1))*cW, py:ptY((d.byDate[dt]&&d.byDate[dt][album])||0)};
      });
      ctx.beginPath(); ctx.strokeStyle=lineColors[ai]; ctx.lineWidth=3; ctx.lineJoin='round';
      ctx.moveTo(pts[0].px,pts[0].py);
      for (let i=1;i<pts.length;i++) {
        const cpx=(pts[i-1].px+pts[i].px)/2;
        ctx.bezierCurveTo(cpx,pts[i-1].py,cpx,pts[i].py,pts[i].px,pts[i].py);
      }
      ctx.stroke();
      pts.forEach(function(p) {
        ctx.beginPath(); ctx.arc(p.px,p.py,5,0,Math.PI*2);
        ctx.fillStyle=lineColors[ai]; ctx.fill();
      });
    });

    let ly=cTop+4;
    (d.top5forChart||[]).forEach(function(album,ai) {
      ctx.fillStyle=lineColors[ai]; ctx.fillRect(cX+cW-220,ly+5,16,4);
      ctx.font='18px "DM Sans",sans-serif'; ctx.fillStyle='#6a6050';
      ctx.fillText(fitC(ctx,album,196), cX+cW-198, ly+17); ly+=26;
    });
  }

  hRuleC(ctx, 1562, PAD, CW-PAD, '#ffffff', 0.08);

  // ── ZONE 8: FOOTER (1560–1920) ────────────────────────────
  ctx.fillStyle = toRgbC(A, 0.15);
  ctx.beginPath(); ctx.arc(CW/2, 1920, 620, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = toRgbC(B, 0.1);
  ctx.beginPath(); ctx.arc(180, 1920, 400, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = toRgbC(C, 0.08);
  ctx.beginPath(); ctx.arc(900, 1920, 350, 0, Math.PI*2); ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'italic bold 68px Georgia,serif';
  ctx.textAlign = 'center';
  ctx.fillText('Album Rater', CW/2, 1726);
  ctx.fillStyle = toRgbC(A, 0.6);
  ctx.font = '400 22px "DM Sans",sans-serif';
  ctx.fillText('sillymcwilly1.github.io/2026-Albums', CW/2, 1768);
  ctx.fillStyle = toRgbC(A, 0.3);
  ctx.font = '600 18px "DM Sans",sans-serif';
  ctx.fillText('WEEK IN REVIEW', CW/2, 1806);
  ctx.textAlign = 'left';

  ctx.fillStyle = toRgbC(A);
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
